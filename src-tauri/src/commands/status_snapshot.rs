use sha2::Digest;

fn app_startup_diag_path() -> Option<std::path::PathBuf> {
    let user_data_dir = std::env::var("API_ROUTER_USER_DATA_DIR").ok()?;
    let trimmed = user_data_dir.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(std::path::PathBuf::from(trimmed).join("app-startup.json"))
}

fn append_app_startup_stage(stage: &str, elapsed_ms: Option<u64>, detail: Option<&str>) {
    let Some(path) = app_startup_diag_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut payload = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .unwrap_or_else(|| serde_json::json!({ "stages": [] }));
    let entry = serde_json::json!({
        "stage": stage,
        "elapsedMs": elapsed_ms,
        "detail": detail,
        "updatedAtUnixMs": unix_ms(),
    });
    if let Some(stages) = payload.get_mut("stages").and_then(|value| value.as_array_mut()) {
        stages.push(entry);
    } else {
        payload["stages"] = serde_json::json!([entry]);
    }
    payload["updatedAtUnixMs"] = serde_json::json!(unix_ms());
    let _ = std::fs::write(
        path,
        serde_json::to_vec_pretty(&payload).unwrap_or_default(),
    );
}

fn elapsed_ms_since(started_at: std::time::Instant) -> u64 {
    started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

fn write_dashboard_status_slow_diag(
    diagnostics_dir: &std::path::Path,
    detail_level: &str,
    total_elapsed_ms: u64,
    response_bytes: usize,
    phase_timings_ms: &serde_json::Map<String, serde_json::Value>,
) {
    let diag = serde_json::json!({
        "captured_at_unix_ms": unix_ms(),
        "detail_level": detail_level,
        "total_elapsed_ms": total_elapsed_ms,
        "response_bytes": response_bytes,
        "phase_timings_ms": phase_timings_ms,
    });
    let path = diagnostics_dir.join(format!("status-dashboard-slow-{}.json", unix_ms()));
    let _ = std::fs::write(path, serde_json::to_vec_pretty(&diag).unwrap_or_default());
}

#[tauri::command]
pub(crate) fn get_status(
    state: tauri::State<'_, app_state::AppState>,
    detail_level: Option<String>,
) -> serde_json::Value {
    let command_started_at = std::time::Instant::now();
    let mut phase_timings_ms = serde_json::Map::new();
    let dashboard_detail = detail_level
        .as_deref()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("dashboard"));
    let phase_started_at = std::time::Instant::now();
    let cfg = state.gateway.cfg.read().clone();
    let config_revision = config_revision(&state, &cfg);
    let wsl_gateway_host =
        crate::platform::wsl_gateway_host::cached_or_default_wsl_gateway_host(Some(&state.config_path));
    let local_network_online = state.local_network.refresh_from_system();
    phase_timings_ms.insert(
        "config_and_revision".to_string(),
        serde_json::json!(elapsed_ms_since(phase_started_at)),
    );
    let now = unix_ms();
    let phase_started_at = std::time::Instant::now();
    state.gateway.router.sync_with_config(&cfg, now);
    let providers = state.gateway.router.snapshot(now);
    phase_timings_ms.insert(
        "router_snapshot".to_string(),
        serde_json::json!(elapsed_ms_since(phase_started_at)),
    );
    let manual_override = state.gateway.router.manual_override.read().clone();
    // Keep status payload small: expose only a compact latest-error preview.
    let phase_started_at = std::time::Instant::now();
    let recent_events = if dashboard_detail {
        Vec::new()
    } else {
        state
            .gateway
            .store
            .list_recent_error_events(crate::constants::STATUS_RECENT_ERROR_PREVIEW_LIMIT)
    };
    phase_timings_ms.insert(
        "recent_events".to_string(),
        serde_json::json!(elapsed_ms_since(phase_started_at)),
    );
    let phase_started_at = std::time::Instant::now();
    let metrics = state.gateway.store.get_metrics();
    let quota = state.gateway.store.list_quota_snapshots();
    let mut providers = providers;
    for (provider_name, snapshot) in providers.iter_mut() {
        let hard_cap = state.secrets.get_provider_quota_hard_cap(provider_name);
        if !crate::orchestrator::gateway::provider_has_remaining_quota_with_hard_cap(
            &cfg,
            &quota,
            provider_name,
            &hard_cap,
        ) {
            snapshot.status = "closed".to_string();
            snapshot.cooldown_until_unix_ms = 0;
        }
    }
    let ledgers = state.gateway.store.list_ledgers();
    let projected_ledgers = projected_usage_ledgers(&state.gateway, &quota);
    phase_timings_ms.insert(
        "metrics_quota_ledgers".to_string(),
        serde_json::json!(elapsed_ms_since(phase_started_at)),
    );
    let last_activity = state.gateway.last_activity_unix_ms.load(Ordering::Relaxed);
    let active_recent = last_activity > 0 && now.saturating_sub(last_activity) < 2 * 60 * 1000;
    let phase_started_at = std::time::Instant::now();
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
    phase_timings_ms.insert(
        "active_provider".to_string(),
        serde_json::json!(elapsed_ms_since(phase_started_at)),
    );
    let phase_started_at = std::time::Instant::now();
    let codex_account = state
        .gateway
        .store
        .get_codex_account_snapshot()
        .unwrap_or(serde_json::json!({"ok": false}));
    phase_timings_ms.insert(
        "codex_account".to_string(),
        serde_json::json!(elapsed_ms_since(phase_started_at)),
    );
    let phase_started_at = std::time::Instant::now();
    let lan_sync = state
        .lan_sync
        .snapshot(cfg.listen.port, &cfg, &state.secrets);
    phase_timings_ms.insert(
        "lan_sync_snapshot".to_string(),
        serde_json::json!(elapsed_ms_since(phase_started_at)),
    );
    let phase_started_at = std::time::Instant::now();
    let shared_quota_owners = if dashboard_detail {
        Vec::new()
    } else {
        crate::orchestrator::quota::shared_quota_owner_statuses(&state.gateway, &state.lan_sync)
    };
    phase_timings_ms.insert(
        "shared_quota_owners".to_string(),
        serde_json::json!(elapsed_ms_since(phase_started_at)),
    );

    let phase_started_at = std::time::Instant::now();
    let client_sessions = {
        let map = if !dashboard_detail {
            // Full status may update runtime session discovery; keep this off the dashboard hot path.
            // Session discovery can take seconds on Windows. If this is reintroduced into the
            // dashboard polling path, clicks and scrolling will stutter again because
            // get_status(detailLevel='dashboard') runs on a tight interval.
            let gateway_token = state.secrets.get_gateway_token().unwrap_or_default();
            let expected = (!gateway_token.is_empty()).then_some(gateway_token.as_str());
            let discovered_snapshot = crate::platform::windows_terminal::discover_sessions_using_router_snapshot(
                cfg.listen.port,
                expected,
            );
            let discovered = discovered_snapshot.items;
            let discovery_is_fresh = discovered_snapshot.fresh;
            let live_child_parent_session_ids = if discovery_is_fresh {
                discovered_live_agent_parent_session_ids(&discovered)
            } else {
                std::collections::HashSet::new()
            };
            let mut seen_in_discovery: std::collections::HashSet<String> =
                std::collections::HashSet::new();

            {
                let mut map = state.gateway.client_sessions.write();
                for s in discovered {
                    if !discovery_is_fresh {
                        continue;
                    }
                    let Some(codex_session_id) = s.codex_session_id.as_deref() else {
                        continue;
                    };
                    seen_in_discovery.insert(codex_session_id.to_string());
                    let entry = map.entry(codex_session_id.to_string()).or_insert_with(|| {
                        crate::orchestrator::gateway::ClientSessionRuntime {
                            codex_session_id: codex_session_id.to_string(),
                            pid: s.pid,
                            wt_session: crate::platform::windows_terminal::merge_wt_session_marker(
                                None,
                                &s.wt_session,
                            ),
                            last_request_unix_ms: 0,
                            last_discovered_unix_ms: 0,
                            last_reported_model_provider: None,
                            last_reported_model: None,
                            last_reported_base_url: None,
                            agent_parent_session_id: None,
                            is_agent: s.is_agent,
                            is_review: s.is_review,
                            confirmed_router: s.router_confirmed,
                        }
                    });
                    entry.pid = s.pid;
                    entry.wt_session = crate::platform::windows_terminal::merge_wt_session_marker(
                        entry.wt_session.as_deref(),
                        &s.wt_session,
                    );
                    entry.last_discovered_unix_ms =
                        next_last_discovered_unix_ms(entry.last_discovered_unix_ms, now, true);
                    apply_discovered_router_confirmation(entry, s.router_confirmed, s.is_agent);
                    merge_discovered_model_provider(entry, s.reported_model_provider.as_deref());
                    if let Some(bu) = s.reported_base_url.as_deref() {
                        entry.last_reported_base_url = Some(bu.to_string());
                    }
                    if let Some(parent_sid) = s.agent_parent_session_id.as_deref() {
                        entry.agent_parent_session_id = Some(parent_sid.to_string());
                    }
                    if s.is_agent {
                        entry.is_agent = true;
                    }
                    if s.is_review {
                        entry.is_review = true;
                        entry.is_agent = true;
                    }
                }
                backfill_main_confirmation_from_verified_agent(&mut map, now);
            }

            {
                let mut map = state.gateway.client_sessions.write();
                static WSL_DISCOVERY_MISS_COUNTS: std::sync::OnceLock<
                    std::sync::Mutex<std::collections::HashMap<String, u8>>,
                > = std::sync::OnceLock::new();
                let miss_counts = WSL_DISCOVERY_MISS_COUNTS
                    .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
                let mut miss_counts_guard = miss_counts.lock().ok();
                let mut removed_main_sessions = Vec::new();
                map.retain(|_, v| {
                    let codex_id = v.codex_session_id.clone();
                    let is_wsl_pidless = v.pid == 0
                        && v.wt_session
                            .as_deref()
                            .unwrap_or_default()
                            .trim()
                            .to_ascii_lowercase()
                            .starts_with("wsl:");
                    let seen_now = seen_in_discovery.contains(&codex_id);
                    let wsl_discovery_miss_count = if is_wsl_pidless {
                        if seen_now {
                            if let Some(guard) = miss_counts_guard.as_mut() {
                                guard.remove(&codex_id);
                            }
                            0
                        } else if let Some(guard) = miss_counts_guard.as_mut() {
                            let prev = guard.get(&codex_id).copied().unwrap_or(0);
                            let next =
                                next_wsl_discovery_miss_count(prev, seen_now, discovery_is_fresh);
                            if discovery_is_fresh {
                                guard.insert(codex_id.clone(), next);
                            }
                            next
                        } else {
                            0
                        }
                    } else {
                        if let Some(guard) = miss_counts_guard.as_mut() {
                            guard.remove(&codex_id);
                        }
                        0
                    };

                    let keep = should_keep_runtime_session(
                        v,
                        now,
                        crate::platform::windows_terminal::is_pid_alive,
                        crate::platform::windows_terminal::is_wt_session_alive,
                        wsl_discovery_miss_count,
                        discovery_is_fresh,
                    ) || (!(v.is_agent || v.is_review)
                        && live_child_parent_session_ids.contains(&codex_id));
                    if !(keep || v.is_agent || v.is_review) {
                        removed_main_sessions.push(codex_id);
                    }
                    keep
                });
                if let Some(guard) = miss_counts_guard.as_mut() {
                    let live_ids: std::collections::HashSet<String> =
                        map.keys().map(|k| k.to_string()).collect();
                    guard.retain(|k, _| live_ids.contains(k));
                }
                clear_removed_main_session_routes_and_assignments(
                    &state.gateway,
                    &removed_main_sessions,
                );
                rebalance_balanced_assignments_on_main_session_change(&state.gateway, &cfg, &map);
            }
            state.gateway.client_sessions.read().clone()
        } else {
            // Dashboard must stay cache-only here. Do not run live session discovery in this branch.
            // The cached runtime session map is refreshed by the non-dashboard status path and other
            // session lifecycle updates; using it here keeps the dashboard responsive.
            state.gateway.client_sessions.read().clone()
        };
        let last_used_by_session = state.gateway.last_used_by_session.read().clone();
        let items = recent_client_sessions_with_main_parent_context(&map, 20);
        let sessions = items
            .into_iter()
            .map(|(_codex_session_id, v)| {
                // Consider a session "active" only if it has recently made requests through the router.
                // Discovery scans run frequently and should not keep sessions pinned as active forever.
                let active = session_is_active(&v, now);

                let codex_id = v.codex_session_id.clone();
                let pref = cfg
                    .routing
                    .session_preferred_providers
                    .get(&codex_id)
                    .cloned()
                    .filter(|p| cfg.providers.contains_key(p));
                let current_route = last_used_by_session
                    .get(&codex_id)
                    .filter(|route| cfg.providers.contains_key(route.provider.as_str()));
                let preferred_provider = pref
                    .as_deref()
                    .unwrap_or(cfg.routing.preferred_provider.as_str());
                let (display_provider, display_reason) = displayed_session_route(
                    &state.gateway,
                    &cfg,
                    &codex_id,
                    preferred_provider,
                    v.confirmed_router,
                    current_route,
                );
                let last_seen_unix_ms = v.last_request_unix_ms.max(v.last_discovered_unix_ms);
                serde_json::json!({
                    "id": codex_id,
                    "wt_session": v.wt_session,
                    "codex_session_id": v.codex_session_id,
                    "agent_parent_session_id": v.agent_parent_session_id,
                    "reported_model_provider": v.last_reported_model_provider,
                    "reported_model": v.last_reported_model,
                    "reported_base_url": v.last_reported_base_url,
                    "last_seen_unix_ms": last_seen_unix_ms,
                    "active": active,
                    "preferred_provider": pref,
                    "current_provider": display_provider,
                    "current_reason": display_reason,
                    "verified": v.confirmed_router,
                    "is_agent": v.is_agent,
                    "is_review": v.is_review
                })
            })
            .collect::<Vec<_>>();
        sessions
    };
    phase_timings_ms.insert(
        "client_sessions".to_string(),
        serde_json::json!(elapsed_ms_since(phase_started_at)),
    );

    let response = serde_json::json!({
      "listen": { "host": cfg.listen.host, "port": cfg.listen.port },
      "config_revision": config_revision,
      "wsl_gateway_host": wsl_gateway_host,
      "local_network_online": local_network_online,
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
      "projected_ledgers": projected_ledgers,
      "last_activity_unix_ms": last_activity,
      "codex_account": codex_account,
      "client_sessions": client_sessions,
      "lan_sync": lan_sync,
      "shared_quota_owners": shared_quota_owners
    });
    let total_elapsed_ms = elapsed_ms_since(command_started_at);
    if total_elapsed_ms >= 1000 {
        let response_bytes = serde_json::to_vec(&response).unwrap_or_default();
        write_dashboard_status_slow_diag(
            &state.diagnostics_dir,
            if dashboard_detail { "dashboard" } else { "full" },
            total_elapsed_ms,
            response_bytes.len(),
            &phase_timings_ms,
        );
    }
    response
}

