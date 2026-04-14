use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::net::SocketAddr;
use std::sync::OnceLock;

#[cfg(windows)]
const TAILSCALE_CREATE_NO_WINDOW: u32 = 0x08000000;

const TAILSCALE_DIAGNOSTIC_CACHE_TTL_MS: u64 = 5_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TailscaleBootstrapSummary {
    pub last_stage: Option<String>,
    pub last_detail: Option<String>,
    pub updated_at_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TailscaleDiagnosticSnapshot {
    pub installed: bool,
    pub connected: bool,
    pub backend_state: Option<String>,
    pub dns_name: Option<String>,
    pub ipv4: Vec<String>,
    pub reachable_ipv4: Vec<String>,
    pub gateway_reachable: bool,
    pub needs_gateway_restart: bool,
    pub status_error: Option<String>,
    pub bootstrap: Option<TailscaleBootstrapSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TailscaleBaseStatus {
    installed: bool,
    connected: bool,
    backend_state: Option<String>,
    dns_name: Option<String>,
    ipv4: Vec<String>,
    status_error: Option<String>,
}

fn tailscale_hidden_command(program: &str) -> std::process::Command {
    #[cfg(windows)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(not(windows))]
    let cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        std::os::windows::process::CommandExt::creation_flags(&mut cmd, TAILSCALE_CREATE_NO_WINDOW);
    }
    cmd
}

fn parse_tailscale_summary(parsed: &Value) -> TailscaleBaseStatus {
    let backend_state = parsed
        .get("BackendState")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let connected = backend_state
        .as_deref()
        .is_some_and(|state| matches!(state, "Running" | "Starting"));

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

    TailscaleBaseStatus {
        installed: true,
        connected,
        backend_state,
        dns_name: if dns_name.is_empty() {
            None
        } else {
            Some(dns_name)
        },
        ipv4,
        status_error: None,
    }
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

fn read_gateway_bootstrap_summary() -> Option<TailscaleBootstrapSummary> {
    let path = crate::diagnostics::current_user_data_dir()?.join("gateway-bootstrap.json");
    let bytes = std::fs::read(path).ok()?;
    let parsed = serde_json::from_slice::<Value>(&bytes).ok()?;
    let stages = parsed.get("stages").and_then(|v| v.as_array())?;
    let last = stages.last()?;
    Some(TailscaleBootstrapSummary {
        last_stage: last
            .get("stage")
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        last_detail: last
            .get("detail")
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        updated_at_unix_ms: parsed.get("updatedAtUnixMs").and_then(|v| v.as_u64()),
    })
}

fn current_tailscale_base_status_uncached() -> TailscaleBaseStatus {
    match tailscale_status_json() {
        Ok(parsed) => parse_tailscale_summary(&parsed),
        Err(err) => TailscaleBaseStatus {
            installed: err != "tailscale_not_found",
            connected: false,
            backend_state: None,
            dns_name: None,
            ipv4: Vec::new(),
            status_error: Some(err),
        },
    }
}

fn probe_gateway_addr(addr: SocketAddr) -> bool {
    std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(180)).is_ok()
}

fn resolve_reachable_gateway_ipv4(ipv4: &[String], listen_port: u16) -> Vec<String> {
    ipv4.iter()
        .filter_map(|ip| {
            let parsed_ip = ip.parse().ok()?;
            let addr = SocketAddr::new(parsed_ip, listen_port);
            probe_gateway_addr(addr).then(|| ip.clone())
        })
        .collect()
}

fn current_tailscale_base_status() -> TailscaleBaseStatus {
    static CACHE: OnceLock<RwLock<Option<(u64, TailscaleBaseStatus)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| RwLock::new(None));
    let now = crate::orchestrator::store::unix_ms();
    if let Some((captured_at, snapshot)) = cache.read().clone() {
        if now.saturating_sub(captured_at) < TAILSCALE_DIAGNOSTIC_CACHE_TTL_MS {
            return snapshot;
        }
    }
    let snapshot = current_tailscale_base_status_uncached();
    *cache.write() = Some((now, snapshot.clone()));
    snapshot
}

