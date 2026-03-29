#[cfg(windows)]
const TAILSCALE_CREATE_NO_WINDOW: u32 = 0x08000000;

use std::net::{SocketAddr, TcpStream};

fn tailscale_hidden_command(program: &str) -> std::process::Command {
    #[cfg(windows)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(not(windows))]
    let cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        std::os::windows::process::CommandExt::creation_flags(
            &mut cmd,
            TAILSCALE_CREATE_NO_WINDOW,
        );
    }
    cmd
}

fn tailscale_status_json() -> Result<Value, String> {
    let output = tailscale_hidden_command("tailscale")
        .args(["status", "--json"])
        .output()
        .map_err(|_| "tailscale_not_found".to_string())?;
    if !output.status.success() {
        return Err("tailscale_not_connected".to_string());
    }
    serde_json::from_slice(&output.stdout).map_err(|_| "tailscale_bad_json".to_string())
}

fn parse_tailscale_summary(parsed: &Value) -> (bool, Option<String>, Vec<String>) {
    let backend_state = parsed
        .get("BackendState")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let connected = matches!(backend_state, "Running" | "Starting");

    let self_info = parsed.get("Self").cloned().unwrap_or(Value::Null);
    let dns_name = self_info
        .get("DNSName")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .trim_end_matches('.')
        .to_string();

    let mut ipv4 = Vec::new();
    if let Some(arr) = self_info.get("TailscaleIPs").and_then(|v| v.as_array()) {
        for item in arr {
            if let Some(ip) = item.as_str() {
                if ip.contains('.') {
                    ipv4.push(ip.to_string());
                }
            }
        }
    }

    (
        connected,
        if dns_name.is_empty() { None } else { Some(dns_name) },
        ipv4,
    )
}

fn probe_gateway_addr(addr: SocketAddr) -> bool {
    TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(180)).is_ok()
}

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

#[tauri::command]
pub(crate) async fn tailscale_status(
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<Value, String> {
    let parsed = tailscale_status_json();
    let Ok(parsed) = parsed else {
        let err = parsed.err().unwrap_or_default();
        return Ok(serde_json::json!({
            "ok": true,
            "installed": err != "tailscale_not_found",
            "connected": false,
            "dnsName": Value::Null,
            "ipv4": [],
            "reachableIpv4": [],
            "gatewayReachable": false,
            "needsGatewayRestart": false,
            "downloadUrl": "https://tailscale.com/download",
        }));
    };
    let (connected, dns_name, ipv4) = parse_tailscale_summary(&parsed);
    let listen_port = state.gateway.cfg.read().listen.port;
    let reachable_ipv4 = if connected {
        resolve_reachable_gateway_ipv4(&ipv4, listen_port, probe_gateway_addr)
    } else {
        Vec::new()
    };
    let gateway_reachable = !reachable_ipv4.is_empty();
    let needs_gateway_restart = connected && !ipv4.is_empty() && !gateway_reachable;

    Ok(serde_json::json!({
        "ok": true,
        "installed": true,
        "connected": connected,
        "dnsName": dns_name.map(Value::String).unwrap_or(Value::Null),
        "ipv4": ipv4,
        "reachableIpv4": reachable_ipv4,
        "gatewayReachable": gateway_reachable,
        "needsGatewayRestart": needs_gateway_restart,
        "downloadUrl": "https://tailscale.com/download",
    }))
}

#[cfg(test)]
#[test]
fn parses_connected_tailscale_ipv4_summary() {
    let parsed = serde_json::json!({
        "BackendState": "Running",
        "Self": {
            "DNSName": "desktop-kk6sa2d-1.tail997985.ts.net.",
            "TailscaleIPs": ["100.64.208.117", "fd7a:115c:a1e0::201:d089"]
        }
    });
    let (connected, dns_name, ipv4) = parse_tailscale_summary(&parsed);
    assert!(connected);
    assert_eq!(dns_name.as_deref(), Some("desktop-kk6sa2d-1.tail997985.ts.net"));
    assert_eq!(ipv4, vec!["100.64.208.117"]);
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
