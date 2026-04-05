use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LanRemoteUpdateReadinessSnapshot {
    pub ready: bool,
    pub blocked_reason: Option<String>,
    #[serde(default)]
    pub checked_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LanRemoteUpdateTimelineEntry {
    #[serde(default)]
    pub unix_ms: u64,
    #[serde(default)]
    pub phase: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LanRemoteUpdateStatusSnapshot {
    pub state: String,
    pub target_ref: String,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub reason_code: Option<String>,
    #[serde(default)]
    pub requester_node_id: Option<String>,
    #[serde(default)]
    pub requester_node_name: Option<String>,
    #[serde(default)]
    pub worker_script: Option<String>,
    #[serde(default)]
    pub worker_pid: Option<u32>,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub accepted_at_unix_ms: u64,
    #[serde(default)]
    pub started_at_unix_ms: Option<u64>,
    #[serde(default)]
    pub finished_at_unix_ms: Option<u64>,
    #[serde(default)]
    pub updated_at_unix_ms: u64,
    #[serde(default)]
    pub timeline: Vec<LanRemoteUpdateTimelineEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LanRemoteUpdateRequestPacket {
    pub(crate) version: u8,
    pub(crate) node_id: String,
    #[serde(default)]
    pub(crate) node_name: Option<String>,
    pub(crate) target_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LanRemoteUpdateDebugRequestPacket {
    pub(crate) version: u8,
    pub(crate) node_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct LanRemoteUpdateDebugResponsePacket {
    pub ok: bool,
    pub version: u8,
    pub node_id: String,
    pub node_name: String,
    pub remote_update_readiness: LanRemoteUpdateReadinessSnapshot,
    pub remote_update_status: Option<LanRemoteUpdateStatusSnapshot>,
    pub status_path: Option<String>,
    pub status_file_exists: bool,
    pub log_path: Option<String>,
    pub log_file_exists: bool,
    pub log_tail: Option<String>,
    pub local_build_identity: LanBuildIdentitySnapshot,
    pub local_version_sync: LanLocalVersionSyncSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LanRemoteUpdateAcceptedPacket {
    accepted: bool,
    target_ref: String,
    worker_script: String,
    #[serde(default)]
    request_id: Option<String>,
}

fn lan_remote_update_status_path() -> Option<std::path::PathBuf> {
    let user_data_dir = std::env::var("API_ROUTER_USER_DATA_DIR").ok()?;
    let trimmed = user_data_dir.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(
        std::path::PathBuf::from(trimmed)
            .join("diagnostics")
            .join("lan-remote-update-status.json"),
    )
}

pub(crate) fn lan_remote_update_log_path() -> Option<std::path::PathBuf> {
    let user_data_dir = std::env::var("API_ROUTER_USER_DATA_DIR").ok()?;
    let trimmed = user_data_dir.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(
        std::path::PathBuf::from(trimmed)
            .join("diagnostics")
            .join("lan-remote-update.log"),
    )
}

fn read_lan_remote_update_status_raw() -> Option<LanRemoteUpdateStatusSnapshot> {
    let path = lan_remote_update_status_path()?;
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice::<LanRemoteUpdateStatusSnapshot>(&bytes).ok()
}

fn trim_remote_update_timeline(timeline: &mut Vec<LanRemoteUpdateTimelineEntry>) {
    const MAX_ENTRIES: usize = 24;
    if timeline.len() > MAX_ENTRIES {
        let remove_count = timeline.len().saturating_sub(MAX_ENTRIES);
        timeline.drain(0..remove_count);
    }
}

fn append_remote_update_timeline_entry(
    status: &mut LanRemoteUpdateStatusSnapshot,
    phase: &str,
    label: &str,
    detail: Option<String>,
    source: &str,
    unix_ms: u64,
) {
    let normalized_phase = phase.trim();
    let normalized_label = label.trim();
    let normalized_source = source.trim();
    let normalized_detail = detail
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let should_skip = status.timeline.last().is_some_and(|entry| {
        entry.phase == normalized_phase
            && entry.label == normalized_label
            && entry.detail == normalized_detail
            && entry.source == normalized_source
            && entry.state == status.state
    });
    if should_skip {
        return;
    }
    status.timeline.push(LanRemoteUpdateTimelineEntry {
        unix_ms,
        phase: normalized_phase.to_string(),
        label: normalized_label.to_string(),
        detail: normalized_detail,
        source: normalized_source.to_string(),
        state: status.state.clone(),
    });
    trim_remote_update_timeline(&mut status.timeline);
}

pub(crate) fn write_lan_remote_update_status(
    status: &LanRemoteUpdateStatusSnapshot,
) -> Result<(), String> {
    let Some(path) = lan_remote_update_status_path() else {
        return Err("API_ROUTER_USER_DATA_DIR is not set".to_string());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create remote update status dir: {err}"))?;
    }
    let bytes = serde_json::to_vec_pretty(status)
        .map_err(|err| format!("failed to serialize remote update status: {err}"))?;
    std::fs::write(&path, bytes)
        .map_err(|err| format!("failed to write remote update status: {err}"))?;
    Ok(())
}

fn write_lan_remote_update_status_with_timeline(
    status: &LanRemoteUpdateStatusSnapshot,
    phase: &str,
    label: &str,
    source: &str,
) -> Result<(), String> {
    let mut next = status.clone();
    if let Some(existing) = read_lan_remote_update_status_raw() {
        if next.request_id.is_some() && next.request_id == existing.request_id {
            next.timeline = existing.timeline;
        }
    }
    let entry_unix_ms = next
        .updated_at_unix_ms
        .max(next.finished_at_unix_ms.unwrap_or(0))
        .max(next.started_at_unix_ms.unwrap_or(0))
        .max(next.accepted_at_unix_ms);
    let timeline_detail = next.detail.clone();
    append_remote_update_timeline_entry(
        &mut next,
        phase,
        label,
        timeline_detail,
        source,
        entry_unix_ms,
    );
    write_lan_remote_update_status(&next)
}

pub(crate) fn display_target_ref(target_ref: &str) -> &str {
    let trimmed = target_ref.trim();
    if trimmed.len() > 8 {
        &trimmed[..8]
    } else {
        trimmed
    }
}

pub(crate) fn normalized_local_build_target_ref() -> Option<String> {
    let build_identity = current_build_identity();
    let target_ref = build_identity.build_git_sha.trim();
    (!target_ref.is_empty() && !target_ref.eq_ignore_ascii_case("unknown"))
        .then(|| target_ref.to_string())
}

pub(crate) fn local_version_sync_target_ref(
    version_sync: &LanLocalVersionSyncSnapshot,
) -> Result<&str, String> {
    let Some(target_ref) = version_sync.target_ref.as_deref() else {
        return Err(version_sync.blocked_reason.clone().unwrap_or_else(|| {
            "local build git sha is unknown; cannot coordinate same-version update".to_string()
        }));
    };
    if !version_sync.update_to_local_build_allowed {
        return Err(version_sync.blocked_reason.clone().unwrap_or_else(|| {
            "current machine cannot expose a safe build target for peer update".to_string()
        }));
    }
    Ok(target_ref)
}

fn remote_update_worker_is_alive(worker_pid: Option<u32>) -> bool {
    let Some(pid) = worker_pid.filter(|pid| *pid != 0) else {
        return false;
    };
    #[cfg(target_os = "windows")]
    {
        crate::platform::windows_loopback_peer::is_pid_alive(pid)
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .is_ok_and(|child| child.status.success())
    }
}

fn cleanup_remote_update_worker(worker_pid: Option<u32>) -> Option<String> {
    let pid = worker_pid?;
    match terminate_remote_update_worker(pid) {
        Ok(Some(true)) => Some(format!("Stopped stale remote update worker PID {pid}.")),
        Ok(Some(false)) => Some(format!("Remote update worker PID {pid} was already gone.")),
        Ok(None) => None,
        Err(err) => Some(format!(
            "Tried to stop stale remote update worker PID {pid}, but failed: {err}"
        )),
    }
}

fn terminate_remote_update_worker(pid: u32) -> Result<Option<bool>, String> {
    if pid == 0 {
        return Ok(None);
    }
    #[cfg(target_os = "windows")]
    {
        let output = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .map_err(|err| format!("taskkill failed: {err}"))?;
        if output.status.success() {
            return Ok(Some(true));
        }
        let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
        let stdout = String::from_utf8_lossy(&output.stdout).to_lowercase();
        if stderr.contains("not found")
            || stderr.contains("no running instance")
            || stdout.contains("not found")
            || stdout.contains("no running instance")
        {
            return Ok(Some(false));
        }
        Err(format!(
            "taskkill exited with {}: {}{}",
            output.status,
            stdout.trim(),
            if stderr.trim().is_empty() {
                String::new()
            } else {
                format!(" {}", stderr.trim())
            }
        ))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let output = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output()
            .map_err(|err| format!("kill failed: {err}"))?;
        if output.status.success() {
            return Ok(Some(true));
        }
        let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
        if stderr.contains("no such process") {
            return Ok(Some(false));
        }
        Err(format!(
            "kill exited with {}: {}",
            output.status,
            stderr.trim()
        ))
    }
}

fn normalize_remote_update_status(
    mut status: LanRemoteUpdateStatusSnapshot,
) -> LanRemoteUpdateStatusSnapshot {
    let current_target_ref = normalized_local_build_target_ref();
    let status_target_ref = status.target_ref.trim();
    let state = status.state.trim();
    if !matches!(state, "accepted" | "running") {
        return status;
    }

    let now_unix_ms = unix_ms();
    if remote_update_worker_is_alive(status.worker_pid) {
        return status;
    }
    if state == "accepted" && status.started_at_unix_ms.is_none() {
        let freshness_unix_ms = status.updated_at_unix_ms.max(status.accepted_at_unix_ms);
        if now_unix_ms.saturating_sub(freshness_unix_ms)
            < LAN_REMOTE_UPDATE_ACCEPTED_STARTUP_GRACE_MS
        {
            return status;
        }
    }

    let Some(current_target_ref) = current_target_ref.as_deref() else {
        return status;
    };

    let worker_cleanup_detail = cleanup_remote_update_worker(status.worker_pid);
    let finished_at_unix_ms = unix_ms();

    if current_target_ref == status_target_ref {
        status.state = "succeeded".to_string();
        status.reason_code = Some("peer_already_matches_target".to_string());
        status.detail = Some(match worker_cleanup_detail {
            Some(detail) => format!(
                "Current build already matches the queued target; cleared stale remote update status after restart/manual update. {detail}"
            ),
            None => "Current build already matches the queued target; cleared stale remote update status after restart/manual update."
                .to_string(),
        });
        status
            .finished_at_unix_ms
            .get_or_insert(finished_at_unix_ms);
        status.updated_at_unix_ms = finished_at_unix_ms;
        let timeline_detail = status.detail.clone();
        append_remote_update_timeline_entry(
            &mut status,
            "normalized_succeeded",
            "Status normalized to succeeded",
            timeline_detail,
            "normalizer",
            finished_at_unix_ms,
        );
        return status;
    }

    let (reason_code, label, detail) = if state == "accepted" && status.started_at_unix_ms.is_none()
    {
        (
            "peer_build_changed_before_start",
            "Status normalized to expired before start",
            match worker_cleanup_detail {
                Some(detail) => format!(
                    "Queued remote update to {} never started; peer is currently on build {}. {detail}",
                    display_target_ref(status_target_ref),
                    display_target_ref(current_target_ref),
                ),
                None => format!(
                    "Queued remote update to {} never started; peer is currently on build {}.",
                    display_target_ref(status_target_ref),
                    display_target_ref(current_target_ref),
                ),
            },
        )
    } else {
        (
            "peer_build_changed_after_start",
            "Status normalized to replaced after start",
            match worker_cleanup_detail {
                Some(detail) => format!(
                    "Queued remote update to {} stopped after the peer changed to build {}. {detail}",
                    display_target_ref(status_target_ref),
                    display_target_ref(current_target_ref),
                ),
                None => format!(
                    "Queued remote update to {} stopped after the peer changed to build {}.",
                    display_target_ref(status_target_ref),
                    display_target_ref(current_target_ref),
                ),
            },
        )
    };
    status.state = "superseded".to_string();
    status.reason_code = Some(reason_code.to_string());
    status.detail = Some(detail);
    status
        .finished_at_unix_ms
        .get_or_insert(finished_at_unix_ms);
    status.updated_at_unix_ms = finished_at_unix_ms;
    let timeline_detail = status.detail.clone();
    append_remote_update_timeline_entry(
        &mut status,
        "normalized_superseded",
        label,
        timeline_detail,
        "normalizer",
        finished_at_unix_ms,
    );
    status
}

pub(crate) fn load_lan_remote_update_status() -> Option<LanRemoteUpdateStatusSnapshot> {
    let path = lan_remote_update_status_path()?;
    let bytes = std::fs::read(path).ok()?;
    let status = serde_json::from_slice::<LanRemoteUpdateStatusSnapshot>(&bytes).ok()?;
    let normalized = normalize_remote_update_status(status.clone());
    if normalized != status {
        let _ = write_lan_remote_update_status(&normalized);
    }
    Some(normalized)
}

pub(crate) fn load_lan_remote_update_status_public() -> Option<LanRemoteUpdateStatusSnapshot> {
    load_lan_remote_update_status()
}

fn read_remote_update_log_tail(max_bytes: usize) -> Option<String> {
    let path = lan_remote_update_log_path()?;
    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() {
        return None;
    }
    let start = bytes.len().saturating_sub(max_bytes.max(1));
    let text = String::from_utf8_lossy(&bytes[start..]).to_string();
    let trimmed = text.trim().to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

fn remote_update_status_blocks_new_request(status: &LanRemoteUpdateStatusSnapshot) -> bool {
    matches!(status.state.as_str(), "accepted" | "running")
}

fn current_remote_update_status_block_reason() -> Option<String> {
    let status = load_lan_remote_update_status()?;
    if !remote_update_status_blocks_new_request(&status) {
        return None;
    }
    let target_ref = display_target_ref(status.target_ref.trim());
    let detail = status.detail.as_deref().unwrap_or_default().trim();
    Some(if detail.is_empty() {
        format!(
            "This machine is already processing a remote update to {target_ref}. Wait for it to finish before sending another request."
        )
    } else {
        format!("This machine is already processing a remote update to {target_ref}: {detail}")
    })
}

fn remote_update_request_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

pub(crate) fn compute_local_remote_update_readiness() -> LanRemoteUpdateReadinessSnapshot {
    let checked_at_unix_ms = unix_ms();
    if let Some(reason) = current_remote_update_status_block_reason() {
        return LanRemoteUpdateReadinessSnapshot {
            ready: false,
            blocked_reason: Some(reason),
            checked_at_unix_ms,
        };
    }
    let repo_root = match resolve_repo_root_for_self_update() {
        Ok(repo_root) => repo_root,
        Err(err) => {
            return LanRemoteUpdateReadinessSnapshot {
                ready: false,
                blocked_reason: Some(format!(
                    "This machine cannot resolve the repo root needed for remote update: {err}"
                )),
                checked_at_unix_ms,
            };
        }
    };
    match probe_git_worktree_clean(&repo_root) {
        Ok(true) => LanRemoteUpdateReadinessSnapshot {
            ready: true,
            blocked_reason: None,
            checked_at_unix_ms,
        },
        Ok(false) => LanRemoteUpdateReadinessSnapshot {
            ready: false,
            blocked_reason: Some(
                "This machine's git worktree is dirty. Commit or stash local changes there before remote update can run."
                    .to_string(),
            ),
            checked_at_unix_ms,
        },
        Err(err) => LanRemoteUpdateReadinessSnapshot {
            ready: false,
            blocked_reason: Some(format!(
                "This machine cannot verify its git worktree for remote update: {err}"
            )),
            checked_at_unix_ms,
        },
    }
}

pub(crate) fn current_local_remote_update_readiness() -> LanRemoteUpdateReadinessSnapshot {
    static CACHE: OnceLock<RwLock<Option<(u64, LanRemoteUpdateReadinessSnapshot)>>> =
        OnceLock::new();
    let cache = CACHE.get_or_init(|| RwLock::new(None));
    let now = unix_ms();
    if let Some((captured_at, snapshot)) = cache.read().clone() {
        if now.saturating_sub(captured_at) < 30_000 {
            return snapshot;
        }
    }
    let snapshot = compute_local_remote_update_readiness();
    *cache.write() = Some((now, snapshot.clone()));
    snapshot
}

pub(crate) fn peer_remote_update_blocked_reason(peer: &LanPeerSnapshot) -> Option<String> {
    let peer_advertises_remote_update = peer_supports_http_sync(peer, LAN_REMOTE_UPDATE_CAPABILITY)
        || peer.remote_update_readiness.is_some();
    if !peer_advertises_remote_update {
        return Some(format!(
            "{} does not support remote update yet. Update that machine manually first.",
            peer.node_name
        ));
    }
    let readiness = peer.remote_update_readiness.as_ref()?;
    if readiness.ready {
        return None;
    }
    Some(
        readiness.blocked_reason.clone().unwrap_or_else(|| {
            format!("{} is not ready to run remote update yet.", peer.node_name)
        }),
    )
}

impl LanSyncRuntime {
    pub async fn request_peer_remote_update(
        &self,
        gateway: &crate::orchestrator::gateway::GatewayState,
        node_id: &str,
        target_ref: &str,
    ) -> Result<(), String> {
        let normalized_node_id = node_id.trim();
        if normalized_node_id.is_empty() {
            return Err("node_id is required".to_string());
        }
        let normalized_target_ref = target_ref.trim();
        if normalized_target_ref.is_empty() {
            return Err("target_ref is required".to_string());
        }
        let peer = self
            .live_peer_by_node_id(normalized_node_id)
            .ok_or_else(|| format!("peer is not reachable on LAN: {normalized_node_id}"))?;
        if let Some(reason) = peer_remote_update_blocked_reason(&peer) {
            return Err(reason);
        }
        let base_url = peer_http_base_url(&peer)
            .ok_or_else(|| format!("peer has no valid LAN address: {normalized_node_id}"))?;
        let trust_secret = current_lan_trust_secret(gateway)?;
        let response = lan_sync_http_client()
            .post(format!("{base_url}/lan-sync/remote-update"))
            .header(
                LAN_SYNC_AUTH_NODE_ID_HEADER,
                self.local_node.node_id.clone(),
            )
            .header(LAN_SYNC_AUTH_SECRET_HEADER, trust_secret)
            .json(&LanRemoteUpdateRequestPacket {
                version: 1,
                node_id: self.local_node.node_id.clone(),
                node_name: Some(self.local_node.node_name.clone()),
                target_ref: normalized_target_ref.to_string(),
            })
            .send()
            .await
            .map_err(|err| format!("remote update request failed: {err}"))?;
        if !response.status().is_success() {
            let detail = response
                .text()
                .await
                .unwrap_or_else(|_| "unknown remote update error".to_string());
            return Err(format!(
                "remote update request rejected by {}: {detail}",
                peer.node_name
            ));
        }
        let accepted = response
            .json::<LanRemoteUpdateAcceptedPacket>()
            .await
            .map_err(|err| format!("remote update response decode failed: {err}"))?;
        let display_target_ref = display_target_ref(normalized_target_ref);
        gateway.store.add_event(
            "gateway",
            "info",
            "lan.remote_update_requested",
            &format!(
                "Requested {} to self-update to {display_target_ref}",
                peer.node_name
            ),
            serde_json::json!({
                "request_id": accepted.request_id,
                "peer_node_id": peer.node_id,
                "peer_node_name": peer.node_name,
                "target_ref": normalized_target_ref,
                "worker_script": accepted.worker_script,
            }),
        );
        Ok(())
    }

    pub async fn request_peer_remote_update_to_local_build(
        &self,
        gateway: &crate::orchestrator::gateway::GatewayState,
        node_id: &str,
    ) -> Result<(), String> {
        let version_sync = current_local_version_sync_snapshot();
        let target_ref = local_version_sync_target_ref(&version_sync)?;
        self.request_peer_remote_update(gateway, node_id, target_ref)
            .await
    }

    pub async fn fetch_peer_remote_update_debug(
        &self,
        gateway: &crate::orchestrator::gateway::GatewayState,
        node_id: &str,
    ) -> Result<LanRemoteUpdateDebugResponsePacket, String> {
        let normalized_node_id = node_id.trim();
        if normalized_node_id.is_empty() {
            return Err("node_id is required".to_string());
        }
        let peer = self
            .live_peer_by_node_id(normalized_node_id)
            .ok_or_else(|| format!("peer is not reachable on LAN: {normalized_node_id}"))?;
        let base_url = peer_http_base_url(&peer)
            .ok_or_else(|| format!("peer has no valid LAN address: {normalized_node_id}"))?;
        let trust_secret = current_lan_trust_secret(gateway)?;
        let response = lan_sync_http_client()
            .post(format!("{base_url}/lan-sync/debug/remote-update"))
            .header(
                LAN_SYNC_AUTH_NODE_ID_HEADER,
                self.local_node.node_id.clone(),
            )
            .header(LAN_SYNC_AUTH_SECRET_HEADER, trust_secret)
            .json(&LanRemoteUpdateDebugRequestPacket {
                version: 1,
                node_id: self.local_node.node_id.clone(),
            })
            .send()
            .await
            .map_err(|err| {
                let detail = format_lan_sync_reqwest_error(&err);
                self.note_http_sync_probe(
                    &peer,
                    "/lan-sync/debug/remote-update",
                    "request_error",
                    &detail,
                );
                format!("LAN remote update debug request failed: {detail}")
            })?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            if status == reqwest::StatusCode::NOT_FOUND {
                let detail = if peer.build_identity == current_build_identity() {
                    format!(
                        "{} is still running a process without LAN remote update debug. Restart that machine and wait for a fresh heartbeat.",
                        peer.node_name
                    )
                } else {
                    format!(
                        "{} does not expose LAN remote update debug yet. Update and restart that machine first.",
                        peer.node_name
                    )
                };
                self.note_http_sync_probe(
                    &peer,
                    "/lan-sync/debug/remote-update",
                    "http_error",
                    &detail,
                );
                return Err(detail);
            }
            let detail = format!("LAN remote update debug http {status}: {body}");
            self.note_http_sync_probe(
                &peer,
                "/lan-sync/debug/remote-update",
                "http_error",
                &detail,
            );
            return Err(detail);
        }
        let packet = response
            .json::<LanRemoteUpdateDebugResponsePacket>()
            .await
            .map_err(|err| {
                let detail = format_lan_sync_reqwest_error(&err);
                self.note_http_sync_probe(
                    &peer,
                    "/lan-sync/debug/remote-update",
                    "decode_error",
                    &detail,
                );
                format!("LAN remote update debug response decode failed: {detail}")
            })?;
        let _ =
            self.note_http_sync_probe(&peer, "/lan-sync/debug/remote-update", "ok", "HTTP sync ok");
        Ok(packet)
    }
}

pub(crate) async fn lan_sync_remote_update_http(
    State(gateway): State<crate::orchestrator::gateway::GatewayState>,
    headers: HeaderMap,
    Json(packet): Json<LanRemoteUpdateRequestPacket>,
) -> impl IntoResponse {
    if let Err(err) = authorize_lan_sync_http_request(&gateway, &headers, &packet.node_id) {
        return err.into_response();
    }
    let normalized_target_ref = packet.target_ref.trim();
    if normalized_target_ref.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "ok": false,
                "error": "target_ref is required",
            })),
        )
            .into_response();
    }
    let _request_lock = remote_update_request_lock()
        .lock()
        .expect("remote update request mutex poisoned");
    if let Some(reason) = current_remote_update_status_block_reason() {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "ok": false,
                "error": reason,
            })),
        )
            .into_response();
    }
    let accepted_at_unix_ms = unix_ms();
    let request_id = format!("ru_{}", uuid::Uuid::new_v4().simple());
    let accepted_status = LanRemoteUpdateStatusSnapshot {
        state: "accepted".to_string(),
        target_ref: normalized_target_ref.to_string(),
        request_id: Some(request_id.clone()),
        reason_code: Some("request_accepted".to_string()),
        requester_node_id: Some(packet.node_id.clone()),
        requester_node_name: packet
            .node_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string),
        worker_script: None,
        worker_pid: None,
        detail: Some("Queued remote self-update worker".to_string()),
        accepted_at_unix_ms,
        started_at_unix_ms: None,
        finished_at_unix_ms: None,
        updated_at_unix_ms: accepted_at_unix_ms,
        timeline: Vec::new(),
    };
    if let Err(err) = write_lan_remote_update_status_with_timeline(
        &accepted_status,
        "request_accepted",
        "Remote update request accepted",
        "http",
    ) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "ok": false,
                "error": err,
            })),
        )
            .into_response();
    }
    match spawn_remote_update_worker(
        normalized_target_ref,
        &request_id,
        &packet.node_id,
        packet.node_name.as_deref(),
    ) {
        Ok((worker_script, worker_pid)) => {
            let display_target_ref = display_target_ref(normalized_target_ref);
            let _ = write_lan_remote_update_status_with_timeline(
                &LanRemoteUpdateStatusSnapshot {
                    worker_script: Some(worker_script.clone()),
                    worker_pid: Some(worker_pid),
                    detail: Some("Remote self-update worker started".to_string()),
                    reason_code: Some("worker_spawned".to_string()),
                    ..accepted_status
                },
                "worker_spawned",
                "Remote update worker spawned",
                "http",
            );
            gateway.store.add_event(
                "gateway",
                "warning",
                "lan.remote_update_accepted",
                &format!(
                    "Accepted remote update request to {display_target_ref}; local self-update worker started"
                ),
                serde_json::json!({
                    "request_id": request_id,
                    "requester_node_id": packet.node_id,
                    "target_ref": normalized_target_ref,
                    "worker_script": worker_script,
                    "worker_pid": worker_pid,
                }),
            );
            (
                StatusCode::ACCEPTED,
                Json(serde_json::json!(LanRemoteUpdateAcceptedPacket {
                    accepted: true,
                    target_ref: normalized_target_ref.to_string(),
                    worker_script,
                    request_id: Some(request_id),
                })),
            )
                .into_response()
        }
        Err(err) => {
            let failed_at_unix_ms = unix_ms();
            let _ = write_lan_remote_update_status_with_timeline(
                &LanRemoteUpdateStatusSnapshot {
                    state: "failed".to_string(),
                    reason_code: Some("worker_spawn_failed".to_string()),
                    detail: Some(err.clone()),
                    finished_at_unix_ms: Some(failed_at_unix_ms),
                    updated_at_unix_ms: failed_at_unix_ms,
                    ..accepted_status
                },
                "worker_spawn_failed",
                "Remote update worker failed to start",
                "http",
            );
            (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "ok": false,
                    "error": err,
                })),
            )
                .into_response()
        }
    }
}

