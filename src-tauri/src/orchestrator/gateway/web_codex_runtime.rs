use super::*;
use axum::extract::Query;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::process::Command;

use crate::orchestrator::gateway::web_codex_home::{
    parse_workspace_target, web_codex_rpc_home_override_for_target,
};
use crate::orchestrator::gateway::web_codex_session_runtime::{
    workspace_runtime_snapshot, workspace_thread_runtime_count, WorkspaceRuntimeSnapshot,
};

#[derive(Deserialize)]
pub(super) struct TerminalExecRequest {
    pub(super) command: String,
    #[serde(default)]
    pub(super) cwd: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RuntimeStateQuery {
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    home: Option<String>,
}

#[derive(Clone, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct CodexRuntimeStatePayload {
    workspace: String,
    home_override: Option<String>,
    connected: bool,
    connected_at_unix_secs: Option<i64>,
    last_replay_cursor: u64,
    last_replay_last_event_id: Option<u64>,
    last_replay_at_unix_secs: Option<i64>,
    active_thread_count: usize,
}

#[derive(Clone, Serialize, Debug, PartialEq, Eq)]
pub(super) struct CodexVersionInfo {
    windows: String,
    wsl2: String,
    #[serde(rename = "windowsInstalled")]
    windows_installed: bool,
    #[serde(rename = "wsl2Installed")]
    wsl2_installed: bool,
    #[serde(rename = "windowsAppServerSupported")]
    windows_app_server_supported: bool,
    #[serde(rename = "wsl2AppServerSupported")]
    wsl2_app_server_supported: bool,
    #[serde(rename = "windowsRemoteTuiSupported")]
    windows_remote_tui_supported: bool,
    #[serde(rename = "wsl2RemoteTuiSupported")]
    wsl2_remote_tui_supported: bool,
    #[serde(rename = "appVersion")]
    app_version: String,
    #[serde(rename = "buildGitSha")]
    build_git_sha: String,
    #[serde(rename = "buildGitShortSha")]
    build_git_short_sha: String,
    #[serde(rename = "repoGitSha")]
    repo_git_sha: Option<String>,
    #[serde(rename = "repoGitShortSha")]
    repo_git_short_sha: Option<String>,
    #[serde(rename = "buildStale")]
    build_stale: bool,
}

#[derive(Clone)]
struct CodexVersionInfoCache {
    value: CodexVersionInfo,
    updated_at_unix_secs: i64,
}

static CODEX_VERSION_INFO_REFRESH_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug, PartialEq, Eq)]
struct DetectedCodexRuntime {
    version: String,
    installed: bool,
    app_server_supported: bool,
    remote_tui_supported: bool,
}

fn codex_version_info_cache() -> &'static std::sync::Mutex<Option<CodexVersionInfoCache>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<Option<CodexVersionInfoCache>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(None))
}

fn lock_codex_version_info_cache() -> std::sync::MutexGuard<'static, Option<CodexVersionInfoCache>>
{
    match codex_version_info_cache().lock() {
        Ok(v) => v,
        Err(err) => err.into_inner(),
    }
}

fn version_info_cache_is_fresh(updated_at_unix_secs: i64, now_unix_secs: i64) -> bool {
    now_unix_secs.saturating_sub(updated_at_unix_secs) < VERSION_INFO_CACHE_SECS
}

pub(super) fn truncate_output(value: &[u8]) -> (String, bool) {
    if value.len() <= MAX_TERMINAL_OUTPUT_BYTES {
        return (String::from_utf8_lossy(value).to_string(), false);
    }
    let head = &value[..MAX_TERMINAL_OUTPUT_BYTES];
    (String::from_utf8_lossy(head).to_string(), true)
}

async fn run_stdout_cmd(mut cmd: Command) -> Option<String> {
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    let timed = tokio::time::timeout(
        std::time::Duration::from_secs(VERSION_DETECT_TIMEOUT_SECS),
        cmd.output(),
    )
    .await
    .ok()?;
    let output = timed.ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn first_nonempty_line(value: &str) -> Option<String> {
    value
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.to_string())
}

fn help_text_supports_app_server(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("app-server")
}

fn help_text_supports_remote_tui(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("--remote")
}

async fn run_windows_shell_stdout(command: &str) -> Option<String> {
    let mut cmd = Command::new("cmd.exe");
    cmd.arg("/C").arg(command);
    run_stdout_cmd(cmd).await
}

async fn run_wsl_shell_stdout(command: &str) -> Option<String> {
    let mut cmd = Command::new("wsl.exe");
    cmd.arg("-e").arg("bash").arg("-lc").arg(command);
    run_stdout_cmd(cmd).await
}

