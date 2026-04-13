use super::*;
use chrono::{Datelike, Local, TimeZone, Timelike};
use std::process::Stdio;

#[cfg(test)]
thread_local! {
    static TEST_REPO_ROOT_OVERRIDE: std::cell::RefCell<Option<std::path::PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn set_test_user_data_dir_override(
    value: Option<&std::path::Path>,
) -> Option<std::path::PathBuf> {
    crate::diagnostics::set_test_user_data_dir_override(value)
}

#[cfg(test)]
pub(crate) fn set_test_repo_root_override(
    value: Option<&std::path::Path>,
) -> Option<std::path::PathBuf> {
    TEST_REPO_ROOT_OVERRIDE.with(|cell| {
        let previous = cell.borrow().clone();
        *cell.borrow_mut() = value.map(|path| path.to_path_buf());
        previous
    })
}

#[cfg(test)]
pub(crate) fn test_repo_root_override() -> Option<std::path::PathBuf> {
    TEST_REPO_ROOT_OVERRIDE.with(|cell| cell.borrow().clone())
}

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
    pub worker_exit_code: Option<i32>,
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
    #[serde(default = "default_remote_update_log_tail_source")]
    pub log_tail_source: String,
    pub log_tail: Option<String>,
    #[serde(default)]
    pub shell_log_path: Option<String>,
    #[serde(default)]
    pub shell_log_file_exists: bool,
    #[serde(default)]
    pub shell_log_tail: Option<String>,
    #[serde(default)]
    pub worker_bootstrap_observed: bool,
    pub worker_script_probe: Option<LanRemoteUpdateWorkerScriptProbe>,
    pub local_build_identity: LanBuildIdentitySnapshot,
    pub local_version_sync: LanLocalVersionSyncSnapshot,
}

fn default_remote_update_log_tail_source() -> String {
    "none".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct LanRemoteUpdateWorkerScriptProbe {
    pub path: String,
    pub exists: bool,
    #[serde(default)]
    pub modified_at_unix_ms: Option<u64>,
    #[serde(default)]
    pub size_bytes: Option<u64>,
    pub bootstrap_marker_present: bool,
    pub no_tag_fetch_present: bool,
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
    crate::diagnostics::diagnostics_file_path("lan-remote-update-status.json")
}

pub(crate) fn lan_remote_update_log_path() -> Option<std::path::PathBuf> {
    crate::diagnostics::diagnostics_file_path("lan-remote-update.log")
}

fn append_remote_update_log_message(message: &str) {
    let Some(path) = lan_remote_update_log_path() else {
        return;
    };
    let _ = crate::diagnostics::append_timestamped_log_line(&path, message);
}

fn reset_remote_update_log() {
    let Some(path) = lan_remote_update_log_path() else {
        return;
    };
    let _ = crate::diagnostics::ensure_parent_dir(&path);
    let _ = std::fs::write(path, "");
}

fn remote_update_shell_window_log_path() -> Option<std::path::PathBuf> {
    crate::diagnostics::diagnostics_file_path("lan-remote-update-shell.log")
}

#[cfg(target_os = "windows")]
fn append_remote_update_shell_window_log(message: &str) {
    let Some(path) = remote_update_shell_window_log_path() else {
        return;
    };
    let _ = crate::diagnostics::append_timestamped_log_line_capped(&path, message, 64 * 1024);
}

#[cfg(any(test, target_os = "windows"))]
struct RemoteUpdateShellProcessContext<'a> {
    worker_pid: u32,
    request_id: &'a str,
    repo_root: &'a std::path::Path,
    status_path: Option<&'a std::path::Path>,
    log_path: Option<&'a std::path::Path>,
}

#[cfg(any(test, target_os = "windows"))]
struct RemoteUpdateShellProcessEvidence<'a> {
    pid: u32,
    command_line: &'a str,
    cwd: Option<&'a std::path::Path>,
    status_env: &'a str,
    log_env: &'a str,
    request_id_env: &'a str,
}

#[cfg(target_os = "windows")]
fn remote_update_global_visible_window_key(
    window: &crate::platform::windows_loopback_peer::VisibleWindowSnapshot,
) -> String {
    format!(
        "{}|{}|{}|{}",
        window.hwnd,
        window.pid,
        window.title.trim(),
        window.class_name.trim()
    )
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
struct RemoteUpdateWorkerMonitorContext {
    repo_root: std::path::PathBuf,
    status_path: Option<std::path::PathBuf>,
    log_path: Option<std::path::PathBuf>,
}

#[cfg(any(test, target_os = "windows"))]
fn remote_update_text_contains_repo_marker(value: &str, repo_root: &std::path::Path) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return false;
    }
    let repo_marker = repo_root.display().to_string().to_ascii_lowercase();
    normalized.contains(&repo_marker)
        || normalized.contains("lan-remote-update.ps1")
        || normalized.contains("lan-remote-update.sh")
        || normalized.contains("build-root-exe.ps1")
        || normalized.contains("build-root-exe.mjs")
        || normalized.contains("api_router_remote_update_request_id")
}

#[cfg(any(test, target_os = "windows"))]
fn remote_update_shell_process_is_relevant(
    context: &RemoteUpdateShellProcessContext<'_>,
    evidence: &RemoteUpdateShellProcessEvidence<'_>,
) -> bool {
    if evidence.pid == context.worker_pid {
        return true;
    }
    if !context.request_id.trim().is_empty()
        && evidence.request_id_env.trim() == context.request_id.trim()
    {
        return true;
    }
    if remote_update_text_contains_repo_marker(evidence.command_line, context.repo_root) {
        return true;
    }
    if evidence
        .cwd
        .is_some_and(|value| value.starts_with(context.repo_root))
    {
        return true;
    }
    if context.status_path.is_some_and(|path| {
        evidence
            .status_env
            .trim()
            .eq_ignore_ascii_case(&path.display().to_string())
    }) {
        return true;
    }
    context.log_path.is_some_and(|path| {
        evidence
            .log_env
            .trim()
            .eq_ignore_ascii_case(&path.display().to_string())
    })
}

fn read_lan_remote_update_status_raw() -> Option<LanRemoteUpdateStatusSnapshot> {
    let path = lan_remote_update_status_path()?;
    let bytes = std::fs::read(path).ok()?;
    parse_lan_remote_update_status_bytes(&bytes).ok()
}

fn parse_lan_remote_update_status_bytes(
    bytes: &[u8],
) -> Result<LanRemoteUpdateStatusSnapshot, serde_json::Error> {
    const UTF8_BOM: &[u8; 3] = b"\xEF\xBB\xBF";
    let trimmed = if bytes.starts_with(UTF8_BOM) {
        &bytes[UTF8_BOM.len()..]
    } else {
        bytes
    };
    serde_json::from_slice::<LanRemoteUpdateStatusSnapshot>(trimmed)
}

fn remote_update_worker_bootstrap_observed(status: &LanRemoteUpdateStatusSnapshot) -> bool {
    status
        .timeline
        .iter()
        .any(|entry| entry.source.trim() == "worker")
}

