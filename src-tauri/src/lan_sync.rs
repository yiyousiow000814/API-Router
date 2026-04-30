use std::collections::{BTreeMap, HashMap, HashSet};
use std::error::Error;
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

#[path = "lan_sync/lan_fetch.rs"]
mod lan_fetch;
mod local_state;
#[path = "lan_sync/remote_update.rs"]
mod remote_update;
#[path = "lan_sync/shared_health.rs"]
mod shared_health;
#[path = "lan_sync/usage_history.rs"]
mod usage_history;
#[path = "lan_sync/versioning.rs"]
mod versioning;
#[path = "lan_sync/watchdog_incidents.rs"]
mod watchdog_incidents;
mod build_info {
    include!(concat!(env!("OUT_DIR"), "/build_info.rs"));
}

pub(crate) use lan_fetch::{
    lan_sync_diagnostics_http, local_diagnostics_snapshot, LanDiagnosticsRequestPacket,
    LanDiagnosticsResponsePacket,
};
pub use local_state::{
    apply_followed_provider_state, load_local_provider_copy_state,
    load_local_provider_state_snapshot, restore_local_provider_state,
    save_local_provider_state_snapshot, write_local_provider_copy_state,
    write_local_provider_state_snapshot, LocalProviderCopyStateSnapshot,
    LocalProviderStateSnapshot,
};
#[cfg(not(test))]
pub(crate) use remote_update::ensure_remote_update_updater_daemon;
#[cfg(test)]
pub(crate) use remote_update::{
    build_remote_update_worker_command, compute_local_remote_update_readiness,
    lan_remote_update_log_path, local_version_sync_target_ref, write_lan_remote_update_status,
    LanRemoteUpdateDebugRequestPacket, LanRemoteUpdateRequestPacket,
};
pub(crate) use remote_update::{
    current_local_remote_update_readiness, lan_sync_remote_update_debug_http,
    lan_sync_remote_update_http, load_lan_remote_update_status,
    load_lan_remote_update_status_public, normalized_local_build_target_ref,
    peer_remote_update_blocked_reason, reconcile_remote_update_terminal_event,
    remote_update_updater_port, LanRemoteUpdateDebugResponsePacket,
};
pub use remote_update::{LanRemoteUpdateReadinessSnapshot, LanRemoteUpdateStatusSnapshot};
pub(crate) use shared_health::LanSharedHealthPacket;
use shared_health::{apply_shared_health_packet, run_shared_health_loop};
pub(crate) use usage_history::{
    lan_sync_tracked_spend_history_debug_http, rebuild_shared_tracked_spend_views,
};
use usage_history::{
    refresh_shared_tracked_spend_projection_for_event, tracked_spend_history_day_key_for_debug,
};
pub(crate) use versioning::SYNC_DOMAIN_OFFICIAL_ACCOUNTS as LAN_SYNC_DOMAIN_OFFICIAL_ACCOUNTS;
use versioning::{
    lan_heartbeat_capabilities, local_sync_contracts, local_version_inventory,
    merge_version_inventory, SYNC_DOMAIN_PROVIDER_DEFINITIONS, SYNC_DOMAIN_SHARED_HEALTH,
    SYNC_DOMAIN_USAGE_HISTORY, SYNC_DOMAIN_USAGE_REQUESTS,
};

pub const LAN_DISCOVERY_PORT: u16 = 38455;
pub const LAN_HEARTBEAT_INTERVAL_MS: u64 = 2_000;
// Keep this well above the 2s send interval. Windows peer updates/builds and normal Wi-Fi jitter
// can delay UDP heartbeats for 7-10s; pruning that quickly makes the LAN peer button flicker even
// though the peer is still reachable and immediately rediscovered from the same listen address.
pub const LAN_PEER_STALE_AFTER_MS: u64 = 20_000;
pub const LAN_PEER_HTTP_GRACE_AFTER_MS: u64 = 30_000;
// Remote rollback intentionally keeps the peer's last known updater address longer than
// normal LAN HTTP grace. If the main API Router process hangs after an update, heartbeat
// stops, but the independent updater daemon can still receive a rollback request.
pub const LAN_REMOTE_UPDATE_ROLLBACK_HTTP_GRACE_AFTER_MS: u64 = 30 * 60 * 1000;
const LAN_PEER_HISTORY_RETAIN_AFTER_MS: u64 = LAN_REMOTE_UPDATE_ROLLBACK_HTTP_GRACE_AFTER_MS;
const LAN_HEARTBEAT_SENDER_DELAY_LOG_THRESHOLD_MS: u64 = LAN_HEARTBEAT_INTERVAL_MS * 2;
const LAN_HEARTBEAT_PREP_SLOW_LOG_THRESHOLD_MS: u64 = 250;
const _: () = assert!(LAN_PEER_STALE_AFTER_MS >= LAN_HEARTBEAT_INTERVAL_MS * 10);
const _: () = assert!(LAN_PEER_HISTORY_RETAIN_AFTER_MS >= LAN_PEER_STALE_AFTER_MS);
const LAN_SHARED_HEALTH_LOOP_INTERVAL_MS: u64 = 900;
const LAN_USAGE_SYNC_LOOP_INTERVAL_MS: u64 = 1_000;
const LAN_USAGE_SYNC_BATCH_LIMIT: usize = 2_048;
const LAN_EDIT_SYNC_LOOP_INTERVAL_MS: u64 = 1_000;
const LAN_EDIT_SYNC_BATCH_LIMIT: usize = 512;
const LAN_DEBUG_BATCH_LIMIT: usize = 256;
const LAN_PACKET_SOFT_LIMIT_BYTES: usize = 8 * 1024;
const LAN_SOCKET_RETRY_MS: u64 = 2_000;
const LAN_PEER_DIAGNOSTICS_LOG_MAX_BYTES: usize = 64 * 1024;
const LAN_PAIR_REQUEST_TTL_MS: u64 = 5 * 60 * 1000;
const LAN_PAIR_REQUEST_THROTTLE_MS: u64 = 60 * 1000;
const LAN_PAIR_APPROVAL_TTL_MS: u64 = 5 * 60 * 1000;
const LAN_REMOTE_UPDATE_ACCEPTED_STARTUP_GRACE_MS: u64 = 15_000;
const LAN_REMOTE_UPDATE_DEBUG_HTTP_TIMEOUT_MS: u64 = 4_000;
const LAN_OFFICIAL_ACCOUNTS_SYNC_HTTP_TIMEOUT_MS: u64 = 2_500;
const LAN_SYNC_AUTH_NODE_ID_HEADER: &str = "x-api-router-lan-node-id";
const LAN_SYNC_AUTH_SECRET_HEADER: &str = "x-api-router-lan-secret";
pub(crate) const LAN_REMOTE_UPDATE_CAPABILITY: &str = "remote_update_v2";
const LAN_EDIT_ENTITY_PROVIDER_DEFINITION: &str = "provider_definition";
const LAN_EDIT_ENTITY_PROVIDER_PRICING: &str = "provider_pricing";
const LAN_EDIT_ENTITY_QUOTA_SNAPSHOT: &str = "quota_snapshot";
const LAN_EDIT_ENTITY_SPEND_MANUAL_DAY: &str = "spend_manual_day";
const LAN_EDIT_ENTITY_TRACKED_SPEND_DAY: &str = "tracked_spend_day";
const LAN_EDIT_ENTITY_TRACKED_SPEND_DAY_HISTORY_DELETE: &str = "tracked_spend_day_history_delete";

static GATEWAY_STATUS_RUNTIME: OnceLock<RwLock<Option<LanSyncRuntime>>> = OnceLock::new();
static UI_WATCHDOG_RUNTIME: OnceLock<RwLock<HashMap<u16, crate::app_state::UiWatchdogState>>> =
    OnceLock::new();

fn gateway_status_runtime() -> &'static RwLock<Option<LanSyncRuntime>> {
    GATEWAY_STATUS_RUNTIME.get_or_init(|| RwLock::new(None))
}

fn ui_watchdog_runtime() -> &'static RwLock<HashMap<u16, crate::app_state::UiWatchdogState>> {
    UI_WATCHDOG_RUNTIME.get_or_init(|| RwLock::new(HashMap::new()))
}

pub(crate) fn register_ui_watchdog_state(
    listen_port: u16,
    watchdog: crate::app_state::UiWatchdogState,
) {
    ui_watchdog_runtime().write().insert(listen_port, watchdog);
}

pub(crate) fn reassign_ui_watchdog_state(
    previous_port: u16,
    next_port: u16,
    watchdog: crate::app_state::UiWatchdogState,
) {
    let mut runtime = ui_watchdog_runtime().write();
    if previous_port != next_port {
        runtime.remove(&previous_port);
    }
    runtime.insert(next_port, watchdog);
}

pub(crate) fn current_ui_watchdog_live_snapshot(
    listen_port: u16,
    now_unix_ms: u64,
) -> Option<crate::app_state::UiWatchdogLiveSnapshot> {
    ui_watchdog_runtime()
        .read()
        .get(&listen_port)
        .map(|watchdog| watchdog.live_snapshot(now_unix_ms))
}

pub(crate) fn current_ui_watchdog_state(
    listen_port: u16,
) -> Option<crate::app_state::UiWatchdogState> {
    ui_watchdog_runtime().read().get(&listen_port).cloned()
}

fn lan_peer_diagnostics_log_path() -> Option<std::path::PathBuf> {
    crate::diagnostics::diagnostics_file_path("lan-peer-diagnostics.log")
}

fn append_lan_peer_diagnostics_log(message: &str) {
    let Some(path) = lan_peer_diagnostics_log_path() else {
        return;
    };
    let _ = crate::diagnostics::append_timestamped_log_line_capped(
        &path,
        message,
        LAN_PEER_DIAGNOSTICS_LOG_MAX_BYTES,
    );
}

fn heartbeat_sender_delay_ms(previous_sent_unix_ms: Option<u64>, now_unix_ms: u64) -> Option<u64> {
    previous_sent_unix_ms.and_then(|previous_sent_unix_ms| {
        let delay_ms = now_unix_ms.saturating_sub(previous_sent_unix_ms);
        (delay_ms > LAN_HEARTBEAT_SENDER_DELAY_LOG_THRESHOLD_MS).then_some(delay_ms)
    })
}

fn optional_u64_log_value(value: Option<u64>) -> String {
    value
        .map(|value| value.to_string())
        .unwrap_or_else(|| "none".to_string())
}

fn heartbeat_step_elapsed_ms(started_at_unix_ms: u64) -> u64 {
    unix_ms().saturating_sub(started_at_unix_ms)
}