pub(crate) async fn lan_sync_remote_update_debug_http(
    State(gateway): State<crate::orchestrator::gateway::GatewayState>,
    headers: HeaderMap,
    Json(packet): Json<LanRemoteUpdateDebugRequestPacket>,
) -> impl IntoResponse {
    if let Err(err) = authorize_lan_sync_http_request(&gateway, &headers, &packet.node_id) {
        return err.into_response();
    }
    let node = gateway.secrets.get_lan_node_identity();
    let status_path = lan_remote_update_status_path();
    let log_path = lan_remote_update_log_path();
    Json(serde_json::json!(LanRemoteUpdateDebugResponsePacket {
        ok: true,
        version: 1,
        node_id: node
            .as_ref()
            .map(|value| value.node_id.clone())
            .unwrap_or_default(),
        node_name: node
            .as_ref()
            .map(|value| value.node_name.clone())
            .unwrap_or_default(),
        remote_update_readiness: current_local_remote_update_readiness(),
        remote_update_status: load_lan_remote_update_status(),
        status_file_exists: status_path.as_ref().is_some_and(|path| path.is_file()),
        status_path: status_path.map(|path| path.display().to_string()),
        log_file_exists: log_path.as_ref().is_some_and(|path| path.is_file()),
        log_path: log_path.map(|path| path.display().to_string()),
        log_tail: read_remote_update_log_tail(6_000),
        local_build_identity: current_build_identity(),
        local_version_sync: current_local_version_sync_snapshot(),
    }))
    .into_response()
}

