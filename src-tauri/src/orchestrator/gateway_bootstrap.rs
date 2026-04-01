use std::io::ErrorKind;
#[cfg(windows)]
use std::net::IpAddr;
use std::net::SocketAddr;
#[cfg(windows)]
use std::process::Command;

use serde_json::json;

pub(crate) struct PreparedGatewayListeners {
    pub(crate) listen_port: u16,
    pub(crate) listeners: Vec<(SocketAddr, std::net::TcpListener)>,
}

#[cfg(windows)]
fn push_unique_addr(addrs: &mut Vec<SocketAddr>, addr: SocketAddr) {
    if !addrs.contains(&addr) {
        addrs.push(addr);
    }
}

#[cfg(windows)]
fn gateway_listen_addrs_with_overlays(
    listen_host: &str,
    listen_port: u16,
    wsl_host: &str,
    lan_ip: Option<IpAddr>,
    extra_ips: &[IpAddr],
) -> anyhow::Result<Vec<SocketAddr>> {
    let primary: SocketAddr = format!("{listen_host}:{listen_port}").parse()?;
    let mut addrs = vec![primary];

    let primary_ip = primary.ip().to_string();
    if primary_ip == crate::constants::GATEWAY_WINDOWS_HOST {
        let parsed_wsl_ip: std::net::IpAddr = wsl_host.parse()?;
        if parsed_wsl_ip != primary.ip() {
            push_unique_addr(&mut addrs, SocketAddr::new(parsed_wsl_ip, listen_port));
        }
        if let Some(lan_ip) = lan_ip {
            if lan_ip != primary.ip() {
                push_unique_addr(&mut addrs, SocketAddr::new(lan_ip, listen_port));
            }
        }
        for extra_ip in extra_ips {
            if *extra_ip != primary.ip() {
                push_unique_addr(&mut addrs, SocketAddr::new(*extra_ip, listen_port));
            }
        }
    }

    Ok(addrs)
}

#[cfg(windows)]
fn tailscale_hidden_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x08000000);
    cmd
}

fn write_gateway_bootstrap_diag(stage: &str, detail: Option<&str>) {
    let Some(user_data_dir) = std::env::var("API_ROUTER_USER_DATA_DIR").ok() else {
        return;
    };
    let trimmed = user_data_dir.trim();
    if trimmed.is_empty() {
        return;
    }
    let path = std::path::PathBuf::from(trimmed).join("gateway-bootstrap.json");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut payload = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .unwrap_or_else(|| serde_json::json!({ "stages": [] }));
    let entry = serde_json::json!({
        "stage": stage,
        "detail": detail,
        "updatedAtUnixMs": crate::orchestrator::store::unix_ms(),
    });
    if let Some(stages) = payload
        .get_mut("stages")
        .and_then(|value| value.as_array_mut())
    {
        stages.push(entry);
    } else {
        payload["stages"] = serde_json::json!([entry]);
    }
    payload["updatedAtUnixMs"] = serde_json::json!(crate::orchestrator::store::unix_ms());
    let _ = std::fs::write(
        path,
        serde_json::to_vec_pretty(&payload).unwrap_or_default(),
    );
}

#[cfg(windows)]
fn detected_tailscale_ipv4_addrs() -> Vec<IpAddr> {
    write_gateway_bootstrap_diag("tailscale_ipv4_detect_start", None);
    let output = tailscale_hidden_command("tailscale")
        .args(["ip", "-4"])
        .output();
    let Ok(output) = output else {
        write_gateway_bootstrap_diag("tailscale_ipv4_detect_unavailable", None);
        return Vec::new();
    };
    if !output.status.success() {
        write_gateway_bootstrap_diag(
            "tailscale_ipv4_detect_failed",
            Some(&format!("status={}", output.status)),
        );
        return Vec::new();
    }

    let addrs = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter_map(|line| line.parse::<IpAddr>().ok())
        .collect::<Vec<_>>();
    write_gateway_bootstrap_diag(
        "tailscale_ipv4_detect_ok",
        Some(&format!("count={}", addrs.len())),
    );
    addrs
}