fn config_revision(state: &app_state::AppState, cfg: &crate::orchestrator::config::AppConfig) -> String {
    let followed_source_node_id = state.secrets.get_followed_config_source_node_id();
    let local_copied_shared_ids = crate::lan_sync::load_local_provider_copy_state(state)
        .map(|snapshot| snapshot.copied_shared_provider_ids)
        .unwrap_or_default()
        .into_iter()
        .collect::<Vec<_>>();
    let mut providers = Vec::new();
    for provider_name in &cfg.provider_order {
        let Some(provider_cfg) = cfg.providers.get(provider_name) else {
            continue;
        };
        providers.push(serde_json::json!({
            "name": provider_name,
            "display_name": provider_cfg.display_name,
            "base_url": provider_cfg.base_url,
            "group": provider_cfg.group,
            "disabled": provider_cfg.disabled,
            "usage_adapter": provider_cfg.usage_adapter,
            "usage_base_url": provider_cfg.usage_base_url,
            "shared_provider_id": state.secrets.get_provider_shared_id(provider_name),
            "key_storage": state.secrets.get_provider_key_storage_mode(provider_name),
            "has_key": state.secrets.get_provider_key(provider_name).is_some(),
            "account_email": state.secrets.get_provider_account_email(provider_name),
            "has_usage_token": state.secrets.get_usage_token(provider_name).is_some(),
            "has_usage_login": state.secrets.get_usage_login(provider_name).is_some(),
        }));
    }
    for provider_name in cfg.providers.keys() {
        if cfg.provider_order.iter().any(|entry| entry == provider_name) {
            continue;
        }
        let Some(provider_cfg) = cfg.providers.get(provider_name) else {
            continue;
        };
        providers.push(serde_json::json!({
            "name": provider_name,
            "display_name": provider_cfg.display_name,
            "base_url": provider_cfg.base_url,
            "group": provider_cfg.group,
            "disabled": provider_cfg.disabled,
            "usage_adapter": provider_cfg.usage_adapter,
            "usage_base_url": provider_cfg.usage_base_url,
            "shared_provider_id": state.secrets.get_provider_shared_id(provider_name),
            "key_storage": state.secrets.get_provider_key_storage_mode(provider_name),
            "has_key": state.secrets.get_provider_key(provider_name).is_some(),
            "account_email": state.secrets.get_provider_account_email(provider_name),
            "has_usage_token": state.secrets.get_usage_token(provider_name).is_some(),
            "has_usage_login": state.secrets.get_usage_login(provider_name).is_some(),
        }));
    }
    let payload = serde_json::json!({
        "listen": cfg.listen,
        "routing": cfg.routing,
        "provider_order": cfg.provider_order,
        "followed_source_node_id": followed_source_node_id,
        "copied_shared_provider_ids": local_copied_shared_ids,
        "providers": providers,
    });
    let digest = sha2::Sha256::digest(serde_json::to_vec(&payload).unwrap_or_default());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn projected_usage_ledgers(
    gateway: &crate::orchestrator::gateway::GatewayState,
    quota: &serde_json::Value,
) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    let Some(quota_map) = quota.as_object() else {
        return serde_json::Value::Object(out);
    };

    for (provider_name, snapshot) in quota_map {
        let Some(kind) = snapshot.get("kind").and_then(|value| value.as_str()) else {
            continue;
        };
        if kind != "budget_info" {
            continue;
        }
        let Some(updated_at_unix_ms) = snapshot.get("updated_at_unix_ms").and_then(|value| value.as_u64()) else {
            continue;
        };
        if updated_at_unix_ms == 0 {
            continue;
        }
        let (request_count, total_tokens) = gateway
            .store
            .summarize_usage_requests_since_by_provider(provider_name, updated_at_unix_ms);
        out.insert(
            provider_name.clone(),
            serde_json::json!({
                "since_last_quota_refresh_requests": request_count,
                "since_last_quota_refresh_total_tokens": total_tokens,
                "last_reset_unix_ms": updated_at_unix_ms,
            }),
        );
    }

    serde_json::Value::Object(out)
}

#[tauri::command]
pub(crate) fn record_app_startup_stage(
    stage: String,
    elapsed_ms: Option<u64>,
    detail: Option<String>,
) {
    let stage = stage.trim();
    if stage.is_empty() {
        return;
    }
    append_app_startup_stage(stage, elapsed_ms, detail.as_deref());
}

#[tauri::command]
pub(crate) fn record_ui_watchdog_heartbeat(
    state: tauri::State<'_, app_state::AppState>,
    active_page: String,
    visible: bool,
    status_in_flight: bool,
    config_in_flight: bool,
    provider_switch_in_flight: bool,
) {
    state.ui_watchdog.record_heartbeat(
        &active_page,
        visible,
        status_in_flight,
        config_in_flight,
        provider_switch_in_flight,
        unix_ms(),
    );
}

#[tauri::command]
pub(crate) fn record_ui_trace(
    state: tauri::State<'_, app_state::AppState>,
    kind: String,
    active_page: String,
    visible: bool,
    fields: serde_json::Value,
) {
    state.ui_watchdog.record_trace(
        &kind,
        serde_json::json!({
            "active_page": active_page,
            "visible": visible,
            "fields": fields,
        }),
        unix_ms(),
    );
}

#[derive(serde::Deserialize)]
pub(crate) struct UiTraceBatchEntry {
    kind: String,
    active_page: String,
    visible: bool,
    fields: serde_json::Value,
}

#[derive(serde::Deserialize)]
pub(crate) struct UiInvokeResultBatchEntry {
    command: String,
    elapsed_ms: u64,
    ok: bool,
    error_message: Option<String>,
    active_page: String,
    visible: bool,
}

#[tauri::command]
pub(crate) fn record_ui_diagnostics_batch(
    state: tauri::State<'_, app_state::AppState>,
    traces: Option<Vec<UiTraceBatchEntry>>,
    invoke_results: Option<Vec<UiInvokeResultBatchEntry>>,
) {
    let now = unix_ms();
    for trace in traces.unwrap_or_default().into_iter().take(256) {
        state.ui_watchdog.record_trace(
            &trace.kind,
            serde_json::json!({
                "active_page": trace.active_page,
                "visible": trace.visible,
                "fields": trace.fields,
            }),
            now,
        );
    }
    for result in invoke_results.unwrap_or_default().into_iter().take(256) {
        state.ui_watchdog.record_invoke_result(
            app_state::UiWatchdogRuntime {
                store: &state.gateway.store,
                diagnostics_dir: &state.diagnostics_dir,
            },
            app_state::UiWatchdogInvokeResult {
                command: &result.command,
                elapsed_ms: result.elapsed_ms,
                ok: result.ok,
                error_message: result.error_message.as_deref(),
            },
            app_state::UiWatchdogPageState {
                active_page: &result.active_page,
                visible: result.visible,
            },
            now,
        );
    }
}

#[tauri::command]
pub(crate) fn record_ui_slow_refresh(
    state: tauri::State<'_, app_state::AppState>,
    kind: String,
    elapsed_ms: u64,
    active_page: String,
    visible: bool,
) {
    state.ui_watchdog.record_slow_refresh(
        app_state::UiWatchdogRuntime {
            store: &state.gateway.store,
            diagnostics_dir: &state.diagnostics_dir,
        },
        &kind,
        elapsed_ms,
        app_state::UiWatchdogPageState {
            active_page: &active_page,
            visible,
        },
        unix_ms(),
    );
}

#[tauri::command]
pub(crate) fn record_ui_long_task(
    state: tauri::State<'_, app_state::AppState>,
    elapsed_ms: u64,
    active_page: String,
    visible: bool,
) {
    state.ui_watchdog.record_long_task(
        app_state::UiWatchdogRuntime {
            store: &state.gateway.store,
            diagnostics_dir: &state.diagnostics_dir,
        },
        elapsed_ms,
        app_state::UiWatchdogPageState {
            active_page: &active_page,
            visible,
        },
        unix_ms(),
    );
}

#[tauri::command]
pub(crate) fn record_ui_frame_stall(
    state: tauri::State<'_, app_state::AppState>,
    elapsed_ms: u64,
    monitor_kind: String,
    active_page: String,
    visible: bool,
) {
    state.ui_watchdog.record_frame_stall(
        app_state::UiWatchdogRuntime {
            store: &state.gateway.store,
            diagnostics_dir: &state.diagnostics_dir,
        },
        elapsed_ms,
        &monitor_kind,
        app_state::UiWatchdogPageState {
            active_page: &active_page,
            visible,
        },
        unix_ms(),
    );
}

#[tauri::command]
pub(crate) fn record_ui_frontend_error(
    state: tauri::State<'_, app_state::AppState>,
    kind: String,
    message: String,
    active_page: String,
    visible: bool,
) {
    state.ui_watchdog.record_frontend_error(
        app_state::UiWatchdogRuntime {
            store: &state.gateway.store,
            diagnostics_dir: &state.diagnostics_dir,
        },
        &kind,
        &message,
        app_state::UiWatchdogPageState {
            active_page: &active_page,
            visible,
        },
        unix_ms(),
    );
}

#[tauri::command]
pub(crate) fn record_ui_invoke_result(
    state: tauri::State<'_, app_state::AppState>,
    command: String,
    elapsed_ms: u64,
    ok: bool,
    error_message: Option<String>,
    active_page: String,
    visible: bool,
) {
    state.ui_watchdog.record_invoke_result(
        app_state::UiWatchdogRuntime {
            store: &state.gateway.store,
            diagnostics_dir: &state.diagnostics_dir,
        },
        app_state::UiWatchdogInvokeResult {
            command: &command,
            elapsed_ms,
            ok,
            error_message: error_message.as_deref(),
        },
        app_state::UiWatchdogPageState {
            active_page: &active_page,
            visible,
        },
        unix_ms(),
    );
}

fn merge_discovered_model_provider(
    entry: &mut crate::orchestrator::gateway::ClientSessionRuntime,
    discovered_model_provider: Option<&str>,
) {
    let Some(mp) = discovered_model_provider else {
        return;
    };
    if entry.confirmed_router {
        return;
    }
    entry.last_reported_model_provider = Some(mp.to_string());
}

fn apply_discovered_router_confirmation(
    entry: &mut crate::orchestrator::gateway::ClientSessionRuntime,
    router_confirmed: bool,
    discovered_is_agent: bool,
) {
    if !router_confirmed {
        return;
    }
    entry.confirmed_router = true;
    // For verified non-agent sessions discovered before first request, show codex provider as
    // API Router instead of blank to match gateway ownership semantics.
    if !(discovered_is_agent || entry.is_agent) {
        entry.last_reported_model_provider = Some(crate::constants::GATEWAY_MODEL_PROVIDER_ID.to_string());
    }
}

fn displayed_session_route(
    gateway: &crate::orchestrator::gateway::GatewayState,
    cfg: &crate::orchestrator::config::AppConfig,
    codex_session_id: &str,
    preferred_provider: &str,
    verified: bool,
    current_route: Option<&crate::orchestrator::gateway::LastUsedRoute>,
) -> (Option<String>, Option<String>) {
    if let Some(route) = current_route {
        // Keep status polling cheap: once we have an observed route, reuse it instead of
        // recomputing a full routing decision for every poll.
        return (Some(route.provider.clone()), Some(route.reason.clone()));
    }
    if verified {
        let (provider, reason) = crate::orchestrator::gateway::decide_provider_for_display(
            gateway,
            cfg,
            preferred_provider,
            codex_session_id,
        );
        return (Some(provider), Some(reason.to_string()));
    }
    (None, None)
}

fn clear_removed_main_session_routes_and_assignments(
    gateway: &crate::orchestrator::gateway::GatewayState,
    removed_session_ids: &[String],
) {
    if removed_session_ids.is_empty() {
        return;
    }
    {
        let mut routes = gateway.last_used_by_session.write();
        for session_id in removed_session_ids {
            routes.remove(session_id);
        }
    }
    for session_id in removed_session_ids {
        gateway.store.delete_session_route_assignment(session_id);
    }
}

