use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::extract::{Json, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use base64::Engine;
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{ChaCha20Poly1305, KeyInit, Nonce};
use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::orchestrator::config::AppConfig;
use crate::orchestrator::secrets::SecretStore;
use crate::orchestrator::store::unix_ms;

mod local_state;

pub use local_state::{
    apply_followed_provider_state, load_local_provider_copy_state,
    load_local_provider_state_snapshot, restore_local_provider_state,
    save_local_provider_state_snapshot, write_local_provider_copy_state,
    write_local_provider_state_snapshot, LocalProviderCopyStateSnapshot,
    LocalProviderStateSnapshot,
};

pub const LAN_DISCOVERY_PORT: u16 = 38455;
pub const LAN_HEARTBEAT_INTERVAL_MS: u64 = 2_000;
pub const LAN_PEER_STALE_AFTER_MS: u64 = 7_000;
const LAN_SHARED_HEALTH_LOOP_INTERVAL_MS: u64 = 900;
const LAN_USAGE_SYNC_LOOP_INTERVAL_MS: u64 = 1_000;
const LAN_USAGE_SYNC_BATCH_LIMIT: usize = 2_048;
const LAN_EDIT_SYNC_LOOP_INTERVAL_MS: u64 = 1_000;
const LAN_EDIT_SYNC_BATCH_LIMIT: usize = 512;
const LAN_PACKET_SOFT_LIMIT_BYTES: usize = 8 * 1024;
const LAN_SOCKET_RETRY_MS: u64 = 2_000;
const LAN_PAIR_REQUEST_TTL_MS: u64 = 5 * 60 * 1000;
const LAN_PAIR_REQUEST_THROTTLE_MS: u64 = 60 * 1000;
const LAN_PAIR_APPROVAL_TTL_MS: u64 = 5 * 60 * 1000;
const LAN_SYNC_AUTH_NODE_ID_HEADER: &str = "x-api-router-lan-node-id";
const LAN_SYNC_AUTH_SECRET_HEADER: &str = "x-api-router-lan-secret";
const LAN_HEARTBEAT_CAPABILITIES: [&str; 6] = [
    "heartbeat_v1",
    "status_v1",
    "usage_sync_v1",
    "edit_sync_v1",
    "config_source_v1",
    "quota_refresh_v1",
];

static GATEWAY_STATUS_RUNTIME: OnceLock<RwLock<Option<LanSyncRuntime>>> = OnceLock::new();

fn gateway_status_runtime() -> &'static RwLock<Option<LanSyncRuntime>> {
    GATEWAY_STATUS_RUNTIME.get_or_init(|| RwLock::new(None))
}

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
    pub followed_source_node_id: Option<String>,
    pub trusted: bool,
    pub pair_state: Option<String>,
    pub pair_request_id: Option<String>,
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
    pub last_peer_heartbeat_received_unix_ms: u64,
    pub last_peer_heartbeat_source: Option<String>,
    pub local_node: LanLocalNodeSnapshot,
    pub peers: Vec<LanPeerSnapshot>,
}

pub fn register_gateway_status_runtime(runtime: LanSyncRuntime) {
    *gateway_status_runtime().write() = Some(runtime);
}

pub fn gateway_status_snapshot(
    listen_port: u16,
    cfg: &AppConfig,
    secrets: &SecretStore,
) -> Option<LanSyncStatusSnapshot> {
    gateway_status_runtime()
        .read()
        .as_ref()
        .map(|runtime| runtime.snapshot(listen_port, cfg, secrets))
}

#[derive(Debug, Clone)]
struct LanPeerRuntime {
    node_id: String,
    node_name: String,
    listen_addr: String,
    last_heartbeat_unix_ms: u64,
    capabilities: Vec<String>,
    provider_fingerprints: Vec<String>,
    followed_source_node_id: Option<String>,
}

#[derive(Debug, Clone)]
struct LanPendingPairRequest {
    request_id: String,
    requester_node_id: String,
    requested_at_unix_ms: u64,
    requester_addr: SocketAddr,
}

#[derive(Debug, Clone)]
struct LanOutboundPairRequest {
    request_id: String,
    requested_at_unix_ms: u64,
    approval_ready: bool,
}