#[cfg(not(windows))]
fn gateway_listen_addrs_with_overlays(
    listen_host: &str,
    listen_port: u16,
) -> anyhow::Result<Vec<SocketAddr>> {
    let primary: SocketAddr = format!("{listen_host}:{listen_port}").parse()?;
    Ok(vec![primary])
}

fn gateway_listen_addrs(listen_host: &str, listen_port: u16) -> anyhow::Result<Vec<SocketAddr>> {
    write_gateway_bootstrap_diag(
        "gateway_listen_addrs_start",
        Some(&format!("host={listen_host} port={listen_port}")),
    );
    #[cfg(windows)]
    {
        let wsl_host = crate::platform::wsl_gateway_host::cached_or_default_wsl_gateway_host(None);
        let lan_ip = crate::lan_sync::detect_local_listen_ip();
        // Keep startup cheap, but still bind the current Tailscale IPv4 overlay when it is already
        // available so Web Codex QR access works immediately without a manual restart.
        let extra_ips = detected_tailscale_ipv4_addrs();
        let addrs = gateway_listen_addrs_with_overlays(
            listen_host,
            listen_port,
            &wsl_host,
            lan_ip,
            &extra_ips,
        )?;
        write_gateway_bootstrap_diag(
            "gateway_listen_addrs_ok",
            Some(
                &addrs
                    .iter()
                    .map(|addr| addr.to_string())
                    .collect::<Vec<_>>()
                    .join(", "),
            ),
        );
        Ok(addrs)
    }
    #[cfg(not(windows))]
    {
        let addrs = gateway_listen_addrs_with_overlays(listen_host, listen_port)?;
        write_gateway_bootstrap_diag(
            "gateway_listen_addrs_ok",
            Some(
                &addrs
                    .iter()
                    .map(|addr| addr.to_string())
                    .collect::<Vec<_>>()
                    .join(", "),
            ),
        );
        Ok(addrs)
    }
}

fn persist_gateway_runtime_port(
    state: &crate::app_state::AppState,
    next_port: u16,
) -> anyhow::Result<()> {
    let cfg_to_write = {
        let mut cfg = state.gateway.cfg.write();
        if cfg.listen.port == next_port {
            return Ok(());
        }
        cfg.listen.port = next_port;
        cfg.clone()
    };
    std::fs::write(&state.config_path, toml::to_string_pretty(&cfg_to_write)?)?;
    state.gateway.store.add_event(
        "gateway",
        "warning",
        "gateway.listen_port_reassigned",
        &format!("Gateway listen port reassigned to {next_port} because the configured port was unavailable."),
        json!({ "listen_port": next_port }),
    );
    Ok(())
}

fn try_bind_gateway_listeners(
    listen_host: &str,
    listen_port: u16,
) -> anyhow::Result<Vec<(SocketAddr, std::net::TcpListener)>> {
    write_gateway_bootstrap_diag(
        "try_bind_gateway_listeners_start",
        Some(&format!("host={listen_host} port={listen_port}")),
    );
    let addrs = gateway_listen_addrs(listen_host, listen_port)?;
    let mut listeners = Vec::with_capacity(addrs.len());
    for addr in addrs {
        let listener = std::net::TcpListener::bind(addr)?;
        listener.set_nonblocking(true)?;
        listeners.push((addr, listener));
    }
    write_gateway_bootstrap_diag(
        "try_bind_gateway_listeners_ok",
        Some(
            &listeners
                .iter()
                .map(|(addr, _)| addr.to_string())
                .collect::<Vec<_>>()
                .join(", "),
        ),
    );
    Ok(listeners)
}