fn probe_remote_update_worker_script() -> Option<LanRemoteUpdateWorkerScriptProbe> {
    let repo_root = resolve_repo_root_for_self_update().ok()?;
    #[cfg(target_os = "windows")]
    let script_path = repo_root
        .join("src-tauri")
        .join("src")
        .join("lan_sync")
        .join("remote_update")
        .join("lan-remote-update.ps1");
    #[cfg(not(target_os = "windows"))]
    let script_path = repo_root
        .join("src-tauri")
        .join("src")
        .join("lan_sync")
        .join("remote_update")
        .join("lan-remote-update.sh");

    let exists = script_path.is_file();
    let metadata = std::fs::metadata(&script_path).ok();
    let modified_at_unix_ms = metadata
        .as_ref()
        .and_then(|value| value.modified().ok())
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64);
    let size_bytes = metadata.as_ref().map(|value| value.len());
    let script_text = std::fs::read_to_string(&script_path).ok();
    let bootstrap_marker_present = script_text.as_ref().is_some_and(|value| {
        value.contains("Bootstrapping remote self-update worker.")
            && value.contains("Phase 'bootstrap'")
    });
    let no_tag_fetch_present = script_text
        .as_ref()
        .is_some_and(|value| value.contains("git fetch origin --prune"));
    Some(LanRemoteUpdateWorkerScriptProbe {
        path: script_path.display().to_string(),
        exists,
        modified_at_unix_ms,
        size_bytes,
        bootstrap_marker_present,
        no_tag_fetch_present: no_tag_fetch_present
            && !script_text
                .as_ref()
                .is_some_and(|value| value.contains("git fetch origin --prune --tags")),
    })
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
    let state = status.state.trim().to_string();
    if !matches!(state.as_str(), "accepted" | "running" | "failed") {
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
        status.reason_code = Some(if state == "failed" {
            "peer_already_matches_target_after_failed_status".to_string()
        } else {
            "peer_already_matches_target".to_string()
        });
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
                    "Queued remote update to {} never started before the peer build changed. {detail}",
                    display_target_ref(status_target_ref),
                ),
                None => format!(
                    "Queued remote update to {} never started before the peer build changed.",
                    display_target_ref(status_target_ref),
                ),
            },
        )
    } else {
        (
            "peer_build_changed_after_start",
            "Status normalized to replaced after start",
            match worker_cleanup_detail {
                Some(detail) => format!(
                    "Queued remote update to {} stopped after the peer build changed. {detail}",
                    display_target_ref(status_target_ref),
                ),
                None => format!(
                    "Queued remote update to {} stopped after the peer build changed.",
                    display_target_ref(status_target_ref),
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
    let status = parse_lan_remote_update_status_bytes(&bytes).ok()?;
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
    read_optional_log_tail(&path, max_bytes)
}

fn read_remote_update_shell_window_log_tail(max_bytes: usize) -> Option<String> {
    let path = remote_update_shell_window_log_path()?;
    read_optional_log_tail(&path, max_bytes)
}

fn read_optional_log_tail(path: &std::path::Path, max_bytes: usize) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() {
        return None;
    }
    let start = bytes.len().saturating_sub(max_bytes.max(1));
    let text = String::from_utf8_lossy(&bytes[start..]).to_string();
    let trimmed = text.trim().to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

fn synthesize_remote_update_log_tail_from_status(
    status: &LanRemoteUpdateStatusSnapshot,
    max_chars: usize,
) -> Option<String> {
    let mut lines = Vec::new();
    for entry in &status.timeline {
        let mut line = String::new();
        if let Some(timestamp) = format_remote_update_debug_time(entry.unix_ms) {
            line.push_str(&timestamp);
            line.push_str(" \u{00B7} ");
        }
        if !entry.label.trim().is_empty() {
            let label = entry.label.trim();
            line.push_str(label);
        } else if !entry.phase.trim().is_empty() {
            let phase = entry.phase.trim();
            line.push_str(phase);
        } else {
            line.push_str("step");
        }
        if let Some(detail) = entry
            .detail
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            line.push_str(": ");
            line.push_str(detail);
        }
        lines.push(line);
    }
    if lines.is_empty() {
        if let Some(detail) = status
            .detail
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            lines.push(detail.to_string());
        }
    }
    if lines.is_empty() {
        return None;
    }
    let text = lines.join("\n");
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return None;
    }
    let max_chars = max_chars.max(1);
    if trimmed.chars().count() <= max_chars {
        return Some(trimmed);
    }
    let tail: String = trimmed
        .chars()
        .rev()
        .take(max_chars)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    Some(tail)
}

fn select_remote_update_log_tail(
    remote_update_status: Option<&LanRemoteUpdateStatusSnapshot>,
    file_log_tail: Option<String>,
) -> (String, Option<String>) {
    if let Some(log_tail) = file_log_tail {
        return ("file".to_string(), Some(log_tail));
    }
    if let Some(status) = remote_update_status {
        if let Some(log_tail) = synthesize_remote_update_log_tail_from_status(status, 6_000) {
            return ("timeline".to_string(), Some(log_tail));
        }
    }
    ("none".to_string(), None)
}

