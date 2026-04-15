/// Aggregates all local diagnostic domains (watchdog, webtransport, tailscale) into a single JSON response.
///
/// # Arguments
/// * `domains` - List of domain names to include. If empty or contains "all", all domains are returned.
///   Supported domains: "watchdog", "webtransport", "tailscale". Unknown domains are silently ignored.
fn merge_live_watchdog_state(
    snapshot: &mut serde_json::Value,
    live_watchdog: &crate::app_state::UiWatchdogLiveSnapshot,
) {
    let Some(domains) = snapshot.as_object_mut() else {
        return;
    };
    let Some(watchdog) = domains
        .get_mut("watchdog")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };
    watchdog.insert(
        "live_frontend".to_string(),
        serde_json::to_value(&live_watchdog.frontend).unwrap_or(serde_json::Value::Null),
    );
    watchdog.insert(
        "live_backend_status".to_string(),
        serde_json::to_value(&live_watchdog.backend_status).unwrap_or(serde_json::Value::Null),
    );
}

#[tauri::command]
pub(crate) async fn get_local_diagnostics(
    state: tauri::State<'_, crate::app_state::AppState>,
    domains: Vec<String>,
) -> Result<serde_json::Value, String> {
    let listen_port = state.gateway.cfg.read().listen.port;
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        crate::lan_sync::local_diagnostics_snapshot(listen_port, &domains)
    })
    .await
    .map_err(|err| format!("local_diagnostics_snapshot_failed: {err}"))?;
    let mut snapshot = snapshot;
    let live_watchdog = state
        .ui_watchdog
        .live_snapshot(crate::orchestrator::store::unix_ms());
    merge_live_watchdog_state(&mut snapshot, &live_watchdog);
    Ok(snapshot)
}

#[cfg(test)]
mod local_diagnostics_integration_tests {
    use super::merge_live_watchdog_state;
    use crate::app_state::{
        UiWatchdogBackendStatusSnapshot, UiWatchdogFrontendSnapshot, UiWatchdogLiveSnapshot,
    };
    use crate::lan_sync::local_diagnostics_snapshot;

    #[test]
    fn local_diagnostics_snapshot_includes_requested_domains() {
        let snapshot = local_diagnostics_snapshot(
            4000,
            &["watchdog".to_string(), "webtransport".to_string(), "tailscale".to_string()],
        );

        let domains = snapshot.as_object().expect("snapshot object");
        assert!(domains.contains_key("watchdog"));
        assert!(domains.contains_key("webtransport"));
        assert!(domains.contains_key("tailscale"));
    }

    #[test]
    fn merge_live_watchdog_state_adds_frontend_and_backend_status() {
        let mut snapshot = serde_json::json!({
            "watchdog": {
                "healthy": true,
            }
        });
        let live_snapshot = UiWatchdogLiveSnapshot {
            frontend: UiWatchdogFrontendSnapshot {
                last_heartbeat_unix_ms: 10,
                heartbeat_age_ms: 20,
                active_page: "dashboard".to_string(),
                visible: true,
                status_in_flight: true,
                config_in_flight: false,
                provider_switch_in_flight: false,
                stalled: false,
            },
            backend_status: UiWatchdogBackendStatusSnapshot {
                in_flight: true,
                detail_level: Some("dashboard".to_string()),
                started_unix_ms: Some(30),
                last_progress_unix_ms: Some(40),
                last_finished_unix_ms: Some(50),
                phase: Some("client_sessions".to_string()),
                progress_age_ms: Some(60),
                stalled: true,
            },
        };

        merge_live_watchdog_state(&mut snapshot, &live_snapshot);

        let watchdog = snapshot
            .get("watchdog")
            .and_then(serde_json::Value::as_object)
            .expect("watchdog object");
        assert_eq!(
            watchdog
                .get("live_frontend")
                .and_then(|value| value.get("active_page"))
                .and_then(serde_json::Value::as_str),
            Some("dashboard")
        );
        assert_eq!(
            watchdog
                .get("live_backend_status")
                .and_then(|value| value.get("phase"))
                .and_then(serde_json::Value::as_str),
            Some("client_sessions")
        );
        assert_eq!(
            watchdog
                .get("live_backend_status")
                .and_then(|value| value.get("stalled"))
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
    }
}