fn main_session_ids_excluding_agents_and_reviews(
    sessions: &std::collections::HashMap<String, crate::orchestrator::gateway::ClientSessionRuntime>,
) -> std::collections::BTreeSet<String> {
    sessions
        .values()
        .filter(|entry| !(entry.is_agent || entry.is_review))
        .map(|entry| entry.codex_session_id.clone())
        .collect()
}

fn rebalance_balanced_assignments_on_main_session_change(
    gateway: &crate::orchestrator::gateway::GatewayState,
    cfg: &crate::orchestrator::config::AppConfig,
    sessions: &std::collections::HashMap<String, crate::orchestrator::gateway::ClientSessionRuntime>,
) {
    if cfg.routing.route_mode != crate::orchestrator::config::RouteMode::BalancedAuto {
        return;
    }
    let main_session_ids = main_session_ids_excluding_agents_and_reviews(sessions);
    if !gateway
        .router
        .record_balanced_main_sessions(&main_session_ids)
    {
        return;
    }
    let kept_agent_or_review_ids: std::collections::HashSet<String> = sessions
        .values()
        .filter(|entry| entry.is_agent || entry.is_review)
        .map(|entry| entry.codex_session_id.clone())
        .collect();
    {
        let mut routes = gateway.last_used_by_session.write();
        routes.retain(|session_id, _| kept_agent_or_review_ids.contains(session_id));
    }
    let cleared_assignments = gateway.store.delete_all_session_route_assignments();
    gateway.store.add_event(
        "gateway",
        "info",
        "routing.balanced_reassign_on_session_topology_change",
        "cleared balanced assignments after codex session topology changed",
        serde_json::json!({
            "main_session_count": main_session_ids.len(),
            "cleared_session_route_assignments": cleared_assignments
        }),
    );
}

#[derive(Clone)]
struct VerifiedAgentParentAnchor {
    parent_sid: String,
    pid: u32,
    wt_session: Option<String>,
    last_request_unix_ms: u64,
    last_discovered_unix_ms: u64,
    last_reported_model: Option<String>,
    last_reported_base_url: Option<String>,
}

fn verified_agent_parent_anchors(
    map: &std::collections::HashMap<String, crate::orchestrator::gateway::ClientSessionRuntime>,
) -> Vec<VerifiedAgentParentAnchor> {
    map.values()
        .filter(|entry| entry.confirmed_router && entry.is_agent)
        .filter_map(|entry| {
            let parent_sid = entry
                .agent_parent_session_id
                .as_deref()
                .map(str::trim)
                .filter(|sid| !sid.is_empty() && *sid != entry.codex_session_id)?;
            Some(VerifiedAgentParentAnchor {
                parent_sid: parent_sid.to_string(),
                pid: entry.pid,
                wt_session: entry.wt_session.clone(),
                last_request_unix_ms: entry.last_request_unix_ms,
                last_discovered_unix_ms: entry.last_discovered_unix_ms,
                last_reported_model: entry.last_reported_model.clone(),
                last_reported_base_url: entry.last_reported_base_url.clone(),
            })
        })
        .collect()
}

fn infer_agent_parent_sid_from_runtime_map(
    map: &std::collections::HashMap<String, crate::orchestrator::gateway::ClientSessionRuntime>,
    child: &crate::orchestrator::gateway::ClientSessionRuntime,
) -> Option<String> {
    let child_sid = child.codex_session_id.trim();
    if child_sid.is_empty() {
        return None;
    }
    map.values()
        .filter(|candidate| candidate.codex_session_id != child_sid)
        .filter(|candidate| !(candidate.is_agent || candidate.is_review))
        .filter(|candidate| {
            let pid_match = child.pid != 0 && candidate.pid != 0 && child.pid == candidate.pid;
            let wt_match = child
                .wt_session
                .as_deref()
                .zip(candidate.wt_session.as_deref())
                .is_some_and(|(a, b)| {
                    crate::platform::windows_terminal::wt_session_ids_equal(a, b)
                });
            pid_match || wt_match
        })
        .max_by_key(|candidate| {
            candidate
                .last_request_unix_ms
                .max(candidate.last_discovered_unix_ms)
        })
        .map(|candidate| candidate.codex_session_id.clone())
}

fn backfill_main_confirmation_from_verified_agent(
    map: &mut std::collections::HashMap<String, crate::orchestrator::gateway::ClientSessionRuntime>,
    _now_unix_ms: u64,
) {
    let inferred_missing_parents = map
        .values()
        .filter(|entry| entry.is_agent)
        .filter(|entry| entry.agent_parent_session_id.is_none())
        .filter_map(|entry| {
            let parent_sid =
                crate::platform::windows_terminal::infer_parent_session_id_for_agent_session(
                    &entry.codex_session_id,
                )
                .or_else(|| infer_agent_parent_sid_from_runtime_map(map, entry))?;
            if parent_sid == entry.codex_session_id {
                return None;
            }
            Some((entry.codex_session_id.clone(), parent_sid))
        })
        .collect::<Vec<_>>();

    for (child_sid, parent_sid) in inferred_missing_parents {
        if let Some(entry) = map.get_mut(&child_sid) {
            if entry.agent_parent_session_id.is_none() {
                entry.agent_parent_session_id = Some(parent_sid);
            }
        }
    }

    let parent_anchors = verified_agent_parent_anchors(map);

    if !parent_anchors.is_empty() {
        for anchor in &parent_anchors {
            map.entry(anchor.parent_sid.clone()).or_insert_with(|| {
                crate::orchestrator::gateway::ClientSessionRuntime {
                    codex_session_id: anchor.parent_sid.clone(),
                    pid: anchor.pid,
                    wt_session: anchor.wt_session.clone(),
                    last_request_unix_ms: anchor.last_request_unix_ms,
                    last_discovered_unix_ms: anchor.last_discovered_unix_ms,
                    last_reported_model_provider: Some(
                        crate::constants::GATEWAY_MODEL_PROVIDER_ID.to_string(),
                    ),
                    last_reported_model: anchor.last_reported_model.clone(),
                    last_reported_base_url: anchor.last_reported_base_url.clone(),
                    agent_parent_session_id: None,
                    is_agent: false,
                    is_review: false,
                    confirmed_router: true,
                }
            });
        }

        let parent_ids: std::collections::HashSet<String> = parent_anchors
            .iter()
            .map(|anchor| anchor.parent_sid.clone())
            .collect();

        for parent_sid in parent_ids {
            let Some(entry) = map.get_mut(&parent_sid) else {
                continue;
            };
            if entry.confirmed_router || entry.is_agent || entry.is_review {
                continue;
            }
            entry.confirmed_router = true;
            entry.last_reported_model_provider =
                Some(crate::constants::GATEWAY_MODEL_PROVIDER_ID.to_string());
        }
    }

    let verified_main_ids: std::collections::HashSet<String> = map
        .values()
        .filter(|entry| entry.confirmed_router && !(entry.is_agent || entry.is_review))
        .map(|entry| entry.codex_session_id.clone())
        .collect();

    for entry in map.values_mut() {
        if !(entry.is_agent || entry.is_review) || entry.confirmed_router {
            continue;
        }
        let Some(parent_sid) = entry.agent_parent_session_id.as_deref() else {
            continue;
        };
        if !verified_main_ids.contains(parent_sid) {
            continue;
        }
        entry.confirmed_router = true;
        entry.last_reported_model_provider =
            Some(crate::constants::GATEWAY_MODEL_PROVIDER_ID.to_string());
    }

    for entry in map.values_mut() {
        if entry.confirmed_router || entry.is_agent || entry.is_review {
            continue;
        }
        let same_proc = parent_anchors.iter().any(|anchor| {
            let pid_match = anchor.pid != 0 && entry.pid != 0 && anchor.pid == entry.pid;
            let wt_match = anchor
                .wt_session
                .as_deref()
                .zip(entry.wt_session.as_deref())
                .is_some_and(|(a, b)| crate::platform::windows_terminal::wt_session_ids_equal(a, b));
            pid_match || wt_match
        });
        if !same_proc {
            continue;
        }
        entry.confirmed_router = true;
        entry.last_reported_model_provider =
            Some(crate::constants::GATEWAY_MODEL_PROVIDER_ID.to_string());
    }
}

fn session_is_active(entry: &crate::orchestrator::gateway::ClientSessionRuntime, now: u64) -> bool {
    entry.last_request_unix_ms > 0 && now.saturating_sub(entry.last_request_unix_ms) < 60_000
}

fn session_last_seen_unix_ms(
    entry: &crate::orchestrator::gateway::ClientSessionRuntime,
) -> u64 {
    entry.last_request_unix_ms.max(entry.last_discovered_unix_ms)
}

fn recent_client_sessions_with_main_parent_context(
    map: &std::collections::HashMap<String, crate::orchestrator::gateway::ClientSessionRuntime>,
    primary_limit: usize,
) -> Vec<(String, crate::orchestrator::gateway::ClientSessionRuntime)> {
    let mut items: Vec<_> = map
        .iter()
        .map(|(sid, runtime)| (sid.clone(), runtime.clone()))
        .collect();
    items.sort_by_key(|(_sid, runtime)| std::cmp::Reverse(session_last_seen_unix_ms(runtime)));
    if items.len() <= primary_limit {
        return items;
    }

    let mut selected_ids: std::collections::HashSet<String> = items
        .iter()
        .take(primary_limit)
        .map(|(sid, _runtime)| sid.clone())
        .collect();

    for (_sid, runtime) in items.iter().take(primary_limit) {
        if !(runtime.is_agent || runtime.is_review) {
            continue;
        }
        let Some(parent_sid) = runtime
            .agent_parent_session_id
            .as_deref()
            .map(str::trim)
            .filter(|sid| !sid.is_empty())
        else {
            continue;
        };
        if map.contains_key(parent_sid) {
            selected_ids.insert(parent_sid.to_string());
        }
    }

    items.retain(|(sid, _runtime)| selected_ids.contains(sid));
    items
}

fn next_last_discovered_unix_ms(prev: u64, now: u64, discovery_is_fresh: bool) -> u64 {
    if discovery_is_fresh {
        return now;
    }
    prev
}

fn next_wsl_discovery_miss_count(prev: u8, seen_now: bool, discovery_is_fresh: bool) -> u8 {
    if seen_now {
        return 0;
    }
    if !discovery_is_fresh {
        return prev;
    }
    prev.saturating_add(1)
}

fn should_keep_runtime_session(
    entry: &crate::orchestrator::gateway::ClientSessionRuntime,
    now: u64,
    is_pid_alive: fn(u32) -> bool,
    is_wt_session_alive: fn(&str) -> bool,
    wsl_discovery_miss_count: u8,
    discovery_is_fresh: bool,
) -> bool {
    const WSL_MAX_DISCOVERY_MISSES: u8 = 3;
    const PIDLESS_WT_MAX_STALE_MS: u64 = 15 * 60 * 1000;

    let active = session_is_active(entry, now);
    if entry.is_review {
        return active;
    }
    if entry.pid != 0 && !is_pid_alive(entry.pid) {
        return false;
    }
    if entry.pid == 0 {
        let wt = entry.wt_session.as_deref().unwrap_or_default().trim();
        let is_wsl_marker = wt.to_ascii_lowercase().starts_with("wsl:");
        if is_wsl_marker {
            // WSL sessions usually have pid=0 on Windows side. Use consecutive discovery misses
            // to avoid flicker from one-off scan failures while still removing quickly after Ctrl+C.
            if discovery_is_fresh && wsl_discovery_miss_count >= WSL_MAX_DISCOVERY_MISSES {
                return false;
            }
        }

        if !wt.is_empty() {
            let last_seen = entry.last_request_unix_ms.max(entry.last_discovered_unix_ms);
            let stale_too_long =
                last_seen == 0 || now.saturating_sub(last_seen) > PIDLESS_WT_MAX_STALE_MS;
            if !active && stale_too_long {
                return false;
            }
            // WT tab identity is a hard liveness boundary for pid=0 sessions.
            if discovery_is_fresh && !is_wt_session_alive(wt) {
                return false;
            }
        } else if !active {
            return false;
        }
    }
    true
}

fn discovered_live_agent_parent_session_ids(
    discovered: &[crate::platform::windows_terminal::InferredWtSession],
) -> std::collections::HashSet<String> {
    discovered
        .iter()
        .filter(|entry| entry.is_agent || entry.is_review)
        .filter_map(|entry| entry.agent_parent_session_id.as_deref())
        .map(str::trim)
        .filter(|sid| !sid.is_empty())
        .map(str::to_string)
        .collect()
}

fn local_day_key_from_unix_ms(ts_unix_ms: u64) -> Option<String> {
    let ts = i64::try_from(ts_unix_ms).ok()?;
    let dt = Local.timestamp_millis_opt(ts).single()?;
    Some(dt.format("%Y-%m-%d").to_string())
}

fn day_start_unix_ms_from_day_key(day_key: &str) -> Option<u64> {
    let date = chrono::NaiveDate::parse_from_str(day_key, "%Y-%m-%d").ok()?;
    let dt = Local
        .with_ymd_and_hms(
            chrono::Datelike::year(&date),
            chrono::Datelike::month(&date),
            chrono::Datelike::day(&date),
            0,
            0,
            0,
        )
        .single()?;
    u64::try_from(dt.timestamp_millis()).ok()
}

fn event_query_key(e: &Value) -> Option<String> {
    let unix_ms = e.get("unix_ms").and_then(|v| v.as_u64())?;
    let provider = e.get("provider").and_then(|v| v.as_str()).unwrap_or("");
    let level = e.get("level").and_then(|v| v.as_str()).unwrap_or("");
    let code = e.get("code").and_then(|v| v.as_str()).unwrap_or("");
    let message = e.get("message").and_then(|v| v.as_str()).unwrap_or("");
    let fields = e
        .get("fields")
        .and_then(|v| serde_json::to_string(v).ok())
        .unwrap_or_default();
    Some(format!(
        "{unix_ms}|{provider}|{level}|{code}|{message}|{fields}"
    ))
}