pub(crate) fn current_build_identity() -> LanBuildIdentitySnapshot {
    LanBuildIdentitySnapshot {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        build_git_sha: build_info::API_ROUTER_BUILD_GIT_SHA.to_string(),
        build_git_short_sha: build_info::API_ROUTER_BUILD_GIT_SHORT_SHA.to_string(),
        build_git_commit_unix_ms: build_info::API_ROUTER_BUILD_GIT_COMMIT_UNIX_MS,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LanLocalVersionSyncSnapshot {
    pub target_ref: Option<String>,
    pub git_worktree_clean: bool,
    pub update_to_local_build_allowed: bool,
    pub blocked_reason: Option<String>,
}

fn probe_git_worktree_clean(repo_root: &Path) -> Result<bool, String> {
    let output = crate::platform::git_exec::new_git_command()
        .arg("status")
        .arg("--porcelain=v1")
        .current_dir(repo_root)
        .output()
        .map_err(|err| format!("git status failed: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            return Err(format!("git status exited with {}", output.status));
        }
        return Err(format!(
            "git status exited with {}: {stderr}",
            output.status
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

fn git_output_trimmed(repo_root: &Path, args: &[&str]) -> Result<String, String> {
    let output = crate::platform::git_exec::new_git_command()
        .args(args)
        .current_dir(repo_root)
        .output()
        .map_err(|err| format!("git {} failed: {err}", args.join(" ")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            return Err(format!(
                "git {} exited with {}",
                args.join(" "),
                output.status
            ));
        }
        return Err(format!(
            "git {} exited with {}: {stderr}",
            args.join(" "),
            output.status
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn local_version_sync_target_ref_for_repo(repo_root: &Path, build_sha: &str) -> String {
    let head_sha = git_output_trimmed(repo_root, &["rev-parse", "HEAD"]).unwrap_or_default();
    if head_sha.eq_ignore_ascii_case(build_sha) {
        let branch = git_output_trimmed(repo_root, &["branch", "--show-current"])
            .unwrap_or_default()
            .trim()
            .to_string();
        if !branch.is_empty() {
            return branch;
        }
    }
    build_sha.to_string()
}

fn compute_local_version_sync_snapshot() -> LanLocalVersionSyncSnapshot {
    let Some(build_sha) = normalized_local_build_target_ref() else {
        return LanLocalVersionSyncSnapshot {
            target_ref: None,
            git_worktree_clean: false,
            update_to_local_build_allowed: false,
            blocked_reason: Some(
                "Current build does not expose a git commit sha; cannot safely sync peers to this build."
                    .to_string(),
            ),
        };
    };
    let (target_ref, git_worktree_clean) = match resolve_repo_root_for_self_update() {
        Ok(repo_root) => (
            local_version_sync_target_ref_for_repo(&repo_root, &build_sha),
            probe_git_worktree_clean(&repo_root).unwrap_or_default(),
        ),
        Err(_) => (build_sha.clone(), false),
    };
    LanLocalVersionSyncSnapshot {
        target_ref: Some(target_ref),
        git_worktree_clean,
        update_to_local_build_allowed: true,
        blocked_reason: None,
    }
}

pub(crate) fn current_local_version_sync_snapshot() -> LanLocalVersionSyncSnapshot {
    static CACHE: OnceLock<RwLock<Option<(u64, LanLocalVersionSyncSnapshot)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| RwLock::new(None));
    let now = unix_ms();
    if let Some((captured_at, snapshot)) = cache.read().clone() {
        if now.saturating_sub(captured_at) < 5_000 {
            return snapshot;
        }
    }
    let snapshot = compute_local_version_sync_snapshot();
    *cache.write() = Some((now, snapshot.clone()));
    snapshot
}

const LAN_EDIT_ENTITY_DOMAIN_REGISTRY: [(&str, &str); 6] = [
    (
        LAN_EDIT_ENTITY_PROVIDER_DEFINITION,
        SYNC_DOMAIN_PROVIDER_DEFINITIONS,
    ),
    (LAN_EDIT_ENTITY_PROVIDER_PRICING, SYNC_DOMAIN_USAGE_HISTORY),
    (LAN_EDIT_ENTITY_QUOTA_SNAPSHOT, SYNC_DOMAIN_USAGE_HISTORY),
    (LAN_EDIT_ENTITY_SPEND_MANUAL_DAY, SYNC_DOMAIN_USAGE_HISTORY),
    (LAN_EDIT_ENTITY_TRACKED_SPEND_DAY, SYNC_DOMAIN_USAGE_HISTORY),
    (
        LAN_EDIT_ENTITY_TRACKED_SPEND_DAY_HISTORY_DELETE,
        SYNC_DOMAIN_USAGE_HISTORY,
    ),
];

fn lan_edit_entity_sync_domain(entity_type: &str) -> Option<&'static str> {
    LAN_EDIT_ENTITY_DOMAIN_REGISTRY
        .iter()
        .find_map(|(registered_type, domain)| (*registered_type == entity_type).then_some(*domain))
}

#[cfg(test)]
fn usage_requests_contract_sample() -> Value {
    serde_json::json!({
        "id": "usage-1",
        "unix_ms": 1_700_000_000_000u64,
        "ingested_at_unix_ms": 1_700_000_000_001u64,
        "provider": "gateway",
        "api_key_ref": "-",
        "model": "gpt-5.4",
        "origin": "gateway",
        "transport": "http",
        "session_id": "session-1",
        "node_id": "node-local",
        "node_name": "Local",
        "input_tokens": 10u64,
        "output_tokens": 20u64,
        "total_tokens": 30u64,
        "cache_creation_input_tokens": 0u64,
        "cache_read_input_tokens": 0u64
    })
}

#[cfg(test)]
fn usage_history_contract_samples() -> Vec<(&'static str, Value)> {
    vec![
        (
            LAN_EDIT_ENTITY_PROVIDER_PRICING,
            serde_json::json!({
                "provider_name": "provider_1",
                "pricing": {
                    "mode": "per_request",
                    "amount_usd": 0.02,
                    "periods": [{
                        "id": "period-1",
                        "mode": "per_request",
                        "amount_usd": 0.02,
                        "api_key_ref": "-",
                        "started_at_unix_ms": 1000,
                        "ended_at_unix_ms": null
                    }],
                    "gap_fill_mode": null,
                    "gap_fill_amount_usd": null
                }
            }),
        ),
        (
            LAN_EDIT_ENTITY_QUOTA_SNAPSHOT,
            serde_json::json!({
                "provider_name": "provider_1",
                "snapshot": {
                    "kind": "budget_info",
                    "updated_at_unix_ms": 2222,
                    "remaining": null,
                    "today_used": null,
                    "today_added": null,
                    "daily_spent_usd": 17.47,
                    "daily_budget_usd": 200.0,
                    "weekly_spent_usd": null,
                    "weekly_budget_usd": null,
                    "monthly_spent_usd": null,
                    "monthly_budget_usd": null,
                    "package_expires_at_unix_ms": null,
                    "last_error": "",
                    "effective_usage_base": "https://example.com/v1",
                    "effective_usage_source": "remote"
                }
            }),
        ),
        (
            LAN_EDIT_ENTITY_SPEND_MANUAL_DAY,
            serde_json::json!({
                "provider_name": "provider_1",
                "day_key": "2026-03-30",
                "manual_total_usd": 12.5,
                "manual_usd_per_req": null
            }),
        ),
        (
            LAN_EDIT_ENTITY_TRACKED_SPEND_DAY,
            serde_json::json!({
                "provider_name": "provider_1",
                "day_started_at_unix_ms": 1711929600000u64,
                "row": {
                    "provider": "provider_1",
                    "api_key_ref": "sk-abc******wxyz",
                    "started_at_unix_ms": 1711929600000u64,
                    "ended_at_unix_ms": null,
                    "tracked_spend_usd": 17.47,
                    "last_seen_daily_spent_usd": 17.47,
                    "updated_at_unix_ms": 2222u64
                }
            }),
        ),
        (
            LAN_EDIT_ENTITY_TRACKED_SPEND_DAY_HISTORY_DELETE,
            serde_json::json!({
                "provider_name": "provider_1",
                "day_key": "2026-04-02"
            }),
        ),
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LanBuildIdentitySnapshot {
    pub app_version: String,
    pub build_git_sha: String,
    pub build_git_short_sha: String,
    #[serde(default)]
    pub build_git_commit_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LanSyncDomainDiagnosticSnapshot {
    pub domain: String,
    pub status: String,
    pub local_contract_version: u32,
    pub peer_contract_version: u32,
    pub blocked_reason: Option<String>,
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
    pub remote_update_updater_port: Option<u16>,
    pub capabilities: Vec<String>,
    pub version_inventory: Vec<String>,
    pub build_identity: LanBuildIdentitySnapshot,
    pub version_sync: LanLocalVersionSyncSnapshot,
    pub remote_update_status: Option<LanRemoteUpdateStatusSnapshot>,
    pub sync_contracts: BTreeMap<String, u32>,
    pub provider_fingerprints: Vec<String>,
    pub provider_definitions_revision: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LanPeerSnapshot {
    pub node_id: String,
    pub node_name: String,
    pub listen_addr: String,
    pub remote_update_updater_port: Option<u16>,
    pub last_heartbeat_unix_ms: u64,
    pub capabilities: Vec<String>,
    pub version_inventory: Vec<String>,
    pub build_identity: LanBuildIdentitySnapshot,
    pub provider_fingerprints: Vec<String>,
    pub provider_definitions_revision: String,
    pub sync_contracts: BTreeMap<String, u32>,
    pub followed_source_node_id: Option<String>,
    pub trusted: bool,
    pub pair_state: Option<String>,
    pub pair_request_id: Option<String>,
    pub remote_update_readiness: Option<LanRemoteUpdateReadinessSnapshot>,
    pub remote_update_status: Option<LanRemoteUpdateStatusSnapshot>,
    pub sync_blocked_domains: Vec<String>,
    pub sync_diagnostics: Vec<LanSyncDomainDiagnosticSnapshot>,
    pub build_matches_local: bool,
    pub heartbeat_age_ms: u64,
    pub http_probe_state: Option<String>,
    pub http_probe_detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LanHttpSyncProbeSnapshot {
    pub unix_ms: u64,
    pub peer_node_id: String,
    pub peer_listen_addr: String,
    pub route: String,
    pub outcome: String,
    pub detail: String,
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
    pub last_http_sync_probe: Option<LanHttpSyncProbeSnapshot>,
    pub last_http_sync_failure: Option<LanHttpSyncProbeSnapshot>,
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
    remote_update_updater_port: Option<u16>,
    last_heartbeat_unix_ms: u64,
    capabilities: Vec<String>,
    version_inventory: Vec<String>,
    build_identity: LanBuildIdentitySnapshot,
    remote_update_readiness: Option<LanRemoteUpdateReadinessSnapshot>,
    remote_update_status: Option<LanRemoteUpdateStatusSnapshot>,
    sync_contracts: BTreeMap<String, u32>,
    provider_fingerprints: Vec<String>,
    provider_definitions_revision: String,
    followed_source_node_id: Option<String>,
}

fn lan_peer_snapshot_from_runtime(peer: &LanPeerRuntime) -> LanPeerSnapshot {
    LanPeerSnapshot {
        node_id: peer.node_id.clone(),
        node_name: peer.node_name.clone(),
        listen_addr: peer.listen_addr.clone(),
        remote_update_updater_port: peer.remote_update_updater_port,
        last_heartbeat_unix_ms: peer.last_heartbeat_unix_ms,
        capabilities: peer.capabilities.clone(),
        version_inventory: peer.version_inventory.clone(),
        build_identity: peer.build_identity.clone(),
        provider_fingerprints: peer.provider_fingerprints.clone(),
        provider_definitions_revision: peer.provider_definitions_revision.clone(),
        sync_contracts: peer.sync_contracts.clone(),
        followed_source_node_id: peer.followed_source_node_id.clone(),
        trusted: false,
        pair_state: None,
        pair_request_id: None,
        remote_update_readiness: peer.remote_update_readiness.clone(),
        remote_update_status: peer.remote_update_status.clone(),
        sync_blocked_domains: Vec::new(),
        sync_diagnostics: Vec::new(),
        build_matches_local: false,
        heartbeat_age_ms: 0,
        http_probe_state: None,
        http_probe_detail: None,
    }
}

fn enrich_peer_transport_diagnostics(
    peer: &mut LanPeerSnapshot,
    now: u64,
    last_probe: Option<&LanHttpSyncProbeSnapshot>,
    last_failure: Option<&LanHttpSyncProbeSnapshot>,
) {
    peer.heartbeat_age_ms = now.saturating_sub(peer.last_heartbeat_unix_ms);
    let matching_failure = last_failure.filter(|probe| probe.peer_node_id == peer.node_id);
    let matching_probe = last_probe.filter(|probe| probe.peer_node_id == peer.node_id);
    if let Some(failure) = matching_failure {
        peer.http_probe_state = Some(failure.outcome.clone());
        peer.http_probe_detail = Some(format!(
            "{} via {}: {}",
            failure.route, failure.peer_listen_addr, failure.detail
        ));
        return;
    }
    if let Some(probe) = matching_probe {
        peer.http_probe_state = Some(probe.outcome.clone());
        peer.http_probe_detail = Some(format!(
            "{} via {}: {}",
            probe.route, probe.peer_listen_addr, probe.detail
        ));
    }
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
    #[serde(default)]
    remote_update_updater_port: Option<u16>,
    sent_at_unix_ms: u64,
    #[serde(default)]
    sequence: u64,
    #[serde(default)]
    sender_previous_gap_ms: Option<u64>,
    #[serde(default)]
    sender_previous_elapsed_ms: Option<u64>,
    capabilities: Vec<String>,
    #[serde(default = "current_build_identity")]
    build_identity: LanBuildIdentitySnapshot,
    #[serde(default)]
    remote_update_readiness: Option<LanRemoteUpdateReadinessSnapshot>,
    #[serde(default)]
    remote_update_status: Option<LanRemoteUpdateStatusSnapshot>,
    #[serde(default)]
    sync_contracts: BTreeMap<String, u32>,
    provider_fingerprints: Vec<String>,
    #[serde(default)]
    provider_definitions_revision: String,
    #[serde(default)]
    followed_source_node_id: Option<String>,
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
pub(crate) struct LanProviderDefinitionsRequestPacket {
    version: u8,
    node_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LanOfficialAccountProfilesRequestPacket {
    version: u8,
    node_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LanTrackedSpendHistoryDebugRequestPacket {
    version: u8,
    node_id: String,
    provider: String,
    day_key: String,
    #[serde(default)]
    limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct LanTrackedSpendHistoryDiagnosticRow {
    pub producer_node_id: String,
    pub producer_node_name: String,
    pub day_key: String,
    pub day_started_at_unix_ms: Option<u64>,
    pub started_at_unix_ms: Option<u64>,
    pub ended_at_unix_ms: Option<u64>,
    pub updated_at_unix_ms: Option<u64>,
    pub tracked_spend_usd: Option<f64>,
    pub last_seen_daily_spent_usd: Option<f64>,
    pub api_key_ref: Option<String>,
    pub row: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct LanTrackedSpendHistoryDebugResponsePacket {
    pub ok: bool,
    pub version: u8,
    pub node_id: String,
    pub node_name: String,
    pub local_node_id: String,
    pub shared_provider_id: String,
    pub provider: String,
    pub day_key: String,
    pub local_rows: Vec<LanTrackedSpendHistoryDiagnosticRow>,
    pub remote_rows: Vec<LanTrackedSpendHistoryDiagnosticRow>,
    pub recent_edit_events: Vec<crate::orchestrator::store::LanEditSyncEvent>,
    pub recent_remove_events: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct TrackedSpendHistoryDayDeleteSyncPayload {
    provider_name: String,
    day_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LanProviderDefinitionSyncItem {
    shared_provider_id: String,
    provider_name: String,
    deleted: bool,
    snapshot: Value,
    lamport_ts: u64,
    revision_event_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LanProviderDefinitionsSyncPacket {
    version: u8,
    node_id: String,
    node_name: String,
    provider_definitions_revision: String,
    definitions: Vec<LanProviderDefinitionSyncItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LanOfficialAccountProfileSyncItem {
    pub source_node_id: String,
    pub source_node_name: String,
    pub remote_profile_id: String,
    #[serde(default)]
    pub identity_key: Option<String>,
    pub summary: crate::orchestrator::secrets::OfficialAccountProfileSummary,
    #[serde(default)]
    pub auth_json: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LanOfficialAccountProfilesSyncPacket {
    version: u8,
    pub node_id: String,
    pub node_name: String,
    pub profiles: Vec<LanOfficialAccountProfileSyncItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LanQuotaRefreshRequestPacket {
    version: u8,
    node_id: String,
    shared_provider_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LanEditSyncHintPacket {
    version: u8,
    node_id: String,
    sent_at_unix_ms: u64,
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
    Heartbeat(Box<LanHeartbeatPacket>),
    SharedHealth(Box<LanSharedHealthPacket>),
    QuotaRefreshRequest(LanQuotaRefreshRequestPacket),
    EditSyncHint(LanEditSyncHintPacket),
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
    Heartbeat(Box<LanHeartbeatPacket>),
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
    last_http_sync_probe: Arc<RwLock<Option<LanHttpSyncProbeSnapshot>>>,
    last_http_sync_failure: Arc<RwLock<Option<LanHttpSyncProbeSnapshot>>>,
    active_http_sync_failures: Arc<RwLock<HashMap<String, LanHttpSyncProbeSnapshot>>>,
    inbound_pair_requests: Arc<RwLock<HashMap<String, LanPendingPairRequest>>>,
    outbound_pair_requests: Arc<RwLock<HashMap<String, LanOutboundPairRequest>>>,
    pair_approvals: Arc<RwLock<HashMap<String, LanPairApprovalState>>>,
    pending_trust_bundle_pins: Arc<RwLock<HashMap<String, String>>>,
    started: Arc<AtomicBool>,
    last_peer_prune_unix_ms: Arc<AtomicU64>,
    /// Tracks whether a build mismatch event has been reported for each peer.
    /// Key: peer node_id, Value: true = mismatch reported
    build_mismatch_reported: Arc<RwLock<HashMap<String, bool>>>,
}

impl LanSyncRuntime {
    pub fn new(local_node: LanNodeIdentity) -> Self {
        Self {
            local_node,
            local_provider_fingerprints: Arc::new(RwLock::new(Vec::new())),
            peers: Arc::new(RwLock::new(HashMap::new())),
            last_peer_heartbeat_received_unix_ms: Arc::new(AtomicU64::new(0)),
            last_peer_heartbeat_source: Arc::new(RwLock::new(None)),
            last_http_sync_probe: Arc::new(RwLock::new(None)),
            last_http_sync_failure: Arc::new(RwLock::new(None)),
            active_http_sync_failures: Arc::new(RwLock::new(HashMap::new())),
            inbound_pair_requests: Arc::new(RwLock::new(HashMap::new())),
            outbound_pair_requests: Arc::new(RwLock::new(HashMap::new())),
            pair_approvals: Arc::new(RwLock::new(HashMap::new())),
            pending_trust_bundle_pins: Arc::new(RwLock::new(HashMap::new())),
            started: Arc::new(AtomicBool::new(false)),
            last_peer_prune_unix_ms: Arc::new(AtomicU64::new(0)),
            build_mismatch_reported: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    fn note_http_sync_probe(
        &self,
        peer: &LanPeerSnapshot,
        route: &str,
        outcome: &str,
        detail: &str,
    ) -> Option<LanHttpSyncProbeSnapshot> {
        let snapshot = LanHttpSyncProbeSnapshot {
            unix_ms: unix_ms(),
            peer_node_id: peer.node_id.clone(),
            peer_listen_addr: peer.listen_addr.clone(),
            route: route.to_string(),
            outcome: outcome.to_string(),
            detail: detail.to_string(),
        };
        let failure_key = lan_http_sync_failure_key(&peer.node_id, route);
        *self.last_http_sync_probe.write() = Some(snapshot.clone());
        let mut failures = self.active_http_sync_failures.write();
        let recovered = if outcome == "ok" {
            failures.remove(&failure_key)
        } else {
            failures.insert(failure_key, snapshot.clone());
            None
        };
        *self.last_http_sync_failure.write() =
            failures.values().max_by_key(|value| value.unix_ms).cloned();
        recovered
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
            if sync_contract_mismatch_detail(&peer, SYNC_DOMAIN_SHARED_HEALTH).is_some() {
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
        let local_build_identity = current_build_identity();
        let local_version_sync = current_local_version_sync_snapshot();
        self.prune_pair_state(now);
        let trusted_node_ids = secrets.trusted_lan_node_ids();
        let inbound_requests = self.inbound_pair_requests.read().clone();
        let outbound_requests = self.outbound_pair_requests.read().clone();
        let last_http_sync_probe = self.last_http_sync_probe.read().clone();
        let last_http_sync_failure = self.last_http_sync_failure.read().clone();
        let peers = self
            .collect_live_peers(now)
            .into_iter()
            .map(|mut peer| {
                enrich_peer_transport_diagnostics(
                    &mut peer,
                    now,
                    last_http_sync_probe.as_ref(),
                    last_http_sync_failure.as_ref(),
                );
                peer.trusted = trusted_node_ids.contains(&peer.node_id);
                peer.pair_state = peer_pair_state(
                    &peer.node_id,
                    &trusted_node_ids,
                    &inbound_requests,
                    &outbound_requests,
                );
                peer.pair_request_id =
                    peer_pair_request_id(&peer.node_id, &inbound_requests, &outbound_requests);
                peer.sync_blocked_domains = sync_domains_blocked_for_peer(&peer);
                peer.sync_diagnostics = sync_domain_diagnostics_for_peer(&peer);
                peer.build_matches_local = peer.build_identity == local_build_identity;
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
            last_http_sync_probe,
            last_http_sync_failure,
            local_node: LanLocalNodeSnapshot {
                node_id: self.local_node.node_id.clone(),
                node_name: self.local_node.node_name.clone(),
                listen_addr: detect_local_listen_addr(listen_port),
                remote_update_updater_port: remote_update_updater_port(listen_port),
                capabilities: lan_heartbeat_capabilities(),
                version_inventory: local_version_inventory(),
                build_identity: local_build_identity,
                version_sync: local_version_sync,
                remote_update_status: load_lan_remote_update_status(),
                sync_contracts: local_sync_contracts(),
                provider_fingerprints: local_provider_fingerprints,
                provider_definitions_revision: provider_definitions_revision(
                    &local_provider_definition_sync_items_from_config(cfg, secrets),
                ),
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
                remote_update_updater_port: remote_update_updater_port(4000),
                last_heartbeat_unix_ms: unix_ms(),
                capabilities: lan_heartbeat_capabilities(),
                version_inventory: local_version_inventory(),
                build_identity: current_build_identity(),
                remote_update_readiness: Some(current_local_remote_update_readiness()),
                remote_update_status: load_lan_remote_update_status(),
                sync_contracts: local_sync_contracts(),
                provider_fingerprints: Vec::new(),
                provider_definitions_revision: String::new(),
                followed_source_node_id: followed_source_node_id.map(ToString::to_string),
            },
        );
    }

    fn note_peer_heartbeat(&self, packet: LanHeartbeatPacket, source: SocketAddr) {
        if packet.node_id.trim().is_empty() || packet.node_id == self.local_node.node_id {
            return;
        }
        let received_at_unix_ms = unix_ms();
        let previous = self.peers.read().get(&packet.node_id).cloned();
        let listen_addr = format!("{}:{}", source.ip(), packet.listen_port);
        self.last_peer_heartbeat_received_unix_ms
            .store(received_at_unix_ms, Ordering::Relaxed);
        *self.last_peer_heartbeat_source.write() = Some(source.to_string());
        let sanitized_name = sanitize_node_name(&packet.node_name);
        let capability_summary = if packet.capabilities.is_empty() {
            "none".to_string()
        } else {
            packet.capabilities.join(",")
        };
        let gap_ms = previous
            .as_ref()
            .map(|peer| received_at_unix_ms.saturating_sub(peer.last_heartbeat_unix_ms))
            .unwrap_or(0);
        let wire_delay_ms = received_at_unix_ms.saturating_sub(packet.sent_at_unix_ms);
        let was_stale = previous
            .as_ref()
            .is_some_and(|peer| peer_is_stale(peer.last_heartbeat_unix_ms, received_at_unix_ms));
        let listen_addr_changed = previous
            .as_ref()
            .is_some_and(|peer| peer.listen_addr != listen_addr);
        let capabilities_changed = previous
            .as_ref()
            .is_some_and(|peer| peer.capabilities != packet.capabilities);
        let version_inventory =
            merge_version_inventory(&packet.capabilities, &packet.sync_contracts);
        self.peers.write().insert(
            packet.node_id.clone(),
            LanPeerRuntime {
                node_id: packet.node_id,
                node_name: sanitized_name.clone(),
                listen_addr: listen_addr.clone(),
                remote_update_updater_port: packet.remote_update_updater_port,
                last_heartbeat_unix_ms: received_at_unix_ms,
                capabilities: packet.capabilities,
                version_inventory,
                build_identity: packet.build_identity,
                remote_update_readiness: packet.remote_update_readiness,
                remote_update_status: packet.remote_update_status,
                sync_contracts: packet.sync_contracts,
                provider_fingerprints: packet.provider_fingerprints,
                provider_definitions_revision: packet.provider_definitions_revision,
                followed_source_node_id: packet.followed_source_node_id,
            },
        );
        match previous {
            None => append_lan_peer_diagnostics_log(&format!(
                "Discovered LAN peer {} from {} listen_addr={} capabilities={}",
                sanitized_name, source, listen_addr, capability_summary
            )),
            Some(previous_peer) if was_stale => append_lan_peer_diagnostics_log(&format!(
                "Peer {} recovered after {}ms without heartbeat; source={} listen_addr={} previous_listen_addr={} sent_at_unix_ms={} receive_minus_sent_ms={} sender_previous_gap_ms={} sender_previous_elapsed_ms={} heartbeat_sequence={} capabilities={}",
                previous_peer.node_id,
                gap_ms,
                source,
                listen_addr,
                previous_peer.listen_addr,
                packet.sent_at_unix_ms,
                wire_delay_ms,
                optional_u64_log_value(packet.sender_previous_gap_ms),
                optional_u64_log_value(packet.sender_previous_elapsed_ms),
                packet.sequence,
                capability_summary
            )),
            Some(previous_peer) if listen_addr_changed => append_lan_peer_diagnostics_log(&format!(
                "Peer {} changed listen_addr from {} to {} after {}ms; source={} sent_at_unix_ms={} receive_minus_sent_ms={} sender_previous_gap_ms={} sender_previous_elapsed_ms={} heartbeat_sequence={}",
                previous_peer.node_id, previous_peer.listen_addr, listen_addr, gap_ms, source, packet.sent_at_unix_ms, wire_delay_ms, optional_u64_log_value(packet.sender_previous_gap_ms), optional_u64_log_value(packet.sender_previous_elapsed_ms), packet.sequence
            )),
            Some(previous_peer) if capabilities_changed => append_lan_peer_diagnostics_log(&format!(
                "Peer {} updated capabilities after {}ms; sent_at_unix_ms={} receive_minus_sent_ms={} sender_previous_gap_ms={} sender_previous_elapsed_ms={} heartbeat_sequence={}; now={}",
                previous_peer.node_id, gap_ms, packet.sent_at_unix_ms, wire_delay_ms, optional_u64_log_value(packet.sender_previous_gap_ms), optional_u64_log_value(packet.sender_previous_elapsed_ms), packet.sequence, capability_summary
            )),
            Some(previous_peer) if gap_ms > LAN_HEARTBEAT_INTERVAL_MS.saturating_mul(2) => {
                append_lan_peer_diagnostics_log(&format!(
                    "Peer {} heartbeat gap {}ms from source={} listen_addr={} sent_at_unix_ms={} receive_minus_sent_ms={} sender_previous_gap_ms={} sender_previous_elapsed_ms={} heartbeat_sequence={}",
                    previous_peer.node_id, gap_ms, source, listen_addr, packet.sent_at_unix_ms, wire_delay_ms, optional_u64_log_value(packet.sender_previous_gap_ms), optional_u64_log_value(packet.sender_previous_elapsed_ms), packet.sequence
                ))
            }
            _ => {}
        }
    }

    fn collect_live_peers(&self, now: u64) -> Vec<LanPeerSnapshot> {
        let should_prune = now.saturating_sub(self.last_peer_prune_unix_ms.load(Ordering::Relaxed))
            >= LAN_PEER_STALE_AFTER_MS / 2;
        let mut out = if should_prune {
            let mut peers = self.peers.write();
            let mut stale_peers = Vec::new();
            peers.retain(|_, peer| {
                let age_ms = now.saturating_sub(peer.last_heartbeat_unix_ms);
                let should_drop = age_ms > LAN_PEER_HISTORY_RETAIN_AFTER_MS;
                if should_drop {
                    stale_peers.push((
                        peer.node_id.clone(),
                        peer.node_name.clone(),
                        peer.listen_addr.clone(),
                        age_ms,
                    ));
                }
                !should_drop
            });
            self.last_peer_prune_unix_ms.store(now, Ordering::Relaxed);
            for (node_id, node_name, listen_addr, age_ms) in stale_peers {
                append_lan_peer_diagnostics_log(&format!(
                    "Pruned historical LAN peer {} ({}) after {}ms without heartbeat; listen_addr={}",
                    node_id, node_name, age_ms, listen_addr
                ));
            }
            peers
                .values()
                .filter(|peer| !peer_is_stale(peer.last_heartbeat_unix_ms, now))
                .map(lan_peer_snapshot_from_runtime)
                .collect::<Vec<_>>()
        } else {
            self.peers
                .read()
                .values()
                .filter(|peer| !peer_is_stale(peer.last_heartbeat_unix_ms, now))
                .map(lan_peer_snapshot_from_runtime)
                .collect::<Vec<_>>()
        };
        out.sort_by(|a, b| {
            b.last_heartbeat_unix_ms
                .cmp(&a.last_heartbeat_unix_ms)
                .then_with(|| a.node_name.cmp(&b.node_name))
        });
        out
    }

    fn heartbeat_delivery_targets(&self, now: u64) -> Vec<SocketAddr> {
        let broadcast_target = SocketAddr::from((Ipv4Addr::BROADCAST, LAN_DISCOVERY_PORT));
        let mut targets = vec![broadcast_target];
        let mut seen = HashSet::from([broadcast_target]);
        for peer in self.peers.read().values() {
            if peer_is_stale(peer.last_heartbeat_unix_ms, now) {
                continue;
            }
            let Ok(listen_addr) = peer.listen_addr.parse::<SocketAddr>() else {
                continue;
            };
            // Heartbeat discovery is UDP on LAN_DISCOVERY_PORT. peer.listen_addr stores the
            // peer's HTTP listen port, so only reuse the IP for a directed unicast heartbeat.
            let target = SocketAddr::new(listen_addr.ip(), LAN_DISCOVERY_PORT);
            if seen.insert(target) {
                targets.push(target);
            }
        }
        targets
    }

    fn live_peer_by_node_id(&self, node_id: &str) -> Option<LanPeerSnapshot> {
        self.collect_live_peers(unix_ms())
            .into_iter()
            .find(|peer| peer.node_id == node_id)
    }

    fn recent_peer_by_node_id(&self, node_id: &str, max_age_ms: u64) -> Option<LanPeerSnapshot> {
        let now = unix_ms();
        self.peers
            .read()
            .get(node_id)
            .filter(|peer| now.saturating_sub(peer.last_heartbeat_unix_ms) <= max_age_ms)
            .map(lan_peer_snapshot_from_runtime)
    }

    pub fn recently_stale_peers(&self, max_age_ms: u64) -> Vec<LanPeerSnapshot> {
        let now = unix_ms();
        let mut peers = self
            .peers
            .read()
            .values()
            .filter(|peer| {
                let age_ms = now.saturating_sub(peer.last_heartbeat_unix_ms);
                peer_is_stale(peer.last_heartbeat_unix_ms, now) && age_ms <= max_age_ms
            })
            .map(lan_peer_snapshot_from_runtime)
            .collect::<Vec<_>>();
        peers.sort_by(|a, b| {
            b.last_heartbeat_unix_ms
                .cmp(&a.last_heartbeat_unix_ms)
                .then_with(|| a.node_name.cmp(&b.node_name))
        });
        peers
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
        gateway.store.events().emit(
            "gateway",
            crate::orchestrator::store::EventCode::LAN_PAIR_REQUEST_SENT,
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
        gateway.store.events().emit(
            "gateway",
            crate::orchestrator::store::EventCode::LAN_PAIR_APPROVED,
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
        gateway.store.events().emit(
            "gateway",
            crate::orchestrator::store::EventCode::LAN_PAIR_PIN_SUBMITTED,
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

pub(crate) async fn lan_sync_provider_definitions_http(
    State(gateway): State<crate::orchestrator::gateway::GatewayState>,
    headers: HeaderMap,
    Json(packet): Json<LanProviderDefinitionsRequestPacket>,
) -> impl IntoResponse {
    if let Err(err) = authorize_lan_sync_http_request(&gateway, &headers, &packet.node_id) {
        return err.into_response();
    }
    let definitions = local_provider_definition_sync_items(&gateway);
    let node = gateway.secrets.get_lan_node_identity();
    Json(serde_json::json!({
        "ok": true,
        "version": 1,
        "node_id": node.as_ref().map(|value| value.node_id.clone()).unwrap_or_default(),
        "node_name": node.as_ref().map(|value| value.node_name.clone()).unwrap_or_default(),
        "provider_definitions_revision": provider_definitions_revision(&definitions),
        "definitions": definitions,
    }))
    .into_response()
}

pub(crate) async fn lan_sync_official_accounts_http(
    State(gateway): State<crate::orchestrator::gateway::GatewayState>,
    headers: HeaderMap,
    Json(packet): Json<LanOfficialAccountProfilesRequestPacket>,
) -> impl IntoResponse {
    if let Err(err) = authorize_lan_sync_http_request(&gateway, &headers, &packet.node_id) {
        return err.into_response();
    }
    let node = gateway.secrets.get_lan_node_identity();
    let node_id = node
        .as_ref()
        .map(|value| value.node_id.clone())
        .unwrap_or_default();
    let node_name = node
        .as_ref()
        .map(|value| value.node_name.clone())
        .unwrap_or_default();
    let profiles = gateway
        .secrets
        .export_official_account_sync_items()
        .into_iter()
        .map(|item| LanOfficialAccountProfileSyncItem {
            source_node_id: node_id.clone(),
            source_node_name: node_name.clone(),
            remote_profile_id: item.id,
            identity_key: item.identity_key,
            summary: item.summary,
            auth_json: Some(item.auth_json),
        })
        .collect::<Vec<_>>();
    Json(serde_json::json!({
        "ok": true,
        "version": 1,
        "node_id": node_id,
        "node_name": node_name,
        "profiles": profiles,
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

fn send_heartbeat_packet(
    packet: &LanHeartbeatPacket,
    targets: &[SocketAddr],
) -> Result<(), String> {
    let bytes = serde_json::to_vec(&LanWirePacket::Heartbeat(Box::new(packet.clone())))
        .map_err(|err| err.to_string())?;
    let mut sent_count = 0_usize;
    let mut errors = Vec::new();
    for target in targets {
        match send_wire_bytes(*target, &bytes) {
            Ok(()) => sent_count += 1,
            Err(err) => errors.push(format!("{target}: {err}")),
        }
    }
    if sent_count > 0 {
        Ok(())
    } else {
        Err(if errors.is_empty() {
            "no heartbeat targets".to_string()
        } else {
            errors.join("; ")
        })
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct QuotaSnapshotSyncPayload {
    provider_name: String,
    snapshot: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TrackedSpendDaySyncPayload {
    provider_name: String,
    day_started_at_unix_ms: u64,
    row: Value,
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
    pub supports_websockets: bool,
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

fn local_node_identity_for_edit_recording() -> Option<LanNodeIdentity> {
    gateway_status_runtime()
        .read()
        .as_ref()
        .map(|runtime| runtime.local_node.clone())
}

pub(crate) fn current_local_node_identity() -> Option<LanNodeIdentity> {
    local_node_identity_for_edit_recording()
}

fn gateway_local_node_identity(
    gateway: &crate::orchestrator::gateway::GatewayState,
) -> Option<LanNodeIdentity> {
    gateway.secrets.get_lan_node_identity()
}

fn resolve_provider_name_for_shared_provider_id(
    gateway: &crate::orchestrator::gateway::GatewayState,
    shared_provider_id: &str,
    provider_name_hint: &str,
) -> Result<String, String> {
    if let Some(provider_name) = gateway
        .secrets
        .find_provider_by_shared_id(shared_provider_id)
    {
        return Ok(provider_name);
    }
    if !provider_name_hint.trim().is_empty()
        && gateway
            .cfg
            .read()
            .providers
            .contains_key(provider_name_hint)
    {
        gateway
            .secrets
            .set_provider_shared_id(provider_name_hint, shared_provider_id)?;
        return Ok(provider_name_hint.to_string());
    }
    Err(format!("unknown shared provider id: {shared_provider_id}"))
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
        supports_websockets: provider_cfg.supports_websockets,
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
    if let Some(supports_websockets) = payload_bool_field(payload, "supports_websockets") {
        next.supports_websockets = supports_websockets;
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
    let event = record_edit_event(
        &state.gateway,
        &state.lan_sync.local_node,
        "provider_definition",
        &shared_provider_id,
        "patch",
        patch.clone(),
    )?;
    apply_provider_definition_patch(
        &state.gateway,
        &state.config_path,
        &state.lan_sync.local_node.node_id,
        &state.lan_sync.local_node.node_name,
        &shared_provider_id,
        event.lamport_ts,
        &event.event_id,
        &patch,
    )
}

fn provider_definition_seed_meta_key(shared_provider_id: &str) -> String {
    format!("lan_provider_definition_seed:{shared_provider_id}")
}

fn provider_pricing_seed_meta_key(shared_provider_id: &str) -> String {
    format!("lan_provider_pricing_seed:{shared_provider_id}")
}

fn quota_snapshot_seed_meta_key(shared_provider_id: &str) -> String {
    format!("lan_quota_snapshot_seed:{shared_provider_id}")
}

fn spend_manual_day_seed_meta_key(entity_id: &str) -> String {
    format!("lan_spend_manual_day_seed:{entity_id}")
}

fn tracked_spend_day_seed_meta_key(entity_id: &str) -> String {
    format!("lan_tracked_spend_day_seed:{entity_id}")
}

fn seed_payload_revision(value: &Value) -> Result<String, String> {
    serde_json::to_string(value).map_err(|err| err.to_string())
}

fn provider_pricing_entity_id(shared_provider_id: &str, source_node_id: &str) -> String {
    format!("{shared_provider_id}|{source_node_id}")
}

fn spend_manual_day_entity_id(
    shared_provider_id: &str,
    day_key: &str,
    source_node_id: &str,
) -> String {
    format!("{shared_provider_id}|{day_key}|{source_node_id}")
}

fn tracked_spend_day_entity_id(
    shared_provider_id: &str,
    day_started_at_unix_ms: u64,
    source_node_id: &str,
) -> String {
    format!("{shared_provider_id}|{day_started_at_unix_ms}|{source_node_id}")
}

fn parse_provider_pricing_entity_id<'a>(
    entity_id: &'a str,
    fallback_node_id: &'a str,
) -> (&'a str, &'a str) {
    entity_id
        .split_once('|')
        .unwrap_or((entity_id, fallback_node_id))
}

fn parse_day_scoped_entity_id<'a>(
    entity_id: &'a str,
    fallback_node_id: &'a str,
) -> Result<(&'a str, &'a str, &'a str), String> {
    let parts = entity_id.split('|').collect::<Vec<_>>();
    match parts.as_slice() {
        [shared_provider_id, day_scope, source_node_id] => {
            Ok((shared_provider_id, day_scope, source_node_id))
        }
        [shared_provider_id, day_scope] => Ok((shared_provider_id, day_scope, fallback_node_id)),
        _ => Err(format!("invalid source-scoped entity id: {entity_id}")),
    }
}

fn tracked_spend_day_source_identity(
    row: &Value,
    fallback_node_id: &str,
    fallback_node_name: &str,
) -> Option<(String, String)> {
    let source_node_id = row
        .get("producer_node_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_node_id)
        .to_string();
    let source_node_name = row
        .get("producer_node_name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_node_name)
        .to_string();
    if source_node_id.is_empty() {
        return None;
    }
    Some((source_node_id, source_node_name))
}

fn normalize_tracked_spend_day_seed_row(row: &Value) -> Value {
    let mut normalized = row.clone();
    if let Some(map) = normalized.as_object_mut() {
        map.remove("applied_at_unix_ms");
        map.remove("applied_from_node_id");
        map.remove("applied_from_node_name");
    }
    normalized
}

fn tracked_spend_history_day_delete_entity_id(shared_provider_id: &str, day_key: &str) -> String {
    format!("{shared_provider_id}|{day_key}")
}

fn parse_provider_day_entity_id(entity_id: &str) -> Result<(&str, &str), String> {
    entity_id
        .split_once('|')
        .ok_or_else(|| format!("invalid provider-day entity id: {entity_id}"))
}

fn seed_edit_event_if_changed(
    state: &crate::app_state::AppState,
    entity_type: &str,
    entity_id: &str,
    op: &str,
    payload: Value,
    meta_key: &str,
) -> Result<(), String> {
    let next_revision = seed_payload_revision(&payload)?;
    let current_revision = state
        .gateway
        .store
        .get_event_meta(meta_key)
        .map_err(|err| err.to_string())?;
    if current_revision.as_deref() == Some(next_revision.as_str()) {
        return Ok(());
    }
    let _ = record_edit_event(
        &state.gateway,
        &state.lan_sync.local_node,
        entity_type,
        entity_id,
        op,
        payload,
    )?;
    let _ = state.gateway.store.set_event_meta(meta_key, &next_revision);
    Ok(())
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
            record_provider_definition_patch(state, &provider, payload)?;
            let _ = state
                .gateway
                .store
                .set_event_meta(&provider_definition_seed_meta_key(&shared_provider_id), "1");
        }

        let mut pricing_map = state.secrets.list_provider_pricing();
        let pricing = pricing_map.remove(&provider);
        let pricing_payload = serde_json::to_value(ProviderPricingSyncPayload {
            provider_name: provider.clone(),
            pricing,
        })
        .map_err(|err| err.to_string())?;
        let pricing_entity_id =
            provider_pricing_entity_id(&shared_provider_id, &state.lan_sync.local_node.node_id);
        seed_edit_event_if_changed(
            state,
            "provider_pricing",
            &pricing_entity_id,
            "replace",
            pricing_payload,
            &provider_pricing_seed_meta_key(&shared_provider_id),
        )?;

        if let Some(snapshot) = state.gateway.store.get_quota_snapshot(&provider) {
            let snapshot_payload = serde_json::to_value(QuotaSnapshotSyncPayload {
                provider_name: provider.clone(),
                snapshot,
            })
            .map_err(|err| err.to_string())?;
            seed_edit_event_if_changed(
                state,
                "quota_snapshot",
                &shared_provider_id,
                "replace",
                snapshot_payload,
                &quota_snapshot_seed_meta_key(&shared_provider_id),
            )?;
        }

        for row in state.gateway.store.list_local_spend_days(&provider) {
            let Some(day_started_at_unix_ms) =
                row.get("started_at_unix_ms").and_then(Value::as_u64)
            else {
                continue;
            };
            let Some((source_node_id, _source_node_name)) = tracked_spend_day_source_identity(
                &row,
                &state.lan_sync.local_node.node_id,
                &state.lan_sync.local_node.node_name,
            ) else {
                continue;
            };
            let entity_id = tracked_spend_day_entity_id(
                &shared_provider_id,
                day_started_at_unix_ms,
                &source_node_id,
            );
            let tracked_payload = serde_json::to_value(TrackedSpendDaySyncPayload {
                provider_name: provider.clone(),
                day_started_at_unix_ms,
                row: normalize_tracked_spend_day_seed_row(&row),
            })
            .map_err(|err| err.to_string())?;
            seed_edit_event_if_changed(
                state,
                LAN_EDIT_ENTITY_TRACKED_SPEND_DAY,
                &entity_id,
                "replace",
                tracked_payload,
                &tracked_spend_day_seed_meta_key(&entity_id),
            )?;
        }

        for row in state.gateway.store.list_local_spend_manual_days(&provider) {
            let Some(day_key) = row
                .get("day_key")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            let entity_id = spend_manual_day_entity_id(
                &shared_provider_id,
                day_key,
                &state.lan_sync.local_node.node_id,
            );
            let manual_payload = serde_json::to_value(SpendManualDaySyncPayload {
                provider_name: provider.clone(),
                day_key: day_key.to_string(),
                manual_total_usd: row.get("manual_total_usd").and_then(Value::as_f64),
                manual_usd_per_req: row.get("manual_usd_per_req").and_then(Value::as_f64),
            })
            .map_err(|err| err.to_string())?;
            seed_edit_event_if_changed(
                state,
                "spend_manual_day",
                &entity_id,
                "replace",
                manual_payload,
                &spend_manual_day_seed_meta_key(&entity_id),
            )?;
        }
    }
    Ok(())
}

pub fn record_provider_definition_tombstone(
    state: &crate::app_state::AppState,
    provider: &str,
) -> Result<(), String> {
    let shared_provider_id = shared_provider_id_for_provider(&state.secrets, provider)?;
    let event = record_edit_event(
        &state.gateway,
        &state.lan_sync.local_node,
        "provider_definition",
        &shared_provider_id,
        "tombstone",
        serde_json::json!({ "name": provider }),
    )?;
    apply_provider_definition_tombstone(
        &state.gateway,
        &state.config_path,
        &state.lan_sync.local_node.node_id,
        &state.lan_sync.local_node.node_name,
        &shared_provider_id,
        event.lamport_ts,
        &event.event_id,
    )
}

pub fn record_provider_pricing_snapshot(
    state: &crate::app_state::AppState,
    provider: &str,
) -> Result<(), String> {
    let shared_provider_id = shared_provider_id_for_provider(&state.secrets, provider)?;
    let entity_id =
        provider_pricing_entity_id(&shared_provider_id, &state.lan_sync.local_node.node_id);
    let mut pricing_map = state.secrets.list_provider_pricing();
    let pricing = pricing_map.remove(provider);
    let payload = serde_json::to_value(ProviderPricingSyncPayload {
        provider_name: provider.to_string(),
        pricing,
    })
    .map_err(|err| err.to_string())?;
    let _ = record_edit_event(
        &state.gateway,
        &state.lan_sync.local_node,
        "provider_pricing",
        &entity_id,
        "replace",
        payload,
    )?;
    Ok(())
}

pub fn record_spend_manual_day(
    state: &crate::app_state::AppState,
    provider: &str,
    day_key: &str,
    manual_total_usd: Option<f64>,
    manual_usd_per_req: Option<f64>,
) -> Result<(), String> {
    let shared_provider_id = shared_provider_id_for_provider(&state.secrets, provider)?;
    let entity_id = spend_manual_day_entity_id(
        &shared_provider_id,
        day_key.trim(),
        &state.lan_sync.local_node.node_id,
    );
    let payload = serde_json::to_value(SpendManualDaySyncPayload {
        provider_name: provider.to_string(),
        day_key: day_key.trim().to_string(),
        manual_total_usd,
        manual_usd_per_req,
    })
    .map_err(|err| err.to_string())?;
    let _ = record_edit_event(
        &state.gateway,
        &state.lan_sync.local_node,
        "spend_manual_day",
        &entity_id,
        "replace",
        payload,
    )?;
    Ok(())
}

pub fn record_quota_snapshot_from_gateway(
    gateway: &crate::orchestrator::gateway::GatewayState,
    secrets: &SecretStore,
    provider: &str,
    snapshot: &crate::orchestrator::quota::QuotaSnapshot,
) -> Result<(), String> {
    let Some(local_node) = local_node_identity_for_edit_recording() else {
        return Ok(());
    };
    let shared_provider_id = shared_provider_id_for_provider(secrets, provider)?;
    let payload = serde_json::to_value(QuotaSnapshotSyncPayload {
        provider_name: provider.to_string(),
        snapshot: snapshot.to_json(),
    })
    .map_err(|err| err.to_string())?;
    let _ = record_edit_event(
        gateway,
        &local_node,
        "quota_snapshot",
        &shared_provider_id,
        "replace",
        payload,
    )?;
    Ok(())
}

pub fn remove_tracked_spend_history_day_from_gateway(
    gateway: &crate::orchestrator::gateway::GatewayState,
    provider: &str,
    day_key: &str,
) -> Result<usize, String> {
    let normalized_day_key = day_key.trim();
    if normalized_day_key.is_empty() {
        return Err("day_key is required".to_string());
    }
    let local_node_id = current_local_node_identity()
        .map(|node| node.node_id)
        .unwrap_or_default();
    let mut removed = 0usize;
    for day in gateway.store.list_local_spend_days(provider) {
        let Some(day_started_at_unix_ms) = day.get("started_at_unix_ms").and_then(Value::as_u64)
        else {
            continue;
        };
        if tracked_spend_history_day_key_for_debug(&day).as_deref() == Some(normalized_day_key) {
            gateway
                .store
                .remove_spend_day(provider, day_started_at_unix_ms);
            removed = removed.saturating_add(1);
        }
    }
    for day in gateway.store.list_remote_spend_days(provider) {
        let Some(day_started_at_unix_ms) = day.get("started_at_unix_ms").and_then(Value::as_u64)
        else {
            continue;
        };
        if tracked_spend_history_day_key_for_debug(&day).as_deref() != Some(normalized_day_key) {
            continue;
        }
        let producer_node_id = day
            .get("producer_node_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(local_node_id.as_str());
        gateway
            .store
            .remove_remote_spend_day(provider, producer_node_id, day_started_at_unix_ms);
        removed = removed.saturating_add(1);
    }
    Ok(removed)
}

pub fn record_tracked_spend_history_day_removal_from_gateway(
    gateway: &crate::orchestrator::gateway::GatewayState,
    secrets: &SecretStore,
    provider: &str,
    day_key: &str,
) -> Result<(), String> {
    let Some(local_node) = local_node_identity_for_edit_recording() else {
        return Ok(());
    };
    let shared_provider_id = shared_provider_id_for_provider(secrets, provider)?;
    let entity_id = tracked_spend_history_day_delete_entity_id(&shared_provider_id, day_key.trim());
    let payload = serde_json::to_value(TrackedSpendHistoryDayDeleteSyncPayload {
        provider_name: provider.to_string(),
        day_key: day_key.trim().to_string(),
    })
    .map_err(|err| err.to_string())?;
    let _ = record_edit_event(
        gateway,
        &local_node,
        LAN_EDIT_ENTITY_TRACKED_SPEND_DAY_HISTORY_DELETE,
        &entity_id,
        "delete",
        payload,
    )?;
    Ok(())
}

pub fn record_tracked_spend_day_from_gateway(
    gateway: &crate::orchestrator::gateway::GatewayState,
    secrets: &SecretStore,
    provider: &str,
    day_started_at_unix_ms: u64,
    row: &Value,
) -> Result<(), String> {
    let Some(local_node) = local_node_identity_for_edit_recording() else {
        return Ok(());
    };
    let shared_provider_id = shared_provider_id_for_provider(secrets, provider)?;
    let (source_node_id, _source_node_name) =
        tracked_spend_day_source_identity(row, &local_node.node_id, &local_node.node_name)
            .ok_or_else(|| "tracked spend day row is missing a source node id".to_string())?;
    let entity_id =
        tracked_spend_day_entity_id(&shared_provider_id, day_started_at_unix_ms, &source_node_id);
    let payload = serde_json::to_value(TrackedSpendDaySyncPayload {
        provider_name: provider.to_string(),
        day_started_at_unix_ms,
        row: normalize_tracked_spend_day_seed_row(row),
    })
    .map_err(|err| err.to_string())?;
    let _ = record_edit_event(
        gateway,
        &local_node,
        LAN_EDIT_ENTITY_TRACKED_SPEND_DAY,
        &entity_id,
        "replace",
        payload,
    )?;
    Ok(())
}

fn record_edit_event(
    gateway: &crate::orchestrator::gateway::GatewayState,
    local_node: &LanNodeIdentity,
    entity_type: &str,
    entity_id: &str,
    op: &str,
    payload: Value,
) -> Result<crate::orchestrator::store::LanEditSyncEvent, String> {
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
        let _ = refresh_shared_tracked_spend_projection_for_event(gateway, &event);
        if should_request_immediate_edit_sync(entity_type) {
            request_immediate_edit_sync_from_live_peers(gateway);
        }
        Ok(event)
    } else {
        Err("failed to insert edit sync event".to_string())
    }
}

fn should_request_immediate_edit_sync(entity_type: &str) -> bool {
    matches!(
        lan_edit_entity_sync_domain(entity_type),
        Some(SYNC_DOMAIN_USAGE_HISTORY)
    )
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
    set_entity_version(
        gateway,
        &event.entity_type,
        &event.entity_id,
        event.lamport_ts,
        &event.node_id,
        &event.event_id,
    );
}

fn set_entity_version(
    gateway: &crate::orchestrator::gateway::GatewayState,
    entity_type: &str,
    entity_id: &str,
    lamport_ts: u64,
    node_id: &str,
    event_id: &str,
) {
    let _ = gateway.store.set_event_meta(
        &entity_version_meta_key(entity_type, entity_id),
        &format!("{lamport_ts}|{node_id}|{event_id}"),
    );
}

fn local_provider_definition_sync_items(
    gateway: &crate::orchestrator::gateway::GatewayState,
) -> Vec<LanProviderDefinitionSyncItem> {
    let cfg = gateway.cfg.read().clone();
    local_provider_definition_sync_items_from_config(&cfg, &gateway.secrets)
}

fn provider_definitions_revision(items: &[LanProviderDefinitionSyncItem]) -> String {
    let Ok(bytes) = serde_json::to_vec(items) else {
        return String::new();
    };
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn replace_remote_provider_definition_snapshots(
    gateway: &crate::orchestrator::gateway::GatewayState,
    config_path: &Path,
    source_node_id: &str,
    source_node_name: &str,
    items: &[LanProviderDefinitionSyncItem],
) -> Result<(), String> {
    let existing = gateway
        .store
        .list_all_lan_provider_definition_snapshots(source_node_id)
        .into_iter()
        .map(|row| row.shared_provider_id)
        .collect::<std::collections::BTreeSet<_>>();
    let incoming = items
        .iter()
        .map(|item| item.shared_provider_id.clone())
        .collect::<std::collections::BTreeSet<_>>();

    for item in items {
        let record = crate::orchestrator::store::LanProviderDefinitionSnapshotRecord {
            source_node_id: source_node_id.to_string(),
            source_node_name: source_node_name.to_string(),
            shared_provider_id: item.shared_provider_id.clone(),
            provider_name: item.provider_name.clone(),
            deleted: item.deleted,
            snapshot: item.snapshot.clone(),
            updated_at_unix_ms: unix_ms(),
            lamport_ts: item.lamport_ts,
            revision_event_id: item.revision_event_id.clone(),
        };
        gateway
            .store
            .upsert_lan_provider_definition_snapshot(&record)?;
        set_entity_version(
            gateway,
            "provider_definition",
            &item.shared_provider_id,
            item.lamport_ts,
            source_node_id,
            &item.revision_event_id,
        );
    }

    for stale_shared_provider_id in existing.difference(&incoming) {
        gateway
            .store
            .remove_lan_provider_definition_snapshot(source_node_id, stale_shared_provider_id)?;
        let _ = gateway.store.delete_event_meta(&entity_version_meta_key(
            "provider_definition",
            stale_shared_provider_id,
        ));
    }

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
    entity_id: &str,
    payload: &Value,
    event: &crate::orchestrator::store::LanEditSyncEvent,
) -> Result<(), String> {
    let payload: ProviderPricingSyncPayload =
        serde_json::from_value(payload.clone()).map_err(|err| err.to_string())?;
    let (shared_provider_id, source_node_id) =
        parse_provider_pricing_entity_id(entity_id, &event.node_id);
    let provider_name = resolve_provider_name_for_shared_provider_id(
        gateway,
        shared_provider_id,
        &payload.provider_name,
    )?;
    gateway.store.put_remote_provider_pricing_config(
        &provider_name,
        source_node_id,
        &event.node_name,
        payload.pricing.as_ref(),
    );
    Ok(())
}

fn apply_quota_snapshot_event(
    gateway: &crate::orchestrator::gateway::GatewayState,
    shared_provider_id: &str,
    payload: &Value,
    event: &crate::orchestrator::store::LanEditSyncEvent,
) -> Result<(), String> {
    let payload: QuotaSnapshotSyncPayload =
        serde_json::from_value(payload.clone()).map_err(|err| err.to_string())?;
    let provider_name = resolve_provider_name_for_shared_provider_id(
        gateway,
        shared_provider_id,
        &payload.provider_name,
    )?;
    let mut snapshot = crate::orchestrator::quota::quota_snapshot_from_json(&payload.snapshot)
        .ok_or_else(|| "invalid quota snapshot payload".to_string())?;
    if snapshot.producer_node_id.is_none() {
        snapshot.producer_node_id = Some(event.node_id.clone());
    }
    if snapshot.producer_node_name.is_none() {
        snapshot.producer_node_name = Some(event.node_name.clone());
    }
    crate::orchestrator::quota::apply_remote_quota_snapshot(
        gateway,
        &provider_name,
        &snapshot,
        Some(event.node_id.as_str()),
        Some(event.node_name.as_str()),
    );
    Ok(())
}

fn apply_spend_manual_day_event(
    gateway: &crate::orchestrator::gateway::GatewayState,
    entity_id: &str,
    payload: &Value,
    event: &crate::orchestrator::store::LanEditSyncEvent,
) -> Result<(), String> {
    let payload: SpendManualDaySyncPayload =
        serde_json::from_value(payload.clone()).map_err(|err| err.to_string())?;
    let (shared_provider_id, _day_scope, source_node_id) =
        parse_day_scoped_entity_id(entity_id, &event.node_id)?;
    let provider_name = resolve_provider_name_for_shared_provider_id(
        gateway,
        shared_provider_id,
        &payload.provider_name,
    )?;
    if payload.manual_total_usd.is_none() && payload.manual_usd_per_req.is_none() {
        gateway.store.remove_remote_spend_manual_day(
            &provider_name,
            source_node_id,
            &payload.day_key,
        );
    } else {
        let row = serde_json::json!({
            "provider": provider_name,
            "day_key": payload.day_key,
            "manual_total_usd": payload.manual_total_usd,
            "manual_usd_per_req": payload.manual_usd_per_req,
            "updated_at_unix_ms": unix_ms(),
            "producer_node_id": event.node_id,
            "producer_node_name": event.node_name,
            "applied_from_node_id": event.node_id,
            "applied_from_node_name": event.node_name,
            "applied_at_unix_ms": unix_ms(),
        });
        gateway.store.put_remote_spend_manual_day(
            &provider_name,
            source_node_id,
            &event.node_name,
            &payload.day_key,
            &row,
        );
    }
    Ok(())
}

fn apply_tracked_spend_day_event(
    gateway: &crate::orchestrator::gateway::GatewayState,
    entity_id: &str,
    payload: &Value,
    event: &crate::orchestrator::store::LanEditSyncEvent,
) -> Result<(), String> {
    let payload: TrackedSpendDaySyncPayload =
        serde_json::from_value(payload.clone()).map_err(|err| err.to_string())?;
    let event_projection = event.clone();
    let (shared_provider_id, _day_scope, source_node_id) =
        parse_day_scoped_entity_id(entity_id, &event.node_id)?;
    let provider_name = resolve_provider_name_for_shared_provider_id(
        gateway,
        shared_provider_id,
        &payload.provider_name,
    )?;
    if event.op == "delete" {
        let local_node_id = gateway_local_node_identity(gateway)
            .map(|node| node.node_id)
            .unwrap_or_default();
        if source_node_id == local_node_id {
            gateway
                .store
                .remove_spend_day(&provider_name, payload.day_started_at_unix_ms);
        } else {
            gateway.store.remove_remote_spend_day(
                &provider_name,
                source_node_id,
                payload.day_started_at_unix_ms,
            );
        }
        refresh_shared_tracked_spend_projection_for_event(gateway, &event_projection)?;
        return Ok(());
    }
    let mut row = payload.row.clone();
    let (producer_node_id, producer_node_name) =
        tracked_spend_day_source_identity(&row, source_node_id, &event.node_name)
            .ok_or_else(|| "tracked spend day row is missing a source node id".to_string())?;
    if let Some(map) = row.as_object_mut() {
        map.insert(
            "producer_node_id".to_string(),
            Value::String(producer_node_id.clone()),
        );
        map.insert(
            "producer_node_name".to_string(),
            Value::String(producer_node_name.clone()),
        );
        map.insert(
            "applied_from_node_id".to_string(),
            Value::String(event.node_id.clone()),
        );
        map.insert(
            "applied_from_node_name".to_string(),
            Value::String(event.node_name.clone()),
        );
        map.insert(
            "applied_at_unix_ms".to_string(),
            serde_json::json!(unix_ms()),
        );
    }
    gateway.store.put_remote_spend_day(
        &provider_name,
        source_node_id,
        &producer_node_name,
        payload.day_started_at_unix_ms,
        &row,
    );
    refresh_shared_tracked_spend_projection_for_event(gateway, &event_projection)?;
    Ok(())
}

fn apply_tracked_spend_history_day_delete_event(
    gateway: &crate::orchestrator::gateway::GatewayState,
    entity_id: &str,
    payload: &Value,
) -> Result<(), String> {
    let payload: TrackedSpendHistoryDayDeleteSyncPayload =
        serde_json::from_value(payload.clone()).map_err(|err| err.to_string())?;
    let projection_event = crate::orchestrator::store::LanEditSyncEvent {
        event_id: String::new(),
        node_id: String::new(),
        node_name: String::new(),
        created_at_unix_ms: 0,
        lamport_ts: 0,
        entity_type: LAN_EDIT_ENTITY_TRACKED_SPEND_DAY_HISTORY_DELETE.to_string(),
        entity_id: entity_id.to_string(),
        op: "delete".to_string(),
        payload: serde_json::to_value(payload.clone()).map_err(|err| err.to_string())?,
    };
    let (shared_provider_id, day_key) = parse_provider_day_entity_id(entity_id)?;
    let provider_name = resolve_provider_name_for_shared_provider_id(
        gateway,
        shared_provider_id,
        &payload.provider_name,
    )?;
    if payload.day_key.trim() != day_key {
        return Err(format!(
            "tracked spend day delete payload mismatch: entity_id day_key={day_key} payload day_key={}",
            payload.day_key
        ));
    }
    let _ = remove_tracked_spend_history_day_from_gateway(gateway, &provider_name, day_key)?;
    refresh_shared_tracked_spend_projection_for_event(gateway, &projection_event)?;
    Ok(())
}

fn apply_lan_edit_event(
    gateway: &crate::orchestrator::gateway::GatewayState,
    config_path: &Path,
    event: &crate::orchestrator::store::LanEditSyncEvent,
) -> Result<(), String> {
    match event.entity_type.as_str() {
        LAN_EDIT_ENTITY_PROVIDER_DEFINITION => match event.op.as_str() {
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
        LAN_EDIT_ENTITY_PROVIDER_PRICING => {
            apply_provider_pricing_event(gateway, &event.entity_id, &event.payload, event)
        }
        LAN_EDIT_ENTITY_QUOTA_SNAPSHOT => {
            apply_quota_snapshot_event(gateway, &event.entity_id, &event.payload, event)
        }
        LAN_EDIT_ENTITY_SPEND_MANUAL_DAY => {
            apply_spend_manual_day_event(gateway, &event.entity_id, &event.payload, event)
        }
        LAN_EDIT_ENTITY_TRACKED_SPEND_DAY => {
            apply_tracked_spend_day_event(gateway, &event.entity_id, &event.payload, event)
        }
        LAN_EDIT_ENTITY_TRACKED_SPEND_DAY_HISTORY_DELETE => {
            apply_tracked_spend_history_day_delete_event(gateway, &event.entity_id, &event.payload)
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
                            let node_id = packet.node_id.clone();
                            runtime.note_peer_heartbeat(*packet, source);
                            if let Some(peer) = runtime.peers.read().get(&node_id) {
                                let snapshot = lan_peer_snapshot_from_runtime(peer);
                                ensure_peer_build_compatible(&runtime, &gateway, &snapshot);
                            }
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
                                    let node_id = packet.node_id.clone();
                                    runtime.note_peer_heartbeat(*packet, source);
                                    if let Some(peer) = runtime.peers.read().get(&node_id) {
                                        let snapshot = lan_peer_snapshot_from_runtime(peer);
                                        ensure_peer_build_compatible(&runtime, &gateway, &snapshot);
                                    }
                                }
                                LanSyncPacket::SharedHealth(packet) => {
                                    apply_shared_health_packet(&runtime, &gateway, *packet);
                                }
                                LanSyncPacket::QuotaRefreshRequest(packet) => {
                                    handle_quota_refresh_request(&runtime, &gateway, packet);
                                }
                                LanSyncPacket::EditSyncHint(packet) => {
                                    handle_edit_sync_hint(
                                        &runtime,
                                        &gateway,
                                        &config_path,
                                        source,
                                        packet,
                                    );
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
    let mut last_heartbeat_sent_unix_ms: Option<u64> = None;
    let mut last_heartbeat_elapsed_ms: Option<u64> = None;
    let mut heartbeat_sequence: u64 = 0;
    let mut sender_delay_active = false;
    let mut sender_delay_gap_ms: Option<u64> = None;
    loop {
        let heartbeat_started_unix_ms = unix_ms();
        let sender_previous_gap_ms = last_heartbeat_sent_unix_ms
            .map(|last_sent| heartbeat_started_unix_ms.saturating_sub(last_sent));
        if let Some(delay_ms) =
            heartbeat_sender_delay_ms(last_heartbeat_sent_unix_ms, heartbeat_started_unix_ms)
        {
            if !sender_delay_active {
                append_lan_peer_diagnostics_log(&format!(
                    "Heartbeat sender delayed {}ms before broadcast; node={} name={}",
                    delay_ms, runtime.local_node.node_id, runtime.local_node.node_name
                ));
            }
            sender_delay_active = true;
            sender_delay_gap_ms = Some(delay_ms);
        }
        let cfg_started_unix_ms = unix_ms();
        let cfg_snapshot = gateway.cfg.read().clone();
        let cfg_elapsed_ms = heartbeat_step_elapsed_ms(cfg_started_unix_ms);
        let provider_fingerprints_started_unix_ms = unix_ms();
        let provider_fingerprints = build_provider_fingerprints(&cfg_snapshot, &gateway.secrets);
        let provider_fingerprints_elapsed_ms =
            heartbeat_step_elapsed_ms(provider_fingerprints_started_unix_ms);
        let provider_definitions_started_unix_ms = unix_ms();
        let provider_definition_items = local_provider_definition_sync_items(&gateway);
        let provider_definitions_elapsed_ms =
            heartbeat_step_elapsed_ms(provider_definitions_started_unix_ms);
        *runtime.local_provider_fingerprints.write() = provider_fingerprints.clone();
        heartbeat_sequence = heartbeat_sequence.saturating_add(1);
        let remote_update_started_unix_ms = unix_ms();
        let remote_update_readiness = Some(current_local_remote_update_readiness());
        let remote_update_status = load_lan_remote_update_status();
        let remote_update_elapsed_ms = heartbeat_step_elapsed_ms(remote_update_started_unix_ms);
        let sync_contracts_started_unix_ms = unix_ms();
        let sync_contracts = local_sync_contracts();
        let sync_contracts_elapsed_ms = heartbeat_step_elapsed_ms(sync_contracts_started_unix_ms);
        let followed_source_started_unix_ms = unix_ms();
        let followed_source_node_id = gateway.secrets.get_followed_config_source_node_id();
        let followed_source_elapsed_ms = heartbeat_step_elapsed_ms(followed_source_started_unix_ms);
        let packet = LanSyncPacket::Heartbeat(Box::new(LanHeartbeatPacket {
            version: 1,
            node_id: runtime.local_node.node_id.clone(),
            node_name: runtime.local_node.node_name.clone(),
            listen_port: cfg_snapshot.listen.port,
            remote_update_updater_port: remote_update_updater_port(cfg_snapshot.listen.port),
            sent_at_unix_ms: heartbeat_started_unix_ms,
            sequence: heartbeat_sequence,
            sender_previous_gap_ms,
            sender_previous_elapsed_ms: last_heartbeat_elapsed_ms,
            capabilities: lan_heartbeat_capabilities(),
            build_identity: current_build_identity(),
            remote_update_readiness,
            remote_update_status,
            sync_contracts,
            provider_fingerprints,
            provider_definitions_revision: provider_definitions_revision(
                &provider_definition_items,
            ),
            followed_source_node_id,
        }));
        let prep_elapsed_ms = heartbeat_step_elapsed_ms(heartbeat_started_unix_ms);
        if prep_elapsed_ms >= LAN_HEARTBEAT_PREP_SLOW_LOG_THRESHOLD_MS {
            append_lan_peer_diagnostics_log(&format!(
                "Heartbeat sender prep slow {}ms; node={} name={} cfg={}ms provider_fingerprints={}ms provider_definitions={}ms remote_update={}ms sync_contracts={}ms followed_source={}ms",
                prep_elapsed_ms,
                runtime.local_node.node_id,
                runtime.local_node.node_name,
                cfg_elapsed_ms,
                provider_fingerprints_elapsed_ms,
                provider_definitions_elapsed_ms,
                remote_update_elapsed_ms,
                sync_contracts_elapsed_ms,
                followed_source_elapsed_ms
            ));
        }
        if let LanSyncPacket::Heartbeat(ref heartbeat) = packet {
            let targets = runtime.heartbeat_delivery_targets(heartbeat_started_unix_ms);
            if let Err(err) = send_heartbeat_packet(heartbeat, &targets) {
                log::warn!("lan sync sender heartbeat failed: {err}");
                let failure_context = match last_heartbeat_sent_unix_ms {
                    Some(last_sent_unix_ms) => format!(
                        " after {}ms since last successful heartbeat",
                        heartbeat_started_unix_ms.saturating_sub(last_sent_unix_ms)
                    ),
                    None => " before first successful heartbeat".to_string(),
                };
                append_lan_peer_diagnostics_log(&format!(
                    "Heartbeat broadcast failed{}: {}",
                    failure_context, err
                ));
                std::thread::sleep(Duration::from_millis(LAN_SOCKET_RETRY_MS));
                continue;
            }
        }
        let heartbeat_finished_unix_ms = unix_ms();
        last_heartbeat_elapsed_ms =
            Some(heartbeat_finished_unix_ms.saturating_sub(heartbeat_started_unix_ms));
        last_heartbeat_sent_unix_ms = Some(heartbeat_finished_unix_ms);
        if sender_delay_active {
            append_lan_peer_diagnostics_log(&format!(
                "Heartbeat sender recovered after {}ms delay; node={} name={}",
                sender_delay_gap_ms.unwrap_or_default(),
                runtime.local_node.node_id,
                runtime.local_node.node_name
            ));
            sender_delay_active = false;
            sender_delay_gap_ms = None;
        }
        std::thread::sleep(Duration::from_millis(LAN_HEARTBEAT_INTERVAL_MS));
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
    gateway.store.events().emit(
        "gateway",
        crate::orchestrator::store::EventCode::LAN_PAIR_REQUEST_RECEIVED,
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
    gateway.store.events().emit(
        "gateway",
        crate::orchestrator::store::EventCode::LAN_PAIR_APPROVAL_READY,
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
        gateway.store.events().emit(
            "gateway",
            crate::orchestrator::store::EventCode::LAN_PAIR_PIN_REJECTED_MISSING_APPROVAL,
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
        gateway.store.events().emit(
            "gateway",
            crate::orchestrator::store::EventCode::LAN_PAIR_PIN_REJECTED_MISMATCH,
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
    gateway.store.events().emit(
        "gateway",
        crate::orchestrator::store::EventCode::LAN_PAIR_PIN_ACCEPTED,
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
        gateway.store.events().emit(
            "gateway",
            crate::orchestrator::store::EventCode::LAN_PAIR_TRUST_BUNDLE_IGNORED_MISSING_PIN,
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
        gateway.store.events().emit(
            "gateway",
            crate::orchestrator::store::EventCode::LAN_PAIR_TRUST_BUNDLE_DECRYPT_FAILED,
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
    gateway.store.events().emit(
        "gateway",
        crate::orchestrator::store::EventCode::LAN_PAIR_TRUST_BUNDLE_APPLIED,
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

fn peer_listen_host_and_port(peer: &LanPeerSnapshot) -> Option<(&str, u16)> {
    let (host, port) = peer.listen_addr.trim().rsplit_once(':')?;
    let host = host.trim();
    let port = port.trim().parse::<u16>().ok()?;
    (!host.is_empty()).then_some((host, port))
}

fn peer_updater_base_url(peer: &LanPeerSnapshot) -> Option<String> {
    let (host, listen_port) = peer_listen_host_and_port(peer)?;
    let updater_port = peer
        .remote_update_updater_port
        .or_else(|| remote_update_updater_port(listen_port))?;
    (!host.is_empty()).then(|| format!("http://{host}:{updater_port}"))
}

fn redact_url_for_logs(url: &reqwest::Url) -> String {
    let scheme = url.scheme();
    let host = url.host_str().unwrap_or("<unknown>");
    let port = url
        .port()
        .map(|value| format!(":{value}"))
        .unwrap_or_default();
    format!("{scheme}://{host}{port}{}", url.path())
}

fn lan_http_sync_failure_key(peer_node_id: &str, route: &str) -> String {
    format!("{peer_node_id}|{route}")
}

fn emit_http_sync_recovered_event(
    gateway: &crate::orchestrator::gateway::GatewayState,
    event_code: crate::orchestrator::store::EventCode,
    message: &str,
    recovered: &LanHttpSyncProbeSnapshot,
) {
    match event_code {
        crate::orchestrator::store::EventCode::LAN_USAGE_SYNC_HTTP_RECOVERED => {
            gateway.store.events().lan().usage_sync_http_recovered(
                "gateway",
                message,
                serde_json::json!({
                    "peer_node_id": recovered.peer_node_id,
                    "peer_listen_addr": recovered.peer_listen_addr,
                    "route": recovered.route,
                    "previous_outcome": recovered.outcome,
                    "previous_detail": recovered.detail,
                }),
            )
        }
        crate::orchestrator::store::EventCode::LAN_EDIT_SYNC_HTTP_RECOVERED => {
            gateway.store.events().lan().edit_sync_http_recovered(
                "gateway",
                message,
                serde_json::json!({
                    "peer_node_id": recovered.peer_node_id,
                    "peer_listen_addr": recovered.peer_listen_addr,
                    "route": recovered.route,
                    "previous_outcome": recovered.outcome,
                    "previous_detail": recovered.detail,
                }),
            )
        }
        crate::orchestrator::store::EventCode::LAN_PROVIDER_DEFINITIONS_SYNC_HTTP_RECOVERED => {
            gateway
                .store
                .events()
                .lan()
                .provider_definitions_sync_http_recovered(
                    "gateway",
                    message,
                    serde_json::json!({
                        "peer_node_id": recovered.peer_node_id,
                        "peer_listen_addr": recovered.peer_listen_addr,
                        "route": recovered.route,
                        "previous_outcome": recovered.outcome,
                        "previous_detail": recovered.detail,
                    }),
                )
        }
        _ => gateway.store.events().emit(
            "gateway",
            event_code,
            message,
            serde_json::json!({
                "peer_node_id": recovered.peer_node_id,
                "peer_listen_addr": recovered.peer_listen_addr,
                "route": recovered.route,
                "previous_outcome": recovered.outcome,
                "previous_detail": recovered.detail,
            }),
        ),
    }
}

fn sync_edit_events_from_peer(
    runtime: &LanSyncRuntime,
    gateway: &crate::orchestrator::gateway::GatewayState,
    config_path: &Path,
    peer: &LanPeerSnapshot,
    reported_sync_blocks: &mut HashMap<String, String>,
) -> Result<(), String> {
    if !ensure_peer_sync_contract(
        gateway,
        peer,
        SYNC_DOMAIN_USAGE_HISTORY,
        reported_sync_blocks,
    ) {
        return Ok(());
    }
    if !peer_supports_http_sync(peer, "edit_sync_v1") {
        return Ok(());
    }
    loop {
        let batch =
            tauri::async_runtime::block_on(fetch_edit_sync_batch_http(runtime, gateway, peer))?;
        let has_more = batch.has_more;
        if batch.events.is_empty() {
            break;
        }
        apply_edit_sync_batch(runtime, gateway, config_path, peer, batch);
        if !has_more {
            break;
        }
    }
    Ok(())
}

fn request_immediate_edit_sync_from_live_peers(
    gateway: &crate::orchestrator::gateway::GatewayState,
) {
    let runtime = gateway_status_runtime().read().as_ref().cloned();
    let Some(runtime) = runtime else {
        return;
    };
    let trusted_node_ids = gateway.secrets.trusted_lan_node_ids();
    let packet = LanSyncPacket::EditSyncHint(LanEditSyncHintPacket {
        version: 1,
        node_id: runtime.local_node.node_id.clone(),
        sent_at_unix_ms: unix_ms(),
    });
    for peer in runtime.collect_live_peers(unix_ms()) {
        if !trusted_node_ids.contains(&peer.node_id) {
            continue;
        }
        if sync_contract_mismatch_detail(&peer, SYNC_DOMAIN_USAGE_HISTORY).is_some() {
            continue;
        }
        let Some(addr) = peer_sync_addr(&peer) else {
            continue;
        };
        let _ = send_packet_to_addr(gateway, addr, &packet);
    }
}

fn format_lan_sync_reqwest_error(err: &reqwest::Error) -> String {
    let kind = if err.is_timeout() {
        "timeout"
    } else if err.is_connect() {
        "connect"
    } else {
        "request"
    };
    let mut parts = vec![format!("LAN sync request error ({kind})")];
    if let Some(url) = err.url() {
        parts.push(format!("url={}", redact_url_for_logs(url)));
    }
    let mut source: Option<&(dyn Error + 'static)> = err.source();
    let mut causes = Vec::new();
    while let Some(inner) = source {
        let rendered = inner.to_string();
        if !rendered.is_empty() && !causes.contains(&rendered) {
            causes.push(rendered);
        }
        if causes.len() >= 2 {
            break;
        }
        source = inner.source();
    }
    if !causes.is_empty() {
        parts.push(format!("cause={}", causes.join(" | ")));
    }
    parts.join("; ")
}

fn resolve_repo_root_for_self_update() -> Result<std::path::PathBuf, String> {
    #[cfg(test)]
    if let Some(path) = remote_update::test_repo_root_override() {
        if path.join("package.json").is_file() {
            return Ok(path);
        }
    }
    if let Ok(explicit) = std::env::var("API_ROUTER_REPO_ROOT") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            let path = std::path::PathBuf::from(trimmed);
            if path.join("package.json").is_file() {
                return Ok(path);
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let path = parent.to_path_buf();
            if path.join("package.json").is_file() {
                return Ok(path);
            }
        }
    }
    let manifest_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_root
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "failed to resolve repo root".to_string())?;
    if repo_root.join("package.json").is_file() {
        Ok(repo_root)
    } else {
        Err("repo root does not contain package.json".to_string())
    }
}

fn peer_supports_http_sync(peer: &LanPeerSnapshot, capability: &str) -> bool {
    peer.trusted && peer.capabilities.iter().any(|value| value == capability)
}

fn sync_contract_version(contracts: &BTreeMap<String, u32>, domain: &str) -> u32 {
    contracts.get(domain).copied().unwrap_or(0)
}

pub(crate) fn sync_contract_mismatch_detail(
    peer: &LanPeerSnapshot,
    domain: &str,
) -> Option<(u32, u32)> {
    if !peer.trusted {
        return None;
    }
    let local_version = sync_contract_version(&local_sync_contracts(), domain);
    let peer_version = sync_contract_version(&peer.sync_contracts, domain);
    if local_version == peer_version {
        return None;
    }
    Some((local_version, peer_version))
}

fn sync_contract_mismatch_reason(peer: &LanPeerSnapshot, domain: &str) -> Option<String> {
    let (local_version, peer_version) = sync_contract_mismatch_detail(peer, domain)?;
    Some(format!(
        "Rejected LAN {domain} sync from {} because sync contract version does not match (local=v{local_version}, peer=v{peer_version}). Update both devices to the same compatible build. Sync will resume automatically once versions match.",
        peer.node_name
    ))
}

fn sync_domain_diagnostics_for_peer(
    peer: &LanPeerSnapshot,
) -> Vec<LanSyncDomainDiagnosticSnapshot> {
    local_sync_contracts()
        .keys()
        .map(|domain| {
            let local_contract_version = sync_contract_version(&local_sync_contracts(), domain);
            let peer_contract_version = sync_contract_version(&peer.sync_contracts, domain);
            let blocked_reason = sync_contract_mismatch_reason(peer, domain);
            LanSyncDomainDiagnosticSnapshot {
                domain: domain.clone(),
                status: if blocked_reason.is_some() {
                    "blocked".to_string()
                } else {
                    "ok".to_string()
                },
                local_contract_version,
                peer_contract_version,
                blocked_reason,
            }
        })
        .collect()
}

pub(crate) fn sync_contract_block_reason_for_domain(
    peer: &LanPeerSnapshot,
    domain: &str,
) -> Option<String> {
    sync_contract_mismatch_reason(peer, domain)
}

pub(crate) fn peer_version_sync_reason(peer: &LanPeerSnapshot) -> Option<String> {
    if !peer.trusted {
        return None;
    }
    if !peer.sync_blocked_domains.is_empty() {
        let domains = peer.sync_blocked_domains.join(", ");
        return Some(format!(
            "Sync paused for {domains} on {} until both devices run compatible builds.",
            peer.node_name
        ));
    }
    if peer.build_matches_local {
        return None;
    }
    Some(format!(
        "{} is on a different build. Remote update can sync it to the current machine build if needed.",
        peer.node_name
    ))
}

fn sync_domains_blocked_for_peer(peer: &LanPeerSnapshot) -> Vec<String> {
    local_sync_contracts()
        .keys()
        .filter(|domain| sync_contract_mismatch_detail(peer, domain).is_some())
        .cloned()
        .collect()
}

fn peer_build_matches_local(peer: &LanPeerSnapshot) -> bool {
    peer.build_identity == current_build_identity()
}

fn ensure_peer_sync_contract(
    gateway: &crate::orchestrator::gateway::GatewayState,
    peer: &LanPeerSnapshot,
    domain: &str,
    reported: &mut HashMap<String, String>,
) -> bool {
    let key = format!("{}:{domain}", peer.node_id);
    let Some(reason) = sync_contract_mismatch_reason(peer, domain) else {
        if reported.remove(&key).is_some() {
            gateway.store.events().emit(
                "gateway",
                crate::orchestrator::store::EventCode::LAN_SYNC_CONTRACT_RECOVERED,
                &format!(
                    "LAN {domain} sync with {} is compatible again and has resumed",
                    peer.node_name
                ),
                serde_json::json!({
                    "peer_node_id": peer.node_id,
                    "peer_node_name": peer.node_name,
                    "domain": domain,
                    "local_sync_contracts": local_sync_contracts(),
                    "peer_sync_contracts": peer.sync_contracts,
                }),
            );
        }
        return true;
    };
    if reported.get(&key) != Some(&reason) {
        gateway.store.events().emit(
            "gateway",
            crate::orchestrator::store::EventCode::LAN_SYNC_CONTRACT_MISMATCH,
            &reason,
            serde_json::json!({
                "peer_node_id": peer.node_id,
                "peer_node_name": peer.node_name,
                "domain": domain,
                "local_sync_contracts": local_sync_contracts(),
                "peer_sync_contracts": peer.sync_contracts,
            }),
        );
        reported.insert(key, reason);
    }
    false
}

/// Checks if a peer's build matches the local build and emits build mismatch/recovery
/// events. Uses `runtime.build_mismatch_reported` to track state across heartbeat cycles,
/// ensuring events fire only on state transitions (mismatch → recovered, recovered →
/// mismatch).
///
/// Returns `true` if the peer's build matches the local build, `false` otherwise.
fn ensure_peer_build_compatible(
    runtime: &LanSyncRuntime,
    gateway: &crate::orchestrator::gateway::GatewayState,
    peer: &LanPeerSnapshot,
) -> bool {
    let local_build = current_build_identity();
    let matches = peer_build_matches_local(peer);

    let reported = &mut *runtime.build_mismatch_reported.write();
    let key = &peer.node_id;

    if matches {
        if let Some(_prev) = reported.remove(key) {
            // Build mismatch resolved — emit recovery event
            gateway.store.events().emit(
                "gateway",
                crate::orchestrator::store::EventCode::LAN_PEER_BUILD_RECOVERED,
                &format!("{} is now on the same build as this device", peer.node_name),
                serde_json::json!({
                    "peer_node_id": peer.node_id,
                    "peer_node_name": peer.node_name,
                    "peer_build": peer.build_identity,
                    "local_build": local_build,
                }),
            );
        }
        return true;
    }

    // Build mismatch detected
    if !reported.contains_key(key) {
        // First time reporting this mismatch — emit mismatch event
        reported.insert(key.to_string(), true);
        gateway.store.events().emit(
            "gateway",
            crate::orchestrator::store::EventCode::LAN_PEER_BUILD_MISMATCH,
            &format!(
                "{} is on a different build than this device. Usage sync may be limited.",
                peer.node_name
            ),
            serde_json::json!({
                "peer_node_id": peer.node_id,
                "peer_node_name": peer.node_name,
                "peer_build": peer.build_identity,
                "local_build": local_build,
            }),
        );
    }
    false
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

fn official_account_profiles_request_timeout() -> Duration {
    Duration::from_millis(LAN_OFFICIAL_ACCOUNTS_SYNC_HTTP_TIMEOUT_MS)
}

fn remote_update_debug_request_timeout() -> Duration {
    Duration::from_millis(LAN_REMOTE_UPDATE_DEBUG_HTTP_TIMEOUT_MS)
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
        .map_err(|err| {
            let detail = format_lan_sync_reqwest_error(&err);
            runtime.note_http_sync_probe(peer, "/lan-sync/usage", "request_error", &detail);
            format!("LAN usage sync request failed: {detail}")
        })?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let detail = format!("LAN usage sync http {status}: {body}");
        runtime.note_http_sync_probe(peer, "/lan-sync/usage", "http_error", &detail);
        return Err(detail);
    }
    let packet = response
        .json::<LanUsageSyncBatchPacket>()
        .await
        .map_err(|err| {
            let detail = format_lan_sync_reqwest_error(&err);
            runtime.note_http_sync_probe(peer, "/lan-sync/usage", "decode_error", &detail);
            format!("LAN usage sync response decode failed: {detail}")
        })?;
    if let Some(recovered) =
        runtime.note_http_sync_probe(peer, "/lan-sync/usage", "ok", "HTTP sync ok")
    {
        emit_http_sync_recovered_event(
            gateway,
            crate::orchestrator::store::EventCode::LAN_USAGE_SYNC_HTTP_RECOVERED,
            "LAN usage sync request recovered",
            &recovered,
        );
    }
    Ok(packet)
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
    let _ = inserted;
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
        .map_err(|err| {
            let detail = format_lan_sync_reqwest_error(&err);
            runtime.note_http_sync_probe(peer, "/lan-sync/edit", "request_error", &detail);
            format!("LAN edit sync request failed: {detail}")
        })?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let detail = format!("LAN edit sync http {status}: {body}");
        runtime.note_http_sync_probe(peer, "/lan-sync/edit", "http_error", &detail);
        return Err(detail);
    }
    let packet = response
        .json::<LanEditSyncBatchPacket>()
        .await
        .map_err(|err| {
            let detail = format_lan_sync_reqwest_error(&err);
            runtime.note_http_sync_probe(peer, "/lan-sync/edit", "decode_error", &detail);
            format!("LAN edit sync response decode failed: {detail}")
        })?;
    if let Some(recovered) =
        runtime.note_http_sync_probe(peer, "/lan-sync/edit", "ok", "HTTP sync ok")
    {
        emit_http_sync_recovered_event(
            gateway,
            crate::orchestrator::store::EventCode::LAN_EDIT_SYNC_HTTP_RECOVERED,
            "LAN edit sync request recovered",
            &recovered,
        );
    }
    Ok(packet)
}

async fn fetch_provider_definitions_http(
    runtime: &LanSyncRuntime,
    gateway: &crate::orchestrator::gateway::GatewayState,
    peer: &LanPeerSnapshot,
) -> Result<LanProviderDefinitionsSyncPacket, String> {
    let base_url = peer_http_base_url(peer)
        .ok_or_else(|| format!("peer has no valid HTTP listen address: {}", peer.node_id))?;
    let trust_secret = current_lan_trust_secret(gateway)?;
    let response = lan_sync_http_client()
        .post(format!("{base_url}/lan-sync/provider-definitions"))
        .header(
            LAN_SYNC_AUTH_NODE_ID_HEADER,
            runtime.local_node.node_id.clone(),
        )
        .header(LAN_SYNC_AUTH_SECRET_HEADER, trust_secret)
        .json(&LanProviderDefinitionsRequestPacket {
            version: 1,
            node_id: runtime.local_node.node_id.clone(),
        })
        .send()
        .await
        .map_err(|err| {
            let detail = format_lan_sync_reqwest_error(&err);
            runtime.note_http_sync_probe(
                peer,
                "/lan-sync/provider-definitions",
                "request_error",
                &detail,
            );
            format!("LAN provider definitions request failed: {detail}")
        })?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let detail = format!("LAN provider definitions http {status}: {body}");
        runtime.note_http_sync_probe(
            peer,
            "/lan-sync/provider-definitions",
            "http_error",
            &detail,
        );
        return Err(detail);
    }
    let packet = response
        .json::<LanProviderDefinitionsSyncPacket>()
        .await
        .map_err(|err| {
            let detail = format_lan_sync_reqwest_error(&err);
            runtime.note_http_sync_probe(
                peer,
                "/lan-sync/provider-definitions",
                "decode_error",
                &detail,
            );
            format!("LAN provider definitions response decode failed: {detail}")
        })?;
    if let Some(recovered) =
        runtime.note_http_sync_probe(peer, "/lan-sync/provider-definitions", "ok", "HTTP sync ok")
    {
        emit_http_sync_recovered_event(
            gateway,
            crate::orchestrator::store::EventCode::LAN_PROVIDER_DEFINITIONS_SYNC_HTTP_RECOVERED,
            "LAN provider definitions sync request recovered",
            &recovered,
        );
    }
    Ok(packet)
}

async fn fetch_official_account_profiles_http(
    runtime: &LanSyncRuntime,
    gateway: &crate::orchestrator::gateway::GatewayState,
    peer: &LanPeerSnapshot,
) -> Result<LanOfficialAccountProfilesSyncPacket, String> {
    let base_url = peer_http_base_url(peer)
        .ok_or_else(|| format!("peer has no valid HTTP listen address: {}", peer.node_id))?;
    let trust_secret = current_lan_trust_secret(gateway)?;
    let response = lan_sync_http_client()
        .post(format!("{base_url}/lan-sync/official-accounts"))
        .header(
            LAN_SYNC_AUTH_NODE_ID_HEADER,
            runtime.local_node.node_id.clone(),
        )
        .header(LAN_SYNC_AUTH_SECRET_HEADER, trust_secret)
        .json(&LanOfficialAccountProfilesRequestPacket {
            version: 1,
            node_id: runtime.local_node.node_id.clone(),
        })
        .timeout(official_account_profiles_request_timeout())
        .send()
        .await
        .map_err(|err| {
            let detail = format_lan_sync_reqwest_error(&err);
            runtime.note_http_sync_probe(
                peer,
                "/lan-sync/official-accounts",
                "request_error",
                &detail,
            );
            format!("LAN official accounts request failed: {detail}")
        })?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let detail = format!("LAN official accounts http {status}: {body}");
        runtime.note_http_sync_probe(peer, "/lan-sync/official-accounts", "http_error", &detail);
        return Err(detail);
    }
    let packet = response
        .json::<LanOfficialAccountProfilesSyncPacket>()
        .await
        .map_err(|err| {
            let detail = format_lan_sync_reqwest_error(&err);
            runtime.note_http_sync_probe(
                peer,
                "/lan-sync/official-accounts",
                "decode_error",
                &detail,
            );
            format!("LAN official accounts response decode failed: {detail}")
        })?;
    let _ = runtime.note_http_sync_probe(peer, "/lan-sync/official-accounts", "ok", "HTTP sync ok");
    Ok(packet)
}

pub(crate) fn fetch_official_account_profiles_from_peer(
    runtime: &LanSyncRuntime,
    gateway: &crate::orchestrator::gateway::GatewayState,
    peer: &LanPeerSnapshot,
) -> Result<LanOfficialAccountProfilesSyncPacket, String> {
    tauri::async_runtime::block_on(fetch_official_account_profiles_http(runtime, gateway, peer))
}

pub(crate) fn refresh_followed_provider_definitions_from_live_peer(
    runtime: &LanSyncRuntime,
    gateway: &crate::orchestrator::gateway::GatewayState,
    config_path: &Path,
    peer: &LanPeerSnapshot,
) -> Result<String, String> {
    let packet =
        tauri::async_runtime::block_on(fetch_provider_definitions_http(runtime, gateway, peer))?;
    replace_remote_provider_definition_snapshots(
        gateway,
        config_path,
        &peer.node_id,
        packet.node_name.as_str(),
        &packet.definitions,
    )?;
    Ok(packet.provider_definitions_revision)
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
    let requester_node_id = packet.node_id.trim().to_string();
    let requester_node_name = runtime
        .live_peer_by_node_id(&requester_node_id)
        .map(|peer| peer.node_name)
        .unwrap_or_else(|| requester_node_id.clone());
    let gateway = gateway.clone();
    let runtime = runtime.clone();
    tauri::async_runtime::spawn(async move {
        gateway.store.events().emit(
            &provider_name,
            crate::orchestrator::store::EventCode::LAN_QUOTA_REFRESH_FORWARDED_STARTED,
            &format!("Shared usage refresh received from {}", requester_node_name),
            serde_json::json!({
                "provider": provider_name,
                "requester_node_id": requester_node_id,
                "requester_node_name": requester_node_name,
            }),
        );
        match crate::orchestrator::quota::refresh_quota_shared(&gateway, &runtime, &provider_name)
            .await
        {
            Ok(group) => gateway.store.events().emit(
                &provider_name,
                crate::orchestrator::store::EventCode::LAN_QUOTA_REFRESH_FORWARDED_SUCCEEDED,
                &format!("Shared usage refresh completed for {}", requester_node_name),
                serde_json::json!({
                    "provider": provider_name,
                    "providers": group,
                    "requester_node_id": requester_node_id,
                    "requester_node_name": requester_node_name,
                }),
            ),
            Err(err) => gateway.store.events().emit(
                &provider_name,
                crate::orchestrator::store::EventCode::LAN_QUOTA_REFRESH_FORWARDED_FAILED,
                &format!(
                    "Shared usage refresh failed for {}: {err}",
                    requester_node_name
                ),
                serde_json::json!({
                    "provider": provider_name,
                    "requester_node_id": requester_node_id,
                    "requester_node_name": requester_node_name,
                }),
            ),
        }
    });
}

fn handle_edit_sync_hint(
    runtime: &LanSyncRuntime,
    gateway: &crate::orchestrator::gateway::GatewayState,
    config_path: &Path,
    source: SocketAddr,
    packet: LanEditSyncHintPacket,
) {
    let sender_node_id = packet.node_id.trim();
    if sender_node_id.is_empty() || sender_node_id == runtime.local_node.node_id {
        return;
    }
    if !gateway.secrets.is_lan_node_trusted(sender_node_id) {
        return;
    }

    let Some(peer) = runtime
        .live_peer_by_node_id(sender_node_id)
        .or_else(|| runtime.recent_peer_by_node_id(sender_node_id, LAN_PEER_HTTP_GRACE_AFTER_MS))
    else {
        gateway.store.events().emit(
            "gateway",
            crate::orchestrator::store::EventCode::LAN_EDIT_SYNC_HINT_IGNORED_UNKNOWN_PEER,
            "ignored LAN edit sync hint because the sender has no live or recent peer snapshot",
            serde_json::json!({
                "peer_node_id": sender_node_id,
                "source": source.to_string(),
                "hint_sent_at_unix_ms": packet.sent_at_unix_ms,
            }),
        );
        return;
    };

    let runtime = runtime.clone();
    let gateway = gateway.clone();
    let config_path = config_path.to_path_buf();
    tauri::async_runtime::spawn(async move {
        let mut reported_sync_blocks = HashMap::new();
        let _ = sync_edit_events_from_peer(
            &runtime,
            &gateway,
            &config_path,
            &peer,
            &mut reported_sync_blocks,
        );
    });
}

fn apply_edit_sync_batch(
    runtime: &LanSyncRuntime,
    gateway: &crate::orchestrator::gateway::GatewayState,
    config_path: &Path,
    peer: &LanPeerSnapshot,
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
        let Some(domain) = lan_edit_entity_sync_domain(&event.entity_type) else {
            gateway.store.events().emit(
                "gateway",
                crate::orchestrator::store::EventCode::LAN_EDIT_SYNC_ENTITY_DOMAIN_MISSING,
                &format!(
                    "Rejected LAN edit sync entity {} from {} because it is not mapped to a sync domain",
                    event.entity_type, peer.node_name
                ),
                serde_json::json!({
                    "peer_node_id": peer.node_id,
                    "peer_node_name": peer.node_name,
                    "entity_type": event.entity_type,
                    "event_id": event.event_id,
                }),
            );
            continue;
        };
        if sync_contract_mismatch_detail(peer, domain).is_some() {
            continue;
        }
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
        gateway.store.events().emit(
            "gateway",
            crate::orchestrator::store::EventCode::LAN_EDIT_SYNC_APPLIED,
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
    let mut reported_sync_blocks: HashMap<String, String> = HashMap::new();
    loop {
        let peers = runtime.collect_live_peers(unix_ms());
        let trusted_node_ids = gateway.secrets.trusted_lan_node_ids();
        for peer in peers {
            let mut peer = peer;
            peer.trusted = trusted_node_ids.contains(&peer.node_id);
            if !ensure_peer_sync_contract(
                &gateway,
                &peer,
                SYNC_DOMAIN_USAGE_REQUESTS,
                &mut reported_sync_blocks,
            ) {
                continue;
            }
            if !peer_supports_http_sync(&peer, "usage_sync_v1") {
                continue;
            }
            loop {
                let batch = match tauri::async_runtime::block_on(fetch_usage_sync_batch_http(
                    &runtime, &gateway, &peer,
                )) {
                    Ok(batch) => batch,
                    Err(err) => {
                        gateway.store.events().emit(
                            "gateway",
                            crate::orchestrator::store::EventCode::LAN_USAGE_SYNC_HTTP_FAILED,
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
    let mut last_live_peer_ids = std::collections::BTreeSet::new();
    let mut attempted_followed_revisions: HashMap<String, String> = HashMap::new();
    let mut applied_followed_revisions: HashMap<String, String> = HashMap::new();
    let mut reported_sync_blocks: HashMap<String, String> = HashMap::new();
    loop {
        let peers = runtime.collect_live_peers(unix_ms());
        let trusted_node_ids = gateway.secrets.trusted_lan_node_ids();
        let followed_source_node_id = gateway.secrets.get_followed_config_source_node_id();
        let current_live_peer_ids = peers
            .iter()
            .map(|peer| peer.node_id.clone())
            .collect::<std::collections::BTreeSet<_>>();
        for peer in peers {
            let mut peer = peer;
            peer.trusted = trusted_node_ids.contains(&peer.node_id);
            let became_live = !last_live_peer_ids.contains(&peer.node_id);
            if followed_source_node_id.as_deref() == Some(peer.node_id.as_str())
                && ensure_peer_sync_contract(
                    &gateway,
                    &peer,
                    SYNC_DOMAIN_PROVIDER_DEFINITIONS,
                    &mut reported_sync_blocks,
                )
                && peer_supports_http_sync(&peer, "provider_definitions_v1")
            {
                let revision = peer.provider_definitions_revision.trim().to_string();
                let already_applied = applied_followed_revisions
                    .get(&peer.node_id)
                    .is_some_and(|value| value == &revision);
                let already_attempted = attempted_followed_revisions
                    .get(&peer.node_id)
                    .is_some_and(|value| value == &revision);
                if !revision.is_empty() && (!already_applied && (became_live || !already_attempted))
                {
                    attempted_followed_revisions.insert(peer.node_id.clone(), revision.clone());
                    match refresh_followed_provider_definitions_from_live_peer(
                        &runtime,
                        &gateway,
                        &config_path,
                        &peer,
                    ) {
                        Ok(applied_revision) => {
                            applied_followed_revisions
                                .insert(peer.node_id.clone(), applied_revision);
                        }
                        Err(err) => {
                            gateway.store.events().emit(
                                "gateway",
                                crate::orchestrator::store::EventCode::LAN_PROVIDER_DEFINITIONS_SYNC_FAILED,
                                &err,
                                serde_json::json!({
                                    "peer_node_id": peer.node_id,
                                }),
                            );
                        }
                    }
                }
            }
            if !ensure_peer_sync_contract(
                &gateway,
                &peer,
                SYNC_DOMAIN_USAGE_HISTORY,
                &mut reported_sync_blocks,
            ) {
                continue;
            }
            if let Err(err) = sync_edit_events_from_peer(
                &runtime,
                &gateway,
                &config_path,
                &peer,
                &mut reported_sync_blocks,
            ) {
                gateway.store.events().emit(
                    "gateway",
                    crate::orchestrator::store::EventCode::LAN_EDIT_SYNC_HTTP_FAILED,
                    &err,
                    serde_json::json!({
                        "peer_node_id": peer.node_id,
                    }),
                );
            }
        }
        last_live_peer_ids = current_live_peer_ids;
        std::thread::sleep(Duration::from_millis(LAN_EDIT_SYNC_LOOP_INTERVAL_MS));
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

fn local_provider_definition_sync_items_from_config(
    cfg: &AppConfig,
    secrets: &SecretStore,
) -> Vec<LanProviderDefinitionSyncItem> {
    let mut normalized = cfg.clone();
    crate::app_state::normalize_provider_order(&mut normalized);
    let mut provider_names = normalized.provider_order.clone();
    for provider_name in normalized.providers.keys() {
        if !provider_names.iter().any(|entry| entry == provider_name) {
            provider_names.push(provider_name.clone());
        }
    }
    provider_names
        .into_iter()
        .filter_map(|provider_name| {
            let provider_cfg = normalized.providers.get(&provider_name)?;
            let usage_login = secrets.get_usage_login(&provider_name);
            let shared_provider_id = secrets.ensure_provider_shared_id(&provider_name).ok()?;
            Some(LanProviderDefinitionSyncItem {
                shared_provider_id,
                provider_name: provider_name.clone(),
                deleted: false,
                snapshot: serde_json::to_value(ProviderDefinitionSnapshotPayload {
                    name: provider_name.clone(),
                    order_index: normalized
                        .provider_order
                        .iter()
                        .position(|entry| entry == &provider_name)
                        .map(|index| index as u64),
                    display_name: provider_cfg.display_name.clone(),
                    base_url: provider_cfg.base_url.clone(),
                    group: provider_cfg.group.clone(),
                    disabled: provider_cfg.disabled,
                    supports_websockets: provider_cfg.supports_websockets,
                    usage_adapter: provider_cfg.usage_adapter.clone(),
                    usage_base_url: provider_cfg.usage_base_url.clone(),
                    key: secrets.get_provider_key(&provider_name),
                    key_storage: Some(secrets.get_provider_key_storage_mode(&provider_name)),
                    account_email: secrets.get_provider_account_email(&provider_name),
                    usage_token: secrets.get_usage_token(&provider_name),
                    usage_login_username: usage_login.as_ref().map(|value| value.username.clone()),
                    usage_login_password: usage_login.as_ref().map(|value| value.password.clone()),
                })
                .ok()?,
                lamport_ts: 0,
                revision_event_id: String::new(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        apply_followed_provider_state, apply_lan_edit_event, deserialize_wire_packet,
        incoming_event_is_newer, lan_sync_edit_http, lan_sync_provider_definitions_http,
        lan_sync_remote_update_http, lan_sync_tracked_spend_history_debug_http,
        lan_sync_usage_http, local_version_sync_target_ref, note_entity_version, peer_is_stale,
        peer_supports_http_sync, replace_remote_provider_definition_snapshots,
        restore_local_provider_state, sanitize_node_name, serialize_wire_packet,
        should_request_immediate_edit_sync, tracked_spend_day_entity_id, LanEditSyncHintPacket,
        LanEditSyncRequestPacket, LanHeartbeatPacket, LanLocalVersionSyncSnapshot, LanNodeIdentity,
        LanPeerSnapshot, LanProviderDefinitionSyncItem, LanProviderDefinitionsRequestPacket,
        LanRemoteUpdateDebugRequestPacket, LanRemoteUpdateDebugResponsePacket,
        LanRemoteUpdateReadinessSnapshot, LanRemoteUpdateRequestPacket,
        LanRemoteUpdateStatusSnapshot, LanSyncPacket, LanSyncRuntime,
        LanTrackedSpendHistoryDebugRequestPacket, LanTrackedSpendHistoryDebugResponsePacket,
        LanUsageSyncRequestPacket, LAN_PEER_STALE_AFTER_MS, LAN_SYNC_AUTH_NODE_ID_HEADER,
        LAN_SYNC_AUTH_SECRET_HEADER,
    };
    use crate::lan_sync::remote_update::LanRemoteUpdateTimelineEntry;
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

    struct RemoteUpdateEnvGuard {
        previous_user_data_dir: Option<std::path::PathBuf>,
        previous_repo_root: Option<std::path::PathBuf>,
    }

    impl Drop for RemoteUpdateEnvGuard {
        fn drop(&mut self) {
            super::remote_update::set_test_repo_root_override(self.previous_repo_root.as_deref());
            super::remote_update::set_test_user_data_dir_override(
                self.previous_user_data_dir.as_deref(),
            );
        }
    }

    fn set_remote_update_env_for_test(
        user_data_dir: Option<&std::path::Path>,
        repo_root: Option<&std::path::Path>,
    ) -> RemoteUpdateEnvGuard {
        let previous_user_data_dir =
            super::remote_update::set_test_user_data_dir_override(user_data_dir);
        let previous_repo_root = super::remote_update::set_test_repo_root_override(repo_root);
        RemoteUpdateEnvGuard {
            previous_user_data_dir,
            previous_repo_root,
        }
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

    fn test_peer_snapshot() -> LanPeerSnapshot {
        LanPeerSnapshot {
            node_id: "node-peer".to_string(),
            node_name: "Peer".to_string(),
            listen_addr: "192.168.1.10:4000".to_string(),
            remote_update_updater_port: Some(4001),
            last_heartbeat_unix_ms: 1,
            capabilities: super::lan_heartbeat_capabilities(),
            version_inventory: super::local_version_inventory(),
            build_identity: super::current_build_identity(),
            remote_update_readiness: None,
            remote_update_status: None,
            provider_fingerprints: Vec::new(),
            provider_definitions_revision: String::new(),
            sync_contracts: super::local_sync_contracts(),
            followed_source_node_id: None,
            trusted: true,
            pair_state: None,
            pair_request_id: None,
            sync_blocked_domains: Vec::new(),
            sync_diagnostics: Vec::new(),
            build_matches_local: true,
            heartbeat_age_ms: 0,
            http_probe_state: None,
            http_probe_detail: None,
        }
    }

    #[test]
    fn local_version_sync_target_ref_allows_dirty_build_when_sha_exists() {
        let snapshot = LanLocalVersionSyncSnapshot {
            target_ref: Some("abc123".to_string()),
            git_worktree_clean: false,
            update_to_local_build_allowed: true,
            blocked_reason: Some("local worktree is dirty".to_string()),
        };

        assert_eq!(
            local_version_sync_target_ref(&snapshot).expect("target ref should stay usable"),
            "abc123"
        );
    }

    #[test]
    fn local_version_sync_target_ref_for_repo_prefers_current_branch() {
        let tmp = tempfile::tempdir().expect("tmp");
        let repo = tmp.path();
        crate::platform::git_exec::new_git_command()
            .args(["init", "-b", "feature/test"])
            .current_dir(repo)
            .output()
            .expect("git init");
        std::fs::write(repo.join("README.md"), "test\n").expect("write readme");
        crate::platform::git_exec::new_git_command()
            .args(["add", "README.md"])
            .current_dir(repo)
            .output()
            .expect("git add");
        crate::platform::git_exec::new_git_command()
            .args([
                "-c",
                "user.name=API Router Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "test",
            ])
            .current_dir(repo)
            .output()
            .expect("git commit");
        let sha = super::git_output_trimmed(repo, &["rev-parse", "HEAD"]).expect("head sha");

        assert_eq!(
            super::local_version_sync_target_ref_for_repo(repo, &sha),
            "feature/test"
        );
        assert_eq!(
            super::local_version_sync_target_ref_for_repo(repo, "deadbeef"),
            "deadbeef"
        );
    }

    #[test]
    fn peer_remote_update_blocked_reason_reports_peer_dirty_state() {
        let mut peer = test_peer_snapshot();
        peer.remote_update_readiness = Some(LanRemoteUpdateReadinessSnapshot {
            ready: false,
            blocked_reason: Some("peer worktree is dirty".to_string()),
            checked_at_unix_ms: 1,
        });

        assert_eq!(
            super::peer_remote_update_blocked_reason(&peer).as_deref(),
            Some("peer worktree is dirty")
        );
    }

    #[test]
    fn peer_remote_update_readiness_implies_support_when_capability_list_is_stale() {
        let mut peer = test_peer_snapshot();
        peer.capabilities.clear();
        peer.remote_update_readiness = Some(LanRemoteUpdateReadinessSnapshot {
            ready: true,
            blocked_reason: None,
            checked_at_unix_ms: 1,
        });

        assert_eq!(super::peer_remote_update_blocked_reason(&peer), None);
    }

    #[test]
    fn protected_edit_sync_hint_roundtrips_over_wire_format() {
        let (_tmp, state) = build_test_state();
        let packet = LanSyncPacket::EditSyncHint(LanEditSyncHintPacket {
            version: 1,
            node_id: "node-remote".to_string(),
            sent_at_unix_ms: 1234,
        });

        let bytes = serialize_wire_packet(&state.gateway, &packet).expect("serialize wire packet");
        let decoded = deserialize_wire_packet(&state.gateway, &bytes).expect("decode wire packet");
        match decoded {
            LanSyncPacket::EditSyncHint(inner) => {
                assert_eq!(inner.node_id, "node-remote");
                assert_eq!(inner.sent_at_unix_ms, 1234);
            }
            other => panic!("unexpected packet: {other:?}"),
        }
    }

    #[test]
    fn immediate_edit_sync_hints_only_usage_history_events() {
        assert!(should_request_immediate_edit_sync(
            super::LAN_EDIT_ENTITY_PROVIDER_PRICING
        ));
        assert!(should_request_immediate_edit_sync(
            super::LAN_EDIT_ENTITY_QUOTA_SNAPSHOT
        ));
        assert!(should_request_immediate_edit_sync(
            super::LAN_EDIT_ENTITY_TRACKED_SPEND_DAY
        ));
        assert!(should_request_immediate_edit_sync(
            super::LAN_EDIT_ENTITY_TRACKED_SPEND_DAY_HISTORY_DELETE
        ));
        assert!(!should_request_immediate_edit_sync(
            super::LAN_EDIT_ENTITY_PROVIDER_DEFINITION
        ));
    }

    #[test]
    fn compute_local_remote_update_readiness_ignores_stale_remote_update_after_build_changes() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let user_data_dir = tmp.path().join("user-data");
        let repo_root = tmp.path().join("repo");
        std::fs::create_dir_all(&repo_root).expect("create repo root");
        std::fs::write(
            repo_root.join("package.json"),
            "{\n  \"name\": \"api-router-test\"\n}\n",
        )
        .expect("write package.json");
        crate::platform::git_exec::new_git_command()
            .args(["init"])
            .current_dir(&repo_root)
            .output()
            .expect("git init");
        std::fs::write(repo_root.join("dirty.txt"), "dirty\n").expect("write dirty file");
        let _guard = set_remote_update_env_for_test(Some(&user_data_dir), Some(&repo_root));
        super::write_lan_remote_update_status(&LanRemoteUpdateStatusSnapshot {
            state: "running".to_string(),
            target_ref: "abc123".to_string(),
            from_git_sha: None,
            to_git_sha: None,
            current_git_sha: None,
            previous_git_sha: None,
            progress_percent: None,
            rollback_available: false,
            request_id: None,
            reason_code: None,
            requester_node_id: Some("node-remote".to_string()),
            requester_node_name: Some("Desk Remote".to_string()),
            worker_script: Some(
                "src-tauri/src/lan_sync/remote_update/lan-remote-update.ps1".to_string(),
            ),
            worker_pid: None,
            worker_exit_code: None,
            detail: Some("Remote self-update worker started".to_string()),
            accepted_at_unix_ms: 1,
            started_at_unix_ms: Some(2),
            finished_at_unix_ms: None,
            updated_at_unix_ms: 2,
            timeline: Vec::new(),
        })
        .expect("write remote update status");

        let readiness = super::compute_local_remote_update_readiness();
        assert!(!readiness.ready);
        assert!(!readiness
            .blocked_reason
            .as_deref()
            .unwrap_or_default()
            .contains("already processing a remote update to abc123"));
        assert!(readiness
            .blocked_reason
            .as_deref()
            .unwrap_or_default()
            .contains("git worktree is dirty"));

        let normalized = super::load_lan_remote_update_status().expect("normalized status");
        assert_eq!(normalized.state, "superseded");
    }

    #[test]
    fn lan_sync_remote_update_http_respects_whether_previous_status_still_blocks() {
        let (_tmp, state) = build_test_state();
        let trust_secret = state
            .secrets
            .ensure_lan_trust_secret()
            .expect("trust secret");
        state
            .secrets
            .set_lan_node_trusted("node-remote", true)
            .expect("trust peer");
        let user_data_dir = state
            .config_path
            .parent()
            .expect("config parent")
            .to_path_buf();
        let _guard = set_remote_update_env_for_test(Some(&user_data_dir), None);
        super::write_lan_remote_update_status(&LanRemoteUpdateStatusSnapshot {
            state: "accepted".to_string(),
            target_ref: "abc123".to_string(),
            from_git_sha: None,
            to_git_sha: None,
            current_git_sha: None,
            previous_git_sha: None,
            progress_percent: None,
            rollback_available: false,
            request_id: None,
            reason_code: None,
            requester_node_id: Some("node-prev".to_string()),
            requester_node_name: Some("Desk Prev".to_string()),
            worker_script: None,
            worker_pid: None,
            worker_exit_code: None,
            detail: Some("Queued remote self-update worker".to_string()),
            accepted_at_unix_ms: 1,
            started_at_unix_ms: None,
            finished_at_unix_ms: None,
            updated_at_unix_ms: 1,
            timeline: Vec::new(),
        })
        .expect("write accepted status");
        let response = tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(async {
                lan_sync_remote_update_http(
                    State(state.gateway.clone()),
                    lan_sync_headers("node-remote", &trust_secret),
                    Json(LanRemoteUpdateRequestPacket {
                        version: 1,
                        node_id: "node-remote".to_string(),
                        node_name: Some("Desk Remote".to_string()),
                        target_ref: "def456".to_string(),
                    }),
                )
                .await
                .into_response()
            });

        assert!(matches!(
            response.status(),
            StatusCode::ACCEPTED | StatusCode::CONFLICT
        ));
    }

    #[test]
    fn snapshot_exposes_local_remote_update_status() {
        let runtime = LanSyncRuntime::new(LanNodeIdentity {
            node_id: "node-self".to_string(),
            node_name: "self".to_string(),
        });
        let cfg = crate::orchestrator::config::AppConfig::default_config();
        let tmp = tempfile::tempdir().expect("tempdir");
        let user_data_dir = tmp.path().join("user-data");
        std::fs::create_dir_all(&user_data_dir).expect("create user-data dir");
        let secrets =
            crate::orchestrator::secrets::SecretStore::new(user_data_dir.join("secrets.json"));
        let _guard = set_remote_update_env_for_test(Some(&user_data_dir), None);
        let target_ref = super::remote_update::normalized_local_build_target_ref()
            .unwrap_or_else(|| "abc123".to_string());
        let status = LanRemoteUpdateStatusSnapshot {
            state: "succeeded".to_string(),
            target_ref: target_ref.clone(),
            from_git_sha: Some("from123".to_string()),
            to_git_sha: Some(target_ref.clone()),
            current_git_sha: Some(target_ref),
            previous_git_sha: Some("from123".to_string()),
            progress_percent: Some(100),
            rollback_available: true,
            request_id: None,
            reason_code: None,
            requester_node_id: Some("node-remote".to_string()),
            requester_node_name: Some("Desk Remote".to_string()),
            worker_script: Some(
                "src-tauri/src/lan_sync/remote_update/lan-remote-update.ps1".to_string(),
            ),
            worker_pid: None,
            worker_exit_code: None,
            detail: Some("Remote self-update completed successfully.".to_string()),
            accepted_at_unix_ms: 1,
            started_at_unix_ms: Some(2),
            finished_at_unix_ms: Some(3),
            updated_at_unix_ms: 3,
            timeline: Vec::new(),
        };
        super::write_lan_remote_update_status(&status).expect("write remote update status");

        let snapshot = runtime.snapshot(4_000, &cfg, &secrets);
        assert_eq!(snapshot.local_node.remote_update_status, Some(status));
    }

    #[test]
    fn remote_update_debug_http_returns_status_and_log_tail() {
        let (_tmp, state) = build_test_state();
        let trust_secret = state
            .secrets
            .ensure_lan_trust_secret()
            .expect("trust secret");
        state
            .secrets
            .set_lan_node_trusted("node-remote", true)
            .expect("trust peer");
        let user_data_dir = state
            .config_path
            .parent()
            .expect("config parent")
            .to_path_buf();
        let _guard = set_remote_update_env_for_test(Some(&user_data_dir), None);
        let status = LanRemoteUpdateStatusSnapshot {
            state: "running".to_string(),
            target_ref: "abc123".to_string(),
            from_git_sha: Some("from123".to_string()),
            to_git_sha: Some("abc123".to_string()),
            current_git_sha: Some("from123".to_string()),
            previous_git_sha: None,
            progress_percent: Some(20),
            rollback_available: false,
            request_id: None,
            reason_code: None,
            requester_node_id: Some("node-remote".to_string()),
            requester_node_name: Some("Desk Remote".to_string()),
            worker_script: Some(
                "src-tauri/src/lan_sync/remote_update/lan-remote-update.ps1".to_string(),
            ),
            worker_pid: None,
            worker_exit_code: None,
            detail: Some("Fetching from origin".to_string()),
            accepted_at_unix_ms: 1,
            started_at_unix_ms: Some(2),
            finished_at_unix_ms: None,
            updated_at_unix_ms: 3,
            timeline: Vec::new(),
        };
        super::write_lan_remote_update_status(&status).expect("write remote update status");
        let log_path = super::lan_remote_update_log_path().expect("log path");
        std::fs::create_dir_all(log_path.parent().expect("log dir")).expect("create log dir");
        std::fs::write(&log_path, "step 1\nstep 2\nfatal: git fetch failed\n").expect("write log");

        let response = tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(async {
                super::lan_sync_remote_update_debug_http(
                    State(state.gateway.clone()),
                    lan_sync_headers("node-remote", &trust_secret),
                    Json(LanRemoteUpdateDebugRequestPacket {
                        version: 1,
                        node_id: "node-remote".to_string(),
                    }),
                )
                .await
                .into_response()
            });
        assert_eq!(response.status(), StatusCode::OK);
        let body = tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(async {
                to_bytes(response.into_body(), usize::MAX)
                    .await
                    .expect("body")
            });
        let payload: LanRemoteUpdateDebugResponsePacket =
            serde_json::from_slice(&body).expect("remote update debug json");
        assert!(payload.ok);
        let normalized = payload
            .remote_update_status
            .as_ref()
            .expect("normalized remote update status");
        assert_eq!(normalized.state, "superseded");
        assert_eq!(normalized.target_ref, status.target_ref);
        assert_eq!(
            normalized.reason_code.as_deref(),
            Some("peer_build_changed_after_start")
        );
        assert!(normalized
            .detail
            .as_deref()
            .unwrap_or_default()
            .contains("stopped after the peer build changed"));
        assert!(payload.status_file_exists);
        assert!(payload.log_file_exists);
        assert_eq!(payload.log_tail_source, "file");
        assert!(payload
            .log_tail
            .as_deref()
            .unwrap_or_default()
            .contains("fatal: git fetch failed"));
    }

    #[test]
    fn remote_update_debug_http_falls_back_to_status_timeline_when_log_file_is_missing() {
        let (_tmp, state) = build_test_state();
        let trust_secret = state
            .secrets
            .ensure_lan_trust_secret()
            .expect("trust secret");
        state
            .secrets
            .set_lan_node_trusted("node-remote", true)
            .expect("trust peer");
        let user_data_dir = state
            .config_path
            .parent()
            .expect("config parent")
            .to_path_buf();
        let _guard = set_remote_update_env_for_test(Some(&user_data_dir), None);
        let status = LanRemoteUpdateStatusSnapshot {
            state: "failed".to_string(),
            target_ref: "abc123".to_string(),
            from_git_sha: Some("from123".to_string()),
            to_git_sha: Some("abc123".to_string()),
            current_git_sha: Some("from123".to_string()),
            previous_git_sha: Some("from123".to_string()),
            progress_percent: Some(80),
            rollback_available: true,
            request_id: None,
            reason_code: Some("build_checked_exe".to_string()),
            requester_node_id: Some("node-remote".to_string()),
            requester_node_name: Some("Desk Remote".to_string()),
            worker_script: Some(
                "src-tauri/src/lan_sync/remote_update/lan-remote-update.ps1".to_string(),
            ),
            worker_pid: Some(42),
            worker_exit_code: None,
            detail: Some("Building checked EXE: npm run build:root-exe:checked failed".to_string()),
            accepted_at_unix_ms: 1,
            started_at_unix_ms: Some(2),
            finished_at_unix_ms: Some(4),
            updated_at_unix_ms: 4,
            timeline: vec![
                LanRemoteUpdateTimelineEntry {
                    unix_ms: 2,
                    phase: "git_fetch".to_string(),
                    label: "Fetching from origin".to_string(),
                    detail: Some("Fetching from origin".to_string()),
                    source: "worker".to_string(),
                    state: "running".to_string(),
                },
                LanRemoteUpdateTimelineEntry {
                    unix_ms: 3,
                    phase: "build_checked_exe".to_string(),
                    label: "Building checked EXE".to_string(),
                    detail: Some(
                        "Building checked EXE: npm run build:root-exe:checked failed".to_string(),
                    ),
                    source: "worker".to_string(),
                    state: "failed".to_string(),
                },
            ],
        };
        super::write_lan_remote_update_status(&status).expect("write remote update status");

        let response = tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(async {
                super::lan_sync_remote_update_debug_http(
                    State(state.gateway.clone()),
                    lan_sync_headers("node-remote", &trust_secret),
                    Json(LanRemoteUpdateDebugRequestPacket {
                        version: 1,
                        node_id: "node-remote".to_string(),
                    }),
                )
                .await
                .into_response()
            });
        assert_eq!(response.status(), StatusCode::OK);
        let body = tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(async {
                to_bytes(response.into_body(), usize::MAX)
                    .await
                    .expect("body")
            });
        let payload: LanRemoteUpdateDebugResponsePacket =
            serde_json::from_slice(&body).expect("remote update debug json");
        assert!(payload.ok);
        assert!(!payload.log_file_exists);
        assert_eq!(payload.log_tail_source, "timeline");
        let log_tail = payload.log_tail.as_deref().unwrap_or_default();
        assert!(log_tail.contains("UTC"));
        assert!(log_tail.contains("Building checked EXE"));
        assert!(log_tail.contains("npm run build:root-exe:checked failed"));
        assert!(!log_tail.contains("[3]"));
    }

    #[test]
    fn load_remote_update_status_marks_matching_pending_target_as_succeeded() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let user_data_dir = tmp.path().join("user-data");
        std::fs::create_dir_all(&user_data_dir).expect("create user-data dir");
        let _guard = set_remote_update_env_for_test(Some(&user_data_dir), None);
        let target_ref = super::normalized_local_build_target_ref().expect("local target ref");
        super::write_lan_remote_update_status(&LanRemoteUpdateStatusSnapshot {
            state: "accepted".to_string(),
            target_ref: target_ref.clone(),
            from_git_sha: None,
            to_git_sha: Some(target_ref.clone()),
            current_git_sha: None,
            previous_git_sha: None,
            progress_percent: None,
            rollback_available: false,
            request_id: None,
            reason_code: None,
            requester_node_id: Some("node-remote".to_string()),
            requester_node_name: Some("Desk Remote".to_string()),
            worker_script: None,
            worker_pid: None,
            worker_exit_code: None,
            detail: Some("Queued remote self-update worker".to_string()),
            accepted_at_unix_ms: 1,
            started_at_unix_ms: None,
            finished_at_unix_ms: None,
            updated_at_unix_ms: 1,
            timeline: Vec::new(),
        })
        .expect("write accepted status");

        let loaded = super::load_lan_remote_update_status().expect("load status");
        assert_eq!(loaded.state, "succeeded");
        assert_eq!(
            loaded.reason_code.as_deref(),
            Some("peer_already_matches_target")
        );
        assert_eq!(loaded.target_ref, target_ref);
        assert!(loaded
            .detail
            .as_deref()
            .unwrap_or_default()
            .contains("cleared stale remote update status"));
        assert!(loaded.finished_at_unix_ms.is_some());
    }

    #[test]
    fn load_remote_update_status_marks_mismatched_pending_target_as_superseded() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let user_data_dir = tmp.path().join("user-data");
        std::fs::create_dir_all(&user_data_dir).expect("create user-data dir");
        let _guard = set_remote_update_env_for_test(Some(&user_data_dir), None);
        let current_target_ref =
            super::normalized_local_build_target_ref().expect("local target ref");
        super::write_lan_remote_update_status(&LanRemoteUpdateStatusSnapshot {
            state: "accepted".to_string(),
            target_ref: "9910964e24802d327b1500a69f2d4471fb7ac647".to_string(),
            from_git_sha: None,
            to_git_sha: Some("9910964e24802d327b1500a69f2d4471fb7ac647".to_string()),
            current_git_sha: None,
            previous_git_sha: None,
            progress_percent: None,
            rollback_available: false,
            request_id: None,
            reason_code: None,
            requester_node_id: Some("node-remote".to_string()),
            requester_node_name: Some("Desk Remote".to_string()),
            worker_script: None,
            worker_pid: None,
            worker_exit_code: None,
            detail: Some("Queued remote self-update worker".to_string()),
            accepted_at_unix_ms: 1,
            started_at_unix_ms: None,
            finished_at_unix_ms: None,
            updated_at_unix_ms: 1,
            timeline: Vec::new(),
        })
        .expect("write accepted status");

        let loaded = super::load_lan_remote_update_status().expect("load status");
        assert_eq!(loaded.state, "superseded");
        assert_eq!(
            loaded.reason_code.as_deref(),
            Some("peer_build_changed_before_start")
        );
        assert_eq!(
            loaded.target_ref,
            "9910964e24802d327b1500a69f2d4471fb7ac647"
        );
        let detail = loaded.detail.as_deref().unwrap_or_default();
        assert!(detail.contains("never started before the peer build changed"));
        assert!(!detail.contains("currently on build"));
        assert!(!detail.contains(&current_target_ref[..8]));
        assert!(loaded.finished_at_unix_ms.is_some());
    }

    #[test]
    fn load_remote_update_status_keeps_fresh_accepted_request_before_worker_starts() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let user_data_dir = tmp.path().join("user-data");
        std::fs::create_dir_all(&user_data_dir).expect("create user-data dir");
        let _guard = set_remote_update_env_for_test(Some(&user_data_dir), None);
        let fresh_unix_ms = crate::orchestrator::store::unix_ms();
        super::write_lan_remote_update_status(&LanRemoteUpdateStatusSnapshot {
            state: "accepted".to_string(),
            target_ref: "9910964e24802d327b1500a69f2d4471fb7ac647".to_string(),
            from_git_sha: None,
            to_git_sha: Some("9910964e24802d327b1500a69f2d4471fb7ac647".to_string()),
            current_git_sha: None,
            previous_git_sha: None,
            progress_percent: None,
            rollback_available: false,
            request_id: None,
            reason_code: None,
            requester_node_id: Some("node-remote".to_string()),
            requester_node_name: Some("Desk Remote".to_string()),
            worker_script: Some(
                "src-tauri/src/lan_sync/remote_update/lan-remote-update.ps1".to_string(),
            ),
            worker_pid: None,
            worker_exit_code: None,
            detail: Some("Queued remote self-update worker".to_string()),
            accepted_at_unix_ms: fresh_unix_ms,
            started_at_unix_ms: None,
            finished_at_unix_ms: None,
            updated_at_unix_ms: fresh_unix_ms,
            timeline: Vec::new(),
        })
        .expect("write accepted status");

        let loaded = super::load_lan_remote_update_status().expect("load status");
        assert_eq!(loaded.state, "accepted");
        assert_eq!(
            loaded.target_ref,
            "9910964e24802d327b1500a69f2d4471fb7ac647"
        );
        assert!(loaded.finished_at_unix_ms.is_none());
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
                    transport: "http".to_string(),
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

    #[tokio::test]
    async fn lan_sync_provider_definitions_http_returns_canonical_local_snapshots() {
        let (_tmp, state) = build_test_state();
        let trust_secret = state
            .secrets
            .ensure_lan_trust_secret()
            .expect("trust secret");
        state
            .secrets
            .set_lan_node_trusted("node-remote", true)
            .expect("trust peer");
        {
            let mut cfg = state.gateway.cfg.write();
            cfg.provider_order = vec![
                "provider_2".to_string(),
                "official".to_string(),
                "provider_1".to_string(),
            ];
            crate::app_state::normalize_provider_order(&mut cfg);
        }
        for provider_name in ["provider_2", "official", "provider_1"] {
            super::record_provider_definition_patch(
                &state,
                provider_name,
                serde_json::json!({
                    "order_index": state
                        .gateway
                        .cfg
                        .read()
                        .provider_order
                        .iter()
                        .position(|entry| entry == provider_name)
                        .map(|index| index as u64),
                }),
            )
            .expect("record local provider definition patch");
        }

        let response = lan_sync_provider_definitions_http(
            State(state.gateway.clone()),
            lan_sync_headers("node-remote", &trust_secret),
            Json(LanProviderDefinitionsRequestPacket {
                version: 1,
                node_id: "node-remote".to_string(),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("provider definitions body");
        let json: Value = serde_json::from_slice(&body).expect("provider definitions json");
        let definitions = json
            .get("definitions")
            .and_then(|value| value.as_array())
            .expect("definitions array");
        let ordered_names = definitions
            .iter()
            .filter(|entry| {
                !entry
                    .get("deleted")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false)
            })
            .map(|entry| {
                entry
                    .get("snapshot")
                    .and_then(|value| value.get("name"))
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            ordered_names,
            vec![
                "provider_2".to_string(),
                "official".to_string(),
                "provider_1".to_string()
            ]
        );
        assert!(json
            .get("provider_definitions_revision")
            .and_then(|value| value.as_str())
            .is_some_and(|value| !value.trim().is_empty()));
    }

    #[tokio::test]
    async fn lan_sync_provider_definitions_http_uses_live_config_even_without_seeded_snapshots() {
        let (_tmp, state) = build_test_state();
        let trust_secret = state
            .secrets
            .ensure_lan_trust_secret()
            .expect("trust secret");
        state
            .secrets
            .set_lan_node_trusted("node-remote", true)
            .expect("trust peer");
        {
            let mut cfg = state.gateway.cfg.write();
            cfg.provider_order = vec![
                "provider_2".to_string(),
                "official".to_string(),
                "provider_1".to_string(),
            ];
            crate::app_state::normalize_provider_order(&mut cfg);
        }
        let local_node_id = state
            .secrets
            .get_lan_node_identity()
            .map(|node| node.node_id)
            .expect("local node id");
        for row in state
            .gateway
            .store
            .list_all_lan_provider_definition_snapshots(&local_node_id)
        {
            state
                .gateway
                .store
                .remove_lan_provider_definition_snapshot(&local_node_id, &row.shared_provider_id)
                .expect("remove seeded snapshot");
        }

        let response = lan_sync_provider_definitions_http(
            State(state.gateway.clone()),
            lan_sync_headers("node-remote", &trust_secret),
            Json(LanProviderDefinitionsRequestPacket {
                version: 1,
                node_id: "node-remote".to_string(),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("provider definitions body");
        let json: Value = serde_json::from_slice(&body).expect("provider definitions json");
        let definitions = json
            .get("definitions")
            .and_then(|value| value.as_array())
            .expect("definitions array");
        let ordered_names = definitions
            .iter()
            .map(|entry| {
                entry
                    .get("snapshot")
                    .and_then(|value| value.get("name"))
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            ordered_names,
            vec![
                "provider_2".to_string(),
                "official".to_string(),
                "provider_1".to_string()
            ]
        );
        let status_revision = state
            .lan_sync
            .snapshot(
                state.gateway.cfg.read().listen.port,
                &state.gateway.cfg.read(),
                &state.secrets,
            )
            .local_node
            .provider_definitions_revision;
        assert_eq!(
            json.get("provider_definitions_revision")
                .and_then(|value| value.as_str()),
            Some(status_revision.as_str())
        );
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
                    supports_websockets: false,
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
            &LanSyncPacket::SharedHealth(Box::new(super::LanSharedHealthPacket {
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
                last_error_event: None,
            })),
        )
        .expect("serialize protected");

        let packet_a = deserialize_wire_packet(&state_a.gateway, &protected);
        let packet_b = deserialize_wire_packet(&state_b.gateway, &protected);

        assert!(matches!(packet_a, Some(LanSyncPacket::SharedHealth(_))));
        assert!(packet_b.is_none());
    }

    #[test]
    fn apply_shared_health_packet_records_remote_error_event_for_matching_provider() {
        let (_tmp, state) = build_test_state();
        let local_node = super::LanNodeIdentity {
            node_id: "node-local".to_string(),
            node_name: "Local".to_string(),
        };
        let runtime = super::LanSyncRuntime::new(local_node);
        let provider_name = "p1".to_string();
        let cfg = crate::orchestrator::config::AppConfig {
            listen: crate::orchestrator::config::ListenConfig {
                host: "127.0.0.1".to_string(),
                port: 4000,
            },
            routing: crate::orchestrator::config::RoutingConfig {
                preferred_provider: provider_name.clone(),
                session_preferred_providers: std::collections::BTreeMap::new(),
                route_mode: crate::orchestrator::config::RouteMode::FollowPreferredAuto,
                auto_return_to_preferred: true,
                preferred_stable_seconds: 30,
                failure_threshold: 1,
                cooldown_seconds: 60,
                request_timeout_seconds: 5,
            },
            providers: std::collections::BTreeMap::from([(
                provider_name.clone(),
                crate::orchestrator::config::ProviderConfig {
                    display_name: "Provider 1".to_string(),
                    base_url: "https://example.com/v1".to_string(),
                    usage_adapter: String::new(),
                    usage_base_url: Some("https://example.com".to_string()),
                    group: None,
                    disabled: false,
                    supports_websockets: false,
                    api_key: String::new(),
                },
            )]),
            provider_order: vec![provider_name.clone()],
        };
        *state.gateway.cfg.write() = cfg.clone();
        state
            .gateway
            .router
            .sync_with_config(&cfg, 1_717_171_700_000);
        state
            .secrets
            .set_provider_key(&provider_name, "sk-demo-shared")
            .expect("set shared provider key");
        state
            .secrets
            .ensure_provider_shared_id(&provider_name)
            .expect("ensure shared provider id");
        let fingerprint = crate::orchestrator::quota::shared_provider_fingerprint(
            &cfg,
            &state.secrets,
            &provider_name,
        )
        .expect("shared fingerprint");

        let packet = super::LanSharedHealthPacket {
            version: 1,
            node_id: "node-remote".to_string(),
            node_name: "Peer Desk".to_string(),
            sent_at_unix_ms: 1_717_171_710_000,
            shared_provider_fingerprint: fingerprint,
            status: "unhealthy".to_string(),
            consecutive_failures: 2,
            cooldown_until_unix_ms: 0,
            last_error: "http 503 from peer".to_string(),
            last_ok_at_unix_ms: 1_717_171_700_000,
            last_fail_at_unix_ms: 1_717_171_709_000,
            shared_probe_required: false,
            last_error_event: Some(super::shared_health::LanSharedErrorEventPacket {
                event_id: "evt-remote-http-503".to_string(),
                unix_ms: 1_717_171_709_000,
                level: "error".to_string(),
                code: "gateway.request_failed".to_string(),
                message: "http 503 from peer".to_string(),
                fields: serde_json::json!({
                    "origin": "shared",
                    "source_node_id": "node-remote",
                    "source_node_name": "Peer Desk",
                }),
            }),
        };

        super::shared_health::apply_shared_health_packet(&runtime, &state.gateway, packet);

        let events = state.gateway.store.list_events_range(None, None, Some(20));
        let expected_event_id = format!("shared:node-remote:evt-remote-http-503:{provider_name}");
        let remote = events
            .iter()
            .find(|event| {
                event.get("id").and_then(|value| value.as_str()) == Some(expected_event_id.as_str())
            })
            .expect("remote event inserted");
        assert_eq!(
            remote.get("provider").and_then(|value| value.as_str()),
            Some(provider_name.as_str())
        );
        assert_eq!(
            remote.get("level").and_then(|value| value.as_str()),
            Some("error")
        );
        assert_eq!(
            remote.get("message").and_then(|value| value.as_str()),
            Some("http 503 from peer")
        );
        let fields = remote
            .get("fields")
            .and_then(|value| value.as_object())
            .expect("fields object");
        assert_eq!(
            fields
                .get("shared_event_id")
                .and_then(|value| value.as_str()),
            Some("evt-remote-http-503")
        );
        assert_eq!(
            fields
                .get("source_node_name")
                .and_then(|value| value.as_str()),
            Some("Peer Desk")
        );
    }

    #[test]
    fn heartbeat_packets_remain_plain_discovery_messages() {
        let (_tmp, state) = build_test_state();
        let bytes = serialize_wire_packet(
            &state.gateway,
            &LanSyncPacket::Heartbeat(Box::new(LanHeartbeatPacket {
                version: 1,
                node_id: "node-x".to_string(),
                node_name: "Desk".to_string(),
                listen_port: 4000,
                remote_update_updater_port: Some(4001),
                sent_at_unix_ms: 1,
                sequence: 0,
                sender_previous_gap_ms: None,
                sender_previous_elapsed_ms: None,
                capabilities: vec!["heartbeat_v1".to_string()],
                build_identity: super::current_build_identity(),
                remote_update_readiness: None,
                remote_update_status: None,
                sync_contracts: std::collections::BTreeMap::new(),
                provider_fingerprints: vec![],
                provider_definitions_revision: String::new(),
                followed_source_node_id: None,
            })),
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
        state
            .secrets
            .set_provider_pricing(
                "provider_1",
                "per_request",
                0.035,
                None,
                Some("sk-local".to_string()),
            )
            .expect("seed local provider pricing");
        state
            .gateway
            .store
            .sync_provider_pricing_configs(&state.secrets.list_provider_pricing());
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
        assert_eq!(
            state.gateway.store.list_provider_pricing_configs(),
            state.secrets.list_provider_pricing()
        );
    }

    #[test]
    fn restore_local_provider_state_rolls_back_memory_when_persist_fails() {
        let (_tmp, mut state) = build_test_state();
        state
            .secrets
            .set_provider_key("provider_1", "sk-local-before")
            .expect("seed local provider key");
        state
            .secrets
            .set_provider_pricing(
                "provider_1",
                "per_request",
                0.035,
                None,
                Some("sk-local-before".to_string()),
            )
            .expect("seed local pricing");
        state
            .gateway
            .store
            .sync_provider_pricing_configs(&state.secrets.list_provider_pricing());
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
        state
            .secrets
            .set_provider_pricing(
                "provider_1",
                "package_total",
                12.5,
                None,
                Some("sk-followed".to_string()),
            )
            .expect("seed followed pricing");
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
        assert_eq!(
            state.gateway.store.list_provider_pricing_configs(),
            state.secrets.list_provider_pricing()
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
    fn full_reconcile_replaces_stale_followed_provider_snapshots_and_order() {
        let (_tmp, state) = build_test_state();
        state
            .secrets
            .set_followed_config_source_node_id(Some("node-remote"))
            .expect("follow remote");
        state
            .gateway
            .store
            .upsert_lan_provider_definition_snapshot(
                &crate::orchestrator::store::LanProviderDefinitionSnapshotRecord {
                    source_node_id: "node-remote".to_string(),
                    source_node_name: "Remote".to_string(),
                    shared_provider_id: "shared-alpha".to_string(),
                    provider_name: "alpha".to_string(),
                    deleted: false,
                    snapshot: serde_json::json!({
                        "name": "alpha",
                        "display_name": "Alpha",
                        "base_url": "https://alpha.example/v1",
                        "order_index": 0,
                    }),
                    updated_at_unix_ms: 1,
                    lamport_ts: 1,
                    revision_event_id: "evt-alpha-old".to_string(),
                },
            )
            .expect("seed stale alpha");
        state
            .gateway
            .store
            .upsert_lan_provider_definition_snapshot(
                &crate::orchestrator::store::LanProviderDefinitionSnapshotRecord {
                    source_node_id: "node-remote".to_string(),
                    source_node_name: "Remote".to_string(),
                    shared_provider_id: "shared-zeta".to_string(),
                    provider_name: "zeta".to_string(),
                    deleted: false,
                    snapshot: serde_json::json!({
                        "name": "zeta",
                        "display_name": "Zeta",
                        "base_url": "https://zeta.example/v1",
                        "order_index": 1,
                    }),
                    updated_at_unix_ms: 1,
                    lamport_ts: 1,
                    revision_event_id: "evt-zeta-old".to_string(),
                },
            )
            .expect("seed stale zeta");
        state
            .gateway
            .store
            .upsert_lan_provider_definition_snapshot(
                &crate::orchestrator::store::LanProviderDefinitionSnapshotRecord {
                    source_node_id: "node-remote".to_string(),
                    source_node_name: "Remote".to_string(),
                    shared_provider_id: "shared-stale".to_string(),
                    provider_name: "stale".to_string(),
                    deleted: false,
                    snapshot: serde_json::json!({
                        "name": "stale",
                        "display_name": "Stale",
                        "base_url": "https://stale.example/v1",
                        "order_index": 2,
                    }),
                    updated_at_unix_ms: 1,
                    lamport_ts: 1,
                    revision_event_id: "evt-stale-old".to_string(),
                },
            )
            .expect("seed stale extra");
        apply_followed_provider_state(&state.gateway, &state.config_path, "node-remote")
            .expect("apply stale followed state");
        assert_eq!(
            state.gateway.cfg.read().provider_order,
            vec!["alpha".to_string(), "zeta".to_string(), "stale".to_string()]
        );

        replace_remote_provider_definition_snapshots(
            &state.gateway,
            &state.config_path,
            "node-remote",
            "Remote",
            &[
                LanProviderDefinitionSyncItem {
                    shared_provider_id: "shared-zeta".to_string(),
                    provider_name: "zeta".to_string(),
                    deleted: false,
                    snapshot: serde_json::json!({
                        "name": "zeta",
                        "display_name": "Zeta",
                        "base_url": "https://zeta.example/v1",
                        "order_index": 0,
                    }),
                    lamport_ts: 5,
                    revision_event_id: "evt-zeta-new".to_string(),
                },
                LanProviderDefinitionSyncItem {
                    shared_provider_id: "shared-alpha".to_string(),
                    provider_name: "alpha".to_string(),
                    deleted: false,
                    snapshot: serde_json::json!({
                        "name": "alpha",
                        "display_name": "Alpha",
                        "base_url": "https://alpha.example/v1",
                        "order_index": 1,
                    }),
                    lamport_ts: 6,
                    revision_event_id: "evt-alpha-new".to_string(),
                },
            ],
        )
        .expect("replace remote snapshots");

        assert_eq!(
            state.gateway.cfg.read().provider_order,
            vec!["zeta".to_string(), "alpha".to_string()]
        );
        assert!(state
            .gateway
            .store
            .get_lan_provider_definition_snapshot("node-remote", "shared-stale")
            .is_none());
        let alpha_version = state
            .gateway
            .store
            .get_event_meta("lan_edit_entity_version:provider_definition:shared-alpha")
            .expect("alpha version meta")
            .expect("alpha version");
        assert_eq!(alpha_version, "6|node-remote|evt-alpha-new");
    }

    #[test]
    fn peer_http_sync_requires_trusted_peer_and_capability() {
        let trusted_peer = super::LanPeerSnapshot {
            node_id: "node-a".to_string(),
            node_name: "Node A".to_string(),
            listen_addr: "192.168.1.10:4000".to_string(),
            remote_update_updater_port: Some(4001),
            last_heartbeat_unix_ms: 1,
            capabilities: super::lan_heartbeat_capabilities(),
            version_inventory: super::local_version_inventory(),
            build_identity: super::current_build_identity(),
            remote_update_readiness: None,
            remote_update_status: None,
            provider_fingerprints: Vec::new(),
            provider_definitions_revision: String::new(),
            sync_contracts: super::local_sync_contracts(),
            followed_source_node_id: None,
            trusted: true,
            pair_state: None,
            pair_request_id: None,
            sync_blocked_domains: Vec::new(),
            sync_diagnostics: Vec::new(),
            build_matches_local: true,
            heartbeat_age_ms: 0,
            http_probe_state: None,
            http_probe_detail: None,
        };
        assert!(peer_supports_http_sync(&trusted_peer, "edit_sync_v1"));

        let mut untrusted_peer = trusted_peer.clone();
        untrusted_peer.trusted = false;
        assert!(!peer_supports_http_sync(&untrusted_peer, "edit_sync_v1"));

        let mut missing_capability_peer = trusted_peer.clone();
        missing_capability_peer.capabilities.clear();
        assert!(!peer_supports_http_sync(
            &missing_capability_peer,
            "edit_sync_v1"
        ));
    }

    #[test]
    fn peer_build_matches_local_uses_build_identity_not_cached_flag() {
        let mut matching_peer = test_peer_snapshot();
        matching_peer.build_matches_local = false;
        assert!(super::peer_build_matches_local(&matching_peer));

        let mut mismatching_peer = test_peer_snapshot();
        mismatching_peer.build_identity.app_version.push_str("-alt");
        mismatching_peer.build_matches_local = true;
        assert!(!super::peer_build_matches_local(&mismatching_peer));
    }

    #[test]
    fn sync_contract_reason_detects_domain_mismatch() {
        let incompatible_peer = super::LanPeerSnapshot {
            node_id: "node-a".to_string(),
            node_name: "Node A".to_string(),
            listen_addr: "192.168.1.10:4000".to_string(),
            remote_update_updater_port: Some(4001),
            last_heartbeat_unix_ms: 1,
            capabilities: super::lan_heartbeat_capabilities(),
            version_inventory: super::merge_version_inventory(
                &super::lan_heartbeat_capabilities(),
                &std::collections::BTreeMap::from([
                    (super::SYNC_DOMAIN_USAGE_REQUESTS.to_string(), 1),
                    (super::SYNC_DOMAIN_USAGE_HISTORY.to_string(), 1),
                    (super::SYNC_DOMAIN_PROVIDER_DEFINITIONS.to_string(), 1),
                    (super::SYNC_DOMAIN_SHARED_HEALTH.to_string(), 1),
                ]),
            ),
            build_identity: super::current_build_identity(),
            remote_update_readiness: None,
            remote_update_status: None,
            provider_fingerprints: Vec::new(),
            provider_definitions_revision: String::new(),
            sync_contracts: std::collections::BTreeMap::from([
                (super::SYNC_DOMAIN_USAGE_REQUESTS.to_string(), 1),
                (super::SYNC_DOMAIN_USAGE_HISTORY.to_string(), 1),
                (super::SYNC_DOMAIN_PROVIDER_DEFINITIONS.to_string(), 1),
                (super::SYNC_DOMAIN_SHARED_HEALTH.to_string(), 1),
            ]),
            followed_source_node_id: None,
            trusted: true,
            pair_state: None,
            pair_request_id: None,
            sync_blocked_domains: Vec::new(),
            sync_diagnostics: Vec::new(),
            build_matches_local: true,
            heartbeat_age_ms: 0,
            http_probe_state: None,
            http_probe_detail: None,
        };

        let reason = super::sync_contract_block_reason_for_domain(
            &incompatible_peer,
            super::SYNC_DOMAIN_USAGE_HISTORY,
        )
        .expect("mismatch reason");
        assert!(reason.contains("usage_history"));
        assert!(reason.contains("local=v4"));
        assert!(reason.contains("peer=v1"));
        assert!(peer_supports_http_sync(&incompatible_peer, "edit_sync_v1"));
    }

    #[test]
    fn sync_domain_diagnostics_expose_blocked_domain_versions() {
        let peer = super::LanPeerSnapshot {
            node_id: "node-a".to_string(),
            node_name: "Node A".to_string(),
            listen_addr: "192.168.1.10:4000".to_string(),
            remote_update_updater_port: Some(4001),
            last_heartbeat_unix_ms: 1,
            capabilities: super::lan_heartbeat_capabilities(),
            version_inventory: super::merge_version_inventory(
                &super::lan_heartbeat_capabilities(),
                &std::collections::BTreeMap::from([
                    (super::SYNC_DOMAIN_USAGE_REQUESTS.to_string(), 1),
                    (super::SYNC_DOMAIN_USAGE_HISTORY.to_string(), 1),
                    (super::SYNC_DOMAIN_PROVIDER_DEFINITIONS.to_string(), 1),
                    (super::SYNC_DOMAIN_SHARED_HEALTH.to_string(), 1),
                ]),
            ),
            build_identity: super::current_build_identity(),
            remote_update_readiness: None,
            remote_update_status: None,
            provider_fingerprints: Vec::new(),
            provider_definitions_revision: String::new(),
            sync_contracts: std::collections::BTreeMap::from([
                (super::SYNC_DOMAIN_USAGE_REQUESTS.to_string(), 1),
                (super::SYNC_DOMAIN_USAGE_HISTORY.to_string(), 1),
                (super::SYNC_DOMAIN_PROVIDER_DEFINITIONS.to_string(), 1),
                (super::SYNC_DOMAIN_SHARED_HEALTH.to_string(), 1),
            ]),
            followed_source_node_id: None,
            trusted: true,
            pair_state: None,
            pair_request_id: None,
            sync_blocked_domains: Vec::new(),
            sync_diagnostics: Vec::new(),
            build_matches_local: true,
            heartbeat_age_ms: 0,
            http_probe_state: None,
            http_probe_detail: None,
        };

        let diagnostics = super::sync_domain_diagnostics_for_peer(&peer);
        let blocked = diagnostics
            .into_iter()
            .find(|item| item.domain == super::SYNC_DOMAIN_USAGE_HISTORY)
            .expect("usage_history diagnostics");
        assert_eq!(blocked.status, "blocked");
        assert_eq!(blocked.local_contract_version, 4);
        assert_eq!(blocked.peer_contract_version, 1);
        assert!(blocked
            .blocked_reason
            .as_deref()
            .is_some_and(|value| value.contains("usage_history")));
    }

    #[test]
    fn lan_edit_entity_domain_registry_covers_all_supported_entities() {
        let mappings = super::LAN_EDIT_ENTITY_DOMAIN_REGISTRY
            .iter()
            .map(|(entity_type, domain)| ((*entity_type).to_string(), (*domain).to_string()))
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(
            mappings
                .get(super::LAN_EDIT_ENTITY_PROVIDER_DEFINITION)
                .map(String::as_str),
            Some(super::SYNC_DOMAIN_PROVIDER_DEFINITIONS)
        );
        assert_eq!(
            mappings
                .get(super::LAN_EDIT_ENTITY_PROVIDER_PRICING)
                .map(String::as_str),
            Some(super::SYNC_DOMAIN_USAGE_HISTORY)
        );
        assert_eq!(
            mappings
                .get(super::LAN_EDIT_ENTITY_QUOTA_SNAPSHOT)
                .map(String::as_str),
            Some(super::SYNC_DOMAIN_USAGE_HISTORY)
        );
        assert_eq!(
            mappings
                .get(super::LAN_EDIT_ENTITY_SPEND_MANUAL_DAY)
                .map(String::as_str),
            Some(super::SYNC_DOMAIN_USAGE_HISTORY)
        );
        assert_eq!(
            mappings
                .get(super::LAN_EDIT_ENTITY_TRACKED_SPEND_DAY)
                .map(String::as_str),
            Some(super::SYNC_DOMAIN_USAGE_HISTORY)
        );
        assert_eq!(
            mappings
                .get(super::LAN_EDIT_ENTITY_TRACKED_SPEND_DAY_HISTORY_DELETE)
                .map(String::as_str),
            Some(super::SYNC_DOMAIN_USAGE_HISTORY)
        );
        assert_eq!(mappings.len(), 6);
    }

    #[test]
    fn usage_requests_contract_sample_matches_current_contract_version() {
        assert_eq!(
            super::sync_contract_version(
                &super::local_sync_contracts(),
                super::SYNC_DOMAIN_USAGE_REQUESTS
            ),
            2,
            "usage_requests payload shape changed; update samples and bump contract if semantics changed"
        );
        let payload = super::usage_requests_contract_sample();
        let row: crate::orchestrator::store::UsageRequestSyncRow = serde_json::from_value(payload)
            .expect("usage_requests contract sample should deserialize");
        assert_eq!(row.transport, "http");
    }

    #[test]
    fn usage_history_contract_samples_match_current_contract_version() {
        assert_eq!(
            super::sync_contract_version(
                &super::local_sync_contracts(),
                super::SYNC_DOMAIN_USAGE_HISTORY
            ),
            4,
            "usage_history payload shape changed; update samples and bump contract if semantics changed"
        );
        let samples = super::usage_history_contract_samples();
        assert_eq!(samples.len(), 5);
        for (entity_type, payload) in samples {
            assert_eq!(
                super::lan_edit_entity_sync_domain(entity_type),
                Some(super::SYNC_DOMAIN_USAGE_HISTORY),
                "usage_history sample entity must stay mapped to usage_history"
            );
            assert!(
                payload.is_object(),
                "usage_history contract sample for {entity_type} must stay object-shaped"
            );
        }
    }

    #[test]
    fn local_version_inventory_exposes_capabilities_and_contracts() {
        let inventory = super::local_version_inventory();
        assert!(inventory.contains(&"heartbeat_v1".to_string()));
        assert!(inventory.contains(&"remote_update_v2".to_string()));
        assert!(inventory.contains(&"usage_requests_v2".to_string()));
        assert!(inventory.contains(&"usage_history_v4".to_string()));
    }

    #[test]
    fn version_registry_includes_bump_rules_for_every_entry() {
        let rules = super::versioning::version_bump_rules();
        assert!(!rules.is_empty());
        assert!(rules.iter().any(|(name, version, rule)| {
            name == super::SYNC_DOMAIN_USAGE_HISTORY && *version == 4 && rule.contains("truth")
        }));
        assert!(rules
            .iter()
            .all(|(_name, _version, rule)| !rule.trim().is_empty()));
    }

    #[test]
    fn apply_edit_sync_batch_skips_events_for_blocked_entity_domain() {
        let (_tmp, state) = build_test_state();
        let runtime = super::LanSyncRuntime::new(super::LanNodeIdentity {
            node_id: "node-self".to_string(),
            node_name: "self".to_string(),
        });
        let peer = super::LanPeerSnapshot {
            node_id: "node-remote".to_string(),
            node_name: "remote".to_string(),
            listen_addr: "192.168.1.10:4000".to_string(),
            remote_update_updater_port: Some(4001),
            last_heartbeat_unix_ms: 1,
            capabilities: super::lan_heartbeat_capabilities(),
            version_inventory: super::merge_version_inventory(
                &super::lan_heartbeat_capabilities(),
                &std::collections::BTreeMap::from([
                    (super::SYNC_DOMAIN_USAGE_REQUESTS.to_string(), 1),
                    (super::SYNC_DOMAIN_USAGE_HISTORY.to_string(), 2),
                    (super::SYNC_DOMAIN_PROVIDER_DEFINITIONS.to_string(), 0),
                    (super::SYNC_DOMAIN_SHARED_HEALTH.to_string(), 1),
                ]),
            ),
            build_identity: super::current_build_identity(),
            remote_update_readiness: None,
            remote_update_status: None,
            provider_fingerprints: Vec::new(),
            provider_definitions_revision: String::new(),
            sync_contracts: std::collections::BTreeMap::from([
                (super::SYNC_DOMAIN_USAGE_REQUESTS.to_string(), 1),
                (super::SYNC_DOMAIN_USAGE_HISTORY.to_string(), 2),
                (super::SYNC_DOMAIN_PROVIDER_DEFINITIONS.to_string(), 0),
                (super::SYNC_DOMAIN_SHARED_HEALTH.to_string(), 1),
            ]),
            followed_source_node_id: None,
            trusted: true,
            pair_state: None,
            pair_request_id: None,
            sync_blocked_domains: Vec::new(),
            sync_diagnostics: Vec::new(),
            build_matches_local: false,
            heartbeat_age_ms: 0,
            http_probe_state: None,
            http_probe_detail: None,
        };
        let shared_provider_id = state
            .secrets
            .ensure_provider_shared_id("provider_1")
            .expect("shared id");
        let batch = super::LanEditSyncBatchPacket {
            version: 1,
            node_id: peer.node_id.clone(),
            events: vec![crate::orchestrator::store::LanEditSyncEvent {
                event_id: "evt-provider-definition".to_string(),
                node_id: peer.node_id.clone(),
                node_name: peer.node_name.clone(),
                created_at_unix_ms: 1,
                lamport_ts: 1,
                entity_type: super::LAN_EDIT_ENTITY_PROVIDER_DEFINITION.to_string(),
                entity_id: shared_provider_id.clone(),
                op: "patch".to_string(),
                payload: serde_json::json!({
                    "name": "provider_1",
                    "display_name": "Blocked Name",
                    "base_url": "https://blocked.example/v1"
                }),
            }],
            has_more: false,
        };

        super::apply_edit_sync_batch(&runtime, &state.gateway, &state.config_path, &peer, batch);

        assert!(
            state
                .gateway
                .store
                .get_lan_provider_definition_snapshot("node-remote", &shared_provider_id)
                .is_none(),
            "provider_definition event must be skipped when provider_definitions domain is blocked"
        );
    }

    #[test]
    fn build_remote_update_worker_command_points_at_repo_script() {
        let (program, _args, script) =
            super::build_remote_update_worker_command("main").expect("worker command");
        #[cfg(target_os = "windows")]
        {
            assert_eq!(program, "powershell.exe");
            assert!(_args.iter().any(|value| value == "-File"));
            assert!(
                script.ends_with("src-tauri\\src\\lan_sync\\remote_update\\lan-remote-update.ps1")
            );
        }
        #[cfg(not(target_os = "windows"))]
        {
            assert_eq!(program, "bash");
            assert!(script.ends_with("src-tauri/src/lan_sync/remote_update/lan-remote-update.sh"));
        }
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
    fn peer_registry_hides_stale_peers_and_prunes_expired_history() {
        let runtime = LanSyncRuntime::new(LanNodeIdentity {
            node_id: "node-self".to_string(),
            node_name: "self".to_string(),
        });
        let now = super::LAN_PEER_HISTORY_RETAIN_AFTER_MS + 100_000;
        runtime.peers.write().insert(
            "fresh".to_string(),
            super::LanPeerRuntime {
                node_id: "fresh".to_string(),
                node_name: "Fresh".to_string(),
                listen_addr: "192.168.1.10:4000".to_string(),
                remote_update_updater_port: Some(4001),
                last_heartbeat_unix_ms: now,
                capabilities: vec!["heartbeat_v1".to_string()],
                version_inventory: vec!["heartbeat_v1".to_string()],
                build_identity: super::current_build_identity(),
                remote_update_readiness: None,
                remote_update_status: None,
                sync_contracts: std::collections::BTreeMap::new(),
                provider_fingerprints: vec![],
                provider_definitions_revision: String::new(),
                followed_source_node_id: None,
            },
        );
        runtime.peers.write().insert(
            "stale".to_string(),
            super::LanPeerRuntime {
                node_id: "stale".to_string(),
                node_name: "Stale".to_string(),
                listen_addr: "192.168.1.11:4000".to_string(),
                remote_update_updater_port: Some(4001),
                last_heartbeat_unix_ms: now.saturating_sub(LAN_PEER_STALE_AFTER_MS + 1),
                capabilities: vec!["heartbeat_v1".to_string()],
                version_inventory: vec!["heartbeat_v1".to_string()],
                build_identity: super::current_build_identity(),
                remote_update_readiness: None,
                remote_update_status: None,
                sync_contracts: std::collections::BTreeMap::new(),
                provider_fingerprints: vec![],
                provider_definitions_revision: String::new(),
                followed_source_node_id: None,
            },
        );
        runtime.peers.write().insert(
            "expired".to_string(),
            super::LanPeerRuntime {
                node_id: "expired".to_string(),
                node_name: "Expired".to_string(),
                listen_addr: "192.168.1.12:4000".to_string(),
                remote_update_updater_port: Some(4001),
                last_heartbeat_unix_ms: now
                    .saturating_sub(super::LAN_PEER_HISTORY_RETAIN_AFTER_MS + 1),
                capabilities: vec!["heartbeat_v1".to_string()],
                version_inventory: vec!["heartbeat_v1".to_string()],
                build_identity: super::current_build_identity(),
                remote_update_readiness: None,
                remote_update_status: None,
                sync_contracts: std::collections::BTreeMap::new(),
                provider_fingerprints: vec![],
                provider_definitions_revision: String::new(),
                followed_source_node_id: None,
            },
        );

        let peers = runtime.collect_live_peers(now);
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].node_id, "fresh");
        assert!(
            runtime.peers.read().contains_key("stale"),
            "recently stale peer metadata must stay available for rollback"
        );
        assert!(
            !runtime.peers.read().contains_key("expired"),
            "expired peer metadata should be pruned after rollback grace"
        );
    }

    #[test]
    fn recent_peer_lookup_keeps_recently_stale_peer_for_http_grace_window() {
        let runtime = LanSyncRuntime::new(LanNodeIdentity {
            node_id: "node-self".to_string(),
            node_name: "self".to_string(),
        });
        let now = crate::orchestrator::store::unix_ms();
        runtime.peers.write().insert(
            "peer-recent".to_string(),
            super::LanPeerRuntime {
                node_id: "peer-recent".to_string(),
                node_name: "Peer Recent".to_string(),
                listen_addr: "192.168.1.12:4000".to_string(),
                remote_update_updater_port: Some(4001),
                last_heartbeat_unix_ms: now.saturating_sub(LAN_PEER_STALE_AFTER_MS + 1),
                capabilities: super::lan_heartbeat_capabilities(),
                version_inventory: super::local_version_inventory(),
                build_identity: super::current_build_identity(),
                remote_update_readiness: None,
                remote_update_status: None,
                sync_contracts: std::collections::BTreeMap::new(),
                provider_fingerprints: vec![],
                provider_definitions_revision: String::new(),
                followed_source_node_id: None,
            },
        );

        let recent = runtime
            .recent_peer_by_node_id("peer-recent", super::LAN_PEER_HTTP_GRACE_AFTER_MS)
            .expect("recently stale peer should still be reachable for HTTP grace");
        assert_eq!(recent.node_id, "peer-recent");
        assert_eq!(recent.listen_addr, "192.168.1.12:4000");
        assert!(peer_is_stale(
            recent.last_heartbeat_unix_ms,
            crate::orchestrator::store::unix_ms()
        ));
    }

    #[test]
    fn peer_updater_base_url_derives_port_for_legacy_heartbeat() {
        let peer = LanPeerSnapshot {
            node_id: "peer-legacy".to_string(),
            node_name: "Peer Legacy".to_string(),
            listen_addr: "192.168.1.12:4000".to_string(),
            remote_update_updater_port: None,
            last_heartbeat_unix_ms: crate::orchestrator::store::unix_ms(),
            capabilities: super::lan_heartbeat_capabilities(),
            version_inventory: super::local_version_inventory(),
            build_identity: super::current_build_identity(),
            provider_fingerprints: Vec::new(),
            provider_definitions_revision: String::new(),
            sync_contracts: super::local_sync_contracts(),
            followed_source_node_id: None,
            trusted: true,
            pair_state: Some("trusted".to_string()),
            pair_request_id: None,
            remote_update_readiness: Some(super::current_local_remote_update_readiness()),
            remote_update_status: None,
            sync_blocked_domains: Vec::new(),
            sync_diagnostics: Vec::new(),
            build_matches_local: true,
            heartbeat_age_ms: 0,
            http_probe_state: None,
            http_probe_detail: None,
        };

        assert_eq!(
            super::peer_updater_base_url(&peer),
            Some("http://192.168.1.12:4001".to_string())
        );
    }

    #[test]
    fn recently_stale_peers_lists_recent_offline_peer_without_readding_live_peer() {
        let runtime = LanSyncRuntime::new(LanNodeIdentity {
            node_id: "node-self".to_string(),
            node_name: "self".to_string(),
        });
        let now = crate::orchestrator::store::unix_ms();
        runtime.peers.write().insert(
            "peer-recent".to_string(),
            super::LanPeerRuntime {
                node_id: "peer-recent".to_string(),
                node_name: "Peer Recent".to_string(),
                listen_addr: "192.168.1.12:4000".to_string(),
                remote_update_updater_port: Some(4001),
                last_heartbeat_unix_ms: now.saturating_sub(super::LAN_PEER_STALE_AFTER_MS + 1),
                capabilities: super::lan_heartbeat_capabilities(),
                version_inventory: super::local_version_inventory(),
                build_identity: super::current_build_identity(),
                remote_update_readiness: None,
                remote_update_status: None,
                sync_contracts: super::local_sync_contracts(),
                provider_fingerprints: vec![],
                provider_definitions_revision: String::new(),
                followed_source_node_id: None,
            },
        );
        runtime.peers.write().insert(
            "peer-live".to_string(),
            super::LanPeerRuntime {
                node_id: "peer-live".to_string(),
                node_name: "Peer Live".to_string(),
                listen_addr: "192.168.1.13:4000".to_string(),
                remote_update_updater_port: Some(4001),
                last_heartbeat_unix_ms: now,
                capabilities: super::lan_heartbeat_capabilities(),
                version_inventory: super::local_version_inventory(),
                build_identity: super::current_build_identity(),
                remote_update_readiness: None,
                remote_update_status: None,
                sync_contracts: super::local_sync_contracts(),
                provider_fingerprints: vec![],
                provider_definitions_revision: String::new(),
                followed_source_node_id: None,
            },
        );

        let peers = runtime.recently_stale_peers(super::LAN_PEER_HTTP_GRACE_AFTER_MS);
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].node_id, "peer-recent");
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
                remote_update_updater_port: Some(4001),
                sent_at_unix_ms: 1000,
                sequence: 0,
                sender_previous_gap_ms: None,
                sender_previous_elapsed_ms: None,
                capabilities: vec!["heartbeat_v1".to_string()],
                build_identity: super::current_build_identity(),
                remote_update_readiness: None,
                remote_update_status: None,
                sync_contracts: std::collections::BTreeMap::new(),
                provider_fingerprints: Vec::new(),
                provider_definitions_revision: String::new(),
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
    fn lan_peer_diagnostics_log_is_capped_to_recent_entries() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let user_data_dir = tmp.path().join("user-data");
        let _guard = set_remote_update_env_for_test(Some(&user_data_dir), None);

        for index in 0..256 {
            super::append_lan_peer_diagnostics_log(&format!(
                "diagnostic entry {index:03} {}",
                "x".repeat(512)
            ));
        }

        let log_path =
            super::lan_peer_diagnostics_log_path().expect("diagnostics log path should exist");
        let bytes = std::fs::read(&log_path).expect("read diagnostics log");
        assert!(bytes.len() <= super::LAN_PEER_DIAGNOSTICS_LOG_MAX_BYTES);
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("diagnostic entry 255"));
        assert!(!text.contains("diagnostic entry 000"));
    }

    #[test]
    fn heartbeat_sender_delay_stays_quiet_without_previous_success() {
        assert_eq!(super::heartbeat_sender_delay_ms(None, 10_000), None);
    }

    #[test]
    fn heartbeat_sender_delay_uses_strict_threshold_boundary() {
        let threshold = super::LAN_HEARTBEAT_SENDER_DELAY_LOG_THRESHOLD_MS;
        assert_eq!(super::heartbeat_sender_delay_ms(Some(10_000), 10_000), None);
        assert_eq!(
            super::heartbeat_sender_delay_ms(Some(10_000), 10_000 + threshold),
            None
        );
        assert_eq!(
            super::heartbeat_sender_delay_ms(Some(10_000), 10_000 + threshold + 1),
            Some(threshold + 1)
        );
    }

    #[test]
    fn snapshot_exposes_last_http_sync_probe_diagnostics() {
        let runtime = LanSyncRuntime::new(LanNodeIdentity {
            node_id: "node-self".to_string(),
            node_name: "self".to_string(),
        });
        let cfg = crate::orchestrator::config::AppConfig::default_config();
        let tmp = tempfile::tempdir().expect("tempdir");
        let secrets =
            crate::orchestrator::secrets::SecretStore::new(tmp.path().join("secrets.json"));
        let peer = super::LanPeerSnapshot {
            node_id: "node-peer".to_string(),
            node_name: "Peer".to_string(),
            listen_addr: "192.168.1.50:4000".to_string(),
            remote_update_updater_port: Some(4001),
            last_heartbeat_unix_ms: 1,
            capabilities: super::lan_heartbeat_capabilities(),
            version_inventory: super::local_version_inventory(),
            build_identity: super::current_build_identity(),
            remote_update_readiness: None,
            remote_update_status: None,
            provider_fingerprints: Vec::new(),
            provider_definitions_revision: String::new(),
            sync_contracts: super::local_sync_contracts(),
            followed_source_node_id: None,
            trusted: true,
            pair_state: None,
            pair_request_id: None,
            sync_blocked_domains: Vec::new(),
            sync_diagnostics: Vec::new(),
            build_matches_local: true,
            heartbeat_age_ms: 0,
            http_probe_state: None,
            http_probe_detail: None,
        };
        runtime.note_http_sync_probe(
            &peer,
            "/lan-sync/edit",
            "request_error",
            "LAN sync request error (timeout); url=http://192.168.1.50:4000/lan-sync/edit",
        );

        let snapshot = runtime.snapshot(4_000, &cfg, &secrets);
        let probe = snapshot.last_http_sync_probe.expect("last http sync probe");
        assert_eq!(probe.peer_node_id, "node-peer");
        assert_eq!(probe.peer_listen_addr, "192.168.1.50:4000");
        assert_eq!(probe.route, "/lan-sync/edit");
        assert_eq!(probe.outcome, "request_error");
        assert!(probe.detail.contains("timeout"));
        let failure = snapshot
            .last_http_sync_failure
            .expect("last http sync failure");
        assert_eq!(failure.route, "/lan-sync/edit");
    }

    #[test]
    fn successful_http_sync_probe_clears_matching_failure_and_marks_recovery() {
        let runtime = LanSyncRuntime::new(LanNodeIdentity {
            node_id: "node-self".to_string(),
            node_name: "self".to_string(),
        });
        let cfg = crate::orchestrator::config::AppConfig::default_config();
        let tmp = tempfile::tempdir().expect("tempdir");
        let secrets =
            crate::orchestrator::secrets::SecretStore::new(tmp.path().join("secrets.json"));
        let peer = super::LanPeerSnapshot {
            node_id: "node-peer".to_string(),
            node_name: "Peer".to_string(),
            listen_addr: "192.168.1.50:4000".to_string(),
            remote_update_updater_port: Some(4001),
            last_heartbeat_unix_ms: 1,
            capabilities: super::lan_heartbeat_capabilities(),
            version_inventory: super::local_version_inventory(),
            build_identity: super::current_build_identity(),
            remote_update_readiness: None,
            remote_update_status: None,
            provider_fingerprints: Vec::new(),
            provider_definitions_revision: String::new(),
            sync_contracts: super::local_sync_contracts(),
            followed_source_node_id: None,
            trusted: true,
            pair_state: None,
            pair_request_id: None,
            sync_blocked_domains: Vec::new(),
            sync_diagnostics: Vec::new(),
            build_matches_local: true,
            heartbeat_age_ms: 0,
            http_probe_state: None,
            http_probe_detail: None,
        };
        runtime.note_http_sync_probe(
            &peer,
            "/lan-sync/edit",
            "request_error",
            "LAN sync request error (timeout); url=http://192.168.1.50:4000/lan-sync/edit",
        );

        let recovered = runtime.note_http_sync_probe(&peer, "/lan-sync/edit", "ok", "HTTP sync ok");
        let recovered = recovered.expect("matching sync failure should be marked recovered");
        assert_eq!(recovered.route, "/lan-sync/edit");
        assert_eq!(recovered.outcome, "request_error");

        let snapshot = runtime.snapshot(4_000, &cfg, &secrets);
        let probe = snapshot.last_http_sync_probe.expect("last http sync probe");
        assert_eq!(probe.route, "/lan-sync/edit");
        assert_eq!(probe.outcome, "ok");
        assert!(snapshot.last_http_sync_failure.is_none());
    }

    #[test]
    fn official_account_profile_fetch_uses_short_request_timeout() {
        assert_eq!(
            super::official_account_profiles_request_timeout(),
            std::time::Duration::from_millis(2_500)
        );
    }

    #[test]
    fn quota_and_tracked_spend_recording_emit_lan_edit_events() {
        let (_tmp, state) = build_test_state();
        let runtime = LanSyncRuntime::new(LanNodeIdentity {
            node_id: "node-self".to_string(),
            node_name: "self".to_string(),
        });
        super::register_gateway_status_runtime(runtime);
        state
            .secrets
            .ensure_provider_shared_id("provider_1")
            .expect("shared id");

        let snapshot = crate::orchestrator::quota::QuotaSnapshot {
            kind: crate::orchestrator::quota::UsageKind::BudgetInfo,
            updated_at_unix_ms: 5000,
            remaining: None,
            today_used: None,
            today_added: None,
            daily_spent_usd: Some(12.34),
            daily_budget_usd: Some(100.0),
            weekly_spent_usd: None,
            weekly_budget_usd: None,
            monthly_spent_usd: None,
            monthly_budget_usd: None,
            package_expires_at_unix_ms: None,
            last_error: String::new(),
            effective_usage_base: Some("https://example.com/v1".to_string()),
            effective_usage_source: Some("remote".to_string()),
            producer_node_id: None,
            producer_node_name: None,
            applied_from_node_id: None,
            applied_from_node_name: None,
            applied_at_unix_ms: 0,
        };
        super::record_quota_snapshot_from_gateway(
            &state.gateway,
            &state.secrets,
            "provider_1",
            &snapshot,
        )
        .expect("record quota snapshot");

        let (events, _) = state.gateway.store.list_lan_edit_events_batch(0, None, 10);
        assert!(events
            .iter()
            .any(|event| event.entity_type == "quota_snapshot"));
    }

    #[test]
    fn ensure_local_edit_seed_state_includes_existing_usage_entities() {
        let (_tmp, state) = build_test_state();
        let shared_provider_id = state
            .secrets
            .ensure_provider_shared_id("provider_1")
            .expect("shared id");
        state
            .secrets
            .set_provider_pricing("provider_1", "per_request", 0.035, None, None)
            .expect("set provider pricing");
        state
            .gateway
            .store
            .sync_provider_pricing_configs(&state.secrets.list_provider_pricing());
        state
            .gateway
            .store
            .put_quota_snapshot(
                "provider_1",
                &serde_json::json!({
                    "kind": "budget_info",
                    "updated_at_unix_ms": 5000u64,
                    "daily_spent_usd": 12.34,
                    "daily_budget_usd": 100.0,
                    "last_error": "",
                }),
            )
            .expect("seed quota snapshot");
        state.gateway.store.put_spend_manual_day(
            "provider_1",
            "2026-04-02",
            &serde_json::json!({
                "provider": "provider_1",
                "day_key": "2026-04-02",
                "manual_total_usd": 1.25,
                "manual_usd_per_req": 0.5,
                "updated_at_unix_ms": 6000u64,
            }),
        );
        state.gateway.store.put_spend_day(
            "provider_1",
            1_711_929_600_000u64,
            &serde_json::json!({
                "provider": "provider_1",
                "started_at_unix_ms": 1_711_929_600_000u64,
                "tracked_spend_usd": 8.5,
                "updated_at_unix_ms": 7000u64,
                "producer_node_id": state.lan_sync.local_node_id(),
                "producer_node_name": state.lan_sync.local_node_name(),
            }),
        );
        state.gateway.store.put_remote_spend_day(
            "provider_1",
            "node-remote",
            "Remote Node",
            1_711_933_200_000u64,
            &serde_json::json!({
                "provider": "provider_1",
                "started_at_unix_ms": 1_711_933_200_000u64,
                "tracked_spend_usd": 12.25,
                "updated_at_unix_ms": 7100u64,
                "producer_node_id": "node-remote",
                "producer_node_name": "Remote Node",
            }),
        );

        super::ensure_local_edit_seed_state(&state).expect("seed local edit state");

        let (events, _) = state.gateway.store.list_lan_edit_events_batch(0, None, 50);
        assert!(events
            .iter()
            .any(|event| event.entity_type == "provider_pricing"));
        assert!(events
            .iter()
            .any(|event| event.entity_type == "quota_snapshot"));
        assert!(events
            .iter()
            .any(|event| event.entity_type == "spend_manual_day"));
        let tracked_spend_events = events
            .iter()
            .filter(|event| event.entity_type == "tracked_spend_day")
            .collect::<Vec<_>>();
        assert_eq!(tracked_spend_events.len(), 1);
        assert!(tracked_spend_events.iter().any(|event| {
            event.entity_id
                == tracked_spend_day_entity_id(
                    &shared_provider_id,
                    1_711_929_600_000u64,
                    &state.lan_sync.local_node_id(),
                )
        }));
    }

    #[test]
    fn normalize_tracked_spend_day_seed_row_strips_applied_metadata() {
        let normalized = super::normalize_tracked_spend_day_seed_row(&serde_json::json!({
            "provider": "provider_1",
            "started_at_unix_ms": 1_711_933_200_000u64,
            "tracked_spend_usd": 12.25,
            "updated_at_unix_ms": 7100u64,
            "producer_node_id": "node-remote",
            "producer_node_name": "Remote Node",
            "applied_from_node_id": "node-self",
            "applied_from_node_name": "Self Node",
            "applied_at_unix_ms": 9999u64,
        }));
        assert_eq!(
            normalized.get("applied_from_node_id"),
            None,
            "seed payload should not drift with receiver metadata"
        );
        assert_eq!(normalized.get("applied_from_node_name"), None);
        assert_eq!(normalized.get("applied_at_unix_ms"), None);
        assert_eq!(
            normalized.get("producer_node_id").and_then(Value::as_str),
            Some("node-remote")
        );
    }

    #[test]
    fn tracked_spend_history_day_key_for_debug_rejects_overflow_timestamp() {
        let day = serde_json::json!({
            "started_at_unix_ms": (i64::MAX as u64).saturating_add(1),
            "tracked_spend_usd": 1.0
        });
        assert_eq!(super::tracked_spend_history_day_key_for_debug(&day), None);
    }

    #[test]
    fn rebuild_shared_tracked_spend_views_ignores_remote_cache_truth() {
        let (_tmp, state) = build_test_state();
        let shared_provider_id = state
            .secrets
            .ensure_provider_shared_id("provider_1")
            .expect("shared id");
        let local_started_at_unix_ms = 1_711_929_600_000u64;
        let remote_started_at_unix_ms = 1_711_933_200_000u64;
        let local_day_key =
            crate::orchestrator::store::Store::local_day_key_from_unix_ms(local_started_at_unix_ms)
                .expect("local day key");

        state.gateway.store.put_spend_day(
            "provider_1",
            local_started_at_unix_ms,
            &serde_json::json!({
                "provider": "provider_1",
                "started_at_unix_ms": local_started_at_unix_ms,
                "tracked_spend_usd": 8.5,
                "updated_at_unix_ms": 7000u64,
                "producer_node_id": state.lan_sync.local_node_id(),
                "producer_node_name": state.lan_sync.local_node_name(),
            }),
        );
        state.gateway.store.put_remote_spend_day(
            "provider_1",
            "node-remote",
            "Remote Node",
            remote_started_at_unix_ms,
            &serde_json::json!({
                "provider": "provider_1",
                "started_at_unix_ms": remote_started_at_unix_ms,
                "tracked_spend_usd": 12.25,
                "updated_at_unix_ms": 7100u64,
                "producer_node_id": "node-remote",
                "producer_node_name": "Remote Node",
            }),
        );

        super::ensure_local_edit_seed_state(&state).expect("seed local edit state");
        super::rebuild_shared_tracked_spend_views(&state).expect("rebuild shared view");

        let shared_rows = state
            .gateway
            .store
            .list_shared_tracked_spend_days("provider_1");
        assert_eq!(shared_rows.len(), 1);
        assert_eq!(
            shared_rows[0].get("day_key").and_then(Value::as_str),
            Some(local_day_key.as_str())
        );
        assert_eq!(
            shared_rows[0]
                .get("tracked_spend_usd")
                .and_then(Value::as_f64),
            Some(8.5)
        );

        let tracked_spend_events = state
            .gateway
            .store
            .list_lan_edit_events_batch(0, None, 50)
            .0
            .into_iter()
            .filter(|event| event.entity_type == "tracked_spend_day")
            .collect::<Vec<_>>();
        assert_eq!(tracked_spend_events.len(), 1);
        assert_eq!(
            tracked_spend_events[0].entity_id,
            tracked_spend_day_entity_id(
                &shared_provider_id,
                local_started_at_unix_ms,
                &state.lan_sync.local_node_id(),
            )
        );
    }

    #[test]
    fn rebuild_shared_tracked_spend_views_respects_day_delete_after_disconnect() {
        let (_tmp, state) = build_test_state();
        let shared_provider_id = state
            .secrets
            .ensure_provider_shared_id("provider_1")
            .expect("shared id");
        let started_at_unix_ms = 1_711_929_600_000u64;
        let day_key =
            crate::orchestrator::store::Store::local_day_key_from_unix_ms(started_at_unix_ms)
                .expect("day key");

        state
            .gateway
            .store
            .insert_lan_edit_event(&LanEditSyncEvent {
                event_id: "edit-replace-before-disconnect".to_string(),
                node_id: "node-remote".to_string(),
                node_name: "Remote Node".to_string(),
                created_at_unix_ms: 10,
                lamport_ts: 10,
                entity_type: "tracked_spend_day".to_string(),
                entity_id: tracked_spend_day_entity_id(
                    &shared_provider_id,
                    started_at_unix_ms,
                    "node-remote",
                ),
                op: "replace".to_string(),
                payload: serde_json::json!({
                    "provider_name": "provider_1",
                    "day_started_at_unix_ms": started_at_unix_ms,
                    "row": {
                        "provider": "provider_1",
                        "started_at_unix_ms": started_at_unix_ms,
                        "tracked_spend_usd": 17.47,
                        "updated_at_unix_ms": started_at_unix_ms,
                        "producer_node_id": "node-remote",
                        "producer_node_name": "Remote Node"
                    }
                }),
            });
        state
            .gateway
            .store
            .insert_lan_edit_event(&LanEditSyncEvent {
                event_id: "edit-day-delete-after-reconnect".to_string(),
                node_id: state.lan_sync.local_node_id(),
                node_name: state.lan_sync.local_node_name(),
                created_at_unix_ms: 11,
                lamport_ts: 11,
                entity_type: "tracked_spend_day_history_delete".to_string(),
                entity_id: format!("{shared_provider_id}|{day_key}"),
                op: "delete".to_string(),
                payload: serde_json::json!({
                    "provider_name": "provider_1",
                    "day_key": day_key,
                }),
            });

        super::rebuild_shared_tracked_spend_views(&state).expect("rebuild shared view");

        assert!(
            state
                .gateway
                .store
                .list_shared_tracked_spend_days("provider_1")
                .is_empty(),
            "day delete event should win after reconnect rebuild"
        );
    }

    #[test]
    fn rebuild_shared_tracked_spend_views_compacts_superseded_source_events() {
        let (_tmp, state) = build_test_state();
        let shared_provider_id = state
            .secrets
            .ensure_provider_shared_id("provider_1")
            .expect("shared id");
        let started_at_unix_ms = 1_711_929_600_000u64;
        let day_key =
            crate::orchestrator::store::Store::local_day_key_from_unix_ms(started_at_unix_ms)
                .expect("day key");
        let entity_id =
            tracked_spend_day_entity_id(&shared_provider_id, started_at_unix_ms, "node-remote");

        assert!(state
            .gateway
            .store
            .insert_lan_edit_event(&LanEditSyncEvent {
                event_id: "edit-replace-1".to_string(),
                node_id: "node-remote".to_string(),
                node_name: "Remote Node".to_string(),
                created_at_unix_ms: 10,
                lamport_ts: 10,
                entity_type: "tracked_spend_day".to_string(),
                entity_id: entity_id.clone(),
                op: "replace".to_string(),
                payload: serde_json::json!({
                    "provider_name": "provider_1",
                    "day_started_at_unix_ms": started_at_unix_ms,
                    "row": {
                        "provider": "provider_1",
                        "started_at_unix_ms": started_at_unix_ms,
                        "tracked_spend_usd": 3.0,
                        "updated_at_unix_ms": 10u64,
                        "producer_node_id": "node-remote",
                        "producer_node_name": "Remote Node"
                    }
                }),
            }));
        assert!(state
            .gateway
            .store
            .insert_lan_edit_event(&LanEditSyncEvent {
                event_id: "edit-replace-2".to_string(),
                node_id: "node-remote".to_string(),
                node_name: "Remote Node".to_string(),
                created_at_unix_ms: 11,
                lamport_ts: 11,
                entity_type: "tracked_spend_day".to_string(),
                entity_id,
                op: "replace".to_string(),
                payload: serde_json::json!({
                    "provider_name": "provider_1",
                    "day_started_at_unix_ms": started_at_unix_ms,
                    "row": {
                        "provider": "provider_1",
                        "started_at_unix_ms": started_at_unix_ms,
                        "tracked_spend_usd": 9.5,
                        "updated_at_unix_ms": 11u64,
                        "producer_node_id": "node-remote",
                        "producer_node_name": "Remote Node"
                    }
                }),
            }));

        super::rebuild_shared_tracked_spend_views(&state).expect("rebuild shared view");

        let shared_rows = state
            .gateway
            .store
            .list_shared_tracked_spend_days("provider_1");
        assert_eq!(shared_rows.len(), 1);
        assert_eq!(
            shared_rows[0].get("day_key").and_then(Value::as_str),
            Some(day_key.as_str())
        );
        assert_eq!(
            shared_rows[0]
                .get("tracked_spend_usd")
                .and_then(Value::as_f64),
            Some(9.5)
        );
        let sources = state
            .gateway
            .store
            .list_shared_tracked_spend_day_sources(&shared_provider_id, &day_key);
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].2, 11);
        assert_eq!(
            sources[0]
                .3
                .get("tracked_spend_usd")
                .and_then(Value::as_f64),
            Some(9.5)
        );
    }

    #[test]
    fn rebuild_shared_tracked_spend_views_does_not_sum_duplicate_day_sources() {
        let (_tmp, state) = build_test_state();
        let shared_provider_id = state
            .secrets
            .ensure_provider_shared_id("provider_1")
            .expect("shared id");
        let started_at_unix_ms = 1_711_929_600_000u64;
        let day_key =
            crate::orchestrator::store::Store::local_day_key_from_unix_ms(started_at_unix_ms)
                .expect("day key");

        for (node_id, node_name, updated_at, event_id) in [
            ("node-remote-a", "Remote A", 10u64, "edit-remote-a"),
            ("node-remote-b", "Remote B", 11u64, "edit-remote-b"),
        ] {
            assert!(state
                .gateway
                .store
                .insert_lan_edit_event(&LanEditSyncEvent {
                    event_id: event_id.to_string(),
                    node_id: node_id.to_string(),
                    node_name: node_name.to_string(),
                    created_at_unix_ms: updated_at,
                    lamport_ts: updated_at,
                    entity_type: "tracked_spend_day".to_string(),
                    entity_id: tracked_spend_day_entity_id(
                        &shared_provider_id,
                        started_at_unix_ms,
                        node_id,
                    ),
                    op: "replace".to_string(),
                    payload: serde_json::json!({
                        "provider_name": "provider_1",
                        "day_started_at_unix_ms": started_at_unix_ms,
                        "row": {
                            "provider": "provider_1",
                            "started_at_unix_ms": started_at_unix_ms,
                            "tracked_spend_usd": 17.47,
                            "updated_at_unix_ms": updated_at,
                            "producer_node_id": node_id,
                            "producer_node_name": node_name
                        }
                    }),
                }));
        }

        super::rebuild_shared_tracked_spend_views(&state).expect("rebuild shared view");

        let shared_rows = state
            .gateway
            .store
            .list_shared_tracked_spend_days("provider_1");
        assert_eq!(shared_rows.len(), 1);
        assert_eq!(
            shared_rows[0].get("day_key").and_then(Value::as_str),
            Some(day_key.as_str())
        );
        assert_eq!(
            shared_rows[0]
                .get("tracked_spend_usd")
                .and_then(Value::as_f64),
            Some(17.47)
        );
        assert_eq!(
            shared_rows[0]
                .get("producer_node_id")
                .and_then(Value::as_str),
            Some("node-remote-b")
        );
        assert_eq!(
            shared_rows[0]
                .get("tracked_source_nodes")
                .and_then(Value::as_array)
                .map(|items| items.len()),
            Some(2)
        );
    }

    #[test]
    fn rebuild_shared_tracked_spend_views_skips_broken_projection_events() {
        let (_tmp, state) = build_test_state();
        let shared_provider_id = state
            .secrets
            .ensure_provider_shared_id("provider_1")
            .expect("shared id");
        let started_at_unix_ms = 1_711_929_600_000u64;
        let day_key =
            crate::orchestrator::store::Store::local_day_key_from_unix_ms(started_at_unix_ms)
                .expect("day key");

        assert!(state
            .gateway
            .store
            .insert_lan_edit_event(&LanEditSyncEvent {
                event_id: "edit-broken-provider".to_string(),
                node_id: "node-ghost".to_string(),
                node_name: "Ghost Node".to_string(),
                created_at_unix_ms: 9,
                lamport_ts: 9,
                entity_type: "tracked_spend_day".to_string(),
                entity_id: tracked_spend_day_entity_id(
                    "sp_missing",
                    started_at_unix_ms,
                    "node-ghost",
                ),
                op: "replace".to_string(),
                payload: serde_json::json!({
                    "provider_name": "ghost_provider",
                    "day_started_at_unix_ms": started_at_unix_ms,
                    "row": {
                        "provider": "ghost_provider",
                        "started_at_unix_ms": started_at_unix_ms,
                        "tracked_spend_usd": 4.2,
                        "updated_at_unix_ms": 9u64
                    }
                }),
            }));
        assert!(state
            .gateway
            .store
            .insert_lan_edit_event(&LanEditSyncEvent {
                event_id: "edit-valid-provider".to_string(),
                node_id: "node-remote".to_string(),
                node_name: "Remote Node".to_string(),
                created_at_unix_ms: 10,
                lamport_ts: 10,
                entity_type: "tracked_spend_day".to_string(),
                entity_id: tracked_spend_day_entity_id(
                    &shared_provider_id,
                    started_at_unix_ms,
                    "node-remote",
                ),
                op: "replace".to_string(),
                payload: serde_json::json!({
                    "provider_name": "provider_1",
                    "day_started_at_unix_ms": started_at_unix_ms,
                    "row": {
                        "provider": "provider_1",
                        "started_at_unix_ms": started_at_unix_ms,
                        "tracked_spend_usd": 17.47,
                        "updated_at_unix_ms": 10u64,
                        "producer_node_id": "node-remote",
                        "producer_node_name": "Remote Node"
                    }
                }),
            }));

        super::rebuild_shared_tracked_spend_views(&state).expect("rebuild shared view");

        let shared_rows = state
            .gateway
            .store
            .list_shared_tracked_spend_days("provider_1");
        assert_eq!(shared_rows.len(), 1);
        assert_eq!(
            shared_rows[0].get("day_key").and_then(Value::as_str),
            Some(day_key.as_str())
        );
        assert_eq!(
            shared_rows[0]
                .get("tracked_spend_usd")
                .and_then(Value::as_f64),
            Some(17.47)
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
                remote_update_updater_port: Some(4001),
                sent_at_unix_ms: 1,
                sequence: 0,
                sender_previous_gap_ms: None,
                sender_previous_elapsed_ms: None,
                capabilities: vec!["heartbeat_v1".to_string()],
                build_identity: super::current_build_identity(),
                remote_update_readiness: None,
                remote_update_status: None,
                sync_contracts: std::collections::BTreeMap::new(),
                provider_fingerprints: vec![],
                provider_definitions_revision: String::new(),
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
                remote_update_updater_port: Some(4001),
                last_heartbeat_unix_ms: now,
                capabilities: super::lan_heartbeat_capabilities(),
                version_inventory: super::local_version_inventory(),
                build_identity: super::current_build_identity(),
                remote_update_readiness: None,
                remote_update_status: None,
                sync_contracts: super::local_sync_contracts(),
                provider_fingerprints: vec!["fp-1".to_string()],
                provider_definitions_revision: String::new(),
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
                remote_update_updater_port: Some(4001),
                last_heartbeat_unix_ms: now,
                capabilities: vec!["heartbeat_v1".to_string()],
                version_inventory: vec!["heartbeat_v1".to_string()],
                build_identity: super::current_build_identity(),
                remote_update_readiness: None,
                remote_update_status: None,
                sync_contracts: std::collections::BTreeMap::new(),
                provider_fingerprints: vec!["fp-1".to_string()],
                provider_definitions_revision: String::new(),
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
    fn peer_stale_timeout_tolerates_transient_windows_heartbeat_gaps() {
        // Regression guard: LAN diagnostics showed the same peer being pruned after 7-10s
        // heartbeat gaps, then immediately rediscovered from the same listen address.
        assert!(!peer_is_stale(10_000, 20_000));
    }

    #[test]
    fn heartbeat_delivery_targets_include_known_peer_unicast_ips() {
        let runtime = LanSyncRuntime::new(LanNodeIdentity {
            node_id: "node-self".to_string(),
            node_name: "self".to_string(),
        });
        let now = crate::orchestrator::store::unix_ms();
        runtime.peers.write().insert(
            "node-live".to_string(),
            super::LanPeerRuntime {
                node_id: "node-live".to_string(),
                node_name: "peer-live".to_string(),
                listen_addr: "192.168.1.50:4000".to_string(),
                remote_update_updater_port: Some(4001),
                last_heartbeat_unix_ms: now,
                capabilities: super::lan_heartbeat_capabilities(),
                version_inventory: super::local_version_inventory(),
                build_identity: super::current_build_identity(),
                remote_update_readiness: None,
                remote_update_status: None,
                sync_contracts: super::local_sync_contracts(),
                provider_fingerprints: vec![],
                provider_definitions_revision: String::new(),
                followed_source_node_id: None,
            },
        );
        runtime.peers.write().insert(
            "node-stale".to_string(),
            super::LanPeerRuntime {
                node_id: "node-stale".to_string(),
                node_name: "peer-stale".to_string(),
                listen_addr: "192.168.1.51:4000".to_string(),
                remote_update_updater_port: Some(4001),
                last_heartbeat_unix_ms: now.saturating_sub(super::LAN_PEER_STALE_AFTER_MS + 1),
                capabilities: super::lan_heartbeat_capabilities(),
                version_inventory: super::local_version_inventory(),
                build_identity: super::current_build_identity(),
                remote_update_readiness: None,
                remote_update_status: None,
                sync_contracts: super::local_sync_contracts(),
                provider_fingerprints: vec![],
                provider_definitions_revision: String::new(),
                followed_source_node_id: None,
            },
        );

        let targets = runtime.heartbeat_delivery_targets(now);

        assert!(targets.contains(&std::net::SocketAddr::from((
            std::net::Ipv4Addr::BROADCAST,
            super::LAN_DISCOVERY_PORT
        ))));
        assert!(targets.contains(
            &format!("192.168.1.50:{}", super::LAN_DISCOVERY_PORT)
                .parse()
                .expect("live unicast target")
        ));
        assert!(!targets.contains(
            &format!("192.168.1.51:{}", super::LAN_DISCOVERY_PORT)
                .parse()
                .expect("stale unicast target")
        ));
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
    fn provider_pricing_quota_and_spend_events_apply_by_shared_provider_id() {
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

        let quota_event = crate::orchestrator::store::LanEditSyncEvent {
            event_id: "edit_test_quota".to_string(),
            node_id: "node-remote".to_string(),
            node_name: "remote".to_string(),
            created_at_unix_ms: 2,
            lamport_ts: 2,
            entity_type: "quota_snapshot".to_string(),
            entity_id: shared_provider_id.clone(),
            op: "replace".to_string(),
            payload: serde_json::json!({
                "provider_name": "provider_1",
                "snapshot": {
                    "kind": "budget_info",
                    "updated_at_unix_ms": 2222,
                    "remaining": null,
                    "today_used": null,
                    "today_added": null,
                    "daily_spent_usd": 17.47,
                    "daily_budget_usd": 200.0,
                    "weekly_spent_usd": null,
                    "weekly_budget_usd": null,
                    "monthly_spent_usd": null,
                    "monthly_budget_usd": null,
                    "package_expires_at_unix_ms": null,
                    "last_error": "",
                    "effective_usage_base": "https://example.com/v1",
                    "effective_usage_source": "remote"
                }
            }),
        };
        apply_lan_edit_event(&state.gateway, &state.config_path, &quota_event)
            .expect("apply quota");

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

        let tracked_spend_event = crate::orchestrator::store::LanEditSyncEvent {
            event_id: "edit_test_tracked_spend".to_string(),
            node_id: "node-remote".to_string(),
            node_name: "remote".to_string(),
            created_at_unix_ms: 4,
            lamport_ts: 4,
            entity_type: "tracked_spend_day".to_string(),
            entity_id: format!("{shared_provider_id}|1711929600000"),
            op: "replace".to_string(),
            payload: serde_json::json!({
                "provider_name": "provider_1",
                "day_started_at_unix_ms": 1711929600000u64,
                "row": {
                    "provider": "provider_1",
                    "api_key_ref": "sk-abc******wxyz",
                    "started_at_unix_ms": 1711929600000u64,
                    "ended_at_unix_ms": null,
                    "tracked_spend_usd": 17.47,
                    "last_seen_daily_spent_usd": 17.47,
                    "updated_at_unix_ms": 2222u64
                }
            }),
        };
        apply_lan_edit_event(&state.gateway, &state.config_path, &tracked_spend_event)
            .expect("apply tracked spend");

        let pricing = state.gateway.store.list_provider_pricing_configs();
        let provider_pricing = pricing.get("provider_1").expect("provider pricing");
        assert_eq!(provider_pricing.mode, "per_request");
        assert_eq!(provider_pricing.amount_usd, 0.035);
        assert_eq!(provider_pricing.periods.len(), 1);
        assert!(
            !state
                .secrets
                .list_provider_pricing()
                .contains_key("provider_1"),
            "remote pricing must not overwrite local provider pricing state"
        );

        let quota_snapshot = state
            .gateway
            .store
            .get_quota_snapshot("provider_1")
            .expect("quota snapshot");
        assert_eq!(
            quota_snapshot
                .get("daily_spent_usd")
                .and_then(|value| value.as_f64()),
            Some(17.47)
        );
        assert_eq!(
            quota_snapshot
                .get("updated_at_unix_ms")
                .and_then(|value| value.as_u64()),
            Some(2222)
        );
        assert_eq!(
            quota_snapshot
                .get("producer_node_id")
                .and_then(|value| value.as_str()),
            Some("node-remote")
        );
        assert_eq!(
            quota_snapshot
                .get("producer_node_name")
                .and_then(|value| value.as_str()),
            Some("remote")
        );
        assert_eq!(
            quota_snapshot
                .get("applied_from_node_id")
                .and_then(|value| value.as_str()),
            Some("node-remote")
        );
        assert_eq!(
            quota_snapshot
                .get("applied_from_node_name")
                .and_then(|value| value.as_str()),
            Some("remote")
        );
        assert!(
            quota_snapshot
                .get("applied_at_unix_ms")
                .and_then(|value| value.as_u64())
                .unwrap_or(0)
                > 0
        );

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

        let tracked_days = state.gateway.store.list_spend_days("provider_1");
        assert_eq!(tracked_days.len(), 2);
        let local_tracked_days = state.gateway.store.list_local_spend_days("provider_1");
        assert_eq!(local_tracked_days.len(), 1);
        assert_eq!(
            local_tracked_days[0]
                .get("tracked_spend_usd")
                .and_then(|value| value.as_f64()),
            Some(0.0)
        );
        let remote_tracked_days = state.gateway.store.list_remote_spend_days("provider_1");
        assert_eq!(remote_tracked_days.len(), 1);
        assert_eq!(
            remote_tracked_days[0]
                .get("tracked_spend_usd")
                .and_then(|value| value.as_f64()),
            Some(17.47)
        );
        assert_eq!(
            remote_tracked_days[0]
                .get("producer_node_id")
                .and_then(|value| value.as_str()),
            Some("node-remote")
        );
        assert_eq!(
            remote_tracked_days[0]
                .get("applied_from_node_id")
                .and_then(|value| value.as_str()),
            Some("node-remote")
        );
        assert!(
            state.gateway.store.get_spend_state("provider_1").is_some(),
            "remote quota observations should now advance the shared local tracking state"
        );
        assert_eq!(
            state
                .gateway
                .store
                .get_spend_state("provider_1")
                .and_then(|value| value.get("last_seen_daily_spent_usd").cloned())
                .and_then(|value| value.as_f64()),
            Some(17.47)
        );
    }

    #[test]
    fn tracked_spend_seed_relay_preserves_original_remote_producer() {
        let (_tmp, state) = build_test_state();
        let shared_provider_id = state
            .secrets
            .ensure_provider_shared_id("provider_1")
            .expect("shared id");
        let local_node_id = state.lan_sync.local_node_id();
        let local_node_name = state.lan_sync.local_node_name();
        let event = crate::orchestrator::store::LanEditSyncEvent {
            event_id: "seeded_remote_tracked_spend".to_string(),
            node_id: local_node_id.clone(),
            node_name: local_node_name.clone(),
            created_at_unix_ms: 5,
            lamport_ts: 5,
            entity_type: "tracked_spend_day".to_string(),
            entity_id: tracked_spend_day_entity_id(
                &shared_provider_id,
                1_711_929_600_000u64,
                "node-remote",
            ),
            op: "replace".to_string(),
            payload: serde_json::json!({
                "provider_name": "provider_1",
                "day_started_at_unix_ms": 1_711_929_600_000u64,
                "row": {
                    "provider": "provider_1",
                    "started_at_unix_ms": 1_711_929_600_000u64,
                    "tracked_spend_usd": 17.47,
                    "updated_at_unix_ms": 2222u64,
                    "producer_node_id": "node-remote",
                    "producer_node_name": "Remote Node"
                }
            }),
        };

        apply_lan_edit_event(&state.gateway, &state.config_path, &event)
            .expect("apply seeded tracked spend relay");

        let remote_tracked_days = state.gateway.store.list_remote_spend_days("provider_1");
        assert_eq!(remote_tracked_days.len(), 1);
        assert_eq!(
            remote_tracked_days[0]
                .get("producer_node_id")
                .and_then(|value| value.as_str()),
            Some("node-remote")
        );
        assert_eq!(
            remote_tracked_days[0]
                .get("producer_node_name")
                .and_then(|value| value.as_str()),
            Some("Remote Node")
        );
        assert_eq!(
            remote_tracked_days[0]
                .get("applied_from_node_id")
                .and_then(|value| value.as_str()),
            Some(local_node_id.as_str())
        );
        assert_eq!(
            remote_tracked_days[0]
                .get("applied_from_node_name")
                .and_then(|value| value.as_str()),
            Some(local_node_name.as_str())
        );
    }

    #[tokio::test]
    async fn forwarded_quota_refresh_events_are_scoped_to_provider_and_keep_node_ids_in_fields() {
        let (_tmp, state) = build_test_state();
        {
            let mut cfg = state.gateway.cfg.write();
            let provider = cfg.providers.get_mut("provider_1").expect("provider_1");
            provider.base_url = "https://provider1.mock.local/v1".to_string();
            provider.usage_base_url = Some("https://usage.provider1.mock.local/v1".to_string());
        }
        state
            .secrets
            .set_provider_key("provider_1", "sk-owner")
            .expect("set provider key");
        state
            .gateway
            .secrets
            .set_provider_key("provider_1", "sk-owner")
            .expect("set gateway provider key");
        let runtime = LanSyncRuntime::new(LanNodeIdentity {
            node_id: "node-owner".to_string(),
            node_name: "owner-box".to_string(),
        });
        let fingerprint = crate::orchestrator::quota::shared_provider_fingerprint(
            &state.gateway.cfg.read().clone(),
            &state.secrets,
            "provider_1",
        )
        .expect("shared fingerprint");
        *runtime.local_provider_fingerprints.write() = vec![fingerprint.clone()];
        state
            .secrets
            .set_lan_node_trusted("node-remote", true)
            .expect("trust requester");
        runtime.peers.write().insert(
            "node-remote".to_string(),
            super::LanPeerRuntime {
                node_id: "node-remote".to_string(),
                node_name: "remote-box".to_string(),
                listen_addr: "192.168.1.21:4000".to_string(),
                remote_update_updater_port: Some(4001),
                last_heartbeat_unix_ms: crate::orchestrator::store::unix_ms(),
                capabilities: vec!["heartbeat_v1".to_string()],
                version_inventory: vec!["heartbeat_v1".to_string()],
                build_identity: super::current_build_identity(),
                remote_update_readiness: None,
                remote_update_status: None,
                sync_contracts: std::collections::BTreeMap::new(),
                provider_fingerprints: vec![fingerprint.clone()],
                provider_definitions_revision: String::new(),
                followed_source_node_id: None,
            },
        );

        super::handle_quota_refresh_request(
            &runtime,
            &state.gateway,
            super::LanQuotaRefreshRequestPacket {
                version: 1,
                node_id: "node-remote".to_string(),
                shared_provider_fingerprint: fingerprint,
            },
        );

        tokio::time::sleep(std::time::Duration::from_millis(80)).await;

        let events = state.gateway.store.list_events_range(None, None, Some(20));
        let started = events
            .iter()
            .find(|event| {
                event.get("code").and_then(|value| value.as_str())
                    == Some("lan.quota_refresh_forwarded_started")
            })
            .expect("started event");
        assert_eq!(
            started.get("provider").and_then(|value| value.as_str()),
            Some("provider_1")
        );
        assert_eq!(
            started.get("message").and_then(|value| value.as_str()),
            Some("Shared usage refresh received from remote-box")
        );
        let fields = started.get("fields").expect("started fields");
        assert_eq!(
            fields
                .get("requester_node_id")
                .and_then(|value| value.as_str()),
            Some("node-remote")
        );
        assert_eq!(
            fields
                .get("requester_node_name")
                .and_then(|value| value.as_str()),
            Some("remote-box")
        );
    }

    #[tokio::test]
    async fn tracked_spend_history_debug_http_returns_matching_rows_and_events() {
        let (_tmp, state) = build_test_state();
        let trust_secret = state
            .secrets
            .ensure_lan_trust_secret()
            .expect("trust secret");
        state
            .secrets
            .set_lan_node_trusted("node-remote", true)
            .expect("trust remote");
        let local_node = state
            .secrets
            .get_lan_node_identity()
            .expect("local node identity");
        let shared_provider_id = state
            .secrets
            .ensure_provider_shared_id("provider_1")
            .expect("shared provider id");

        let local_row = serde_json::json!({
            "provider": "provider_1",
            "api_key_ref": "sk-local",
            "started_at_unix_ms": 1774976280809u64,
            "ended_at_unix_ms": 1774979880809u64,
            "updated_at_unix_ms": 1774979880900u64,
            "tracked_spend_usd": 17.4690825,
            "last_seen_daily_spent_usd": 17.4690825
        });
        let expected_day_key =
            super::tracked_spend_history_day_key_for_debug(&local_row).expect("local day key");
        state
            .gateway
            .store
            .put_spend_day("provider_1", 1774976280809u64, &local_row);
        let remote_row = serde_json::json!({
            "provider": "provider_1",
            "api_key_ref": "sk-remote",
            "started_at_unix_ms": 1774989680513u64,
            "ended_at_unix_ms": 1774993280513u64,
            "updated_at_unix_ms": 1774993280600u64,
            "tracked_spend_usd": 94.406078,
            "last_seen_daily_spent_usd": 94.406078
        });
        state.gateway.store.put_remote_spend_day(
            "provider_1",
            "node-syb",
            "SYB",
            1774989680513u64,
            &remote_row,
        );
        state
            .gateway
            .store
            .insert_lan_edit_event(&LanEditSyncEvent {
                event_id: "edit-replace".to_string(),
                node_id: "node-syb".to_string(),
                node_name: "SYB".to_string(),
                created_at_unix_ms: 10,
                lamport_ts: 10,
                entity_type: "tracked_spend_day".to_string(),
                entity_id: tracked_spend_day_entity_id(
                    &shared_provider_id,
                    1774989680513u64,
                    "node-syb",
                ),
                op: "replace".to_string(),
                payload: serde_json::json!({
                    "provider_name": "provider_1",
                    "day_started_at_unix_ms": 1774989680513u64
                }),
            });
        state
            .gateway
            .store
            .insert_lan_edit_event(&LanEditSyncEvent {
                event_id: "edit-delete".to_string(),
                node_id: local_node.node_id.clone(),
                node_name: local_node.node_name.clone(),
                created_at_unix_ms: 11,
                lamport_ts: 11,
                entity_type: "tracked_spend_day".to_string(),
                entity_id: tracked_spend_day_entity_id(
                    &shared_provider_id,
                    1774976280809u64,
                    &local_node.node_id,
                ),
                op: "delete".to_string(),
                payload: serde_json::json!({
                    "provider_name": "provider_1",
                    "day_started_at_unix_ms": 1774976280809u64
                }),
            });
        state.gateway.store.events().emit(
            "provider_1",
            crate::orchestrator::store::EventCode::USAGE_TRACKED_SPEND_HISTORY_ENTRIES_REMOVED,
            "tracked spend history entries removed",
            serde_json::json!({
                "day_key": expected_day_key,
                "removed": 2
            }),
        );

        let response = lan_sync_tracked_spend_history_debug_http(
            State(state.gateway.clone()),
            lan_sync_headers("node-remote", &trust_secret),
            Json(LanTrackedSpendHistoryDebugRequestPacket {
                version: 1,
                node_id: "node-remote".to_string(),
                provider: "provider_1".to_string(),
                day_key: expected_day_key.clone(),
                limit: 20,
            }),
        )
        .await
        .into_response();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("debug body");
        let payload: LanTrackedSpendHistoryDebugResponsePacket =
            serde_json::from_slice(&body).expect("debug json");
        assert_eq!(payload.provider, "provider_1");
        assert_eq!(payload.day_key, expected_day_key);
        assert_eq!(payload.local_rows.len(), 1);
        assert_eq!(payload.remote_rows.len(), 1);
        assert_eq!(payload.remote_rows[0].producer_node_id, "node-syb");
        assert_eq!(payload.recent_edit_events.len(), 2);
        assert_eq!(payload.recent_remove_events.len(), 1);
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
    fn tracked_spend_delete_event_removes_local_owner_row_when_source_matches_local_node() {
        let (_tmp, state) = build_test_state();
        super::register_gateway_status_runtime(state.lan_sync.clone());
        let local_node_id = super::current_local_node_identity()
            .map(|node| node.node_id)
            .unwrap_or_else(|| state.lan_sync.local_node_id());
        let shared_provider_id = state
            .secrets
            .ensure_provider_shared_id("provider_1")
            .expect("shared id");
        let day_started_at_unix_ms = 1_711_929_600_000u64;
        state.gateway.store.put_spend_day(
            "provider_1",
            day_started_at_unix_ms,
            &serde_json::json!({
                "provider": "provider_1",
                "started_at_unix_ms": day_started_at_unix_ms,
                "tracked_spend_usd": 17.47,
                "updated_at_unix_ms": day_started_at_unix_ms,
                "producer_node_id": state.lan_sync.local_node_id(),
                "producer_node_name": state.lan_sync.local_node_name()
            }),
        );
        let event = crate::orchestrator::store::LanEditSyncEvent {
            event_id: "edit_delete_local_owned_row".to_string(),
            node_id: local_node_id.clone(),
            node_name: "remote".to_string(),
            created_at_unix_ms: 5,
            lamport_ts: 5,
            entity_type: "tracked_spend_day".to_string(),
            entity_id: tracked_spend_day_entity_id(
                &shared_provider_id,
                day_started_at_unix_ms,
                &local_node_id,
            ),
            op: "delete".to_string(),
            payload: serde_json::json!({
                "provider_name": "provider_1",
                "day_started_at_unix_ms": day_started_at_unix_ms,
                "row": serde_json::Value::Null
            }),
        };

        apply_lan_edit_event(&state.gateway, &state.config_path, &event).expect("apply delete");

        assert!(
            state
                .gateway
                .store
                .get_spend_day("provider_1", day_started_at_unix_ms)
                .is_none(),
            "delete event should remove the local owner row when source node matches local node"
        );
    }

    #[test]
    fn tracked_spend_day_history_delete_event_removes_peer_only_stale_rows() {
        let (_tmp, state) = build_test_state();
        super::register_gateway_status_runtime(state.lan_sync.clone());
        let shared_provider_id = state
            .secrets
            .ensure_provider_shared_id("provider_1")
            .expect("shared id");
        let day_started_at_unix_ms = 1_711_929_600_000u64;
        state.gateway.store.put_remote_spend_day(
            "provider_1",
            &state.lan_sync.local_node_id(),
            &state.lan_sync.local_node_name(),
            day_started_at_unix_ms,
            &serde_json::json!({
                "provider": "provider_1",
                "started_at_unix_ms": day_started_at_unix_ms,
                "ended_at_unix_ms": day_started_at_unix_ms + 1000,
                "tracked_spend_usd": 17.47,
                "updated_at_unix_ms": day_started_at_unix_ms + 1000,
                "producer_node_id": state.lan_sync.local_node_id(),
                "producer_node_name": state.lan_sync.local_node_name()
            }),
        );
        let event = crate::orchestrator::store::LanEditSyncEvent {
            event_id: "edit_delete_history_day".to_string(),
            node_id: "node-remote".to_string(),
            node_name: "remote".to_string(),
            created_at_unix_ms: 6,
            lamport_ts: 6,
            entity_type: "tracked_spend_day_history_delete".to_string(),
            entity_id: format!("{shared_provider_id}|2024-04-01"),
            op: "delete".to_string(),
            payload: serde_json::json!({
                "provider_name": "provider_1",
                "day_key": "2024-04-01"
            }),
        };

        apply_lan_edit_event(&state.gateway, &state.config_path, &event).expect("apply delete");

        assert!(
            state.gateway.store.list_spend_days("provider_1").is_empty(),
            "day delete event should remove remote-table rows that only remain on the peer"
        );
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