fn bind_fallback_gateway_listeners(
    listen_host: &str,
) -> anyhow::Result<Vec<(SocketAddr, std::net::TcpListener)>> {
    const MAX_ATTEMPTS: usize = 32;
    for _ in 0..MAX_ATTEMPTS {
        let primary = std::net::TcpListener::bind(format!("{listen_host}:0"))?;
        let primary_addr = primary.local_addr()?;
        primary.set_nonblocking(true)?;
        let addrs = gateway_listen_addrs(listen_host, primary_addr.port())?;
        let mut listeners = vec![(primary_addr, primary)];
        let mut retry = false;
        for addr in addrs.into_iter().skip(1) {
            match std::net::TcpListener::bind(addr) {
                Ok(listener) => {
                    listener.set_nonblocking(true)?;
                    listeners.push((addr, listener));
                }
                Err(err) if err.kind() == ErrorKind::AddrInUse => {
                    retry = true;
                    break;
                }
                Err(err) => return Err(err.into()),
            }
        }
        if !retry {
            return Ok(listeners);
        }
    }
    Err(anyhow::anyhow!(
        "failed to allocate a shared fallback port for gateway listeners"
    ))
}

pub(crate) fn prepare_gateway_listeners(
    state: &crate::app_state::AppState,
) -> anyhow::Result<PreparedGatewayListeners> {
    write_gateway_bootstrap_diag("prepare_gateway_listeners_enter", None);
    let cfg = state.gateway.cfg.read().clone();
    let bound = match try_bind_gateway_listeners(&cfg.listen.host, cfg.listen.port) {
        Ok(listeners) => listeners,
        Err(err)
            if err
                .downcast_ref::<std::io::Error>()
                .is_some_and(|io| io.kind() == ErrorKind::AddrInUse) =>
        {
            write_gateway_bootstrap_diag(
                "prepare_gateway_listeners_addr_in_use",
                Some(&format!("configured_port={}", cfg.listen.port)),
            );
            let listeners = bind_fallback_gateway_listeners(&cfg.listen.host)?;
            let next_port = listeners
                .first()
                .map(|(addr, _)| addr.port())
                .ok_or_else(|| anyhow::anyhow!("gateway fallback bind produced no listeners"))?;
            persist_gateway_runtime_port(state, next_port)?;
            listeners
        }
        Err(err) => {
            write_gateway_bootstrap_diag(
                "prepare_gateway_listeners_failed",
                Some(&err.to_string()),
            );
            return Err(err);
        }
    };
    let listen_port = bound
        .first()
        .map(|(addr, _)| addr.port())
        .ok_or_else(|| anyhow::anyhow!("gateway bind produced no listeners"))?;
    write_gateway_bootstrap_diag(
        "prepare_gateway_listeners_ok",
        Some(&format!("listen_port={listen_port}")),
    );
    Ok(PreparedGatewayListeners {
        listen_port,
        listeners: bound,
    })
}

#[cfg(test)]
mod tests {
    use super::{gateway_listen_addrs, gateway_listen_addrs_with_overlays};

    #[test]
    fn local_bind_keeps_primary_listener() {
        let addrs = gateway_listen_addrs("127.0.0.1", 4000).unwrap();
        assert!(!addrs.is_empty());
        assert_eq!(addrs[0].to_string(), "127.0.0.1:4000");
    }

    #[cfg(windows)]
    #[test]
    fn local_bind_adds_tailscale_overlay_listener() {
        let overlays = vec!["100.64.208.117".parse().unwrap()];
        let addrs = gateway_listen_addrs_with_overlays(
            "127.0.0.1",
            4000,
            "172.26.144.1",
            Some("192.168.3.210".parse().unwrap()),
            &overlays,
        )
        .unwrap();
        assert!(addrs
            .iter()
            .any(|addr| addr.to_string() == "127.0.0.1:4000"));
        assert!(addrs
            .iter()
            .any(|addr| addr.to_string() == "192.168.3.210:4000"));
        assert!(addrs
            .iter()
            .any(|addr| addr.to_string() == "100.64.208.117:4000"));
    }

    #[cfg(windows)]
    #[test]
    fn tailscale_ip_output_parser_ignores_empty_rows() {
        let parsed = String::from("100.64.208.117\r\n\r\n100.118.0.115\n")
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .filter_map(|line| line.parse::<std::net::IpAddr>().ok())
            .collect::<Vec<_>>();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].to_string(), "100.64.208.117");
        assert_eq!(parsed[1].to_string(), "100.118.0.115");
    }
}
