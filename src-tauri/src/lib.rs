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
use chrono::{Local, LocalResult, NaiveDate, TimeZone, Timelike};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
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
            get_provider_timeline,
            set_provider_timeline,
            get_provider_schedule,
            set_provider_schedule,
            set_provider_gap_fill,
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
            get_usage_statistics,
            get_spend_history,
            set_spend_history_entry
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

fn local_day_key_from_unix_ms(ts_unix_ms: u64) -> Option<String> {
    let ts = i64::try_from(ts_unix_ms).ok()?;
    let dt = Local.timestamp_millis_opt(ts).single()?;
    Some(dt.format("%Y-%m-%d").to_string())
}

fn local_day_range_from_key(day_key: &str) -> Option<(u64, u64)> {
    let date = NaiveDate::parse_from_str(day_key, "%Y-%m-%d").ok()?;
    let start_naive = date.and_hms_opt(0, 0, 0)?;
    let start = match Local.from_local_datetime(&start_naive) {
        LocalResult::Single(dt) => dt,
        LocalResult::Ambiguous(a, b) => a.min(b),
        LocalResult::None => return None,
    };
    let end = start + chrono::Duration::days(1);
    let start_ms = u64::try_from(start.timestamp_millis()).ok()?;
    let end_ms = u64::try_from(end.timestamp_millis()).ok()?;
    Some((start_ms, end_ms))
}

fn add_package_total_segment_by_day(
    by_day: &mut BTreeMap<String, f64>,
    package_total_usd: f64,
    segment_start_unix_ms: u64,
    segment_end_unix_ms: u64,
    window_start_unix_ms: u64,
    window_end_unix_ms: u64,
) {
    if !package_total_usd.is_finite() || package_total_usd <= 0.0 {
        return;
    }
    if segment_end_unix_ms <= segment_start_unix_ms || window_end_unix_ms <= window_start_unix_ms {
        return;
    }
    let overlap_start = segment_start_unix_ms.max(window_start_unix_ms);
    let overlap_end = segment_end_unix_ms.min(window_end_unix_ms);
    if overlap_end <= overlap_start {
        return;
    }

    let month_ms = (30_u64 * 24 * 60 * 60 * 1000) as f64;
    let mut cursor = overlap_start;
    while cursor < overlap_end {
        let Some(day_key) = local_day_key_from_unix_ms(cursor) else {
            break;
        };
        let Some((day_start, day_end)) = local_day_range_from_key(&day_key) else {
            break;
        };
        let part_start = cursor.max(day_start);
        let part_end = overlap_end.min(day_end);
        if part_end > part_start {
            let part_ms = (part_end.saturating_sub(part_start)) as f64;
            let cost = package_total_usd * (part_ms / month_ms);
            by_day
                .entry(day_key)
                .and_modify(|v| *v += cost)
                .or_insert(cost);
        }
        if day_end <= cursor {
            break;
        }
        cursor = day_end;
    }
}

fn package_total_schedule_by_day(
    pricing_cfg: Option<&crate::orchestrator::secrets::ProviderPricingConfig>,
    window_start_unix_ms: u64,
    window_end_unix_ms: u64,
) -> BTreeMap<String, f64> {
    let mut by_day: BTreeMap<String, f64> = BTreeMap::new();
    let Some(cfg) = pricing_cfg else {
        return by_day;
    };
    let mut has_timeline = false;
    for period in cfg.periods.iter() {
        if period.mode != "package_total" {
            continue;
        }
        if !period.amount_usd.is_finite() || period.amount_usd <= 0.0 {
            continue;
        }
        let segment_end = period.ended_at_unix_ms.unwrap_or(window_end_unix_ms);
        add_package_total_segment_by_day(
            &mut by_day,
            period.amount_usd,
            period.started_at_unix_ms,
            segment_end,
            window_start_unix_ms,
            window_end_unix_ms,
        );
        has_timeline = true;
    }
    if !has_timeline
        && cfg.mode == "package_total"
        && cfg.amount_usd.is_finite()
        && cfg.amount_usd > 0.0
    {
        add_package_total_segment_by_day(
            &mut by_day,
            cfg.amount_usd,
            window_start_unix_ms,
            window_end_unix_ms,
            window_start_unix_ms,
            window_end_unix_ms,
        );
    }
    by_day
}

fn package_total_amount_for_slice(
    pricing_cfg: Option<&crate::orchestrator::secrets::ProviderPricingConfig>,
    slice_start_unix_ms: u64,
    slice_end_unix_ms: u64,
) -> Option<f64> {
    let cfg = pricing_cfg?;
    if slice_end_unix_ms <= slice_start_unix_ms {
        return None;
    }
    let mut best: Option<(f64, u64, u64)> = None; // (amount, overlap_ms, started_at)
    let mut has_timeline = false;
    for period in cfg.periods.iter() {
        if period.mode != "package_total" {
            continue;
        }
        if !period.amount_usd.is_finite() || period.amount_usd <= 0.0 {
            continue;
        }
        has_timeline = true;
        let period_end = period.ended_at_unix_ms.unwrap_or(u64::MAX);
        let overlap_start = period.started_at_unix_ms.max(slice_start_unix_ms);
        let overlap_end = period_end.min(slice_end_unix_ms);
        if overlap_end <= overlap_start {
            continue;
        }
        let overlap_ms = overlap_end.saturating_sub(overlap_start);
        let should_replace = best
            .as_ref()
            .map(|(_, cur_overlap, cur_started)| {
                overlap_ms > *cur_overlap
                    || (overlap_ms == *cur_overlap && period.started_at_unix_ms >= *cur_started)
            })
            .unwrap_or(true);
        if should_replace {
            best = Some((period.amount_usd, overlap_ms, period.started_at_unix_ms));
        }
    }
    if let Some((amount, _, _)) = best {
        return Some(amount);
    }
    if !has_timeline
        && cfg.mode == "package_total"
        && cfg.amount_usd.is_finite()
        && cfg.amount_usd > 0.0
    {
        return Some(cfg.amount_usd);
    }
    None
}

fn package_total_window_total_by_day_slots(
    pricing_cfg: Option<&crate::orchestrator::secrets::ProviderPricingConfig>,
    window_start_unix_ms: u64,
    window_end_unix_ms: u64,
    window_hours: u64,
) -> f64 {
    if window_end_unix_ms <= window_start_unix_ms || window_hours == 0 {
        return 0.0;
    }
    let slot_ms = 24_u64 * 60 * 60 * 1000;
    let slot_count = (window_hours / 24).max(1);
    let mut total = 0.0_f64;
    for i in 0..slot_count {
        let slot_end = window_end_unix_ms.saturating_sub(i.saturating_mul(slot_ms));
        if slot_end <= window_start_unix_ms {
            break;
        }
        let slot_start = slot_end.saturating_sub(slot_ms).max(window_start_unix_ms);
        if let Some(monthly_total) =
            package_total_amount_for_slice(pricing_cfg, slot_start, slot_end)
        {
            total += monthly_total / 30.0;
        }
    }
    total
}

fn active_package_period(
    pricing_cfg: Option<&crate::orchestrator::secrets::ProviderPricingConfig>,
    now_unix_ms: u64,
) -> Option<(f64, Option<u64>)> {
    let cfg = pricing_cfg?;
    let mut active: Option<(f64, Option<u64>)> = None;
    let mut active_start = 0u64;
    for period in cfg.periods.iter() {
        if period.mode != "package_total" {
            continue;
        }
        if !period.amount_usd.is_finite() || period.amount_usd <= 0.0 {
            continue;
        }
        let ended = period.ended_at_unix_ms.unwrap_or(u64::MAX);
        if period.started_at_unix_ms <= now_unix_ms
            && now_unix_ms < ended
            && period.started_at_unix_ms >= active_start
        {
            active = Some((period.amount_usd, period.ended_at_unix_ms));
            active_start = period.started_at_unix_ms;
        }
    }
    if active.is_some() {
        return active;
    }
    if cfg.mode == "package_total" && cfg.amount_usd.is_finite() && cfg.amount_usd > 0.0 {
        return Some((cfg.amount_usd, None));
    }
    None
}

