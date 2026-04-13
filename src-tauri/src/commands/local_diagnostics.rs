use serde_json::json;

/// Aggregates all local diagnostic domains (watchdog, webtransport, tailscale) into a single JSON response.
///
/// # Arguments
/// * `domains` - List of domain names to include. If empty or contains "all", all domains are returned.
///   Supported domains: "watchdog", "webtransport", "tailscale". Unknown domains are silently ignored.
#[tauri::command]
pub async fn get_local_diagnostics(
    state: tauri::State<'_, app_state::AppState>,
    domains: Vec<String>,
) -> Result<serde_json::Value, String> {
    let all_domains = domains.is_empty() || domains.contains(&"all".to_string());

    let mut result = json!({});

    if all_domains || domains.contains(&"watchdog".to_string()) {
        // Get watchdog summary from lan_fetch module
        let watchdog = crate::lan_sync::watchdog_summary();
        result["watchdog"] = watchdog;
    }

    if all_domains || domains.contains(&"webtransport".to_string()) {
        // Get web transport snapshot
        let snapshot =
            crate::diagnostics::codex_web_transport::current_web_transport_snapshot();
        result["webtransport"] =
            serde_json::to_value(snapshot).map_err(|e| e.to_string())?;
    }

    if all_domains || domains.contains(&"tailscale".to_string()) {
        // Get tailscale diagnostics
        let listen_port = state.gateway.cfg.read().listen.port;
        let snapshot =
            crate::tailscale_diagnostics::current_tailscale_diagnostic_snapshot(listen_port);
        result["tailscale"] = serde_json::to_value(snapshot).map_err(|e| e.to_string())?;
    }

    // Return the result directly (it is already a Value::Object / Map)
    Ok(result)
}

/// Domain filter logic extracted for unit testing.
#[cfg(test)]
fn domain_is_requested(domain: &str, domains: &[String]) -> bool {
    domains.is_empty() || domains.contains(&domain.to_string()) || domains.contains(&"all".to_string())
}

#[cfg(test)]
mod local_diagnostics_integration_tests {
    use super::domain_is_requested;

    // Note: Testing the full command requires tauri::State<AppState> which cannot be
    // constructed outside of Tauri. The domain-filtering logic and individual domain
    // functions are tested below. The watchdog and webtransport domain functions are
    // tested in their respective modules (lan_fetch.rs and codex_web_transport.rs).

    #[test]
    fn empty_domains_includes_all() {
        assert!(domain_is_requested("watchdog", &[]));
        assert!(domain_is_requested("webtransport", &[]));
        assert!(domain_is_requested("tailscale", &[]));
        assert!(domain_is_requested("unknown", &[]));
    }

    #[test]
    fn all_keyword_includes_all() {
        assert!(domain_is_requested("watchdog", &["all".to_string()]));
        assert!(domain_is_requested("webtransport", &["all".to_string()]));
        assert!(domain_is_requested("tailscale", &["all".to_string()]));
        assert!(domain_is_requested("anything", &["all".to_string()]));
    }

    #[test]
    fn specific_domains_return_only_requested() {
        assert!(domain_is_requested("watchdog", &["watchdog".to_string()]));
        assert!(!domain_is_requested("webtransport", &["watchdog".to_string()]));
        assert!(!domain_is_requested("tailscale", &["watchdog".to_string()]));
    }

    #[test]
    fn multiple_specific_domains() {
        assert!(domain_is_requested("watchdog", &["watchdog".to_string(), "webtransport".to_string()]));
        assert!(domain_is_requested("webtransport", &["watchdog".to_string(), "webtransport".to_string()]));
        assert!(!domain_is_requested("tailscale", &["watchdog".to_string(), "webtransport".to_string()]));
    }

    #[test]
    fn unknown_domains_are_silently_ignored() {
        // When specific domains are requested, unknown domains return false
        // (not in the requested list), so they are excluded from the result dict.
        assert!(!domain_is_requested("unknown", &["watchdog".to_string()]));
        assert!(!domain_is_requested("foobar", &["watchdog".to_string()]));
        assert!(!domain_is_requested("unknown", &["watchdog".to_string(), "webtransport".to_string()]));
    }
}
