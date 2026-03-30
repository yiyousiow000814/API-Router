use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::orchestrator::config::AppConfig;
use crate::orchestrator::secrets::SecretStore;
use crate::orchestrator::store::unix_ms;

pub const LAN_DISCOVERY_PORT: u16 = 38455;
pub const LAN_HEARTBEAT_INTERVAL_MS: u64 = 2_000;
pub const LAN_PEER_STALE_AFTER_MS: u64 = 7_000;
const LAN_SHARED_HEALTH_LOOP_INTERVAL_MS: u64 = 900;
const LAN_USAGE_SYNC_LOOP_INTERVAL_MS: u64 = 1_500;
const LAN_USAGE_SYNC_BATCH_LIMIT: usize = 32;
const LAN_EDIT_SYNC_LOOP_INTERVAL_MS: u64 = 1_500;
const LAN_EDIT_SYNC_BATCH_LIMIT: usize = 32;
const LAN_HEARTBEAT_CAPABILITIES: [&str; 5] = [
    "heartbeat_v1",
    "status_v1",
    "usage_sync_v1",
    "edit_sync_v1",
    "config_source_v1",
];

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
    followed_source_node_id: Option<String>,
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
struct LanEditSyncRequestPacket {
    version: u8,
    node_id: String,
    after_lamport_ts: u64,
    after_event_id: String,
    limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LanEditSyncBatchPacket {
    version: u8,
    node_id: String,
    events: Vec<crate::orchestrator::store::LanEditSyncEvent>,
    has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum LanSyncPacket {
    Heartbeat(LanHeartbeatPacket),
    SharedHealth(LanSharedHealthPacket),
    UsageSyncRequest(LanUsageSyncRequestPacket),
    UsageSyncBatch(LanUsageSyncBatchPacket),
    EditSyncRequest(LanEditSyncRequestPacket),
    EditSyncBatch(LanEditSyncBatchPacket),
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
        let listener_config_path = config_path.clone();
        std::thread::Builder::new()
            .name("lan-sync-listener".to_string())
            .spawn(move || run_listener(listener_runtime, listener_gateway, listener_config_path))
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
        std::thread::Builder::new()
            .name("lan-sync-edit-sync".to_string())
            .spawn(move || run_edit_sync_loop(edit_sync_runtime, edit_sync_gateway))
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
                followed_source_node_id: packet.followed_source_node_id,
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
                followed_source_node_id: peer.followed_source_node_id.clone(),
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalProviderStateSnapshot {
    pub providers: std::collections::BTreeMap<String, crate::orchestrator::config::ProviderConfig>,
    pub provider_order: Vec<String>,
    pub preferred_provider: String,
    pub session_preferred_providers: std::collections::BTreeMap<String, String>,
    pub provider_state: crate::orchestrator::secrets::ProviderStateBundle,
    #[serde(default)]
    pub copied_shared_provider_ids: std::collections::BTreeSet<String>,
    #[serde(default)]
    pub linked_shared_provider_ids: std::collections::BTreeSet<String>,
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

fn followed_local_snapshot_meta_key() -> &'static str {
    "lan_follow_local_provider_snapshot"
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

pub fn save_local_provider_state_snapshot(
    state: &crate::app_state::AppState,
) -> Result<(), String> {
    let cfg = state.gateway.cfg.read().clone();
    let snapshot = LocalProviderStateSnapshot {
        providers: cfg.providers.clone(),
        provider_order: cfg.provider_order.clone(),
        preferred_provider: cfg.routing.preferred_provider.clone(),
        session_preferred_providers: cfg.routing.session_preferred_providers.clone(),
        provider_state: state.secrets.export_provider_state_bundle(),
        copied_shared_provider_ids: std::collections::BTreeSet::new(),
        linked_shared_provider_ids: std::collections::BTreeSet::new(),
    };
    write_local_provider_state_snapshot(state, &snapshot)
}

pub fn write_local_provider_state_snapshot(
    state: &crate::app_state::AppState,
    snapshot: &LocalProviderStateSnapshot,
) -> Result<(), String> {
    let payload = serde_json::to_string(&snapshot).map_err(|err| err.to_string())?;
    state
        .gateway
        .store
        .set_event_meta(followed_local_snapshot_meta_key(), &payload)
        .map_err(|err| err.to_string())
}

pub fn load_local_provider_state_snapshot(
    state: &crate::app_state::AppState,
) -> Result<Option<LocalProviderStateSnapshot>, String> {
    let raw = state
        .gateway
        .store
        .get_event_meta(followed_local_snapshot_meta_key())
        .map_err(|err| err.to_string())?;
    raw.map(|value| serde_json::from_str(&value).map_err(|err| err.to_string()))
        .transpose()
}

pub fn clear_local_provider_state_snapshot(
    state: &crate::app_state::AppState,
) -> Result<(), String> {
    state
        .gateway
        .store
        .delete_event_meta(followed_local_snapshot_meta_key())
        .map_err(|err| err.to_string())
}

fn normalize_followed_provider_name(
    used_names: &mut std::collections::BTreeSet<String>,
    requested_name: &str,
    shared_provider_id: &str,
) -> String {
    let base_name = requested_name
        .trim()
        .to_string()
        .chars()
        .take(64)
        .collect::<String>();
    let base_name = if base_name.trim().is_empty() {
        let suffix: String = shared_provider_id.chars().take(8).collect();
        format!("shared_{suffix}")
    } else {
        base_name
    };
    let mut candidate = base_name.clone();
    let mut index = 2usize;
    while used_names.contains(&candidate) {
        candidate = format!("{base_name} [{index}]");
        index = index.saturating_add(1);
    }
    used_names.insert(candidate.clone());
    candidate
}

fn sanitize_active_routing_refs(cfg: &mut AppConfig) {
    if !cfg.providers.contains_key(&cfg.routing.preferred_provider)
        || cfg
            .providers
            .get(&cfg.routing.preferred_provider)
            .is_some_and(|provider| provider.disabled)
    {
        cfg.routing.preferred_provider = cfg
            .provider_order
            .iter()
            .find(|name| {
                cfg.providers
                    .get(*name)
                    .is_some_and(|provider| !provider.disabled)
            })
            .cloned()
            .or_else(|| {
                cfg.providers
                    .iter()
                    .find_map(|(name, provider)| (!provider.disabled).then(|| name.clone()))
            })
            .unwrap_or_default();
    }
    cfg.routing
        .session_preferred_providers
        .retain(|_, provider| cfg.providers.contains_key(provider));
}

fn build_followed_provider_state(
    gateway: &crate::orchestrator::gateway::GatewayState,
    source_node_id: &str,
) -> Result<(AppConfig, crate::orchestrator::secrets::ProviderStateBundle), String> {
    let snapshot_rows = gateway
        .store
        .list_lan_provider_definition_snapshots(source_node_id);
    if snapshot_rows.is_empty() {
        return Err(format!(
            "no synced provider definitions available yet for source: {source_node_id}"
        ));
    }
    let mut next_cfg = gateway.cfg.read().clone();
    let mut next_bundle = crate::orchestrator::secrets::ProviderStateBundle::default();
    let mut next_providers = std::collections::BTreeMap::new();
    let mut next_order = Vec::new();
    let mut used_names = std::collections::BTreeSet::new();

    for row in snapshot_rows {
        let payload: ProviderDefinitionSnapshotPayload =
            serde_json::from_value(row.snapshot.clone()).map_err(|err| err.to_string())?;
        let provider_name = normalize_followed_provider_name(
            &mut used_names,
            &payload.name,
            &row.shared_provider_id,
        );
        next_order.push(provider_name.clone());
        next_providers.insert(
            provider_name.clone(),
            crate::orchestrator::config::ProviderConfig {
                display_name: if payload.display_name.trim().is_empty() {
                    provider_name.clone()
                } else {
                    payload.display_name.clone()
                },
                base_url: payload.base_url.clone(),
                group: payload.group.clone(),
                disabled: payload.disabled,
                usage_adapter: payload.usage_adapter.clone(),
                usage_base_url: payload.usage_base_url.clone(),
                api_key: String::new(),
            },
        );
        if let Some(key) = non_empty_trimmed(payload.key) {
            next_bundle.providers.insert(provider_name.clone(), key);
        }
        if let Some(storage) = non_empty_trimmed(payload.key_storage) {
            next_bundle
                .provider_key_storage_modes
                .insert(provider_name.clone(), storage);
        }
        if let Some(email) = non_empty_trimmed(payload.account_email) {
            next_bundle
                .provider_account_emails
                .insert(provider_name.clone(), email);
        }
        if let Some(token) = non_empty_trimmed(payload.usage_token) {
            next_bundle
                .usage_tokens
                .insert(provider_name.clone(), token);
        }
        if let (Some(username), Some(password)) = (
            non_empty_trimmed(payload.usage_login_username),
            non_empty_raw(payload.usage_login_password),
        ) {
            next_bundle.usage_logins.insert(
                provider_name.clone(),
                crate::orchestrator::secrets::UsageLoginSecret { username, password },
            );
        }
        next_bundle
            .provider_shared_ids
            .insert(provider_name, row.shared_provider_id);
    }

    next_cfg.providers = next_providers;
    next_cfg.provider_order = next_order;
    crate::app_state::normalize_provider_order(&mut next_cfg);
    sanitize_active_routing_refs(&mut next_cfg);
    Ok((next_cfg, next_bundle))
}

pub fn apply_followed_provider_state(
    gateway: &crate::orchestrator::gateway::GatewayState,
    config_path: &Path,
    source_node_id: &str,
) -> Result<(), String> {
    let (next_cfg, next_bundle) = build_followed_provider_state(gateway, source_node_id)?;
    gateway.secrets.replace_provider_state_bundle(next_bundle)?;
    {
        let mut cfg = gateway.cfg.write();
        *cfg = next_cfg.clone();
    }
    persist_gateway_config(gateway, config_path)?;
    gateway.router.sync_with_config(&next_cfg, unix_ms());
    Ok(())
}

pub fn restore_local_provider_state(state: &crate::app_state::AppState) -> Result<(), String> {
    let Some(snapshot) = load_local_provider_state_snapshot(state)? else {
        return Err("missing local provider snapshot for followed config source".to_string());
    };
    {
        let mut cfg = state.gateway.cfg.write();
        cfg.providers = snapshot.providers;
        cfg.provider_order = snapshot.provider_order;
        cfg.routing.preferred_provider = snapshot.preferred_provider;
        cfg.routing.session_preferred_providers = snapshot.session_preferred_providers;
        crate::app_state::normalize_provider_order(&mut cfg);
        sanitize_active_routing_refs(&mut cfg);
    }
    state
        .secrets
        .replace_provider_state_bundle(snapshot.provider_state)?;
    let cfg = state.gateway.cfg.read().clone();
    persist_gateway_config(&state.gateway, &state.config_path)?;
    state.gateway.router.sync_with_config(&cfg, unix_ms());
    clear_local_provider_state_snapshot(state)?;
    Ok(())
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
        .replace_provider_pricing_config(&provider_name, payload.pricing)
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

fn run_listener(
    runtime: LanSyncRuntime,
    gateway: crate::orchestrator::gateway::GatewayState,
    config_path: std::path::PathBuf,
) {
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
                    LanSyncPacket::EditSyncRequest(packet) => {
                        handle_edit_sync_request(&runtime, &gateway, source, packet);
                    }
                    LanSyncPacket::EditSyncBatch(packet) => {
                        apply_edit_sync_batch(&runtime, &gateway, &config_path, packet);
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
            followed_source_node_id: gateway.secrets.get_followed_config_source_node_id(),
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

fn handle_edit_sync_request(
    runtime: &LanSyncRuntime,
    gateway: &crate::orchestrator::gateway::GatewayState,
    source: SocketAddr,
    packet: LanEditSyncRequestPacket,
) {
    if packet.node_id.trim().is_empty() || packet.node_id == runtime.local_node.node_id {
        return;
    }
    let (events, has_more) = gateway.store.list_lan_edit_events_batch(
        packet.after_lamport_ts,
        Some(packet.after_event_id.as_str()),
        packet.limit.clamp(1, LAN_EDIT_SYNC_BATCH_LIMIT),
    );
    send_packet_to_addr(
        SocketAddr::from((source.ip(), LAN_DISCOVERY_PORT)),
        &LanSyncPacket::EditSyncBatch(LanEditSyncBatchPacket {
            version: 1,
            node_id: runtime.local_node.node_id.clone(),
            events,
            has_more,
        }),
    );
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

fn run_edit_sync_loop(
    runtime: LanSyncRuntime,
    gateway: crate::orchestrator::gateway::GatewayState,
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
            let Some(addr) = peer_sync_addr(&peer) else {
                continue;
            };
            let (after_lamport_ts, after_event_id) = load_edit_sync_cursor(&gateway, &peer.node_id);
            send_packet_to_addr(
                addr,
                &LanSyncPacket::EditSyncRequest(LanEditSyncRequestPacket {
                    version: 1,
                    node_id: runtime.local_node.node_id.clone(),
                    after_lamport_ts,
                    after_event_id,
                    limit: LAN_EDIT_SYNC_BATCH_LIMIT,
                }),
            );
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
        apply_lan_edit_event, incoming_event_is_newer, note_entity_version, peer_is_stale,
        sanitize_node_name, LanNodeIdentity, LanSyncRuntime, LAN_PEER_STALE_AFTER_MS,
    };

    fn build_test_state() -> (tempfile::TempDir, crate::app_state::AppState) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("user-data").join("data");
        let state = crate::app_state::build_state(config_path, data_dir).expect("build state");
        (tmp, state)
    }

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
