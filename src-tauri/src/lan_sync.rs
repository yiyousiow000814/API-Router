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
const LAN_SHARED_HEALTH_LOOP_INTERVAL_MS: u64 = 900;
const LAN_USAGE_SYNC_LOOP_INTERVAL_MS: u64 = 1_500;
const LAN_USAGE_SYNC_BATCH_LIMIT: usize = 32;
const LAN_HEARTBEAT_CAPABILITIES: [&str; 3] = ["heartbeat_v1", "status_v1", "usage_sync_v1"];

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
pub struct LanQuotaOwnerDecision {
    pub owner_node_id: String,
    pub owner_node_name: String,
    pub local_is_owner: bool,
    pub contender_count: usize,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LanSharedHealthPacket {
    version: u8,
    node_id: String,
    node_name: String,
    sent_at_unix_ms: u64,
    shared_provider_fingerprint: String,
    status: String,
    consecutive_failures: u32,
    cooldown_until_unix_ms: u64,
    last_error: String,
    last_ok_at_unix_ms: u64,
    last_fail_at_unix_ms: u64,
    shared_probe_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LanUsageSyncRequestPacket {
    version: u8,
    node_id: String,
    after_ingested_at_unix_ms: u64,
    after_id: String,
    limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LanUsageSyncBatchPacket {
    version: u8,
    node_id: String,
    rows: Vec<crate::orchestrator::store::UsageRequestSyncRow>,
    has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum LanSyncPacket {
    Heartbeat(LanHeartbeatPacket),
    SharedHealth(LanSharedHealthPacket),
    UsageSyncRequest(LanUsageSyncRequestPacket),
    UsageSyncBatch(LanUsageSyncBatchPacket),
}

#[derive(Clone)]
pub struct LanSyncRuntime {
    local_node: LanNodeIdentity,
    local_provider_fingerprints: Arc<RwLock<Vec<String>>>,
    peers: Arc<RwLock<HashMap<String, LanPeerRuntime>>>,
    started: Arc<AtomicBool>,
}

impl LanSyncRuntime {
    pub fn new(local_node: LanNodeIdentity) -> Self {
        Self {
            local_node,
            local_provider_fingerprints: Arc::new(RwLock::new(Vec::new())),
            peers: Arc::new(RwLock::new(HashMap::new())),
            started: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn start_background(&self, gateway: crate::orchestrator::gateway::GatewayState) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }

        let listener_runtime = self.clone();
        let listener_gateway = gateway.clone();
        std::thread::Builder::new()
            .name("lan-sync-listener".to_string())
            .spawn(move || run_listener(listener_runtime, listener_gateway))
            .ok();

        let sender_runtime = self.clone();
        let sender_gateway = gateway.clone();
        std::thread::Builder::new()
            .name("lan-sync-heartbeat".to_string())
            .spawn(move || run_sender(sender_runtime, sender_gateway))
            .ok();

        let shared_health_runtime = self.clone();
        let shared_health_gateway = gateway.clone();
        std::thread::Builder::new()
            .name("lan-sync-shared-health".to_string())
            .spawn(move || run_shared_health_loop(shared_health_runtime, shared_health_gateway))
            .ok();

        let usage_sync_runtime = self.clone();
        let usage_sync_gateway = gateway.clone();
        std::thread::Builder::new()
            .name("lan-sync-usage-sync".to_string())
            .spawn(move || run_usage_sync_loop(usage_sync_runtime, usage_sync_gateway))
            .ok();
    }

    pub fn quota_owner_for_fingerprint(&self, fingerprint: &str) -> Option<LanQuotaOwnerDecision> {
        let normalized = fingerprint.trim();
        if normalized.is_empty() {
            return None;
        }
        let mut contenders = Vec::new();
        if self
            .local_provider_fingerprints
            .read()
            .iter()
            .any(|value| value == normalized)
        {
            contenders.push((
                self.local_node.node_id.clone(),
                self.local_node.node_name.clone(),
            ));
        }
        for peer in self.collect_live_peers(unix_ms()) {
            if !peer
                .provider_fingerprints
                .iter()
                .any(|value| value == normalized)
            {
                continue;
            }
            contenders.push((peer.node_id, peer.node_name));
        }
        contenders.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        contenders.dedup_by(|a, b| a.0 == b.0);
        let (owner_node_id, owner_node_name) = contenders.first()?.clone();
        Some(LanQuotaOwnerDecision {
            local_is_owner: owner_node_id == self.local_node.node_id,
            owner_node_id,
            owner_node_name,
            contender_count: contenders.len(),
        })
    }

    pub fn snapshot(
        &self,
        listen_port: u16,
        cfg: &AppConfig,
        secrets: &SecretStore,
    ) -> LanSyncStatusSnapshot {
        let peers = self.collect_live_peers(unix_ms());
        let local_provider_fingerprints = build_provider_fingerprints(cfg, secrets);
        *self.local_provider_fingerprints.write() = local_provider_fingerprints.clone();
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
                provider_fingerprints: local_provider_fingerprints,
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

    pub fn local_node_id(&self) -> String {
        self.local_node.node_id.clone()
    }

    pub fn local_node_name(&self) -> String {
        self.local_node.node_name.clone()
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

fn run_listener(runtime: LanSyncRuntime, gateway: crate::orchestrator::gateway::GatewayState) {
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
                let Ok(packet) = serde_json::from_slice::<LanSyncPacket>(&buf[..len]) else {
                    continue;
                };
                match packet {
                    LanSyncPacket::Heartbeat(packet) => runtime.note_peer_heartbeat(packet, source),
                    LanSyncPacket::SharedHealth(packet) => {
                        apply_shared_health_packet(&runtime, &gateway, packet);
                    }
                    LanSyncPacket::UsageSyncRequest(packet) => {
                        handle_usage_sync_request(&runtime, &gateway, source, packet);
                    }
                    LanSyncPacket::UsageSyncBatch(packet) => {
                        apply_usage_sync_batch(&runtime, &gateway, packet);
                    }
                }
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

fn run_sender(runtime: LanSyncRuntime, gateway: crate::orchestrator::gateway::GatewayState) {
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
        let cfg_snapshot = gateway.cfg.read().clone();
        let provider_fingerprints = build_provider_fingerprints(&cfg_snapshot, &gateway.secrets);
        *runtime.local_provider_fingerprints.write() = provider_fingerprints.clone();
        let packet = LanSyncPacket::Heartbeat(LanHeartbeatPacket {
            version: 1,
            node_id: runtime.local_node.node_id.clone(),
            node_name: runtime.local_node.node_name.clone(),
            listen_port: cfg_snapshot.listen.port,
            sent_at_unix_ms: unix_ms(),
            capabilities: LAN_HEARTBEAT_CAPABILITIES
                .iter()
                .map(|value| value.to_string())
                .collect(),
            provider_fingerprints,
        });
        if let Ok(bytes) = serde_json::to_vec(&packet) {
            let _ = socket.send_to(&bytes, target);
        }
        std::thread::sleep(Duration::from_millis(LAN_HEARTBEAT_INTERVAL_MS));
    }
}

fn apply_shared_health_packet(
    runtime: &LanSyncRuntime,
    gateway: &crate::orchestrator::gateway::GatewayState,
    packet: LanSharedHealthPacket,
) {
    if packet.node_id.trim().is_empty() || packet.node_id == runtime.local_node.node_id {
        return;
    }
    let cfg = gateway.cfg.read().clone();
    let shared = crate::orchestrator::router::SharedHealthSyncSnapshot {
        status: packet.status,
        consecutive_failures: packet.consecutive_failures,
        cooldown_until_unix_ms: packet.cooldown_until_unix_ms,
        last_error: packet.last_error,
        last_ok_at_unix_ms: packet.last_ok_at_unix_ms,
        last_fail_at_unix_ms: packet.last_fail_at_unix_ms,
        shared_probe_required: packet.shared_probe_required,
        updated_at_unix_ms: packet.sent_at_unix_ms,
        source_node_id: packet.node_id.clone(),
        source_is_local: false,
    };
    let mut applied = Vec::new();
    for provider_name in cfg.providers.keys() {
        let Some(fingerprint) = crate::orchestrator::quota::shared_provider_fingerprint(
            &cfg,
            &gateway.secrets,
            provider_name,
        ) else {
            continue;
        };
        if fingerprint != packet.shared_provider_fingerprint {
            continue;
        }
        if gateway
            .router
            .apply_shared_sync_snapshot(provider_name, &shared, false)
        {
            applied.push(provider_name.clone());
        }
    }
    if !applied.is_empty() {
        gateway.store.add_event(
            "gateway",
            "info",
            "lan.shared_health_applied",
            &format!(
                "applied shared health from {} to {} provider(s)",
                packet.node_name,
                applied.len()
            ),
            serde_json::json!({
                "source_node_id": packet.node_id,
                "source_node_name": packet.node_name,
                "providers": applied,
                "status": shared.status,
                "cooldown_until_unix_ms": shared.cooldown_until_unix_ms,
            }),
        );
    }
}

fn broadcast_shared_health_packet(packet: &LanSharedHealthPacket) {
    let socket = match UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)) {
        Ok(socket) => socket,
        Err(_) => return,
    };
    if socket.set_broadcast(true).is_err() {
        return;
    }
    let target = SocketAddr::from((Ipv4Addr::BROADCAST, LAN_DISCOVERY_PORT));
    let payload = LanSyncPacket::SharedHealth(packet.clone());
    if let Ok(bytes) = serde_json::to_vec(&payload) {
        let _ = socket.send_to(&bytes, target);
    }
}

fn send_packet_to_addr(addr: SocketAddr, packet: &LanSyncPacket) {
    let socket = match UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)) {
        Ok(socket) => socket,
        Err(_) => return,
    };
    if let Ok(bytes) = serde_json::to_vec(packet) {
        let _ = socket.send_to(&bytes, addr);
    }
}

fn peer_sync_addr(peer: &LanPeerSnapshot) -> Option<SocketAddr> {
    let host = peer.listen_addr.split(':').next()?.trim();
    let ip: Ipv4Addr = host.parse().ok()?;
    Some(SocketAddr::from((ip, LAN_DISCOVERY_PORT)))
}

fn usage_sync_cursor_key(peer_node_id: &str) -> String {
    format!("lan_usage_sync_cursor:{peer_node_id}")
}

fn load_usage_sync_cursor(
    gateway: &crate::orchestrator::gateway::GatewayState,
    peer_node_id: &str,
) -> (u64, String) {
    let Ok(Some(value)) = gateway.store.get_event_meta(&usage_sync_cursor_key(peer_node_id)) else {
        return (0, String::new());
    };
    let Some((left, right)) = value.split_once('|') else {
        return (0, String::new());
    };
    (left.trim().parse::<u64>().unwrap_or(0), right.to_string())
}

fn save_usage_sync_cursor(
    gateway: &crate::orchestrator::gateway::GatewayState,
    peer_node_id: &str,
    after_ingested_at_unix_ms: u64,
    after_id: &str,
) {
    let _ = gateway.store.set_event_meta(
        &usage_sync_cursor_key(peer_node_id),
        &format!("{after_ingested_at_unix_ms}|{after_id}"),
    );
}

fn handle_usage_sync_request(
    runtime: &LanSyncRuntime,
    gateway: &crate::orchestrator::gateway::GatewayState,
    source: SocketAddr,
    packet: LanUsageSyncRequestPacket,
) {
    if packet.node_id.trim().is_empty() || packet.node_id == runtime.local_node.node_id {
        return;
    }
    let (rows, has_more) = gateway.store.list_usage_request_sync_batch(
        packet.after_ingested_at_unix_ms,
        Some(packet.after_id.as_str()),
        packet.limit.clamp(1, LAN_USAGE_SYNC_BATCH_LIMIT),
    );
    send_packet_to_addr(
        SocketAddr::from((source.ip(), LAN_DISCOVERY_PORT)),
        &LanSyncPacket::UsageSyncBatch(LanUsageSyncBatchPacket {
            version: 1,
            node_id: runtime.local_node.node_id.clone(),
            rows,
            has_more,
        }),
    );
}

fn apply_usage_sync_batch(
    runtime: &LanSyncRuntime,
    gateway: &crate::orchestrator::gateway::GatewayState,
    packet: LanUsageSyncBatchPacket,
) {
    if packet.node_id.trim().is_empty() || packet.node_id == runtime.local_node.node_id {
        return;
    }
    if packet.rows.is_empty() {
        return;
    }
    let inserted = gateway.store.upsert_usage_request_sync_rows(&packet.rows);
    if let Some(last_row) = packet.rows.last() {
        save_usage_sync_cursor(
            gateway,
            &packet.node_id,
            last_row.ingested_at_unix_ms,
            &last_row.id,
        );
    }
    if inserted > 0 {
        gateway.store.add_event(
            "gateway",
            "info",
            "lan.usage_sync_applied",
            &format!("applied {inserted} synced request row(s)"),
            serde_json::json!({
                "source_node_id": packet.node_id,
                "received_rows": packet.rows.len(),
                "inserted_rows": inserted,
                "has_more": packet.has_more,
            }),
        );
    }
}

fn run_usage_sync_loop(
    runtime: LanSyncRuntime,
    gateway: crate::orchestrator::gateway::GatewayState,
) {
    loop {
        let peers = runtime.collect_live_peers(unix_ms());
        for peer in peers {
            if !peer.capabilities.iter().any(|value| value == "usage_sync_v1") {
                continue;
            }
            let Some(addr) = peer_sync_addr(&peer) else {
                continue;
            };
            let (after_ingested_at_unix_ms, after_id) =
                load_usage_sync_cursor(&gateway, &peer.node_id);
            send_packet_to_addr(
                addr,
                &LanSyncPacket::UsageSyncRequest(LanUsageSyncRequestPacket {
                    version: 1,
                    node_id: runtime.local_node.node_id.clone(),
                    after_ingested_at_unix_ms,
                    after_id,
                    limit: LAN_USAGE_SYNC_BATCH_LIMIT,
                }),
            );
        }
        std::thread::sleep(Duration::from_millis(LAN_USAGE_SYNC_LOOP_INTERVAL_MS));
    }
}

fn run_shared_health_loop(
    runtime: LanSyncRuntime,
    gateway: crate::orchestrator::gateway::GatewayState,
) {
    let mut last_broadcasted: HashMap<String, String> = HashMap::new();
    let mut last_probe_attempt_unix_ms: HashMap<String, u64> = HashMap::new();

    loop {
        let now = unix_ms();
        let cfg = gateway.cfg.read().clone();
        let mut by_fingerprint: HashMap<
            String,
            (
                String,
                crate::orchestrator::router::SharedHealthSyncSnapshot,
            ),
        > = HashMap::new();

        for provider_name in cfg.providers.keys() {
            let Some(fingerprint) = crate::orchestrator::quota::shared_provider_fingerprint(
                &cfg,
                &gateway.secrets,
                provider_name,
            ) else {
                continue;
            };
            let Some(shared) = gateway.router.shared_sync_snapshot(provider_name, now) else {
                continue;
            };
            if !shared.source_is_local {
                continue;
            }
            let replace = by_fingerprint
                .get(&fingerprint)
                .map(|(current_provider_name, current)| {
                    shared.updated_at_unix_ms > current.updated_at_unix_ms
                        || (shared.updated_at_unix_ms == current.updated_at_unix_ms
                            && provider_name < current_provider_name)
                })
                .unwrap_or(true);
            if replace {
                by_fingerprint.insert(fingerprint, (provider_name.clone(), shared));
            }
        }

        for (fingerprint, (_provider_name, shared)) in by_fingerprint.iter() {
            for sibling_provider in cfg.providers.keys() {
                let Some(sibling_fingerprint) =
                    crate::orchestrator::quota::shared_provider_fingerprint(
                        &cfg,
                        &gateway.secrets,
                        sibling_provider,
                    )
                else {
                    continue;
                };
                if &sibling_fingerprint != fingerprint {
                    continue;
                }
                let _ = gateway
                    .router
                    .apply_shared_sync_snapshot(sibling_provider, shared, true);
            }

            let signature = format!(
                "{}|{}|{}|{}|{}|{}",
                shared.updated_at_unix_ms,
                shared.status,
                shared.cooldown_until_unix_ms,
                shared.consecutive_failures,
                shared.last_ok_at_unix_ms,
                shared.last_fail_at_unix_ms
            );
            if last_broadcasted.get(fingerprint) == Some(&signature) {
                continue;
            }
            last_broadcasted.insert(fingerprint.clone(), signature);
            broadcast_shared_health_packet(&LanSharedHealthPacket {
                version: 1,
                node_id: runtime.local_node.node_id.clone(),
                node_name: runtime.local_node.node_name.clone(),
                sent_at_unix_ms: shared.updated_at_unix_ms,
                shared_provider_fingerprint: fingerprint.clone(),
                status: shared.status.clone(),
                consecutive_failures: shared.consecutive_failures,
                cooldown_until_unix_ms: shared.cooldown_until_unix_ms,
                last_error: shared.last_error.clone(),
                last_ok_at_unix_ms: shared.last_ok_at_unix_ms,
                last_fail_at_unix_ms: shared.last_fail_at_unix_ms,
                shared_probe_required: shared.shared_probe_required,
            });
        }

        for provider_name in cfg.providers.keys() {
            let Some(fingerprint) = crate::orchestrator::quota::shared_provider_fingerprint(
                &cfg,
                &gateway.secrets,
                provider_name,
            ) else {
                continue;
            };
            let Some(shared) = gateway.router.shared_sync_snapshot(provider_name, now) else {
                continue;
            };
            if !shared.shared_probe_required
                || shared.cooldown_until_unix_ms == 0
                || now < shared.cooldown_until_unix_ms
            {
                continue;
            }
            if last_probe_attempt_unix_ms
                .get(&fingerprint)
                .is_some_and(|value| {
                    now.saturating_sub(*value) < LAN_SHARED_HEALTH_LOOP_INTERVAL_MS
                })
            {
                continue;
            }
            let Some(owner) = runtime.quota_owner_for_fingerprint(&fingerprint) else {
                continue;
            };
            if !owner.local_is_owner {
                continue;
            }
            last_probe_attempt_unix_ms.insert(fingerprint.clone(), now);
            run_single_owner_recovery_probe(&gateway, &cfg, provider_name);
        }

        std::thread::sleep(Duration::from_millis(LAN_SHARED_HEALTH_LOOP_INTERVAL_MS));
    }
}

fn run_single_owner_recovery_probe(
    gateway: &crate::orchestrator::gateway::GatewayState,
    cfg: &AppConfig,
    provider_name: &str,
) {
    let Some(provider) = cfg.providers.get(provider_name).cloned() else {
        return;
    };
    let api_key = gateway.secrets.get_provider_key(provider_name);
    let now = unix_ms();
    let result = tauri::async_runtime::block_on(gateway.upstream.get_json(
        &provider,
        "/v1/models",
        api_key.as_deref(),
        None,
        cfg.routing.request_timeout_seconds,
    ));
    match result {
        Ok((status, _payload)) if (200..300).contains(&status) => {
            let _ = gateway.router.mark_success(provider_name, now);
            gateway.store.add_event(
                provider_name,
                "info",
                "lan.shared_recovery_probe_ok",
                "shared cooldown recovery probe succeeded",
                serde_json::json!({ "owner_node": "local" }),
            );
        }
        Ok((status, _payload)) => {
            let err = format!("shared recovery probe failed: http {status}");
            let _ = gateway.router.mark_failure(provider_name, cfg, &err, now);
            gateway.store.add_event(
                provider_name,
                "warning",
                "lan.shared_recovery_probe_failed",
                &err,
                serde_json::json!({ "owner_node": "local", "http_status": status }),
            );
        }
        Err(err) => {
            let detail = format!("shared recovery probe failed: {err}");
            let _ = gateway
                .router
                .mark_failure(provider_name, cfg, &detail, now);
            gateway.store.add_event(
                provider_name,
                "warning",
                "lan.shared_recovery_probe_failed",
                &detail,
                serde_json::json!({ "owner_node": "local" }),
            );
        }
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
    for provider_name in cfg.providers.keys() {
        if let Some(fingerprint) =
            crate::orchestrator::quota::shared_provider_fingerprint(cfg, secrets, provider_name)
        {
            out.push(fingerprint);
        }
    }
    out.sort();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::{
        peer_is_stale, sanitize_node_name, LanNodeIdentity, LanSyncRuntime, LAN_PEER_STALE_AFTER_MS,
    };

    #[test]
    fn sanitize_node_name_trims_and_limits_length() {
        let value = sanitize_node_name("  My/Desk*Top Node Name With Extra Characters  ");
        assert_eq!(value, "My-Desk-Top Node Name With Extra Characters");
        assert!(sanitize_node_name("").contains("api-router-node"));
    }

    #[test]
    fn shared_provider_fingerprint_is_deterministic() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let secrets =
            crate::orchestrator::secrets::SecretStore::new(tmp.path().join("secrets.json"));
        secrets
            .set_provider_key("p1", "sk-123")
            .expect("set provider key");
        secrets
            .ensure_provider_shared_id("p1")
            .expect("ensure shared id");
        let cfg = crate::orchestrator::config::AppConfig {
            listen: crate::orchestrator::config::ListenConfig {
                host: "127.0.0.1".to_string(),
                port: 4000,
            },
            routing: crate::orchestrator::config::RoutingConfig {
                preferred_provider: "p1".to_string(),
                session_preferred_providers: std::collections::BTreeMap::new(),
                route_mode: crate::orchestrator::config::RouteMode::FollowPreferredAuto,
                auto_return_to_preferred: true,
                preferred_stable_seconds: 1,
                failure_threshold: 1,
                cooldown_seconds: 600,
                request_timeout_seconds: 5,
            },
            providers: std::collections::BTreeMap::from([(
                "p1".to_string(),
                crate::orchestrator::config::ProviderConfig {
                    display_name: "P1".to_string(),
                    base_url: "https://quota.example/v1".to_string(),
                    usage_adapter: String::new(),
                    usage_base_url: Some("https://quota.example".to_string()),
                    group: None,
                    disabled: false,
                    api_key: String::new(),
                },
            )]),
            provider_order: vec!["p1".to_string()],
        };

        let a = crate::orchestrator::quota::shared_provider_fingerprint(&cfg, &secrets, "p1")
            .expect("fingerprint a");
        let b = crate::orchestrator::quota::shared_provider_fingerprint(&cfg, &secrets, "p1")
            .expect("fingerprint b");
        secrets
            .set_provider_key("p1", "sk-xyz")
            .expect("update provider key");
        let c = crate::orchestrator::quota::shared_provider_fingerprint(&cfg, &secrets, "p1")
            .expect("fingerprint c");
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
    fn quota_owner_for_fingerprint_prefers_lowest_node_id() {
        let runtime = LanSyncRuntime::new(LanNodeIdentity {
            node_id: "node-b".to_string(),
            node_name: "self".to_string(),
        });
        let now = crate::orchestrator::store::unix_ms();
        *runtime.local_provider_fingerprints.write() = vec!["fp-1".to_string()];
        runtime.peers.write().insert(
            "node-a".to_string(),
            super::LanPeerRuntime {
                node_id: "node-a".to_string(),
                node_name: "peer-a".to_string(),
                listen_addr: "192.168.1.10:4000".to_string(),
                last_heartbeat_unix_ms: now,
                capabilities: vec!["heartbeat_v1".to_string()],
                provider_fingerprints: vec!["fp-1".to_string()],
            },
        );
        let owner = runtime
            .quota_owner_for_fingerprint("fp-1")
            .expect("quota owner");
        assert_eq!(owner.owner_node_id, "node-a");
        assert!(!owner.local_is_owner);
    }

    #[test]
    fn peer_stale_boundary_matches_timeout() {
        assert!(!peer_is_stale(10_000, 10_000 + LAN_PEER_STALE_AFTER_MS));
        assert!(peer_is_stale(10_000, 10_000 + LAN_PEER_STALE_AFTER_MS + 1));
    }
}
