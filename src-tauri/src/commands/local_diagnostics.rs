/// Aggregates all local diagnostic domains (watchdog, webtransport, tailscale) into a single JSON response.
///
/// # Arguments
/// * `domains` - List of domain names to include. If empty or contains "all", all domains are returned.
///   Supported domains: "watchdog", "webtransport", "tailscale". Unknown domains are silently ignored.
#[tauri::command]
pub(crate) async fn get_local_diagnostics(
    state: tauri::State<'_, app_state::AppState>,
    domains: Vec<String>,
) -> Result<serde_json::Value, String> {
    let listen_port = state.gateway.cfg.read().listen.port;
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        crate::lan_sync::local_diagnostics_snapshot(listen_port, &domains)
    })
    .await
    .map_err(|err| format!("local_diagnostics_snapshot_failed: {err}"))?;
    Ok(snapshot)
}

#[cfg(test)]
mod local_diagnostics_integration_tests {
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
}