fn windows_codex_shell_candidates(subcommand: &str) -> Vec<String> {
    let mut candidates = vec![format!("codex {subcommand}")];
    if let Ok(appdata) = std::env::var("APPDATA") {
        let candidate = PathBuf::from(appdata).join("npm").join("codex.cmd");
        if candidate.exists() {
            candidates.push(format!("\"{}\" {subcommand}", candidate.display()));
        }
    }
    candidates
}

async fn detect_windows_codex_runtime() -> DetectedCodexRuntime {
    let started = std::time::Instant::now();
    let mut version = "Not installed".to_string();
    for candidate in windows_codex_shell_candidates("--version") {
        if let Some(found) = run_windows_shell_stdout(&candidate).await {
            if let Some(line) = first_nonempty_line(&found) {
                version = line;
                break;
            }
        }
    }
    let installed = version != "Not installed";
    let (remote_tui_supported, app_server_supported) = if installed {
        let remote = async {
            for candidate in windows_codex_shell_candidates("--help") {
                if let Some(help) = run_windows_shell_stdout(&candidate).await {
                    if help_text_supports_remote_tui(&help) {
                        return true;
                    }
                }
            }
            false
        };
        let app_server = async {
            for candidate in windows_codex_shell_candidates("app-server --help") {
                if let Some(help) = run_windows_shell_stdout(&candidate).await {
                    if help_text_supports_app_server(&help) {
                        return true;
                    }
                }
            }
            false
        };
        tokio::join!(remote, app_server)
    } else {
        (false, false)
    };
    log_codex_version_detect_timing("windows", started.elapsed().as_millis());
    DetectedCodexRuntime {
        version,
        installed,
        app_server_supported,
        remote_tui_supported,
    }
}

async fn detect_wsl_codex_runtime() -> DetectedCodexRuntime {
    let started = std::time::Instant::now();
    let (version_output, help_output, app_server_help_output) = tokio::join!(
        run_wsl_shell_stdout("codex --version"),
        run_wsl_shell_stdout("codex --help"),
        run_wsl_shell_stdout("codex app-server --help")
    );
    let version = version_output
        .and_then(|found| first_nonempty_line(&found))
        .unwrap_or_else(|| "Not installed".to_string());
    let installed = version != "Not installed";
    let remote_tui_supported = installed
        && help_output
            .as_deref()
            .is_some_and(help_text_supports_remote_tui);
    let app_server_supported = installed
        && app_server_help_output
            .as_deref()
            .is_some_and(help_text_supports_app_server);
    log_codex_version_detect_timing("wsl2", started.elapsed().as_millis());
    DetectedCodexRuntime {
        version,
        installed,
        app_server_supported,
        remote_tui_supported,
    }
}

fn log_codex_version_detect_timing(workspace: &str, elapsed_ms: u128) {
    let mut pipeline = crate::diagnostics::codex_web_pipeline::CodexWebPipelineEvent::new(
        "/codex/version-info",
        workspace,
        "runtime_detect",
        u64::try_from(elapsed_ms).unwrap_or(u64::MAX),
    );
    pipeline.source = Some("codex-version-command".to_string());
    pipeline.ok = Some(true);
    crate::diagnostics::codex_web_pipeline::append_pipeline_event(pipeline);
    let _ =
        crate::orchestrator::gateway::web_codex_storage::append_codex_live_trace_entry(&json!({
            "source": "backend.version_info",
            "entry": {
                "at": current_unix_secs() * 1000,
                "kind": "version_info.detect_runtime",
                "workspace": workspace,
                "elapsedMs": elapsed_ms,
            }
        }));
}

fn resolve_repo_root_for_git() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.to_path_buf();
            if candidate.join(".git").exists() {
                return Some(candidate);
            }
        }
    }
    let cwd = std::env::current_dir().ok()?;
    if cwd.join(".git").exists() {
        Some(cwd)
    } else {
        None
    }
}

fn detect_repo_git_sha() -> Option<String> {
    let repo_root = resolve_repo_root_for_git()?;
    let mut cmd = crate::platform::git_exec::new_git_command();
    cmd.arg("-C").arg(repo_root).arg("rev-parse").arg("HEAD");
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if sha.is_empty() {
        None
    } else {
        Some(sha)
    }
}

fn short_git_sha(value: Option<&str>) -> Option<String> {
    value.map(|sha| {
        if sha.len() > 8 {
            sha[..8].to_string()
        } else {
            sha.to_string()
        }
    })
}