pub(crate) fn build_remote_update_worker_command(
    target_ref: &str,
) -> Result<(String, Vec<String>, String), String> {
    let normalized_target_ref = target_ref.trim();
    if normalized_target_ref.is_empty() {
        return Err("target_ref is required".to_string());
    }
    let repo_root = resolve_repo_root_for_self_update()?;
    #[cfg(target_os = "windows")]
    {
        let script = repo_root
            .join("src-tauri")
            .join("src")
            .join("lan_sync")
            .join("remote_update")
            .join("lan-remote-update.ps1");
        if !script.is_file() {
            return Err(format!(
                "missing remote update script: {}",
                script.display()
            ));
        }
        let args = vec![
            "-NoProfile".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
            "-File".to_string(),
            script.display().to_string(),
            "-TargetRef".to_string(),
            normalized_target_ref.to_string(),
        ];
        Ok((
            "powershell.exe".to_string(),
            args,
            script.display().to_string(),
        ))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let script = repo_root
            .join("src-tauri")
            .join("src")
            .join("lan_sync")
            .join("remote_update")
            .join("lan-remote-update.sh");
        if !script.is_file() {
            return Err(format!(
                "missing remote update script: {}",
                script.display()
            ));
        }
        let args = vec![
            script.display().to_string(),
            normalized_target_ref.to_string(),
        ];
        Ok(("bash".to_string(), args, script.display().to_string()))
    }
}