fn event_shape_is_valid(e: &Value) -> bool {
    e.get("unix_ms").and_then(|v| v.as_u64()).is_some()
        && e.get("provider").and_then(|v| v.as_str()).is_some()
        && e.get("level").and_then(|v| v.as_str()).is_some()
        && e.get("code").and_then(|v| v.as_str()).is_some()
        && e.get("message").and_then(|v| v.as_str()).is_some()
}

const EVENT_LOG_QUERY_DEFAULT_LIMIT: usize = 2000;
const EVENT_LOG_QUERY_MAX_LIMIT: usize = 5000;

fn normalize_event_query_limit(limit: Option<usize>) -> usize {
    limit
        .unwrap_or(EVENT_LOG_QUERY_DEFAULT_LIMIT)
        .clamp(1, EVENT_LOG_QUERY_MAX_LIMIT)
}

fn event_in_time_window(e: &Value, from: Option<u64>, to: Option<u64>) -> bool {
    let Some(unix_ms) = e.get("unix_ms").and_then(|v| v.as_u64()) else {
        return false;
    };
    if let Some(from_ms) = from {
        if unix_ms < from_ms {
            return false;
        }
    }
    if let Some(to_ms) = to {
        if unix_ms > to_ms {
            return false;
        }
    }
    true
}

fn append_backup_events(
    out: &mut Vec<Value>,
    dedup: &mut std::collections::HashSet<String>,
    data_root: &std::path::Path,
    from: Option<u64>,
    to: Option<u64>,
    cap: usize,
) {
    if out.len() >= cap {
        return;
    }
    let Ok(entries) = std::fs::read_dir(data_root) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= cap {
            break;
        }
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        let include = name.starts_with("sled.backup.")
            || name.starts_with("sled.manual-backup.")
            || name.starts_with("sled.bak.");
        if !include {
            continue;
        }
        let Ok(db) = sled::open(&path) else {
            continue;
        };
        for item in db.scan_prefix(b"event:").rev() {
            if out.len() >= cap {
                break;
            }
            let Ok((_, v)) = item else {
                continue;
            };
            let Ok(e) = serde_json::from_slice::<Value>(&v) else {
                continue;
            };
            if !event_shape_is_valid(&e) {
                continue;
            }
            if !event_in_time_window(&e, from, to) {
                continue;
            }
            let Some(key) = event_query_key(&e) else {
                continue;
            };
            if dedup.insert(key) {
                out.push(e);
            }
        }
    }
}

fn backup_data_root_from_config_path(config_path: &std::path::Path) -> std::path::PathBuf {
    config_path
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join("data")
}

fn append_backup_event_years(years: &mut std::collections::BTreeSet<i32>, backup_root: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(backup_root) else {
        return;
    };
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let include = name.starts_with("sled.backup.")
            || name.starts_with("sled.manual-backup.")
            || name.starts_with("sled.bak.");
        if include && path.is_dir() {
            dirs.push(path);
        }
    }
    dirs.sort();
    for path in dirs {
        let Ok(db) = sled::open(&path) else {
            continue;
        };
        for item in db.scan_prefix(b"event:") {
            let Ok((k, _)) = item else {
                continue;
            };
            let Some(body) = k.as_ref().strip_prefix(b"event:") else {
                continue;
            };
            let Some(split_at) = body.iter().position(|b| *b == b':') else {
                continue;
            };
            let ts_bytes = &body[..split_at];
            let Ok(ts_str) = std::str::from_utf8(ts_bytes) else {
                continue;
            };
            let Ok(unix_ms) = ts_str.parse::<u64>() else {
                continue;
            };
            let Ok(ts) = i64::try_from(unix_ms) else {
                continue;
            };
            if let chrono::LocalResult::Single(dt) = chrono::Local.timestamp_millis_opt(ts) {
                years.insert(chrono::Datelike::year(&dt));
            }
        }
    }
}

fn append_backup_event_daily_stats(
    rows: &mut Vec<Value>,
    backup_root: &std::path::Path,
    from: Option<u64>,
    to: Option<u64>,
) {
    let Ok(entries) = std::fs::read_dir(backup_root) else {
        return;
    };
    let mut existing_days: std::collections::HashSet<String> = rows
        .iter()
        .filter_map(|row| row.get("day").and_then(|v| v.as_str()).map(str::to_string))
        .collect();
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let include = name.starts_with("sled.backup.")
            || name.starts_with("sled.manual-backup.")
            || name.starts_with("sled.bak.");
        if include && path.is_dir() {
            dirs.push(path);
        }
    }
    dirs.sort();
    let mut day_counts: std::collections::BTreeMap<String, (u64, u64, u64, u64)> =
        std::collections::BTreeMap::new();
    for path in dirs {
        let Ok(db) = sled::open(&path) else {
            continue;
        };
        for item in db.scan_prefix(b"event:") {
            let Ok((_, v)) = item else {
                continue;
            };
            let Ok(e) = serde_json::from_slice::<Value>(&v) else {
                continue;
            };
            if !event_shape_is_valid(&e) {
                continue;
            }
            if !event_in_time_window(&e, from, to) {
                continue;
            }
            let Some(unix_ms) = e.get("unix_ms").and_then(|v| v.as_u64()) else {
                continue;
            };
            let Some(day_key) = local_day_key_from_unix_ms(unix_ms) else {
                continue;
            };
            if existing_days.contains(&day_key) {
                continue;
            }
            let level = e.get("level").and_then(|v| v.as_str()).unwrap_or("info");
            let row = day_counts.entry(day_key).or_insert((0, 0, 0, 0));
            row.0 = row.0.saturating_add(1);
            match level {
                "error" => row.3 = row.3.saturating_add(1),
                "warning" => row.2 = row.2.saturating_add(1),
                _ => row.1 = row.1.saturating_add(1),
            }
        }
    }
    for (day, (total, infos, warnings, errors)) in day_counts {
        let Some(day_start_unix_ms) = day_start_unix_ms_from_day_key(&day) else {
            continue;
        };
        rows.push(serde_json::json!({
            "day": day,
            "day_start_unix_ms": day_start_unix_ms,
            "total": total,
            "infos": infos,
            "warnings": warnings,
            "errors": errors,
        }));
        let _ = existing_days.insert(day);
    }
}

fn display_event_minute_bucket(unix_ms: u64) -> u64 {
    unix_ms / 60_000
}