fn build_version_payload(
    windows: DetectedCodexRuntime,
    wsl2: DetectedCodexRuntime,
    build_git_sha: String,
    build_git_short_sha: String,
    repo_git_sha: Option<String>,
) -> CodexVersionInfo {
    let repo_git_short_sha = short_git_sha(repo_git_sha.as_deref());
    let build_stale = repo_git_sha
        .as_deref()
        .is_some_and(|repo| !build_git_sha.eq_ignore_ascii_case(repo));
    CodexVersionInfo {
        windows_installed: windows.installed,
        wsl2_installed: wsl2.installed,
        windows_app_server_supported: windows.app_server_supported,
        wsl2_app_server_supported: wsl2.app_server_supported,
        windows_remote_tui_supported: windows.remote_tui_supported,
        wsl2_remote_tui_supported: wsl2.remote_tui_supported,
        windows: windows.version,
        wsl2: wsl2.version,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        build_git_sha,
        build_git_short_sha,
        repo_git_sha,
        repo_git_short_sha,
        build_stale,
    }
}

async fn detect_codex_version_info_payload() -> CodexVersionInfo {
    let started = std::time::Instant::now();
    let (windows, wsl2) = tokio::join!(detect_windows_codex_runtime(), detect_wsl_codex_runtime());
    let build_git_sha = option_env!("API_ROUTER_BUILD_GIT_SHA")
        .unwrap_or("unknown")
        .to_string();
    let build_git_short_sha = option_env!("API_ROUTER_BUILD_GIT_SHORT_SHA")
        .unwrap_or("unknown")
        .to_string();
    let repo_git_sha = detect_repo_git_sha();
    let payload = build_version_payload(
        windows,
        wsl2,
        build_git_sha,
        build_git_short_sha,
        repo_git_sha,
    );
    {
        let mut cache = lock_codex_version_info_cache();
        *cache = Some(CodexVersionInfoCache {
            value: payload.clone(),
            updated_at_unix_secs: current_unix_secs(),
        });
    }
    let _ =
        crate::orchestrator::gateway::web_codex_storage::append_codex_live_trace_entry(&json!({
            "source": "backend.version_info",
            "entry": {
                "at": current_unix_secs() * 1000,
                "kind": "version_info.refresh_complete",
                "elapsedMs": started.elapsed().as_millis(),
            }
        }));
    payload
}

fn spawn_codex_version_info_refresh_if_idle() {
    if CODEX_VERSION_INFO_REFRESH_IN_FLIGHT
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    tauri::async_runtime::spawn(async {
        let _ = detect_codex_version_info_payload().await;
        CODEX_VERSION_INFO_REFRESH_IN_FLIGHT.store(false, Ordering::Release);
    });
}