fn format_remote_update_debug_time(unix_ms: u64) -> Option<String> {
    if unix_ms == 0 {
        return None;
    }
    let dt = Local
        .timestamp_millis_opt(i64::try_from(unix_ms).ok()?)
        .single()?;
    let offset = dt.offset().local_minus_utc();
    let sign = if offset >= 0 { '+' } else { '-' };
    let abs_offset = offset.abs();
    let offset_hours = abs_offset / 3600;
    let offset_minutes = (abs_offset % 3600) / 60;
    Some(format!(
        "{:02}-{:02}-{:04} {:02}:{:02} UTC{}{:02}:{:02}",
        dt.day(),
        dt.month(),
        dt.year(),
        dt.hour(),
        dt.minute(),
        sign,
        offset_hours,
        offset_minutes
    ))
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

fn build_worker_started_status(
    accepted_status: &LanRemoteUpdateStatusSnapshot,
    worker_script: &str,
    worker_pid: u32,
    started_at_unix_ms: u64,
) -> LanRemoteUpdateStatusSnapshot {
    LanRemoteUpdateStatusSnapshot {
        state: "running".to_string(),
        worker_script: Some(worker_script.to_string()),
        worker_pid: Some(worker_pid),
        worker_exit_code: None,
        detail: Some("Remote self-update worker started".to_string()),
        reason_code: Some("worker_spawned".to_string()),
        started_at_unix_ms: Some(started_at_unix_ms),
        updated_at_unix_ms: started_at_unix_ms,
        ..accepted_status.clone()
    }
}

fn build_worker_exited_early_status(
    current_status: &LanRemoteUpdateStatusSnapshot,
    worker_pid: u32,
    worker_exit_code: Option<i32>,
    exit_detail: &str,
    finished_at_unix_ms: u64,
) -> LanRemoteUpdateStatusSnapshot {
    let bootstrap_observed = remote_update_worker_bootstrap_observed(current_status);
    let display_target = display_target_ref(&current_status.target_ref);
    let detail = if bootstrap_observed {
        exit_detail.to_string()
    } else {
        match worker_exit_code {
            Some(code) => format!(
                "Remote update worker PID {worker_pid} exited before bootstrap for target {display_target} with code {code}. No worker status/log entries were recorded, so PowerShell likely failed before the script body started."
            ),
            None => format!(
                "Remote update worker PID {worker_pid} exited before bootstrap for target {display_target}. No worker status/log entries were recorded, so PowerShell likely failed before the script body started."
            ),
        }
    };
    LanRemoteUpdateStatusSnapshot {
        state: "failed".to_string(),
        worker_pid: Some(worker_pid),
        worker_exit_code,
        reason_code: Some(
            if bootstrap_observed {
                "worker_exited_early"
            } else {
                "worker_never_bootstrapped"
            }
            .to_string(),
        ),
        detail: Some(detail),
        finished_at_unix_ms: Some(finished_at_unix_ms),
        updated_at_unix_ms: finished_at_unix_ms,
        ..current_status.clone()
    }
}

fn record_remote_update_worker_exit(
    gateway: &crate::orchestrator::gateway::GatewayState,
    request_id: &str,
    worker_pid: u32,
    worker_exit_code: Option<i32>,
    exit_detail: &str,
    finished_at_unix_ms: u64,
) {
    let Some(current_status) = read_lan_remote_update_status_raw() else {
        return;
    };
    if current_status.request_id.as_deref() != Some(request_id) {
        return;
    }
    if current_status.worker_pid.is_some() && current_status.worker_pid != Some(worker_pid) {
        return;
    }
    if !matches!(current_status.state.trim(), "accepted" | "running") {
        return;
    }
    let failed_status = build_worker_exited_early_status(
        &current_status,
        worker_pid,
        worker_exit_code,
        exit_detail,
        finished_at_unix_ms,
    );
    let _ = write_lan_remote_update_status_with_timeline(
        &failed_status,
        "worker_exit",
        "Remote update worker exited early",
        "launcher",
    );
    gateway.store.events().lan().remote_update_failed(
        "gateway",
        &format!(
            "Accepted remote update request to {}; local self-update worker exited early",
            display_target_ref(&current_status.target_ref)
        ),
        serde_json::json!({
            "request_id": request_id,
            "target_ref": current_status.target_ref,
            "worker_pid": worker_pid,
            "worker_exit_code": worker_exit_code,
            "reason_code": "worker_exited_early",
            "error": exit_detail,
        }),
    );
}

#[cfg(target_os = "windows")]
fn poll_remote_update_shell_window_diagnostics(
    context: &RemoteUpdateShellProcessContext<'_>,
    seen_keys: &mut std::collections::HashSet<String>,
) {
    let candidate_pids = crate::platform::windows_loopback_peer::list_process_ids_by_name(&[
        "powershell.exe",
        "pwsh.exe",
        "cmd.exe",
        "conhost.exe",
    ]);
    for pid in candidate_pids {
        let command_line = crate::platform::windows_loopback_peer::read_process_command_line(pid)
            .unwrap_or_default();
        let cwd = crate::platform::windows_loopback_peer::read_process_cwd(pid);
        let status_env = crate::platform::windows_loopback_peer::read_process_env_var(
            pid,
            "API_ROUTER_REMOTE_UPDATE_STATUS_PATH",
        )
        .unwrap_or_default();
        let log_env = crate::platform::windows_loopback_peer::read_process_env_var(
            pid,
            "API_ROUTER_REMOTE_UPDATE_LOG_PATH",
        )
        .unwrap_or_default();
        let request_id_env = crate::platform::windows_loopback_peer::read_process_env_var(
            pid,
            "API_ROUTER_REMOTE_UPDATE_REQUEST_ID",
        )
        .unwrap_or_default();
        let evidence = RemoteUpdateShellProcessEvidence {
            pid,
            command_line: &command_line,
            cwd: cwd.as_deref(),
            status_env: &status_env,
            log_env: &log_env,
            request_id_env: &request_id_env,
        };
        if !remote_update_shell_process_is_relevant(context, &evidence) {
            continue;
        }
        let visible_title = crate::platform::windows_loopback_peer::visible_window_title(pid);
        let visibility = if visible_title.is_some() {
            "visible"
        } else {
            "hidden_or_no_window"
        };
        let key = format!(
            "{pid}|{visibility}|{}|{}|{}",
            command_line.trim(),
            cwd.as_ref()
                .map(|value| value.display().to_string())
                .unwrap_or_default(),
            request_id_env.trim()
        );
        if !seen_keys.insert(key) {
            continue;
        }
        let title_detail = match visible_title.as_deref() {
            Some(title) if !title.trim().is_empty() => format!(" title={title:?}"),
            Some(_) => " title=<untitled>".to_string(),
            None => String::new(),
        };
        append_remote_update_shell_window_log(&format!(
            "Remote update shell process pid={pid} visibility={visibility}{title_detail} cwd={} request_id_env={} cmd={}",
            cwd.as_ref()
                .map(|value| value.display().to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            if request_id_env.trim().is_empty() {
                "unset".to_string()
            } else {
                request_id_env.trim().to_string()
            },
            if command_line.trim().is_empty() {
                "<unavailable>".to_string()
            } else {
                command_line.trim().to_string()
            }
        ));
    }

    for window in crate::platform::windows_loopback_peer::list_visible_windows() {
        log_remote_update_visible_window_diagnostic(
            "Global visible window",
            context,
            seen_keys,
            &window,
        );
    }
}

#[cfg(target_os = "windows")]
fn drain_remote_update_visible_window_events(
    context: &RemoteUpdateShellProcessContext<'_>,
    seen_keys: &mut std::collections::HashSet<String>,
    receiver: &std::sync::mpsc::Receiver<
        crate::platform::windows_loopback_peer::VisibleWindowSnapshot,
    >,
) {
    while let Ok(window) = receiver.try_recv() {
        log_remote_update_visible_window_diagnostic(
            "WinEvent visible window",
            context,
            seen_keys,
            &window,
        );
    }
}

#[cfg(target_os = "windows")]
fn log_remote_update_visible_window_diagnostic(
    source: &str,
    context: &RemoteUpdateShellProcessContext<'_>,
    seen_keys: &mut std::collections::HashSet<String>,
    window: &crate::platform::windows_loopback_peer::VisibleWindowSnapshot,
) {
    let key = format!(
        "{source}|{}",
        remote_update_global_visible_window_key(window)
    );
    if !seen_keys.insert(key) {
        return;
    }
    let command_line =
        crate::platform::windows_loopback_peer::read_process_command_line(window.pid)
            .unwrap_or_default();
    let cwd = crate::platform::windows_loopback_peer::read_process_cwd(window.pid);
    let status_env = crate::platform::windows_loopback_peer::read_process_env_var(
        window.pid,
        "API_ROUTER_REMOTE_UPDATE_STATUS_PATH",
    )
    .unwrap_or_default();
    let log_env = crate::platform::windows_loopback_peer::read_process_env_var(
        window.pid,
        "API_ROUTER_REMOTE_UPDATE_LOG_PATH",
    )
    .unwrap_or_default();
    let request_id_env = crate::platform::windows_loopback_peer::read_process_env_var(
        window.pid,
        "API_ROUTER_REMOTE_UPDATE_REQUEST_ID",
    )
    .unwrap_or_default();
    let evidence = RemoteUpdateShellProcessEvidence {
        pid: window.pid,
        command_line: &command_line,
        cwd: cwd.as_deref(),
        status_env: &status_env,
        log_env: &log_env,
        request_id_env: &request_id_env,
    };
    let relevance = if remote_update_shell_process_is_relevant(context, &evidence) {
        "relevant"
    } else {
        "observed"
    };
    append_remote_update_shell_window_log(&format!(
        "{source} during remote update relevance={relevance} pid={} hwnd={} class={:?} title={:?} cwd={} request_id_env={} cmd={}",
        window.pid,
        window.hwnd,
        if window.class_name.trim().is_empty() {
            "<unknown>"
        } else {
            window.class_name.trim()
        },
        if window.title.trim().is_empty() {
            "<untitled>"
        } else {
            window.title.trim()
        },
        cwd.as_ref()
            .map(|value| value.display().to_string())
            .unwrap_or_else(|| "unknown".to_string()),
        if request_id_env.trim().is_empty() {
            "unset".to_string()
        } else {
            request_id_env.trim().to_string()
        },
        if command_line.trim().is_empty() {
            "<unavailable>".to_string()
        } else {
            command_line.trim().to_string()
        }
    ));
}

fn monitor_remote_update_worker_exit(
    gateway: crate::orchestrator::gateway::GatewayState,
    mut child: std::process::Child,
    request_id: String,
    worker_pid: u32,
    target_ref: String,
    monitor_context: RemoteUpdateWorkerMonitorContext,
) {
    std::thread::spawn(move || {
        let mut last_progress_key: Option<String> = None;
        #[cfg(target_os = "windows")]
        let mut seen_shell_window_keys = std::collections::HashSet::<String>::new();
        #[cfg(target_os = "windows")]
        let visible_window_event_watcher =
            crate::platform::windows_loopback_peer::watch_visible_window_show_events();
        #[cfg(target_os = "windows")]
        let shell_context = RemoteUpdateShellProcessContext {
            worker_pid,
            request_id: &request_id,
            repo_root: &monitor_context.repo_root,
            status_path: monitor_context.status_path.as_deref(),
            log_path: monitor_context.log_path.as_deref(),
        };
        #[cfg(not(target_os = "windows"))]
        let _ = &monitor_context;
        let (worker_exit_code, exit_detail) = loop {
            emit_remote_update_progress_event(
                &gateway,
                &request_id,
                &target_ref,
                &mut last_progress_key,
            );
            #[cfg(target_os = "windows")]
            poll_remote_update_shell_window_diagnostics(
                &shell_context,
                &mut seen_shell_window_keys,
            );
            #[cfg(target_os = "windows")]
            if let Some((_, receiver)) = visible_window_event_watcher.as_ref() {
                drain_remote_update_visible_window_events(
                    &shell_context,
                    &mut seen_shell_window_keys,
                    receiver,
                );
            }
            match child.try_wait() {
                Ok(Some(status)) => break match status.code() {
                Some(0)
                    if read_lan_remote_update_status_raw().as_ref().is_some_and(|snapshot| {
                        !matches!(snapshot.state.trim(), "accepted" | "running")
                    }) =>
                {
                    emit_remote_update_progress_event(
                        &gateway,
                        &request_id,
                        &target_ref,
                        &mut last_progress_key,
                    );
                    return;
                }
                Some(0) => (
                    Some(0),
                    format!(
                    "Remote update worker PID {worker_pid} exited without recording completion for target {}.",
                    display_target_ref(&target_ref)
                ),
                ),
                Some(code) => (
                    Some(code),
                    format!(
                    "Remote update worker PID {worker_pid} exited before completion with code {code} for target {}.",
                    display_target_ref(&target_ref)
                ),
                ),
                None => (
                    None,
                    format!(
                    "Remote update worker PID {worker_pid} exited before completion for target {}.",
                    display_target_ref(&target_ref)
                ),
                ),
            },
                Ok(None) => {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    continue;
                }
                Err(err) => {
                    break (
                        None,
                        format!(
                            "Remote update worker PID {worker_pid} could not be monitored after spawn: {err}"
                        ),
                    )
                }
            }
        };
        #[cfg(target_os = "windows")]
        poll_remote_update_shell_window_diagnostics(&shell_context, &mut seen_shell_window_keys);
        #[cfg(target_os = "windows")]
        if let Some((_, receiver)) = visible_window_event_watcher.as_ref() {
            drain_remote_update_visible_window_events(
                &shell_context,
                &mut seen_shell_window_keys,
                receiver,
            );
        }
        append_remote_update_log_message(&exit_detail);
        record_remote_update_worker_exit(
            &gateway,
            &request_id,
            worker_pid,
            worker_exit_code,
            &exit_detail,
            unix_ms(),
        );
        emit_remote_update_progress_event(
            &gateway,
            &request_id,
            &target_ref,
            &mut last_progress_key,
        );
    });
}

fn emit_remote_update_progress_event_for_status(
    gateway: &crate::orchestrator::gateway::GatewayState,
    status: &LanRemoteUpdateStatusSnapshot,
    last_progress_key: &mut Option<String>,
) {
    let latest_entry = status
        .timeline
        .iter()
        .max_by_key(|entry| entry.unix_ms)
        .cloned();
    let phase = latest_entry
        .as_ref()
        .map(|entry| entry.phase.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or(status.state.trim());
    let event_key = format!(
        "{}:{}:{}",
        status.state.trim(),
        phase,
        status.updated_at_unix_ms
    );
    if last_progress_key.as_deref() == Some(event_key.as_str()) {
        return;
    }
    *last_progress_key = Some(event_key);

    let label = latest_entry
        .as_ref()
        .map(|entry| entry.label.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| status.state.trim());
    let detail = latest_entry
        .as_ref()
        .and_then(|entry| entry.detail.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            status
                .detail
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or("");
    let event_code = match status.state.trim() {
        "running" => crate::orchestrator::store::EventCode::LAN_REMOTE_UPDATE_PROGRESS,
        "succeeded" => crate::orchestrator::store::EventCode::LAN_REMOTE_UPDATE_SUCCEEDED,
        "failed" => crate::orchestrator::store::EventCode::LAN_REMOTE_UPDATE_FAILED,
        _ => return,
    };
    let display_target = display_target_ref(&status.target_ref);
    let message = if detail.is_empty() {
        format!("Remote self-update to {display_target}: {label}")
    } else {
        format!("Remote self-update to {display_target}: {label} ({detail})")
    };
    let fields = serde_json::json!({
        "request_id": status.request_id,
        "target_ref": status.target_ref,
        "state": status.state,
        "phase": phase,
        "label": label,
        "detail": if detail.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(detail.to_string()) },
        "worker_pid": status.worker_pid,
        "worker_exit_code": status.worker_exit_code,
        "updated_at_unix_ms": status.updated_at_unix_ms,
    });
    match event_code {
        crate::orchestrator::store::EventCode::LAN_REMOTE_UPDATE_PROGRESS => {
            gateway
                .store
                .events()
                .lan()
                .remote_update_progress("gateway", &message, fields);
        }
        crate::orchestrator::store::EventCode::LAN_REMOTE_UPDATE_SUCCEEDED => {
            gateway
                .store
                .events()
                .lan()
                .remote_update_succeeded("gateway", &message, fields);
        }
        crate::orchestrator::store::EventCode::LAN_REMOTE_UPDATE_FAILED => {
            gateway
                .store
                .events()
                .lan()
                .remote_update_failed("gateway", &message, fields);
        }
        _ => gateway
            .store
            .events()
            .emit("gateway", event_code, &message, fields),
    }
}

fn emit_remote_update_progress_event(
    gateway: &crate::orchestrator::gateway::GatewayState,
    request_id: &str,
    _target_ref: &str,
    last_progress_key: &mut Option<String>,
) {
    let Some(status) = read_lan_remote_update_status_raw() else {
        return;
    };
    if status.request_id.as_deref() != Some(request_id) {
        return;
    }
    emit_remote_update_progress_event_for_status(gateway, &status, last_progress_key);
}

fn terminal_remote_update_event_already_recorded(
    gateway: &crate::orchestrator::gateway::GatewayState,
    request_id: &str,
    event_code: crate::orchestrator::store::EventCode,
) -> bool {
    gateway
        .store
        .list_events_range(None, None, Some(200))
        .iter()
        .any(|event| {
            event.get("code").and_then(|value| value.as_str()) == Some(event_code.code())
                && event
                    .get("fields")
                    .and_then(|value| value.get("request_id"))
                    .and_then(|value| value.as_str())
                    == Some(request_id)
        })
}

pub(crate) fn reconcile_remote_update_terminal_event(
    gateway: &crate::orchestrator::gateway::GatewayState,
) {
    let Some(status) = load_lan_remote_update_status() else {
        return;
    };
    let Some(request_id) = status.request_id.as_deref() else {
        return;
    };
    let event_code = match status.state.trim() {
        "succeeded" => crate::orchestrator::store::EventCode::LAN_REMOTE_UPDATE_SUCCEEDED,
        "failed" => crate::orchestrator::store::EventCode::LAN_REMOTE_UPDATE_FAILED,
        _ => return,
    };
    if terminal_remote_update_event_already_recorded(gateway, request_id, event_code) {
        return;
    }
    let mut last_progress_key = None;
    emit_remote_update_progress_event_for_status(gateway, &status, &mut last_progress_key);
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
            .or_else(|| {
                self.recent_peer_by_node_id(normalized_node_id, LAN_PEER_HTTP_GRACE_AFTER_MS)
            })
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
        gateway.store.events().lan().remote_update_requested(
            "gateway",
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
            .or_else(|| {
                self.recent_peer_by_node_id(normalized_node_id, LAN_PEER_HTTP_GRACE_AFTER_MS)
            })
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

    pub async fn fetch_peer_diagnostics(
        &self,
        gateway: &crate::orchestrator::gateway::GatewayState,
        node_id: &str,
        domains: Vec<String>,
    ) -> Result<LanDiagnosticsResponsePacket, String> {
        let normalized_node_id = node_id.trim();
        if normalized_node_id.is_empty() {
            return Err("node_id is required".to_string());
        }
        let peer = self
            .live_peer_by_node_id(normalized_node_id)
            .or_else(|| {
                self.recent_peer_by_node_id(normalized_node_id, LAN_PEER_HTTP_GRACE_AFTER_MS)
            })
            .ok_or_else(|| format!("peer is not reachable on LAN: {normalized_node_id}"))?;
        let base_url = peer_http_base_url(&peer)
            .ok_or_else(|| format!("peer has no valid LAN address: {normalized_node_id}"))?;
        let trust_secret = current_lan_trust_secret(gateway)?;
        let response = lan_sync_http_client()
            .post(format!("{base_url}/lan-sync/diagnostics"))
            .header(
                LAN_SYNC_AUTH_NODE_ID_HEADER,
                self.local_node.node_id.clone(),
            )
            .header(LAN_SYNC_AUTH_SECRET_HEADER, trust_secret)
            .json(&LanDiagnosticsRequestPacket {
                version: 1,
                node_id: self.local_node.node_id.clone(),
                domains,
            })
            .send()
            .await
            .map_err(|err| {
                let detail = format_lan_sync_reqwest_error(&err);
                self.note_http_sync_probe(&peer, "/lan-sync/diagnostics", "request_error", &detail);
                format!("LAN diagnostics request failed: {detail}")
            })?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            let detail = format!("LAN diagnostics http {status}: {body}");
            self.note_http_sync_probe(&peer, "/lan-sync/diagnostics", "http_error", &detail);
            return Err(detail);
        }
        let packet = response
            .json::<LanDiagnosticsResponsePacket>()
            .await
            .map_err(|err| {
                let detail = format_lan_sync_reqwest_error(&err);
                self.note_http_sync_probe(&peer, "/lan-sync/diagnostics", "decode_error", &detail);
                format!("LAN diagnostics response decode failed: {detail}")
            })?;
        let _ = self.note_http_sync_probe(&peer, "/lan-sync/diagnostics", "ok", "HTTP sync ok");
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
    reset_remote_update_log();
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
        worker_exit_code: None,
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
        &gateway,
        normalized_target_ref,
        &request_id,
        &packet.node_id,
        packet.node_name.as_deref(),
    ) {
        Ok((worker_script, worker_pid)) => {
            let display_target_ref = display_target_ref(normalized_target_ref);
            let started_at_unix_ms = unix_ms();
            let _ = write_lan_remote_update_status_with_timeline(
                &build_worker_started_status(
                    &accepted_status,
                    &worker_script,
                    worker_pid,
                    started_at_unix_ms,
                ),
                "worker_spawned",
                "Remote update worker spawned",
                "http",
            );
            gateway.store.events().lan().remote_update_accepted(
                "gateway",
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
            gateway.store.events().lan().remote_update_failed(
                "gateway",
                &format!(
                    "Accepted remote update request to {}; local self-update worker failed to start",
                    display_target_ref(normalized_target_ref)
                ),
                serde_json::json!({
                    "request_id": request_id,
                    "requester_node_id": packet.node_id,
                    "target_ref": normalized_target_ref,
                    "error": err,
                }),
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
    let shell_log_path = remote_update_shell_window_log_path();
    let remote_update_status = load_lan_remote_update_status();
    let worker_bootstrap_observed = remote_update_status
        .as_ref()
        .is_some_and(remote_update_worker_bootstrap_observed);
    let worker_script_probe = probe_remote_update_worker_script();
    let file_log_tail = read_remote_update_log_tail(6_000);
    let shell_log_tail = read_remote_update_shell_window_log_tail(20_000);
    let (log_tail_source, log_tail) =
        select_remote_update_log_tail(remote_update_status.as_ref(), file_log_tail);
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
        remote_update_status,
        status_file_exists: status_path.as_ref().is_some_and(|path| path.is_file()),
        status_path: status_path.map(|path| path.display().to_string()),
        log_file_exists: log_path.as_ref().is_some_and(|path| path.is_file()),
        log_path: log_path.map(|path| path.display().to_string()),
        log_tail_source,
        log_tail,
        shell_log_file_exists: shell_log_path.as_ref().is_some_and(|path| path.is_file()),
        shell_log_path: shell_log_path.map(|path| path.display().to_string()),
        shell_log_tail,
        worker_bootstrap_observed,
        worker_script_probe,
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
    gateway: &crate::orchestrator::gateway::GatewayState,
    target_ref: &str,
    request_id: &str,
    requester_node_id: &str,
    requester_node_name: Option<&str>,
) -> Result<(String, u32), String> {
    let (program, args, script) = build_remote_update_worker_command(target_ref)?;
    let repo_root = resolve_repo_root_for_self_update()?;
    let status_path = lan_remote_update_status_path();
    let log_path = lan_remote_update_log_path();
    let mut command = std::process::Command::new(program);
    command.args(&args).current_dir(&repo_root);
    if let Some(path) = status_path {
        command.env("API_ROUTER_REMOTE_UPDATE_STATUS_PATH", path);
    }
    if let Some(path) = log_path.clone() {
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
        // Remote update must never surface a transient PowerShell/cmd window on the peer.
        // Keep the worker in a no-window process group here, and preserve hidden launches in
        // the worker scripts as well when they invoke nested PowerShell/npm/cmd steps.
        command.creation_flags(windows_remote_update_creation_flags());
    }
    command.stdin(Stdio::null());
    if let Some(path) = log_path.as_ref() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| format!("failed to create remote update log dir: {err}"))?;
        }
        let stdout = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|err| format!("failed to open remote update log for stdout: {err}"))?;
        let stderr = stdout
            .try_clone()
            .map_err(|err| format!("failed to clone remote update log handle: {err}"))?;
        command.stdout(Stdio::from(stdout));
        command.stderr(Stdio::from(stderr));
    }
    append_remote_update_log_message(&format!(
        "Launcher spawning remote update worker for target {} with script {}. cwd={} args={} log_path={} status_path={}",
        display_target_ref(target_ref),
        script,
        repo_root.display(),
        args.join(" "),
        log_path
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "unavailable".to_string()),
        lan_remote_update_status_path()
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "unavailable".to_string())
    ));
    let child = command
        .spawn()
        .map_err(|err| format!("failed to start remote update worker: {err}"))?;
    let worker_pid = child.id();
    append_remote_update_log_message(&format!(
        "Launcher started remote update worker PID {worker_pid} for target {}.",
        display_target_ref(target_ref)
    ));
    monitor_remote_update_worker_exit(
        gateway.clone(),
        child,
        request_id.to_string(),
        worker_pid,
        target_ref.to_string(),
        RemoteUpdateWorkerMonitorContext {
            repo_root,
            status_path: lan_remote_update_status_path(),
            log_path,
        },
    );
    Ok((script, worker_pid))
}

#[cfg(target_os = "windows")]
fn windows_remote_update_creation_flags() -> u32 {
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // Keep the remote update worker headless, but do not detach it from the parent process.
    // This is the outermost Windows guarantee that remote update will not flash PowerShell/cmd
    // on the peer machine. Detached launches were unreliable here because the script bootstrap
    // could exit before redirected stdout/stderr were fully established by the running app.
    CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::config::AppConfig;
    use crate::orchestrator::gateway::open_store_dir;
    use crate::orchestrator::gateway::GatewayState;
    use crate::orchestrator::router::RouterState;
    use crate::orchestrator::secrets::SecretStore;
    use crate::orchestrator::upstream::UpstreamClient;
    use parking_lot::RwLock;
    use std::collections::HashMap;
    use std::sync::atomic::AtomicU64;
    use std::sync::Arc;

    struct RemoteUpdateTestGuard {
        previous_user_data_dir: Option<std::path::PathBuf>,
        previous_repo_root: Option<std::path::PathBuf>,
    }

    impl Drop for RemoteUpdateTestGuard {
        fn drop(&mut self) {
            set_test_repo_root_override(self.previous_repo_root.as_deref());
            set_test_user_data_dir_override(self.previous_user_data_dir.as_deref());
        }
    }

    fn accepted_status_fixture() -> LanRemoteUpdateStatusSnapshot {
        LanRemoteUpdateStatusSnapshot {
            state: "accepted".to_string(),
            target_ref: "abc123".to_string(),
            request_id: Some("ru_test".to_string()),
            reason_code: Some("request_accepted".to_string()),
            requester_node_id: Some("node-remote".to_string()),
            requester_node_name: Some("Desk Remote".to_string()),
            worker_script: None,
            worker_pid: None,
            worker_exit_code: None,
            detail: Some("Queued remote self-update worker".to_string()),
            accepted_at_unix_ms: 10,
            started_at_unix_ms: None,
            finished_at_unix_ms: None,
            updated_at_unix_ms: 10,
            timeline: Vec::new(),
        }
    }

    fn gateway_state_fixture(root: &std::path::Path) -> GatewayState {
        let cfg = AppConfig::default_config();
        let now = unix_ms();
        GatewayState {
            cfg: Arc::new(RwLock::new(cfg.clone())),
            router: Arc::new(RouterState::new(&cfg, now)),
            store: open_store_dir(root.join("data")).expect("store"),
            upstream: UpstreamClient::new(),
            secrets: SecretStore::new(root.join("secrets.json")),
            last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
            last_used_by_session: Arc::new(RwLock::new(HashMap::new())),
            usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
            prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
            client_sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    #[test]
    fn remote_update_shell_process_match_accepts_request_and_repo_markers() {
        let repo_root = std::path::Path::new(r"C:\repo\API-Router");
        let status_path = repo_root
            .join("user-data")
            .join("diagnostics")
            .join("lan-remote-update-status.json");
        let log_path = repo_root
            .join("user-data")
            .join("diagnostics")
            .join("lan-remote-update.log");
        let context = super::RemoteUpdateShellProcessContext {
            worker_pid: 41,
            request_id: "ru_test",
            repo_root,
            status_path: Some(&status_path),
            log_path: Some(&log_path),
        };
        assert!(super::remote_update_shell_process_is_relevant(
            &context,
            &super::RemoteUpdateShellProcessEvidence {
                pid: 42,
                command_line: "",
                cwd: None,
                status_env: "",
                log_env: "",
                request_id_env: "ru_test",
            },
        ));
        assert!(super::remote_update_shell_process_is_relevant(
            &context,
            &super::RemoteUpdateShellProcessEvidence {
                pid: 42,
                command_line: r#"powershell.exe -File C:\repo\API-Router\tools\build\build-root-exe.ps1"#,
                cwd: None,
                status_env: "",
                log_env: "",
                request_id_env: "",
            },
        ));
        assert!(super::remote_update_shell_process_is_relevant(
            &context,
            &super::RemoteUpdateShellProcessEvidence {
                pid: 42,
                command_line: "",
                cwd: Some(repo_root),
                status_env: "",
                log_env: "",
                request_id_env: "",
            },
        ));
    }

    #[test]
    fn remote_update_shell_process_match_rejects_unrelated_shells() {
        let repo_root = std::path::Path::new(r"C:\repo\API-Router");
        let status_path = repo_root
            .join("user-data")
            .join("diagnostics")
            .join("lan-remote-update-status.json");
        let log_path = repo_root
            .join("user-data")
            .join("diagnostics")
            .join("lan-remote-update.log");
        let context = super::RemoteUpdateShellProcessContext {
            worker_pid: 41,
            request_id: "ru_test",
            repo_root,
            status_path: Some(&status_path),
            log_path: Some(&log_path),
        };
        assert!(!super::remote_update_shell_process_is_relevant(
            &context,
            &super::RemoteUpdateShellProcessEvidence {
                pid: 42,
                command_line: r#"cmd.exe /c echo hello"#,
                cwd: Some(std::path::Path::new(r"C:\Windows\System32")),
                status_env: "",
                log_env: "",
                request_id_env: "",
            },
        ));
    }

    fn set_remote_update_test_env(root: &std::path::Path) -> RemoteUpdateTestGuard {
        let previous_user_data_dir = set_test_user_data_dir_override(Some(root));
        let previous_repo_root = set_test_repo_root_override(Some(root));
        RemoteUpdateTestGuard {
            previous_user_data_dir,
            previous_repo_root,
        }
    }

    #[test]
    fn reset_remote_update_log_discards_previous_attempt_lines() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let _guard = set_remote_update_test_env(temp_dir.path());

        append_remote_update_log_message("old attempt line");
        let before_reset = read_remote_update_log_tail(4096).expect("old log should exist");
        assert!(before_reset.contains("old attempt line"));

        reset_remote_update_log();
        append_remote_update_log_message("current attempt line");

        let after_reset =
            read_remote_update_log_tail(4096).expect("current log should exist after reset");
        assert!(after_reset.contains("current attempt line"));
        assert!(!after_reset.contains("old attempt line"));
    }

    #[test]
    fn build_worker_started_status_marks_running_and_sets_started_time() {
        let accepted_status = accepted_status_fixture();

        let running_status = build_worker_started_status(
            &accepted_status,
            "src-tauri/src/lan_sync/remote_update/lan-remote-update.ps1",
            4242,
            25,
        );

        assert_eq!(running_status.state, "running");
        assert_eq!(
            running_status.reason_code.as_deref(),
            Some("worker_spawned")
        );
        assert_eq!(
            running_status.detail.as_deref(),
            Some("Remote self-update worker started")
        );
        assert_eq!(running_status.worker_pid, Some(4242));
        assert_eq!(running_status.worker_exit_code, None);
        assert_eq!(
            running_status.worker_script.as_deref(),
            Some("src-tauri/src/lan_sync/remote_update/lan-remote-update.ps1")
        );
        assert_eq!(running_status.started_at_unix_ms, Some(25));
        assert_eq!(running_status.updated_at_unix_ms, 25);
        assert_eq!(running_status.accepted_at_unix_ms, 10);
    }

    #[test]
    fn build_worker_exited_early_status_marks_failure_and_preserves_worker_context() {
        let running_status = build_worker_started_status(
            &accepted_status_fixture(),
            "src-tauri/src/lan_sync/remote_update/lan-remote-update.ps1",
            4242,
            25,
        );

        let failed_status = build_worker_exited_early_status(
            &running_status,
            4242,
            Some(9),
            "Remote update worker PID 4242 exited before completion with code 9 for target abc123.",
            40,
        );

        assert_eq!(failed_status.state, "failed");
        assert_eq!(
            failed_status.reason_code.as_deref(),
            Some("worker_never_bootstrapped")
        );
        assert_eq!(
            failed_status
                .detail
                .as_deref()
                .map(|value| value.contains("exited before bootstrap")),
            Some(true)
        );
        assert_eq!(failed_status.worker_pid, Some(4242));
        assert_eq!(failed_status.worker_exit_code, Some(9));
        assert_eq!(
            failed_status.worker_script.as_deref(),
            Some("src-tauri/src/lan_sync/remote_update/lan-remote-update.ps1")
        );
        assert_eq!(failed_status.started_at_unix_ms, Some(25));
        assert_eq!(failed_status.finished_at_unix_ms, Some(40));
        assert_eq!(failed_status.updated_at_unix_ms, 40);
    }

    #[test]
    fn build_worker_exited_early_status_preserves_original_detail_after_bootstrap() {
        let mut running_status = build_worker_started_status(
            &accepted_status_fixture(),
            "src-tauri/src/lan_sync/remote_update/lan-remote-update.ps1",
            4242,
            25,
        );
        running_status.timeline.push(LanRemoteUpdateTimelineEntry {
            unix_ms: 30,
            phase: "bootstrap".to_string(),
            label: "Bootstrapping worker".to_string(),
            detail: Some("Bootstrapping remote self-update worker.".to_string()),
            source: "worker".to_string(),
            state: "running".to_string(),
        });

        let failed_status = build_worker_exited_early_status(
            &running_status,
            4242,
            Some(9),
            "Remote update worker PID 4242 exited before completion with code 9 for target abc123.",
            40,
        );

        assert_eq!(
            failed_status.reason_code.as_deref(),
            Some("worker_exited_early")
        );
        assert_eq!(
            failed_status.detail.as_deref(),
            Some("Remote update worker PID 4242 exited before completion with code 9 for target abc123.")
        );
    }

    #[test]
    fn record_remote_update_worker_exit_writes_failed_status_and_timeline() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let _guard = set_remote_update_test_env(temp_dir.path());

        let gateway = gateway_state_fixture(temp_dir.path());
        let accepted_status = accepted_status_fixture();
        write_lan_remote_update_status(&accepted_status).expect("write accepted status");
        append_remote_update_log_message(
            "Remote update worker PID 4242 exited before completion with code 7 for target abc123.",
        );
        record_remote_update_worker_exit(
            &gateway,
            accepted_status
                .request_id
                .as_deref()
                .expect("request id should exist"),
            4242,
            Some(7),
            "Remote update worker PID 4242 exited before completion with code 7 for target abc123.",
            40,
        );

        let final_status =
            read_lan_remote_update_status_raw().expect("worker exit should be recorded");
        assert_eq!(final_status.state, "failed");
        assert_eq!(final_status.worker_pid, Some(4242));
        assert_eq!(final_status.worker_exit_code, Some(7));
        assert_eq!(
            final_status.reason_code.as_deref(),
            Some("worker_never_bootstrapped")
        );
        assert!(final_status
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("exited before bootstrap")));
        assert!(final_status
            .timeline
            .iter()
            .any(|entry| entry.phase == "worker_exit"
                && entry.label == "Remote update worker exited early"
                && entry.source == "launcher"));

        let log_tail = read_remote_update_log_tail(4096).expect("launcher log should exist");
        assert!(log_tail.contains("Remote update worker PID"));
        let events = gateway.store.list_events_range(None, None, Some(20));
        assert!(events.iter().any(|event| {
            event.get("code").and_then(|value| value.as_str()) == Some("lan.remote_update_failed")
                && event
                    .get("message")
                    .and_then(|value| value.as_str())
                    .is_some_and(|message| {
                        message.contains("local self-update worker exited early")
                    })
        }));
    }

    #[test]
    fn reconcile_remote_update_terminal_event_backfills_missing_success_event() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let _guard = set_remote_update_test_env(temp_dir.path());
        let gateway = gateway_state_fixture(temp_dir.path());

        let status = LanRemoteUpdateStatusSnapshot {
            state: "succeeded".to_string(),
            target_ref: "9e557ebd".to_string(),
            request_id: Some("ru_success".to_string()),
            reason_code: None,
            requester_node_id: Some("node-remote".to_string()),
            requester_node_name: Some("Desk Remote".to_string()),
            worker_script: Some("worker.ps1".to_string()),
            worker_pid: Some(4242),
            worker_exit_code: Some(0),
            detail: Some("Completed: Remote self-update completed successfully.".to_string()),
            accepted_at_unix_ms: 10,
            started_at_unix_ms: Some(20),
            finished_at_unix_ms: Some(30),
            updated_at_unix_ms: 30,
            timeline: vec![LanRemoteUpdateTimelineEntry {
                unix_ms: 30,
                phase: "completed".to_string(),
                label: "Remote update completed".to_string(),
                detail: Some("Completed: Remote self-update completed successfully.".to_string()),
                source: "worker".to_string(),
                state: "succeeded".to_string(),
            }],
        };
        write_lan_remote_update_status(&status).expect("write status");

        reconcile_remote_update_terminal_event(&gateway);

        let events = gateway.store.list_events_range(None, None, Some(20));
        assert!(events.iter().any(|event| {
            event.get("code").and_then(|value| value.as_str())
                == Some("lan.remote_update_succeeded")
                && event
                    .get("fields")
                    .and_then(|value| value.get("request_id"))
                    .and_then(|value| value.as_str())
                    == Some("ru_success")
        }));
    }

    #[test]
    fn record_remote_update_worker_exit_does_not_override_succeeded_status() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let _guard = set_remote_update_test_env(temp_dir.path());
        let gateway = gateway_state_fixture(temp_dir.path());

        let status = LanRemoteUpdateStatusSnapshot {
            state: "succeeded".to_string(),
            target_ref: "9e557ebd".to_string(),
            request_id: Some("ru_success".to_string()),
            reason_code: None,
            requester_node_id: Some("node-remote".to_string()),
            requester_node_name: Some("Desk Remote".to_string()),
            worker_script: Some("worker.ps1".to_string()),
            worker_pid: Some(4242),
            worker_exit_code: Some(0),
            detail: Some("Completed: Remote self-update completed successfully.".to_string()),
            accepted_at_unix_ms: 10,
            started_at_unix_ms: Some(20),
            finished_at_unix_ms: Some(30),
            updated_at_unix_ms: 30,
            timeline: vec![LanRemoteUpdateTimelineEntry {
                unix_ms: 30,
                phase: "completed".to_string(),
                label: "Remote update completed".to_string(),
                detail: Some("Completed: Remote self-update completed successfully.".to_string()),
                source: "worker".to_string(),
                state: "succeeded".to_string(),
            }],
        };
        write_lan_remote_update_status(&status).expect("write status");

        record_remote_update_worker_exit(
            &gateway,
            "ru_success",
            4242,
            Some(0),
            "Remote update worker PID 4242 exited without recording completion for target 9e557ebd.",
            40,
        );

        let final_status = read_lan_remote_update_status_raw().expect("status should still exist");
        assert_eq!(final_status.state, "succeeded");
        assert_eq!(final_status.worker_exit_code, Some(0));
        let events = gateway.store.list_events_range(None, None, Some(20));
        assert!(!events.iter().any(|event| {
            event.get("code").and_then(|value| value.as_str()) == Some("lan.remote_update_failed")
        }));
    }

    #[test]
    fn parse_remote_update_debug_response_accepts_older_payload_without_new_fields() {
        let payload = serde_json::json!({
            "ok": true,
            "version": 1,
            "node_id": "node-a",
            "node_name": "Desk A",
            "remote_update_readiness": {
                "ready": true,
                "checked_at_unix_ms": 1,
                "blocked_reason": null
            },
            "remote_update_status": null,
            "status_path": null,
            "status_file_exists": false,
            "log_path": null,
            "log_file_exists": false,
            "log_tail": null,
            "worker_script_probe": null,
            "local_build_identity": {
                "app_version": "0.4.0",
                "build_git_sha": "abcdef0123456789",
                "build_git_short_sha": "abcdef01",
                "build_commit_unix_ms": null
            },
            "local_version_sync": {
                "target_ref": null,
                "git_worktree_clean": true,
                "update_to_local_build_allowed": false,
                "blocked_reason": null
            }
        });

        let parsed: LanRemoteUpdateDebugResponsePacket =
            serde_json::from_value(payload).expect("older payload should deserialize");
        assert_eq!(parsed.log_tail_source, "none");
        assert!(!parsed.worker_bootstrap_observed);
        assert!(!parsed.shell_log_file_exists);
        assert_eq!(parsed.shell_log_path, None);
        assert_eq!(parsed.shell_log_tail, None);
    }

    #[test]
    fn select_remote_update_log_tail_prefers_file_log_over_timeline() {
        let status = LanRemoteUpdateStatusSnapshot {
            state: "failed".to_string(),
            target_ref: "deadbeef".to_string(),
            request_id: Some("ru_file".to_string()),
            reason_code: Some("build_failed".to_string()),
            requester_node_id: Some("node-a".to_string()),
            requester_node_name: Some("Desk A".to_string()),
            worker_script: Some("worker.ps1".to_string()),
            worker_pid: Some(42),
            worker_exit_code: Some(1),
            detail: Some("failed".to_string()),
            accepted_at_unix_ms: 1,
            started_at_unix_ms: Some(2),
            finished_at_unix_ms: Some(3),
            updated_at_unix_ms: 4,
            timeline: vec![LanRemoteUpdateTimelineEntry {
                unix_ms: 4,
                phase: "failed".to_string(),
                label: "Building frontend failed".to_string(),
                detail: Some("timeline summary".to_string()),
                source: "worker".to_string(),
                state: "failed".to_string(),
            }],
        };

        let (source, log_tail) =
            select_remote_update_log_tail(Some(&status), Some("worker stderr tail".to_string()));
        assert_eq!(source, "file");
        assert_eq!(log_tail.as_deref(), Some("worker stderr tail"));
    }

    #[test]
    fn parse_lan_remote_update_status_bytes_accepts_utf8_bom_written_by_powershell() {
        let status = LanRemoteUpdateStatusSnapshot {
            state: "running".to_string(),
            target_ref: "0d3cbb4b".to_string(),
            request_id: Some("ru_bom".to_string()),
            reason_code: Some("worker_spawned".to_string()),
            requester_node_id: Some("node-remote".to_string()),
            requester_node_name: Some("Desk Remote".to_string()),
            worker_script: Some("worker.ps1".to_string()),
            worker_pid: Some(4242),
            worker_exit_code: None,
            detail: Some("Building EXE: Running Windows EXE build and restart script".to_string()),
            accepted_at_unix_ms: 10,
            started_at_unix_ms: Some(20),
            finished_at_unix_ms: None,
            updated_at_unix_ms: 30,
            timeline: vec![LanRemoteUpdateTimelineEntry {
                unix_ms: 30,
                phase: "build_exe".to_string(),
                label: "Building EXE".to_string(),
                detail: Some(
                    "Building EXE: Running Windows EXE build and restart script".to_string(),
                ),
                source: "worker".to_string(),
                state: "running".to_string(),
            }],
        };
        let mut bytes = b"\xEF\xBB\xBF".to_vec();
        bytes.extend(serde_json::to_vec(&status).expect("serialize status"));

        let loaded =
            parse_lan_remote_update_status_bytes(&bytes).expect("parse status with utf8 bom");
        assert_eq!(loaded.state, "running");
        assert_eq!(loaded.target_ref, "0d3cbb4b");
        assert_eq!(loaded.request_id.as_deref(), Some("ru_bom"));
        assert_eq!(
            loaded.timeline.last().map(|entry| entry.phase.as_str()),
            Some("build_exe")
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn remote_update_global_visible_window_key_trims_noise_for_dedup() {
        let window = crate::platform::windows_loopback_peer::VisibleWindowSnapshot {
            hwnd: 42,
            pid: 777,
            title: "  API Router  ".to_string(),
            class_name: "  ConsoleWindowClass ".to_string(),
        };

        let key = remote_update_global_visible_window_key(&window);
        assert_eq!(key, "42|777|API Router|ConsoleWindowClass");
    }

    #[test]
    fn remote_update_scripts_fetch_without_tags() {
        let repo_root = resolve_repo_root_for_self_update().expect("resolve repo root");
        let windows_script = repo_root
            .join("src-tauri")
            .join("src")
            .join("lan_sync")
            .join("remote_update")
            .join("lan-remote-update.ps1");
        let windows_contents =
            std::fs::read_to_string(&windows_script).expect("read Windows remote update script");
        assert!(windows_contents.contains("git fetch origin --prune"));
        assert!(!windows_contents.contains("git fetch origin --prune --tags"));
        assert!(windows_contents.contains("function Test-GitRevisionExists"));
        assert!(windows_contents.contains("if (Test-GitRevisionExists \"refs/heads/$Ref\")"));
        assert!(windows_contents.contains("UTF8Encoding($false)"));
        assert!(windows_contents
            .contains("[System.IO.File]::WriteAllText($statusPath, $json, $utf8NoBom)"));
        assert!(windows_contents.contains("tools\\build\\build-root-exe.ps1"));
        assert!(windows_contents.contains("Running Windows EXE build and restart script"));
        assert!(windows_contents.contains("build-root-exe.ps1 failed"));
        assert!(windows_contents.contains("function Get-RemoteUpdateBuildResultPath"));
        assert!(windows_contents
            .contains("$env:API_ROUTER_REMOTE_UPDATE_BUILD_RESULT_PATH = $buildResultPath"));
        assert!(windows_contents.contains("Hidden process exit_code was <null>"));
        assert!(windows_contents.contains("build result marker reported success"));
        assert!(windows_contents.contains("-StartHidden"));
        assert!(windows_contents.contains("function Show-RemoteUpdateNotification"));
        assert!(windows_contents.contains("System.Windows.Forms.NotifyIcon"));
        assert!(windows_contents.contains("API Router update in progress"));
        assert!(windows_contents.contains("Show-RemoteUpdateNotification -TargetRef $TargetRef"));
        assert!(!windows_contents.contains("npm run build:root-exe"));

        let linux_script = repo_root
            .join("src-tauri")
            .join("src")
            .join("lan_sync")
            .join("remote_update")
            .join("lan-remote-update.sh");
        let linux_contents =
            std::fs::read_to_string(&linux_script).expect("read Linux remote update script");
        assert!(linux_contents.contains("git fetch origin --prune"));
        assert!(!linux_contents.contains("git fetch origin --prune --tags"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_remote_update_worker_runs_headless_without_detaching() {
        let flags = windows_remote_update_creation_flags();
        assert_eq!(flags & 0x0000_0200, 0x0000_0200);
        assert_eq!(flags & 0x0800_0000, 0x0800_0000);
        assert_eq!(flags & 0x0000_0008, 0);
    }

    #[test]
    fn build_root_exe_script_uses_windows_powershell_driver() {
        let repo_root = resolve_repo_root_for_self_update().expect("resolve repo root");
        let package_json =
            std::fs::read_to_string(repo_root.join("package.json")).expect("read package.json");
        assert!(
            package_json.contains("\"build:root-exe\": \"node tools/build/build-root-exe.mjs\"")
        );

        let build_driver = std::fs::read_to_string(
            repo_root
                .join("tools")
                .join("build")
                .join("build-root-exe.mjs"),
        )
        .expect("read build-root-exe driver");
        assert!(build_driver.contains("tools', 'build', 'build-root-exe.ps1"));
        assert!(build_driver.contains("powershell.exe"));

        let build_script = std::fs::read_to_string(
            repo_root
                .join("tools")
                .join("build")
                .join("build-root-exe.ps1"),
        )
        .expect("read build-root-exe.ps1");
        assert!(build_script
            .contains("@($RunWithWinSdkCli, 'node', $TauriCliEntry, 'build', '--no-bundle')"));
        assert!(build_script.contains("[switch]$StartHidden"));
        assert!(build_script.contains("'--start-hidden'"));
        assert!(build_script.contains("if ($arguments.Count -gt 0)"));
        assert!(build_script.contains("$restartWarning = $null"));
        assert!(build_script.contains("function Invoke-BuildCommand"));
        assert!(build_script.contains("CreateNoWindow = $true"));
        assert!(build_script.contains("function Get-RemoteUpdateBuildResultPath"));
        assert!(build_script.contains("function Write-BuildResultMarker"));
        assert!(build_script.contains("API_ROUTER_REMOTE_UPDATE_BUILD_RESULT_PATH"));
        assert!(build_script.contains("lan-remote-update-build-result.json"));
        assert!(build_script.contains("function Invoke-BuildStage"));
        assert!(build_script.contains("Invoke-BuildStage `"));
        assert!(build_script.contains("-FilePath $NpmCli"));
        assert!(build_script.contains("function Update-RemoteUpdateTimelineStep"));
        assert!(build_script.contains("function Try-CopyOptionalArtifact"));
        assert!(build_script.contains("-Phase 'build_vite'"));
        assert!(build_script.contains("-Phase 'build_release_binary'"));
        assert!(build_script.contains("Enter-BuildStep -Phase 'install_release_binary'"));
        assert!(build_script.contains("Enter-BuildStep -Phase 'restart_api_router'"));
        assert!(build_script.contains("Installed canonical runtime executable"));
        assert!(build_script.contains("Optional TEST EXE"));
        assert!(build_script.contains("API Router restart after build failed"));
        assert!(
            build_script.contains("Windows EXE build succeeded, but the restart attempt failed")
        );
        assert!(build_script.contains("$StartFilePath = Resolve-BuildArtifactPath"));
        assert!(build_script.contains("Missing start target: $StartFilePath"));
        assert!(build_script.contains("Starting: $StartFilePath"));
        assert!(build_script.contains("$startOptions.WindowStyle = 'Hidden'"));
        assert!(build_script.contains("Start-Process @startOptions"));
        assert!(build_script.contains("$UsesArtifactPathOverrides"));
        assert!(build_script.contains("if ($IsWindows -and -not $UsesArtifactPathOverrides)"));
        assert!(build_script.contains("Reset-LastExitCode"));
        assert!(build_script.contains("exit 0"));
    }

    #[test]
    fn normalize_remote_update_status_marks_failed_status_succeeded_when_target_already_matches() {
        let Some(target_ref) = normalized_local_build_target_ref() else {
            return;
        };
        let status = LanRemoteUpdateStatusSnapshot {
            state: "failed".to_string(),
            target_ref: target_ref.clone(),
            request_id: Some("ru_failed".to_string()),
            reason_code: Some("worker_exited_early".to_string()),
            requester_node_id: Some("node-remote".to_string()),
            requester_node_name: Some("Desk Remote".to_string()),
            worker_script: Some("worker.ps1".to_string()),
            worker_pid: None,
            worker_exit_code: Some(1),
            detail: Some("tools/build/build-root-exe.ps1 failed".to_string()),
            accepted_at_unix_ms: 10,
            started_at_unix_ms: Some(20),
            finished_at_unix_ms: Some(30),
            updated_at_unix_ms: 30,
            timeline: vec![LanRemoteUpdateTimelineEntry {
                unix_ms: 30,
                phase: "failed".to_string(),
                label: "Build step failed".to_string(),
                detail: Some("tools/build/build-root-exe.ps1 failed".to_string()),
                source: "worker".to_string(),
                state: "failed".to_string(),
            }],
        };

        let normalized = normalize_remote_update_status(status);
        assert_eq!(normalized.state, "succeeded");
        assert_eq!(
            normalized.reason_code.as_deref(),
            Some("peer_already_matches_target_after_failed_status")
        );
        assert!(normalized.detail.as_deref().is_some_and(
            |detail| detail.contains("Current build already matches the queued target")
        ));
        assert!(normalized
            .timeline
            .iter()
            .any(|entry| entry.phase == "normalized_succeeded"
                && entry.label == "Status normalized to succeeded"));
    }
}
