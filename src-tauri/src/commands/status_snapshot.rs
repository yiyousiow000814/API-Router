use sha2::Digest;
use std::sync::{Arc, Mutex, OnceLock};

use crate::commands::status_snapshot_support::dashboard_snapshot_cache::DashboardSnapshotCache;

const DASHBOARD_STATUS_SNAPSHOT_CACHE_TTL_MS: u64 = 5_000;
const DASHBOARD_LAST_ERROR_EVENT_MATCH_WINDOW_MS: u64 = 5 * 60 * 1000;

fn status_client_sessions_trace_cache() -> &'static Mutex<Option<String>> {
    static CACHE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

#[derive(Clone)]
struct VisibleLastErrorEventsCache {
    config_path: String,
    captured_at_unix_ms: u64,
    events: Vec<serde_json::Value>,
}

const DASHBOARD_VISIBLE_LAST_ERROR_CACHE_TTL_MS: u64 = 5_000;

fn visible_last_error_events_cache() -> &'static Mutex<Option<VisibleLastErrorEventsCache>> {
    static CACHE: OnceLock<Mutex<Option<VisibleLastErrorEventsCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

#[cfg(test)]
fn clear_visible_last_error_events_cache() {
    let cache = visible_last_error_events_cache();
    let mut guard = match cache.lock() {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    };
    *guard = None;
}

fn summarize_client_sessions_for_trace(sessions: &[serde_json::Value]) -> serde_json::Value {
    serde_json::json!({
        "count": sessions.len(),
        "sessions": sessions.iter().take(40).map(|session| serde_json::json!({
            "id": session.get("id").and_then(serde_json::Value::as_str),
            "parent": session.get("agent_parent_session_id").and_then(serde_json::Value::as_str),
            "active": session.get("active").and_then(serde_json::Value::as_bool),
            "verified": session.get("verified").and_then(serde_json::Value::as_bool),
            "is_agent": session.get("is_agent").and_then(serde_json::Value::as_bool),
            "is_review": session.get("is_review").and_then(serde_json::Value::as_bool),
            "current_provider": session.get("current_provider").and_then(serde_json::Value::as_str),
            "reported_model_provider": session.get("reported_model_provider").and_then(serde_json::Value::as_str),
            "last_seen_unix_ms": session.get("last_seen_unix_ms").and_then(serde_json::Value::as_u64),
        })).collect::<Vec<_>>()
    })
}

fn trace_client_sessions_snapshot(sessions: &[serde_json::Value]) {
    let summary = summarize_client_sessions_for_trace(sessions);
    let Ok(summary_text) = serde_json::to_string(&summary) else {
        return;
    };
    let cache = status_client_sessions_trace_cache();
    let mut guard = match cache.lock() {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    };
    if guard.as_deref() == Some(summary_text.as_str()) {
        return;
    }
    *guard = Some(summary_text);
    let _ = crate::orchestrator::gateway::web_codex_storage::append_codex_live_trace_entry(
        &serde_json::json!({
            "source": "status.client_sessions",
            "entry": {
                "at": unix_ms(),
                "kind": "status.client_sessions.snapshot",
                "summary": summary,
            }
        }),
    );
}

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

#[cfg(test)]
async fn run_blocking_snapshot<T, F>(snapshot_fn: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(snapshot_fn)
        .await
        .map_err(|err| format!("blocking_snapshot_failed: {err}"))
}

fn dashboard_lan_sync_snapshot_cache(
) -> &'static Arc<DashboardSnapshotCache<crate::lan_sync::LanSyncStatusSnapshot>> {
    static CACHE: OnceLock<Arc<DashboardSnapshotCache<crate::lan_sync::LanSyncStatusSnapshot>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Arc::new(DashboardSnapshotCache::new()))
}

fn dashboard_tailscale_snapshot_cache(
) -> &'static Arc<DashboardSnapshotCache<crate::tailscale_diagnostics::TailscaleDiagnosticSnapshot>>
{
    static CACHE: OnceLock<
        Arc<DashboardSnapshotCache<crate::tailscale_diagnostics::TailscaleDiagnosticSnapshot>>,
    > = OnceLock::new();
    CACHE.get_or_init(|| Arc::new(DashboardSnapshotCache::new()))
}

#[cfg(test)]
fn fallback_tailscale_snapshot(
    status_error: Option<String>,
) -> crate::tailscale_diagnostics::TailscaleDiagnosticSnapshot {
    crate::tailscale_diagnostics::TailscaleDiagnosticSnapshot {
        installed: false,
        connected: false,
        backend_state: None,
        dns_name: None,
        ipv4: Vec::new(),
        reachable_ipv4: Vec::new(),
        gateway_reachable: false,
        needs_gateway_restart: false,
        status_error,
        command_path: String::new(),
        command_source: String::new(),
        probe: crate::tailscale_diagnostics::TailscaleProbeReport {
            attempts: Vec::new(),
            selected_command_path: None,
            selected_command_source: None,
        },
        bootstrap: None,
    }
}

fn current_dashboard_tailscale_snapshot(
    listen_port: u16,
) -> crate::tailscale_diagnostics::TailscaleDiagnosticSnapshot {
    let cache = dashboard_tailscale_snapshot_cache();
    if let Some(snapshot) = cache.snapshot_if_fresh(DASHBOARD_STATUS_SNAPSHOT_CACHE_TTL_MS) {
        return snapshot;
    }
    let compute = Arc::new(move || {
        crate::tailscale_diagnostics::current_tailscale_diagnostic_snapshot(listen_port)
    });
    cache.read_or_refresh(DASHBOARD_STATUS_SNAPSHOT_CACHE_TTL_MS, compute)
}

#[cfg(windows)]
fn should_refresh_runtime_wsl_listener(listen_host: &str, wsl_gateway_host: &str) -> bool {
    listen_host == crate::constants::GATEWAY_WINDOWS_HOST
        && !wsl_gateway_host.trim().is_empty()
        && !wsl_gateway_host.eq_ignore_ascii_case(crate::constants::GATEWAY_WINDOWS_HOST)
}

#[cfg(windows)]
fn maybe_refresh_runtime_wsl_listener(
    state: &crate::app_state::AppState,
    wsl_gateway_host: &str,
) -> usize {
    let listen = state.gateway.cfg.read().listen.clone();
    if !should_refresh_runtime_wsl_listener(&listen.host, wsl_gateway_host) {
        return 0;
    }
    let Ok(Some(addr)) = crate::orchestrator::gateway_bootstrap::wsl_overlay_listener_addr(
        &listen.host,
        listen.port,
        wsl_gateway_host,
    ) else {
        return 0;
    };
    crate::orchestrator::gateway::ensure_runtime_gateway_listener_bindings(
        state.gateway.clone(),
        &[addr],
    )
    .map(|newly_bound| newly_bound.len())
    .unwrap_or(0)
}

fn current_dashboard_lan_sync_snapshot(
    listen_port: u16,
    cfg: &crate::orchestrator::config::AppConfig,
    secrets: &crate::orchestrator::secrets::SecretStore,
    lan_sync: &crate::lan_sync::LanSyncRuntime,
) -> crate::lan_sync::LanSyncStatusSnapshot {
    let cache = dashboard_lan_sync_snapshot_cache();
    if let Some(snapshot) = cache.snapshot_if_fresh(DASHBOARD_STATUS_SNAPSHOT_CACHE_TTL_MS) {
        return snapshot;
    }
    let cfg = cfg.clone();
    let secrets = secrets.clone();
    let lan_sync = lan_sync.clone();
    let compute = Arc::new(move || lan_sync.snapshot(listen_port, &cfg, &secrets));
    cache.read_or_refresh(DASHBOARD_STATUS_SNAPSHOT_CACHE_TTL_MS, compute)
}

pub(crate) fn spawn_dashboard_snapshot_warmup(
    listen_port: u16,
    lan_sync: crate::lan_sync::LanSyncRuntime,
    cfg: crate::orchestrator::config::AppConfig,
    secrets: crate::orchestrator::secrets::SecretStore,
) {
    let lan_sync_cache = Arc::clone(dashboard_lan_sync_snapshot_cache());
    let tailscale_cache = Arc::clone(dashboard_tailscale_snapshot_cache());
    tauri::async_runtime::spawn(async move {
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let compute = Arc::new(move || lan_sync.snapshot(listen_port, &cfg, &secrets));
            lan_sync_cache.refresh_now(compute)
        })
        .await;
    });
    tauri::async_runtime::spawn(async move {
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let compute = Arc::new(move || {
                crate::tailscale_diagnostics::current_tailscale_diagnostic_snapshot(listen_port)
            });
            tailscale_cache.refresh_now(compute)
        })
        .await;
    });
}

fn load_visible_last_error_events_with_cache(
    store: &crate::orchestrator::store::Store,
    config_path: &std::path::Path,
    dashboard_detail: bool,
) -> Vec<serde_json::Value> {
    let config_key = config_path.to_string_lossy().into_owned();
    let now = unix_ms();
    let cache = visible_last_error_events_cache();
    if dashboard_detail {
        let guard = match cache.lock() {
            Ok(guard) => guard,
            Err(err) => err.into_inner(),
        };
        if let Some(entry) = guard.as_ref() {
            let is_same_config = entry.config_path == config_key;
            let is_fresh = now.saturating_sub(entry.captured_at_unix_ms) <= DASHBOARD_VISIBLE_LAST_ERROR_CACHE_TTL_MS;
            if is_same_config && is_fresh {
                return entry.events.clone();
            }
        }
    }

    let events = load_event_log_entries_for_display(
        store,
        config_path,
        None,
        None,
        EVENT_LOG_DASHBOARD_VISIBLE_LIMIT,
    );
    let mut guard = match cache.lock() {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    };
    *guard = Some(VisibleLastErrorEventsCache {
        config_path: config_key,
        captured_at_unix_ms: now,
        events: events.clone(),
    });
    events
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

struct StatusWatchdogGuard<'a> {
    watchdog: &'a app_state::UiWatchdogState,
    finished: bool,
}

