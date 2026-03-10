use super::*;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

#[derive(Deserialize)]
pub(super) struct TerminalExecRequest {
    pub(super) command: String,
    #[serde(default)]
    pub(super) cwd: Option<String>,
}

#[derive(Clone, Serialize, Debug, PartialEq, Eq)]
pub(super) struct CodexVersionInfo {
    windows: String,
    wsl2: String,
    #[serde(rename = "windowsInstalled")]
    windows_installed: bool,
    #[serde(rename = "wsl2Installed")]
    wsl2_installed: bool,
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

pub(super) fn truncate_output(value: &[u8]) -> (String, bool) {
    if value.len() <= MAX_TERMINAL_OUTPUT_BYTES {
        return (String::from_utf8_lossy(value).to_string(), false);
    }
    let head = &value[..MAX_TERMINAL_OUTPUT_BYTES];
    (String::from_utf8_lossy(head).to_string(), true)
}

async fn run_version_cmd(mut cmd: Command) -> Option<String> {
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
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.to_string())
}

async fn detect_windows_codex_version() -> String {
    let mut cmd = Command::new("cmd.exe");
    cmd.arg("/C").arg("codex --version");
    if let Some(found) = run_version_cmd(cmd).await {
        return found;
    }

    if let Ok(appdata) = std::env::var("APPDATA") {
        let candidate = PathBuf::from(appdata).join("npm").join("codex.cmd");
        if candidate.exists() {
            let mut cmd = Command::new("cmd.exe");
            cmd.arg("/C").arg(candidate).arg("--version");
            if let Some(found) = run_version_cmd(cmd).await {
                return found;
            }
        }
    }
    "Not installed".to_string()
}

async fn detect_wsl_codex_version() -> String {
    let mut cmd = Command::new("wsl.exe");
    cmd.arg("-e").arg("bash").arg("-lc").arg("codex --version");
    if let Some(found) = run_version_cmd(cmd).await {
        return found;
    }
    "Not installed".to_string()
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
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(repo_root).arg("rev-parse").arg("HEAD");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
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
    windows: String,
    wsl2: String,
    build_git_sha: String,
    build_git_short_sha: String,
    repo_git_sha: Option<String>,
) -> CodexVersionInfo {
    let repo_git_short_sha = short_git_sha(repo_git_sha.as_deref());
    let build_stale = repo_git_sha
        .as_deref()
        .is_some_and(|repo| !build_git_sha.eq_ignore_ascii_case(repo));
    CodexVersionInfo {
        windows_installed: windows != "Not installed",
        wsl2_installed: wsl2 != "Not installed",
        windows,
        wsl2,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        build_git_sha,
        build_git_short_sha,
        repo_git_sha,
        repo_git_short_sha,
        build_stale,
    }
}

pub(super) async fn codex_version_info(
    State(st): State<GatewayState>,
    headers: HeaderMap,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let now = current_unix_secs();
    if let Some(cached) = lock_codex_version_info_cache().clone() {
        if now.saturating_sub(cached.updated_at_unix_secs) < VERSION_INFO_CACHE_SECS {
            return Json(cached.value).into_response();
        }
    }

    let (windows, wsl2) = tokio::join!(detect_windows_codex_version(), detect_wsl_codex_version());
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
            updated_at_unix_secs: now,
        });
    }
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
            "codex 1.0.0".to_string(),
            "Not installed".to_string(),
            "abc12345".to_string(),
            "abc12345".to_string(),
            Some("fff00000".to_string()),
        );
        assert!(payload.windows_installed);
        assert!(!payload.wsl2_installed);
        assert_eq!(payload.repo_git_short_sha, Some("fff00000".to_string()));
        assert!(payload.build_stale);
    }
}
