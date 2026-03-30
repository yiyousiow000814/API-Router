use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use crate::orchestrator::config::AppConfig;
use crate::orchestrator::secrets::SecretStore;
use crate::orchestrator::store::unix_ms;

pub const LAN_DISCOVERY_PORT: u16 = 38455;
pub const LAN_HEARTBEAT_INTERVAL_MS: u64 = 2_000;
pub const LAN_PEER_STALE_AFTER_MS: u64 = 7_000;
const LAN_HEARTBEAT_CAPABILITIES: [&str; 2] = ["heartbeat_v1", "status_v1"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LanNodeIdentity {
    pub node_id: String,
    pub node_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LanLocalNodeSnapshot {
    pub node_id: String,
    pub node_name: String,
    pub listen_addr: Option<String>,
    pub capabilities: Vec<String>,
    pub provider_fingerprints: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LanPeerSnapshot {
    pub node_id: String,
    pub node_name: String,
    pub listen_addr: String,
    pub last_heartbeat_unix_ms: u64,
    pub capabilities: Vec<String>,
    pub provider_fingerprints: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LanSyncStatusSnapshot {
    pub enabled: bool,
    pub discovery_port: u16,
    pub heartbeat_interval_ms: u64,
    pub peer_stale_after_ms: u64,
    pub local_node: LanLocalNodeSnapshot,
    pub peers: Vec<LanPeerSnapshot>,
}

#[derive(Debug, Clone)]
struct LanPeerRuntime {
    node_id: String,
    node_name: String,
    listen_addr: String,
    last_heartbeat_unix_ms: u64,
    capabilities: Vec<String>,
    provider_fingerprints: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LanHeartbeatPacket {
    version: u8,
    node_id: String,
    node_name: String,
    listen_port: u16,
    sent_at_unix_ms: u64,
    capabilities: Vec<String>,
    provider_fingerprints: Vec<String>,
}

#[derive(Clone)]
pub struct LanSyncRuntime {
    local_node: LanNodeIdentity,
    peers: Arc<RwLock<HashMap<String, LanPeerRuntime>>>,
    started: Arc<AtomicBool>,
}

impl LanSyncRuntime {
    pub fn new(local_node: LanNodeIdentity) -> Self {
        Self {
            local_node,
            peers: Arc::new(RwLock::new(HashMap::new())),
            started: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn start_background(&self, cfg: Arc<RwLock<AppConfig>>, secrets: SecretStore) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }

        let listener_runtime = self.clone();
        std::thread::Builder::new()
            .name("lan-sync-listener".to_string())
            .spawn(move || run_listener(listener_runtime))
            .ok();

        let sender_runtime = self.clone();
        std::thread::Builder::new()
            .name("lan-sync-heartbeat".to_string())
            .spawn(move || run_sender(sender_runtime, cfg, secrets))
            .ok();
    }

    pub fn snapshot(
        &self,
        listen_port: u16,
        cfg: &AppConfig,
        secrets: &SecretStore,
    ) -> LanSyncStatusSnapshot {
        let peers = self.collect_live_peers(unix_ms());
        LanSyncStatusSnapshot {
            enabled: true,
            discovery_port: LAN_DISCOVERY_PORT,
            heartbeat_interval_ms: LAN_HEARTBEAT_INTERVAL_MS,
            peer_stale_after_ms: LAN_PEER_STALE_AFTER_MS,
            local_node: LanLocalNodeSnapshot {
                node_id: self.local_node.node_id.clone(),
                node_name: self.local_node.node_name.clone(),
                listen_addr: detect_local_listen_addr(listen_port),
                capabilities: LAN_HEARTBEAT_CAPABILITIES
                    .iter()
                    .map(|value| value.to_string())
                    .collect(),
                provider_fingerprints: build_provider_fingerprints(cfg, secrets),
            },
            peers,
        }
    }

    fn note_peer_heartbeat(&self, packet: LanHeartbeatPacket, source: SocketAddr) {
        if packet.node_id.trim().is_empty() || packet.node_id == self.local_node.node_id {
            return;
        }
        let listen_addr = format!("{}:{}", source.ip(), packet.listen_port);
        self.peers.write().insert(
            packet.node_id.clone(),
            LanPeerRuntime {
                node_id: packet.node_id,
                node_name: sanitize_node_name(&packet.node_name),
                listen_addr,
                last_heartbeat_unix_ms: packet.sent_at_unix_ms,
                capabilities: packet.capabilities,
                provider_fingerprints: packet.provider_fingerprints,
            },
        );
    }

    fn collect_live_peers(&self, now: u64) -> Vec<LanPeerSnapshot> {
        let mut peers = self.peers.write();
        peers.retain(|_, peer| !peer_is_stale(peer.last_heartbeat_unix_ms, now));
        let mut out = peers
            .values()
            .map(|peer| LanPeerSnapshot {
                node_id: peer.node_id.clone(),
                node_name: peer.node_name.clone(),
                listen_addr: peer.listen_addr.clone(),
                last_heartbeat_unix_ms: peer.last_heartbeat_unix_ms,
                capabilities: peer.capabilities.clone(),
                provider_fingerprints: peer.provider_fingerprints.clone(),
            })
            .collect::<Vec<_>>();
        out.sort_by(|a, b| {
            b.last_heartbeat_unix_ms
                .cmp(&a.last_heartbeat_unix_ms)
                .then_with(|| a.node_name.cmp(&b.node_name))
        });
        out
    }
}

pub fn default_node_name() -> String {
    let candidate = std::env::var("API_ROUTER_NODE_NAME")
        .ok()
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .unwrap_or_else(|| "api-router-node".to_string());
    sanitize_node_name(&candidate)
}

pub fn sanitize_node_name(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "api-router-node".to_string();
    }
    let cleaned = trimmed
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == ' ' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        "api-router-node".to_string()
    } else {
        collapsed.chars().take(48).collect()
    }
}

fn run_listener(runtime: LanSyncRuntime) {
    let socket = match UdpSocket::bind((Ipv4Addr::UNSPECIFIED, LAN_DISCOVERY_PORT)) {
        Ok(socket) => socket,
        Err(err) => {
            log::warn!(
                "lan sync listener bind failed on {}: {err}",
                LAN_DISCOVERY_PORT
            );
            return;
        }
    };
    let _ = socket.set_read_timeout(Some(Duration::from_millis(1_500)));
    let mut buf = [0_u8; 64 * 1024];
    loop {
        match socket.recv_from(&mut buf) {
            Ok((len, source)) => {
                let Ok(packet) = serde_json::from_slice::<LanHeartbeatPacket>(&buf[..len]) else {
                    continue;
                };
                runtime.note_peer_heartbeat(packet, source);
            }
            Err(err)
                if err.kind() == std::io::ErrorKind::WouldBlock
                    || err.kind() == std::io::ErrorKind::TimedOut => {}
            Err(err) => {
                log::warn!("lan sync listener recv failed: {err}");
                std::thread::sleep(Duration::from_millis(750));
            }
        }
    }
}

fn run_sender(runtime: LanSyncRuntime, cfg: Arc<RwLock<AppConfig>>, secrets: SecretStore) {
    let socket = match UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)) {
        Ok(socket) => socket,
        Err(err) => {
            log::warn!("lan sync sender bind failed: {err}");
            return;
        }
    };
    if let Err(err) = socket.set_broadcast(true) {
        log::warn!("lan sync sender failed to enable broadcast: {err}");
        return;
    }
    let target = SocketAddr::from((Ipv4Addr::BROADCAST, LAN_DISCOVERY_PORT));
    loop {
        let cfg_snapshot = cfg.read().clone();
        let packet = LanHeartbeatPacket {
            version: 1,
            node_id: runtime.local_node.node_id.clone(),
            node_name: runtime.local_node.node_name.clone(),
            listen_port: cfg_snapshot.listen.port,
            sent_at_unix_ms: unix_ms(),
            capabilities: LAN_HEARTBEAT_CAPABILITIES
                .iter()
                .map(|value| value.to_string())
                .collect(),
            provider_fingerprints: build_provider_fingerprints(&cfg_snapshot, &secrets),
        };
        if let Ok(bytes) = serde_json::to_vec(&packet) {
            let _ = socket.send_to(&bytes, target);
        }
        std::thread::sleep(Duration::from_millis(LAN_HEARTBEAT_INTERVAL_MS));
    }
}

fn detect_local_listen_addr(listen_port: u16) -> Option<String> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(8, 8, 8, 8), 80)).ok()?;
    let addr = socket.local_addr().ok()?;
    let ip = addr.ip();
    if ip.is_loopback() || !ip.is_ipv4() {
        return None;
    }
    Some(format!("{}:{}", ip, listen_port))
}