fn active_package_total_usd(
    pricing_cfg: Option<&crate::orchestrator::secrets::ProviderPricingConfig>,
    now_unix_ms: u64,
) -> Option<f64> {
    active_package_period(pricing_cfg, now_unix_ms).map(|(amount, _)| amount)
}

fn package_profile_for_day(
    pricing_cfg: Option<&crate::orchestrator::secrets::ProviderPricingConfig>,
    day_start_unix_ms: u64,
) -> Option<(f64, Option<u64>)> {
    let cfg = pricing_cfg?;
    let mut matched: Option<(f64, Option<u64>, u64)> = None;
    for period in cfg.periods.iter() {
        if period.mode != "package_total"
            || !period.amount_usd.is_finite()
            || period.amount_usd <= 0.0
        {
            continue;
        }
        let ended = period.ended_at_unix_ms.unwrap_or(u64::MAX);
        if period.started_at_unix_ms <= day_start_unix_ms && day_start_unix_ms < ended {
            let replace = matched
                .as_ref()
                .map(|(_, _, started)| period.started_at_unix_ms >= *started)
                .unwrap_or(true);
            if replace {
                matched = Some((
                    period.amount_usd,
                    period.ended_at_unix_ms,
                    period.started_at_unix_ms,
                ));
            }
        }
    }
    if let Some((amount, expires, _)) = matched {
        return Some((amount, expires));
    }
    if cfg.mode == "package_total" && cfg.amount_usd.is_finite() && cfg.amount_usd > 0.0 {
        return Some((cfg.amount_usd, None));
    }
    None
}

fn per_request_amount_at(
    pricing_cfg: Option<&crate::orchestrator::secrets::ProviderPricingConfig>,
    ts_unix_ms: u64,
) -> Option<f64> {
    let cfg = pricing_cfg?;
    let mut matched: Option<(f64, u64)> = None;
    for period in cfg.periods.iter() {
        if period.mode != "per_request"
            || !period.amount_usd.is_finite()
            || period.amount_usd <= 0.0
        {
            continue;
        }
        let ended = period.ended_at_unix_ms.unwrap_or(u64::MAX);
        if period.started_at_unix_ms <= ts_unix_ms && ts_unix_ms < ended {
            let replace = matched
                .as_ref()
                .map(|(_, started)| period.started_at_unix_ms >= *started)
                .unwrap_or(true);
            if replace {
                matched = Some((period.amount_usd, period.started_at_unix_ms));
            }
        }
    }
    if let Some((amount, _)) = matched {
        return Some(amount);
    }
    if cfg.mode == "per_request" && cfg.amount_usd.is_finite() && cfg.amount_usd > 0.0 {
        return Some(cfg.amount_usd);
    }
    None
}

fn has_per_request_timeline(
    pricing_cfg: Option<&crate::orchestrator::secrets::ProviderPricingConfig>,
) -> bool {
    let Some(cfg) = pricing_cfg else {
        return false;
    };
    cfg.periods.iter().any(|period| {
        period.mode == "per_request" && period.amount_usd.is_finite() && period.amount_usd > 0.0
    })
}

fn aligned_bucket_start_unix_ms(ts_unix_ms: u64, bucket_ms: u64) -> Option<u64> {
    if bucket_ms == 24 * 60 * 60 * 1000 {
        let day_key = local_day_key_from_unix_ms(ts_unix_ms)?;
        let (start, _) = local_day_range_from_key(&day_key)?;
        return Some(start);
    }
    if bucket_ms == 60 * 60 * 1000 {
        let ts = i64::try_from(ts_unix_ms).ok()?;
        let dt = Local.timestamp_millis_opt(ts).single()?;
        let hour = dt.with_minute(0)?.with_second(0)?.with_nanosecond(0)?;
        return u64::try_from(hour.timestamp_millis()).ok();
    }
    if bucket_ms == 0 {
        return Some(ts_unix_ms);
    }
    Some((ts_unix_ms / bucket_ms) * bucket_ms)
}

