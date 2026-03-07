use std::io::ErrorKind;
use std::net::SocketAddr;

use serde_json::json;

pub(crate) struct PreparedGatewayListeners {
    pub(crate) listen_port: u16,
    pub(crate) listeners: Vec<(SocketAddr, std::net::TcpListener)>,
}

fn gateway_listen_addrs(listen_host: &str, listen_port: u16) -> anyhow::Result<Vec<SocketAddr>> {
    let primary: SocketAddr = format!("{listen_host}:{listen_port}").parse()?;
    #[cfg(windows)]
    let mut addrs = vec![primary];
    #[cfg(not(windows))]
    let addrs = vec![primary];
    #[cfg(windows)]
    {
        let primary_ip = primary.ip().to_string();
        if primary_ip == crate::constants::GATEWAY_WINDOWS_HOST {
            let wsl_host = crate::platform::wsl_gateway_host::resolve_wsl_gateway_host(None);
            let parsed_wsl_ip: std::net::IpAddr = wsl_host.parse()?;
            if parsed_wsl_ip != primary.ip() {
                addrs.push(SocketAddr::new(parsed_wsl_ip, listen_port));
            }
        }
    }
    Ok(addrs)
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
    let addrs = gateway_listen_addrs(listen_host, listen_port)?;
    let mut listeners = Vec::with_capacity(addrs.len());
    for addr in addrs {
        let listener = std::net::TcpListener::bind(addr)?;
        listener.set_nonblocking(true)?;
        listeners.push((addr, listener));
    }
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
    let cfg = state.gateway.cfg.read().clone();
    let bound = match try_bind_gateway_listeners(&cfg.listen.host, cfg.listen.port) {
        Ok(listeners) => listeners,
        Err(err)
            if err
                .downcast_ref::<std::io::Error>()
                .is_some_and(|io| io.kind() == ErrorKind::AddrInUse) =>
        {
            let listeners = bind_fallback_gateway_listeners(&cfg.listen.host)?;
            let next_port = listeners
                .first()
                .map(|(addr, _)| addr.port())
                .ok_or_else(|| anyhow::anyhow!("gateway fallback bind produced no listeners"))?;
            persist_gateway_runtime_port(state, next_port)?;
            listeners
        }
        Err(err) => return Err(err),
    };
    let listen_port = bound
        .first()
        .map(|(addr, _)| addr.port())
        .ok_or_else(|| anyhow::anyhow!("gateway bind produced no listeners"))?;
    Ok(PreparedGatewayListeners {
        listen_port,
        listeners: bound,
    })
}

#[cfg(test)]
mod tests {
    use super::gateway_listen_addrs;

    #[test]
    fn local_bind_keeps_primary_listener() {
        let addrs = gateway_listen_addrs("127.0.0.1", 4000).unwrap();
        assert!(!addrs.is_empty());
        assert_eq!(addrs[0].to_string(), "127.0.0.1:4000");
    }
}