fn normalize_runtime_home_override(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn build_runtime_state_payload(snapshot: WorkspaceRuntimeSnapshot) -> CodexRuntimeStatePayload {
    let active_thread_count = workspace_thread_runtime_count(
        snapshot.workspace_target,
        snapshot.home_override.as_deref(),
    );
    CodexRuntimeStatePayload {
        workspace: snapshot.workspace_label,
        home_override: snapshot.home_override,
        connected: snapshot.connected,
        connected_at_unix_secs: snapshot.connected_at_unix_secs,
        last_replay_cursor: snapshot.last_replay_cursor,
        last_replay_last_event_id: snapshot.last_replay_last_event_id,
        last_replay_at_unix_secs: snapshot.last_replay_at_unix_secs,
        active_thread_count,
    }
}

pub(super) async fn codex_runtime_state(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<RuntimeStateQuery>,
) -> Response {
    let started = std::time::Instant::now();
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let workspace_target = query.workspace.as_deref().and_then(parse_workspace_target);
    let home_override = normalize_runtime_home_override(query.home.as_deref())
        .or_else(|| web_codex_rpc_home_override_for_target(workspace_target));
    let snapshot = workspace_runtime_snapshot(workspace_target, home_override.as_deref());
    let payload = build_runtime_state_payload(snapshot);
    let mut pipeline = crate::diagnostics::codex_web_pipeline::CodexWebPipelineEvent::new(
        "/codex/runtime/state",
        &payload.workspace,
        "gateway_handler",
        crate::diagnostics::codex_web_pipeline::elapsed_ms_u64(started),
    );
    pipeline.source = Some("runtime-registry".to_string());
    pipeline.item_count = Some(payload.active_thread_count);
    pipeline.ok = Some(true);
    crate::diagnostics::codex_web_pipeline::append_pipeline_event(pipeline);
    Json(payload).into_response()
}

pub(super) async fn codex_version_info(
    State(st): State<GatewayState>,
    headers: HeaderMap,
) -> Response {
    let started = std::time::Instant::now();
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let now = current_unix_secs();
    if let Some(cached) = lock_codex_version_info_cache().clone() {
        if version_info_cache_is_fresh(cached.updated_at_unix_secs, now) {
            let mut pipeline = crate::diagnostics::codex_web_pipeline::CodexWebPipelineEvent::new(
                "/codex/version-info",
                "all",
                "gateway_handler",
                crate::diagnostics::codex_web_pipeline::elapsed_ms_u64(started),
            );
            pipeline.cache_hit = Some(true);
            pipeline.source = Some("fresh-cache".to_string());
            pipeline.ok = Some(true);
            crate::diagnostics::codex_web_pipeline::append_pipeline_event(pipeline);
            return Json(cached.value).into_response();
        }
        spawn_codex_version_info_refresh_if_idle();
        let mut pipeline = crate::diagnostics::codex_web_pipeline::CodexWebPipelineEvent::new(
            "/codex/version-info",
            "all",
            "gateway_handler",
            crate::diagnostics::codex_web_pipeline::elapsed_ms_u64(started),
        );
        pipeline.cache_hit = Some(true);
        pipeline.refreshing = Some(true);
        pipeline.source = Some("stale-cache-background-refresh".to_string());
        pipeline.ok = Some(true);
        crate::diagnostics::codex_web_pipeline::append_pipeline_event(pipeline);
        return Json(cached.value).into_response();
    }

    let payload = detect_codex_version_info_payload().await;
    let mut pipeline = crate::diagnostics::codex_web_pipeline::CodexWebPipelineEvent::new(
        "/codex/version-info",
        "all",
        "gateway_handler",
        crate::diagnostics::codex_web_pipeline::elapsed_ms_u64(started),
    );
    pipeline.cache_hit = Some(false);
    pipeline.source = Some("cold-detect".to_string());
    pipeline.ok = Some(true);
    crate::diagnostics::codex_web_pipeline::append_pipeline_event(pipeline);
    Json(payload).into_response()
}

pub(super) async fn codex_terminal_exec(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    LoggedJson(req): LoggedJson<TerminalExecRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let command = req.command.trim();
    if command.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "command is required");
    }
    if command.len() > MAX_TERMINAL_COMMAND_LEN {
        return api_error(StatusCode::BAD_REQUEST, "command exceeds max length");
    }
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd.exe");
        c.arg("/C").arg(command);
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-lc").arg(command);
        c
    };
    cmd.kill_on_drop(true);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);

    if let Some(cwd) = req.cwd {
        let path = PathBuf::from(cwd);
        if path.exists() && path.is_dir() {
            cmd.current_dir(path);
        }
    }

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return api_error_detail(
                StatusCode::BAD_REQUEST,
                "failed to spawn command",
                e.to_string(),
            )
        }
    };
    let timed = tokio::time::timeout(
        std::time::Duration::from_secs(TERMINAL_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await;
    let output = match timed {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            return api_error_detail(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to wait command",
                e.to_string(),
            )
        }
        Err(_) => {
            return api_error(
                StatusCode::REQUEST_TIMEOUT,
                "terminal command timed out (20s)",
            )
        }
    };
    let (stdout, stdout_truncated) = truncate_output(&output.stdout);
    let (stderr, stderr_truncated) = truncate_output(&output.stderr);
    Json(json!({
        "ok": output.status.success(),
        "exitCode": output.status.code(),
        "stdout": stdout,
        "stderr": stderr,
        "stdoutTruncated": stdout_truncated,
        "stderrTruncated": stderr_truncated,
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::gateway::web_codex_home::WorkspaceTarget;
    use crate::orchestrator::gateway::web_codex_session_runtime::{
        _clear_workspace_runtime_registry_for_test, mark_workspace_runtime_connected,
        mark_workspace_runtime_replay, upsert_workspace_thread_runtime,
    };

    #[test]
    fn short_git_sha_truncates_only_when_needed() {
        assert_eq!(
            short_git_sha(Some("1234567890abcdef")),
            Some("12345678".to_string())
        );
        assert_eq!(short_git_sha(Some("1234567")), Some("1234567".to_string()));
        assert_eq!(short_git_sha(None), None);
    }

    #[test]
    fn build_version_payload_marks_installation_and_staleness() {
        let payload = build_version_payload(
            DetectedCodexRuntime {
                version: "codex 1.0.0".to_string(),
                installed: true,
                app_server_supported: true,
                remote_tui_supported: true,
            },
            DetectedCodexRuntime {
                version: "Not installed".to_string(),
                installed: false,
                app_server_supported: false,
                remote_tui_supported: false,
            },
            "abc12345".to_string(),
            "abc12345".to_string(),
            Some("fff00000".to_string()),
        );
        assert!(payload.windows_installed);
        assert!(!payload.wsl2_installed);
        assert!(payload.windows_app_server_supported);
        assert!(payload.windows_remote_tui_supported);
        assert!(!payload.wsl2_app_server_supported);
        assert!(!payload.wsl2_remote_tui_supported);
        assert_eq!(payload.repo_git_short_sha, Some("fff00000".to_string()));
        assert!(payload.build_stale);
    }

    #[test]
    fn help_text_support_flags_are_detected() {
        let help = "Usage: codex [OPTIONS]\nCommands:\n  app-server\nOptions:\n  --remote <ADDR>\n";
        assert!(help_text_supports_app_server(help));
        assert!(help_text_supports_remote_tui(help));
        assert!(!help_text_supports_remote_tui("Usage: codex [OPTIONS]"));
    }

    #[test]
    fn version_info_cache_distinguishes_fresh_from_stale() {
        assert!(version_info_cache_is_fresh(
            1_000,
            1_000 + VERSION_INFO_CACHE_SECS - 1
        ));
        assert!(!version_info_cache_is_fresh(
            1_000,
            1_000 + VERSION_INFO_CACHE_SECS
        ));
    }

    #[test]
    fn build_runtime_state_payload_maps_snapshot_fields() {
        let payload = build_runtime_state_payload(WorkspaceRuntimeSnapshot {
            workspace_target: Some(WorkspaceTarget::Windows),
            workspace_label: "windows".to_string(),
            home_override: Some(r"C:\Users\yiyou\.codex".to_string()),
            connected: true,
            connected_at_unix_secs: Some(123),
            last_replay_cursor: 45,
            last_replay_last_event_id: Some(67),
            last_replay_at_unix_secs: Some(89),
        });
        assert_eq!(payload.workspace, "windows");
        assert_eq!(
            payload.home_override.as_deref(),
            Some(r"C:\Users\yiyou\.codex")
        );
        assert!(payload.connected);
        assert_eq!(payload.connected_at_unix_secs, Some(123));
        assert_eq!(payload.last_replay_cursor, 45);
        assert_eq!(payload.last_replay_last_event_id, Some(67));
        assert_eq!(payload.last_replay_at_unix_secs, Some(89));
        assert_eq!(payload.active_thread_count, 0);
    }

    #[test]
    fn normalize_runtime_home_override_trims_and_drops_empty() {
        assert_eq!(
            normalize_runtime_home_override(Some(r"  C:\Users\yiyou\.codex  ")).as_deref(),
            Some(r"C:\Users\yiyou\.codex")
        );
        assert_eq!(normalize_runtime_home_override(Some("   ")), None);
        assert_eq!(normalize_runtime_home_override(None), None);
    }

    #[test]
    fn runtime_state_payload_uses_registered_workspace_snapshot() {
        _clear_workspace_runtime_registry_for_test();
        mark_workspace_runtime_connected(Some(WorkspaceTarget::Wsl2), Some("/home/yiyou/.codex"));
        mark_workspace_runtime_replay(
            Some(WorkspaceTarget::Wsl2),
            Some("/home/yiyou/.codex"),
            12,
            Some(34),
        );
        upsert_workspace_thread_runtime(
            Some(WorkspaceTarget::Wsl2),
            Some("/home/yiyou/.codex"),
            crate::orchestrator::gateway::web_codex_session_runtime::WorkspaceThreadRuntimeUpdate {
                thread_id: "thread-1",
                cwd: Some("/home/yiyou/repo"),
                rollout_path: Some("/home/yiyou/.codex/sessions/rollout-thread-1.jsonl"),
                status: Some("running"),
                last_event_id: Some(34),
                last_turn_id: Some("turn-1"),
                clear_last_turn_id: false,
            },
        );
        let payload = build_runtime_state_payload(workspace_runtime_snapshot(
            Some(WorkspaceTarget::Wsl2),
            Some("/home/yiyou/.codex"),
        ));
        assert_eq!(payload.workspace, "wsl2");
        assert_eq!(payload.home_override.as_deref(), Some("/home/yiyou/.codex"));
        assert!(payload.connected);
        assert_eq!(payload.last_replay_cursor, 12);
        assert_eq!(payload.last_replay_last_event_id, Some(34));
        assert_eq!(payload.active_thread_count, 1);
    }
}