#[derive(Debug, Clone)]
struct LanPairApprovalState {
    requester_node_id: String,
    requester_addr: SocketAddr,
    pin_code: String,
    created_at_unix_ms: u64,
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
    #[serde(default)]
    followed_source_node_id: Option<String>,
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
pub(crate) struct LanUsageSyncRequestPacket {
    version: u8,
    node_id: String,
    after_ingested_at_unix_ms: u64,
    after_id: String,
    limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LanUsageSyncBatchPacket {
    version: u8,
    node_id: String,
    rows: Vec<crate::orchestrator::store::UsageRequestSyncRow>,
    has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LanEditSyncRequestPacket {
    version: u8,
    node_id: String,
    after_lamport_ts: u64,
    after_event_id: String,
    limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LanEditSyncBatchPacket {
    version: u8,
    node_id: String,
    events: Vec<crate::orchestrator::store::LanEditSyncEvent>,
    has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LanQuotaRefreshRequestPacket {
    version: u8,
    node_id: String,
    shared_provider_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LanPairRequestPacket {
    version: u8,
    request_id: String,
    node_id: String,
    node_name: String,
    sent_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LanPairApprovalReadyPacket {
    version: u8,
    request_id: String,
    node_id: String,
    node_name: String,
    sent_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LanPairPinSubmitPacket {
    version: u8,
    request_id: String,
    node_id: String,
    pin_code: String,
    sent_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LanPairTrustBundlePacket {
    version: u8,
    request_id: String,
    node_id: String,
    nonce_b64: String,
    ciphertext_b64: String,
    sent_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum LanSyncPacket {
    Heartbeat(LanHeartbeatPacket),
    SharedHealth(LanSharedHealthPacket),
    QuotaRefreshRequest(LanQuotaRefreshRequestPacket),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LanProtectedPacket {
    version: u8,
    sender_node_id: String,
    nonce_b64: String,
    ciphertext_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "wire_kind", rename_all = "snake_case")]
enum LanWirePacket {
    Heartbeat(LanHeartbeatPacket),
    Protected(LanProtectedPacket),
    PairRequest(LanPairRequestPacket),
    PairApprovalReady(LanPairApprovalReadyPacket),
    PairPinSubmit(LanPairPinSubmitPacket),
    PairTrustBundle(LanPairTrustBundlePacket),
}

#[derive(Clone)]
pub struct LanSyncRuntime {
    local_node: LanNodeIdentity,
    local_provider_fingerprints: Arc<RwLock<Vec<String>>>,
    peers: Arc<RwLock<HashMap<String, LanPeerRuntime>>>,
    last_peer_heartbeat_received_unix_ms: Arc<AtomicU64>,
    last_peer_heartbeat_source: Arc<RwLock<Option<String>>>,
    inbound_pair_requests: Arc<RwLock<HashMap<String, LanPendingPairRequest>>>,
    outbound_pair_requests: Arc<RwLock<HashMap<String, LanOutboundPairRequest>>>,
    pair_approvals: Arc<RwLock<HashMap<String, LanPairApprovalState>>>,
    pending_trust_bundle_pins: Arc<RwLock<HashMap<String, String>>>,
    started: Arc<AtomicBool>,
    last_peer_prune_unix_ms: Arc<AtomicU64>,
}

impl LanSyncRuntime {
    pub fn new(local_node: LanNodeIdentity) -> Self {
        Self {
            local_node,
            local_provider_fingerprints: Arc::new(RwLock::new(Vec::new())),
            peers: Arc::new(RwLock::new(HashMap::new())),
            last_peer_heartbeat_received_unix_ms: Arc::new(AtomicU64::new(0)),
            last_peer_heartbeat_source: Arc::new(RwLock::new(None)),
            inbound_pair_requests: Arc::new(RwLock::new(HashMap::new())),
            outbound_pair_requests: Arc::new(RwLock::new(HashMap::new())),
            pair_approvals: Arc::new(RwLock::new(HashMap::new())),
            pending_trust_bundle_pins: Arc::new(RwLock::new(HashMap::new())),
            started: Arc::new(AtomicBool::new(false)),
            last_peer_prune_unix_ms: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn start_background(
        &self,
        gateway: crate::orchestrator::gateway::GatewayState,
        config_path: std::path::PathBuf,
    ) {
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

        let edit_sync_runtime = self.clone();
        let edit_sync_gateway = gateway.clone();
        let edit_sync_config_path = config_path.clone();
        std::thread::Builder::new()
            .name("lan-sync-edit-sync".to_string())
            .spawn(move || {
                run_edit_sync_loop(edit_sync_runtime, edit_sync_gateway, edit_sync_config_path)
            })
            .ok();
    }

    pub fn quota_owner_for_fingerprint(
        &self,
        fingerprint: &str,
        trusted_node_ids: &std::collections::BTreeSet<String>,
    ) -> Option<LanQuotaOwnerDecision> {
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
            if !trusted_node_ids.contains(&peer.node_id) {
                continue;
            }
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
        let now = unix_ms();
        self.prune_pair_state(now);
        let trusted_node_ids = secrets.trusted_lan_node_ids();
        let inbound_requests = self.inbound_pair_requests.read().clone();
        let outbound_requests = self.outbound_pair_requests.read().clone();
        let peers = self
            .collect_live_peers(now)
            .into_iter()
            .map(|mut peer| {
                peer.trusted = trusted_node_ids.contains(&peer.node_id);
                peer.pair_state = peer_pair_state(
                    &peer.node_id,
                    &trusted_node_ids,
                    &inbound_requests,
                    &outbound_requests,
                );
                peer.pair_request_id =
                    peer_pair_request_id(&peer.node_id, &inbound_requests, &outbound_requests);
                peer
            })
            .collect();
        let local_provider_fingerprints = build_provider_fingerprints(cfg, secrets);
        *self.local_provider_fingerprints.write() = local_provider_fingerprints.clone();
        LanSyncStatusSnapshot {
            enabled: true,
            discovery_port: LAN_DISCOVERY_PORT,
            heartbeat_interval_ms: LAN_HEARTBEAT_INTERVAL_MS,
            peer_stale_after_ms: LAN_PEER_STALE_AFTER_MS,
            last_peer_heartbeat_received_unix_ms: self
                .last_peer_heartbeat_received_unix_ms
                .load(Ordering::Relaxed),
            last_peer_heartbeat_source: self.last_peer_heartbeat_source.read().clone(),
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

    #[cfg(test)]
    pub(crate) fn seed_test_peer(
        &self,
        node_id: &str,
        node_name: &str,
        followed_source_node_id: Option<&str>,
    ) {
        self.peers.write().insert(
            node_id.to_string(),
            LanPeerRuntime {
                node_id: node_id.to_string(),
                node_name: sanitize_node_name(node_name),
                listen_addr: "192.168.1.10:4000".to_string(),
                last_heartbeat_unix_ms: unix_ms(),
                capabilities: LAN_HEARTBEAT_CAPABILITIES
                    .iter()
                    .map(|value| value.to_string())
                    .collect(),
                provider_fingerprints: Vec::new(),
                followed_source_node_id: followed_source_node_id.map(ToString::to_string),
            },
        );
    }

    fn note_peer_heartbeat(&self, packet: LanHeartbeatPacket, source: SocketAddr) {
        if packet.node_id.trim().is_empty() || packet.node_id == self.local_node.node_id {
            return;
        }
        let listen_addr = format!("{}:{}", source.ip(), packet.listen_port);
        self.last_peer_heartbeat_received_unix_ms
            .store(unix_ms(), Ordering::Relaxed);
        *self.last_peer_heartbeat_source.write() = Some(source.to_string());
        self.peers.write().insert(
            packet.node_id.clone(),
            LanPeerRuntime {
                node_id: packet.node_id,
                node_name: sanitize_node_name(&packet.node_name),
                listen_addr,
                last_heartbeat_unix_ms: unix_ms(),
                capabilities: packet.capabilities,
                provider_fingerprints: packet.provider_fingerprints,
                followed_source_node_id: packet.followed_source_node_id,
            },
        );
    }

    fn collect_live_peers(&self, now: u64) -> Vec<LanPeerSnapshot> {
        let should_prune = now.saturating_sub(self.last_peer_prune_unix_ms.load(Ordering::Relaxed))
            >= LAN_PEER_STALE_AFTER_MS / 2;
        let mut out = if should_prune {
            let mut peers = self.peers.write();
            peers.retain(|_, peer| !peer_is_stale(peer.last_heartbeat_unix_ms, now));
            self.last_peer_prune_unix_ms.store(now, Ordering::Relaxed);
            peers
                .values()
                .map(|peer| LanPeerSnapshot {
                    node_id: peer.node_id.clone(),
                    node_name: peer.node_name.clone(),
                    listen_addr: peer.listen_addr.clone(),
                    last_heartbeat_unix_ms: peer.last_heartbeat_unix_ms,
                    capabilities: peer.capabilities.clone(),
                    provider_fingerprints: peer.provider_fingerprints.clone(),
                    followed_source_node_id: peer.followed_source_node_id.clone(),
                    trusted: false,
                    pair_state: None,
                    pair_request_id: None,
                })
                .collect::<Vec<_>>()
        } else {
            self.peers
                .read()
                .values()
                .filter(|peer| !peer_is_stale(peer.last_heartbeat_unix_ms, now))
                .map(|peer| LanPeerSnapshot {
                    node_id: peer.node_id.clone(),
                    node_name: peer.node_name.clone(),
                    listen_addr: peer.listen_addr.clone(),
                    last_heartbeat_unix_ms: peer.last_heartbeat_unix_ms,
                    capabilities: peer.capabilities.clone(),
                    provider_fingerprints: peer.provider_fingerprints.clone(),
                    followed_source_node_id: peer.followed_source_node_id.clone(),
                    trusted: false,
                    pair_state: None,
                    pair_request_id: None,
                })
                .collect::<Vec<_>>()
        };
        out.sort_by(|a, b| {
            b.last_heartbeat_unix_ms
                .cmp(&a.last_heartbeat_unix_ms)
                .then_with(|| a.node_name.cmp(&b.node_name))
        });
        out
    }

    fn live_peer_by_node_id(&self, node_id: &str) -> Option<LanPeerSnapshot> {
        self.collect_live_peers(unix_ms())
            .into_iter()
            .find(|peer| peer.node_id == node_id)
    }

    pub fn has_alive_peers(&self) -> bool {
        !self.collect_live_peers(unix_ms()).is_empty()
    }

    pub fn request_pair(
        &self,
        gateway: &crate::orchestrator::gateway::GatewayState,
        node_id: &str,
    ) -> Result<String, String> {
        let normalized = node_id.trim();
        if normalized.is_empty() {
            return Err("node_id is required".to_string());
        }
        if gateway.secrets.is_lan_node_trusted(normalized) {
            return Err("peer is already trusted".to_string());
        }
        let now = unix_ms();
        self.prune_pair_state(now);
        if let Some(existing) = self.outbound_pair_requests.read().get(normalized).cloned() {
            if now.saturating_sub(existing.requested_at_unix_ms) < LAN_PAIR_REQUEST_THROTTLE_MS {
                return Ok(existing.request_id);
            }
        }
        let peer = self
            .live_peer_by_node_id(normalized)
            .ok_or_else(|| format!("unknown or offline peer: {normalized}"))?;
        let request_id = format!("pair_{}", Uuid::new_v4().simple());
        self.outbound_pair_requests.write().insert(
            normalized.to_string(),
            LanOutboundPairRequest {
                request_id: request_id.clone(),
                requested_at_unix_ms: now,
                approval_ready: false,
            },
        );
        let addr = peer_sync_addr(&peer)
            .ok_or_else(|| format!("peer has no valid LAN address: {normalized}"))?;
        send_wire_packet(
            addr,
            &LanWirePacket::PairRequest(LanPairRequestPacket {
                version: 1,
                request_id: request_id.clone(),
                node_id: self.local_node.node_id.clone(),
                node_name: self.local_node.node_name.clone(),
                sent_at_unix_ms: now,
            }),
        )?;
        gateway.store.add_event(
            "gateway",
            "info",
            "lan.pair.request_sent",
            "sent LAN pair request",
            serde_json::json!({
                "peer_node_id": normalized,
                "request_id": request_id,
            }),
        );
        Ok(request_id)
    }

    pub fn approve_pair(
        &self,
        gateway: &crate::orchestrator::gateway::GatewayState,
        request_id: &str,
    ) -> Result<String, String> {
        let normalized = request_id.trim();
        if normalized.is_empty() {
            return Err("request_id is required".to_string());
        }
        let now = unix_ms();
        self.prune_pair_state(now);
        let request = self
            .inbound_pair_requests
            .read()
            .values()
            .find(|entry| entry.request_id == normalized)
            .cloned()
            .ok_or_else(|| format!("unknown pair request: {normalized}"))?;
        let pin_code = format!("{:06}", fastrand::u32(0..1_000_000));
        self.pair_approvals.write().insert(
            normalized.to_string(),
            LanPairApprovalState {
                requester_node_id: request.requester_node_id.clone(),
                requester_addr: request.requester_addr,
                pin_code: pin_code.clone(),
                created_at_unix_ms: now,
            },
        );
        send_wire_packet(
            request.requester_addr,
            &LanWirePacket::PairApprovalReady(LanPairApprovalReadyPacket {
                version: 1,
                request_id: normalized.to_string(),
                node_id: self.local_node.node_id.clone(),
                node_name: self.local_node.node_name.clone(),
                sent_at_unix_ms: now,
            }),
        )?;
        gateway.store.add_event(
            "gateway",
            "info",
            "lan.pair.approved",
            "approved LAN pair request and generated PIN",
            serde_json::json!({
                "request_id": normalized,
                "requester_node_id": request.requester_node_id,
            }),
        );
        Ok(pin_code)
    }

    pub fn submit_pair_pin(
        &self,
        gateway: &crate::orchestrator::gateway::GatewayState,
        node_id: &str,
        request_id: &str,
        pin_code: &str,
    ) -> Result<(), String> {
        let normalized_node_id = node_id.trim();
        let normalized_request_id = request_id.trim();
        let normalized_pin = pin_code.trim();
        if normalized_node_id.is_empty()
            || normalized_request_id.is_empty()
            || normalized_pin.is_empty()
        {
            return Err("node_id, request_id and pin_code are required".to_string());
        }
        let now = unix_ms();
        self.prune_pair_state(now);
        let outbound = self
            .outbound_pair_requests
            .read()
            .get(normalized_node_id)
            .cloned()
            .ok_or_else(|| "no outbound pair request for that peer".to_string())?;
        if outbound.request_id != normalized_request_id {
            return Err("pair request id does not match latest outbound request".to_string());
        }
        if !outbound.approval_ready {
            return Err("pair approval is not ready yet".to_string());
        }
        let peer = self
            .live_peer_by_node_id(normalized_node_id)
            .ok_or_else(|| format!("unknown or offline peer: {normalized_node_id}"))?;
        let addr = peer_sync_addr(&peer)
            .ok_or_else(|| format!("peer has no valid LAN address: {normalized_node_id}"))?;
        self.pending_trust_bundle_pins.write().insert(
            normalized_request_id.to_string(),
            normalized_pin.to_string(),
        );
        send_wire_packet(
            addr,
            &LanWirePacket::PairPinSubmit(LanPairPinSubmitPacket {
                version: 1,
                request_id: normalized_request_id.to_string(),
                node_id: self.local_node.node_id.clone(),
                pin_code: normalized_pin.to_string(),
                sent_at_unix_ms: now,
            }),
        )?;
        gateway.store.add_event(
            "gateway",
            "info",
            "lan.pair.pin_submitted",
            "submitted LAN pairing PIN",
            serde_json::json!({
                "peer_node_id": normalized_node_id,
                "request_id": normalized_request_id,
            }),
        );
        Ok(())
    }

    fn prune_pair_state(&self, now: u64) {
        self.inbound_pair_requests.write().retain(|_, entry| {
            now.saturating_sub(entry.requested_at_unix_ms) <= LAN_PAIR_REQUEST_TTL_MS
        });
        self.outbound_pair_requests.write().retain(|_, entry| {
            now.saturating_sub(entry.requested_at_unix_ms) <= LAN_PAIR_REQUEST_TTL_MS
        });
        self.pair_approvals.write().retain(|_, entry| {
            now.saturating_sub(entry.created_at_unix_ms) <= LAN_PAIR_APPROVAL_TTL_MS
        });
    }

    pub fn request_remote_quota_refresh(
        &self,
        gateway: &crate::orchestrator::gateway::GatewayState,
        owner_node_id: &str,
        shared_provider_fingerprint: &str,
    ) -> Result<(), String> {
        let peer = self
            .live_peer_by_node_id(owner_node_id)
            .ok_or_else(|| format!("quota owner is not reachable on LAN: {owner_node_id}"))?;
        let addr = peer_sync_addr(&peer)
            .ok_or_else(|| format!("quota owner has no valid LAN address: {owner_node_id}"))?;
        send_packet_to_addr(
            gateway,
            addr,
            &LanSyncPacket::QuotaRefreshRequest(LanQuotaRefreshRequestPacket {
                version: 1,
                node_id: self.local_node.node_id.clone(),
                shared_provider_fingerprint: shared_provider_fingerprint.trim().to_string(),
            }),
        )
    }

    pub fn local_node_id(&self) -> String {
        self.local_node.node_id.clone()
    }

    pub fn local_node_name(&self) -> String {
        self.local_node.node_name.clone()
    }
}

fn lan_send_socket_state() -> &'static parking_lot::Mutex<Option<Arc<UdpSocket>>> {
    static STATE: OnceLock<parking_lot::Mutex<Option<Arc<UdpSocket>>>> = OnceLock::new();
    STATE.get_or_init(|| parking_lot::Mutex::new(None))
}

fn shared_lan_send_socket() -> Result<Arc<UdpSocket>, String> {
    let state = lan_send_socket_state();
    {
        let guard = state.lock();
        if let Some(socket) = guard.as_ref() {
            return Ok(socket.clone());
        }
    }
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|err| format!("lan send socket bind failed: {err}"))?;
    socket
        .set_broadcast(true)
        .map_err(|err| format!("lan send socket broadcast enable failed: {err}"))?;
    let socket = Arc::new(socket);
    let mut guard = state.lock();
    *guard = Some(socket.clone());
    Ok(socket)
}

fn current_lan_trust_secret(
    gateway: &crate::orchestrator::gateway::GatewayState,
) -> Result<String, String> {
    gateway
        .secrets
        .get_lan_trust_secret()
        .or_else(|| gateway.secrets.ensure_lan_trust_secret().ok())
        .ok_or_else(|| "missing lan trust secret".to_string())
}

fn lan_sync_auth_error(message: &str) -> (StatusCode, Json<Value>) {
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({
            "ok": false,
            "error": message,
        })),
    )
}

fn authorize_lan_sync_http_request(
    gateway: &crate::orchestrator::gateway::GatewayState,
    headers: &HeaderMap,
    node_id: &str,
) -> Result<(), (StatusCode, Json<Value>)> {
    let normalized_node_id = node_id.trim();
    if normalized_node_id.is_empty() {
        return Err(lan_sync_auth_error("missing LAN sync node id"));
    }
    if !gateway.secrets.is_lan_node_trusted(normalized_node_id) {
        return Err(lan_sync_auth_error("LAN sync peer is not trusted"));
    }
    let expected_secret = current_lan_trust_secret(gateway)
        .map_err(|_| lan_sync_auth_error("missing LAN trust secret"))?;
    let header_node_id = headers
        .get(LAN_SYNC_AUTH_NODE_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| lan_sync_auth_error("missing LAN sync node header"))?;
    if header_node_id != normalized_node_id {
        return Err(lan_sync_auth_error("LAN sync node header mismatch"));
    }
    let provided_secret = headers
        .get(LAN_SYNC_AUTH_SECRET_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| lan_sync_auth_error("missing LAN sync secret header"))?;
    if provided_secret != expected_secret {
        return Err(lan_sync_auth_error("invalid LAN sync secret"));
    }
    Ok(())
}

pub(crate) async fn lan_sync_usage_http(
    State(gateway): State<crate::orchestrator::gateway::GatewayState>,
    headers: HeaderMap,
    Json(packet): Json<LanUsageSyncRequestPacket>,
) -> impl IntoResponse {
    if let Err(err) = authorize_lan_sync_http_request(&gateway, &headers, &packet.node_id) {
        return err.into_response();
    }
    let (rows, has_more) = gateway.store.list_usage_request_sync_batch(
        packet.after_ingested_at_unix_ms,
        Some(packet.after_id.as_str()),
        packet.limit.clamp(1, LAN_USAGE_SYNC_BATCH_LIMIT),
    );
    Json(serde_json::json!({
        "ok": true,
        "version": 1,
        "node_id": gateway
            .secrets
            .get_lan_node_identity()
            .map(|node| node.node_id)
            .unwrap_or_default(),
        "rows": rows,
        "has_more": has_more,
    }))
    .into_response()
}

pub(crate) async fn lan_sync_edit_http(
    State(gateway): State<crate::orchestrator::gateway::GatewayState>,
    headers: HeaderMap,
    Json(packet): Json<LanEditSyncRequestPacket>,
) -> impl IntoResponse {
    if let Err(err) = authorize_lan_sync_http_request(&gateway, &headers, &packet.node_id) {
        return err.into_response();
    }
    let (events, has_more) = gateway.store.list_lan_edit_events_batch(
        packet.after_lamport_ts,
        Some(packet.after_event_id.as_str()),
        packet.limit.clamp(1, LAN_EDIT_SYNC_BATCH_LIMIT),
    );
    Json(serde_json::json!({
        "ok": true,
        "version": 1,
        "node_id": gateway
            .secrets
            .get_lan_node_identity()
            .map(|node| node.node_id)
            .unwrap_or_default(),
        "events": events,
        "has_more": has_more,
    }))
    .into_response()
}

fn lan_cipher(secret: &str) -> ChaCha20Poly1305 {
    let digest = Sha256::digest(secret.trim().as_bytes());
    ChaCha20Poly1305::new(&digest)
}

fn random_nonce_bytes() -> Result<[u8; 12], String> {
    let random = Uuid::new_v4();
    let mut nonce_bytes = [0u8; 12];
    nonce_bytes.copy_from_slice(&random.as_bytes()[..12]);
    Ok(nonce_bytes)
}

fn checked_nonce(slice: &[u8]) -> Option<Nonce> {
    if slice.len() != 12 {
        return None;
    }
    Some(Nonce::clone_from_slice(slice))
}

fn compress_lan_payload(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(bytes).map_err(|err| err.to_string())?;
    encoder.finish().map_err(|err| err.to_string())
}

fn decompress_lan_payload(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoder = ZlibDecoder::new(bytes);
    let mut out = Vec::new();
    decoder
        .read_to_end(&mut out)
        .map_err(|err| err.to_string())?;
    Ok(out)
}

fn serialize_wire_packet(
    gateway: &crate::orchestrator::gateway::GatewayState,
    packet: &LanSyncPacket,
) -> Result<Vec<u8>, String> {
    match packet {
        LanSyncPacket::Heartbeat(inner) => {
            serde_json::to_vec(&LanWirePacket::Heartbeat(inner.clone()))
                .map_err(|err| err.to_string())
        }
        _ => {
            let secret = current_lan_trust_secret(gateway)?;
            let plaintext = serde_json::to_vec(packet).map_err(|err| err.to_string())?;
            let compressed = compress_lan_payload(&plaintext)?;
            let nonce_bytes = random_nonce_bytes()?;
            let sender_node_id = gateway
                .secrets
                .get_lan_node_identity()
                .map(|node| node.node_id)
                .unwrap_or_default();
            let ciphertext = lan_cipher(&secret)
                .encrypt(
                    Nonce::from_slice(&nonce_bytes),
                    Payload {
                        msg: &compressed,
                        aad: sender_node_id.as_bytes(),
                    },
                )
                .map_err(|_| "failed to encrypt LAN packet".to_string())?;
            serde_json::to_vec(&LanWirePacket::Protected(LanProtectedPacket {
                version: 1,
                sender_node_id,
                nonce_b64: base64::engine::general_purpose::STANDARD.encode(nonce_bytes),
                ciphertext_b64: base64::engine::general_purpose::STANDARD.encode(ciphertext),
            }))
            .map_err(|err| err.to_string())
        }
    }
}

fn deserialize_wire_packet(
    gateway: &crate::orchestrator::gateway::GatewayState,
    bytes: &[u8],
) -> Option<LanSyncPacket> {
    let wire = serde_json::from_slice::<LanWirePacket>(bytes).ok()?;
    match wire {
        LanWirePacket::Heartbeat(packet) => Some(LanSyncPacket::Heartbeat(packet)),
        LanWirePacket::Protected(packet) => {
            let secret = current_lan_trust_secret(gateway).ok()?;
            let nonce = base64::engine::general_purpose::STANDARD
                .decode(packet.nonce_b64.as_bytes())
                .ok()?;
            let ciphertext = base64::engine::general_purpose::STANDARD
                .decode(packet.ciphertext_b64.as_bytes())
                .ok()?;
            let plaintext = lan_cipher(&secret)
                .decrypt(
                    &checked_nonce(&nonce)?,
                    Payload {
                        msg: &ciphertext,
                        aad: packet.sender_node_id.as_bytes(),
                    },
                )
                .ok()?;
            let decompressed = decompress_lan_payload(&plaintext).ok()?;
            serde_json::from_slice::<LanSyncPacket>(&decompressed).ok()
        }
        LanWirePacket::PairRequest(_)
        | LanWirePacket::PairApprovalReady(_)
        | LanWirePacket::PairPinSubmit(_)
        | LanWirePacket::PairTrustBundle(_) => None,
    }
}

fn pair_cipher(request_id: &str, pin_code: &str) -> ChaCha20Poly1305 {
    let digest = Sha256::digest(format!("lan-pair:{request_id}:{}", pin_code.trim()).as_bytes());
    ChaCha20Poly1305::new(&digest)
}

fn encrypt_pair_bundle(
    request_id: &str,
    pin_code: &str,
    payload: &[u8],
) -> Result<(String, String), String> {
    let nonce_bytes = random_nonce_bytes()?;
    let ciphertext = pair_cipher(request_id, pin_code)
        .encrypt(Nonce::from_slice(&nonce_bytes), payload)
        .map_err(|_| "failed to encrypt pair trust bundle".to_string())?;
    Ok((
        base64::engine::general_purpose::STANDARD.encode(nonce_bytes),
        base64::engine::general_purpose::STANDARD.encode(ciphertext),
    ))
}

fn decrypt_pair_bundle(
    request_id: &str,
    pin_code: &str,
    nonce_b64: &str,
    ciphertext_b64: &str,
) -> Option<Vec<u8>> {
    let nonce = base64::engine::general_purpose::STANDARD
        .decode(nonce_b64.as_bytes())
        .ok()?;
    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(ciphertext_b64.as_bytes())
        .ok()?;
    pair_cipher(request_id, pin_code)
        .decrypt(&checked_nonce(&nonce)?, ciphertext.as_ref())
        .ok()
}

fn send_wire_bytes(addr: SocketAddr, bytes: &[u8]) -> Result<(), String> {
    shared_lan_send_socket()?
        .send_to(bytes, addr)
        .map(|_| ())
        .map_err(|err| format!("lan send failed: {err}"))
}

fn send_wire_packet(addr: SocketAddr, packet: &LanWirePacket) -> Result<(), String> {
    let bytes = serde_json::to_vec(packet).map_err(|err| err.to_string())?;
    if bytes.len() > LAN_PACKET_SOFT_LIMIT_BYTES {
        return Err(format!(
            "LAN wire packet exceeds soft limit: {} bytes",
            bytes.len()
        ));
    }
    send_wire_bytes(addr, &bytes)
}

fn send_packet_to_addr(
    gateway: &crate::orchestrator::gateway::GatewayState,
    addr: SocketAddr,
    packet: &LanSyncPacket,
) -> Result<(), String> {
    let bytes = serialize_wire_packet(gateway, packet)?;
    if bytes.len() > LAN_PACKET_SOFT_LIMIT_BYTES {
        return Err(format!(
            "LAN packet exceeds soft limit: {} bytes",
            bytes.len()
        ));
    }
    send_wire_bytes(addr, &bytes)
}

fn broadcast_shared_health_packet(
    gateway: &crate::orchestrator::gateway::GatewayState,
    packet: &LanSharedHealthPacket,
) {
    let target = SocketAddr::from((Ipv4Addr::BROADCAST, LAN_DISCOVERY_PORT));
    let _ = send_packet_to_addr(
        gateway,
        target,
        &LanSyncPacket::SharedHealth(packet.clone()),
    );
}

fn send_heartbeat_broadcast(packet: &LanHeartbeatPacket) -> Result<(), String> {
    let target = SocketAddr::from((Ipv4Addr::BROADCAST, LAN_DISCOVERY_PORT));
    let bytes = serde_json::to_vec(&LanWirePacket::Heartbeat(packet.clone()))
        .map_err(|err| err.to_string())?;
    send_wire_bytes(target, &bytes)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProviderPricingSyncPayload {
    provider_name: String,
    pricing: Option<crate::orchestrator::secrets::ProviderPricingConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SpendManualDaySyncPayload {
    provider_name: String,
    day_key: String,
    manual_total_usd: Option<f64>,
    manual_usd_per_req: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderDefinitionSnapshotPayload {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub order_index: Option<u64>,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub usage_adapter: String,
    #[serde(default)]
    pub usage_base_url: Option<String>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub key_storage: Option<String>,
    #[serde(default)]
    pub account_email: Option<String>,
    #[serde(default)]
    pub usage_token: Option<String>,
    #[serde(default)]
    pub usage_login_username: Option<String>,
    #[serde(default)]
    pub usage_login_password: Option<String>,
}

fn persist_gateway_config(
    gateway: &crate::orchestrator::gateway::GatewayState,
    config_path: &Path,
) -> Result<(), String> {
    let cfg = gateway.cfg.read().clone();
    std::fs::write(
        config_path,
        toml::to_string_pretty(&cfg).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())
}

fn shared_provider_id_for_provider(
    secrets: &SecretStore,
    provider: &str,
) -> Result<String, String> {
    secrets.ensure_provider_shared_id(provider)
}

fn provider_definition_snapshot_payload(
    gateway: &crate::orchestrator::gateway::GatewayState,
    provider: &str,
) -> Result<ProviderDefinitionSnapshotPayload, String> {
    let cfg = gateway.cfg.read();
    let provider_cfg = cfg
        .providers
        .get(provider)
        .ok_or_else(|| format!("unknown provider: {provider}"))?;
    let usage_login = gateway.secrets.get_usage_login(provider);
    Ok(ProviderDefinitionSnapshotPayload {
        name: provider.to_string(),
        order_index: cfg
            .provider_order
            .iter()
            .position(|entry| entry == provider)
            .map(|index| index as u64),
        display_name: provider_cfg.display_name.clone(),
        base_url: provider_cfg.base_url.clone(),
        group: provider_cfg.group.clone(),
        disabled: provider_cfg.disabled,
        usage_adapter: provider_cfg.usage_adapter.clone(),
        usage_base_url: provider_cfg.usage_base_url.clone(),
        key: gateway.secrets.get_provider_key(provider),
        key_storage: Some(gateway.secrets.get_provider_key_storage_mode(provider)),
        account_email: gateway.secrets.get_provider_account_email(provider),
        usage_token: gateway.secrets.get_usage_token(provider),
        usage_login_username: usage_login.as_ref().map(|value| value.username.clone()),
        usage_login_password: usage_login.as_ref().map(|value| value.password.clone()),
    })
}

fn merge_provider_definition_snapshot_payload(
    current: Option<ProviderDefinitionSnapshotPayload>,
    payload: &Value,
) -> ProviderDefinitionSnapshotPayload {
    let mut next = current.unwrap_or_default();
    if let Some(Some(value)) = payload_string_field(payload, "name") {
        next.name = value;
    }
    if let Some(order_index) = payload
        .get("order_index")
        .and_then(|value| value.as_u64())
        .or_else(|| {
            payload
                .get("order_index")
                .and_then(|value| value.as_i64())
                .and_then(|value| (value >= 0).then_some(value as u64))
        })
    {
        next.order_index = Some(order_index);
    } else if payload.get("order_index").is_some_and(Value::is_null) {
        next.order_index = None;
    }
    if let Some(Some(value)) = payload_string_field(payload, "display_name") {
        next.display_name = value;
    }
    if let Some(Some(value)) = payload_string_field(payload, "base_url") {
        next.base_url = value;
    }
    if let Some(group) = payload_string_field(payload, "group") {
        next.group = group.and_then(|value| {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        });
    }
    if let Some(disabled) = payload_bool_field(payload, "disabled") {
        next.disabled = disabled;
    }
    if let Some(Some(value)) = payload_string_field(payload, "usage_adapter") {
        next.usage_adapter = value;
    }
    if let Some(usage_base_url) = payload_string_field(payload, "usage_base_url") {
        next.usage_base_url = usage_base_url.and_then(|value| {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        });
    }
    if let Some(value) = payload_string_field(payload, "key") {
        next.key = value.filter(|inner| !inner.trim().is_empty());
    }
    if let Some(value) = payload_string_field(payload, "key_storage") {
        next.key_storage = value.filter(|inner| !inner.trim().is_empty());
    }
    if let Some(value) = payload_string_field(payload, "account_email") {
        next.account_email = value.filter(|inner| !inner.trim().is_empty());
    }
    if let Some(value) = payload_string_field(payload, "usage_token") {
        next.usage_token = value.filter(|inner| !inner.trim().is_empty());
    }
    if let Some(value) = payload_string_field(payload, "usage_login_username") {
        next.usage_login_username = value.filter(|inner| !inner.trim().is_empty());
    }
    if let Some(value) = payload_string_field(payload, "usage_login_password") {
        next.usage_login_password = value.filter(|inner| !inner.is_empty());
    }
    next
}

pub fn record_provider_definition_patch(
    state: &crate::app_state::AppState,
    provider: &str,
    patch: Value,
) -> Result<(), String> {
    let shared_provider_id = shared_provider_id_for_provider(&state.secrets, provider)?;
    record_edit_event(
        &state.gateway,
        &state.lan_sync.local_node,
        "provider_definition",
        &shared_provider_id,
        "patch",
        patch,
    )
}

fn provider_definition_seed_meta_key(shared_provider_id: &str) -> String {
    format!("lan_provider_definition_seed:{shared_provider_id}")
}

pub fn ensure_local_edit_seed_state(state: &crate::app_state::AppState) -> Result<(), String> {
    let provider_names = state
        .gateway
        .cfg
        .read()
        .providers
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    for provider in provider_names {
        let shared_provider_id = shared_provider_id_for_provider(&state.secrets, &provider)?;
        if state
            .gateway
            .store
            .get_event_meta(&provider_definition_seed_meta_key(&shared_provider_id))
            .map_err(|err| err.to_string())?
            .is_none()
        {
            let payload = serde_json::to_value(provider_definition_snapshot_payload(
                &state.gateway,
                &provider,
            )?)
            .map_err(|err| err.to_string())?;
            record_edit_event(
                &state.gateway,
                &state.lan_sync.local_node,
                "provider_definition",
                &shared_provider_id,
                "patch",
                payload,
            )?;
            let _ = state
                .gateway
                .store
                .set_event_meta(&provider_definition_seed_meta_key(&shared_provider_id), "1");
        }
    }
    Ok(())
}

pub fn record_provider_definition_tombstone(
    state: &crate::app_state::AppState,
    provider: &str,
) -> Result<(), String> {
    let shared_provider_id = shared_provider_id_for_provider(&state.secrets, provider)?;
    record_edit_event(
        &state.gateway,
        &state.lan_sync.local_node,
        "provider_definition",
        &shared_provider_id,
        "tombstone",
        serde_json::json!({ "name": provider }),
    )
}

pub fn record_provider_pricing_snapshot(
    state: &crate::app_state::AppState,
    provider: &str,
) -> Result<(), String> {
    let shared_provider_id = shared_provider_id_for_provider(&state.secrets, provider)?;
    let mut pricing_map = state.secrets.list_provider_pricing();
    let pricing = pricing_map.remove(provider);
    let payload = serde_json::to_value(ProviderPricingSyncPayload {
        provider_name: provider.to_string(),
        pricing,
    })
    .map_err(|err| err.to_string())?;
    record_edit_event(
        &state.gateway,
        &state.lan_sync.local_node,
        "provider_pricing",
        &shared_provider_id,
        "replace",
        payload,
    )
}

pub fn record_spend_manual_day(
    state: &crate::app_state::AppState,
    provider: &str,
    day_key: &str,
    manual_total_usd: Option<f64>,
    manual_usd_per_req: Option<f64>,
) -> Result<(), String> {
    let shared_provider_id = shared_provider_id_for_provider(&state.secrets, provider)?;
    let entity_id = format!("{shared_provider_id}|{}", day_key.trim());
    let payload = serde_json::to_value(SpendManualDaySyncPayload {
        provider_name: provider.to_string(),
        day_key: day_key.trim().to_string(),
        manual_total_usd,
        manual_usd_per_req,
    })
    .map_err(|err| err.to_string())?;
    record_edit_event(
        &state.gateway,
        &state.lan_sync.local_node,
        "spend_manual_day",
        &entity_id,
        "replace",
        payload,
    )
}

fn record_edit_event(
    gateway: &crate::orchestrator::gateway::GatewayState,
    local_node: &LanNodeIdentity,
    entity_type: &str,
    entity_id: &str,
    op: &str,
    payload: Value,
) -> Result<(), String> {
    let created_at_unix_ms = unix_ms();
    let lamport_ts = gateway.store.next_lan_edit_lamport_ts(None);
    let event = crate::orchestrator::store::LanEditSyncEvent {
        event_id: format!("edit_{}", Uuid::new_v4().simple()),
        node_id: local_node.node_id.clone(),
        node_name: local_node.node_name.clone(),
        created_at_unix_ms,
        lamport_ts,
        entity_type: entity_type.to_string(),
        entity_id: entity_id.to_string(),
        op: op.to_string(),
        payload,
    };
    if gateway.store.insert_lan_edit_event(&event) {
        note_entity_version(gateway, &event);
        Ok(())
    } else {
        Err("failed to insert edit sync event".to_string())
    }
}

fn entity_version_meta_key(entity_type: &str, entity_id: &str) -> String {
    format!("lan_edit_entity_version:{entity_type}:{entity_id}")
}

fn parse_entity_version(value: &str) -> Option<(u64, String, String)> {
    let (lamport, rest) = value.split_once('|')?;
    let (node_id, event_id) = rest.split_once('|')?;
    Some((
        lamport.trim().parse::<u64>().ok()?,
        node_id.to_string(),
        event_id.to_string(),
    ))
}

fn incoming_event_is_newer(
    gateway: &crate::orchestrator::gateway::GatewayState,
    event: &crate::orchestrator::store::LanEditSyncEvent,
) -> bool {
    let current = gateway
        .store
        .get_event_meta(&entity_version_meta_key(
            &event.entity_type,
            &event.entity_id,
        ))
        .ok()
        .flatten()
        .and_then(|value| parse_entity_version(&value));
    let Some((current_lamport, current_node_id, current_event_id)) = current else {
        return true;
    };
    (
        event.lamport_ts,
        event.node_id.as_str(),
        event.event_id.as_str(),
    ) > (
        current_lamport,
        current_node_id.as_str(),
        current_event_id.as_str(),
    )
}

fn note_entity_version(
    gateway: &crate::orchestrator::gateway::GatewayState,
    event: &crate::orchestrator::store::LanEditSyncEvent,
) {
    let _ = gateway.store.set_event_meta(
        &entity_version_meta_key(&event.entity_type, &event.entity_id),
        &format!("{}|{}|{}", event.lamport_ts, event.node_id, event.event_id),
    );
}

fn payload_string_field(payload: &Value, key: &str) -> Option<Option<String>> {
    let object = payload.as_object()?;
    let value = object.get(key)?;
    if value.is_null() {
        Some(None)
    } else {
        value.as_str().map(|inner| Some(inner.to_string()))
    }
}

fn payload_bool_field(payload: &Value, key: &str) -> Option<bool> {
    payload.as_object()?.get(key)?.as_bool()
}

fn non_empty_trimmed(value: Option<String>) -> Option<String> {
    value.and_then(|inner| {
        let trimmed = inner.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn non_empty_raw(value: Option<String>) -> Option<String> {
    value.and_then(|inner| (!inner.is_empty()).then_some(inner))
}

#[allow(clippy::too_many_arguments)]
fn apply_provider_definition_patch(
    gateway: &crate::orchestrator::gateway::GatewayState,
    config_path: &Path,
    source_node_id: &str,
    source_node_name: &str,
    shared_provider_id: &str,
    lamport_ts: u64,
    revision_event_id: &str,
    payload: &Value,
) -> Result<(), String> {
    let current = gateway
        .store
        .get_lan_provider_definition_snapshot(source_node_id, shared_provider_id)
        .and_then(|record| serde_json::from_value(record.snapshot).ok());
    let merged = merge_provider_definition_snapshot_payload(current, payload);
    let provider_name = if merged.name.trim().is_empty() {
        let suffix: String = shared_provider_id.chars().take(8).collect();
        format!("shared_{suffix}")
    } else {
        merged.name.clone()
    };
    let record = crate::orchestrator::store::LanProviderDefinitionSnapshotRecord {
        source_node_id: source_node_id.to_string(),
        source_node_name: source_node_name.to_string(),
        shared_provider_id: shared_provider_id.to_string(),
        provider_name,
        deleted: false,
        snapshot: serde_json::to_value(&merged).map_err(|err| err.to_string())?,
        updated_at_unix_ms: unix_ms(),
        lamport_ts,
        revision_event_id: revision_event_id.to_string(),
    };
    gateway
        .store
        .upsert_lan_provider_definition_snapshot(&record)?;
    if gateway
        .secrets
        .get_followed_config_source_node_id()
        .as_deref()
        == Some(source_node_id)
    {
        apply_followed_provider_state(gateway, config_path, source_node_id)?;
    }
    Ok(())
}

fn apply_provider_definition_tombstone(
    gateway: &crate::orchestrator::gateway::GatewayState,
    config_path: &Path,
    source_node_id: &str,
    source_node_name: &str,
    shared_provider_id: &str,
    lamport_ts: u64,
    revision_event_id: &str,
) -> Result<(), String> {
    let provider_name = gateway
        .store
        .get_lan_provider_definition_snapshot(source_node_id, shared_provider_id)
        .map(|record| record.provider_name)
        .unwrap_or_else(|| {
            let suffix: String = shared_provider_id.chars().take(8).collect();
            format!("shared_{suffix}")
        });
    let record = crate::orchestrator::store::LanProviderDefinitionSnapshotRecord {
        source_node_id: source_node_id.to_string(),
        source_node_name: source_node_name.to_string(),
        shared_provider_id: shared_provider_id.to_string(),
        provider_name,
        deleted: true,
        snapshot: Value::Null,
        updated_at_unix_ms: unix_ms(),
        lamport_ts,
        revision_event_id: revision_event_id.to_string(),
    };
    gateway
        .store
        .upsert_lan_provider_definition_snapshot(&record)?;
    if gateway
        .secrets
        .get_followed_config_source_node_id()
        .as_deref()
        == Some(source_node_id)
    {
        apply_followed_provider_state(gateway, config_path, source_node_id)?;
    }
    Ok(())
}

fn apply_provider_pricing_event(
    gateway: &crate::orchestrator::gateway::GatewayState,
    shared_provider_id: &str,
    payload: &Value,
) -> Result<(), String> {
    let payload: ProviderPricingSyncPayload =
        serde_json::from_value(payload.clone()).map_err(|err| err.to_string())?;
    let provider_name = if let Some(provider_name) = gateway
        .secrets
        .find_provider_by_shared_id(shared_provider_id)
    {
        provider_name
    } else if !payload.provider_name.trim().is_empty()
        && gateway
            .cfg
            .read()
            .providers
            .contains_key(&payload.provider_name)
    {
        gateway
            .secrets
            .set_provider_shared_id(&payload.provider_name, shared_provider_id)?;
        payload.provider_name.clone()
    } else {
        return Err(format!("unknown shared provider id: {shared_provider_id}"));
    };
    gateway
        .secrets
        .replace_provider_pricing_config(&provider_name, payload.pricing)?;
    gateway
        .store
        .sync_provider_pricing_configs(&gateway.secrets.list_provider_pricing());
    Ok(())
}

fn apply_spend_manual_day_event(
    gateway: &crate::orchestrator::gateway::GatewayState,
    entity_id: &str,
    payload: &Value,
) -> Result<(), String> {
    let payload: SpendManualDaySyncPayload =
        serde_json::from_value(payload.clone()).map_err(|err| err.to_string())?;
    let (shared_provider_id, _) = entity_id
        .split_once('|')
        .ok_or_else(|| format!("invalid spend manual entity id: {entity_id}"))?;
    let provider_name = if let Some(provider_name) = gateway
        .secrets
        .find_provider_by_shared_id(shared_provider_id)
    {
        provider_name
    } else if !payload.provider_name.trim().is_empty()
        && gateway
            .cfg
            .read()
            .providers
            .contains_key(&payload.provider_name)
    {
        gateway
            .secrets
            .set_provider_shared_id(&payload.provider_name, shared_provider_id)?;
        payload.provider_name.clone()
    } else {
        return Err(format!("unknown shared provider id: {shared_provider_id}"));
    };
    if payload.manual_total_usd.is_none() && payload.manual_usd_per_req.is_none() {
        gateway
            .store
            .remove_spend_manual_day(&provider_name, &payload.day_key);
    } else {
        let row = serde_json::json!({
            "provider": provider_name,
            "day_key": payload.day_key,
            "manual_total_usd": payload.manual_total_usd,
            "manual_usd_per_req": payload.manual_usd_per_req,
            "updated_at_unix_ms": unix_ms(),
        });
        gateway
            .store
            .put_spend_manual_day(&provider_name, &payload.day_key, &row);
    }
    Ok(())
}

fn apply_lan_edit_event(
    gateway: &crate::orchestrator::gateway::GatewayState,
    config_path: &Path,
    event: &crate::orchestrator::store::LanEditSyncEvent,
) -> Result<(), String> {
    match event.entity_type.as_str() {
        "provider_definition" => match event.op.as_str() {
            "patch" => apply_provider_definition_patch(
                gateway,
                config_path,
                &event.node_id,
                &event.node_name,
                &event.entity_id,
                event.lamport_ts,
                &event.event_id,
                &event.payload,
            ),
            "tombstone" => apply_provider_definition_tombstone(
                gateway,
                config_path,
                &event.node_id,
                &event.node_name,
                &event.entity_id,
                event.lamport_ts,
                &event.event_id,
            ),
            other => Err(format!("unsupported provider_definition op: {other}")),
        },
        "provider_pricing" => {
            apply_provider_pricing_event(gateway, &event.entity_id, &event.payload)
        }
        "spend_manual_day" => {
            apply_spend_manual_day_event(gateway, &event.entity_id, &event.payload)
        }
        other => Err(format!("unsupported edit entity type: {other}")),
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
    loop {
        let socket = match UdpSocket::bind((Ipv4Addr::UNSPECIFIED, LAN_DISCOVERY_PORT)) {
            Ok(socket) => socket,
            Err(err) => {
                log::warn!(
                    "lan sync listener bind failed on {}: {err}",
                    LAN_DISCOVERY_PORT
                );
                std::thread::sleep(Duration::from_millis(LAN_SOCKET_RETRY_MS));
                continue;
            }
        };
        let _ = socket.set_read_timeout(Some(Duration::from_millis(1_500)));
        let mut buf = [0_u8; 64 * 1024];
        loop {
            match socket.recv_from(&mut buf) {
                Ok((len, source)) => {
                    let Ok(wire_packet) = serde_json::from_slice::<LanWirePacket>(&buf[..len])
                    else {
                        continue;
                    };
                    match wire_packet {
                        LanWirePacket::Heartbeat(packet) => {
                            runtime.note_peer_heartbeat(packet, source)
                        }
                        LanWirePacket::Protected(packet) => {
                            let Some(decoded) = deserialize_wire_packet(
                                &gateway,
                                &serde_json::to_vec(&LanWirePacket::Protected(packet))
                                    .ok()
                                    .unwrap_or_default(),
                            ) else {
                                continue;
                            };
                            match decoded {
                                LanSyncPacket::Heartbeat(packet) => {
                                    runtime.note_peer_heartbeat(packet, source)
                                }
                                LanSyncPacket::SharedHealth(packet) => {
                                    apply_shared_health_packet(&runtime, &gateway, packet);
                                }
                                LanSyncPacket::QuotaRefreshRequest(packet) => {
                                    handle_quota_refresh_request(&runtime, &gateway, packet);
                                }
                            }
                        }
                        LanWirePacket::PairRequest(packet) => {
                            handle_pair_request(&runtime, &gateway, source, packet);
                        }
                        LanWirePacket::PairApprovalReady(packet) => {
                            handle_pair_approval_ready(&runtime, &gateway, packet);
                        }
                        LanWirePacket::PairPinSubmit(packet) => {
                            handle_pair_pin_submit(&runtime, &gateway, source, packet);
                        }
                        LanWirePacket::PairTrustBundle(packet) => {
                            handle_pair_trust_bundle(&runtime, &gateway, packet);
                        }
                    }
                }
                Err(err)
                    if err.kind() == std::io::ErrorKind::WouldBlock
                        || err.kind() == std::io::ErrorKind::TimedOut => {}
                Err(err) => {
                    log::warn!("lan sync listener recv failed: {err}");
                    break;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(750));
    }
}

fn run_sender(runtime: LanSyncRuntime, gateway: crate::orchestrator::gateway::GatewayState) {
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
            followed_source_node_id: gateway.secrets.get_followed_config_source_node_id(),
        });
        if let LanSyncPacket::Heartbeat(ref heartbeat) = packet {
            if let Err(err) = send_heartbeat_broadcast(heartbeat) {
                log::warn!("lan sync sender heartbeat failed: {err}");
                std::thread::sleep(Duration::from_millis(LAN_SOCKET_RETRY_MS));
                continue;
            }
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

fn handle_pair_request(
    runtime: &LanSyncRuntime,
    gateway: &crate::orchestrator::gateway::GatewayState,
    source: SocketAddr,
    packet: LanPairRequestPacket,
) {
    let normalized_node_id = packet.node_id.trim();
    if normalized_node_id.is_empty() || normalized_node_id == runtime.local_node.node_id {
        return;
    }
    if gateway.secrets.is_lan_node_trusted(normalized_node_id) {
        return;
    }
    let now = unix_ms();
    runtime.prune_pair_state(now);
    let mut requests = runtime.inbound_pair_requests.write();
    if let Some(existing) = requests.get(normalized_node_id) {
        if now.saturating_sub(existing.requested_at_unix_ms) < LAN_PAIR_REQUEST_THROTTLE_MS {
            return;
        }
    }
    requests.insert(
        normalized_node_id.to_string(),
        LanPendingPairRequest {
            request_id: packet.request_id.clone(),
            requester_node_id: normalized_node_id.to_string(),
            requested_at_unix_ms: now,
            requester_addr: SocketAddr::new(source.ip(), LAN_DISCOVERY_PORT),
        },
    );
    gateway.store.add_event(
        "gateway",
        "info",
        "lan.pair.request_received",
        "received LAN pair request",
        serde_json::json!({
            "request_id": packet.request_id,
            "requester_node_id": normalized_node_id,
            "requester_node_name": packet.node_name,
            "requester_addr": source.to_string(),
        }),
    );
}

fn handle_pair_approval_ready(
    runtime: &LanSyncRuntime,
    gateway: &crate::orchestrator::gateway::GatewayState,
    packet: LanPairApprovalReadyPacket,
) {
    let normalized_node_id = packet.node_id.trim();
    if normalized_node_id.is_empty() {
        return;
    }
    let mut outbound = runtime.outbound_pair_requests.write();
    let Some(request) = outbound.get_mut(normalized_node_id) else {
        return;
    };
    if request.request_id != packet.request_id {
        return;
    }
    request.approval_ready = true;
    gateway.store.add_event(
        "gateway",
        "info",
        "lan.pair.approval_ready",
        "remote LAN pair approval is ready for PIN entry",
        serde_json::json!({
            "request_id": packet.request_id,
            "peer_node_id": normalized_node_id,
            "peer_node_name": packet.node_name,
        }),
    );
}

fn handle_pair_pin_submit(
    runtime: &LanSyncRuntime,
    gateway: &crate::orchestrator::gateway::GatewayState,
    _source: SocketAddr,
    packet: LanPairPinSubmitPacket,
) {
    let normalized_node_id = packet.node_id.trim();
    if normalized_node_id.is_empty() {
        return;
    }
    let Some(approval) = runtime
        .pair_approvals
        .read()
        .get(packet.request_id.as_str())
        .cloned()
    else {
        gateway.store.add_event(
            "gateway",
            "warning",
            "lan.pair.pin_rejected_missing_approval",
            "rejected LAN pairing PIN because no approval state exists",
            serde_json::json!({
                "request_id": packet.request_id,
                "requester_node_id": normalized_node_id,
            }),
        );
        return;
    };
    if approval.requester_node_id != normalized_node_id
        || approval.pin_code != packet.pin_code.trim()
    {
        gateway.store.add_event(
            "gateway",
            "warning",
            "lan.pair.pin_rejected_mismatch",
            "rejected LAN pairing PIN due to request or PIN mismatch",
            serde_json::json!({
                "request_id": packet.request_id,
                "requester_node_id": normalized_node_id,
                "expected_requester_node_id": approval.requester_node_id,
            }),
        );
        return;
    }
    let trust_secret = match gateway.secrets.ensure_lan_trust_secret() {
        Ok(value) => value,
        Err(_) => return,
    };
    let payload = serde_json::json!({
        "lan_trust_secret": trust_secret,
        "trusted_node_id": runtime.local_node.node_id,
    });
    let Ok(payload_bytes) = serde_json::to_vec(&payload) else {
        return;
    };
    let Ok((nonce_b64, ciphertext_b64)) =
        encrypt_pair_bundle(&packet.request_id, &approval.pin_code, &payload_bytes)
    else {
        return;
    };
    let _ = gateway
        .secrets
        .set_lan_node_trusted(&approval.requester_node_id, true);
    runtime
        .inbound_pair_requests
        .write()
        .remove(&approval.requester_node_id);
    runtime
        .pair_approvals
        .write()
        .remove(packet.request_id.as_str());
    gateway.store.add_event(
        "gateway",
        "info",
        "lan.pair.pin_accepted",
        "accepted LAN pairing PIN and sent trust bundle",
        serde_json::json!({
            "request_id": packet.request_id,
            "requester_node_id": approval.requester_node_id,
        }),
    );
    let _ = send_wire_packet(
        approval.requester_addr,
        &LanWirePacket::PairTrustBundle(LanPairTrustBundlePacket {
            version: 1,
            request_id: packet.request_id,
            node_id: runtime.local_node.node_id.clone(),
            nonce_b64,
            ciphertext_b64,
            sent_at_unix_ms: unix_ms(),
        }),
    );
}

fn handle_pair_trust_bundle(
    runtime: &LanSyncRuntime,
    gateway: &crate::orchestrator::gateway::GatewayState,
    packet: LanPairTrustBundlePacket,
) {
    let Some(pin_code) = runtime
        .pending_trust_bundle_pins
        .write()
        .remove(packet.request_id.as_str())
    else {
        gateway.store.add_event(
            "gateway",
            "warning",
            "lan.pair.trust_bundle_ignored_missing_pin",
            "ignored LAN trust bundle because no pending PIN exists",
            serde_json::json!({
                "request_id": packet.request_id,
                "peer_node_id": packet.node_id,
            }),
        );
        return;
    };
    let Some(plaintext) = decrypt_pair_bundle(
        &packet.request_id,
        &pin_code,
        &packet.nonce_b64,
        &packet.ciphertext_b64,
    ) else {
        gateway.store.add_event(
            "gateway",
            "warning",
            "lan.pair.trust_bundle_decrypt_failed",
            "failed to decrypt LAN trust bundle with submitted PIN",
            serde_json::json!({
                "request_id": packet.request_id,
                "peer_node_id": packet.node_id,
            }),
        );
        return;
    };
    let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&plaintext) else {
        return;
    };
    let Some(trust_secret) = payload
        .get("lan_trust_secret")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    let trusted_node_id = payload
        .get("trusted_node_id")
        .and_then(|value| value.as_str())
        .unwrap_or(packet.node_id.as_str());
    let _ = gateway.secrets.set_lan_trust_secret(trust_secret);
    let _ = gateway.secrets.set_lan_node_trusted(trusted_node_id, true);
    runtime
        .outbound_pair_requests
        .write()
        .remove(packet.node_id.as_str());
    gateway.store.add_event(
        "gateway",
        "info",
        "lan.pair.trust_bundle_applied",
        "applied LAN trust bundle and trusted peer",
        serde_json::json!({
            "request_id": packet.request_id,
            "peer_node_id": packet.node_id,
            "trusted_node_id": trusted_node_id,
        }),
    );
}

fn peer_sync_addr(peer: &LanPeerSnapshot) -> Option<SocketAddr> {
    let host = peer.listen_addr.split(':').next()?.trim();
    let ip: Ipv4Addr = host.parse().ok()?;
    Some(SocketAddr::from((ip, LAN_DISCOVERY_PORT)))
}

fn peer_http_base_url(peer: &LanPeerSnapshot) -> Option<String> {
    let trimmed = peer.listen_addr.trim();
    (!trimmed.is_empty()).then(|| format!("http://{trimmed}"))
}

fn lan_sync_http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .gzip(true)
            .brotli(true)
            .deflate(true)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

fn peer_pair_state(
    node_id: &str,
    trusted_node_ids: &std::collections::BTreeSet<String>,
    inbound_requests: &HashMap<String, LanPendingPairRequest>,
    outbound_requests: &HashMap<String, LanOutboundPairRequest>,
) -> Option<String> {
    if trusted_node_ids.contains(node_id) {
        return Some("trusted".to_string());
    }
    if inbound_requests.contains_key(node_id) {
        return Some("incoming_request".to_string());
    }
    outbound_requests.get(node_id).map(|entry| {
        if entry.approval_ready {
            "pin_required".to_string()
        } else {
            "requested".to_string()
        }
    })
}

fn peer_pair_request_id(
    node_id: &str,
    inbound_requests: &HashMap<String, LanPendingPairRequest>,
    outbound_requests: &HashMap<String, LanOutboundPairRequest>,
) -> Option<String> {
    inbound_requests
        .get(node_id)
        .map(|entry| entry.request_id.clone())
        .or_else(|| {
            outbound_requests
                .get(node_id)
                .map(|entry| entry.request_id.clone())
        })
}

fn usage_sync_cursor_key(peer_node_id: &str) -> String {
    format!("lan_usage_sync_cursor:{peer_node_id}")
}

fn edit_sync_cursor_key(peer_node_id: &str) -> String {
    format!("lan_edit_sync_cursor:{peer_node_id}")
}

fn load_usage_sync_cursor(
    gateway: &crate::orchestrator::gateway::GatewayState,
    peer_node_id: &str,
) -> (u64, String) {
    let Ok(Some(value)) = gateway
        .store
        .get_event_meta(&usage_sync_cursor_key(peer_node_id))
    else {
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

fn load_edit_sync_cursor(
    gateway: &crate::orchestrator::gateway::GatewayState,
    peer_node_id: &str,
) -> (u64, String) {
    let Ok(Some(value)) = gateway
        .store
        .get_event_meta(&edit_sync_cursor_key(peer_node_id))
    else {
        return (0, String::new());
    };
    let Some((left, right)) = value.split_once('|') else {
        return (0, String::new());
    };
    (left.trim().parse::<u64>().unwrap_or(0), right.to_string())
}

fn save_edit_sync_cursor(
    gateway: &crate::orchestrator::gateway::GatewayState,
    peer_node_id: &str,
    after_lamport_ts: u64,
    after_event_id: &str,
) {
    let _ = gateway.store.set_event_meta(
        &edit_sync_cursor_key(peer_node_id),
        &format!("{after_lamport_ts}|{after_event_id}"),
    );
}

async fn fetch_usage_sync_batch_http(
    runtime: &LanSyncRuntime,
    gateway: &crate::orchestrator::gateway::GatewayState,
    peer: &LanPeerSnapshot,
) -> Result<LanUsageSyncBatchPacket, String> {
    let base_url = peer_http_base_url(peer)
        .ok_or_else(|| format!("peer has no valid HTTP listen address: {}", peer.node_id))?;
    let (after_ingested_at_unix_ms, after_id) = load_usage_sync_cursor(gateway, &peer.node_id);
    let trust_secret = current_lan_trust_secret(gateway)?;
    let response = lan_sync_http_client()
        .post(format!("{base_url}/lan-sync/usage"))
        .header(
            LAN_SYNC_AUTH_NODE_ID_HEADER,
            runtime.local_node.node_id.clone(),
        )
        .header(LAN_SYNC_AUTH_SECRET_HEADER, trust_secret)
        .json(&LanUsageSyncRequestPacket {
            version: 1,
            node_id: runtime.local_node.node_id.clone(),
            after_ingested_at_unix_ms,
            after_id,
            limit: LAN_USAGE_SYNC_BATCH_LIMIT,
        })
        .send()
        .await
        .map_err(|err| format!("LAN usage sync request failed: {err}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("LAN usage sync http {status}: {body}"));
    }
    response
        .json::<LanUsageSyncBatchPacket>()
        .await
        .map_err(|err| format!("LAN usage sync response decode failed: {err}"))
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

async fn fetch_edit_sync_batch_http(
    runtime: &LanSyncRuntime,
    gateway: &crate::orchestrator::gateway::GatewayState,
    peer: &LanPeerSnapshot,
) -> Result<LanEditSyncBatchPacket, String> {
    let base_url = peer_http_base_url(peer)
        .ok_or_else(|| format!("peer has no valid HTTP listen address: {}", peer.node_id))?;
    let (after_lamport_ts, after_event_id) = load_edit_sync_cursor(gateway, &peer.node_id);
    let trust_secret = current_lan_trust_secret(gateway)?;
    let response = lan_sync_http_client()
        .post(format!("{base_url}/lan-sync/edit"))
        .header(
            LAN_SYNC_AUTH_NODE_ID_HEADER,
            runtime.local_node.node_id.clone(),
        )
        .header(LAN_SYNC_AUTH_SECRET_HEADER, trust_secret)
        .json(&LanEditSyncRequestPacket {
            version: 1,
            node_id: runtime.local_node.node_id.clone(),
            after_lamport_ts,
            after_event_id,
            limit: LAN_EDIT_SYNC_BATCH_LIMIT,
        })
        .send()
        .await
        .map_err(|err| format!("LAN edit sync request failed: {err}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("LAN edit sync http {status}: {body}"));
    }
    response
        .json::<LanEditSyncBatchPacket>()
        .await
        .map_err(|err| format!("LAN edit sync response decode failed: {err}"))
}

fn handle_quota_refresh_request(
    runtime: &LanSyncRuntime,
    gateway: &crate::orchestrator::gateway::GatewayState,
    packet: LanQuotaRefreshRequestPacket,
) {
    if packet.node_id.trim().is_empty() || packet.node_id == runtime.local_node.node_id {
        return;
    }
    let fingerprint = packet.shared_provider_fingerprint.trim();
    if fingerprint.is_empty() {
        return;
    }
    let trusted_node_ids = gateway.secrets.trusted_lan_node_ids();
    let Some(owner) = runtime.quota_owner_for_fingerprint(fingerprint, &trusted_node_ids) else {
        return;
    };
    if !owner.local_is_owner {
        return;
    }
    let cfg = gateway.cfg.read().clone();
    let Some(provider_name) = cfg.providers.keys().find(|provider_name| {
        crate::orchestrator::quota::shared_provider_fingerprint(
            &cfg,
            &gateway.secrets,
            provider_name,
        )
        .as_deref()
            == Some(fingerprint)
    }) else {
        return;
    };
    let provider_name = provider_name.clone();
    let gateway = gateway.clone();
    let runtime = runtime.clone();
    tauri::async_runtime::spawn(async move {
        match crate::orchestrator::quota::refresh_quota_shared(&gateway, &runtime, &provider_name)
            .await
        {
            Ok(group) => gateway.store.add_event(
                "gateway",
                "info",
                "lan.quota_refresh_forwarded_succeeded",
                &format!(
                    "remote quota refresh request succeeded for {} provider(s)",
                    group.len()
                ),
                serde_json::json!({
                    "provider": provider_name,
                    "providers": group,
                }),
            ),
            Err(err) => gateway.store.add_event(
                "gateway",
                "warning",
                "lan.quota_refresh_forwarded_failed",
                &format!("remote quota refresh request failed: {err}"),
                serde_json::json!({
                    "provider": provider_name,
                }),
            ),
        }
    });
}

fn apply_edit_sync_batch(
    runtime: &LanSyncRuntime,
    gateway: &crate::orchestrator::gateway::GatewayState,
    config_path: &Path,
    packet: LanEditSyncBatchPacket,
) {
    if packet.node_id.trim().is_empty() || packet.node_id == runtime.local_node.node_id {
        return;
    }
    if packet.events.is_empty() {
        return;
    }
    let mut applied = 0usize;
    for event in &packet.events {
        gateway.store.note_lan_edit_lamport_ts(event.lamport_ts);
        if !gateway.store.insert_lan_edit_event(event) {
            continue;
        }
        if !incoming_event_is_newer(gateway, event) {
            continue;
        }
        if apply_lan_edit_event(gateway, config_path, event).is_ok() {
            note_entity_version(gateway, event);
            applied = applied.saturating_add(1);
        }
    }
    if let Some(last_event) = packet.events.last() {
        save_edit_sync_cursor(
            gateway,
            &packet.node_id,
            last_event.lamport_ts,
            &last_event.event_id,
        );
    }
    if applied > 0 {
        gateway.store.add_event(
            "gateway",
            "info",
            "lan.edit_sync_applied",
            &format!("applied {applied} synced editable event(s)"),
            serde_json::json!({
                "source_node_id": packet.node_id,
                "received_events": packet.events.len(),
                "applied_events": applied,
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
            if !peer
                .capabilities
                .iter()
                .any(|value| value == "usage_sync_v1")
            {
                continue;
            }
            loop {
                let batch = match tauri::async_runtime::block_on(fetch_usage_sync_batch_http(
                    &runtime, &gateway, &peer,
                )) {
                    Ok(batch) => batch,
                    Err(err) => {
                        gateway.store.add_event(
                            "gateway",
                            "warning",
                            "lan.usage_sync_http_failed",
                            &err,
                            serde_json::json!({
                                "peer_node_id": peer.node_id,
                            }),
                        );
                        break;
                    }
                };
                let has_more = batch.has_more;
                if batch.rows.is_empty() {
                    break;
                }
                apply_usage_sync_batch(&runtime, &gateway, batch);
                if !has_more {
                    break;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(LAN_USAGE_SYNC_LOOP_INTERVAL_MS));
    }
}

fn run_edit_sync_loop(
    runtime: LanSyncRuntime,
    gateway: crate::orchestrator::gateway::GatewayState,
    config_path: std::path::PathBuf,
) {
    loop {
        let peers = runtime.collect_live_peers(unix_ms());
        for peer in peers {
            if !peer
                .capabilities
                .iter()
                .any(|value| value == "edit_sync_v1")
            {
                continue;
            }
            loop {
                let batch = match tauri::async_runtime::block_on(fetch_edit_sync_batch_http(
                    &runtime, &gateway, &peer,
                )) {
                    Ok(batch) => batch,
                    Err(err) => {
                        gateway.store.add_event(
                            "gateway",
                            "warning",
                            "lan.edit_sync_http_failed",
                            &err,
                            serde_json::json!({
                                "peer_node_id": peer.node_id,
                            }),
                        );
                        break;
                    }
                };
                let has_more = batch.has_more;
                if batch.events.is_empty() {
                    break;
                }
                apply_edit_sync_batch(&runtime, &gateway, &config_path, batch);
                if !has_more {
                    break;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(LAN_EDIT_SYNC_LOOP_INTERVAL_MS));
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
            broadcast_shared_health_packet(
                &gateway,
                &LanSharedHealthPacket {
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
                },
            );
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
            let trusted_node_ids = gateway.secrets.trusted_lan_node_ids();
            let Some(owner) = runtime.quota_owner_for_fingerprint(&fingerprint, &trusted_node_ids)
            else {
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

pub(crate) fn detect_local_listen_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(8, 8, 8, 8), 80)).ok()?;
    let addr = socket.local_addr().ok()?;
    let ip = addr.ip();
    if ip.is_loopback() || !ip.is_ipv4() {
        return None;
    }
    Some(ip)
}

fn detect_local_listen_addr(listen_port: u16) -> Option<String> {
    detect_local_listen_ip().map(|ip| format!("{}:{}", ip, listen_port))
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
        apply_followed_provider_state, apply_lan_edit_event, deserialize_wire_packet,
        incoming_event_is_newer, lan_sync_edit_http, lan_sync_usage_http, note_entity_version,
        peer_is_stale, restore_local_provider_state, sanitize_node_name, serialize_wire_packet,
        LanEditSyncRequestPacket, LanHeartbeatPacket, LanNodeIdentity, LanSyncPacket,
        LanSyncRuntime, LanUsageSyncRequestPacket, LAN_PEER_STALE_AFTER_MS,
        LAN_SYNC_AUTH_NODE_ID_HEADER, LAN_SYNC_AUTH_SECRET_HEADER,
    };
    use crate::orchestrator::store::{LanEditSyncEvent, UsageRequestSyncRow};
    use axum::body::to_bytes;
    use axum::extract::{Json, State};
    use axum::http::{HeaderMap, HeaderValue, StatusCode};
    use axum::response::IntoResponse;
    use base64::Engine;
    use serde_json::Value;

    fn build_test_state() -> (tempfile::TempDir, crate::app_state::AppState) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("user-data").join("data");
        let state = crate::app_state::build_state(config_path, data_dir).expect("build state");
        (tmp, state)
    }

    fn build_test_state_with_broken_secrets_path() -> (tempfile::TempDir, crate::app_state::AppState)
    {
        let tmp = tempfile::tempdir().expect("tempdir");
        let user_data = tmp.path().join("user-data");
        let config_path = user_data.join("config.toml");
        let data_dir = user_data.join("data");
        std::fs::create_dir_all(&user_data).expect("create user-data dir");
        let state = crate::app_state::build_state(config_path, data_dir).expect("build state");
        let secrets_path = state.secrets.path().to_path_buf();
        if secrets_path.exists() {
            std::fs::remove_file(&secrets_path).expect("remove secrets file");
        }
        std::fs::create_dir_all(&secrets_path).expect("create broken secrets dir");
        (tmp, state)
    }

    fn lan_sync_headers(node_id: &str, trust_secret: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            LAN_SYNC_AUTH_NODE_ID_HEADER,
            HeaderValue::from_str(node_id).expect("node id header"),
        );
        headers.insert(
            LAN_SYNC_AUTH_SECRET_HEADER,
            HeaderValue::from_str(trust_secret).expect("trust secret header"),
        );
        headers
    }

    #[test]
    fn sanitize_node_name_trims_and_limits_length() {
        let value = sanitize_node_name("  My/Desk*Top Node Name With Extra Characters  ");
        assert_eq!(value, "My-Desk-Top Node Name With Extra Characters");
        assert!(sanitize_node_name("").contains("api-router-node"));
    }

    #[tokio::test]
    async fn lan_sync_usage_http_rejects_invalid_secret() {
        let (_tmp, state) = build_test_state();
        let trust_secret = state
            .secrets
            .ensure_lan_trust_secret()
            .expect("trust secret");
        state
            .secrets
            .set_lan_node_trusted("node-remote", true)
            .expect("trust peer");
        let response = lan_sync_usage_http(
            State(state.gateway.clone()),
            lan_sync_headers("node-remote", &format!("{trust_secret}-wrong")),
            Json(LanUsageSyncRequestPacket {
                version: 1,
                node_id: "node-remote".to_string(),
                after_ingested_at_unix_ms: 0,
                after_id: String::new(),
                limit: 10,
            }),
        )
        .await
        .into_response();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn lan_sync_http_endpoints_return_usage_and_edit_payloads() {
        let (_tmp, state) = build_test_state();
        let trust_secret = state
            .secrets
            .ensure_lan_trust_secret()
            .expect("trust secret");
        state
            .secrets
            .set_lan_node_trusted("node-remote", true)
            .expect("trust peer");
        assert_eq!(
            state
                .gateway
                .store
                .upsert_usage_request_sync_rows(&[UsageRequestSyncRow {
                    id: "usage-row-1".to_string(),
                    unix_ms: crate::orchestrator::store::unix_ms(),
                    ingested_at_unix_ms: crate::orchestrator::store::unix_ms(),
                    provider: "official".to_string(),
                    api_key_ref: "sk-test".to_string(),
                    model: "gpt-5".to_string(),
                    origin: crate::constants::USAGE_ORIGIN_WINDOWS.to_string(),
                    session_id: "session-1".to_string(),
                    node_id: "node-local".to_string(),
                    node_name: "Desk Local".to_string(),
                    input_tokens: 10,
                    output_tokens: 5,
                    total_tokens: 15,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                }]),
            1
        );
        let edit_event = LanEditSyncEvent {
            event_id: "evt-lan-http".to_string(),
            node_id: state.lan_sync.local_node_id(),
            node_name: state.lan_sync.local_node_name(),
            created_at_unix_ms: crate::orchestrator::store::unix_ms(),
            lamport_ts: 1,
            entity_type: "provider_definition".to_string(),
            entity_id: "shared-official".to_string(),
            op: "patch".to_string(),
            payload: serde_json::json!({
                "name": "official",
                "display_name": "Official",
            }),
        };
        assert!(state.gateway.store.insert_lan_edit_event(&edit_event));

        let usage_response = lan_sync_usage_http(
            State(state.gateway.clone()),
            lan_sync_headers("node-remote", &trust_secret),
            Json(LanUsageSyncRequestPacket {
                version: 1,
                node_id: "node-remote".to_string(),
                after_ingested_at_unix_ms: 0,
                after_id: String::new(),
                limit: 10,
            }),
        )
        .await
        .into_response();
        assert_eq!(usage_response.status(), StatusCode::OK);
        let usage_body = to_bytes(usage_response.into_body(), usize::MAX)
            .await
            .expect("usage body");
        let usage_json: Value = serde_json::from_slice(&usage_body).expect("usage json");
        let usage_rows = usage_json
            .get("rows")
            .and_then(|value| value.as_array())
            .expect("usage rows");
        assert!(usage_rows
            .iter()
            .any(|row| { row.get("id").and_then(|value| value.as_str()) == Some("usage-row-1") }));

        let edit_response = lan_sync_edit_http(
            State(state.gateway.clone()),
            lan_sync_headers("node-remote", &trust_secret),
            Json(LanEditSyncRequestPacket {
                version: 1,
                node_id: "node-remote".to_string(),
                after_lamport_ts: 0,
                after_event_id: String::new(),
                limit: 10,
            }),
        )
        .await
        .into_response();
        assert_eq!(edit_response.status(), StatusCode::OK);
        let edit_body = to_bytes(edit_response.into_body(), usize::MAX)
            .await
            .expect("edit body");
        let edit_json: Value = serde_json::from_slice(&edit_body).expect("edit json");
        let edit_events = edit_json
            .get("events")
            .and_then(|value| value.as_array())
            .expect("edit events");
        assert!(edit_events.iter().any(|event| {
            event.get("event_id").and_then(|value| value.as_str()) == Some("evt-lan-http")
        }));
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
    fn protected_packets_require_matching_lan_trust_secret() {
        let (_tmp_a, state_a) = build_test_state();
        let (_tmp_b, state_b) = build_test_state();
        state_a
            .secrets
            .ensure_lan_trust_secret()
            .expect("trust secret a");
        state_b
            .secrets
            .ensure_lan_trust_secret()
            .expect("trust secret b");

        let protected = serialize_wire_packet(
            &state_a.gateway,
            &LanSyncPacket::SharedHealth(super::LanSharedHealthPacket {
                version: 1,
                node_id: state_a.lan_sync.local_node_id(),
                node_name: state_a.lan_sync.local_node_name(),
                sent_at_unix_ms: 1,
                shared_provider_fingerprint: "fp-1".to_string(),
                status: "cooldown".to_string(),
                consecutive_failures: 3,
                cooldown_until_unix_ms: 10,
                last_error: "http 500".to_string(),
                last_ok_at_unix_ms: 0,
                last_fail_at_unix_ms: 1,
                shared_probe_required: true,
            }),
        )
        .expect("serialize protected");

        let packet_a = deserialize_wire_packet(&state_a.gateway, &protected);
        let packet_b = deserialize_wire_packet(&state_b.gateway, &protected);

        assert!(matches!(packet_a, Some(LanSyncPacket::SharedHealth(_))));
        assert!(packet_b.is_none());
    }

    #[test]
    fn heartbeat_packets_remain_plain_discovery_messages() {
        let (_tmp, state) = build_test_state();
        let bytes = serialize_wire_packet(
            &state.gateway,
            &LanSyncPacket::Heartbeat(LanHeartbeatPacket {
                version: 1,
                node_id: "node-x".to_string(),
                node_name: "Desk".to_string(),
                listen_port: 4000,
                sent_at_unix_ms: 1,
                capabilities: vec!["heartbeat_v1".to_string()],
                provider_fingerprints: vec![],
                followed_source_node_id: None,
            }),
        )
        .expect("serialize heartbeat");

        let decoded = deserialize_wire_packet(&state.gateway, &bytes);

        assert!(matches!(decoded, Some(LanSyncPacket::Heartbeat(_))));
        let raw = String::from_utf8(bytes).expect("utf8");
        assert!(raw.contains("\"wire_kind\":\"heartbeat\""));
    }

    #[test]
    fn malformed_protected_packet_nonce_is_rejected_without_panic() {
        let (_tmp, state) = build_test_state();
        let bytes = serde_json::to_vec(&super::LanWirePacket::Protected(
            super::LanProtectedPacket {
                version: 1,
                sender_node_id: state.lan_sync.local_node_id(),
                nonce_b64: base64::engine::general_purpose::STANDARD.encode([7u8]),
                ciphertext_b64: base64::engine::general_purpose::STANDARD.encode([1u8, 2u8, 3u8]),
            },
        ))
        .expect("serialize malformed packet");

        let decoded = deserialize_wire_packet(&state.gateway, &bytes);

        assert!(decoded.is_none());
    }

    #[test]
    fn apply_followed_provider_state_rolls_back_memory_when_persist_fails() {
        let (_tmp, state) = build_test_state();
        let shared_provider_id = state
            .secrets
            .ensure_provider_shared_id("provider_1")
            .expect("shared id");
        let event = crate::orchestrator::store::LanEditSyncEvent {
            event_id: "edit_follow_remote_provider".to_string(),
            node_id: "node-remote".to_string(),
            node_name: "remote".to_string(),
            created_at_unix_ms: 1,
            lamport_ts: 1,
            entity_type: "provider_definition".to_string(),
            entity_id: shared_provider_id,
            op: "patch".to_string(),
            payload: serde_json::json!({
                "name": "remote-provider",
                "display_name": "Remote Provider",
                "base_url": "https://remote.example/v1",
                "key": "sk-remote",
                "key_storage": "auth_json",
            }),
        };
        apply_lan_edit_event(&state.gateway, &state.config_path, &event)
            .expect("seed remote snapshot");
        state
            .gateway
            .secrets
            .set_provider_key("provider_1", "sk-local")
            .expect("seed local provider key");
        let previous_cfg = state.gateway.cfg.read().clone();
        let previous_bundle = state.gateway.secrets.export_provider_state_bundle();
        let bad_path = state
            .config_path
            .parent()
            .expect("config parent")
            .join("persist-fail-dir");
        std::fs::create_dir_all(&bad_path).expect("create bad path");

        let err = apply_followed_provider_state(&state.gateway, &bad_path, "node-remote")
            .expect_err("persist should fail");

        assert!(!err.trim().is_empty());
        let current_cfg = state.gateway.cfg.read();
        assert_eq!(
            current_cfg.providers.keys().cloned().collect::<Vec<_>>(),
            previous_cfg.providers.keys().cloned().collect::<Vec<_>>()
        );
        assert_eq!(current_cfg.provider_order, previous_cfg.provider_order);
        assert_eq!(
            current_cfg.routing.preferred_provider,
            previous_cfg.routing.preferred_provider
        );
        assert_eq!(
            current_cfg.routing.session_preferred_providers,
            previous_cfg.routing.session_preferred_providers
        );
        let current_bundle = state.gateway.secrets.export_provider_state_bundle();
        assert_eq!(current_bundle.providers, previous_bundle.providers);
        assert_eq!(
            current_bundle.provider_key_storage_modes,
            previous_bundle.provider_key_storage_modes
        );
        assert_eq!(
            current_bundle.provider_shared_ids,
            previous_bundle.provider_shared_ids
        );
    }

    #[test]
    fn restore_local_provider_state_rolls_back_memory_when_persist_fails() {
        let (_tmp, mut state) = build_test_state();
        state
            .secrets
            .set_provider_key("provider_1", "sk-local-before")
            .expect("seed local provider key");
        let local_snapshot = crate::lan_sync::LocalProviderStateSnapshot {
            providers: state.gateway.cfg.read().providers.clone(),
            provider_order: state.gateway.cfg.read().provider_order.clone(),
            preferred_provider: state.gateway.cfg.read().routing.preferred_provider.clone(),
            session_preferred_providers: state
                .gateway
                .cfg
                .read()
                .routing
                .session_preferred_providers
                .clone(),
            provider_state: state.secrets.export_provider_state_bundle(),
        };
        crate::lan_sync::write_local_provider_state_snapshot(&state, &local_snapshot)
            .expect("write local snapshot");
        crate::lan_sync::write_local_provider_copy_state(
            &state,
            &crate::lan_sync::LocalProviderCopyStateSnapshot {
                copied_shared_provider_ids: std::collections::BTreeSet::from([
                    "shared-provider-1".to_string()
                ]),
            },
        )
        .expect("write local copy snapshot");

        {
            let mut cfg = state.gateway.cfg.write();
            let provider = cfg.providers.get_mut("provider_1").expect("provider_1");
            provider.display_name = "Followed Provider".to_string();
            provider.base_url = "https://followed.example/v1".to_string();
            cfg.routing.preferred_provider = "provider_2".to_string();
        }
        state
            .secrets
            .set_provider_key("provider_1", "sk-followed")
            .expect("seed followed provider key");
        let previous_cfg = state.gateway.cfg.read().clone();
        let previous_bundle = state.gateway.secrets.export_provider_state_bundle();

        let bad_path = state
            .config_path
            .parent()
            .expect("config parent")
            .join("persist-fail-dir");
        std::fs::create_dir_all(&bad_path).expect("create bad path");
        state.config_path = bad_path;

        let err = restore_local_provider_state(&state).expect_err("persist should fail");

        assert!(!err.trim().is_empty());
        let current_cfg = state.gateway.cfg.read();
        assert_eq!(
            current_cfg.providers.keys().cloned().collect::<Vec<_>>(),
            previous_cfg.providers.keys().cloned().collect::<Vec<_>>()
        );
        for (name, current_provider) in current_cfg.providers.iter() {
            let previous_provider = previous_cfg
                .providers
                .get(name)
                .expect("provider should exist before failed restore");
            assert_eq!(
                current_provider.display_name,
                previous_provider.display_name
            );
            assert_eq!(current_provider.base_url, previous_provider.base_url);
            assert_eq!(current_provider.group, previous_provider.group);
            assert_eq!(current_provider.disabled, previous_provider.disabled);
            assert_eq!(
                current_provider.usage_adapter,
                previous_provider.usage_adapter
            );
            assert_eq!(
                current_provider.usage_base_url,
                previous_provider.usage_base_url
            );
        }
        assert_eq!(current_cfg.provider_order, previous_cfg.provider_order);
        assert_eq!(
            current_cfg.routing.preferred_provider,
            previous_cfg.routing.preferred_provider
        );
        assert_eq!(
            current_cfg.routing.session_preferred_providers,
            previous_cfg.routing.session_preferred_providers
        );
        let current_bundle = state.gateway.secrets.export_provider_state_bundle();
        assert_eq!(current_bundle.providers, previous_bundle.providers);
        assert_eq!(
            current_bundle.provider_key_storage_modes,
            previous_bundle.provider_key_storage_modes
        );
        assert_eq!(
            current_bundle.provider_account_emails,
            previous_bundle.provider_account_emails
        );
        assert_eq!(current_bundle.usage_tokens, previous_bundle.usage_tokens);
        assert_eq!(
            current_bundle
                .usage_logins
                .iter()
                .map(|(name, login)| (name.clone(), login.username.clone(), login.password.clone()))
                .collect::<Vec<_>>(),
            previous_bundle
                .usage_logins
                .iter()
                .map(|(name, login)| (name.clone(), login.username.clone(), login.password.clone()))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            current_bundle.provider_shared_ids,
            previous_bundle.provider_shared_ids
        );
        assert!(
            crate::lan_sync::load_local_provider_state_snapshot(&state)
                .expect("load snapshot after failed restore")
                .is_some(),
            "failed restore must not clear saved local snapshot"
        );
        assert_eq!(
            crate::lan_sync::load_local_provider_copy_state(&state)
                .expect("load copy snapshot after failed restore")
                .copied_shared_provider_ids,
            std::collections::BTreeSet::from([("shared-provider-1".to_string())]),
            "failed restore must not clear saved local copy state"
        );
    }

    #[test]
    fn restore_local_provider_state_rolls_back_when_secret_bundle_persist_fails() {
        let (_tmp, state) = build_test_state_with_broken_secrets_path();
        let local_snapshot = crate::lan_sync::LocalProviderStateSnapshot {
            providers: state.gateway.cfg.read().providers.clone(),
            provider_order: state.gateway.cfg.read().provider_order.clone(),
            preferred_provider: state.gateway.cfg.read().routing.preferred_provider.clone(),
            session_preferred_providers: state
                .gateway
                .cfg
                .read()
                .routing
                .session_preferred_providers
                .clone(),
            provider_state: state.secrets.export_provider_state_bundle(),
        };
        crate::lan_sync::write_local_provider_state_snapshot(&state, &local_snapshot)
            .expect("write local snapshot");

        {
            let mut cfg = state.gateway.cfg.write();
            let provider = cfg.providers.get_mut("provider_1").expect("provider_1");
            provider.display_name = "Followed Provider".to_string();
            cfg.routing.preferred_provider = "provider_2".to_string();
        }
        let previous_cfg = state.gateway.cfg.read().clone();
        let previous_bundle = state.gateway.secrets.export_provider_state_bundle();

        let err = restore_local_provider_state(&state).expect_err("persist should fail");

        assert!(!err.trim().is_empty());
        let current_cfg = state.gateway.cfg.read();
        assert_eq!(
            current_cfg.providers.keys().cloned().collect::<Vec<_>>(),
            previous_cfg.providers.keys().cloned().collect::<Vec<_>>()
        );
        assert_eq!(current_cfg.provider_order, previous_cfg.provider_order);
        assert_eq!(
            current_cfg.routing.preferred_provider,
            previous_cfg.routing.preferred_provider
        );
        let current_bundle = state.gateway.secrets.export_provider_state_bundle();
        assert_eq!(current_bundle.providers, previous_bundle.providers);
        assert_eq!(
            current_bundle.provider_key_storage_modes,
            previous_bundle.provider_key_storage_modes
        );
    }

    #[test]
    fn apply_followed_provider_state_preserves_existing_pricing_by_shared_id() {
        let (_tmp, state) = build_test_state();
        state
            .secrets
            .set_provider_shared_id("provider_1", "shared-remote")
            .expect("shared id");
        state
            .secrets
            .set_provider_pricing(
                "provider_1",
                "per_request",
                0.035,
                None,
                Some("sk-local".to_string()),
            )
            .expect("seed local pricing");

        let event = crate::orchestrator::store::LanEditSyncEvent {
            event_id: "evt-followed-provider".to_string(),
            node_id: "node-remote".to_string(),
            node_name: "Remote".to_string(),
            created_at_unix_ms: crate::orchestrator::store::unix_ms(),
            lamport_ts: 1,
            entity_type: "provider_definition".to_string(),
            entity_id: "shared-remote".to_string(),
            op: "patch".to_string(),
            payload: serde_json::json!({
                "name": "remote-provider",
                "display_name": "Remote Provider",
                "base_url": "https://remote.example/v1",
                "key": "sk-remote",
                "key_storage": "auth_json",
            }),
        };
        apply_lan_edit_event(&state.gateway, &state.config_path, &event)
            .expect("seed remote snapshot");

        apply_followed_provider_state(&state.gateway, &state.config_path, "node-remote")
            .expect("apply followed state");

        let pricing = state.secrets.list_provider_pricing();
        let followed = pricing
            .get("remote-provider")
            .expect("followed provider pricing preserved");
        assert_eq!(followed.mode, "per_request");
        assert_eq!(followed.amount_usd, 0.035);
        assert_eq!(followed.periods.len(), 1);
        assert_eq!(followed.periods[0].api_key_ref, "sk-local");
    }

    #[test]
    fn apply_followed_provider_state_uses_remote_provider_order() {
        let (_tmp, state) = build_test_state();
        let remote_a = crate::orchestrator::store::LanEditSyncEvent {
            event_id: "evt-followed-order-a".to_string(),
            node_id: "node-remote".to_string(),
            node_name: "Remote".to_string(),
            created_at_unix_ms: crate::orchestrator::store::unix_ms(),
            lamport_ts: 1,
            entity_type: "provider_definition".to_string(),
            entity_id: "shared-remote-a".to_string(),
            op: "patch".to_string(),
            payload: serde_json::json!({
                "name": "alpha",
                "display_name": "Alpha",
                "base_url": "https://alpha.example/v1",
                "order_index": 1,
            }),
        };
        let remote_b = crate::orchestrator::store::LanEditSyncEvent {
            event_id: "evt-followed-order-b".to_string(),
            node_id: "node-remote".to_string(),
            node_name: "Remote".to_string(),
            created_at_unix_ms: crate::orchestrator::store::unix_ms(),
            lamport_ts: 2,
            entity_type: "provider_definition".to_string(),
            entity_id: "shared-remote-b".to_string(),
            op: "patch".to_string(),
            payload: serde_json::json!({
                "name": "zeta",
                "display_name": "Zeta",
                "base_url": "https://zeta.example/v1",
                "order_index": 0,
            }),
        };
        apply_lan_edit_event(&state.gateway, &state.config_path, &remote_a)
            .expect("seed remote alpha snapshot");
        apply_lan_edit_event(&state.gateway, &state.config_path, &remote_b)
            .expect("seed remote zeta snapshot");

        apply_followed_provider_state(&state.gateway, &state.config_path, "node-remote")
            .expect("apply followed state");

        assert_eq!(
            state.gateway.cfg.read().provider_order,
            vec!["zeta".to_string(), "alpha".to_string()]
        );
    }

    #[test]
    fn apply_followed_provider_state_does_not_touch_app_codex_auth_json() {
        let (_tmp, state) = build_test_state();
        let app_auth_path = state
            .config_path
            .parent()
            .expect("config parent")
            .join("codex-home")
            .join("auth.json");
        std::fs::create_dir_all(app_auth_path.parent().expect("auth parent"))
            .expect("create codex auth parent");
        let original_auth = serde_json::json!({
            "tokens": {
                "access_token": "codex-access-token"
            }
        });
        std::fs::write(
            &app_auth_path,
            serde_json::to_string_pretty(&original_auth).expect("auth json"),
        )
        .expect("write app auth");

        let event = crate::orchestrator::store::LanEditSyncEvent {
            event_id: "evt-followed-auth-isolation".to_string(),
            node_id: "node-remote".to_string(),
            node_name: "Remote".to_string(),
            created_at_unix_ms: crate::orchestrator::store::unix_ms(),
            lamport_ts: 1,
            entity_type: "provider_definition".to_string(),
            entity_id: "shared-remote-auth".to_string(),
            op: "patch".to_string(),
            payload: serde_json::json!({
                "name": "remote-provider",
                "display_name": "Remote Provider",
                "base_url": "https://remote.example/v1",
                "key": "sk-remote",
                "key_storage": "auth_json",
                "usage_token": "usage-remote"
            }),
        };
        apply_lan_edit_event(&state.gateway, &state.config_path, &event)
            .expect("seed remote snapshot");

        apply_followed_provider_state(&state.gateway, &state.config_path, "node-remote")
            .expect("apply followed state");

        let persisted_auth: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&app_auth_path).expect("read app auth"))
                .expect("parse app auth");
        assert_eq!(persisted_auth, original_auth);
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
                followed_source_node_id: None,
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
                followed_source_node_id: None,
            },
        );

        let peers = runtime.collect_live_peers(100_000);
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].node_id, "fresh");
    }

    #[test]
    fn snapshot_tracks_last_peer_heartbeat_for_diagnostics() {
        let runtime = LanSyncRuntime::new(LanNodeIdentity {
            node_id: "node-self".to_string(),
            node_name: "self".to_string(),
        });
        let cfg = crate::orchestrator::config::AppConfig::default_config();
        let tmp = tempfile::tempdir().expect("tempdir");
        let secrets =
            crate::orchestrator::secrets::SecretStore::new(tmp.path().join("secrets.json"));

        assert_eq!(
            runtime
                .snapshot(4000, &cfg, &secrets)
                .last_peer_heartbeat_received_unix_ms,
            0
        );
        assert!(runtime
            .snapshot(4000, &cfg, &secrets)
            .last_peer_heartbeat_source
            .is_none());

        runtime.note_peer_heartbeat(
            LanHeartbeatPacket {
                version: 1,
                node_id: "node-peer".to_string(),
                node_name: "peer".to_string(),
                listen_port: 4000,
                sent_at_unix_ms: 1000,
                capabilities: vec!["heartbeat_v1".to_string()],
                provider_fingerprints: Vec::new(),
                followed_source_node_id: None,
            },
            "192.168.1.50:4000".parse().expect("source addr"),
        );

        let snapshot = runtime.snapshot(5_000, &cfg, &secrets);
        assert!(snapshot.last_peer_heartbeat_received_unix_ms > 0);
        assert_eq!(
            snapshot.last_peer_heartbeat_source.as_deref(),
            Some("192.168.1.50:4000")
        );
    }

    #[test]
    fn peer_registry_uses_receive_time_for_freshness() {
        let runtime = LanSyncRuntime::new(LanNodeIdentity {
            node_id: "node-self".to_string(),
            node_name: "self".to_string(),
        });
        runtime.note_peer_heartbeat(
            LanHeartbeatPacket {
                version: 1,
                node_id: "peer-fresh".to_string(),
                node_name: "Peer Fresh".to_string(),
                listen_port: 4000,
                sent_at_unix_ms: 1,
                capabilities: vec!["heartbeat_v1".to_string()],
                provider_fingerprints: vec![],
                followed_source_node_id: None,
            },
            std::net::SocketAddr::from(([192, 168, 1, 10], 38455)),
        );

        let peers = runtime.collect_live_peers(crate::orchestrator::store::unix_ms());
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].node_id, "peer-fresh");
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
                followed_source_node_id: None,
            },
        );
        let mut trusted_node_ids = std::collections::BTreeSet::new();
        trusted_node_ids.insert("node-a".to_string());
        let owner = runtime
            .quota_owner_for_fingerprint("fp-1", &trusted_node_ids)
            .expect("quota owner");
        assert_eq!(owner.owner_node_id, "node-a");
        assert!(!owner.local_is_owner);
    }

    #[test]
    fn quota_owner_for_fingerprint_ignores_untrusted_peers() {
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
                followed_source_node_id: None,
            },
        );

        let trusted_node_ids = std::collections::BTreeSet::new();
        let owner = runtime
            .quota_owner_for_fingerprint("fp-1", &trusted_node_ids)
            .expect("quota owner");
        assert_eq!(owner.owner_node_id, "node-b");
        assert!(owner.local_is_owner);
    }

    #[test]
    fn peer_stale_boundary_matches_timeout() {
        assert!(!peer_is_stale(10_000, 10_000 + LAN_PEER_STALE_AFTER_MS));
        assert!(peer_is_stale(10_000, 10_000 + LAN_PEER_STALE_AFTER_MS + 1));
    }

    #[test]
    fn provider_definition_edit_event_updates_remote_snapshot() {
        let (_tmp, state) = build_test_state();
        let shared_provider_id = state
            .secrets
            .ensure_provider_shared_id("provider_1")
            .expect("shared id");
        let event = crate::orchestrator::store::LanEditSyncEvent {
            event_id: "edit_test_provider_definition".to_string(),
            node_id: "node-remote".to_string(),
            node_name: "remote".to_string(),
            created_at_unix_ms: 1,
            lamport_ts: 1,
            entity_type: "provider_definition".to_string(),
            entity_id: shared_provider_id,
            op: "patch".to_string(),
            payload: serde_json::json!({
                "name": "packycode",
                "display_name": "Packycode",
                "base_url": "https://codex.packycode.com",
                "group": "alpha",
                "disabled": true,
                "account_email": "user@example.com",
                "key": "sk-remote",
                "key_storage": "auth_json",
                "usage_token": "ut-remote",
            }),
        };

        apply_lan_edit_event(&state.gateway, &state.config_path, &event).expect("apply event");

        let record = state
            .gateway
            .store
            .get_lan_provider_definition_snapshot("node-remote", &event.entity_id)
            .expect("snapshot");
        let payload: super::ProviderDefinitionSnapshotPayload =
            serde_json::from_value(record.snapshot).expect("snapshot payload");
        assert_eq!(record.provider_name, "packycode");
        assert_eq!(payload.display_name, "Packycode");
        assert_eq!(payload.base_url, "https://codex.packycode.com");
        assert_eq!(payload.group.as_deref(), Some("alpha"));
        assert!(payload.disabled);
        assert_eq!(payload.account_email.as_deref(), Some("user@example.com"));
        assert_eq!(payload.key.as_deref(), Some("sk-remote"));
        assert_eq!(payload.usage_token.as_deref(), Some("ut-remote"));
    }

    #[test]
    fn provider_pricing_and_spend_events_apply_by_shared_provider_id() {
        let (_tmp, state) = build_test_state();
        let shared_provider_id = state
            .secrets
            .ensure_provider_shared_id("provider_1")
            .expect("shared id");

        let pricing_event = crate::orchestrator::store::LanEditSyncEvent {
            event_id: "edit_test_pricing".to_string(),
            node_id: "node-remote".to_string(),
            node_name: "remote".to_string(),
            created_at_unix_ms: 2,
            lamport_ts: 2,
            entity_type: "provider_pricing".to_string(),
            entity_id: shared_provider_id.clone(),
            op: "replace".to_string(),
            payload: serde_json::json!({
                "provider_name": "provider_1",
                "pricing": {
                    "mode": "per_request",
                    "amount_usd": 0.035,
                    "periods": [{
                        "id": "period-1",
                        "mode": "per_request",
                        "amount_usd": 0.035,
                        "api_key_ref": "-",
                        "started_at_unix_ms": 1000,
                        "ended_at_unix_ms": null
                    }],
                    "gap_fill_mode": null,
                    "gap_fill_amount_usd": null
                }
            }),
        };
        apply_lan_edit_event(&state.gateway, &state.config_path, &pricing_event)
            .expect("apply pricing");

        let spend_event = crate::orchestrator::store::LanEditSyncEvent {
            event_id: "edit_test_spend".to_string(),
            node_id: "node-remote".to_string(),
            node_name: "remote".to_string(),
            created_at_unix_ms: 3,
            lamport_ts: 3,
            entity_type: "spend_manual_day".to_string(),
            entity_id: format!("{shared_provider_id}|2026-03-30"),
            op: "replace".to_string(),
            payload: serde_json::json!({
                "provider_name": "provider_1",
                "day_key": "2026-03-30",
                "manual_total_usd": 12.5,
                "manual_usd_per_req": null
            }),
        };
        apply_lan_edit_event(&state.gateway, &state.config_path, &spend_event)
            .expect("apply spend");

        let pricing = state.secrets.list_provider_pricing();
        let provider_pricing = pricing.get("provider_1").expect("provider pricing");
        assert_eq!(provider_pricing.mode, "per_request");
        assert_eq!(provider_pricing.amount_usd, 0.035);
        assert_eq!(provider_pricing.periods.len(), 1);

        let manual_days = state.gateway.store.list_spend_manual_days("provider_1");
        assert_eq!(manual_days.len(), 1);
        assert_eq!(
            manual_days[0]
                .get("day_key")
                .and_then(|value| value.as_str()),
            Some("2026-03-30")
        );
        assert_eq!(
            manual_days[0]
                .get("manual_total_usd")
                .and_then(|value| value.as_f64()),
            Some(12.5)
        );
    }

    #[test]
    fn provider_definition_tombstone_marks_remote_snapshot_deleted() {
        let (_tmp, state) = build_test_state();
        let shared_provider_id = state
            .secrets
            .ensure_provider_shared_id("provider_1")
            .expect("shared id");
        state
            .secrets
            .set_provider_key("provider_1", "sk-local")
            .expect("set key");
        let event = crate::orchestrator::store::LanEditSyncEvent {
            event_id: "edit_test_provider_delete".to_string(),
            node_id: "node-remote".to_string(),
            node_name: "remote".to_string(),
            created_at_unix_ms: 4,
            lamport_ts: 4,
            entity_type: "provider_definition".to_string(),
            entity_id: shared_provider_id,
            op: "tombstone".to_string(),
            payload: serde_json::json!({ "name": "provider_1" }),
        };

        apply_lan_edit_event(&state.gateway, &state.config_path, &event).expect("apply tombstone");

        let record = state
            .gateway
            .store
            .get_lan_provider_definition_snapshot("node-remote", &event.entity_id)
            .expect("deleted snapshot");
        assert!(record.deleted);
        assert!(record.provider_name.starts_with("shared_"));
    }

    #[test]
    fn older_provider_definition_event_does_not_override_newer_entity_version() {
        let (_tmp, state) = build_test_state();
        let shared_provider_id = state
            .secrets
            .ensure_provider_shared_id("provider_1")
            .expect("shared id");
        let newer = crate::orchestrator::store::LanEditSyncEvent {
            event_id: "event-newer".to_string(),
            node_id: "node-b".to_string(),
            node_name: "remote-b".to_string(),
            created_at_unix_ms: 20,
            lamport_ts: 20,
            entity_type: "provider_definition".to_string(),
            entity_id: shared_provider_id.clone(),
            op: "patch".to_string(),
            payload: serde_json::json!({
                "name": "provider_1",
                "display_name": "Newer Name",
            }),
        };
        let older = crate::orchestrator::store::LanEditSyncEvent {
            event_id: "event-older".to_string(),
            node_id: "node-a".to_string(),
            node_name: "remote-a".to_string(),
            created_at_unix_ms: 10,
            lamport_ts: 10,
            entity_type: "provider_definition".to_string(),
            entity_id: shared_provider_id,
            op: "patch".to_string(),
            payload: serde_json::json!({
                "name": "provider_1",
                "display_name": "Older Name",
            }),
        };

        assert!(incoming_event_is_newer(&state.gateway, &newer));
        apply_lan_edit_event(&state.gateway, &state.config_path, &newer).expect("apply newer");
        note_entity_version(&state.gateway, &newer);

        assert!(!incoming_event_is_newer(&state.gateway, &older));

        let record = state
            .gateway
            .store
            .get_lan_provider_definition_snapshot("node-b", &newer.entity_id)
            .expect("newer snapshot");
        let payload: super::ProviderDefinitionSnapshotPayload =
            serde_json::from_value(record.snapshot).expect("snapshot payload");
        assert_eq!(payload.display_name.as_str(), "Newer Name");
    }
}