fn peer_is_stale(last_heartbeat_unix_ms: u64, now: u64) -> bool {
    last_heartbeat_unix_ms == 0
        || now.saturating_sub(last_heartbeat_unix_ms) > LAN_PEER_STALE_AFTER_MS
}

fn build_provider_fingerprints(cfg: &AppConfig, secrets: &SecretStore) -> Vec<String> {
    let mut out = Vec::new();
    for (provider_name, provider) in cfg.providers.iter() {
        let Some(api_key) = secrets.get_provider_key(provider_name) else {
            continue;
        };
        let normalized_base = provider
            .usage_base_url
            .as_deref()
            .unwrap_or(provider.base_url.as_str())
            .trim()
            .to_ascii_lowercase();
        if normalized_base.is_empty() {
            continue;
        }
        let key_fp = stable_key_fingerprint(&api_key);
        out.push(format!(
            "{}|{}|{}",
            provider_name.trim().to_ascii_lowercase(),
            normalized_base,
            key_fp
        ));
    }
    out.sort();
    out.dedup();
    out
}

fn stable_key_fingerprint(input: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.trim().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", hash)
}

#[cfg(test)]
mod tests {
    use super::{
        peer_is_stale, sanitize_node_name, stable_key_fingerprint, LanNodeIdentity, LanSyncRuntime,
        LAN_PEER_STALE_AFTER_MS,
    };

