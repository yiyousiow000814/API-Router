mod app_state;
mod codex_app_server;
mod codex_cli_swap;
mod orchestrator;
mod platform;
mod provider_switchboard;

use tauri::Manager;

use crate::app_state::build_state;
use crate::orchestrator::gateway::serve_in_background;
use crate::orchestrator::store::unix_ms;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Ensure clicking the EXE again focuses the existing instance instead of launching a second one.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .setup(|app| {
            // UI automation should not steal focus or visibly pop up windows.
            // The WebView still needs a real window on Windows/WebView2, so we move it far off-screen
            // and hide it from the taskbar (best-effort).
            if std::env::var("UI_TAURI").ok().as_deref() == Some("1") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_skip_taskbar(true);
                    let _ = w.set_focusable(false);
                    let _ = w.minimize();
                    let _ = w.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                        x: 100_000,
                        y: 100_000,
                    }));
                }
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Prefer a stable per-user app data directory so rebuilds don't force re-login.
            // If a local ./user-data already exists next to the EXE, keep using it for portability.
            // Layout:
            // - user-data/config.toml
            // - user-data/secrets.json
            // - user-data/data/* (sled store, metrics, events)
            let user_data_dir = (|| -> Option<std::path::PathBuf> {
                let exe = std::env::current_exe().ok()?;
                let dir = exe.parent()?.to_path_buf();
                let local = dir.join("user-data");
                if local.exists() {
                    return Some(local);
                }
                None
            })()
            .unwrap_or(app.path().app_data_dir()?);

            // Isolate Codex auth/session from the default ~/.codex directory to avoid overwrites.
            // This keeps the app's login independent from CLI logins.
            let codex_home = user_data_dir.join("codex-home");
            let _ = std::fs::create_dir_all(&codex_home);
            std::env::set_var("CODEX_HOME", &codex_home);

            let state = build_state(
                user_data_dir.join("config.toml"),
                user_data_dir.join("data"),
            )?;
            app.manage(state);

            // Spawn the local OpenAI-compatible gateway.
            let st = app.state::<app_state::AppState>();
            let gateway = st.gateway.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = serve_in_background(gateway).await {
                    log::error!("gateway exited: {e:?}");
                }
            });

            // Quota refresh scheduler: only runs when the gateway is actively being used.
            let st = app.state::<app_state::AppState>();
            let gateway = st.gateway.clone();
            tauri::async_runtime::spawn(async move {
                crate::orchestrator::quota::run_quota_scheduler(gateway).await;
            });

            // Tray menu so the app is usable even when the main window starts hidden.
            let show = tauri::menu::MenuItemBuilder::with_id("show", "Show").build(app)?;
            let quit = tauri::menu::MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = tauri::menu::MenuBuilder::new(app)
                .items(&[&show, &quit])
                .build()?;

            // Ensure the tray icon has an actual image on Windows; otherwise it can appear as "blank".
            // We always provide an explicit tray icon (rather than relying on default_window_icon)
            // because on Windows the "default" can still render as an empty square.
            let icon = (|| {
                let bytes = include_bytes!("../icons/32x32.png");
                let img = image::load_from_memory(bytes).ok()?.to_rgba8();
                let (w, h) = img.dimensions();
                Some(tauri::image::Image::new_owned(img.into_raw(), w, h))
            })();

            let mut tray_builder =
                tauri::tray::TrayIconBuilder::new()
                    .menu(&menu)
                    .on_menu_event(|app: &tauri::AppHandle, event: tauri::menu::MenuEvent| {
                        match event.id().as_ref() {
                            "show" => {
                                if let Some(w) = app.get_webview_window("main") {
                                    let _ = w.show();
                                    let _ = w.set_focus();
                                }
                            }
                            "quit" => {
                                app.exit(0);
                            }
                            _ => {}
                        }
                    });

            if let Some(icon) = icon {
                tray_builder = tray_builder.icon(icon);
            }

            let _tray = tray_builder.build(app)?;

            // Closing the window should minimize to tray instead of exiting (background mode).
            if let Some(w) = app.get_webview_window("main") {
                let w2 = w.clone();
                w.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w2.hide();
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            set_manual_override,
            get_config,
            get_gateway_token_preview,
            get_gateway_token,
            rotate_gateway_token,
            set_preferred_provider,
            set_session_preferred_provider,
            clear_session_preferred_provider,
            upsert_provider,
            delete_provider,
            rename_provider,
            get_provider_key,
            set_provider_key,
            clear_provider_key,
            refresh_quota,
            refresh_quota_shared,
            refresh_quota_all,
            set_usage_token,
            clear_usage_token,
            set_usage_base_url,
            clear_usage_base_url,
            set_provider_manual_pricing,
            get_effective_usage_base,
            set_provider_order,
            probe_provider,
            codex_cli_toggle_auth_config_swap,
            codex_cli_default_home,
            codex_cli_swap_status,
            provider_switchboard_status,
            provider_switchboard_set_target,
            codex_account_login,
            codex_account_logout,
            codex_account_refresh,
            get_usage_statistics
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn get_status(state: tauri::State<'_, app_state::AppState>) -> serde_json::Value {
    let cfg = state.gateway.cfg.read().clone();
    let now = unix_ms();
    state.gateway.router.sync_with_config(&cfg, now);
    let providers = state.gateway.router.snapshot(now);
    let manual_override = state.gateway.router.manual_override.read().clone();
    let recent_events = state.gateway.store.list_events_split(5, 5);
    let metrics = state.gateway.store.get_metrics();
    let quota = state.gateway.store.list_quota_snapshots();
    let ledgers = state.gateway.store.list_ledgers();
    let last_activity = state.gateway.last_activity_unix_ms.load(Ordering::Relaxed);
    let active_recent = last_activity > 0 && now.saturating_sub(last_activity) < 2 * 60 * 1000;
    let (active_provider, active_reason, active_provider_counts) = if active_recent {
        let map = state.gateway.last_used_by_session.read();

        // Multiple Codex sessions can be active simultaneously, potentially routing through different
        // providers. Expose the full active provider set so the UI can mark multiple providers as
        // "effective" at once.
        //
        // Keep this a single pass so `active_provider` (most recent) and `active_provider_counts`
        // share the same time window semantics.
        let mut counts: std::collections::BTreeMap<String, u64> = std::collections::BTreeMap::new();
        let mut last: Option<crate::orchestrator::gateway::LastUsedRoute> = None;

        for v in map.values() {
            if now.saturating_sub(v.unix_ms) >= 2 * 60 * 1000 {
                continue;
            }
            *counts.entry(v.provider.clone()).or_default() += 1;
            if last
                .as_ref()
                .map(|cur| v.unix_ms > cur.unix_ms)
                .unwrap_or(true)
            {
                last = Some(v.clone());
            }
        }

        (
            last.as_ref().map(|v| v.provider.clone()),
            last.map(|v| v.reason),
            counts,
        )
    } else {
        (None, None, std::collections::BTreeMap::<String, u64>::new())
    };
    let codex_account = state
        .gateway
        .store
        .get_codex_account_snapshot()
        .unwrap_or(serde_json::json!({"ok": false}));

    let client_sessions = {
        // Best-effort: discover running Codex processes configured to use this router, even before
        // the first request is sent (Windows Terminal only).
        let gateway_token = state.secrets.get_gateway_token().unwrap_or_default();
        let expected = (!gateway_token.is_empty()).then_some(gateway_token.as_str());
        let discovered = crate::platform::windows_terminal::discover_sessions_using_router(
            cfg.listen.port,
            expected,
        );

        // Track all discovered sessions, but only allow provider preference changes once we have
        // strong evidence that the session is using this gateway.
        {
            let mut map = state.gateway.client_sessions.write();
            for s in discovered {
                let Some(codex_session_id) = s.codex_session_id.as_deref() else {
                    continue;
                };
                let entry = map.entry(codex_session_id.to_string()).or_insert_with(|| {
                    crate::orchestrator::gateway::ClientSessionRuntime {
                        codex_session_id: codex_session_id.to_string(),
                        pid: s.pid,
                        wt_session: Some(s.wt_session.clone()),
                        last_request_unix_ms: 0,
                        last_discovered_unix_ms: 0,
                        last_reported_model_provider: None,
                        last_reported_base_url: None,
                        confirmed_router: s.router_confirmed,
                    }
                });
                entry.pid = s.pid;
                entry.wt_session = Some(s.wt_session.clone());
                entry.last_discovered_unix_ms = now;
                if s.router_confirmed {
                    entry.confirmed_router = true;
                }
                if let Some(mp) = s.reported_model_provider.as_deref() {
                    entry.last_reported_model_provider = Some(mp.to_string());
                }
                if let Some(bu) = s.reported_base_url.as_deref() {
                    entry.last_reported_base_url = Some(bu.to_string());
                }
            }
        }

        // Drop dead sessions aggressively (e.g. user Ctrl+C'd Codex).
        // We keep the persisted preference mapping in config; only the runtime list is pruned.
        {
            let mut map = state.gateway.client_sessions.write();
            // Some sessions (e.g. non-Windows or when PID inference fails) can have pid=0. Keep them
            // around briefly for UI visibility, but prune if they go cold to avoid unbounded growth.
            const STALE_NO_PID_MS: u64 = 5 * 60 * 1000;
            map.retain(|_, v| {
                if v.pid != 0 && !crate::platform::windows_terminal::is_pid_alive(v.pid) {
                    return false;
                }
                if v.pid == 0 {
                    let last_seen = v.last_request_unix_ms.max(v.last_discovered_unix_ms);
                    if last_seen > 0 && now.saturating_sub(last_seen) > STALE_NO_PID_MS {
                        return false;
                    }
                }
                true
            });
        }

        let map = state.gateway.client_sessions.read().clone();
        let mut items: Vec<_> = map.into_iter().collect();
        items.sort_by_key(|(_k, v)| {
            std::cmp::Reverse(v.last_request_unix_ms.max(v.last_discovered_unix_ms))
        });
        items.truncate(20);
        let sessions = items
            .into_iter()
            .map(|(_codex_session_id, v)| {
                // Consider a session "active" only if it has recently made requests through the router.
                // Discovery scans run frequently and should not keep sessions pinned as active forever.
                let active = v.last_request_unix_ms > 0
                    && now.saturating_sub(v.last_request_unix_ms) < 60_000;

                let codex_id = v.codex_session_id.clone();
                let pref = cfg
                    .routing
                    .session_preferred_providers
                    .get(&codex_id)
                    .cloned()
                    .filter(|p| cfg.providers.contains_key(p));
                let last_seen_unix_ms = v.last_request_unix_ms.max(v.last_discovered_unix_ms);
                serde_json::json!({
                    "id": codex_id,
                    "wt_session": v.wt_session,
                    "codex_session_id": v.codex_session_id,
                    "reported_model_provider": v.last_reported_model_provider,
                    "reported_base_url": v.last_reported_base_url,
                    "last_seen_unix_ms": last_seen_unix_ms,
                    "active": active,
                    "preferred_provider": pref,
                    "verified": v.confirmed_router
                })
            })
            .collect::<Vec<_>>();
        sessions
    };

    serde_json::json!({
      "listen": { "host": cfg.listen.host, "port": cfg.listen.port },
      "preferred_provider": cfg.routing.preferred_provider,
      "manual_override": manual_override,
      "providers": providers,
      "metrics": metrics,
      "recent_events": recent_events,
      "active_provider": active_provider,
      "active_reason": active_reason,
      "active_provider_counts": active_provider_counts,
      "quota": quota,
      "ledgers": ledgers,
      "last_activity_unix_ms": last_activity,
      "codex_account": codex_account,
      "client_sessions": client_sessions
    })
}

#[tauri::command]
fn get_usage_statistics(
    state: tauri::State<'_, app_state::AppState>,
    hours: Option<u64>,
) -> serde_json::Value {
    fn as_f64(v: Option<&Value>) -> Option<f64> {
        v.and_then(|x| {
            x.as_f64().or_else(|| {
                x.as_i64()
                    .map(|n| n as f64)
                    .or_else(|| x.as_u64().map(|n| n as f64))
            })
        })
    }

    fn round3(v: f64) -> f64 {
        (v * 1000.0).round() / 1000.0
    }

    let now = unix_ms();
    let window_hours = hours.unwrap_or(24).clamp(1, 24 * 30);
    let window_ms = window_hours.saturating_mul(60 * 60 * 1000);
    let since_unix_ms = now.saturating_sub(window_ms);
    let bucket_ms = if window_hours <= 48 {
        60 * 60 * 1000
    } else {
        24 * 60 * 60 * 1000
    };

    let records = state.gateway.store.list_usage_requests(5000);
    let quota = state.gateway.store.list_quota_snapshots();

    let mut provider_requests: BTreeMap<String, u64> = BTreeMap::new();
    let mut provider_tokens: BTreeMap<String, u64> = BTreeMap::new();
    let mut timeline: BTreeMap<u64, (u64, u64)> = BTreeMap::new();
    let mut filtered: Vec<(String, String, u64, u64, u64, u64)> = Vec::new();

    for rec in records {
        let ts = rec.get("unix_ms").and_then(|v| v.as_u64()).unwrap_or(0);
        if ts < since_unix_ms {
            continue;
        }
        let provider = rec
            .get("provider")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        let model = rec
            .get("model")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .unwrap_or("unknown")
            .to_string();
        let input_tokens = rec
            .get("input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let output_tokens = rec
            .get("output_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let total_tokens = rec
            .get("total_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(input_tokens.saturating_add(output_tokens));

        *provider_requests.entry(provider.clone()).or_default() += 1;
        *provider_tokens.entry(provider.clone()).or_default() += total_tokens;
        let bucket = (ts / bucket_ms) * bucket_ms;
        let entry = timeline.entry(bucket).or_insert((0, 0));
        entry.0 += 1;
        entry.1 += total_tokens;

        filtered.push((
            provider,
            model,
            input_tokens,
            output_tokens,
            total_tokens,
            ts,
        ));
    }

    let mut provider_cost_per_token: BTreeMap<String, f64> = BTreeMap::new();
    let provider_pricing = state.secrets.list_provider_pricing();
    if let Some(qmap) = quota.as_object() {
        for (provider, q) in qmap {
            let kind = q.get("kind").and_then(|v| v.as_str()).unwrap_or("none");
            if kind != "budget_info" {
                continue;
            }
            let Some(spent) = as_f64(q.get("daily_spent_usd")) else {
                continue;
            };
            if spent <= 0.0 {
                continue;
            }
            let tok = provider_tokens.get(provider).copied().unwrap_or(0);
            if tok > 0 {
                provider_cost_per_token.insert(provider.to_string(), spent / tok as f64);
            }
        }
    }

    #[derive(Default)]
    struct ModelAgg {
        requests: u64,
        input_tokens: u64,
        output_tokens: u64,
        total_tokens: u64,
        estimated_total_cost_usd: f64,
        estimated_cost_request_count: u64,
    }
    #[derive(Default)]
    struct ProviderAgg {
        requests: u64,
        total_tokens: u64,
        estimated_total_cost_usd: f64,
        estimated_cost_request_count: u64,
        manual_per_request_usd: Option<f64>,
        manual_package_total_usd: Option<f64>,
        pricing_source: String,
    }

    let mut by_model_map: BTreeMap<String, ModelAgg> = BTreeMap::new();
    let mut by_provider_map: BTreeMap<String, ProviderAgg> = BTreeMap::new();
    let mut total_requests = 0u64;
    let mut total_tokens = 0u64;

    for (provider, model, input_tokens, output_tokens, total_tokens_row, _ts) in filtered {
        total_requests += 1;
        total_tokens += total_tokens_row;

        let model_entry = by_model_map.entry(model.clone()).or_default();
        model_entry.requests += 1;
        model_entry.input_tokens += input_tokens;
        model_entry.output_tokens += output_tokens;
        model_entry.total_tokens += total_tokens_row;

        let provider_entry = by_provider_map.entry(provider.clone()).or_default();
        provider_entry.requests += 1;
        provider_entry.total_tokens += total_tokens_row;

        let manual = provider_pricing.get(&provider);
        let mut est_cost = 0.0;
        if let Some((mode, amount)) = manual {
            if mode == "per_request" && *amount > 0.0 {
                provider_entry.manual_per_request_usd = Some(*amount);
                provider_entry.pricing_source = "manual_per_request".to_string();
                est_cost = *amount;
            } else if mode == "package_total" && *amount > 0.0 {
                provider_entry.manual_package_total_usd = Some(*amount);
                if provider_entry.pricing_source.is_empty() {
                    provider_entry.pricing_source = "manual_package_total".to_string();
                }
            }
        }
        if est_cost <= 0.0 {
            est_cost = provider_cost_per_token
                .get(&provider)
                .map(|per_tok| *per_tok * total_tokens_row as f64)
                .unwrap_or(0.0);
            if est_cost > 0.0 && provider_entry.pricing_source.is_empty() {
                provider_entry.pricing_source = "token_rate".to_string();
            }
        }
        if est_cost > 0.0 {
            model_entry.estimated_total_cost_usd += est_cost;
            model_entry.estimated_cost_request_count += 1;
            provider_entry.estimated_total_cost_usd += est_cost;
            provider_entry.estimated_cost_request_count += 1;
        }
    }

    let mut by_model: Vec<Value> = by_model_map
        .into_iter()
        .map(|(model, agg)| {
            let share_pct = if total_requests > 0 {
                (agg.requests as f64 / total_requests as f64) * 100.0
            } else {
                0.0
            };
            let avg_req_cost = if agg.estimated_cost_request_count > 0 {
                agg.estimated_total_cost_usd / agg.estimated_cost_request_count as f64
            } else {
                0.0
            };
            serde_json::json!({
                "model": model,
                "requests": agg.requests,
                "input_tokens": agg.input_tokens,
                "output_tokens": agg.output_tokens,
                "total_tokens": agg.total_tokens,
                "share_pct": round3(share_pct),
                "estimated_total_cost_usd": round3(agg.estimated_total_cost_usd),
                "estimated_avg_request_cost_usd": round3(avg_req_cost),
                "estimated_cost_request_count": agg.estimated_cost_request_count
            })
        })
        .collect();
    by_model.sort_by(|a, b| {
        let ar = a.get("requests").and_then(|v| v.as_u64()).unwrap_or(0);
        let br = b.get("requests").and_then(|v| v.as_u64()).unwrap_or(0);
        br.cmp(&ar)
    });

    let mut by_provider: Vec<Value> = by_provider_map
        .into_iter()
        .map(|(provider, agg)| {
            let mut avg_req_cost: Option<f64> = None;
            if let Some(v) = agg.manual_per_request_usd {
                avg_req_cost = Some(v);
            } else if agg.estimated_cost_request_count > 0 {
                avg_req_cost =
                    Some(agg.estimated_total_cost_usd / agg.estimated_cost_request_count as f64);
            }
            let usd_per_million_tokens = if let Some(v) = agg.manual_per_request_usd {
                if agg.requests > 0 && agg.total_tokens > 0 {
                    Some(v * agg.requests as f64 / agg.total_tokens as f64 * 1_000_000.0)
                } else {
                    None
                }
            } else {
                provider_cost_per_token
                    .get(&provider)
                    .map(|per_tok| *per_tok * 1_000_000.0)
            };
            let est_daily_cost = if let Some(package_total) = agg.manual_package_total_usd {
                Some(package_total / 30.0)
            } else if window_hours > 0 && agg.estimated_total_cost_usd > 0.0 {
                Some((agg.estimated_total_cost_usd / window_hours as f64) * 24.0)
            } else {
                None
            };
            let total_used_cost_usd = if let Some(package_total) = agg.manual_package_total_usd {
                Some(package_total)
            } else if agg.estimated_total_cost_usd > 0.0 {
                Some(agg.estimated_total_cost_usd)
            } else {
                None
            };
            let tokens_per_request = if agg.requests > 0 {
                Some(agg.total_tokens as f64 / agg.requests as f64)
            } else {
                None
            };
            let pricing_source = if agg.pricing_source.is_empty() {
                "none".to_string()
            } else {
                agg.pricing_source
            };
            let avg_req_cost_num = avg_req_cost.unwrap_or(0.0);
            let usd_per_million_num = usd_per_million_tokens.unwrap_or(0.0);
            let est_daily_num = est_daily_cost.unwrap_or(0.0);
            let total_used_num = total_used_cost_usd.unwrap_or(0.0);
            let tok_per_req_num = tokens_per_request.unwrap_or(0.0);
            let avg_req_cost_json = if avg_req_cost.is_some() {
                serde_json::json!(round3(avg_req_cost_num))
            } else {
                Value::Null
            };
            let usd_per_million_json = if usd_per_million_tokens.is_some() {
                serde_json::json!(round3(usd_per_million_num))
            } else {
                Value::Null
            };
            let est_daily_json = if est_daily_cost.is_some() {
                serde_json::json!(round3(est_daily_num))
            } else {
                Value::Null
            };
            let total_used_json = if total_used_cost_usd.is_some() {
                serde_json::json!(round3(total_used_num))
            } else {
                Value::Null
            };
            let tok_per_req_json = if tokens_per_request.is_some() {
                serde_json::json!(round3(tok_per_req_num))
            } else {
                Value::Null
            };
            serde_json::json!({
                "provider": provider,
                "requests": agg.requests,
                "total_tokens": agg.total_tokens,
                "tokens_per_request": tok_per_req_json,
                "estimated_total_cost_usd": round3(agg.estimated_total_cost_usd),
                "estimated_avg_request_cost_usd": avg_req_cost_json,
                "usd_per_million_tokens": usd_per_million_json,
                "estimated_daily_cost_usd": est_daily_json,
                "total_used_cost_usd": total_used_json,
                "pricing_source": pricing_source,
                "estimated_cost_request_count": agg.estimated_cost_request_count
            })
        })
        .collect();
    by_provider.sort_by(|a, b| {
        let ar = a.get("requests").and_then(|v| v.as_u64()).unwrap_or(0);
        let br = b.get("requests").and_then(|v| v.as_u64()).unwrap_or(0);
        br.cmp(&ar)
    });

    let first_bucket = (since_unix_ms / bucket_ms) * bucket_ms;
    let last_bucket = (now / bucket_ms) * bucket_ms;
    let mut timeline_points: Vec<Value> = Vec::new();
    let mut bucket = first_bucket;
    while bucket <= last_bucket {
        let (requests, tokens) = timeline.get(&bucket).copied().unwrap_or((0, 0));
        timeline_points.push(serde_json::json!({
            "bucket_unix_ms": bucket,
            "requests": requests,
            "total_tokens": tokens
        }));
        bucket = bucket.saturating_add(bucket_ms);
        if bucket_ms == 0 {
            break;
        }
    }

    let estimated_total_cost_usd = by_model
        .iter()
        .filter_map(|m| m.get("estimated_total_cost_usd").and_then(|v| v.as_f64()))
        .sum::<f64>();

    serde_json::json!({
      "ok": true,
      "generated_at_unix_ms": now,
      "window_hours": window_hours,
      "bucket_seconds": bucket_ms / 1000,
      "summary": {
        "total_requests": total_requests,
        "total_tokens": total_tokens,
        "unique_models": by_model.len(),
        "estimated_total_cost_usd": round3(estimated_total_cost_usd),
        "by_model": by_model,
        "by_provider": by_provider,
        "timeline": timeline_points
      }
    })
}

#[tauri::command]
fn set_manual_override(
    state: tauri::State<'_, app_state::AppState>,
    provider: Option<String>,
) -> Result<(), String> {
    if let Some(ref p) = provider {
        if !state.gateway.cfg.read().providers.contains_key(p) {
            return Err(format!("unknown provider: {p}"));
        }
    }
    state.gateway.router.set_manual_override(provider.clone());
    state.gateway.store.add_event(
        provider.as_deref().unwrap_or("-"),
        "info",
        "routing.manual_override_changed",
        "manual override changed",
        serde_json::Value::Null,
    );
    Ok(())
}

#[tauri::command]
fn get_config(state: tauri::State<'_, app_state::AppState>) -> serde_json::Value {
    let cfg = state.gateway.cfg.read().clone();
    let pricing = state.secrets.list_provider_pricing();
    // Never expose keys in UI/API.
    let providers: serde_json::Map<String, serde_json::Value> = cfg
        .providers
        .iter()
        .map(|(name, p)| {
            let key = state.secrets.get_provider_key(name);
            let usage_token = state.secrets.get_usage_token(name);
            let manual_pricing = pricing.get(name).cloned();
            let has_key = key.is_some();
            let key_preview = key.as_deref().map(mask_key_preview);
            (
                name.clone(),
                serde_json::json!({
                  "display_name": p.display_name,
                  "base_url": p.base_url,
                  "usage_adapter": p.usage_adapter.clone(),
                  "usage_base_url": p.usage_base_url.clone(),
                  "manual_pricing_mode": manual_pricing.as_ref().map(|v| v.0.clone()),
                  "manual_pricing_amount_usd": manual_pricing.as_ref().map(|v| v.1),
                  "has_key": has_key
                  ,"key_preview": key_preview,
                  "has_usage_token": usage_token.is_some()
                }),
            )
        })
        .collect();

    serde_json::json!({
      "listen": cfg.listen,
      "routing": cfg.routing,
      "providers": providers,
      "provider_order": cfg.provider_order
    })
}

#[tauri::command]
fn get_gateway_token_preview(state: tauri::State<'_, app_state::AppState>) -> String {
    let tok = state.secrets.get_gateway_token().unwrap_or_default();
    mask_key_preview(&tok)
}

#[tauri::command]
fn get_gateway_token(state: tauri::State<'_, app_state::AppState>) -> String {
    state.secrets.get_gateway_token().unwrap_or_default()
}

#[tauri::command]
fn rotate_gateway_token(state: tauri::State<'_, app_state::AppState>) -> Result<String, String> {
    state.secrets.rotate_gateway_token()
}

#[tauri::command]
fn set_preferred_provider(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    {
        let mut cfg = state.gateway.cfg.write();
        if !cfg.providers.contains_key(&provider) {
            return Err(format!("unknown provider: {provider}"));
        }
        cfg.routing.preferred_provider = provider.clone();
    }
    persist_config(&state).map_err(|e| e.to_string())?;
    state.gateway.store.add_event(
        &provider,
        "info",
        "config.preferred_provider_updated",
        "preferred_provider updated",
        serde_json::Value::Null,
    );
    Ok(())
}

#[tauri::command]
fn set_session_preferred_provider(
    state: tauri::State<'_, app_state::AppState>,
    session_id: String,
    provider: String,
) -> Result<(), String> {
    // Canonical session identity: Codex session id (from request headers), not WT_SESSION.
    let codex_session_id = session_id.trim().to_string();
    if codex_session_id.is_empty() {
        return Err("codex_session_id is required".to_string());
    }
    let prev_provider: Option<String> = {
        let mut cfg = state.gateway.cfg.write();
        if !cfg.providers.contains_key(&provider) {
            return Err(format!("unknown provider: {provider}"));
        }
        let prev = cfg
            .routing
            .session_preferred_providers
            .get(&codex_session_id)
            .cloned();
        // No-op: avoid emitting confusing events when the user selects the same provider again.
        if prev.as_deref() == Some(provider.as_str()) {
            return Ok(());
        }
        cfg.routing
            .session_preferred_providers
            .insert(codex_session_id.clone(), provider.clone());
        prev
    };
    persist_config(&state).map_err(|e| e.to_string())?;
    let msg = match prev_provider.as_deref() {
        Some(prev) => format!("session preferred_provider updated: {prev} -> {provider}"),
        None => format!("session preferred_provider set: {provider}"),
    };
    state.gateway.store.add_event(
        &provider,
        "info",
        "config.session_preferred_provider_updated",
        &msg,
        serde_json::json!({
            "codex_session_id": codex_session_id,
            "provider": provider,
            "prev_provider": prev_provider,
        }),
    );
    Ok(())
}

#[tauri::command]
fn clear_session_preferred_provider(
    state: tauri::State<'_, app_state::AppState>,
    session_id: String,
) -> Result<(), String> {
    let codex_session_id = session_id.trim().to_string();
    if codex_session_id.is_empty() {
        return Err("codex_session_id is required".to_string());
    }
    let prev_provider: Option<String> = {
        let mut cfg = state.gateway.cfg.write();
        cfg.routing
            .session_preferred_providers
            .remove(&codex_session_id)
    };
    // No-op: don't write config or emit events if nothing was set.
    if prev_provider.is_none() {
        return Ok(());
    }
    persist_config(&state).map_err(|e| e.to_string())?;
    state.gateway.store.add_event(
        "gateway",
        "info",
        "config.session_preferred_provider_cleared",
        &format!(
            "session preferred_provider cleared (was {})",
            prev_provider.as_deref().unwrap_or("unknown")
        ),
        serde_json::json!({
            "codex_session_id": codex_session_id,
            "prev_provider": prev_provider,
        }),
    );
    Ok(())
}

#[tauri::command]
fn upsert_provider(
    state: tauri::State<'_, app_state::AppState>,
    name: String,
    display_name: String,
    base_url: String,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("name is required".to_string());
    }
    {
        let mut cfg = state.gateway.cfg.write();
        let is_new = !cfg.providers.contains_key(&name);
        cfg.providers.insert(
            name.clone(),
            crate::orchestrator::config::ProviderConfig {
                display_name,
                base_url,
                usage_adapter: String::new(),
                usage_base_url: None,
                api_key: String::new(),
            },
        );
        if is_new {
            cfg.provider_order.push(name.clone());
        }
        app_state::normalize_provider_order(&mut cfg);
    }
    persist_config(&state).map_err(|e| e.to_string())?;
    state.gateway.store.add_event(
        &name,
        "info",
        "config.provider_upserted",
        "provider upserted",
        serde_json::Value::Null,
    );
    Ok(())
}

#[tauri::command]
fn delete_provider(
    state: tauri::State<'_, app_state::AppState>,
    name: String,
) -> Result<(), String> {
    let mut next_preferred: Option<String> = None;
    {
        let mut cfg = state.gateway.cfg.write();
        cfg.providers.remove(&name);
        cfg.provider_order.retain(|p| p != &name);
        cfg.routing
            .session_preferred_providers
            .retain(|_, pref| pref != &name);
        app_state::normalize_provider_order(&mut cfg);

        if cfg.providers.is_empty() {
            return Err("cannot delete the last provider".to_string());
        }

        if cfg.routing.preferred_provider == name {
            next_preferred = cfg.providers.keys().next().cloned();
            if let Some(p) = next_preferred.clone() {
                cfg.routing.preferred_provider = p;
            }
        }
    }

    // If the deleted provider was manually locked, return to auto.
    {
        let mut mo = state.gateway.router.manual_override.write();
        if mo.as_deref() == Some(&name) {
            *mo = None;
        }
    }
    let _ = state.secrets.clear_provider_key(&name);
    let _ = state.secrets.clear_provider_pricing(&name);
    persist_config(&state).map_err(|e| e.to_string())?;
    state.gateway.store.add_event(
        &name,
        "info",
        "config.provider_deleted",
        "provider deleted",
        serde_json::Value::Null,
    );
    if let Some(p) = next_preferred {
        state.gateway.store.add_event(
            &p,
            "info",
            "config.preferred_provider_updated",
            "preferred_provider updated (deleted old preferred)",
            serde_json::Value::Null,
        );
    }
    Ok(())
}

#[tauri::command]
fn rename_provider(
    state: tauri::State<'_, app_state::AppState>,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    let old = old_name.trim();
    let new = new_name.trim();
    if old.is_empty() || new.is_empty() {
        return Err("name is required".to_string());
    }
    if old == new {
        return Ok(());
    }

    {
        let mut cfg = state.gateway.cfg.write();
        if !cfg.providers.contains_key(old) {
            return Err(format!("unknown provider: {old}"));
        }
        if cfg.providers.contains_key(new) {
            return Err(format!("provider already exists: {new}"));
        }
        if !app_state::migrate_provider_name(&mut cfg, old, new) {
            return Err("rename failed".to_string());
        }
        if let Some(p) = cfg.providers.get_mut(new) {
            p.display_name = new.to_string();
        }
        if cfg.routing.preferred_provider == old {
            cfg.routing.preferred_provider = new.to_string();
        }
        for (_session, pref) in cfg.routing.session_preferred_providers.iter_mut() {
            if pref == old {
                *pref = new.to_string();
            }
        }
        for entry in cfg.provider_order.iter_mut() {
            if entry == old {
                *entry = new.to_string();
            }
        }
        app_state::normalize_provider_order(&mut cfg);
    }

    {
        let mut mo = state.gateway.router.manual_override.write();
        if mo.as_deref() == Some(old) {
            *mo = Some(new.to_string());
        }
    }

    state.gateway.store.rename_provider(old, new);
    state.secrets.rename_provider(old, new)?;
    persist_config(&state).map_err(|e| e.to_string())?;
    state
        .gateway
        .router
        .sync_with_config(&state.gateway.cfg.read(), unix_ms());
    state.gateway.store.add_event(
        new,
        "info",
        "config.provider_renamed",
        "provider renamed",
        serde_json::Value::Null,
    );
    Ok(())
}

#[tauri::command]
fn set_provider_key(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    key: String,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    state.secrets.set_provider_key(&provider, &key)?;
    state.gateway.store.add_event(
        &provider,
        "info",
        "config.provider_key_updated",
        "provider key updated (stored in user-data/secrets.json)",
        serde_json::Value::Null,
    );
    Ok(())
}

#[tauri::command]
fn set_provider_order(
    state: tauri::State<'_, app_state::AppState>,
    order: Vec<String>,
) -> Result<(), String> {
    {
        let mut cfg = state.gateway.cfg.write();
        cfg.provider_order = order;
        app_state::normalize_provider_order(&mut cfg);
    }
    persist_config(&state).map_err(|e| e.to_string())?;
    state.gateway.store.add_event(
        "-",
        "info",
        "config.provider_order_updated",
        "provider order updated",
        serde_json::Value::Null,
    );
    Ok(())
}

#[tauri::command]
fn get_provider_key(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<Option<String>, String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    Ok(state.secrets.get_provider_key(&provider))
}

#[tauri::command]
fn clear_provider_key(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    state.secrets.clear_provider_key(&provider)?;
    state.gateway.store.add_event(
        &provider,
        "info",
        "config.provider_key_cleared",
        "provider key cleared (user-data/secrets.json)",
        serde_json::Value::Null,
    );
    Ok(())
}

#[tauri::command]
async fn refresh_quota(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let snap =
        crate::orchestrator::quota::refresh_quota_for_provider(&state.gateway, &provider).await;
    if snap.last_error.is_empty() && snap.updated_at_unix_ms > 0 {
        state.gateway.store.add_event(
            &provider,
            "info",
            "usage.refresh_succeeded",
            "Usage refresh succeeded",
            serde_json::Value::Null,
        );
    } else {
        // Avoid double-logging: quota.rs already records an error event when refresh fails.
        let err = if snap.last_error.is_empty() {
            "usage refresh failed".to_string()
        } else {
            snap.last_error.chars().take(300).collect::<String>()
        };
        return Err(err);
    }
    Ok(())
}

#[tauri::command]
async fn refresh_quota_shared(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    let group = crate::orchestrator::quota::refresh_quota_shared(&state.gateway, &provider).await?;
    let n = group.len();
    // Keep the message short (events list is meant to be scannable).
    state.gateway.store.add_event(
        "gateway",
        "info",
        "usage.refresh_succeeded",
        &format!("Usage refresh succeeded (shared): {n} providers updated"),
        serde_json::json!({ "providers": n }),
    );
    Ok(())
}

#[tauri::command]
async fn refresh_quota_all(state: tauri::State<'_, app_state::AppState>) -> Result<(), String> {
    let (ok, err, failed) =
        crate::orchestrator::quota::refresh_quota_all_with_summary(&state.gateway).await;
    if err == 0 {
        state.gateway.store.add_event(
            "gateway",
            "info",
            "usage.refresh_succeeded",
            &format!("Usage refresh succeeded: {ok} providers"),
            serde_json::json!({ "providers": ok }),
        );
    } else {
        let shown = failed
            .iter()
            .take(3)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        let suffix = if failed.len() > 3 { ", ..." } else { "" };
        state.gateway.store.add_event(
            "gateway",
            "error",
            "usage.refresh_partial",
            &format!("usage refresh partial: ok={ok} err={err} (failed: {shown}{suffix})"),
            serde_json::json!({ "ok": ok, "err": err, "failed": failed }),
        );
    }
    Ok(())
}

#[tauri::command]
fn set_usage_token(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    token: String,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    state.secrets.set_usage_token(&provider, &token)?;
    state.gateway.store.add_event(
        &provider,
        "info",
        "config.usage_token_updated",
        "usage token updated (user-data/secrets.json)",
        serde_json::Value::Null,
    );
    Ok(())
}

#[tauri::command]
fn clear_usage_token(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    state.secrets.clear_usage_token(&provider)?;
    state.gateway.store.add_event(
        &provider,
        "info",
        "config.usage_token_cleared",
        "usage token cleared (user-data/secrets.json)",
        serde_json::Value::Null,
    );
    Ok(())
}

#[tauri::command]
fn set_usage_base_url(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    url: String,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let u = url.trim().trim_end_matches('/').to_string();
    if u.is_empty() {
        return Err("url is required".to_string());
    }
    if reqwest::Url::parse(&u).is_err() {
        return Err("invalid url".to_string());
    }
    {
        let mut cfg = state.gateway.cfg.write();
        if let Some(p) = cfg.providers.get_mut(&provider) {
            p.usage_base_url = Some(u);
        }
    }
    persist_config(&state).map_err(|e| e.to_string())?;
    state.gateway.store.add_event(
        &provider,
        "info",
        "config.usage_base_url_updated",
        "usage base url updated",
        serde_json::Value::Null,
    );
    Ok(())
}

#[tauri::command]
fn clear_usage_base_url(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    {
        let mut cfg = state.gateway.cfg.write();
        if let Some(p) = cfg.providers.get_mut(&provider) {
            p.usage_base_url = None;
        }
    }
    persist_config(&state).map_err(|e| e.to_string())?;
    state.gateway.store.add_event(
        &provider,
        "info",
        "config.usage_base_url_cleared",
        "usage base url cleared",
        serde_json::Value::Null,
    );
    Ok(())
}

#[tauri::command]
fn set_provider_manual_pricing(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    mode: String,
    amount_usd: Option<f64>,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let mode = mode.trim().to_lowercase();
    match mode.as_str() {
        "none" => {
            state.secrets.clear_provider_pricing(&provider)?;
            state.gateway.store.add_event(
                &provider,
                "info",
                "config.provider_pricing_cleared",
                "provider manual pricing cleared",
                serde_json::Value::Null,
            );
            Ok(())
        }
        "per_request" | "package_total" => {
            let Some(v) = amount_usd else {
                return Err("amount_usd is required".to_string());
            };
            if !v.is_finite() || v <= 0.0 {
                return Err("amount_usd must be > 0".to_string());
            }
            state.secrets.set_provider_pricing(&provider, &mode, v)?;
            state.gateway.store.add_event(
                &provider,
                "info",
                "config.provider_pricing_updated",
                "provider manual pricing updated",
                serde_json::json!({
                    "mode": mode,
                    "amount_usd": v,
                }),
            );
            Ok(())
        }
        _ => Err("mode must be one of: none, per_request, package_total".to_string()),
    }
}

#[tauri::command]
async fn get_effective_usage_base(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<Option<String>, String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    Ok(crate::orchestrator::quota::effective_usage_base(&state.gateway, &provider).await)
}

#[tauri::command]
async fn probe_provider(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    let cfg = state.gateway.cfg.read().clone();
    let Some(p) = cfg.providers.get(&provider) else {
        return Err(format!("unknown provider: {provider}"));
    };
    let now = unix_ms();
    state.gateway.router.sync_with_config(&cfg, now);
    let key = state.secrets.get_provider_key(&provider);

    let (status, _payload) = state
        .gateway
        .upstream
        .get_json(
            p,
            "/v1/models",
            key.as_deref(),
            None,
            cfg.routing.request_timeout_seconds,
        )
        .await
        .map_err(|e| {
            state
                .gateway
                .router
                .mark_failure(&provider, &cfg, &format!("request error: {e}"), now);
            state.gateway.store.add_event(
                &provider,
                "error",
                "health.probe_failed",
                "health probe failed (request error)",
                serde_json::Value::Null,
            );
            format!("request error: {e}")
        })?;

    if (200..300).contains(&status) {
        state.gateway.router.mark_success(&provider, now);
        state.gateway.store.add_event(
            &provider,
            "info",
            "health.probe_ok",
            "health probe ok",
            serde_json::Value::Null,
        );
        return Ok(());
    }

    let err = format!("http {status}");
    state
        .gateway
        .router
        .mark_failure(&provider, &cfg, &err, now);
    state.gateway.store.add_event(
        &provider,
        "error",
        "health.probe_failed",
        "health probe failed",
        serde_json::Value::Null,
    );
    Err(err)
}

#[tauri::command]
async fn codex_account_login(state: tauri::State<'_, app_state::AppState>) -> Result<(), String> {
    let result = codex_app_server::request(
        "account/login/start",
        serde_json::json!({ "type": "chatgpt" }),
    )
    .await?;
    let auth_url = result
        .get("authUrl")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "codex login response missing authUrl".to_string())?;
    codex_app_server::open_external_url(auth_url)?;
    let snap = serde_json::json!({
      "ok": true,
      "checked_at_unix_ms": unix_ms(),
      "signed_in": false,
      "remaining": null,
      "unlimited": null,
      "error": ""
    });
    state.gateway.store.put_codex_account_snapshot(&snap);
    let gateway = state.gateway.clone();
    tauri::async_runtime::spawn(async move {
        let deadline = unix_ms().saturating_add(120_000);
        loop {
            if unix_ms() >= deadline {
                break;
            }
            if let Ok(true) = refresh_codex_account_snapshot(&gateway).await {
                break;
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    Ok(())
}

#[tauri::command]
async fn codex_account_logout(state: tauri::State<'_, app_state::AppState>) -> Result<(), String> {
    let mut error = String::new();
    if let Err(e) = codex_app_server::request("account/logout", Value::Null).await {
        error = e;
    }
    let snap = serde_json::json!({
      "ok": error.is_empty(),
      "checked_at_unix_ms": unix_ms(),
      "signed_in": false,
      "remaining": null,
      "unlimited": null,
      "error": error
    });
    state.gateway.store.put_codex_account_snapshot(&snap);
    Ok(())
}

#[tauri::command]
async fn codex_account_refresh(state: tauri::State<'_, app_state::AppState>) -> Result<(), String> {
    let gateway = state.gateway.clone();
    let _ = refresh_codex_account_snapshot(&gateway).await?;
    Ok(())
}

#[tauri::command]
fn codex_cli_toggle_auth_config_swap(
    state: tauri::State<'_, app_state::AppState>,
    cli_homes: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    crate::codex_cli_swap::toggle_cli_auth_config_swap(&state, cli_homes.unwrap_or_default())
}

#[tauri::command]
fn codex_cli_default_home() -> Result<String, String> {
    crate::codex_cli_swap::default_cli_codex_home()
        .ok_or_else(|| "missing HOME/USERPROFILE".to_string())
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn codex_cli_swap_status(cli_homes: Option<Vec<String>>) -> Result<serde_json::Value, String> {
    crate::codex_cli_swap::cli_auth_config_swap_status(cli_homes.unwrap_or_default())
}

#[tauri::command]
fn provider_switchboard_status(
    state: tauri::State<'_, app_state::AppState>,
    cli_homes: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    crate::provider_switchboard::get_status(&state, cli_homes.unwrap_or_default())
}

#[tauri::command]
fn provider_switchboard_set_target(
    state: tauri::State<'_, app_state::AppState>,
    cli_homes: Option<Vec<String>>,
    target: String,
    provider: Option<String>,
) -> Result<serde_json::Value, String> {
    crate::provider_switchboard::set_target(&state, cli_homes.unwrap_or_default(), target, provider)
}

fn mask_key_preview(key: &str) -> String {
    let k = key.trim();
    let chars: Vec<char> = k.chars().collect();
    if chars.len() < 10 {
        return "set".to_string();
    }
    let start_len = std::cmp::min(6, chars.len().saturating_sub(4));
    let start: String = chars.iter().take(start_len).collect();
    let end: String = chars
        .iter()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("{start}******{end}")
}

fn persist_config(state: &tauri::State<'_, app_state::AppState>) -> anyhow::Result<()> {
    let cfg = state.gateway.cfg.read().clone();
    std::fs::write(&state.config_path, toml::to_string_pretty(&cfg)?)?;
    Ok(())
}

async fn refresh_codex_account_snapshot(
    gateway: &crate::orchestrator::gateway::GatewayState,
) -> Result<bool, String> {
    let mut signed_in = false;
    let mut remaining: Option<String> = None;
    let mut unlimited: Option<bool> = None;
    let mut limit_5h_remaining: Option<String> = None;
    let mut limit_weekly_remaining: Option<String> = None;
    let mut limit_weekly_reset_at: Option<String> = None;
    let mut code_review_remaining: Option<String> = None;
    let mut code_review_reset_at: Option<String> = None;
    let mut error = String::new();

    let auth = codex_app_server::request("getAuthStatus", Value::Null).await?;
    if let Some(tok) = auth.get("authToken").and_then(|v| v.as_str()) {
        if !tok.trim().is_empty() {
            signed_in = true;
        }
    }

    let rate_limits = codex_app_server::request("account/rateLimits/read", Value::Null).await;
    match rate_limits {
        Ok(result) => {
            signed_in = true;
            let rate_limits = get_rate_limits_obj(&result);
            let used_percent = rate_limits
                .and_then(|v| v.get("secondary").or_else(|| v.get("Secondary")))
                .and_then(get_used_percent);

            if let Some(rate_limits) = rate_limits {
                let mut weekly_best: Option<(String, Option<String>, i32)> = None;
                for (key, target) in [
                    ("primary", "primary"),
                    ("Primary", "primary"),
                    ("secondary", "secondary"),
                    ("Secondary", "secondary"),
                ] {
                    if let Some(node) = rate_limits.get(key) {
                        if let Some(used) = get_used_percent(node) {
                            let window_mins = get_window_minutes(node);
                            if window_mins == Some(300) {
                                limit_5h_remaining = Some(format_percent(100.0 - used));
                            } else if window_mins == Some(10080) || target == "secondary" {
                                // Keep weekly remaining/reset paired from the same node.
                                // Prefer the explicit weekly window; otherwise fall back to the first "secondary".
                                let priority = if window_mins == Some(10080) { 2 } else { 1 };
                                let should_update = weekly_best
                                    .as_ref()
                                    .map(|(_, _, p)| priority > *p)
                                    .unwrap_or(true);
                                if should_update {
                                    weekly_best = Some((
                                        format_percent(100.0 - used),
                                        get_reset_time_str(node),
                                        priority,
                                    ));
                                }
                            }
                        }
                    }
                }
                if let Some((rem, reset, _)) = weekly_best {
                    limit_weekly_remaining = Some(rem);
                    limit_weekly_reset_at = reset;
                }

                if code_review_remaining.is_none() {
                    for key in [
                        "codeReview",
                        "code_review",
                        "codeReviewRemaining",
                        "code_review_remaining",
                        "review",
                        "CodeReview",
                    ] {
                        if let Some(node) = rate_limits.get(key) {
                            if let Some(rem) = get_remaining_percent(node) {
                                code_review_remaining = Some(rem);
                                code_review_reset_at = get_reset_time_str(node);
                                break;
                            }
                        }
                    }
                }
            }
            if let Some(credits) = result
                .get("rateLimits")
                .and_then(|v| v.get("credits"))
                .and_then(|v| v.as_object())
            {
                remaining = credits
                    .get("balance")
                    .and_then(parse_number)
                    .map(|n| n.to_string())
                    .or_else(|| {
                        credits
                            .get("balance")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    });
                unlimited = credits.get("unlimited").and_then(|v| v.as_bool());
            }
            if unlimited != Some(true) {
                if let Some(used) = used_percent {
                    remaining = Some(format_percent(100.0 - used));
                }
            }
        }
        Err(e) => {
            if !signed_in {
                error = e;
            }
        }
    }

    // Do not infer code review from other limits.
    // Fetch the dedicated code-review window from ChatGPT usage API when available.
    if let Some(access_token) = read_codex_access_token() {
        if let Ok(Some((remaining, reset_at))) = fetch_code_review_from_wham(&access_token).await {
            code_review_remaining = Some(remaining);
            code_review_reset_at = reset_at;
        }
    }

    let snap = serde_json::json!({
      "ok": error.is_empty(),
      "checked_at_unix_ms": unix_ms(),
      "signed_in": signed_in,
      "remaining": remaining,
      "limit_5h_remaining": limit_5h_remaining,
      "limit_weekly_remaining": limit_weekly_remaining,
      "limit_weekly_reset_at": limit_weekly_reset_at,
      "code_review_remaining": code_review_remaining,
      "code_review_reset_at": code_review_reset_at,
      "unlimited": unlimited,
      "error": error
    });
    gateway.store.put_codex_account_snapshot(&snap);
    Ok(signed_in)
}

fn read_codex_access_token() -> Option<String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(home) = std::env::var("CODEX_HOME") {
        candidates.push(PathBuf::from(home).join("auth.json"));
    }
    if let Ok(user) = std::env::var("USERPROFILE") {
        candidates.push(PathBuf::from(user).join(".codex").join("auth.json"));
    } else if let Ok(home) = std::env::var("HOME") {
        candidates.push(PathBuf::from(home).join(".codex").join("auth.json"));
    }

    for path in candidates {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if let Some(tok) = v
            .get("tokens")
            .and_then(|t| t.get("access_token"))
            .and_then(|t| t.as_str())
        {
            let trimmed = tok.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

async fn fetch_code_review_from_wham(
    token: &str,
) -> Result<Option<(String, Option<String>)>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get("https://chatgpt.com/backend-api/wham/usage")
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    let node = body.get("code_review_rate_limit");
    let used = node
        .and_then(|n| n.get("primary_window"))
        .and_then(get_used_percent);
    let Some(used_percent) = used else {
        return Ok(None);
    };
    let remaining = format_percent(100.0 - used_percent);
    let reset_at = node
        .and_then(|n| n.get("primary_window"))
        .and_then(|n| n.get("reset_at"))
        .and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_u64().and_then(|u| i64::try_from(u).ok()))
                .map(|n| n.to_string())
                .or_else(|| v.as_str().map(|s| s.to_string()))
        });
    Ok(Some((remaining, reset_at)))
}

fn format_percent(value: f64) -> String {
    let mut pct = if value.is_finite() { value } else { 0.0 };
    if pct < 1.0 {
        pct = 0.0;
    }
    if pct > 100.0 {
        pct = 100.0;
    }
    format!("{}%", pct.floor() as i64)
}

fn get_rate_limits_obj(result: &Value) -> Option<&Value> {
    result
        .get("rateLimits")
        .or_else(|| result.get("rate_limits"))
}

fn get_used_percent(obj: &Value) -> Option<f64> {
    obj.get("usedPercent")
        .or_else(|| obj.get("used_percent"))
        .and_then(parse_number)
}

fn get_window_minutes(obj: &Value) -> Option<i64> {
    obj.get("windowDurationMins")
        .or_else(|| obj.get("window_minutes"))
        .or_else(|| obj.get("window_mins"))
        .and_then(parse_number)
        .map(|v| v.round() as i64)
}

fn get_remaining_percent(obj: &Value) -> Option<String> {
    if let Some(used) = get_used_percent(obj) {
        return Some(format_percent(100.0 - used));
    }
    if let Some(rem) = obj
        .get("remainingPercent")
        .or_else(|| obj.get("remaining_percent"))
        .and_then(parse_number)
    {
        return Some(format_percent(rem));
    }
    obj.get("remaining")
        .and_then(parse_number)
        .map(format_percent)
}

fn get_reset_time_str(obj: &Value) -> Option<String> {
    use std::collections::VecDeque;

    fn read_time_value(v: &Value) -> Option<String> {
        if let Some(s) = v.as_str().map(|s| s.trim().to_string()) {
            if !s.is_empty() {
                return Some(s);
            }
        }
        if let Some(n) = v
            .as_u64()
            .or_else(|| v.as_i64().and_then(|x| u64::try_from(x).ok()))
        {
            // Heuristic: seconds vs milliseconds.
            let ms = if n < 1_000_000_000_000 {
                n.saturating_mul(1000)
            } else {
                n
            };
            return Some(ms.to_string());
        }
        None
    }

    // Try direct keys first, then a small BFS for nested shapes.
    let keys = [
        "resetAt",
        "reset_at",
        "resetsAt",
        "resets_at",
        "nextResetAt",
        "next_reset_at",
        "resetTime",
        "reset_time",
        "resetAtUnixMs",
        "reset_at_unix_ms",
        "resetUnixMs",
        "reset_unix_ms",
        "resetAtMs",
        "reset_at_ms",
        "resetMs",
        "reset_ms",
        // Some APIs report window end times instead of reset times.
        "windowEnd",
        "window_end",
        "windowEndsAt",
        "window_ends_at",
        "endsAt",
        "ends_at",
        "endAt",
        "end_at",
        "expiresAt",
        "expires_at",
    ];

    if let Some(map) = obj.as_object() {
        for k in &keys {
            if let Some(v) = map.get(*k) {
                if let Some(out) = read_time_value(v) {
                    return Some(out);
                }
            }
        }
    }

    // BFS through nested objects/arrays, looking for any key that resembles a reset timestamp.
    let mut q = VecDeque::new();
    q.push_back((obj, 0usize));
    while let Some((cur, depth)) = q.pop_front() {
        if depth >= 4 {
            continue;
        }
        match cur {
            Value::Object(map) => {
                for (k, v) in map.iter() {
                    let kl = k.to_ascii_lowercase();
                    if kl.contains("reset") || kl.contains("expire") || kl.contains("windowend") {
                        if let Some(out) = read_time_value(v) {
                            return Some(out);
                        }
                    }
                    if v.is_object() || v.is_array() {
                        q.push_back((v, depth + 1));
                    }
                }
            }
            Value::Array(arr) => {
                for v in arr {
                    if v.is_object() || v.is_array() {
                        q.push_back((v, depth + 1));
                    }
                }
            }
            _ => {}
        }
    }

    None
}

fn parse_number(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_i64().map(|n| n as f64))
        .or_else(|| v.as_u64().map(|n| n as f64))
        .or_else(|| {
            v.as_str().and_then(|s| {
                let cleaned = s.trim().replace([',', '%'], "");
                if cleaned.is_empty() {
                    None
                } else {
                    cleaned.parse::<f64>().ok()
                }
            })
        })
}