fn display_event_compression_bucket(event: &Value) -> Option<String> {
    let unix_ms = event.get("unix_ms")?.as_u64()?;
    let code = event.get("code")?.as_str()?.trim();
    let minute_bucket = display_event_minute_bucket(unix_ms);
    let fields = event.get("fields").and_then(Value::as_object);
    match code {
        "lan.edit_sync_applied" => {
            let source_node_id = fields
                .and_then(|map| map.get("source_node_id"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase();
            Some(format!("{code}|{minute_bucket}|{source_node_id}"))
        }
        "usage.refresh_shared_applied" => {
            let applied_from_node_id = fields
                .and_then(|map| map.get("applied_from_node_id"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase();
            Some(format!("{code}|{minute_bucket}|{applied_from_node_id}"))
        }
        _ => None,
    }
}

fn compress_noisy_display_events(events: Vec<Value>) -> Vec<Value> {
    let mut passthrough = Vec::new();
    let mut buckets: std::collections::HashMap<String, Vec<Value>> = std::collections::HashMap::new();

    for event in events {
        if let Some(bucket) = display_event_compression_bucket(&event) {
            buckets.entry(bucket).or_default().push(event);
        } else {
            passthrough.push(event);
        }
    }

    for mut bucket_events in buckets.into_values() {
        if bucket_events.len() == 1 {
            if let Some(event) = bucket_events.pop() {
                passthrough.push(event);
            }
            continue;
        }
        bucket_events.sort_by_key(|event| event.get("unix_ms").and_then(Value::as_u64).unwrap_or(0));
        let Some(latest) = bucket_events.last().cloned() else {
            continue;
        };
        let code = latest
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();

        let compressed = match code.as_str() {
            "lan.edit_sync_applied" => {
                let mut applied_total = 0_u64;
                let mut received_total = 0_u64;
                let mut source_node_name = String::new();
                for event in &bucket_events {
                    let fields = event.get("fields").and_then(Value::as_object);
                    applied_total = applied_total.saturating_add(
                        fields
                            .and_then(|map| map.get("applied_events"))
                            .and_then(Value::as_u64)
                            .unwrap_or(0),
                    );
                    received_total = received_total.saturating_add(
                        fields
                            .and_then(|map| map.get("received_events"))
                            .and_then(Value::as_u64)
                            .unwrap_or(0),
                    );
                    if source_node_name.is_empty() {
                        source_node_name = fields
                            .and_then(|map| map.get("source_node_name"))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .trim()
                            .to_string();
                    }
                }
                let mut fields = latest.get("fields").cloned().unwrap_or(Value::Null);
                if let Some(map) = fields.as_object_mut() {
                    map.insert("applied_events".to_string(), serde_json::json!(applied_total));
                    map.insert("received_events".to_string(), serde_json::json!(received_total));
                    map.insert("batch_count".to_string(), serde_json::json!(bucket_events.len()));
                    map.insert("compressed".to_string(), serde_json::json!(true));
                }
                let source_suffix = if source_node_name.is_empty() {
                    String::new()
                } else {
                    format!(" from {source_node_name}")
                };
                serde_json::json!({
                    "unix_ms": latest.get("unix_ms").and_then(Value::as_u64).unwrap_or(0),
                    "provider": latest.get("provider").and_then(Value::as_str).unwrap_or("gateway"),
                    "level": latest.get("level").and_then(Value::as_str).unwrap_or("info"),
                    "code": code,
                    "message": format!(
                        "Applied {applied_total} synced editable event(s) across {} batch(es){source_suffix}",
                        bucket_events.len()
                    ),
                    "fields": fields,
                })
            }
            "usage.refresh_shared_applied" => {
                let mut applied_from_node_name = String::new();
                let mut providers = std::collections::BTreeSet::new();
                for event in &bucket_events {
                    if let Some(provider) = event.get("provider").and_then(Value::as_str) {
                        let trimmed = provider.trim();
                        if !trimmed.is_empty() {
                            let _ = providers.insert(trimmed.to_string());
                        }
                    }
                    let fields = event.get("fields").and_then(Value::as_object);
                    if applied_from_node_name.is_empty() {
                        applied_from_node_name = fields
                            .and_then(|map| map.get("applied_from_node_name"))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .trim()
                        .to_string();
                    }
                }
                let provider_count = providers.len();
                let mut fields = latest.get("fields").cloned().unwrap_or(Value::Null);
                if let Some(map) = fields.as_object_mut() {
                    map.insert("provider_count".to_string(), serde_json::json!(provider_count));
                    map.insert("providers".to_string(), serde_json::json!(providers.clone()));
                    map.insert("event_count".to_string(), serde_json::json!(bucket_events.len()));
                    map.insert("compressed".to_string(), serde_json::json!(true));
                }
                let provider_name = if provider_count == 1 {
                    providers.into_iter().next().unwrap_or_else(|| "gateway".to_string())
                } else {
                    "gateway".to_string()
                };
                let source_label = if applied_from_node_name.is_empty() {
                    "remote peer".to_string()
                } else {
                    applied_from_node_name
                };
                serde_json::json!({
                    "unix_ms": latest.get("unix_ms").and_then(Value::as_u64).unwrap_or(0),
                    "provider": provider_name,
                    "level": latest.get("level").and_then(Value::as_str).unwrap_or("info"),
                    "code": code,
                    "message": format!(
                        "Applied shared usage update from {source_label} to {} provider(s)",
                        provider_count
                    ),
                    "fields": fields,
                })
            }
            _ => latest,
        };
        passthrough.push(compressed);
    }

    passthrough.sort_by(|a, b| {
        let a_ts = a.get("unix_ms").and_then(Value::as_u64).unwrap_or(0);
        let b_ts = b.get("unix_ms").and_then(Value::as_u64).unwrap_or(0);
        b_ts.cmp(&a_ts)
    });
    passthrough
}

#[tauri::command]
pub(crate) fn get_event_log_entries(
    state: tauri::State<'_, app_state::AppState>,
    from_unix_ms: Option<u64>,
    to_unix_ms: Option<u64>,
    limit: Option<usize>,
) -> serde_json::Value {
    let (from, to) = match (from_unix_ms, to_unix_ms) {
        (Some(from), Some(to)) if from > to => (Some(to), Some(from)),
        _ => (from_unix_ms, to_unix_ms),
    };
    let cap = normalize_event_query_limit(limit);
    let mut events = state.gateway.store.list_events_range(from, to, Some(cap));
    events.retain(event_shape_is_valid);
    let mut dedup = std::collections::HashSet::<String>::new();
    for e in &events {
        if let Some(key) = event_query_key(e) {
            let _ = dedup.insert(key);
        }
    }
    let backup_root = state
        .config_path
        .as_path();
    let backup_root = backup_data_root_from_config_path(backup_root);
    append_backup_events(&mut events, &mut dedup, &backup_root, from, to, cap);
    events = compress_noisy_display_events(events);
    events.truncate(cap);
    serde_json::Value::Array(events)
}

#[tauri::command]
pub(crate) fn get_event_log_years(state: tauri::State<'_, app_state::AppState>) -> Vec<i32> {
    let mut years = state.gateway.store.list_event_years();
    let backup_root = backup_data_root_from_config_path(state.config_path.as_path());
    append_backup_event_years(&mut years, &backup_root);
    years.into_iter().collect()
}

#[tauri::command]
pub(crate) fn get_event_log_daily_stats(
    state: tauri::State<'_, app_state::AppState>,
    from_unix_ms: Option<u64>,
    to_unix_ms: Option<u64>,
) -> serde_json::Value {
    let (from, to) = match (from_unix_ms, to_unix_ms) {
        (Some(from), Some(to)) if from > to => (Some(to), Some(from)),
        _ => (from_unix_ms, to_unix_ms),
    };
    let mut rows = state.gateway.store.list_event_daily_counts_range(from, to);
    let backup_root = backup_data_root_from_config_path(state.config_path.as_path());
    append_backup_event_daily_stats(&mut rows, &backup_root, from, to);
    rows.sort_by_key(|row| row.get("day_start_unix_ms").and_then(|v| v.as_u64()).unwrap_or(0));
    serde_json::Value::Array(rows)
}

#[cfg(test)]
mod tests {
    use crate::constants::GATEWAY_MODEL_PROVIDER_ID;
    use crate::commands::{
        apply_discovered_router_confirmation, backfill_main_confirmation_from_verified_agent,
        clear_removed_main_session_routes_and_assignments,
        append_backup_event_daily_stats, day_start_unix_ms_from_day_key, event_query_key,
        config_revision,
        main_session_ids_excluding_agents_and_reviews,
        rebalance_balanced_assignments_on_main_session_change,
        displayed_session_route, merge_discovered_model_provider, next_last_discovered_unix_ms,
        normalize_event_query_limit, next_wsl_discovery_miss_count,
        should_keep_runtime_session,
        compress_noisy_display_events,
    };
    use crate::orchestrator::config::{AppConfig, ListenConfig, ProviderConfig, RoutingConfig};
    use crate::orchestrator::gateway::{decide_provider, open_store_dir, GatewayState, LastUsedRoute};
    use crate::orchestrator::router::RouterState;
    use crate::orchestrator::secrets::SecretStore;
    use crate::orchestrator::store::{unix_ms, UsageRequestSyncRow};
    use crate::orchestrator::upstream::UpstreamClient;
    use crate::orchestrator::gateway::ClientSessionRuntime;
    use chrono::TimeZone;
    use parking_lot::RwLock;
    use serde_json::Value;
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::sync::atomic::AtomicU64;

    #[test]
    fn discovered_provider_does_not_override_confirmed_gateway_session() {
        let mut entry = ClientSessionRuntime {
            codex_session_id: "s1".to_string(),
            pid: 1,
            wt_session: None,
            last_request_unix_ms: 1,
            last_discovered_unix_ms: 1,
            last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
            last_reported_model: None,
            last_reported_base_url: None,
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: true,
        };
        merge_discovered_model_provider(&mut entry, Some("openai"));
        assert_eq!(
            entry.last_reported_model_provider.as_deref(),
            Some(GATEWAY_MODEL_PROVIDER_ID)
        );
    }

    #[test]
    fn compress_noisy_display_events_aggregates_shared_usage_rows() {
        let minute = 1_775_192_400_000_u64;
        let events = vec![
            serde_json::json!({
                "unix_ms": minute + 15_000,
                "provider": "aigateway",
                "level": "info",
                "code": "usage.refresh_shared_applied",
                "message": "Shared usage update applied from DESKTOP-A",
                "fields": {
                    "applied_from_node_id": "node-a",
                    "applied_from_node_name": "DESKTOP-A"
                }
            }),
            serde_json::json!({
                "unix_ms": minute + 20_000,
                "provider": "packycode4",
                "level": "info",
                "code": "usage.refresh_shared_applied",
                "message": "Shared usage update applied from DESKTOP-A",
                "fields": {
                    "applied_from_node_id": "node-a",
                    "applied_from_node_name": "DESKTOP-A"
                }
            }),
        ];

        let compressed = compress_noisy_display_events(events);
        assert_eq!(compressed.len(), 1);
        assert_eq!(
            compressed[0].get("provider").and_then(Value::as_str),
            Some("gateway")
        );
        assert_eq!(
            compressed[0].get("message").and_then(Value::as_str),
            Some("Applied shared usage update from DESKTOP-A to 2 provider(s)")
        );
    }

    #[test]
    fn compress_noisy_display_events_aggregates_edit_sync_batches() {
        let minute = 1_775_192_400_000_u64;
        let events = vec![
            serde_json::json!({
                "unix_ms": minute + 5_000,
                "provider": "gateway",
                "level": "info",
                "code": "lan.edit_sync_applied",
                "message": "applied 10 synced editable event(s)",
                "fields": {
                    "source_node_id": "node-a",
                    "source_node_name": "DESKTOP-A",
                    "received_events": 10,
                    "applied_events": 10
                }
            }),
            serde_json::json!({
                "unix_ms": minute + 40_000,
                "provider": "gateway",
                "level": "info",
                "code": "lan.edit_sync_applied",
                "message": "applied 64 synced editable event(s)",
                "fields": {
                    "source_node_id": "node-a",
                    "source_node_name": "DESKTOP-A",
                    "received_events": 64,
                    "applied_events": 64
                }
            }),
        ];

        let compressed = compress_noisy_display_events(events);
        assert_eq!(compressed.len(), 1);
        assert_eq!(
            compressed[0].get("message").and_then(Value::as_str),
            Some("Applied 74 synced editable event(s) across 2 batch(es) from DESKTOP-A")
        );
        assert_eq!(
            compressed[0]
                .get("fields")
                .and_then(Value::as_object)
                .and_then(|fields| fields.get("batch_count"))
                .and_then(Value::as_u64),
            Some(2)
        );
    }

    #[test]
    fn normalize_event_query_limit_applies_default_and_cap() {
        assert_eq!(normalize_event_query_limit(None), 2000);
        assert_eq!(normalize_event_query_limit(Some(0)), 1);
        assert_eq!(normalize_event_query_limit(Some(999_999)), 5000);
    }

    #[test]
    fn event_query_key_distinguishes_fields_payload() {
        let a = serde_json::json!({
            "unix_ms": 1,
            "provider": "gateway",
            "level": "info",
            "code": "x",
            "message": "same",
            "fields": { "codex_session_id": "s1" }
        });
        let b = serde_json::json!({
            "unix_ms": 1,
            "provider": "gateway",
            "level": "info",
            "code": "x",
            "message": "same",
            "fields": { "codex_session_id": "s2" }
        });
        assert_ne!(event_query_key(&a), event_query_key(&b));
    }

    #[test]
    fn append_backup_event_daily_stats_adds_missing_backup_day() {
        let tmp = tempfile::tempdir().unwrap();
        let backup = tmp.path().join("sled.backup.test");
        std::fs::create_dir_all(&backup).unwrap();
        let db = sled::open(&backup).unwrap();
        let ts = chrono::Local
            .with_ymd_and_hms(2026, 2, 17, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis() as u64;
        let key = format!("event:{ts}:a");
        let v = serde_json::json!({
            "provider": "gateway",
            "level": "warning",
            "unix_ms": ts,
            "code": "test_backup_day",
            "message": "backup only",
            "fields": {}
        });
        db.insert(key.as_bytes(), serde_json::to_vec(&v).unwrap()).unwrap();
        db.flush().unwrap();
        drop(db);

        let mut rows: Vec<serde_json::Value> = Vec::new();
        append_backup_event_daily_stats(&mut rows, tmp.path(), None, None);

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("day").and_then(|v| v.as_str()), Some("2026-02-17"));
        assert_eq!(rows[0].get("warnings").and_then(|v| v.as_u64()), Some(1));
    }

    #[test]
    fn append_backup_event_daily_stats_does_not_duplicate_existing_day() {
        let tmp = tempfile::tempdir().unwrap();
        let backup = tmp.path().join("sled.backup.test2");
        std::fs::create_dir_all(&backup).unwrap();
        let db = sled::open(&backup).unwrap();
        let ts = chrono::Local
            .with_ymd_and_hms(2026, 2, 19, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis() as u64;
        let key = format!("event:{ts}:b");
        let v = serde_json::json!({
            "provider": "gateway",
            "level": "error",
            "unix_ms": ts,
            "code": "test_backup_day_dup",
            "message": "duplicate day",
            "fields": {}
        });
        db.insert(key.as_bytes(), serde_json::to_vec(&v).unwrap()).unwrap();
        db.flush().unwrap();
        drop(db);

        let day_start = day_start_unix_ms_from_day_key("2026-02-19").unwrap();
        let mut rows: Vec<serde_json::Value> = vec![serde_json::json!({
            "day": "2026-02-19",
            "day_start_unix_ms": day_start,
            "total": 3,
            "infos": 2,
            "warnings": 1,
            "errors": 0
        })];
        append_backup_event_daily_stats(&mut rows, tmp.path(), None, None);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("total").and_then(|v| v.as_u64()), Some(3));
    }

    #[test]
    fn discovered_provider_sets_value_when_session_not_confirmed() {
        let mut entry = ClientSessionRuntime {
            codex_session_id: "s2".to_string(),
            pid: 1,
            wt_session: None,
            last_request_unix_ms: 0,
            last_discovered_unix_ms: 1,
            last_reported_model_provider: None,
            last_reported_model: None,
            last_reported_base_url: None,
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: false,
        };
        merge_discovered_model_provider(&mut entry, Some("openai"));
        assert_eq!(entry.last_reported_model_provider.as_deref(), Some("openai"));
    }

    #[test]
    fn confirmed_non_agent_discovery_sets_gateway_provider() {
        let mut entry = ClientSessionRuntime {
            codex_session_id: "s3".to_string(),
            pid: 1,
            wt_session: None,
            last_request_unix_ms: 0,
            last_discovered_unix_ms: 1,
            last_reported_model_provider: None,
            last_reported_model: None,
            last_reported_base_url: None,
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: false,
        };
        apply_discovered_router_confirmation(&mut entry, true, false);
        assert!(entry.confirmed_router);
        assert_eq!(
            entry.last_reported_model_provider.as_deref(),
            Some(GATEWAY_MODEL_PROVIDER_ID)
        );
    }

    #[test]
    fn confirmed_agent_discovery_keeps_provider_unset() {
        let mut entry = ClientSessionRuntime {
            codex_session_id: "s4".to_string(),
            pid: 1,
            wt_session: None,
            last_request_unix_ms: 0,
            last_discovered_unix_ms: 1,
            last_reported_model_provider: None,
            last_reported_model: None,
            last_reported_base_url: None,
            agent_parent_session_id: None,
            is_agent: true,
            is_review: false,
            confirmed_router: false,
        };
        apply_discovered_router_confirmation(&mut entry, true, true);
        assert!(entry.confirmed_router);
        assert_eq!(entry.last_reported_model_provider.as_deref(), None);
    }

    #[test]
    fn displayed_session_route_bootstraps_balanced_assignment_before_first_request() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = open_store_dir(tmp.path().join("data")).expect("store");
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        let mut providers = std::collections::BTreeMap::new();
        providers.insert(
            "p1".to_string(),
            ProviderConfig {
                display_name: "P1".to_string(),
                base_url: "https://p1.example.com".to_string(),
                group: None,
                disabled: false,
                usage_adapter: String::new(),
                usage_base_url: None,
                api_key: String::new(),
            },
        );
        providers.insert(
            "p2".to_string(),
            ProviderConfig {
                display_name: "P2".to_string(),
                base_url: "https://p2.example.com".to_string(),
                group: None,
                disabled: false,
                usage_adapter: String::new(),
                usage_base_url: None,
                api_key: String::new(),
            },
        );
        let cfg = AppConfig {
            listen: ListenConfig {
                host: "127.0.0.1".to_string(),
                port: 4000,
            },
            routing: RoutingConfig {
                preferred_provider: "p1".to_string(),
                session_preferred_providers: std::collections::BTreeMap::new(),
                route_mode: crate::orchestrator::config::RouteMode::BalancedAuto,
                auto_return_to_preferred: true,
                preferred_stable_seconds: 30,
                failure_threshold: 2,
                cooldown_seconds: 30,
                request_timeout_seconds: 300,
            },
            providers,
            provider_order: vec!["p1".to_string(), "p2".to_string()],
        };
        let now = unix_ms();
        let state = GatewayState {
            cfg: Arc::new(RwLock::new(cfg.clone())),
            router: Arc::new(RouterState::new(&cfg, now)),
            store,
            upstream: UpstreamClient::new(),
            secrets,
            last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
            last_used_by_session: Arc::new(RwLock::new(HashMap::new())),
            usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
            prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
            client_sessions: Arc::new(RwLock::new(HashMap::from([(
                "main-session".to_string(),
                ClientSessionRuntime {
                    codex_session_id: "main-session".to_string(),
                    pid: 1,
                    wt_session: Some("wt-main".to_string()),
                    last_request_unix_ms: now,
                    last_discovered_unix_ms: now,
                    last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
                    last_reported_model: None,
                    last_reported_base_url: Some("http://127.0.0.1:4000/v1".to_string()),
                    agent_parent_session_id: None,
                    is_agent: false,
                    is_review: false,
                    confirmed_router: true,
                },
            )]))),
        };

        let stale_ms = now.saturating_sub(24 * 60 * 60 * 1000);
        state
            .store
            .put_session_route_assignment("stale-session", "p2", stale_ms);

        let (provider, reason) = displayed_session_route(
            &state,
            &cfg,
            "main-session",
            "p1",
            true,
            None::<&LastUsedRoute>,
        );
        assert_eq!(provider.as_deref(), Some("p1"));
        assert_eq!(reason.as_deref(), Some("balanced_auto"));
        assert!(
            state
                .store
                .get_session_route_assignment("main-session")
                .is_some(),
            "status display should pre-seed balanced assignments before first routed request"
        );
        let stale_assignment = state.store.get_session_route_assignment("stale-session");
        if let Some(stale_assignment) = stale_assignment {
            assert_eq!(stale_assignment.provider, "p2");
        }
    }

    #[test]
    fn displayed_session_route_keeps_provider_when_other_session_becomes_active() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = open_store_dir(tmp.path().join("data")).expect("store");
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        let mut providers = std::collections::BTreeMap::new();
        providers.insert(
            "p1".to_string(),
            ProviderConfig {
                display_name: "P1".to_string(),
                base_url: "https://p1.example.com".to_string(),
                group: None,
                disabled: false,
                usage_adapter: String::new(),
                usage_base_url: None,
                api_key: String::new(),
            },
        );
        providers.insert(
            "p2".to_string(),
            ProviderConfig {
                display_name: "P2".to_string(),
                base_url: "https://p2.example.com".to_string(),
                group: None,
                disabled: false,
                usage_adapter: String::new(),
                usage_base_url: None,
                api_key: String::new(),
            },
        );
        let cfg = AppConfig {
            listen: ListenConfig {
                host: "127.0.0.1".to_string(),
                port: 4000,
            },
            routing: RoutingConfig {
                preferred_provider: "p1".to_string(),
                session_preferred_providers: std::collections::BTreeMap::new(),
                route_mode: crate::orchestrator::config::RouteMode::BalancedAuto,
                auto_return_to_preferred: true,
                preferred_stable_seconds: 30,
                failure_threshold: 2,
                cooldown_seconds: 30,
                request_timeout_seconds: 300,
            },
            providers,
            provider_order: vec!["p1".to_string(), "p2".to_string()],
        };
        let now = unix_ms();
        let state = GatewayState {
            cfg: Arc::new(RwLock::new(cfg.clone())),
            router: Arc::new(RouterState::new(&cfg, now)),
            store,
            upstream: UpstreamClient::new(),
            secrets,
            last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
            last_used_by_session: Arc::new(RwLock::new(HashMap::new())),
            usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
            prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
            client_sessions: Arc::new(RwLock::new(HashMap::from([
                (
                    "session-a".to_string(),
                    ClientSessionRuntime {
                        codex_session_id: "session-a".to_string(),
                        pid: 1,
                        wt_session: Some("wt-a".to_string()),
                        last_request_unix_ms: now,
                        last_discovered_unix_ms: now,
                        last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
                        last_reported_model: None,
                        last_reported_base_url: Some("http://127.0.0.1:4000/v1".to_string()),
                        agent_parent_session_id: None,
                        is_agent: false,
                        is_review: false,
                        confirmed_router: true,
                    },
                ),
                (
                    "session-b".to_string(),
                    ClientSessionRuntime {
                        codex_session_id: "session-b".to_string(),
                        pid: 2,
                        wt_session: Some("wt-b".to_string()),
                        last_request_unix_ms: now,
                        last_discovered_unix_ms: now,
                        last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
                        last_reported_model: None,
                        last_reported_base_url: Some("http://127.0.0.1:4000/v1".to_string()),
                        agent_parent_session_id: None,
                        is_agent: false,
                        is_review: false,
                        confirmed_router: true,
                    },
                ),
            ]))),
        };

        let (before_provider, before_reason) = displayed_session_route(
            &state,
            &cfg,
            "session-b",
            "p1",
            true,
            None::<&LastUsedRoute>,
        );
        assert!(before_provider.is_some());

        let (_picked, _reason) = decide_provider(&state, &cfg, "p1", "session-a");

        let (after_provider, after_reason) = displayed_session_route(
            &state,
            &cfg,
            "session-b",
            "p1",
            true,
            None::<&LastUsedRoute>,
        );

        assert_eq!(before_provider, after_provider);
        assert_eq!(before_reason, after_reason);
    }

    #[test]
    fn clear_removed_main_session_routes_and_assignments_keeps_agent_entries() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = open_store_dir(tmp.path().join("data")).expect("store");
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        let mut providers = std::collections::BTreeMap::new();
        providers.insert(
            "p1".to_string(),
            ProviderConfig {
                display_name: "P1".to_string(),
                base_url: "https://p1.example.com".to_string(),
                group: None,
                disabled: false,
                usage_adapter: String::new(),
                usage_base_url: None,
                api_key: String::new(),
            },
        );
        let cfg = AppConfig {
            listen: ListenConfig {
                host: "127.0.0.1".to_string(),
                port: 4000,
            },
            routing: RoutingConfig {
                preferred_provider: "p1".to_string(),
                session_preferred_providers: std::collections::BTreeMap::new(),
                route_mode: crate::orchestrator::config::RouteMode::BalancedAuto,
                auto_return_to_preferred: true,
                preferred_stable_seconds: 30,
                failure_threshold: 2,
                cooldown_seconds: 30,
                request_timeout_seconds: 300,
            },
            providers,
            provider_order: vec!["p1".to_string()],
        };
        let now = unix_ms();
        let state = GatewayState {
            cfg: Arc::new(RwLock::new(cfg.clone())),
            router: Arc::new(RouterState::new(&cfg, now)),
            store,
            upstream: UpstreamClient::new(),
            secrets,
            last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
            last_used_by_session: Arc::new(RwLock::new(HashMap::from([
                (
                    "main-session".to_string(),
                    LastUsedRoute {
                        provider: "p1".to_string(),
                        reason: "balanced_auto".to_string(),
                        preferred: "p1".to_string(),
                        unix_ms: now,
                    },
                ),
                (
                    "agent-session".to_string(),
                    LastUsedRoute {
                        provider: "p1".to_string(),
                        reason: "balanced_auto".to_string(),
                        preferred: "p1".to_string(),
                        unix_ms: now,
                    },
                ),
            ]))),
            usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
            prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
            client_sessions: Arc::new(RwLock::new(HashMap::new())),
        };
        state
            .store
            .put_session_route_assignment("main-session", "p1", now);
        state
            .store
            .put_session_route_assignment("agent-session", "p1", now);

        clear_removed_main_session_routes_and_assignments(
            &state,
            &["main-session".to_string()],
        );

        let routes = state.last_used_by_session.read();
        assert!(!routes.contains_key("main-session"));
        assert!(routes.contains_key("agent-session"));
        assert!(
            state
                .store
                .get_session_route_assignment("main-session")
                .is_none()
        );
        assert!(
            state
                .store
                .get_session_route_assignment("agent-session")
                .is_some()
        );
    }

    #[test]
    fn main_session_ids_excluding_agents_and_reviews_only_tracks_main_sessions() {
        let sessions = std::collections::HashMap::from([
            (
                "main-1".to_string(),
                ClientSessionRuntime {
                    codex_session_id: "main-1".to_string(),
                    pid: 1,
                    wt_session: None,
                    last_request_unix_ms: 0,
                    last_discovered_unix_ms: 0,
                    last_reported_model_provider: None,
                    last_reported_model: None,
                    last_reported_base_url: None,
                    agent_parent_session_id: None,
                    is_agent: false,
                    is_review: false,
                    confirmed_router: true,
                },
            ),
            (
                "agent-1".to_string(),
                ClientSessionRuntime {
                    codex_session_id: "agent-1".to_string(),
                    pid: 2,
                    wt_session: None,
                    last_request_unix_ms: 0,
                    last_discovered_unix_ms: 0,
                    last_reported_model_provider: None,
                    last_reported_model: None,
                    last_reported_base_url: None,
                    agent_parent_session_id: Some("main-1".to_string()),
                    is_agent: true,
                    is_review: false,
                    confirmed_router: true,
                },
            ),
            (
                "review-1".to_string(),
                ClientSessionRuntime {
                    codex_session_id: "review-1".to_string(),
                    pid: 3,
                    wt_session: None,
                    last_request_unix_ms: 0,
                    last_discovered_unix_ms: 0,
                    last_reported_model_provider: None,
                    last_reported_model: None,
                    last_reported_base_url: None,
                    agent_parent_session_id: Some("main-1".to_string()),
                    is_agent: true,
                    is_review: true,
                    confirmed_router: true,
                },
            ),
        ]);

        let ids = main_session_ids_excluding_agents_and_reviews(&sessions);
        assert_eq!(
            ids,
            std::collections::BTreeSet::from(["main-1".to_string()])
        );
    }

    #[test]
    fn rebalance_balanced_assignments_only_when_main_session_set_changes() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = open_store_dir(tmp.path().join("data")).expect("store");
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        let cfg = AppConfig {
            listen: ListenConfig {
                host: "127.0.0.1".to_string(),
                port: 4000,
            },
            routing: RoutingConfig {
                preferred_provider: "p1".to_string(),
                session_preferred_providers: std::collections::BTreeMap::new(),
                route_mode: crate::orchestrator::config::RouteMode::BalancedAuto,
                auto_return_to_preferred: true,
                preferred_stable_seconds: 30,
                failure_threshold: 2,
                cooldown_seconds: 30,
                request_timeout_seconds: 300,
            },
            providers: std::collections::BTreeMap::from([(
                "p1".to_string(),
                ProviderConfig {
                    display_name: "P1".to_string(),
                    base_url: "https://p1.example.com".to_string(),
                    group: None,
                    disabled: false,
                    usage_adapter: String::new(),
                    usage_base_url: None,
                    api_key: String::new(),
                },
            )]),
            provider_order: vec!["p1".to_string()],
        };
        let now = unix_ms();
        let mk = |sid: &str, is_agent: bool, is_review: bool| ClientSessionRuntime {
            codex_session_id: sid.to_string(),
            pid: 1,
            wt_session: Some(format!("wt-{sid}")),
            last_request_unix_ms: now,
            last_discovered_unix_ms: now,
            last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
            last_reported_model: None,
            last_reported_base_url: Some("http://127.0.0.1:4000/v1".to_string()),
            agent_parent_session_id: is_agent.then_some("main-a".to_string()),
            is_agent,
            is_review,
            confirmed_router: true,
        };
        let state = GatewayState {
            cfg: Arc::new(RwLock::new(cfg.clone())),
            router: Arc::new(RouterState::new(&cfg, now)),
            store,
            upstream: UpstreamClient::new(),
            secrets,
            last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
            last_used_by_session: Arc::new(RwLock::new(HashMap::from([
                (
                    "main-a".to_string(),
                    LastUsedRoute {
                        provider: "p1".to_string(),
                        reason: "balanced_auto".to_string(),
                        preferred: "p1".to_string(),
                        unix_ms: now,
                    },
                ),
                (
                    "agent-a".to_string(),
                    LastUsedRoute {
                        provider: "p1".to_string(),
                        reason: "balanced_auto".to_string(),
                        preferred: "p1".to_string(),
                        unix_ms: now,
                    },
                ),
            ]))),
            usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
            prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
            client_sessions: Arc::new(RwLock::new(HashMap::from([
                ("main-a".to_string(), mk("main-a", false, false)),
                ("agent-a".to_string(), mk("agent-a", true, false)),
            ]))),
        };
        state
            .store
            .put_session_route_assignment("main-a", "p1", now.saturating_sub(1_000));

        let first = state.client_sessions.read().clone();
        rebalance_balanced_assignments_on_main_session_change(&state, &cfg, &first);
        assert!(
            state
                .store
                .get_session_route_assignment("main-a")
                .is_some(),
            "first snapshot should only prime topology state"
        );

        {
            let mut sessions = state.client_sessions.write();
            sessions.remove("agent-a");
            sessions.insert("agent-b".to_string(), mk("agent-b", true, false));
        }
        let agent_only_change = state.client_sessions.read().clone();
        rebalance_balanced_assignments_on_main_session_change(&state, &cfg, &agent_only_change);
        assert!(
            state
                .store
                .get_session_route_assignment("main-a")
                .is_some(),
            "agent/review changes must not trigger balanced reassignment"
        );

        {
            let mut sessions = state.client_sessions.write();
            sessions.insert("main-b".to_string(), mk("main-b", false, false));
        }
        let main_change = state.client_sessions.read().clone();
        rebalance_balanced_assignments_on_main_session_change(&state, &cfg, &main_change);
        assert!(
            state.store.list_session_route_assignments_since(0).is_empty(),
            "main session topology change should clear assignments for immediate rebalance"
        );
        let routes = state.last_used_by_session.read();
        assert!(
            !routes.contains_key("main-a"),
            "main-session observed route should be cleared on topology change"
        );
    }

    #[test]
    fn displayed_session_route_reuses_observed_route_for_verified_session() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = open_store_dir(tmp.path().join("data")).expect("store");
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        let mut providers = std::collections::BTreeMap::new();
        providers.insert(
            "p1".to_string(),
            ProviderConfig {
                display_name: "P1".to_string(),
                base_url: "https://p1.example.com".to_string(),
                group: None,
                disabled: false,
                usage_adapter: String::new(),
                usage_base_url: None,
                api_key: String::new(),
            },
        );
        providers.insert(
            "p2".to_string(),
            ProviderConfig {
                display_name: "P2".to_string(),
                base_url: "https://p2.example.com".to_string(),
                group: None,
                disabled: false,
                usage_adapter: String::new(),
                usage_base_url: None,
                api_key: String::new(),
            },
        );
        let cfg = AppConfig {
            listen: ListenConfig {
                host: "127.0.0.1".to_string(),
                port: 4000,
            },
            routing: RoutingConfig {
                preferred_provider: "p1".to_string(),
                session_preferred_providers: std::collections::BTreeMap::new(),
                route_mode: crate::orchestrator::config::RouteMode::BalancedAuto,
                auto_return_to_preferred: true,
                preferred_stable_seconds: 30,
                failure_threshold: 2,
                cooldown_seconds: 30,
                request_timeout_seconds: 300,
            },
            providers,
            provider_order: vec!["p1".to_string(), "p2".to_string()],
        };
        let now = unix_ms();
        let state = GatewayState {
            cfg: Arc::new(RwLock::new(cfg.clone())),
            router: Arc::new(RouterState::new(&cfg, now)),
            store,
            upstream: UpstreamClient::new(),
            secrets,
            last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
            last_used_by_session: Arc::new(RwLock::new(HashMap::new())),
            usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
            prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
            client_sessions: Arc::new(RwLock::new(HashMap::new())),
        };

        state.router.require_usage_confirmation("p1");
        state
            .store
            .put_quota_snapshot(
                "p1",
                &serde_json::json!({
                    "remaining": 100.0,
                    "updated_at_unix_ms": now
                }),
            )
            .expect("quota p1");

        let observed = LastUsedRoute {
            provider: "p2".to_string(),
            reason: "preferred_unhealthy".to_string(),
            preferred: "p1".to_string(),
            unix_ms: now,
        };
        let (provider, reason) = displayed_session_route(
            &state,
            &cfg,
            "main-session",
            "p1",
            true,
            Some(&observed),
        );
        assert_eq!(provider.as_deref(), Some("p2"));
        assert_eq!(reason.as_deref(), Some("preferred_unhealthy"));
        assert!(
            state.router.is_waiting_usage_confirmation("p1"),
            "using observed route should not trigger display routing side effects"
        );
    }

    #[test]
    fn verified_review_backfills_main_session_confirmation() {
        let mut map = std::collections::HashMap::new();
        map.insert(
            "main".to_string(),
            ClientSessionRuntime {
                codex_session_id: "main".to_string(),
                pid: 9527,
                wt_session: Some("wt-1".to_string()),
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 1,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: false,
            },
        );
        map.insert(
            "review".to_string(),
            ClientSessionRuntime {
                codex_session_id: "review".to_string(),
                pid: 9527,
                wt_session: Some("wt-1".to_string()),
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 1,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: true,
                is_review: true,
                confirmed_router: true,
            },
        );

        backfill_main_confirmation_from_verified_agent(&mut map, 1);

        let main = map.get("main").expect("main row");
        assert!(main.confirmed_router);
        assert_eq!(
            main.last_reported_model_provider.as_deref(),
            Some(GATEWAY_MODEL_PROVIDER_ID)
        );
    }

    #[test]
    fn backfill_can_confirm_old_main_session_when_review_verified() {
        let mut map = std::collections::HashMap::new();
        map.insert(
            "main_old".to_string(),
            ClientSessionRuntime {
                codex_session_id: "main_old".to_string(),
                pid: 9527,
                wt_session: Some("wt-1".to_string()),
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 1,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: false,
            },
        );
        map.insert(
            "review_now".to_string(),
            ClientSessionRuntime {
                codex_session_id: "review_now".to_string(),
                pid: 9527,
                wt_session: Some("wt-1".to_string()),
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 2,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: true,
                is_review: true,
                confirmed_router: true,
            },
        );

        backfill_main_confirmation_from_verified_agent(&mut map, 2);

        let main = map.get("main_old").expect("main_old row");
        assert!(main.confirmed_router);
        assert_eq!(
            main.last_reported_model_provider.as_deref(),
            Some(GATEWAY_MODEL_PROVIDER_ID)
        );
    }

    #[test]
    fn verified_review_recent_request_backfills_main_without_discovery_now() {
        let mut map = std::collections::HashMap::new();
        map.insert(
            "main_now".to_string(),
            ClientSessionRuntime {
                codex_session_id: "main_now".to_string(),
                pid: 9527,
                wt_session: Some("wt-1".to_string()),
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 2_000,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: false,
            },
        );
        map.insert(
            "review_active".to_string(),
            ClientSessionRuntime {
                codex_session_id: "review_active".to_string(),
                pid: 9527,
                wt_session: Some("wt-1".to_string()),
                last_request_unix_ms: 1_995,
                last_discovered_unix_ms: 1,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: true,
                is_review: true,
                confirmed_router: true,
            },
        );

        backfill_main_confirmation_from_verified_agent(&mut map, 2_000);

        let main = map.get("main_now").expect("main_now row");
        assert!(main.confirmed_router);
        assert_eq!(
            main.last_reported_model_provider.as_deref(),
            Some(GATEWAY_MODEL_PROVIDER_ID)
        );
    }

    #[test]
    fn verified_agent_backfills_main_by_same_wt_without_review_flag() {
        let mut map = std::collections::HashMap::new();
        map.insert(
            "main_agent_wt".to_string(),
            ClientSessionRuntime {
                codex_session_id: "main_agent_wt".to_string(),
                pid: 0,
                wt_session: Some("wsl:abc-123".to_string()),
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 2_000,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: false,
            },
        );
        map.insert(
            "agent_tool".to_string(),
            ClientSessionRuntime {
                codex_session_id: "agent_tool".to_string(),
                pid: 0,
                wt_session: Some("abc-123".to_string()),
                last_request_unix_ms: 1_995,
                last_discovered_unix_ms: 1,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: true,
                is_review: false,
                confirmed_router: true,
            },
        );

        backfill_main_confirmation_from_verified_agent(&mut map, 2_000);

        let main = map.get("main_agent_wt").expect("main_agent_wt row");
        assert!(main.confirmed_router);
        assert_eq!(
            main.last_reported_model_provider.as_deref(),
            Some(GATEWAY_MODEL_PROVIDER_ID)
        );
    }

    #[test]
    fn verified_agent_backfills_main_by_parent_sid_without_wt_or_pid_match() {
        let mut map = std::collections::HashMap::new();
        map.insert(
            "main_from_parent".to_string(),
            ClientSessionRuntime {
                codex_session_id: "main_from_parent".to_string(),
                pid: 0,
                wt_session: None,
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 2_000,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: false,
            },
        );
        map.insert(
            "agent_with_parent".to_string(),
            ClientSessionRuntime {
                codex_session_id: "agent_with_parent".to_string(),
                pid: 0,
                wt_session: None,
                last_request_unix_ms: 1_995,
                last_discovered_unix_ms: 1,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: Some("main_from_parent".to_string()),
                is_agent: true,
                is_review: false,
                confirmed_router: true,
            },
        );

        backfill_main_confirmation_from_verified_agent(&mut map, 2_000);

        let main = map.get("main_from_parent").expect("main_from_parent row");
        assert!(main.confirmed_router);
        assert_eq!(
            main.last_reported_model_provider.as_deref(),
            Some(GATEWAY_MODEL_PROVIDER_ID)
        );
    }

    #[test]
    fn verified_main_backfills_agent_by_parent_sid_without_independent_confirmation() {
        let mut map = std::collections::HashMap::new();
        map.insert(
            "main-confirmed".to_string(),
            ClientSessionRuntime {
                codex_session_id: "main-confirmed".to_string(),
                pid: 0,
                wt_session: None,
                last_request_unix_ms: 2_000,
                last_discovered_unix_ms: 2_000,
                last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: true,
            },
        );
        map.insert(
            "agent-unverified".to_string(),
            ClientSessionRuntime {
                codex_session_id: "agent-unverified".to_string(),
                pid: 0,
                wt_session: None,
                last_request_unix_ms: 1_995,
                last_discovered_unix_ms: 1_995,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: Some("main-confirmed".to_string()),
                is_agent: true,
                is_review: false,
                confirmed_router: false,
            },
        );

        backfill_main_confirmation_from_verified_agent(&mut map, 2_000);

        let agent = map.get("agent-unverified").expect("agent row");
        assert!(agent.confirmed_router);
        assert_eq!(
            agent.last_reported_model_provider.as_deref(),
            Some(GATEWAY_MODEL_PROVIDER_ID)
        );
    }

    #[test]
    fn verified_agent_synthesizes_missing_main_from_parent_sid() {
        let mut map = std::collections::HashMap::new();
        map.insert(
            "agent-only".to_string(),
            ClientSessionRuntime {
                codex_session_id: "agent-only".to_string(),
                pid: 4242,
                wt_session: Some("wsl:tab-1".to_string()),
                last_request_unix_ms: 2_000,
                last_discovered_unix_ms: 1_999,
                last_reported_model_provider: None,
                last_reported_model: Some("gpt-5.4".to_string()),
                last_reported_base_url: Some("http://172.26.144.1:4000/v1".to_string()),
                agent_parent_session_id: Some("main-synth".to_string()),
                is_agent: true,
                is_review: false,
                confirmed_router: true,
            },
        );

        backfill_main_confirmation_from_verified_agent(&mut map, 2_000);

        let main = map.get("main-synth").expect("synthesized main row");
        assert!(!main.is_agent);
        assert!(!main.is_review);
        assert!(main.confirmed_router);
        assert_eq!(main.pid, 4242);
        assert_eq!(main.wt_session.as_deref(), Some("wsl:tab-1"));
        assert_eq!(
            main.last_reported_model_provider.as_deref(),
            Some(GATEWAY_MODEL_PROVIDER_ID)
        );
    }

    #[test]
    fn missing_agent_parent_is_backfilled_from_same_runtime_session() {
        let mut map = std::collections::HashMap::new();
        map.insert(
            "main-live".to_string(),
            ClientSessionRuntime {
                codex_session_id: "main-live".to_string(),
                pid: 0,
                wt_session: Some("wsl:tab-parent".to_string()),
                last_request_unix_ms: 10,
                last_discovered_unix_ms: 20,
                last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: true,
            },
        );
        map.insert(
            "agent-live".to_string(),
            ClientSessionRuntime {
                codex_session_id: "agent-live".to_string(),
                pid: 0,
                wt_session: Some("tab-parent".to_string()),
                last_request_unix_ms: 30,
                last_discovered_unix_ms: 30,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: true,
                is_review: false,
                confirmed_router: true,
            },
        );

        backfill_main_confirmation_from_verified_agent(&mut map, 30);

        let agent = map.get("agent-live").expect("agent row");
        assert_eq!(agent.agent_parent_session_id.as_deref(), Some("main-live"));
    }

    #[test]
    fn discovered_live_agent_parent_session_ids_collects_non_empty_parent_ids() {
        let discovered = vec![
            crate::platform::windows_terminal::InferredWtSession {
                wt_session: "wsl:tab-1".to_string(),
                pid: 0,
                linux_pid: Some(99),
                wsl_distro: Some("Ubuntu".to_string()),
                cwd: Some("/home/yiyou/project".to_string()),
                rollout_path: None,
                codex_session_id: Some("agent-1".to_string()),
                reported_model_provider: None,
                reported_base_url: None,
                agent_parent_session_id: Some("main-1".to_string()),
                is_agent: true,
                is_review: false,
                router_confirmed: true,
            },
            crate::platform::windows_terminal::InferredWtSession {
                wt_session: "tab-2".to_string(),
                pid: 11,
                linux_pid: None,
                wsl_distro: None,
                cwd: Some("C:\\repo".to_string()),
                rollout_path: None,
                codex_session_id: Some("main-2".to_string()),
                reported_model_provider: None,
                reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                router_confirmed: true,
            },
        ];

        let ids = super::discovered_live_agent_parent_session_ids(&discovered);
        assert_eq!(
            ids,
            std::collections::HashSet::from(["main-1".to_string()])
        );
    }

    #[test]
    fn recent_client_sessions_keeps_main_parent_context_for_top_agent_rows() {
        let mut map = std::collections::HashMap::new();
        map.insert(
            "main-parent".to_string(),
            ClientSessionRuntime {
                codex_session_id: "main-parent".to_string(),
                pid: 0,
                wt_session: Some("wt-main".to_string()),
                last_request_unix_ms: 10,
                last_discovered_unix_ms: 10,
                last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: true,
            },
        );
        map.insert(
            "agent-top".to_string(),
            ClientSessionRuntime {
                codex_session_id: "agent-top".to_string(),
                pid: 0,
                wt_session: Some("wt-agent".to_string()),
                last_request_unix_ms: 500,
                last_discovered_unix_ms: 500,
                last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: Some("main-parent".to_string()),
                is_agent: true,
                is_review: false,
                confirmed_router: true,
            },
        );
        for index in 0..20 {
            let sid = format!("other-{index:02}");
            map.insert(
                sid.clone(),
                ClientSessionRuntime {
                    codex_session_id: sid,
                    pid: 0,
                    wt_session: None,
                    last_request_unix_ms: 400_u64.saturating_sub(index as u64),
                    last_discovered_unix_ms: 400_u64.saturating_sub(index as u64),
                    last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
                    last_reported_model: None,
                    last_reported_base_url: None,
                    agent_parent_session_id: None,
                    is_agent: false,
                    is_review: false,
                    confirmed_router: true,
                },
            );
        }

        let items = super::recent_client_sessions_with_main_parent_context(&map, 20);
        let ids: std::collections::HashSet<String> =
            items.iter().map(|(sid, _runtime)| sid.clone()).collect();

        assert!(ids.contains("agent-top"));
        assert!(ids.contains("main-parent"));
        assert_eq!(items.len(), 21);
    }

    #[cfg(windows)]
    #[test]
    fn verified_agent_backfills_main_from_tui_parent_lookup_when_runtime_parent_missing() {
        use std::io::Write;

        let tmp = tempfile::tempdir().expect("tmpdir");
        let codex_home = tmp.path().join(".codex");
        let log_dir = codex_home.join("log");
        std::fs::create_dir_all(&log_dir).expect("mkdir");
        let log_path = log_dir.join("codex-tui.log");

        let main_sid = "019c67c0-c95d-7b10-a0a1-fc576b458272";
        let agent_sid = "019c6bc7-1636-7730-ae5a-03f9d3417528";
        let mut f = std::fs::File::create(&log_path).expect("create");
        writeln!(
            f,
            "2026-02-17T13:25:35.418912Z  INFO session_loop{{thread_id={main_sid}}}:session_loop{{thread_id={agent_sid}}}: codex_core::codex: new"
        )
        .unwrap();

        let _codex_home_guard = crate::codex_home_env::CodexHomeEnvGuard::set(&codex_home);

        let mut map = std::collections::HashMap::new();
        map.insert(
            main_sid.to_string(),
            ClientSessionRuntime {
                codex_session_id: main_sid.to_string(),
                pid: 0,
                wt_session: None,
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 2_000,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: false,
            },
        );
        map.insert(
            agent_sid.to_string(),
            ClientSessionRuntime {
                codex_session_id: agent_sid.to_string(),
                pid: 0,
                wt_session: None,
                last_request_unix_ms: 1_995,
                last_discovered_unix_ms: 1,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: true,
                is_review: false,
                confirmed_router: true,
            },
        );

        backfill_main_confirmation_from_verified_agent(&mut map, 2_000);

        let main = map.get(main_sid).expect("main row"); 
        assert!(main.confirmed_router); 
        assert_eq!(
            main.last_reported_model_provider.as_deref(),
            Some(GATEWAY_MODEL_PROVIDER_ID)
        );
    }

    #[test]
    fn verified_review_backfills_main_when_wsl_prefix_differs() {
        let mut map = std::collections::HashMap::new();
        map.insert(
            "main_wsl".to_string(),
            ClientSessionRuntime {
                codex_session_id: "main_wsl".to_string(),
                pid: 0,
                wt_session: Some("wsl:ABC-123".to_string()),
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 2_000,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: false,
            },
        );
        map.insert(
            "review_wsl".to_string(),
            ClientSessionRuntime {
                codex_session_id: "review_wsl".to_string(),
                pid: 0,
                wt_session: Some("abc-123".to_string()),
                last_request_unix_ms: 1_995,
                last_discovered_unix_ms: 1,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: true,
                is_review: true,
                confirmed_router: true,
            },
        );

        backfill_main_confirmation_from_verified_agent(&mut map, 2_000);

        let main = map.get("main_wsl").expect("main_wsl row");
        assert!(main.confirmed_router);
        assert_eq!(
            main.last_reported_model_provider.as_deref(),
            Some(GATEWAY_MODEL_PROVIDER_ID)
        );
    }

    #[test]
    fn verified_review_backfills_main_when_wsl_prefix_differs_reverse() {
        let mut map = std::collections::HashMap::new();
        map.insert(
            "main_wsl_rev".to_string(),
            ClientSessionRuntime {
                codex_session_id: "main_wsl_rev".to_string(),
                pid: 0,
                wt_session: Some("abc-xyz".to_string()),
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 2_000,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: false,
            },
        );
        map.insert(
            "review_wsl_rev".to_string(),
            ClientSessionRuntime {
                codex_session_id: "review_wsl_rev".to_string(),
                pid: 0,
                wt_session: Some("wsl:ABC-XYZ".to_string()),
                last_request_unix_ms: 1_995,
                last_discovered_unix_ms: 1,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: true,
                is_review: true,
                confirmed_router: true,
            },
        );

        backfill_main_confirmation_from_verified_agent(&mut map, 2_000);

        let main = map.get("main_wsl_rev").expect("main_wsl_rev row");
        assert!(main.confirmed_router);
        assert_eq!(
            main.last_reported_model_provider.as_deref(),
            Some(GATEWAY_MODEL_PROVIDER_ID)
        );
    }

    #[test]
    fn projected_usage_ledgers_include_synced_requests_since_last_refresh() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("user-data").join("data");
        let state = crate::app_state::build_state(config_path, data_dir).expect("build state");
        let now = unix_ms();
        state
            .gateway
            .store
            .put_quota_snapshot(
                "packycode",
                &serde_json::json!({
                    "kind": "budget_info",
                    "updated_at_unix_ms": now,
                    "daily_spent_usd": 1.0,
                    "daily_budget_usd": 10.0,
                    "weekly_spent_usd": 2.0,
                    "weekly_budget_usd": 20.0,
                    "monthly_spent_usd": 3.0,
                    "monthly_budget_usd": 30.0,
                    "last_error": "",
                }),
            )
            .expect("quota snapshot");
        let inserted = state
            .gateway
            .store
            .upsert_usage_request_sync_rows(&[UsageRequestSyncRow {
                id: "row-1".to_string(),
                unix_ms: now.saturating_add(1),
                ingested_at_unix_ms: now.saturating_add(1),
                provider: "packycode".to_string(),
                api_key_ref: "-".to_string(),
                model: "gpt-4.1".to_string(),
                origin: "windows".to_string(),
                session_id: "session-1".to_string(),
                node_id: "node-a".to_string(),
                node_name: "DESKTOP-A".to_string(),
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 128,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            }]);
        assert_eq!(inserted, 1);

        let projected = super::projected_usage_ledgers(
            &state.gateway,
            &state.gateway.store.list_quota_snapshots(),
        );
        assert_eq!(
            projected
                .get("packycode")
                .and_then(serde_json::Value::as_object)
                .and_then(|value| value.get("since_last_quota_refresh_requests"))
                .and_then(serde_json::Value::as_u64),
            Some(1)
        );
        assert_eq!(
            projected
                .get("packycode")
                .and_then(serde_json::Value::as_object)
                .and_then(|value| value.get("since_last_quota_refresh_total_tokens"))
                .and_then(serde_json::Value::as_u64),
            Some(128)
        );
    }

    #[test]
    fn config_revision_changes_when_provider_order_changes() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("user-data").join("data");
        let state = crate::app_state::build_state(config_path, data_dir).expect("build state");
        let before_cfg = state.gateway.cfg.read().clone();
        let before_revision = config_revision(&state, &before_cfg);

        {
            let mut cfg = state.gateway.cfg.write();
            cfg.provider_order.reverse();
        }

        let after_cfg = state.gateway.cfg.read().clone();
        let after_revision = config_revision(&state, &after_cfg);
        assert_ne!(before_revision, after_revision);
    }

    #[test]
    fn stale_wsl_session_drops_even_when_wt_session_is_alive() {
        let now = 100_000_u64;
        let entry = ClientSessionRuntime {
            codex_session_id: "wsl-old".to_string(),
            pid: 0,
            wt_session: Some("wsl:test-wt".to_string()),
            last_request_unix_ms: now.saturating_sub(120_000),
            last_discovered_unix_ms: now.saturating_sub(30_000),
            last_reported_model_provider: None,
            last_reported_model: None,
            last_reported_base_url: None,
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, 3, true);
        assert!(!keep);
    }

    #[test]
    fn recent_wsl_discovery_keeps_idle_session_when_wt_alive() {
        let now = 100_000_u64;
        let entry = ClientSessionRuntime {
            codex_session_id: "wsl-recent".to_string(),
            pid: 0,
            wt_session: Some("wsl:test-wt".to_string()),
            last_request_unix_ms: now.saturating_sub(120_000),
            last_discovered_unix_ms: now.saturating_sub(5_000),
            last_reported_model_provider: None,
            last_reported_model: None,
            last_reported_base_url: None,
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, 1, true);
        assert!(keep);
    }

    #[test]
    fn recent_wsl_agent_session_keeps_when_wt_alive() {
        let now = 100_000_u64;
        let entry = ClientSessionRuntime {
            codex_session_id: "wsl-agent".to_string(),
            pid: 0,
            wt_session: Some("wsl:test-wt".to_string()),
            last_request_unix_ms: now.saturating_sub(120_000),
            last_discovered_unix_ms: now.saturating_sub(5_000),
            last_reported_model_provider: None,
            last_reported_model: None,
            last_reported_base_url: None,
            agent_parent_session_id: Some("main-thread".to_string()),
            is_agent: true,
            is_review: false,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, 1, true);
        assert!(keep);
    }

    #[test]
    fn active_wsl_session_keeps_when_discovery_is_stale() {
        let now = 100_000_u64;
        let entry = ClientSessionRuntime {
            codex_session_id: "wsl-active".to_string(),
            pid: 0,
            wt_session: Some("wsl:test-wt".to_string()),
            last_request_unix_ms: now.saturating_sub(5_000),
            last_discovered_unix_ms: now.saturating_sub(45_000),
            last_reported_model_provider: None,
            last_reported_model: None,
            last_reported_base_url: None,
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, 3, false);
        assert!(keep);
    }

    #[test]
    fn active_wsl_session_keeps_when_discovery_is_recent() {
        let now = 100_000_u64;
        let entry = ClientSessionRuntime {
            codex_session_id: "wsl-active-recent".to_string(),
            pid: 0,
            wt_session: Some("wsl:test-wt".to_string()),
            last_request_unix_ms: now.saturating_sub(5_000),
            last_discovered_unix_ms: now.saturating_sub(2_000),
            last_reported_model_provider: None,
            last_reported_model: None,
            last_reported_base_url: None,
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, 0, true);
        assert!(keep);
    }

    #[test]
    fn inactive_review_without_process_identity_drops_even_with_parent_session() {
        let now = 200_000_u64;
        let entry = ClientSessionRuntime {
            codex_session_id: "review-pidless".to_string(),
            pid: 0,
            wt_session: None,
            last_request_unix_ms: now.saturating_sub(120_000),
            last_discovered_unix_ms: now.saturating_sub(120_000),
            last_reported_model_provider: None,
            last_reported_model: None,
            last_reported_base_url: None,
            agent_parent_session_id: Some("main-1".to_string()),
            is_agent: true,
            is_review: true,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, 3, true);
        assert!(!keep);
    }

    #[test]
    fn inactive_review_with_live_process_identity_still_drops() {
        let now = 200_000_u64;
        let entry = ClientSessionRuntime {
            codex_session_id: "review-shared-pid".to_string(),
            pid: 9527,
            wt_session: Some("wt-main".to_string()),
            last_request_unix_ms: now.saturating_sub(120_000),
            last_discovered_unix_ms: now.saturating_sub(5_000),
            last_reported_model_provider: None,
            last_reported_model: None,
            last_reported_base_url: None,
            agent_parent_session_id: Some("main-1".to_string()),
            is_agent: true,
            is_review: true,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, 0, true);
        assert!(!keep);
    }
    #[test]
    fn pidless_wt_session_drops_when_stale_too_long_even_if_wt_alive() {
        let now = 2_000_000_u64;
        let entry = ClientSessionRuntime {
            codex_session_id: "pidless-stale".to_string(),
            pid: 0,
            wt_session: Some("abc-wt".to_string()),
            last_request_unix_ms: now.saturating_sub(20 * 60 * 1000),
            last_discovered_unix_ms: now.saturating_sub(20 * 60 * 1000),
            last_reported_model_provider: None,
            last_reported_model: None,
            last_reported_base_url: None,
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, 0, true);
        assert!(!keep);
    }

    #[test]
    fn pidless_wt_session_keeps_on_stale_discovery_even_if_wt_probe_fails() {
        let now = 2_000_000_u64;
        let entry = ClientSessionRuntime {
            codex_session_id: "pidless-stale-probe".to_string(),
            pid: 0,
            wt_session: Some("abc-wt".to_string()),
            last_request_unix_ms: now.saturating_sub(5_000),
            last_discovered_unix_ms: now.saturating_sub(5_000),
            last_reported_model_provider: None,
            last_reported_model: None,
            last_reported_base_url: None,
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| false, 0, false);
        assert!(keep);
    }

    #[test]
    fn wsl_discovery_miss_count_skips_increment_when_discovery_is_stale() {
        assert_eq!(
            next_wsl_discovery_miss_count(2, false, false),
            2
        );
    }

    #[test]
    fn wsl_discovery_miss_count_increments_when_discovery_is_fresh() {
        assert_eq!(
            next_wsl_discovery_miss_count(2, false, true),
            3
        );
    }

    #[test]
    fn wsl_discovery_miss_count_resets_when_seen_in_discovery() {
        assert_eq!(
            next_wsl_discovery_miss_count(2, true, false),
            0
        );
    }

    #[test]
    fn last_discovered_timestamp_is_not_overwritten_by_stale_discovery() {
        assert_eq!(next_last_discovered_unix_ms(1234, 9999, false), 1234);
        assert_eq!(next_last_discovered_unix_ms(1234, 9999, true), 9999);
    }
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
) -> Option<(f64, Option<u64>, Option<String>)> {
    let cfg = pricing_cfg?;
    let mut matched: Option<(f64, Option<u64>, u64, String)> = None;
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
                .map(|(_, _, started, _)| period.started_at_unix_ms >= *started)
                .unwrap_or(true);
            if replace {
                matched = Some((
                    period.amount_usd,
                    period.ended_at_unix_ms,
                    period.started_at_unix_ms,
                    period.api_key_ref.clone(),
                ));
            }
        }
    }
    if let Some((amount, expires, _, api_key_ref)) = matched {
        let key = api_key_ref.trim();
        return Some((
            amount,
            expires,
            if key.is_empty() || key == "-" {
                None
            } else {
                Some(key.to_string())
            },
        ));
    }
    if cfg.mode == "package_total" && cfg.amount_usd.is_finite() && cfg.amount_usd > 0.0 {
        return Some((cfg.amount_usd, None, None));
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