fn spawn_remote_update_worker(
    target_ref: &str,
    request_id: &str,
    requester_node_id: &str,
    requester_node_name: Option<&str>,
) -> Result<(String, u32), String> {
    let (program, args, script) = build_remote_update_worker_command(target_ref)?;
    let repo_root = resolve_repo_root_for_self_update()?;
    let status_path = lan_remote_update_status_path();
    let mut command = std::process::Command::new(program);
    command.args(args).current_dir(repo_root);
    if let Some(path) = status_path {
        command.env("API_ROUTER_REMOTE_UPDATE_STATUS_PATH", path);
    }
    if let Some(path) = lan_remote_update_log_path() {
        command.env("API_ROUTER_REMOTE_UPDATE_LOG_PATH", path);
    }
    command.env("API_ROUTER_REMOTE_UPDATE_TARGET_REF", target_ref);
    command.env("API_ROUTER_REMOTE_UPDATE_REQUEST_ID", request_id);
    command.env(
        "API_ROUTER_REMOTE_UPDATE_REQUESTER_NODE_ID",
        requester_node_id,
    );
    if let Some(name) = requester_node_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        command.env("API_ROUTER_REMOTE_UPDATE_REQUESTER_NODE_NAME", name);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0000_0008 | 0x0000_0200);
    }
    let child = command
        .spawn()
        .map_err(|err| format!("failed to start remote update worker: {err}"))?;
    Ok((script, child.id()))
}