impl<'a> StatusWatchdogGuard<'a> {
    fn start(watchdog: &'a app_state::UiWatchdogState, detail_level: &str) -> Self {
        watchdog.record_backend_status_started(detail_level, unix_ms());
        Self {
            watchdog,
            finished: false,
        }
    }

    fn phase(&self, phase: &str) {
        self.watchdog.record_backend_status_progress(phase, unix_ms());
    }

    fn finish(&mut self) {
        if self.finished {
            return;
        }
        self.watchdog.record_backend_status_finished(unix_ms());
        self.finished = true;
    }
}

impl Drop for StatusWatchdogGuard<'_> {
    fn drop(&mut self) {
        self.finish();
    }
}

#[tauri::command]
pub(crate) fn get_status(
    state: tauri::State<'_, app_state::AppState>,
    detail_level: Option<String>,
) -> Result<serde_json::Value, String> {
    let command_started_at = std::time::Instant::now();
    let mut phase_timings_ms = serde_json::Map::new();
    let dashboard_detail = detail_level
        .as_deref()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("dashboard"));
    let status_watchdog_detail = detail_level
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("full");
    let mut status_watchdog = StatusWatchdogGuard::start(&state.ui_watchdog, status_watchdog_detail);
    let phase_started_at = std::time::Instant::now();
    let cfg = state.gateway.cfg.read().clone();
    let config_revision = config_revision(&state, &cfg);
    let wsl_gateway_host =
        crate::platform::wsl_gateway_host::cached_or_default_wsl_gateway_host(Some(&state.config_path));
    #[cfg(windows)]
    let _runtime_wsl_binding_in_progress =
        maybe_refresh_runtime_wsl_listener(&state, &wsl_gateway_host) > 0;
    #[cfg(not(windows))]
    let _runtime_wsl_binding_in_progress = false;
    let local_network = state.local_network.snapshot_for_status_poll();
    phase_timings_ms.insert(
        "config_and_revision".to_string(),
        serde_json::json!(elapsed_ms_since(phase_started_at)),
    );
    status_watchdog.phase("config_and_revision");
    let now = unix_ms();
    let phase_started_at = std::time::Instant::now();
    state.gateway.router.sync_with_config(&cfg, now);
    let mut providers = state.gateway.router.snapshot(now);
    phase_timings_ms.insert(
        "router_snapshot".to_string(),
        serde_json::json!(elapsed_ms_since(phase_started_at)),
    );
    status_watchdog.phase("router_snapshot");
    let phase_started_at = std::time::Instant::now();
    let visible_event_log_entries = load_visible_last_error_events_with_cache(
        &state.gateway.store,
        state.config_path.as_path(),
        dashboard_detail,
    );
    attach_visible_last_error_event_ids(&mut providers, &visible_event_log_entries);
    phase_timings_ms.insert(
        "visible_last_error_events".to_string(),
        serde_json::json!(elapsed_ms_since(phase_started_at)),
    );
    status_watchdog.phase("visible_last_error_events");
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
    status_watchdog.phase("recent_events");
    let phase_started_at = std::time::Instant::now();
    let metrics = state.gateway.store.get_metrics();
    let quota = state.gateway.store.list_quota_snapshots();
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
    phase_timings_ms.insert(
        "metrics_quota_ledgers".to_string(),
        serde_json::json!(elapsed_ms_since(phase_started_at)),
    );
    status_watchdog.phase("metrics_quota_ledgers");
    let last_activity = state.gateway.last_activity_unix_ms.load(Ordering::Relaxed);
    let active_recent = last_activity > 0 && now.saturating_sub(last_activity) < 2 * 60 * 1000;
    let phase_started_at = std::time::Instant::now();
    let (active_provider, active_reason, active_provider_counts) = if active_recent {
        let map = state.gateway.last_used_by_session.read().clone();

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
    status_watchdog.phase("active_provider");
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
    status_watchdog.phase("codex_account");
    let phase_started_at = std::time::Instant::now();
    let lan_sync = current_dashboard_lan_sync_snapshot(
        cfg.listen.port,
        &cfg,
        &state.secrets,
        &state.lan_sync,
    );
    phase_timings_ms.insert(
        "lan_sync_snapshot".to_string(),
        serde_json::json!(elapsed_ms_since(phase_started_at)),
    );
    status_watchdog.phase("lan_sync_snapshot");
    let phase_started_at = std::time::Instant::now();
    let tailscale = current_dashboard_tailscale_snapshot(cfg.listen.port);
    phase_timings_ms.insert(
        "tailscale_snapshot".to_string(),
        serde_json::json!(elapsed_ms_since(phase_started_at)),
    );
    status_watchdog.phase("tailscale_snapshot");
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
    status_watchdog.phase("shared_quota_owners");

    let phase_started_at = std::time::Instant::now();
    let client_sessions = {
        let thread_index_snapshot =
            crate::orchestrator::gateway::web_codex_threads::cached_threads_snapshot_stale_while_revalidate();
        let gateway_token = state.secrets.get_gateway_token().unwrap_or_default();
        let expected_gateway_token = (!gateway_token.is_empty()).then_some(gateway_token.as_str());
        let terminal_discovery =
            crate::platform::windows_terminal::discover_sessions_using_router_snapshot(
                cfg.listen.port,
                expected_gateway_token,
            );
        let items = {
            let mut map = state.gateway.client_sessions.write();
            merge_discovered_terminal_sessions(&mut map, now, &terminal_discovery);
            merge_thread_index_session_hints(
                &mut map,
                now,
                &thread_index_snapshot.items,
                thread_index_snapshot.fresh,
            );
            confirm_router_from_live_thread_base_url(
                &mut map,
                &thread_index_snapshot.items,
                cfg.listen.port,
            );
            backfill_main_confirmation_from_verified_agent(&mut map, now);
            let removed_main_sessions = retain_live_app_server_sessions(
                &mut map,
                now,
                &terminal_discovery.items,
                terminal_discovery.fresh,
                &thread_index_snapshot.items,
                thread_index_snapshot.fresh,
            );
            clear_removed_main_session_routes_and_assignments(&state.gateway, &removed_main_sessions);
            rebalance_balanced_assignments_on_main_session_change(&state.gateway, &cfg, &map);
            visible_client_session_items(&map, 20)
        };
        let last_used_by_session = state.gateway.last_used_by_session.read();
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
        trace_client_sessions_snapshot(&sessions);
        sessions
    };
    phase_timings_ms.insert(
        "client_sessions".to_string(),
        serde_json::json!(elapsed_ms_since(phase_started_at)),
    );
    status_watchdog.phase("client_sessions");

    let response = serde_json::json!({
      "listen": { "host": cfg.listen.host, "port": cfg.listen.port },
      "config_revision": config_revision,
      "wsl_gateway_host": wsl_gateway_host,
      "local_network_online": local_network.online,
      "local_network_source": local_network.source,
      "local_network_last_error": local_network.last_error,
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
      "client_sessions": client_sessions,
      "lan_sync": lan_sync,
      "tailscale": tailscale,
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
    status_watchdog.phase("response_ready");
    status_watchdog.finish();
    Ok(response)
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
    let kind_trimmed = kind.trim().to_string();
    let payload = serde_json::json!({
        "active_page": active_page,
        "visible": visible,
        "fields": fields,
    });
    state.ui_watchdog.record_trace(
        &kind_trimmed,
        payload.clone(),
        unix_ms(),
    );
    if kind_trimmed.starts_with("sessions.") {
        let _ = crate::orchestrator::gateway::web_codex_storage::append_codex_live_trace_entry(
            &serde_json::json!({
                "source": "ui.trace",
                "entry": {
                    "at": unix_ms(),
                    "kind": kind_trimmed,
                    "payload": payload,
                }
            }),
        );
    }
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

fn merge_discovered_terminal_sessions(
    map: &mut std::collections::HashMap<String, crate::orchestrator::gateway::ClientSessionRuntime>,
    now: u64,
    discovery: &crate::platform::windows_terminal::SessionDiscoverySnapshot,
) {
    for discovered in &discovery.items {
        let Some(session_id) = discovered
            .codex_session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };

        let entry = map.entry(session_id.to_string()).or_insert_with(|| {
            crate::orchestrator::gateway::ClientSessionRuntime {
                codex_session_id: session_id.to_string(),
                pid: discovered.pid,
                wt_session: Some(discovered.wt_session.clone()),
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 0,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                rollout_path: discovered.rollout_path.clone(),
                agent_parent_session_id: discovered.agent_parent_session_id.clone(),
                is_agent: discovered.is_agent,
                is_review: discovered.is_review,
                confirmed_router: discovered.router_confirmed,
            }
        });

        if discovered.pid != 0 {
            entry.pid = discovered.pid;
        }
        entry.wt_session = crate::platform::windows_terminal::merge_wt_session_marker(
            entry.wt_session.as_deref(),
            &discovered.wt_session,
        );
        if discovery.fresh {
            entry.last_discovered_unix_ms = now;
        }
        if let Some(rollout_path) = discovered
            .rollout_path
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
        {
            entry.rollout_path = Some(rollout_path.to_string());
        }
        if let Some(parent_sid) = discovered
            .agent_parent_session_id
            .as_deref()
            .map(str::trim)
            .filter(|sid| !sid.is_empty())
        {
            entry.agent_parent_session_id = Some(parent_sid.to_string());
        }
        if let Some(base_url) = discovered
            .reported_base_url
            .as_deref()
            .map(str::trim)
            .filter(|base| !base.is_empty())
        {
            entry.last_reported_base_url = Some(base_url.to_string());
        }
        if discovered.is_agent {
            entry.is_agent = true;
        }
        if discovered.is_review {
            entry.is_review = true;
            entry.is_agent = true;
        }
        merge_discovered_model_provider(entry, discovered.reported_model_provider.as_deref());
        if discovered.router_confirmed {
            entry.confirmed_router = true;
            entry.last_reported_model_provider =
                Some(crate::constants::GATEWAY_MODEL_PROVIDER_ID.to_string());
        }
    }
}

fn confirm_router_from_live_thread_base_url(
    map: &mut std::collections::HashMap<String, crate::orchestrator::gateway::ClientSessionRuntime>,
    thread_items: &[serde_json::Value],
    router_port: u16,
) {
    let live_router_thread_ids: Vec<(String, String)> = thread_items
        .iter()
        .filter(|item| {
            crate::commands::status_snapshot_support::thread_item_is_live_presence(item)
        })
        .filter_map(|item| {
            let session_id =
                crate::commands::status_snapshot_support::thread_item_string_field(item, "id")?;
            let base_url =
                crate::commands::status_snapshot_support::thread_item_base_url(item)?;
            crate::platform::windows_terminal::looks_like_router_base(&base_url, router_port)
                .then_some((session_id, base_url))
        })
        .collect::<Vec<_>>();

    for (session_id, base_url) in live_router_thread_ids {
        let entry = map.entry(session_id.clone()).or_insert_with(|| {
            crate::orchestrator::gateway::ClientSessionRuntime {
                codex_session_id: session_id.clone(),
                pid: 0,
                wt_session: None,
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 0,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                rollout_path: None,
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: false,
            }
        });
        entry.last_reported_base_url = Some(base_url);
        entry.confirmed_router = true;
        entry.last_reported_model_provider =
            Some(crate::constants::GATEWAY_MODEL_PROVIDER_ID.to_string());
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
    gateway.store.events().emit(
        "gateway",
        crate::orchestrator::store::EventCode::ROUTING_BALANCED_REASSIGN_ON_SESSION_TOPOLOGY_CHANGE,
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
            let parent_sid = infer_agent_parent_sid_from_runtime_map(map, entry)?;
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
                    rollout_path: None,
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
const EVENT_LOG_DASHBOARD_VISIBLE_LIMIT: usize = 200;

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

fn load_event_log_entries_for_display(
    store: &crate::orchestrator::store::Store,
    config_path: &std::path::Path,
    from: Option<u64>,
    to: Option<u64>,
    cap: usize,
) -> Vec<Value> {
    let mut events = store.list_events_range(from, to, Some(cap));
    events.retain(event_shape_is_valid);
    let mut dedup = std::collections::HashSet::<String>::new();
    for event in &events {
        if let Some(key) = event_query_key(event) {
            let _ = dedup.insert(key);
        }
    }
    let backup_root = backup_data_root_from_config_path(config_path);
    append_backup_events(&mut events, &mut dedup, &backup_root, from, to, cap);
    let mut events = crate::orchestrator::store::Store::compress_events_for_display(events);
    events.truncate(cap);
    events
}

fn attach_visible_last_error_event_ids(
    providers: &mut std::collections::HashMap<
        String,
        crate::orchestrator::router::ProviderHealthSnapshot,
    >,
    visible_events: &[Value],
) {
    for (provider_name, snapshot) in providers.iter_mut() {
        snapshot.last_error_event_id = None;
        let last_error = snapshot.last_error.trim();
        if last_error.is_empty() || snapshot.last_fail_at_unix_ms == 0 {
            continue;
        }

        let provider = provider_name.trim();
        let mut best_match: Option<(u64, &str)> = None;
        for event in visible_events {
            let Some(event_id) = event.get("id").and_then(Value::as_str) else {
                continue;
            };
            if !event
                .get("level")
                .and_then(Value::as_str)
                .is_some_and(|level| level == "error")
            {
                continue;
            }
            if !event
                .get("provider")
                .and_then(Value::as_str)
                .is_some_and(|event_provider| event_provider.trim() == provider)
            {
                continue;
            }
            if !event
                .get("message")
                .and_then(Value::as_str)
                .is_some_and(|message| message.trim() == last_error)
            {
                continue;
            }
            let Some(event_unix_ms) = event.get("unix_ms").and_then(Value::as_u64) else {
                continue;
            };
            let distance = event_unix_ms.abs_diff(snapshot.last_fail_at_unix_ms);
            if distance > DASHBOARD_LAST_ERROR_EVENT_MATCH_WINDOW_MS {
                continue;
            }
            match best_match {
                Some((best_distance, _)) if best_distance <= distance => {}
                _ => best_match = Some((distance, event_id)),
            }
        }
        snapshot.last_error_event_id = best_match.map(|(_, event_id)| event_id.to_string());
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
    let events = load_event_log_entries_for_display(
        &state.gateway.store,
        state.config_path.as_path(),
        from,
        to,
        cap,
    );
    serde_json::Value::Array(events)
}

#[tauri::command]
pub(crate) fn get_event_log_entry_by_id(
    state: tauri::State<'_, app_state::AppState>,
    event_id: String,
) -> serde_json::Value {
    state
        .gateway
        .store
        .get_event_by_id(&event_id)
        .filter(event_shape_is_valid)
        .map(|event| crate::orchestrator::store::Store::compress_events_for_display(vec![event]))
        .and_then(|mut events| events.pop())
        .unwrap_or(serde_json::Value::Null)
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
    use super::{fallback_tailscale_snapshot, run_blocking_snapshot};
    use crate::constants::GATEWAY_MODEL_PROVIDER_ID;
    use crate::commands::{
        attach_visible_last_error_event_ids,
        backfill_main_confirmation_from_verified_agent,
        clear_visible_last_error_events_cache,
        clear_removed_main_session_routes_and_assignments,
        append_backup_event_daily_stats, day_start_unix_ms_from_day_key, event_query_key,
        config_revision,
        load_visible_last_error_events_with_cache,
        load_event_log_entries_for_display,
        main_session_ids_excluding_agents_and_reviews,
        merge_thread_index_session_hints,
        rebalance_balanced_assignments_on_main_session_change,
        retain_live_app_server_sessions,
        displayed_session_route, merge_discovered_model_provider, next_last_discovered_unix_ms,
        normalize_event_query_limit, EVENT_LOG_DASHBOARD_VISIBLE_LIMIT,
        should_keep_runtime_session,
    };
    #[cfg(windows)]
    use super::should_refresh_runtime_wsl_listener;
    use crate::orchestrator::config::{AppConfig, ListenConfig, ProviderConfig, RoutingConfig};
    use crate::orchestrator::gateway::{decide_provider, open_store_dir, GatewayState, LastUsedRoute};
    use crate::orchestrator::router::{ProviderHealthSnapshot, RouterState};
    use crate::orchestrator::secrets::SecretStore;
    use crate::orchestrator::store::{unix_ms, StoredEventRow, UsageRequestSyncRow};
    use crate::orchestrator::upstream::UpstreamClient;
    use crate::orchestrator::gateway::ClientSessionRuntime;
    use chrono::TimeZone;
    use parking_lot::RwLock;
    use serde_json::Value;
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::sync::atomic::AtomicU64;

    #[cfg(windows)]
    #[test]
    fn runtime_wsl_listener_refreshes_for_windows_loopback_gateway() {
        assert!(should_refresh_runtime_wsl_listener(
            crate::constants::GATEWAY_WINDOWS_HOST,
            "172.26.144.1",
        ));
    }

    #[cfg(windows)]
    #[test]
    fn runtime_wsl_listener_skips_when_gateway_already_listens_on_wsl_host() {
        assert!(!should_refresh_runtime_wsl_listener(
            "172.26.144.1",
            "172.26.144.1",
        ));
    }

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
            rollout_path: None,
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
    fn visible_last_error_ids_ignore_errors_after_first_dashboard_page() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = open_store_dir(tmp.path().join("data")).expect("store");
        let config_path = tmp.path().join("config.toml");
        let provider = "codex-for.me";
        let old_error_ts = 1_775_100_000_000_u64;
        assert!(store.insert_event_row(StoredEventRow {
            id: "evt-old-codex-error".to_string(),
            provider: provider.to_string(),
            level: "error".to_string(),
            code: "gateway.request_failed".to_string(),
            message: "request error: boom".to_string(),
            fields: Value::Null,
            unix_ms: old_error_ts,
        }));
        for idx in 0..EVENT_LOG_DASHBOARD_VISIBLE_LIMIT {
            assert!(store.insert_event_row(StoredEventRow {
                id: format!("evt-newer-{idx}"),
                provider: "gateway".to_string(),
                level: "info".to_string(),
                code: "heartbeat".to_string(),
                message: format!("newer event {idx}"),
                fields: Value::Null,
                unix_ms: old_error_ts + 1_000 + idx as u64,
            }));
        }

        let visible = load_event_log_entries_for_display(
            &store,
            &config_path,
            None,
            None,
            EVENT_LOG_DASHBOARD_VISIBLE_LIMIT,
        );
        assert_eq!(visible.len(), EVENT_LOG_DASHBOARD_VISIBLE_LIMIT);
        assert!(!visible
            .iter()
            .any(|event| event.get("id").and_then(Value::as_str) == Some("evt-old-codex-error")));

        let mut providers = HashMap::from([(
            provider.to_string(),
            ProviderHealthSnapshot {
                status: "unhealthy".to_string(),
                consecutive_failures: 1,
                cooldown_until_unix_ms: 0,
                last_error: "request error: boom".to_string(),
                last_ok_at_unix_ms: 0,
                last_fail_at_unix_ms: old_error_ts,
                last_error_event_id: None,
            },
        )]);

        attach_visible_last_error_event_ids(&mut providers, &visible);

        assert_eq!(
            providers
                .get(provider)
                .and_then(|snapshot| snapshot.last_error_event_id.as_deref()),
            None
        );
    }

    #[test]
    fn visible_last_error_ids_attach_visible_exact_error() {
        let provider = "codex-for.me";
        let mut providers = HashMap::from([(
            provider.to_string(),
            ProviderHealthSnapshot {
                status: "unhealthy".to_string(),
                consecutive_failures: 1,
                cooldown_until_unix_ms: 0,
                last_error: "request error: boom".to_string(),
                last_ok_at_unix_ms: 0,
                last_fail_at_unix_ms: 2_000,
                last_error_event_id: None,
            },
        )]);
        let visible = vec![
            serde_json::json!({
                "id": "evt-wrong-message",
                "unix_ms": 1_999,
                "provider": provider,
                "level": "error",
                "code": "gateway.request_failed",
                "message": "different",
                "fields": null,
            }),
            serde_json::json!({
                "id": "evt-visible-error",
                "unix_ms": 2_001,
                "provider": provider,
                "level": "error",
                "code": "gateway.request_failed",
                "message": "request error: boom",
                "fields": null,
            }),
        ];

        attach_visible_last_error_event_ids(&mut providers, &visible);

        assert_eq!(
            providers
                .get(provider)
                .and_then(|snapshot| snapshot.last_error_event_id.as_deref()),
            Some("evt-visible-error")
        );
    }

    #[test]
    fn visible_last_error_ids_ignore_far_repeated_error_message() {
        let provider = "aigateway2";
        let snapshot_ts = 1_776_240_000_000_u64;
        let mut providers = HashMap::from([(
            provider.to_string(),
            ProviderHealthSnapshot {
                status: "unhealthy".to_string(),
                consecutive_failures: 1,
                cooldown_until_unix_ms: 0,
                last_error: r#"upstream aigateway2 returned 503: {"error":{"message":"Service temporarily unavailable","type":"api_error"}}"#.to_string(),
                last_ok_at_unix_ms: snapshot_ts + 60_000,
                last_fail_at_unix_ms: snapshot_ts,
                last_error_event_id: None,
            },
        )]);
        let visible = vec![serde_json::json!({
            "id": "evt-far-repeat",
            "unix_ms": snapshot_ts + (24 * 60 * 60 * 1000),
            "provider": provider,
            "level": "error",
            "code": "upstream.http_error",
            "message": r#"upstream aigateway2 returned 503: {"error":{"message":"Service temporarily unavailable","type":"api_error"}}"#,
            "fields": null,
        })];

        attach_visible_last_error_event_ids(&mut providers, &visible);

        assert_eq!(
            providers
                .get(provider)
                .and_then(|snapshot| snapshot.last_error_event_id.as_deref()),
            None
        );
    }

    #[test]
    fn visible_last_error_ids_attach_when_error_is_on_first_dashboard_page() {
        clear_visible_last_error_events_cache();
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = open_store_dir(tmp.path().join("data")).expect("store");
        let config_path = tmp.path().join("config.toml");
        let provider = "codex-for.me";
        let target_ts = 1_775_100_000_000_u64;
        assert!(store.insert_event_row(StoredEventRow {
            id: "evt-visible-codex-error".to_string(),
            provider: provider.to_string(),
            level: "error".to_string(),
            code: "gateway.request_failed".to_string(),
            message: "request error: boom".to_string(),
            fields: Value::Null,
            unix_ms: target_ts,
        }));
        for idx in 0..(EVENT_LOG_DASHBOARD_VISIBLE_LIMIT - 1) {
            assert!(store.insert_event_row(StoredEventRow {
                id: format!("evt-newer-{idx}"),
                provider: "gateway".to_string(),
                level: "info".to_string(),
                code: "heartbeat".to_string(),
                message: format!("newer event {idx}"),
                fields: Value::Null,
                unix_ms: target_ts + 1_000 + idx as u64,
            }));
        }

        let visible = load_event_log_entries_for_display(
            &store,
            &config_path,
            None,
            None,
            EVENT_LOG_DASHBOARD_VISIBLE_LIMIT,
        );
        assert_eq!(visible.len(), EVENT_LOG_DASHBOARD_VISIBLE_LIMIT);
        assert!(visible
            .iter()
            .any(|event| event.get("id").and_then(Value::as_str) == Some("evt-visible-codex-error")));

        let mut providers = HashMap::from([(
            provider.to_string(),
            ProviderHealthSnapshot {
                status: "unhealthy".to_string(),
                consecutive_failures: 1,
                cooldown_until_unix_ms: 0,
                last_error: "request error: boom".to_string(),
                last_ok_at_unix_ms: 0,
                last_fail_at_unix_ms: target_ts,
                last_error_event_id: None,
            },
        )]);

        attach_visible_last_error_event_ids(&mut providers, &visible);

        assert_eq!(
            providers
                .get(provider)
                .and_then(|snapshot| snapshot.last_error_event_id.as_deref()),
            Some("evt-visible-codex-error")
        );
    }

    #[test]
    fn fallback_tailscale_snapshot_marks_status_error_without_breaking_status_payload() {
        let snapshot = fallback_tailscale_snapshot(Some("snapshot_failed: boom".to_string()));
        assert!(!snapshot.installed);
        assert!(!snapshot.connected);
        assert_eq!(snapshot.status_error.as_deref(), Some("snapshot_failed: boom"));
        assert!(snapshot.probe.attempts.is_empty());
        assert!(snapshot.command_path.is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn run_blocking_snapshot_uses_a_separate_thread() {
        let outer_thread_id = std::thread::current().id();
        let value = run_blocking_snapshot(move || {
            let inner_thread_id = std::thread::current().id();
            assert_ne!(
                inner_thread_id, outer_thread_id,
                "blocking snapshot should run on a blocking worker thread"
            );
            42_u8
        })
        .await
        .expect("blocking snapshot");

        assert_eq!(value, 42);
    }

    #[test]
    fn dashboard_visible_last_error_events_use_short_lived_cache() {
        clear_visible_last_error_events_cache();
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = open_store_dir(tmp.path().join("data")).expect("store");
        let config_path = tmp.path().join("config.toml");
        let base_ts = 1_775_100_000_000_u64;
        assert!(store.insert_event_row(StoredEventRow {
            id: "evt-initial".to_string(),
            provider: "demo".to_string(),
            level: "error".to_string(),
            code: "gateway.request_failed".to_string(),
            message: "initial".to_string(),
            fields: Value::Null,
            unix_ms: base_ts,
        }));

        let initial = load_visible_last_error_events_with_cache(&store, &config_path, false);
        assert_eq!(
            initial.first().and_then(|event| event.get("id")).and_then(Value::as_str),
            Some("evt-initial")
        );

        assert!(store.insert_event_row(StoredEventRow {
            id: "evt-newer".to_string(),
            provider: "demo".to_string(),
            level: "error".to_string(),
            code: "gateway.request_failed".to_string(),
            message: "newer".to_string(),
            fields: Value::Null,
            unix_ms: base_ts + 1_000,
        }));

        let cached = load_visible_last_error_events_with_cache(&store, &config_path, true);
        assert_eq!(
            cached.first().and_then(|event| event.get("id")).and_then(Value::as_str),
            Some("evt-initial")
        );

        let refreshed = load_visible_last_error_events_with_cache(&store, &config_path, false);
        assert_eq!(
            refreshed.first().and_then(|event| event.get("id")).and_then(Value::as_str),
            Some("evt-newer")
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

        let compressed = crate::orchestrator::store::Store::compress_events_for_display(events);
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

        let compressed = crate::orchestrator::store::Store::compress_events_for_display(events);
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
            rollout_path: None,
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: false,
        };
        merge_discovered_model_provider(&mut entry, Some("openai"));
        assert_eq!(entry.last_reported_model_provider.as_deref(), Some("openai"));
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
                supports_websockets: false,
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
                supports_websockets: false,
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
                    rollout_path: None,
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
                supports_websockets: false,
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
                supports_websockets: false,
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
                        rollout_path: None,
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
                        rollout_path: None,
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
                supports_websockets: false,
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
                    rollout_path: None,
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
                    rollout_path: None,
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
                    rollout_path: None,
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
                    supports_websockets: false,
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
            rollout_path: None,
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
                supports_websockets: false,
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
                supports_websockets: false,
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
                rollout_path: None,
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
                rollout_path: None,
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
                rollout_path: None,
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
                rollout_path: None,
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
                rollout_path: None,
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
                rollout_path: None,
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
                rollout_path: None,
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
                rollout_path: None,
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
                rollout_path: None,
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
                rollout_path: None,
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
                rollout_path: None,
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
                rollout_path: None,
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
                rollout_path: None,
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
                rollout_path: None,
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
                rollout_path: None,
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
                rollout_path: None,
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
                rollout_path: None,
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
                    rollout_path: None,
                    agent_parent_session_id: None,
                    is_agent: false,
                    is_review: false,
                    confirmed_router: true,
                },
            );
        }

        let items = super::recent_client_sessions_with_main_parent_context(&map, &map, 20);
        let ids: std::collections::HashSet<String> =
            items.iter().map(|(sid, _runtime)| sid.clone()).collect();

        assert!(ids.contains("agent-top"));
        assert!(ids.contains("main-parent"));
        assert_eq!(items.len(), 21);
    }

    #[test]
    fn visible_client_sessions_skip_entries_without_rollout() {
        let mut map = std::collections::HashMap::new();
        map.insert(
            "main-no-rollout".to_string(),
            ClientSessionRuntime {
                codex_session_id: "main-no-rollout".to_string(),
                pid: 0,
                wt_session: Some("wt-main".to_string()),
                last_request_unix_ms: 100,
                last_discovered_unix_ms: 100,
                last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
                last_reported_model: None,
                last_reported_base_url: None,
                rollout_path: None,
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: true,
            },
        );
        map.insert(
            "agent-no-rollout".to_string(),
            ClientSessionRuntime {
                codex_session_id: "agent-no-rollout".to_string(),
                pid: 0,
                wt_session: Some("wt-agent".to_string()),
                last_request_unix_ms: 200,
                last_discovered_unix_ms: 200,
                last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
                last_reported_model: None,
                last_reported_base_url: None,
                rollout_path: None,
                agent_parent_session_id: Some("main-with-rollout".to_string()),
                is_agent: true,
                is_review: false,
                confirmed_router: true,
            },
        );
        map.insert(
            "main-with-rollout".to_string(),
            ClientSessionRuntime {
                codex_session_id: "main-with-rollout".to_string(),
                pid: 0,
                wt_session: Some("wt-main-2".to_string()),
                last_request_unix_ms: 300,
                last_discovered_unix_ms: 300,
                last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
                last_reported_model: None,
                last_reported_base_url: None,
                rollout_path: Some("C:\\repo\\.codex\\sessions\\rollout-main.jsonl".to_string()),
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: true,
            },
        );
        map.insert(
            "review-with-rollout".to_string(),
            ClientSessionRuntime {
                codex_session_id: "review-with-rollout".to_string(),
                pid: 0,
                wt_session: Some("wt-review".to_string()),
                last_request_unix_ms: 400,
                last_discovered_unix_ms: 400,
                last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
                last_reported_model: None,
                last_reported_base_url: None,
                rollout_path: Some(
                    "C:\\repo\\.codex\\sessions\\rollout-review.jsonl".to_string(),
                ),
                agent_parent_session_id: Some("main-with-rollout".to_string()),
                is_agent: true,
                is_review: true,
                confirmed_router: true,
            },
        );

        let items = super::visible_client_session_items(&map, 20);
        let ids: std::collections::HashSet<String> =
            items.iter().map(|(sid, _runtime)| sid.clone()).collect();

        assert!(ids.contains("main-with-rollout"));
        assert!(ids.contains("review-with-rollout"));
        assert!(!ids.contains("main-no-rollout"));
        assert!(!ids.contains("agent-no-rollout"));
    }

    #[test]
    fn visible_client_sessions_keep_rollout_parent_context_for_agent_rows() {
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
                rollout_path: Some("C:\\repo\\.codex\\sessions\\rollout-main.jsonl".to_string()),
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
                rollout_path: Some("C:\\repo\\.codex\\sessions\\rollout-agent.jsonl".to_string()),
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
                    rollout_path: Some(format!(
                        "C:\\repo\\.codex\\sessions\\rollout-other-{index:02}.jsonl"
                    )),
                    agent_parent_session_id: None,
                    is_agent: false,
                    is_review: false,
                    confirmed_router: true,
                },
            );
        }

        let items = super::visible_client_session_items(&map, 20);
        let ids: std::collections::HashSet<String> =
            items.iter().map(|(sid, _runtime)| sid.clone()).collect();

        assert!(ids.contains("agent-top"));
        assert!(ids.contains("main-parent"));
        assert_eq!(items.len(), 21);
    }

    #[test]
    fn visible_client_sessions_include_parent_without_rollout_for_visible_agent_rows() {
        let mut map = std::collections::HashMap::new();
        map.insert(
            "main-parent".to_string(),
            ClientSessionRuntime {
                codex_session_id: "main-parent".to_string(),
                pid: 0,
                wt_session: Some("wt-main".to_string()),
                last_request_unix_ms: 450,
                last_discovered_unix_ms: 450,
                last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
                last_reported_model: None,
                last_reported_base_url: None,
                rollout_path: None,
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
                rollout_path: Some("C:\\repo\\.codex\\sessions\\rollout-agent.jsonl".to_string()),
                agent_parent_session_id: Some("main-parent".to_string()),
                is_agent: true,
                is_review: false,
                confirmed_router: true,
            },
        );

        let items = super::visible_client_session_items(&map, 20);
        let ids: std::collections::HashSet<String> =
            items.iter().map(|(sid, _runtime)| sid.clone()).collect();

        assert!(ids.contains("agent-top"));
        assert!(
            ids.contains("main-parent"),
            "visible agent rows should pull their parent main session into the Sessions panel"
        );
    }

    #[test]
    fn visible_client_sessions_limit_is_stable_when_last_seen_ties() {
        fn make_runtime(id: &str) -> ClientSessionRuntime {
            ClientSessionRuntime {
                codex_session_id: id.to_string(),
                pid: 0,
                wt_session: None,
                last_request_unix_ms: 10_000,
                last_discovered_unix_ms: 10_000,
                last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
                last_reported_model: None,
                last_reported_base_url: None,
                rollout_path: Some(format!("C:\\repo\\.codex\\sessions\\rollout-{id}.jsonl")),
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: false,
            }
        }

        let ids = (0..30)
            .map(|index| format!("session-{index:02}"))
            .collect::<Vec<_>>();
        let mut ascending_map = std::collections::HashMap::new();
        for id in &ids {
            ascending_map.insert(id.clone(), make_runtime(id));
        }
        let mut descending_map = std::collections::HashMap::new();
        for id in ids.iter().rev() {
            descending_map.insert(id.clone(), make_runtime(id));
        }

        let ascending_ids = super::visible_client_session_items(&ascending_map, 20)
            .into_iter()
            .map(|(sid, _runtime)| sid)
            .collect::<Vec<_>>();
        let descending_ids = super::visible_client_session_items(&descending_map, 20)
            .into_iter()
            .map(|(sid, _runtime)| sid)
            .collect::<Vec<_>>();

        assert_eq!(
            ascending_ids, descending_ids,
            "equal last-seen sessions should keep a stable visible set regardless of HashMap insertion order",
        );
        assert_eq!(ascending_ids.len(), 20);
        assert_eq!(
            ascending_ids,
            ids.into_iter().take(20).collect::<Vec<_>>(),
            "stable tie-break should keep the lexicographically earliest sessions visible",
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
                rollout_path: None,
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
                rollout_path: None,
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
                rollout_path: None,
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
                rollout_path: None,
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
    fn status_projected_ledgers_reuse_live_ledger_snapshot() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("user-data").join("data");
        let state = crate::app_state::build_state(config_path, data_dir).expect("build state");
        state.gateway.store.reset_ledger("packycode");
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
                transport: "http".to_string(),
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

        let projected = state.gateway.store.list_ledgers();
        assert_eq!(
            projected
                .get("packycode")
                .and_then(serde_json::Value::as_object)
                .and_then(|value| value.get("since_last_quota_refresh_requests"))
                .and_then(serde_json::Value::as_u64),
            Some(0)
        );
        assert_eq!(
            projected
                .get("packycode")
                .and_then(serde_json::Value::as_object)
                .and_then(|value| value.get("since_last_quota_refresh_total_tokens"))
                .and_then(serde_json::Value::as_u64),
            Some(0)
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
    fn discovered_wsl_terminal_identity_backfills_existing_gateway_session() {
        let now = 123_456_u64;
        let mut map = std::collections::HashMap::from([(
            "019d8635-798a-7392-bfa6-b63a0a0358a2".to_string(),
            ClientSessionRuntime {
                codex_session_id: "019d8635-798a-7392-bfa6-b63a0a0358a2".to_string(),
                pid: 0,
                wt_session: None,
                last_request_unix_ms: now.saturating_sub(1_000),
                last_discovered_unix_ms: 0,
                last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
                last_reported_model: None,
                last_reported_base_url: Some("http://172.26.144.1:4000/v1".to_string()),
                rollout_path: None,
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: true,
            },
        )]);

        let discovery = crate::platform::windows_terminal::SessionDiscoverySnapshot {
            fresh: true,
            items: vec![crate::platform::windows_terminal::InferredWtSession {
                wt_session: "wsl:bb64caa2-94fc-4951-ac56-771dd8e2ce6d".to_string(),
                pid: 0,
                linux_pid: Some(5301),
                wsl_distro: Some("Ubuntu".to_string()),
                cwd: Some("/home/yiyou/Automated-Supertrend-Trading".to_string()),
                rollout_path: Some(
                    "\\\\wsl.localhost\\Ubuntu\\home\\yiyou\\.codex\\sessions\\2026\\04\\13\\rollout-2026-04-13T17-39-04-019d8635-798a-7392-bfa6-b63a0a0358a2.jsonl".to_string(),
                ),
                codex_session_id: Some("019d8635-798a-7392-bfa6-b63a0a0358a2".to_string()),
                reported_model_provider: None,
                reported_base_url: Some("http://172.26.144.1:4000/v1".to_string()),
                agent_parent_session_id: None,
                router_confirmed: true,
                is_agent: false,
                is_review: false,
            }],
        };

        super::merge_discovered_terminal_sessions(&mut map, now, &discovery);

        let entry = map
            .get("019d8635-798a-7392-bfa6-b63a0a0358a2")
            .expect("merged session");
        assert_eq!(
            entry.wt_session.as_deref(),
            Some("wsl:bb64caa2-94fc-4951-ac56-771dd8e2ce6d")
        );
        assert_eq!(entry.last_discovered_unix_ms, now);
        assert_eq!(
            entry.rollout_path.as_deref(),
            Some(
                "\\\\wsl.localhost\\Ubuntu\\home\\yiyou\\.codex\\sessions\\2026\\04\\13\\rollout-2026-04-13T17-39-04-019d8635-798a-7392-bfa6-b63a0a0358a2.jsonl"
            )
        );
        assert!(entry.confirmed_router);
    }

    #[test]
    fn discovered_wsl_terminal_identity_preserves_existing_wsl_marker_when_snapshot_stale() {
        let now = 123_456_u64;
        let mut map = std::collections::HashMap::from([(
            "session-wsl".to_string(),
            ClientSessionRuntime {
                codex_session_id: "session-wsl".to_string(),
                pid: 0,
                wt_session: Some("wsl:existing-tab".to_string()),
                last_request_unix_ms: now.saturating_sub(1_000),
                last_discovered_unix_ms: now.saturating_sub(9_000),
                last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
                last_reported_model: None,
                last_reported_base_url: None,
                rollout_path: None,
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: true,
            },
        )]);

        let discovery = crate::platform::windows_terminal::SessionDiscoverySnapshot {
            fresh: false,
            items: vec![crate::platform::windows_terminal::InferredWtSession {
                wt_session: "existing-tab".to_string(),
                pid: 0,
                linux_pid: Some(1),
                wsl_distro: Some("Ubuntu".to_string()),
                cwd: None,
                rollout_path: None,
                codex_session_id: Some("session-wsl".to_string()),
                reported_model_provider: None,
                reported_base_url: None,
                agent_parent_session_id: None,
                router_confirmed: true,
                is_agent: false,
                is_review: false,
            }],
        };

        super::merge_discovered_terminal_sessions(&mut map, now, &discovery);

        let entry = map.get("session-wsl").expect("merged session");
        assert_eq!(entry.wt_session.as_deref(), Some("wsl:existing-tab"));
        assert_eq!(entry.last_discovered_unix_ms, now.saturating_sub(9_000));
    }

    #[test]
    fn stale_wsl_session_keeps_when_wt_session_is_alive() {
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
            rollout_path: None,
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: true,
        };

        let keep =
            should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, false, 3, true);
        assert!(keep);
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
            rollout_path: None,
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: true,
        };

        let keep =
            should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, false, 1, true);
        assert!(keep);
    }

    #[test]
    fn idle_wsl_agent_drops_even_when_wt_alive() {
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
            rollout_path: None,
            agent_parent_session_id: Some("main-thread".to_string()),
            is_agent: true,
            is_review: false,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, false, 1, true);
        assert!(
            !keep,
            "idle agent rows must disappear even if the shared WT session is still alive",
        );
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
            rollout_path: None,
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, false, 3, false);
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
            rollout_path: None,
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: true,
        };

        let keep =
            should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, false, 0, true);
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
            rollout_path: None,
            agent_parent_session_id: Some("main-1".to_string()),
            is_agent: true,
            is_review: true,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, false, 3, true);
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
            rollout_path: None,
            agent_parent_session_id: Some("main-1".to_string()),
            is_agent: true,
            is_review: true,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, false, 0, true);
        assert!(!keep);
    }

    #[test]
    fn inactive_agent_with_live_process_identity_drops_after_stale_window() {
        let now = 2_000_000_u64;
        let entry = ClientSessionRuntime {
            codex_session_id: "agent-shared-pid".to_string(),
            pid: 9527,
            wt_session: Some("wt-main".to_string()),
            last_request_unix_ms: now.saturating_sub(20 * 60 * 1000),
            last_discovered_unix_ms: now.saturating_sub(20 * 60 * 1000),
            last_reported_model_provider: None,
            last_reported_model: None,
            last_reported_base_url: None,
            rollout_path: None,
            agent_parent_session_id: Some("main-1".to_string()),
            is_agent: true,
            is_review: false,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, false, 0, true);
        assert!(!keep);
    }

    #[test]
    fn inactive_pidless_agent_with_wt_session_drops_after_stale_window() {
        let now = 2_000_000_u64;
        let entry = ClientSessionRuntime {
            codex_session_id: "agent-pidless-wt".to_string(),
            pid: 0,
            wt_session: Some("wsl:test-wt".to_string()),
            last_request_unix_ms: now.saturating_sub(20 * 60 * 1000),
            last_discovered_unix_ms: now.saturating_sub(20 * 60 * 1000),
            last_reported_model_provider: None,
            last_reported_model: None,
            last_reported_base_url: None,
            rollout_path: None,
            agent_parent_session_id: Some("main-1".to_string()),
            is_agent: true,
            is_review: false,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, false, 0, true);
        assert!(!keep);
    }

    #[test]
    fn idle_pidless_agent_with_inherited_wt_session_drops_immediately() {
        let now = 2_000_000_u64;
        let entry = ClientSessionRuntime {
            codex_session_id: "agent-inherited-wt".to_string(),
            pid: 0,
            wt_session: Some("pid:41832".to_string()),
            last_request_unix_ms: now.saturating_sub(61_000),
            last_discovered_unix_ms: now,
            last_reported_model_provider: Some("api_router".to_string()),
            last_reported_model: Some("gpt-5.4-mini".to_string()),
            last_reported_base_url: None,
            rollout_path: Some(
                "C:\\Users\\yiyou\\.codex\\sessions\\agent-inherited-wt.jsonl".to_string(),
            ),
            agent_parent_session_id: Some("main-1".to_string()),
            is_agent: true,
            is_review: false,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, true, 0, true);
        assert!(
            !keep,
            "idle agents must disappear even if the parent terminal is still alive and discovery just refreshed",
        );
    }

    #[test]
    fn pidless_wt_session_keeps_when_stale_too_long_if_wt_alive() {
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
            rollout_path: None,
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: true,
        };

        let keep =
            should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, false, 0, true);
        assert!(keep);
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
            rollout_path: None,
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| false, false, 0, false);
        assert!(keep);
    }

    #[test]
    fn pidless_desktop_session_with_recent_live_discovery_keeps_without_terminal_identity() {
        let now = 2_000_000_u64;
        let entry = ClientSessionRuntime {
            codex_session_id: "desktop-live".to_string(),
            pid: 0,
            wt_session: None,
            last_request_unix_ms: 0,
            last_discovered_unix_ms: now.saturating_sub(5_000),
            last_reported_model_provider: Some("openai".to_string()),
            last_reported_model: Some("gpt-5.4-mini".to_string()),
            last_reported_base_url: None,
            rollout_path: Some("C:\\Users\\yiyou\\.codex\\sessions\\rollout-desktop-live.jsonl".to_string()),
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: false,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, false, 0, true);
        assert!(keep, "recent app-server live discovery should keep desktop session visible");
    }

    #[test]
    fn thread_index_live_item_promotes_desktop_session_without_terminal_identity() {
        let now = 2_000_000_u64;
        let mut map = HashMap::new();

        merge_thread_index_session_hints(
            &mut map,
            now,
            &[serde_json::json!({
                "id": "desktop-thread",
                "workspace": "windows",
                "path": "C:\\Users\\yiyou\\.codex\\sessions\\rollout-desktop-thread.jsonl",
                "status": { "type": "running" },
                "updatedAt": 1742269999,
                "modelProvider": "openai",
                "model": "gpt-5.4-mini"
            })],
            true,
        );

        let entry = map.get("desktop-thread").expect("thread-index session");
        assert_eq!(
            entry.rollout_path.as_deref(),
            Some("C:\\Users\\yiyou\\.codex\\sessions\\rollout-desktop-thread.jsonl")
        );
        assert_eq!(
            entry.last_reported_model_provider.as_deref(),
            Some("openai")
        );
        assert_eq!(entry.last_reported_model.as_deref(), Some("gpt-5.4-mini"));
        assert_eq!(entry.last_discovered_unix_ms, 1_742_269_999_000);
    }

    #[test]
    fn thread_index_first_seen_not_loaded_item_does_not_create_runtime_session() {
        let mut map = HashMap::new();
        let now = 2_000_000_u64;

        merge_thread_index_session_hints(
            &mut map,
            now,
            &[serde_json::json!({
                "id": "session-index-only",
                "workspace": "windows",
                "path": "C:\\Users\\yiyou\\.codex\\sessions\\rollout-session-index-only.jsonl",
                "status": { "type": "notLoaded" },
                "updatedAt": 1742269999
            })],
            true,
        );

        assert!(
            !map.contains_key("session-index-only"),
            "first-seen historical notLoaded main thread should not enter the runtime session map"
        );
    }

    #[test]
    fn thread_index_runtime_base_url_is_recorded_and_confirms_live_router_session() {
        let mut map = HashMap::new();
        let now = 2_000_000_u64;
        let items = vec![serde_json::json!({
            "id": "live-configured-thread",
            "workspace": "windows",
            "path": "C:\\Users\\yiyou\\.codex\\sessions\\rollout-live-configured-thread.jsonl",
            "status": { "type": "running" },
            "updatedAt": 1742269999,
            "base_url": "http://127.0.0.1:4000/v1"
        })];

        merge_thread_index_session_hints(&mut map, now, &items, true);
        super::confirm_router_from_live_thread_base_url(&mut map, &items, 4000);

        let entry = map
            .get("live-configured-thread")
            .expect("live configured thread");
        assert_eq!(
            entry.last_reported_base_url.as_deref(),
            Some("http://127.0.0.1:4000/v1")
        );
        assert!(
            entry.confirmed_router,
            "live runtime thread pointing at the router should be treated as configured to API Router"
        );
        assert_eq!(
            entry.last_reported_model_provider.as_deref(),
            Some(crate::constants::GATEWAY_MODEL_PROVIDER_ID)
        );
    }

    #[test]
    fn recent_live_windows_session_outranks_old_not_loaded_sessions() {
        let now = 1_800_000_000_000_u64;
        let mut map = HashMap::new();

        for index in 0..25 {
            merge_thread_index_session_hints(
                &mut map,
                now,
                &[serde_json::json!({
                    "id": format!("old-not-loaded-{index:02}"),
                    "workspace": "windows",
                    "path": format!("C:\\Users\\yiyou\\.codex\\sessions\\old-not-loaded-{index:02}.jsonl"),
                    "status": { "type": "notLoaded" },
                    "updatedAt": 1_742_000_000
                })],
                true,
            );
        }

        map.insert(
            "live-win-session".to_string(),
            ClientSessionRuntime {
                codex_session_id: "live-win-session".to_string(),
                pid: 0,
                wt_session: None,
                last_request_unix_ms: now,
                last_discovered_unix_ms: now,
                last_reported_model_provider: Some("api_router".to_string()),
                last_reported_model: Some("gpt-5.4".to_string()),
                last_reported_base_url: Some("http://127.0.0.1:4000/v1".to_string()),
                rollout_path: Some(
                    "C:\\Users\\yiyou\\.codex\\sessions\\live-win-session.jsonl".to_string(),
                ),
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: true,
            },
        );

        let items = super::visible_client_session_items(&map, 20);
        let ids: std::collections::HashSet<String> =
            items.iter().map(|(sid, _runtime)| sid.clone()).collect();

        assert!(
            ids.contains("live-win-session"),
            "recent live windows session should stay in the visible set instead of being displaced by old notLoaded snapshot rows",
        );
    }

    #[test]
    fn old_unverified_not_loaded_session_keeps_snapshot_timestamp() {
        let now = 1_800_000_000_000_u64;
        let mut map = HashMap::from([(
            "old-unverified".to_string(),
            ClientSessionRuntime {
                codex_session_id: "old-unverified".to_string(),
                pid: 0,
                wt_session: None,
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 1_741_000_000_000,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                rollout_path: Some("C:\\Users\\yiyou\\.codex\\sessions\\old-unverified.jsonl".to_string()),
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: false,
            },
        )]);

        merge_thread_index_session_hints(
            &mut map,
            now,
            &[serde_json::json!({
                "id": "old-unverified",
                "workspace": "windows",
                "path": "C:\\Users\\yiyou\\.codex\\sessions\\old-unverified.jsonl",
                "status": { "type": "notLoaded" },
                "updatedAt": 1_742_000_000
            })],
            true,
        );

        let entry = map.get("old-unverified").expect("old unverified session");
        assert_eq!(entry.last_discovered_unix_ms, 1_742_000_000_000);
    }

    #[test]
    fn thread_index_not_loaded_item_survives_transient_fresh_snapshot_gap() {
        let now = 2_000_000_u64;
        let mut map = HashMap::new();

        merge_thread_index_session_hints(
            &mut map,
            now,
            &[serde_json::json!({
                "id": "session-index-gap",
                "workspace": "windows",
                "path": "C:\\Users\\yiyou\\.codex\\sessions\\rollout-session-index-gap.jsonl",
                "status": { "type": "notLoaded" },
                "updatedAt": 1742269999
            })],
            true,
        );

        assert!(
            map.is_empty(),
            "pure thread-index notLoaded main thread should not become a runtime session before retention runs",
        );
        let removed = retain_live_app_server_sessions(&mut map, now + 5_000, &[], true, &[], true);
        assert!(
            removed.is_empty(),
            "no runtime session should be synthesized for a historical notLoaded thread-index row",
        );
    }

    #[test]
    fn stale_snapshot_absence_does_not_drop_pidless_windows_session() {
        let now = 2_000_000_u64;
        let mut map = HashMap::from([(
            "desktop-stale-snapshot".to_string(),
            ClientSessionRuntime {
                codex_session_id: "desktop-stale-snapshot".to_string(),
                pid: 0,
                wt_session: None,
                last_request_unix_ms: now.saturating_sub(20 * 60 * 1000),
                last_discovered_unix_ms: now.saturating_sub(20 * 60 * 1000),
                last_reported_model_provider: Some("api_router".to_string()),
                last_reported_model: Some("gpt-5.4".to_string()),
                last_reported_base_url: Some("http://127.0.0.1:4000/v1".to_string()),
                rollout_path: Some(
                    "C:\\Users\\yiyou\\.codex\\sessions\\desktop-stale-snapshot.jsonl"
                        .to_string(),
                ),
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: true,
            },
        )]);

        let removed = retain_live_app_server_sessions(&mut map, now, &[], false, &[], false);

        assert!(
            removed.is_empty(),
            "stale app-server cache should not be treated as proof that a pidless desktop session ended",
        );
        assert!(
            map.contains_key("desktop-stale-snapshot"),
            "pidless desktop session should remain visible until a fresh snapshot confirms it disappeared",
        );
    }

    #[test]
    fn partial_snapshot_presence_keeps_pidless_main_session_visible() {
        let now = 2_000_000_u64;
        let mut map = HashMap::from([(
            "partial-fresh-thread".to_string(),
            ClientSessionRuntime {
                codex_session_id: "partial-fresh-thread".to_string(),
                pid: 0,
                wt_session: None,
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 0,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                rollout_path: Some(
                    "C:\\Users\\yiyou\\.codex\\sessions\\partial-fresh-thread.jsonl".to_string(),
                ),
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: false,
            },
        )]);

        let removed = retain_live_app_server_sessions(
            &mut map,
            now,
            &[],
            false,
            &[serde_json::json!({
                "id": "partial-fresh-thread",
                "workspace": "windows",
                "status": { "type": "notLoaded" }
            })],
            false,
        );

        assert!(
            removed.is_empty(),
            "a thread already present in the current partial app-server snapshot should not be dropped",
        );
        assert!(
            map.contains_key("partial-fresh-thread"),
            "partial snapshot presence should keep the pidless main session visible",
        );
    }

    #[test]
    fn fresh_wsl_snapshot_drops_pidless_session_without_recent_gateway_heartbeat() {
        let now = 2_000_000_u64;
        let entry = ClientSessionRuntime {
            codex_session_id: "wsl-missing".to_string(),
            pid: 0,
            wt_session: None,
            last_request_unix_ms: now.saturating_sub(61_000),
            last_discovered_unix_ms: now.saturating_sub(2_000),
            last_reported_model_provider: Some("api_router".to_string()),
            last_reported_model: Some("gpt-5.4".to_string()),
            last_reported_base_url: Some("http://172.26.144.1:4000/v1".to_string()),
            rollout_path: Some(
                "\\\\wsl.localhost\\Ubuntu\\home\\yiyou\\.codex\\sessions\\wsl-missing.jsonl"
                    .to_string(),
            ),
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, false, 0, true);
        assert!(
            !keep,
            "fresh WSL snapshots should hide pidless sessions once the real gateway heartbeat stops",
        );
    }

    #[test]
    fn fresh_wsl_snapshot_keeps_pidless_session_with_recent_gateway_heartbeat() {
        let now = 2_000_000_u64;
        let entry = ClientSessionRuntime {
            codex_session_id: "wsl-live".to_string(),
            pid: 0,
            wt_session: None,
            last_request_unix_ms: now.saturating_sub(20_000),
            last_discovered_unix_ms: now.saturating_sub(60_000),
            last_reported_model_provider: Some("api_router".to_string()),
            last_reported_model: Some("gpt-5.4".to_string()),
            last_reported_base_url: Some("http://172.26.144.1:4000/v1".to_string()),
            rollout_path: Some(
                "\\\\wsl.localhost\\Ubuntu\\home\\yiyou\\.codex\\sessions\\wsl-live.jsonl"
                    .to_string(),
            ),
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, false, 0, true);
        assert!(
            keep,
            "recent WSL gateway requests should act as the canonical live heartbeat when app-server loaded snapshots are empty",
        );
    }

    #[test]
    fn fresh_terminal_snapshot_drops_wsl_session_when_wt_is_absent() {
        let now = 2_000_000_u64;
        let mut map = HashMap::from([(
            "wsl-ended".to_string(),
            ClientSessionRuntime {
                codex_session_id: "wsl-ended".to_string(),
                pid: 0,
                wt_session: Some("wsl:ended-tab".to_string()),
                last_request_unix_ms: now.saturating_sub(5_000),
                last_discovered_unix_ms: now.saturating_sub(5_000),
                last_reported_model_provider: Some("api_router".to_string()),
                last_reported_model: Some("gpt-5.4".to_string()),
                last_reported_base_url: Some("http://172.26.144.1:4000/v1".to_string()),
                rollout_path: Some(
                    "\\\\wsl.localhost\\Ubuntu\\home\\yiyou\\.codex\\sessions\\wsl-ended.jsonl"
                        .to_string(),
                ),
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: true,
            },
        )]);

        let removed = retain_live_app_server_sessions(&mut map, now, &[], true, &[], true);

        assert_eq!(removed, vec!["wsl-ended".to_string()]);
        assert!(
            !map.contains_key("wsl-ended"),
            "fresh terminal discovery should hide WSL sessions as soon as their WT_SESSION disappears",
        );
    }

    #[test]
    fn fresh_terminal_snapshot_keeps_wsl_session_when_wt_is_still_present() {
        let now = 2_000_000_u64;
        let mut map = HashMap::from([(
            "wsl-live-terminal".to_string(),
            ClientSessionRuntime {
                codex_session_id: "wsl-live-terminal".to_string(),
                pid: 0,
                wt_session: Some("wsl:live-tab".to_string()),
                last_request_unix_ms: now.saturating_sub(90_000),
                last_discovered_unix_ms: now.saturating_sub(90_000),
                last_reported_model_provider: Some("api_router".to_string()),
                last_reported_model: Some("gpt-5.4".to_string()),
                last_reported_base_url: Some("http://172.26.144.1:4000/v1".to_string()),
                rollout_path: Some(
                    "\\\\wsl.localhost\\Ubuntu\\home\\yiyou\\.codex\\sessions\\wsl-live-terminal.jsonl"
                        .to_string(),
                ),
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: true,
            },
        )]);

        let terminal_items = vec![crate::platform::windows_terminal::InferredWtSession {
            wt_session: "wsl:live-tab".to_string(),
            pid: 0,
            linux_pid: Some(4242),
            wsl_distro: Some("Ubuntu".to_string()),
            cwd: None,
            rollout_path: None,
            codex_session_id: Some("wsl-live-terminal".to_string()),
            reported_model_provider: None,
            reported_base_url: None,
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            router_confirmed: false,
        }];

        let removed =
            retain_live_app_server_sessions(&mut map, now, &terminal_items, true, &[], true);

        assert!(removed.is_empty());
        assert!(
            map.contains_key("wsl-live-terminal"),
            "fresh terminal discovery should keep the WSL session while the same WT_SESSION is still present",
        );
    }

    #[test]
    fn fresh_terminal_snapshot_matches_wsl_session_even_without_wsl_prefix() {
        let now = 2_000_000_u64;
        let mut map = HashMap::from([(
            "wsl-live-terminal".to_string(),
            ClientSessionRuntime {
                codex_session_id: "wsl-live-terminal".to_string(),
                pid: 0,
                wt_session: Some("wsl:live-tab".to_string()),
                last_request_unix_ms: now.saturating_sub(90_000),
                last_discovered_unix_ms: now.saturating_sub(90_000),
                last_reported_model_provider: Some("api_router".to_string()),
                last_reported_model: Some("gpt-5.4".to_string()),
                last_reported_base_url: Some("http://172.26.144.1:4000/v1".to_string()),
                rollout_path: Some(
                    "\\\\wsl.localhost\\Ubuntu\\home\\yiyou\\.codex\\sessions\\wsl-live-terminal.jsonl"
                        .to_string(),
                ),
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: true,
            },
        )]);

        let terminal_items = vec![crate::platform::windows_terminal::InferredWtSession {
            wt_session: "live-tab".to_string(),
            pid: 0,
            linux_pid: Some(4242),
            wsl_distro: None,
            cwd: None,
            rollout_path: None,
            codex_session_id: None,
            reported_model_provider: None,
            reported_base_url: None,
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            router_confirmed: false,
        }];

        let removed =
            retain_live_app_server_sessions(&mut map, now, &terminal_items, true, &[], true);

        assert!(removed.is_empty());
        assert!(
            map.contains_key("wsl-live-terminal"),
            "wsl-prefixed runtime markers should still match unprefixed terminal snapshot ids",
        );
    }

    #[test]
    fn thread_index_not_loaded_item_no_longer_refreshes_runtime_session_to_now() {
        let now = 1_800_000_000_000_u64;
        let mut map = HashMap::from([(
            "session-index-requested".to_string(),
            ClientSessionRuntime {
                codex_session_id: "session-index-requested".to_string(),
                pid: 0,
                wt_session: None,
                last_request_unix_ms: now.saturating_sub(5 * 60 * 1000),
                last_discovered_unix_ms: now.saturating_sub(1_000),
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: Some("http://127.0.0.1:4000/v1".to_string()),
                rollout_path: Some(
                    "C:\\Users\\yiyou\\.codex\\sessions\\rollout-session-index-requested.jsonl"
                        .to_string(),
                ),
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: true,
            },
        )]);

        merge_thread_index_session_hints(
            &mut map,
            now,
            &[serde_json::json!({
                "id": "session-index-requested",
                "workspace": "wsl2",
                "path": "\\\\wsl.localhost\\Ubuntu\\home\\yiyou\\.codex\\sessions\\2026\\01\\28\\rollout-2026-01-28T17-44-26-session-index-requested.jsonl",
                "status": { "type": "notLoaded" },
                "updatedAt": (now.saturating_sub(5 * 60 * 1000)) / 1000
            })],
            true,
        );

        let entry = map
            .get("session-index-requested")
            .expect("requested session");
        assert_eq!(
            entry.last_discovered_unix_ms,
            now.saturating_sub(5 * 60 * 1000),
            "notLoaded rows should preserve the thread's own updatedAt instead of refreshing discovery to now",
        );
        assert!(
            !should_keep_runtime_session(entry, now, |_pid| true, |_wt| true, false, 0, true),
            "stale pidless runtime sessions should disappear once only historical notLoaded evidence remains",
        );
    }

    #[test]
    fn windows_path_with_home_segment_is_not_classified_as_wsl() {
        let now = 2_000_000_u64;
        let entry = ClientSessionRuntime {
            codex_session_id: "desktop-home-path".to_string(),
            pid: 0,
            wt_session: None,
            last_request_unix_ms: 0,
            last_discovered_unix_ms: now.saturating_sub(5_000),
            last_reported_model_provider: Some("api_router".to_string()),
            last_reported_model: Some("gpt-5.4".to_string()),
            last_reported_base_url: Some("http://127.0.0.1:4000/v1".to_string()),
            rollout_path: Some(
                "D:\\home\\user\\.codex\\sessions\\desktop-home-path.jsonl".to_string(),
            ),
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, false, 0, true);
        assert!(
            keep,
            "ordinary Windows paths containing \\\\home\\\\ should stay on the desktop retention path",
        );
    }

    #[test]
    fn pidless_main_session_keeps_when_present_in_app_server_snapshot() {
        let now = 2_000_000_u64;
        let entry = ClientSessionRuntime {
            codex_session_id: "desktop-not-loaded".to_string(),
            pid: 0,
            wt_session: None,
            last_request_unix_ms: now.saturating_sub(20 * 60 * 1000),
            last_discovered_unix_ms: 0,
            last_reported_model_provider: Some("api_router".to_string()),
            last_reported_model: Some("gpt-5.4".to_string()),
            last_reported_base_url: Some("http://127.0.0.1:4000/v1".to_string()),
            rollout_path: Some("C:\\Users\\yiyou\\.codex\\sessions\\desktop-not-loaded.jsonl".to_string()),
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, true, 0, true);
        assert!(keep, "main session should stay visible while app server still reports the thread");
    }

    #[test]
    fn pidless_agent_drops_when_absent_from_fresh_live_sources() {
        let now = 2_000_000_u64;
        let entry = ClientSessionRuntime {
            codex_session_id: "agent-missing".to_string(),
            pid: 0,
            wt_session: None,
            last_request_unix_ms: now.saturating_sub(61_000),
            last_discovered_unix_ms: now.saturating_sub(30_000),
            last_reported_model_provider: Some("api_router".to_string()),
            last_reported_model: Some("gpt-5.4-mini".to_string()),
            last_reported_base_url: None,
            rollout_path: Some("C:\\Users\\yiyou\\.codex\\sessions\\agent-missing.jsonl".to_string()),
            agent_parent_session_id: Some("main-thread".to_string()),
            is_agent: true,
            is_review: false,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, false, 0, true);
        assert!(
            !keep,
            "fresh snapshots should drop pidless agents once they no longer have app-server or terminal live evidence",
        );
    }

    #[test]
    fn pidless_main_session_drops_when_absent_from_fresh_app_server_snapshot_and_stale() {
        let now = 2_000_000_u64;
        let entry = ClientSessionRuntime {
            codex_session_id: "desktop-missing".to_string(),
            pid: 0,
            wt_session: None,
            last_request_unix_ms: now.saturating_sub(20 * 60 * 1000),
            last_discovered_unix_ms: 0,
            last_reported_model_provider: Some("api_router".to_string()),
            last_reported_model: Some("gpt-5.4".to_string()),
            last_reported_base_url: Some("http://127.0.0.1:4000/v1".to_string()),
            rollout_path: Some("C:\\Users\\yiyou\\.codex\\sessions\\desktop-missing.jsonl".to_string()),
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, false, 0, true);
        assert!(!keep, "fresh app-server miss should eventually hide stale pidless main sessions");
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
