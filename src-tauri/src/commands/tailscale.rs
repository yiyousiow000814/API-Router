#[cfg(windows)]
use std::net::IpAddr;
#[cfg(test)]
use std::net::SocketAddr;

#[cfg(test)]
fn resolve_reachable_gateway_ipv4(
    ipv4: &[String],
    listen_port: u16,
    probe: impl Fn(SocketAddr) -> bool,
) -> Vec<String> {
    ipv4.iter()
        .filter_map(|ip| {
            let parsed_ip = ip.parse().ok()?;
            let addr = SocketAddr::new(parsed_ip, listen_port);
            probe(addr).then(|| ip.clone())
        })
        .collect()
}

#[cfg(windows)]
fn parse_tailscale_ipv4_addrs(ipv4: &[String]) -> Vec<IpAddr> {
    ipv4.iter()
        .filter_map(|ip| ip.parse::<IpAddr>().ok())
        .collect()
}

#[cfg(windows)]
fn maybe_refresh_runtime_tailscale_listener(
    state: &crate::app_state::AppState,
    connected: bool,
    ipv4: &[String],
    gateway_reachable: bool,
) -> usize {
    if !connected || ipv4.is_empty() || gateway_reachable {
        return 0;
    }
    let listen = state.gateway.cfg.read().listen.clone();
    let parsed_ips = parse_tailscale_ipv4_addrs(ipv4);
    let Ok(addrs) = crate::orchestrator::gateway_bootstrap::tailscale_overlay_listener_addrs(
        &listen.host,
        listen.port,
        &parsed_ips,
    ) else {
        return 0;
    };
    crate::orchestrator::gateway::ensure_runtime_gateway_listener_bindings(
        state.gateway.clone(),
        &addrs,
    )
    .map(|newly_bound| newly_bound.len())
    .unwrap_or(0)
}

fn needs_gateway_restart(
    connected: bool,
    ipv4: &[String],
    gateway_reachable: bool,
    runtime_binding_in_progress: bool,
) -> bool {
    connected && !ipv4.is_empty() && !gateway_reachable && !runtime_binding_in_progress
}

#[tauri::command]
pub(crate) async fn tailscale_status(
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<Value, String> {
    let listen_port = state.gateway.cfg.read().listen.port;
    // Wrap blocking I/O (CLI call + TCP probes) in spawn_blocking to avoid blocking tokio
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        crate::tailscale_diagnostics::current_tailscale_diagnostic_snapshot(listen_port)
    })
    .await
    .map_err(|err| format!("tailscale_snapshot_failed: {err}"))?;
    let connected = snapshot.connected;
    let ipv4 = snapshot.ipv4.clone();
    let dns_name = snapshot.dns_name.clone();
    let reachable_ipv4 = snapshot.reachable_ipv4.clone();
    #[cfg(windows)]
    let runtime_binding_in_progress = {
        maybe_refresh_runtime_tailscale_listener(
            &state,
            connected,
            &ipv4,
            snapshot.gateway_reachable,
        ) > 0
    };
    #[cfg(not(windows))]
    let runtime_binding_in_progress = false;
    let gateway_reachable = snapshot.gateway_reachable;
    let needs_gateway_restart = needs_gateway_restart(
        connected,
        &ipv4,
        gateway_reachable,
        runtime_binding_in_progress,
    );

    Ok(serde_json::json!({
        "ok": true,
        "installed": snapshot.installed,
        "connected": connected,
        "backendState": snapshot.backend_state,
        "dnsName": dns_name.map(Value::String).unwrap_or(Value::Null),
        "ipv4": ipv4,
        "reachableIpv4": reachable_ipv4,
        "gatewayReachable": gateway_reachable,
        "needsGatewayRestart": needs_gateway_restart,
        "statusError": snapshot.status_error,
        "bootstrap": snapshot.bootstrap,
        "downloadUrl": "https://download.tailscale.com",
    }))
}

#[cfg(test)]
#[test]
fn reachable_gateway_ipv4_only_keeps_probeable_addrs() {
    let reachable = resolve_reachable_gateway_ipv4(
        &["100.64.208.117".to_string(), "100.88.1.9".to_string()],
        4000,
        |addr: SocketAddr| addr.ip().to_string() == "100.64.208.117" && addr.port() == 4000,
    );

    assert_eq!(reachable, vec!["100.64.208.117"]);
}

#[cfg(test)]
#[test]
fn restart_hint_waits_for_next_poll_after_runtime_bind_progress() {
    assert!(!needs_gateway_restart(
        true,
        &["100.64.208.117".to_string()],
        false,
        true,
    ));
}

#[cfg(test)]
#[test]
fn restart_hint_remains_when_gateway_is_still_unreachable_without_new_binding_progress() {
    assert!(needs_gateway_restart(
        true,
        &["100.64.208.117".to_string()],
        false,
        false,
    ));
}

#[cfg(all(test, windows))]
#[test]
fn parse_tailscale_ipv4_addrs_skips_invalid_rows() {
    let parsed = parse_tailscale_ipv4_addrs(&[
        "100.64.208.117".to_string(),
        "not-an-ip".to_string(),
        "100.118.0.115".to_string(),
    ]);
    let rendered = parsed.iter().map(ToString::to_string).collect::<Vec<_>>();
    assert_eq!(rendered, vec!["100.64.208.117", "100.118.0.115"]);
}