pub(crate) fn current_tailscale_diagnostic_snapshot(
    listen_port: u16,
) -> TailscaleDiagnosticSnapshot {
    static CACHE: OnceLock<RwLock<Option<(u64, TailscaleDiagnosticSnapshot)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| RwLock::new(None));
    let now = crate::orchestrator::store::unix_ms();
    if let Some((captured_at, snapshot)) = cache.read().clone() {
        if now.saturating_sub(captured_at) < TAILSCALE_DIAGNOSTIC_CACHE_TTL_MS {
            return snapshot;
        }
    }
    let snapshot = current_tailscale_diagnostic_snapshot_uncached(listen_port);
    *cache.write() = Some((now, snapshot.clone()));
    snapshot
}

pub(crate) fn current_tailscale_diagnostic_snapshot_uncached(
    listen_port: u16,
) -> TailscaleDiagnosticSnapshot {
    let base = current_tailscale_base_status();
    let reachable_ipv4 = if base.connected {
        resolve_reachable_gateway_ipv4(&base.ipv4, listen_port)
    } else {
        Vec::new()
    };
    let gateway_reachable = !reachable_ipv4.is_empty();
    TailscaleDiagnosticSnapshot {
        installed: base.installed,
        connected: base.connected,
        backend_state: base.backend_state,
        dns_name: base.dns_name,
        ipv4: base.ipv4.clone(),
        reachable_ipv4,
        gateway_reachable,
        needs_gateway_restart: base.connected && !base.ipv4.is_empty() && !gateway_reachable,
        status_error: base.status_error,
        bootstrap: read_gateway_bootstrap_summary(),
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_tailscale_summary, read_gateway_bootstrap_summary, TailscaleBaseStatus};

    #[test]
    fn parse_tailscale_summary_reads_backend_dns_and_ipv4() {
        let parsed = serde_json::json!({
            "BackendState": "Running",
            "Self": {
                "DNSName": "desktop-kk6sa2d-1.tail997985.ts.net.",
                "TailscaleIPs": ["100.64.208.117", "fd7a:115c:a1e0::201:d089"]
            }
        });
        let summary = parse_tailscale_summary(&parsed);
        assert_eq!(
            summary,
            TailscaleBaseStatus {
                installed: true,
                connected: true,
                backend_state: Some("Running".to_string()),
                dns_name: Some("desktop-kk6sa2d-1.tail997985.ts.net".to_string()),
                ipv4: vec!["100.64.208.117".to_string()],
                status_error: None,
            }
        );
    }

    #[test]
    fn gateway_bootstrap_summary_reads_last_stage() {
        let temp = tempfile::tempdir().expect("temp dir");
        let previous = crate::diagnostics::set_test_user_data_dir_override(Some(temp.path()));
        std::fs::write(
            temp.path().join("gateway-bootstrap.json"),
            serde_json::to_vec(&serde_json::json!({
                "stages": [
                    { "stage": "a", "detail": null, "updatedAtUnixMs": 1 },
                    { "stage": "tailscale_ipv4_detect_ok", "detail": "count=1", "updatedAtUnixMs": 2 }
                ],
                "updatedAtUnixMs": 99
            }))
            .expect("json"),
        )
        .expect("write bootstrap");

        let summary = read_gateway_bootstrap_summary().expect("bootstrap summary");
        assert_eq!(
            summary.last_stage.as_deref(),
            Some("tailscale_ipv4_detect_ok")
        );
        assert_eq!(summary.last_detail.as_deref(), Some("count=1"));
        assert_eq!(summary.updated_at_unix_ms, Some(99));
        crate::diagnostics::set_test_user_data_dir_override(previous.as_deref());
    }

    #[test]
    fn gateway_bootstrap_summary_uses_thread_local_test_override() {
        let temp = tempfile::tempdir().expect("temp dir");
        let previous = crate::diagnostics::set_test_user_data_dir_override(Some(temp.path()));
        std::fs::write(
            temp.path().join("gateway-bootstrap.json"),
            serde_json::to_vec(&serde_json::json!({
                "stages": [
                    { "stage": "tailscale_ok", "detail": "ready", "updatedAtUnixMs": 7 }
                ],
                "updatedAtUnixMs": 7
            }))
            .expect("json"),
        )
        .expect("write bootstrap");

        let summary = read_gateway_bootstrap_summary().expect("bootstrap summary");
        assert_eq!(summary.last_stage.as_deref(), Some("tailscale_ok"));
        assert_eq!(summary.last_detail.as_deref(), Some("ready"));
        crate::diagnostics::set_test_user_data_dir_override(previous.as_deref());
    }
}