#[tauri::command]
fn get_usage_statistics(
    state: tauri::State<'_, app_state::AppState>,
    hours: Option<u64>,
    providers: Option<Vec<String>>,
    models: Option<Vec<String>>,
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

    fn projection_hours_until_midnight_cap_16() -> f64 {
        let now = Local::now();
        let secs_since_midnight =
            now.hour() as u64 * 3600 + now.minute() as u64 * 60 + now.second() as u64;
        let secs_to_midnight = 24 * 3600_u64 - secs_since_midnight.min(24 * 3600_u64);
        let hours_to_midnight = secs_to_midnight as f64 / 3600.0;
        hours_to_midnight.clamp(0.0, 16.0)
    }

    #[derive(Clone)]
    struct UsageRow {
        provider: String,
        model: String,
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
    }

    fn json_num_or_null(value: Option<f64>) -> Value {
        if let Some(v) = value {
            serde_json::json!(round3(v))
        } else {
            Value::Null
        }
    }

    let now = unix_ms();
    let window_hours = hours.unwrap_or(24).clamp(1, 24 * 30);
    let window_ms = window_hours.saturating_mul(60 * 60 * 1000);
    let since_unix_ms = now.saturating_sub(window_ms);
    let provider_filter: BTreeSet<String> = providers
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    let model_filter: BTreeSet<String> = models
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    let has_provider_filter = !provider_filter.is_empty();
    let has_model_filter = !model_filter.is_empty();
    let bucket_ms = if window_hours <= 48 {
        60 * 60 * 1000
    } else {
        24 * 60 * 60 * 1000
    };
    let projection_hours = projection_hours_until_midnight_cap_16();

    let records = state.gateway.store.list_usage_requests(500_000);
    let quota = state.gateway.store.list_quota_snapshots();
    let provider_pricing = state.secrets.list_provider_pricing();

    let mut provider_tokens_24h: BTreeMap<String, u64> = BTreeMap::new();
    let mut provider_active_buckets: BTreeMap<String, BTreeSet<u64>> = BTreeMap::new();
    let mut catalog_providers: BTreeSet<String> = BTreeSet::new();
    let mut catalog_models: BTreeSet<String> = BTreeSet::new();
    let mut timeline: BTreeMap<u64, (u64, u64, u64, u64)> = BTreeMap::new();
    let mut filtered: Vec<UsageRow> = Vec::new();
    let last_24h_unix_ms = now.saturating_sub(24 * 60 * 60 * 1000);
    let mut total_requests = 0u64;
    let mut total_tokens = 0u64;
    let mut total_cache_creation_tokens = 0u64;
    let mut total_cache_read_tokens = 0u64;
    let mut by_model_map: BTreeMap<String, ModelAgg> = BTreeMap::new();
    let mut by_provider_map: BTreeMap<String, ProviderAgg> = BTreeMap::new();
    let mut provider_req_by_day_in_window: BTreeMap<String, BTreeMap<String, u64>> =
        BTreeMap::new();
    let mut provider_req_by_day_filtered_total: BTreeMap<String, BTreeMap<String, u64>> =
        BTreeMap::new();
    let mut provider_request_timestamps_in_window: BTreeMap<String, Vec<u64>> = BTreeMap::new();

    for rec in records {
        let ts = rec.get("unix_ms").and_then(|v| v.as_u64()).unwrap_or(0);
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
        let provider_lc = provider.to_ascii_lowercase();
        let model_lc = model.to_ascii_lowercase();
        let input_tokens = rec
            .get("input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let output_tokens = rec
            .get("output_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let total_tokens_row = rec
            .get("total_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(input_tokens.saturating_add(output_tokens));
        let cache_creation_input_tokens = rec
            .get("cache_creation_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let cache_read_input_tokens = rec
            .get("cache_read_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        if ts >= last_24h_unix_ms {
            *provider_tokens_24h.entry(provider.clone()).or_default() += total_tokens_row;
        }
        if has_provider_filter && !provider_filter.contains(&provider_lc) {
            continue;
        }
        if has_model_filter && !model_filter.contains(&model_lc) {
            continue;
        }
        if let Some(day_key) = local_day_key_from_unix_ms(ts) {
            provider_req_by_day_filtered_total
                .entry(provider.clone())
                .or_default()
                .entry(day_key)
                .and_modify(|cur| *cur = cur.saturating_add(1))
                .or_insert(1);
        }
        if ts < since_unix_ms {
            continue;
        }
        catalog_providers.insert(provider.clone());
        catalog_models.insert(model.clone());

        total_requests = total_requests.saturating_add(1);
        total_tokens = total_tokens.saturating_add(total_tokens_row);
        total_cache_creation_tokens =
            total_cache_creation_tokens.saturating_add(cache_creation_input_tokens);
        total_cache_read_tokens = total_cache_read_tokens.saturating_add(cache_read_input_tokens);

        {
            let entry = by_model_map.entry(model.clone()).or_default();
            entry.requests = entry.requests.saturating_add(1);
            entry.input_tokens = entry.input_tokens.saturating_add(input_tokens);
            entry.output_tokens = entry.output_tokens.saturating_add(output_tokens);
            entry.total_tokens = entry.total_tokens.saturating_add(total_tokens_row);
        }
        {
            let entry = by_provider_map.entry(provider.clone()).or_default();
            entry.requests = entry.requests.saturating_add(1);
            entry.total_tokens = entry.total_tokens.saturating_add(total_tokens_row);
        }
        provider_request_timestamps_in_window
            .entry(provider.clone())
            .or_default()
            .push(ts);
        if let Some(day_key) = local_day_key_from_unix_ms(ts) {
            provider_req_by_day_in_window
                .entry(provider.clone())
                .or_default()
                .entry(day_key)
                .and_modify(|cur| *cur = cur.saturating_add(1))
                .or_insert(1);
        }

        let bucket =
            aligned_bucket_start_unix_ms(ts, bucket_ms).unwrap_or((ts / bucket_ms) * bucket_ms);
        provider_active_buckets
            .entry(provider.clone())
            .or_default()
            .insert(bucket);
        let entry = timeline.entry(bucket).or_insert((0, 0, 0, 0));
        entry.0 += 1;
        entry.1 += total_tokens_row;
        entry.2 += cache_creation_input_tokens;
        entry.3 += cache_read_input_tokens;

        filtered.push(UsageRow { provider, model });
    }

    let mut provider_daily_cost_per_token: BTreeMap<String, f64> = BTreeMap::new();
    let mut provider_daily_spent_usd: BTreeMap<String, f64> = BTreeMap::new();
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
            provider_daily_spent_usd.insert(provider.to_string(), spent);
            let tok = provider_tokens_24h.get(provider).copied().unwrap_or(0);
            if tok > 0 {
                provider_daily_cost_per_token.insert(provider.to_string(), spent / tok as f64);
            }
        }
    }

    let mut provider_avg_req_cost: BTreeMap<String, f64> = BTreeMap::new();
    let mut by_provider: Vec<Value> = Vec::new();
    for (provider, agg) in by_provider_map.iter() {
        let active_hours = provider_active_buckets
            .get(provider)
            .map(|buckets| {
                let bucket_hours = bucket_ms as f64 / (60.0 * 60.0 * 1000.0);
                (buckets.len() as f64 * bucket_hours).max(1.0)
            })
            .unwrap_or_else(|| (window_hours as f64).max(1.0));
        let req_per_hour = if active_hours > 0.0 {
            agg.requests as f64 / active_hours
        } else {
            0.0
        };
        let pricing_cfg = provider_pricing.get(provider);
        let mode = pricing_cfg
            .map(|cfg| cfg.mode.trim().to_ascii_lowercase())
            .unwrap_or_else(|| "none".to_string());
        let amount_usd = pricing_cfg
            .map(|cfg| cfg.amount_usd)
            .filter(|v| v.is_finite() && *v > 0.0);
        let req_by_day_in_window = provider_req_by_day_in_window.get(provider);
        let req_by_day_total_filtered = provider_req_by_day_filtered_total.get(provider);
        let usage_days = state.gateway.store.list_usage_days(provider);
        let mut req_by_day: BTreeMap<String, u64> = BTreeMap::new();
        for day in usage_days {
            let Some(day_key) = day.get("day_key").and_then(|v| v.as_str()) else {
                continue;
            };
            let req = day.get("req_count").and_then(|v| v.as_u64()).unwrap_or(0);
            req_by_day
                .entry(day_key.to_string())
                .and_modify(|cur| *cur = cur.saturating_add(req))
                .or_insert(req);
        }
        let mut manual_by_day: BTreeMap<String, (Option<f64>, Option<f64>)> = BTreeMap::new();
        for day in state.gateway.store.list_spend_manual_days(provider) {
            let Some(day_key) = day.get("day_key").and_then(|v| v.as_str()) else {
                continue;
            };
            let manual_total =
                as_f64(day.get("manual_total_usd")).filter(|v| v.is_finite() && *v > 0.0);
            let manual_per_req =
                as_f64(day.get("manual_usd_per_req")).filter(|v| v.is_finite() && *v > 0.0);
            if manual_total.is_some() || manual_per_req.is_some() {
                manual_by_day.insert(day_key.to_string(), (manual_total, manual_per_req));
            }
        }

        let mut total_used_cost_usd: Option<f64> = None;
        let mut estimated_avg_request_cost_usd: Option<f64> = None;
        let mut estimated_daily_cost_usd: Option<f64> = None;
        let mut pricing_source = "none".to_string();
        let mut actual_tracked_spend_usd: Option<f64> = None;
        let mut gap_filled_spend_usd: Option<f64> = None;

        match mode.as_str() {
            "per_request" => {
                let mut timeline_total_used = 0.0_f64;
                let mut timeline_priced_reqs = 0u64;
                if let Some(ts_list) = provider_request_timestamps_in_window.get(provider) {
                    for ts in ts_list {
                        if let Some(per_req) = per_request_amount_at(pricing_cfg, *ts) {
                            timeline_total_used += per_req;
                            timeline_priced_reqs = timeline_priced_reqs.saturating_add(1);
                        }
                    }
                }

                if timeline_priced_reqs > 0 && timeline_total_used > 0.0 {
                    total_used_cost_usd = Some(timeline_total_used);
                    let avg_req = timeline_total_used / timeline_priced_reqs as f64;
                    estimated_avg_request_cost_usd = Some(avg_req);
                    estimated_daily_cost_usd =
                        Some(timeline_total_used + req_per_hour * projection_hours * avg_req);
                    pricing_source = if has_per_request_timeline(pricing_cfg) {
                        "manual_per_request_timeline".to_string()
                    } else {
                        "manual_per_request".to_string()
                    };
                } else if let Some(per_req) = amount_usd {
                    let total_used = per_req * agg.requests as f64;
                    total_used_cost_usd = Some(total_used);
                    estimated_avg_request_cost_usd = Some(per_req);
                    estimated_daily_cost_usd =
                        Some(total_used + req_per_hour * projection_hours * per_req);
                    pricing_source = "manual_per_request".to_string();
                }
            }
            "package_total" => {
                let has_package_timeline = pricing_cfg
                    .map(|cfg| {
                        cfg.periods
                            .iter()
                            .any(|period| period.mode == "package_total")
                    })
                    .unwrap_or(false);
                let scheduled_by_day =
                    package_total_schedule_by_day(pricing_cfg, since_unix_ms, now);
                let forward_window_end = now.saturating_add(window_ms);
                let scheduled_total_by_slots = package_total_window_total_by_day_slots(
                    pricing_cfg,
                    now,
                    forward_window_end,
                    window_hours,
                );
                let mut day_keys: BTreeSet<String> = BTreeSet::new();
                day_keys.extend(scheduled_by_day.keys().cloned());
                day_keys.extend(manual_by_day.keys().cloned());

                let mut scheduled_in_window = 0.0_f64;
                let mut manual_in_window = 0.0_f64;
                let mut total_used = 0.0_f64;

                if manual_by_day.is_empty() {
                    scheduled_in_window = scheduled_total_by_slots;
                    total_used = scheduled_total_by_slots;
                } else {
                    for day_key in day_keys {
                        let scheduled_day = scheduled_by_day.get(&day_key).copied().unwrap_or(0.0);
                        if scheduled_day > 0.0 {
                            scheduled_in_window += scheduled_day;
                        }

                        let manual_window = manual_by_day.get(&day_key).and_then(
                            |(manual_total, manual_per_req)| {
                                let (day_start, day_end) = local_day_range_from_key(&day_key)?;
                                let overlap_start = day_start.max(since_unix_ms);
                                let overlap_end = day_end.min(now);
                                if overlap_end <= overlap_start {
                                    return None;
                                }
                                let ratio = (overlap_end.saturating_sub(overlap_start)) as f64
                                    / (day_end.saturating_sub(day_start).max(1) as f64);
                                let day_req_total = req_by_day_total_filtered
                                    .and_then(|m| m.get(&day_key))
                                    .copied()
                                    .unwrap_or_else(|| {
                                        req_by_day.get(&day_key).copied().unwrap_or(0)
                                    }) as f64;
                                let day_req_in_window = req_by_day_in_window
                                    .and_then(|m| m.get(&day_key))
                                    .copied()
                                    .unwrap_or(0)
                                    as f64;
                                if let Some(v) = manual_total {
                                    if day_req_total > 0.0 {
                                        let req_ratio =
                                            (day_req_in_window / day_req_total).clamp(0.0, 1.0);
                                        Some(*v * req_ratio)
                                    } else {
                                        Some(*v * ratio)
                                    }
                                } else if let Some(v) = manual_per_req {
                                    if day_req_in_window > 0.0 {
                                        Some(*v * day_req_in_window)
                                    } else {
                                        Some(*v * day_req_total * ratio)
                                    }
                                } else {
                                    None
                                }
                            },
                        );

                        if let Some(v) = manual_window {
                            if v > 0.0 {
                                manual_in_window += v;
                                total_used += v;
                            }
                        } else if scheduled_day > 0.0 {
                            total_used += scheduled_day;
                        }
                    }
                }

                if total_used > 0.0 {
                    total_used_cost_usd = Some(total_used);
                    if agg.requests > 0 {
                        estimated_avg_request_cost_usd = Some(total_used / agg.requests as f64);
                    }
                    let active_package_total = active_package_total_usd(pricing_cfg, now);
                    if let Some(v) = active_package_total {
                        estimated_daily_cost_usd = Some(v / 30.0);
                    } else if window_hours > 0 {
                        estimated_daily_cost_usd = Some(total_used * 24.0 / window_hours as f64);
                    }
                    pricing_source = if scheduled_in_window > 0.0 && manual_in_window > 0.0 {
                        "manual_package_timeline+manual_history".to_string()
                    } else if scheduled_in_window > 0.0 {
                        "manual_package_timeline".to_string()
                    } else {
                        "manual_history".to_string()
                    };
                    if manual_in_window > 0.0 {
                        gap_filled_spend_usd = Some(manual_in_window);
                    }
                } else if !has_package_timeline {
                    if let Some(package_total) = amount_usd {
                        let total_used = if window_hours >= 30 * 24 {
                            package_total
                        } else {
                            package_total * (window_hours as f64 / (30.0 * 24.0))
                        };
                        total_used_cost_usd = Some(total_used);
                        if agg.requests > 0 {
                            estimated_avg_request_cost_usd = Some(total_used / agg.requests as f64);
                        }
                        estimated_daily_cost_usd = Some(package_total / 30.0);
                        pricing_source = "manual_package_total".to_string();
                    }
                }
            }
            _ => {
                let spend_days = state.gateway.store.list_spend_days(provider);
                let mut tracked_in_window = 0.0_f64;
                for day in spend_days {
                    let tracked = as_f64(day.get("tracked_spend_usd")).unwrap_or(0.0);
                    if tracked <= 0.0 || !tracked.is_finite() {
                        continue;
                    }
                    let started = day
                        .get("started_at_unix_ms")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let Some(day_key) = local_day_key_from_unix_ms(started) else {
                        continue;
                    };
                    let Some((day_start, day_end)) = local_day_range_from_key(&day_key) else {
                        continue;
                    };
                    let overlap_start = day_start.max(since_unix_ms);
                    let overlap_end = day_end.min(now);
                    if overlap_end <= overlap_start {
                        continue;
                    }
                    let time_ratio = (overlap_end.saturating_sub(overlap_start)) as f64
                        / (day_end.saturating_sub(day_start).max(1) as f64);
                    let day_req_total = req_by_day_total_filtered
                        .and_then(|m| m.get(&day_key))
                        .copied()
                        .unwrap_or_else(|| req_by_day.get(&day_key).copied().unwrap_or(0))
                        as f64;
                    let day_req_in_window = req_by_day_in_window
                        .and_then(|m| m.get(&day_key))
                        .copied()
                        .unwrap_or(0) as f64;
                    let ratio = if day_req_total > 0.0 {
                        (day_req_in_window / day_req_total).clamp(0.0, 1.0)
                    } else {
                        time_ratio
                    };
                    tracked_in_window += tracked * ratio;
                }

                let mut manual_additional_in_window = 0.0_f64;
                for (day_key, (manual_total, manual_per_req)) in manual_by_day.iter() {
                    let Some((day_start, day_end)) = local_day_range_from_key(day_key) else {
                        continue;
                    };
                    let overlap_start = day_start.max(since_unix_ms);
                    let overlap_end = day_end.min(now);
                    if overlap_end <= overlap_start {
                        continue;
                    }
                    let ratio = (overlap_end.saturating_sub(overlap_start)) as f64
                        / (day_end.saturating_sub(day_start).max(1) as f64);
                    let day_req_total = req_by_day_total_filtered
                        .and_then(|m| m.get(day_key))
                        .copied()
                        .unwrap_or_else(|| req_by_day.get(day_key).copied().unwrap_or(0))
                        as f64;
                    let day_req_in_window = req_by_day_in_window
                        .and_then(|m| m.get(day_key))
                        .copied()
                        .unwrap_or(0) as f64;
                    if let Some(v) = manual_total {
                        if day_req_total > 0.0 {
                            let req_ratio = (day_req_in_window / day_req_total).clamp(0.0, 1.0);
                            manual_additional_in_window += *v * req_ratio;
                        } else {
                            manual_additional_in_window += *v * ratio;
                        }
                    } else if let Some(v) = manual_per_req {
                        if day_req_in_window > 0.0 {
                            manual_additional_in_window += *v * day_req_in_window;
                        } else {
                            manual_additional_in_window += *v * day_req_total * ratio;
                        }
                    }
                }

                if tracked_in_window > 0.0 || manual_additional_in_window > 0.0 {
                    let total_used = tracked_in_window + manual_additional_in_window;
                    total_used_cost_usd = Some(total_used);
                    if tracked_in_window > 0.0 {
                        actual_tracked_spend_usd = Some(tracked_in_window);
                    }
                    if manual_additional_in_window > 0.0 {
                        gap_filled_spend_usd = Some(manual_additional_in_window);
                    }
                    pricing_source = if tracked_in_window > 0.0 && manual_additional_in_window > 0.0
                    {
                        "provider_budget_api+manual_history".to_string()
                    } else if tracked_in_window > 0.0 {
                        "provider_budget_api".to_string()
                    } else {
                        "manual_history".to_string()
                    };
                } else if let Some(spent_today) = provider_daily_spent_usd.get(provider).copied() {
                    total_used_cost_usd = Some(spent_today);
                    actual_tracked_spend_usd = Some(spent_today);
                    pricing_source = "provider_budget_api_latest_day".to_string();
                } else if let Some(per_tok) = provider_daily_cost_per_token.get(provider).copied() {
                    let estimated = per_tok * agg.total_tokens as f64;
                    if estimated > 0.0 {
                        total_used_cost_usd = Some(estimated);
                        pricing_source = "provider_token_rate".to_string();
                    }
                }

                if let Some(total_used) = total_used_cost_usd {
                    if agg.requests > 0 {
                        let avg = total_used / agg.requests as f64;
                        estimated_avg_request_cost_usd = Some(avg);
                        estimated_daily_cost_usd =
                            Some(total_used + req_per_hour * projection_hours * avg);
                    } else if let Some(spent_today) =
                        provider_daily_spent_usd.get(provider).copied()
                    {
                        estimated_daily_cost_usd = Some(spent_today);
                    }
                }

                if total_used_cost_usd.is_none() {
                    if let Some(cfg) = pricing_cfg {
                        let gap_mode = cfg
                            .gap_fill_mode
                            .as_ref()
                            .map(|m| m.trim().to_ascii_lowercase())
                            .unwrap_or_else(|| "none".to_string());
                        let gap_amount = cfg
                            .gap_fill_amount_usd
                            .filter(|v| v.is_finite() && *v > 0.0);
                        if let Some(amount) = gap_amount {
                            match gap_mode.as_str() {
                                "per_request" => {
                                    let total_used = amount * agg.requests as f64;
                                    total_used_cost_usd = Some(total_used);
                                    estimated_avg_request_cost_usd = Some(amount);
                                    estimated_daily_cost_usd =
                                        Some(total_used + req_per_hour * projection_hours * amount);
                                    gap_filled_spend_usd = Some(total_used);
                                    pricing_source = "gap_fill_per_request".to_string();
                                }
                                "total" => {
                                    total_used_cost_usd = Some(amount);
                                    if agg.requests > 0 {
                                        let avg = amount / agg.requests as f64;
                                        estimated_avg_request_cost_usd = Some(avg);
                                        estimated_daily_cost_usd =
                                            Some(amount + req_per_hour * projection_hours * avg);
                                    }
                                    gap_filled_spend_usd = Some(amount);
                                    pricing_source = "gap_fill_total".to_string();
                                }
                                "per_day_average" => {
                                    let total_used = amount * (window_hours as f64 / 24.0);
                                    total_used_cost_usd = Some(total_used);
                                    if agg.requests > 0 {
                                        estimated_avg_request_cost_usd =
                                            Some(total_used / agg.requests as f64);
                                    }
                                    estimated_daily_cost_usd = Some(amount);
                                    gap_filled_spend_usd = Some(total_used);
                                    pricing_source = "gap_fill_per_day_average".to_string();
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
        }

        if let Some(avg) = estimated_avg_request_cost_usd {
            if avg > 0.0 {
                provider_avg_req_cost.insert(provider.clone(), avg);
            }
        }

        let tokens_per_request = if agg.requests > 0 {
            Some(agg.total_tokens as f64 / agg.requests as f64)
        } else {
            None
        };
        let usd_per_million_tokens =
            if let (Some(total_used), true) = (total_used_cost_usd, agg.total_tokens > 0) {
                Some(total_used / agg.total_tokens as f64 * 1_000_000.0)
            } else {
                None
            };
        let estimated_cost_request_count = if estimated_avg_request_cost_usd.is_some() {
            agg.requests
        } else {
            0
        };
        by_provider.push(serde_json::json!({
            "provider": provider,
            "requests": agg.requests,
            "total_tokens": agg.total_tokens,
            "tokens_per_request": json_num_or_null(tokens_per_request),
            "estimated_total_cost_usd": round3(total_used_cost_usd.unwrap_or(0.0)),
            "estimated_avg_request_cost_usd": json_num_or_null(estimated_avg_request_cost_usd),
            "usd_per_million_tokens": json_num_or_null(usd_per_million_tokens),
            "estimated_daily_cost_usd": json_num_or_null(estimated_daily_cost_usd),
            "total_used_cost_usd": json_num_or_null(total_used_cost_usd),
            "pricing_source": pricing_source,
            "estimated_cost_request_count": estimated_cost_request_count,
            "actual_tracked_spend_usd": json_num_or_null(actual_tracked_spend_usd),
            "gap_filled_spend_usd": json_num_or_null(gap_filled_spend_usd)
        }));
    }
    by_provider.sort_by(|a, b| {
        let ar = a.get("requests").and_then(|v| v.as_u64()).unwrap_or(0);
        let br = b.get("requests").and_then(|v| v.as_u64()).unwrap_or(0);
        br.cmp(&ar)
    });

    for row in &filtered {
        if let Some(avg_req) = provider_avg_req_cost.get(&row.provider).copied() {
            if let Some(entry) = by_model_map.get_mut(&row.model) {
                entry.estimated_total_cost_usd += avg_req;
                entry.estimated_cost_request_count =
                    entry.estimated_cost_request_count.saturating_add(1);
            }
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

    let first_bucket = aligned_bucket_start_unix_ms(since_unix_ms, bucket_ms)
        .unwrap_or((since_unix_ms / bucket_ms) * bucket_ms);
    let last_bucket =
        aligned_bucket_start_unix_ms(now, bucket_ms).unwrap_or((now / bucket_ms) * bucket_ms);
    let mut timeline_points: Vec<Value> = Vec::new();
    let mut bucket = first_bucket;
    while bucket <= last_bucket {
        let (requests, tokens, cache_creation_tokens, cache_read_tokens) =
            timeline.get(&bucket).copied().unwrap_or((0, 0, 0, 0));
        timeline_points.push(serde_json::json!({
            "bucket_unix_ms": bucket,
            "requests": requests,
            "total_tokens": tokens,
            "cache_creation_tokens": cache_creation_tokens,
            "cache_read_tokens": cache_read_tokens
        }));
        bucket = bucket.saturating_add(bucket_ms);
        if bucket_ms == 0 {
            break;
        }
    }

    let total_used_cost_usd = by_provider
        .iter()
        .filter_map(|p| p.get("total_used_cost_usd").and_then(|v| v.as_f64()))
        .sum::<f64>();
    let estimated_daily_cost_usd = by_provider
        .iter()
        .filter_map(|p| p.get("estimated_daily_cost_usd").and_then(|v| v.as_f64()))
        .sum::<f64>();
    let filter_providers_json = if has_provider_filter {
        serde_json::json!(provider_filter.into_iter().collect::<Vec<_>>())
    } else {
        Value::Null
    };
    let filter_models_json = if has_model_filter {
        serde_json::json!(model_filter.into_iter().collect::<Vec<_>>())
    } else {
        Value::Null
    };
    let catalog_provider_values: Vec<String> = catalog_providers.into_iter().collect();
    let catalog_model_values: Vec<String> = catalog_models.into_iter().collect();

    serde_json::json!({
      "ok": true,
      "generated_at_unix_ms": now,
      "window_hours": window_hours,
      "filter": {
        "providers": filter_providers_json,
        "models": filter_models_json
      },
      "catalog": {
        "providers": catalog_provider_values,
        "models": catalog_model_values
      },
      "bucket_seconds": bucket_ms / 1000,
      "summary": {
        "total_requests": total_requests,
        "total_tokens": total_tokens,
        "cache_creation_tokens": total_cache_creation_tokens,
        "cache_read_tokens": total_cache_read_tokens,
        "unique_models": by_model.len(),
        "estimated_total_cost_usd": round3(total_used_cost_usd),
        "estimated_daily_cost_usd": round3(estimated_daily_cost_usd),
        "by_model": by_model,
        "by_provider": by_provider,
        "timeline": timeline_points
      }
    })
}

#[tauri::command]
fn get_provider_schedule(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<serde_json::Value, String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let periods = state.secrets.list_provider_schedule(&provider);
    let rows = periods
        .into_iter()
        .filter_map(|period| {
            let ended = period.ended_at_unix_ms?;
            Some(serde_json::json!({
                "id": period.id,
                "amount_usd": period.amount_usd,
                "api_key_ref": period.api_key_ref,
                "started_at_unix_ms": period.started_at_unix_ms,
                "ended_at_unix_ms": ended,
            }))
        })
        .collect::<Vec<_>>();
    Ok(serde_json::json!({
        "ok": true,
        "provider": provider,
        "periods": rows
    }))
}

#[derive(Debug, Clone, serde::Deserialize)]
struct ProviderSchedulePeriodInput {
    id: Option<String>,
    #[serde(alias = "amountUsd")]
    amount_usd: f64,
    #[serde(default, alias = "apiKeyRef")]
    api_key_ref: Option<String>,
    #[serde(alias = "startedAtUnixMs")]
    started_at_unix_ms: u64,
    #[serde(alias = "endedAtUnixMs")]
    ended_at_unix_ms: u64,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct ProviderTimelinePeriodInput {
    id: Option<String>,
    mode: String,
    #[serde(alias = "amountUsd")]
    amount_usd: f64,
    #[serde(default, alias = "apiKeyRef")]
    api_key_ref: Option<String>,
    #[serde(alias = "startedAtUnixMs")]
    started_at_unix_ms: u64,
    #[serde(default, alias = "endedAtUnixMs")]
    ended_at_unix_ms: Option<u64>,
}

fn provider_api_key_ref(state: &tauri::State<'_, app_state::AppState>, provider: &str) -> String {
    state
        .secrets
        .get_provider_key(provider)
        .as_deref()
        .map(mask_key_preview)
        .unwrap_or_else(|| "-".to_string())
}

#[tauri::command]
fn get_provider_timeline(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<serde_json::Value, String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let rows = state
        .secrets
        .list_provider_timeline(&provider)
        .into_iter()
        .map(|period| {
            serde_json::json!({
                "id": period.id,
                "mode": period.mode,
                "amount_usd": period.amount_usd,
                "api_key_ref": period.api_key_ref,
                "started_at_unix_ms": period.started_at_unix_ms,
                "ended_at_unix_ms": period.ended_at_unix_ms,
            })
        })
        .collect::<Vec<_>>();
    Ok(serde_json::json!({
        "ok": true,
        "provider": provider,
        "periods": rows
    }))
}

#[tauri::command]
fn set_provider_timeline(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    periods: Vec<ProviderTimelinePeriodInput>,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let default_key_ref = provider_api_key_ref(&state, &provider);

    let mut normalized = periods
        .into_iter()
        .map(|period| {
            let mode = period.mode.trim().to_ascii_lowercase();
            if mode != "package_total" && mode != "per_request" {
                return Err("timeline mode must be package_total or per_request".to_string());
            }
            if !period.amount_usd.is_finite() || period.amount_usd <= 0.0 {
                return Err("timeline amount_usd must be > 0".to_string());
            }
            if period.started_at_unix_ms == 0 {
                return Err("timeline started_at_unix_ms must be valid".to_string());
            }
            if mode == "package_total" && period.ended_at_unix_ms.is_none() {
                return Err("package_total timeline requires ended_at_unix_ms".to_string());
            }
            if let Some(end) = period.ended_at_unix_ms {
                if end == 0 || period.started_at_unix_ms >= end {
                    return Err(
                        "timeline started_at_unix_ms must be less than ended_at_unix_ms"
                            .to_string(),
                    );
                }
            }
            Ok(crate::orchestrator::secrets::ProviderPricingPeriod {
                id: period.id.unwrap_or_default(),
                mode,
                amount_usd: period.amount_usd,
                api_key_ref: period
                    .api_key_ref
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| default_key_ref.clone()),
                started_at_unix_ms: period.started_at_unix_ms,
                ended_at_unix_ms: period.ended_at_unix_ms,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    normalized.sort_by(|a, b| a.started_at_unix_ms.cmp(&b.started_at_unix_ms));
    for pair in normalized.windows(2) {
        let left = &pair[0];
        let right = &pair[1];
        let Some(left_end) = left.ended_at_unix_ms else {
            return Err("open-ended timeline period must be the latest row".to_string());
        };
        if left_end > right.started_at_unix_ms {
            return Err("timeline periods must not overlap".to_string());
        }
    }

    let count = normalized.len();
    state.secrets.set_provider_timeline(&provider, normalized)?;
    state.gateway.store.add_event(
        &provider,
        "info",
        "config.provider_timeline_updated",
        "provider pricing timeline updated",
        serde_json::json!({ "count": count }),
    );
    Ok(())
}

#[tauri::command]
fn set_provider_schedule(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    periods: Vec<ProviderSchedulePeriodInput>,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }

    let default_key_ref = provider_api_key_ref(&state, &provider);
    let mut normalized = periods
        .into_iter()
        .map(|period| {
            if !period.amount_usd.is_finite() || period.amount_usd <= 0.0 {
                return Err("period amount_usd must be > 0".to_string());
            }
            if period.started_at_unix_ms == 0 || period.ended_at_unix_ms == 0 {
                return Err("period start/end must be valid timestamps".to_string());
            }
            if period.started_at_unix_ms >= period.ended_at_unix_ms {
                return Err(
                    "period started_at_unix_ms must be less than ended_at_unix_ms".to_string(),
                );
            }
            Ok(crate::orchestrator::secrets::ProviderPricingPeriod {
                id: period.id.unwrap_or_default(),
                mode: "package_total".to_string(),
                amount_usd: period.amount_usd,
                api_key_ref: period
                    .api_key_ref
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| default_key_ref.clone()),
                started_at_unix_ms: period.started_at_unix_ms,
                ended_at_unix_ms: Some(period.ended_at_unix_ms),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    normalized.sort_by(|a, b| a.started_at_unix_ms.cmp(&b.started_at_unix_ms));
    for pair in normalized.windows(2) {
        let left = &pair[0];
        let right = &pair[1];
        let left_end = left.ended_at_unix_ms.unwrap_or(0);
        if left_end > right.started_at_unix_ms {
            return Err("schedule periods must not overlap".to_string());
        }
    }

    let count = normalized.len();
    state.secrets.set_provider_schedule(&provider, normalized)?;
    state.gateway.store.add_event(
        &provider,
        "info",
        "config.provider_schedule_updated",
        "provider scheduled package periods updated",
        serde_json::json!({ "count": count }),
    );
    Ok(())
}

#[tauri::command]
fn get_spend_history(
    state: tauri::State<'_, app_state::AppState>,
    provider: Option<String>,
    days: Option<u64>,
    compact_only: Option<bool>,
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
    let keep_days = days.unwrap_or(60).clamp(1, 365);
    let compact_only = compact_only.unwrap_or(true);
    let since = now.saturating_sub(keep_days.saturating_mul(24 * 60 * 60 * 1000));
    let provider_filter = provider
        .as_deref()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty());

    let cfg = state.gateway.cfg.read().clone();
    let pricing = state.secrets.list_provider_pricing();
    let mut providers: Vec<String> = cfg.providers.keys().cloned().collect();
    providers.sort();

    let mut rows: Vec<Value> = Vec::new();
    for provider_name in providers {
        if provider_filter
            .as_deref()
            .is_some_and(|f| f != provider_name.to_ascii_lowercase())
        {
            continue;
        }

        let mut usage_by_day: BTreeMap<String, (u64, u64, u64)> = BTreeMap::new();
        for day in state.gateway.store.list_usage_days(&provider_name) {
            let Some(day_key) = day.get("day_key").and_then(|v| v.as_str()) else {
                continue;
            };
            let req_count = day.get("req_count").and_then(|v| v.as_u64()).unwrap_or(0);
            let total_tokens = day
                .get("total_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let updated_at = day
                .get("updated_at_unix_ms")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            usage_by_day
                .entry(day_key.to_string())
                .and_modify(|(r, t, u)| {
                    *r = r.saturating_add(req_count);
                    *t = t.saturating_add(total_tokens);
                    *u = (*u).max(updated_at);
                })
                .or_insert((req_count, total_tokens, updated_at));
        }
        // Backfill from raw usage requests so History can show days that existed
        // before `usage_day:*` aggregation was introduced or when day aggregates are missing.
        let mut usage_by_day_from_req: BTreeMap<String, (u64, u64, u64)> = BTreeMap::new();
        for req in state.gateway.store.list_usage_requests(100_000) {
            let req_provider = req.get("provider").and_then(|v| v.as_str()).unwrap_or("");
            if req_provider != provider_name {
                continue;
            }
            let ts = req.get("unix_ms").and_then(|v| v.as_u64()).unwrap_or(0);
            if ts == 0 {
                continue;
            }
            let Some(day_key) = local_day_key_from_unix_ms(ts) else {
                continue;
            };
            let total_tokens = req
                .get("total_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or_else(|| {
                    let input_tokens = req
                        .get("input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let output_tokens = req
                        .get("output_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    input_tokens.saturating_add(output_tokens)
                });
            usage_by_day_from_req
                .entry(day_key)
                .and_modify(|(r, t, u)| {
                    *r = r.saturating_add(1);
                    *t = t.saturating_add(total_tokens);
                    *u = (*u).max(ts);
                })
                .or_insert((1, total_tokens, ts));
        }
        // Backfill only missing days from raw requests; keep existing usage_day aggregation
        // as the canonical source when both are present.
        for (day_key, row) in usage_by_day_from_req {
            usage_by_day.entry(day_key).or_insert(row);
        }

        let mut tracked_by_day: BTreeMap<String, f64> = BTreeMap::new();
        let mut updated_by_day: BTreeMap<String, u64> = BTreeMap::new();
        for day in state.gateway.store.list_spend_days(&provider_name) {
            let started = day
                .get("started_at_unix_ms")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let Some(day_key) = local_day_key_from_unix_ms(started) else {
                continue;
            };
            let tracked = as_f64(day.get("tracked_spend_usd")).unwrap_or(0.0);
            if tracked > 0.0 && tracked.is_finite() {
                tracked_by_day
                    .entry(day_key.clone())
                    .and_modify(|v| *v += tracked)
                    .or_insert(tracked);
            }
            let updated_at = day
                .get("updated_at_unix_ms")
                .and_then(|v| v.as_u64())
                .unwrap_or(started);
            updated_by_day
                .entry(day_key)
                .and_modify(|v| *v = (*v).max(updated_at))
                .or_insert(updated_at);
        }

        let mut manual_by_day: BTreeMap<String, (Option<f64>, Option<f64>, u64)> = BTreeMap::new();
        for day in state.gateway.store.list_spend_manual_days(&provider_name) {
            let Some(day_key) = day.get("day_key").and_then(|v| v.as_str()) else {
                continue;
            };
            let manual_total =
                as_f64(day.get("manual_total_usd")).filter(|v| v.is_finite() && *v > 0.0);
            let manual_per_req =
                as_f64(day.get("manual_usd_per_req")).filter(|v| v.is_finite() && *v > 0.0);
            let updated_at = day
                .get("updated_at_unix_ms")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            manual_by_day.insert(
                day_key.to_string(),
                (manual_total, manual_per_req, updated_at),
            );
        }
        let mut scheduled_by_day =
            package_total_schedule_by_day(pricing.get(&provider_name), since, now);
        scheduled_by_day.retain(|_, v| v.is_finite() && *v > 0.0);

        let mut day_keys: BTreeSet<String> = BTreeSet::new();
        day_keys.extend(usage_by_day.keys().cloned());
        day_keys.extend(tracked_by_day.keys().cloned());
        day_keys.extend(manual_by_day.keys().cloned());
        day_keys.extend(scheduled_by_day.keys().cloned());

        for day_key in day_keys {
            let Some((day_start, _day_end)) = local_day_range_from_key(&day_key) else {
                continue;
            };
            if day_start < since || day_start > now {
                continue;
            }
            let (req_count, total_tokens, usage_updated_at) =
                usage_by_day.get(&day_key).copied().unwrap_or((0, 0, 0));
            let package_profile = package_profile_for_day(pricing.get(&provider_name), day_start);
            let tracked_total = tracked_by_day.get(&day_key).copied();
            let scheduled_total = scheduled_by_day.get(&day_key).copied();
            let scheduled_package_total_usd = package_profile.map(|(amount, _)| amount);
            let (manual_total, manual_per_req, manual_updated_at) = manual_by_day
                .get(&day_key)
                .copied()
                .unwrap_or((None, None, 0));
            let has_scheduled = scheduled_total.is_some() || scheduled_package_total_usd.is_some();
            if compact_only && req_count == 0 && manual_total.is_none() && manual_per_req.is_none()
            {
                continue;
            }

            let manual_additional = if let Some(v) = manual_total {
                Some(v)
            } else if let Some(v) = manual_per_req {
                if req_count > 0 {
                    Some(v * req_count as f64)
                } else {
                    None
                }
            } else {
                None
            };
            let effective_extra = if manual_additional.is_some() {
                manual_additional
            } else {
                scheduled_total
            };
            let effective_total = match (tracked_total, effective_extra) {
                (Some(a), Some(b)) => Some(a + b),
                (Some(a), None) => Some(a),
                (None, Some(b)) => Some(b),
                (None, None) => None,
            };
            let effective_per_req = if let Some(v) = manual_per_req {
                Some(v)
            } else if let Some(total) = effective_total {
                if req_count > 0 {
                    Some(total / req_count as f64)
                } else {
                    None
                }
            } else {
                None
            };
            let source = match (tracked_total, has_scheduled, manual_total, manual_per_req) {
                (Some(_), _, Some(_), _) => "tracked+manual_total",
                (Some(_), _, None, Some(_)) => "tracked+manual_per_request",
                (Some(_), true, None, None) => "tracked+scheduled",
                (Some(_), false, None, None) => "tracked",
                (None, _, Some(_), _) => "manual_total",
                (None, _, None, Some(_)) => "manual_per_request",
                (None, true, None, None) => "scheduled_package_total",
                _ => "none",
            };
            let updated_at = usage_updated_at
                .max(manual_updated_at)
                .max(updated_by_day.get(&day_key).copied().unwrap_or(0));
            rows.push(serde_json::json!({
                "provider": provider_name,
                "day_key": day_key,
                "req_count": req_count,
                "total_tokens": total_tokens,
                "tracked_total_usd": tracked_total.map(round3),
                "scheduled_total_usd": scheduled_total.map(round3),
                "scheduled_package_total_usd": scheduled_package_total_usd.map(round3),
                "manual_total_usd": manual_total.map(round3),
                "manual_usd_per_req": manual_per_req.map(round3),
                "effective_total_usd": effective_total.map(round3),
                "effective_usd_per_req": effective_per_req.map(round3),
                "source": source,
                "updated_at_unix_ms": updated_at
            }));
        }
    }

    rows.sort_by(|a, b| {
        let ad = a.get("day_key").and_then(|v| v.as_str()).unwrap_or("");
        let bd = b.get("day_key").and_then(|v| v.as_str()).unwrap_or("");
        match bd.cmp(ad) {
            std::cmp::Ordering::Equal => {
                let ap = a.get("provider").and_then(|v| v.as_str()).unwrap_or("");
                let bp = b.get("provider").and_then(|v| v.as_str()).unwrap_or("");
                ap.cmp(bp)
            }
            ord => ord,
        }
    });

    serde_json::json!({
        "ok": true,
        "generated_at_unix_ms": now,
        "days": keep_days,
        "rows": rows
    })
}

#[tauri::command]
fn set_spend_history_entry(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    day_key: String,
    total_used_usd: Option<f64>,
    usd_per_req: Option<f64>,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let day_key = day_key.trim().to_string();
    if local_day_range_from_key(&day_key).is_none() {
        return Err("day_key must be YYYY-MM-DD".to_string());
    }
    let total_used_usd = total_used_usd
        .filter(|v| v.is_finite() && *v > 0.0)
        .or(None);
    let usd_per_req = usd_per_req.filter(|v| v.is_finite() && *v > 0.0).or(None);

    if total_used_usd.is_none() && usd_per_req.is_none() {
        state
            .gateway
            .store
            .remove_spend_manual_day(&provider, &day_key);
        state.gateway.store.add_event(
            &provider,
            "info",
            "usage.spend_history_entry_cleared",
            "spend history manual entry cleared",
            serde_json::json!({ "day_key": day_key }),
        );
        return Ok(());
    }

    let row = serde_json::json!({
        "provider": provider,
        "day_key": day_key,
        "manual_total_usd": total_used_usd,
        "manual_usd_per_req": usd_per_req,
        "updated_at_unix_ms": unix_ms()
    });
    state
        .gateway
        .store
        .put_spend_manual_day(&provider, &day_key, &row);
    state.gateway.store.add_event(
        &provider,
        "info",
        "usage.spend_history_entry_updated",
        "spend history manual entry updated",
        serde_json::json!({
            "day_key": day_key,
            "manual_total_usd": total_used_usd,
            "manual_usd_per_req": usd_per_req
        }),
    );
    Ok(())
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
    let now = unix_ms();
    // Never expose keys in UI/API.
    let providers: serde_json::Map<String, serde_json::Value> = cfg
        .providers
        .iter()
        .map(|(name, p)| {
            let key = state.secrets.get_provider_key(name);
            let usage_token = state.secrets.get_usage_token(name);
            let manual_pricing = pricing.get(name).cloned();
            let active_package = active_package_period(manual_pricing.as_ref(), now);
            let active_package_amount = active_package.map(|(amount, _)| amount);
            let active_package_expires = active_package.and_then(|(_, expires)| expires);
            let manual_mode = manual_pricing.as_ref().map(|v| v.mode.clone());
            let manual_amount = manual_pricing.as_ref().and_then(|v| {
                if v.mode == "none" {
                    None
                } else if v.mode == "package_total" {
                    active_package_amount.or(Some(v.amount_usd))
                } else {
                    Some(v.amount_usd)
                }
            });
            let has_key = key.is_some();
            let key_preview = key.as_deref().map(mask_key_preview);
            (
                name.clone(),
                serde_json::json!({
                  "display_name": p.display_name,
                  "base_url": p.base_url,
                  "usage_adapter": p.usage_adapter.clone(),
                  "usage_base_url": p.usage_base_url.clone(),
                  "manual_pricing_mode": manual_mode.filter(|m| m != "none"),
                  "manual_pricing_amount_usd": manual_amount,
                  "manual_pricing_expires_at_unix_ms": active_package_expires,
                  "manual_gap_fill_mode": manual_pricing.as_ref().and_then(|v| v.gap_fill_mode.clone()),
                  "manual_gap_fill_amount_usd": manual_pricing.as_ref().and_then(|v| v.gap_fill_amount_usd),
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
    package_expires_at_unix_ms: Option<u64>,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let mode = mode.trim().to_lowercase();
    let api_key_ref = provider_api_key_ref(&state, &provider);
    match mode.as_str() {
        "none" => {
            state.secrets.set_provider_pricing(
                &provider,
                "none",
                0.0,
                None,
                Some(api_key_ref.clone()),
            )?;
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
            let expires = if mode == "package_total" {
                if let Some(ts) = package_expires_at_unix_ms {
                    if ts <= unix_ms() {
                        return Err("package_expires_at_unix_ms must be in the future".to_string());
                    }
                    Some(ts)
                } else {
                    None
                }
            } else {
                None
            };
            state.secrets.set_provider_pricing(
                &provider,
                &mode,
                v,
                expires,
                Some(api_key_ref.clone()),
            )?;
            state.gateway.store.add_event(
                &provider,
                "info",
                "config.provider_pricing_updated",
                "provider manual pricing updated",
                serde_json::json!({
                    "mode": mode,
                    "amount_usd": v,
                    "package_expires_at_unix_ms": expires,
                }),
            );
            Ok(())
        }
        _ => Err("mode must be one of: none, per_request, package_total".to_string()),
    }
}

#[tauri::command]
fn set_provider_gap_fill(
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
            state.secrets.set_provider_gap_fill(&provider, None, None)?;
            state.gateway.store.add_event(
                &provider,
                "info",
                "config.provider_gap_fill_cleared",
                "provider gap-fill pricing cleared",
                serde_json::Value::Null,
            );
            Ok(())
        }
        "per_request" | "total" | "per_day_average" => {
            let Some(v) = amount_usd else {
                return Err("amount_usd is required".to_string());
            };
            if !v.is_finite() || v <= 0.0 {
                return Err("amount_usd must be > 0".to_string());
            }
            state
                .secrets
                .set_provider_gap_fill(&provider, Some(&mode), Some(v))?;
            state.gateway.store.add_event(
                &provider,
                "info",
                "config.provider_gap_fill_updated",
                "provider gap-fill pricing updated",
                serde_json::json!({
                    "mode": mode,
                    "amount_usd": v,
                }),
            );
            Ok(())
        }
        _ => Err("mode must be one of: none, per_request, total, per_day_average".to_string()),
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