    #[test]
    fn sanitize_node_name_trims_and_limits_length() {
        let value = sanitize_node_name("  My/Desk*Top Node Name With Extra Characters  ");
        assert_eq!(value, "My-Desk-Top Node Name With Extra Characters");
        assert!(sanitize_node_name("").contains("api-router-node"));
    }

    #[test]
    fn stable_key_fingerprint_is_deterministic() {
        let a = stable_key_fingerprint("sk-123");
        let b = stable_key_fingerprint("sk-123");
        let c = stable_key_fingerprint("sk-xyz");
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn peer_registry_prunes_stale_peers() {
        let runtime = LanSyncRuntime::new(LanNodeIdentity {
            node_id: "node-self".to_string(),
            node_name: "self".to_string(),
        });
        runtime.peers.write().insert(
            "fresh".to_string(),
            super::LanPeerRuntime {
                node_id: "fresh".to_string(),
                node_name: "Fresh".to_string(),
                listen_addr: "192.168.1.10:4000".to_string(),
                last_heartbeat_unix_ms: 100_000,
                capabilities: vec!["heartbeat_v1".to_string()],
                provider_fingerprints: vec![],
            },
        );
        runtime.peers.write().insert(
            "stale".to_string(),
            super::LanPeerRuntime {
                node_id: "stale".to_string(),
                node_name: "Stale".to_string(),
                listen_addr: "192.168.1.11:4000".to_string(),
                last_heartbeat_unix_ms: 100_000_u64.saturating_sub(LAN_PEER_STALE_AFTER_MS + 1),
                capabilities: vec!["heartbeat_v1".to_string()],
                provider_fingerprints: vec![],
            },
        );

        let peers = runtime.collect_live_peers(100_000);
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].node_id, "fresh");
    }

    #[test]
    fn peer_stale_boundary_matches_timeout() {
        assert!(!peer_is_stale(10_000, 10_000 + LAN_PEER_STALE_AFTER_MS));
        assert!(peer_is_stale(10_000, 10_000 + LAN_PEER_STALE_AFTER_MS + 1));
    }
}
