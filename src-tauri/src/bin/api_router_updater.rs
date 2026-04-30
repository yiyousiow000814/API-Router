#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::{self, Read};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::Value;

const APP_EXE_NAME: &str = "API Router.exe";
const UPDATER_EXE_NAME: &str = "API Router Updater.exe";
const LAN_SYNC_AUTH_NODE_ID_HEADER: &str = "x-api-router-lan-node-id";
const LAN_SYNC_AUTH_SECRET_HEADER: &str = "x-api-router-lan-secret";

#[derive(Debug, Serialize, Deserialize)]
struct VersionManifest {
    #[serde(rename = "gitSha")]
    git_sha: String,
    #[serde(rename = "exeSha256")]
    exe_sha256: Option<String>,
    #[serde(rename = "sourcePath")]
    source_path: String,
    reason: String,
    #[serde(rename = "installedAtUnixMs")]
    installed_at_unix_ms: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct RuntimePointer {
    #[serde(rename = "gitSha")]
    git_sha: String,
    #[serde(rename = "exePath")]
    exe_path: String,
    reason: Option<String>,
    #[serde(rename = "updatedAtUnixMs")]
    updated_at_unix_ms: u64,
}

#[derive(Clone)]
struct ServeState {
    repo_root: PathBuf,
    secret: String,
    status_path: Option<PathBuf>,
    active_operation: Arc<Mutex<Option<ActiveOperation>>>,
}

#[derive(Debug, Clone, Serialize)]
struct ActiveOperation {
    name: String,
    #[serde(rename = "startedAtUnixMs")]
    started_at_unix_ms: u64,
}

#[tokio::main]
async fn main() {
    if let Err(err) = run().await {
        eprintln!("{err}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let command = args.first().map(String::as_str).ok_or_else(usage)?;
    let repo_root = option_value(&args, "--repo-root")
        .map(PathBuf::from)
        .unwrap_or(env::current_dir().map_err(|err| format!("failed to resolve cwd: {err}"))?);
    match command {
        "backup" => {
            let git_sha = required_option(&args, "--git-sha")?;
            let source = option_value(&args, "--source")
                .map(PathBuf::from)
                .unwrap_or_else(|| repo_root.join(APP_EXE_NAME));
            backup_runtime(&repo_root, &git_sha, &source, "pre-update backup")?;
            write_pointer(&repo_root, "previous", &git_sha, Some("pre-update backup"))?;
            print_json(&serde_json::json!({ "ok": true, "previousGitSha": git_sha }))
        }
        "record-current" => {
            let git_sha = required_option(&args, "--git-sha")?;
            let source = option_value(&args, "--source")
                .map(PathBuf::from)
                .unwrap_or_else(|| repo_root.join(APP_EXE_NAME));
            backup_runtime(&repo_root, &git_sha, &source, "installed current runtime")?;
            write_pointer(
                &repo_root,
                "current",
                &git_sha,
                Some("remote update installed"),
            )?;
            print_json(&serde_json::json!({ "ok": true, "currentGitSha": git_sha }))
        }
        "rollback" => {
            let status_path = remote_update_status_path();
            rollback_runtime(
                &repo_root,
                args.iter().any(|arg| arg == "--start-hidden"),
                status_path.as_deref(),
            )?;
            print_json(&serde_json::json!({ "ok": true, "state": "rolled_back" }))
        }
        "status" => {
            let current = read_pointer(&repo_root, "current");
            let previous = read_pointer(&repo_root, "previous");
            print_json(&serde_json::json!({
                "ok": true,
                "current": current.ok(),
                "previous": previous.ok(),
                "updaterPath": repo_root.join(UPDATER_EXE_NAME),
            }))
        }
        "serve" => serve(&args, repo_root).await,
        _ => Err(usage()),
    }
}

fn usage() -> String {
    "usage: api_router_updater <backup|record-current|rollback|status|serve> --repo-root <path> [options]; serve requires --secret or API_ROUTER_REMOTE_UPDATE_LAN_SECRET"
        .to_string()
}

fn option_value(args: &[String], name: &str) -> Option<String> {
    args.windows(2)
        .find(|window| window[0] == name)
        .map(|window| window[1].clone())
}

fn required_option(args: &[String], name: &str) -> Result<String, String> {
    option_value(args, name)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{name} is required"))
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn versions_root(repo_root: &Path) -> PathBuf {
    repo_root.join("versions")
}

fn runtime_root(repo_root: &Path) -> PathBuf {
    repo_root.join("runtime")
}

fn version_exe_path(repo_root: &Path, git_sha: &str) -> PathBuf {
    versions_root(repo_root).join(git_sha).join(APP_EXE_NAME)
}

fn pointer_path(repo_root: &Path, name: &str) -> PathBuf {
    runtime_root(repo_root).join(format!("{name}.json"))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        fs::File::open(path).map_err(|err| format!("failed to open {}: {err}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|err| format!("failed to read {}: {err}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn backup_runtime(
    repo_root: &Path,
    git_sha: &str,
    source: &Path,
    reason: &str,
) -> Result<PathBuf, String> {
    if !source.is_file() {
        return Err(format!(
            "source executable is missing: {}",
            source.display()
        ));
    }
    let version_dir = versions_root(repo_root).join(git_sha);
    fs::create_dir_all(&version_dir)
        .map_err(|err| format!("failed to create {}: {err}", version_dir.display()))?;
    let dest = version_dir.join(APP_EXE_NAME);
    fs::copy(source, &dest).map_err(|err| {
        format!(
            "failed to copy {} to {}: {err}",
            source.display(),
            dest.display()
        )
    })?;
    let manifest = VersionManifest {
        git_sha: git_sha.to_string(),
        exe_sha256: Some(sha256_file(&dest)?),
        source_path: source.display().to_string(),
        reason: reason.to_string(),
        installed_at_unix_ms: now_unix_ms(),
    };
    write_json(&version_dir.join("manifest.json"), &manifest)?;
    Ok(dest)
}

fn write_pointer(
    repo_root: &Path,
    name: &str,
    git_sha: &str,
    reason: Option<&str>,
) -> Result<(), String> {
    let pointer = RuntimePointer {
        git_sha: git_sha.to_string(),
        exe_path: version_exe_path(repo_root, git_sha).display().to_string(),
        reason: reason.map(ToString::to_string),
        updated_at_unix_ms: now_unix_ms(),
    };
    write_json(&pointer_path(repo_root, name), &pointer)
}

fn read_pointer(repo_root: &Path, name: &str) -> Result<RuntimePointer, String> {
    let path = pointer_path(repo_root, name);
    let bytes =
        fs::read(&path).map_err(|err| format!("failed to read {}: {err}", path.display()))?;
    serde_json::from_slice(&bytes)
        .map_err(|err| format!("failed to parse {}: {err}", path.display()))
}

async fn serve(args: &[String], repo_root: PathBuf) -> Result<(), String> {
    let bind = required_option(args, "--bind")?
        .parse::<SocketAddr>()
        .map_err(|err| format!("invalid --bind address: {err}"))?;
    let secret = option_value(args, "--secret")
        .or_else(|| env::var("API_ROUTER_REMOTE_UPDATE_LAN_SECRET").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "--secret or API_ROUTER_REMOTE_UPDATE_LAN_SECRET is required".to_string())?;
    let state = ServeState {
        repo_root: repo_root.clone(),
        secret,
        status_path: remote_update_status_path(),
        active_operation: Arc::new(Mutex::new(None)),
    };
    let app = updater_router(state);
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .map_err(|err| format!("failed to bind updater listener {bind}: {err}"))?;
    write_updater_state(&repo_root, listener.local_addr().unwrap_or(bind))?;
    axum::serve(listener, app)
        .await
        .map_err(|err| format!("updater listener failed: {err}"))
}

fn updater_router(state: ServeState) -> Router {
    Router::new()
        .route("/status", get(updater_status_http))
        .route("/rollback", post(updater_rollback_http))
        .with_state(state)
}

fn write_updater_state(repo_root: &Path, bind: SocketAddr) -> Result<(), String> {
    let path = runtime_root(repo_root).join("updater-state.json");
    write_json(
        &path,
        &serde_json::json!({
            "bind": bind.to_string(),
            "pid": std::process::id(),
            "updatedAtUnixMs": now_unix_ms(),
        }),
    )
}

fn authorize_updater_request(
    headers: &HeaderMap,
    expected_secret: &str,
) -> Result<(), (StatusCode, Json<Value>)> {
    let node_id = headers
        .get(LAN_SYNC_AUTH_NODE_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| updater_auth_error("missing LAN sync node header"))?;
    let provided_secret = headers
        .get(LAN_SYNC_AUTH_SECRET_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| updater_auth_error("missing LAN sync secret header"))?;
    if node_id.is_empty() || provided_secret != expected_secret.trim() {
        return Err(updater_auth_error("invalid LAN updater credentials"));
    }
    Ok(())
}

fn updater_auth_error(message: &str) -> (StatusCode, Json<Value>) {
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({ "ok": false, "error": message })),
    )
}

fn active_operation_snapshot(state: &ServeState) -> Option<ActiveOperation> {
    state
        .active_operation
        .lock()
        .ok()
        .and_then(|operation| operation.clone())
}

struct ActiveOperationGuard {
    active_operation: Arc<Mutex<Option<ActiveOperation>>>,
}

impl Drop for ActiveOperationGuard {
    fn drop(&mut self) {
        if let Ok(mut operation) = self.active_operation.lock() {
            *operation = None;
        }
    }
}

fn begin_active_operation(
    state: &ServeState,
    name: &str,
) -> Result<ActiveOperationGuard, (StatusCode, Json<Value>)> {
    let mut operation = state
        .active_operation
        .lock()
        .map_err(|_| updater_busy_error("updater operation lock is poisoned", None))?;
    if let Some(active) = operation.clone() {
        return Err(updater_busy_error("updater is busy", Some(active)));
    }
    *operation = Some(ActiveOperation {
        name: name.to_string(),
        started_at_unix_ms: now_unix_ms(),
    });
    Ok(ActiveOperationGuard {
        active_operation: Arc::clone(&state.active_operation),
    })
}

fn updater_busy_error(message: &str, active: Option<ActiveOperation>) -> (StatusCode, Json<Value>) {
    (
        StatusCode::CONFLICT,
        Json(serde_json::json!({
            "ok": false,
            "error": message,
            "busy": true,
            "activeOperation": active,
        })),
    )
}

async fn updater_status_http(
    State(state): State<ServeState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(err) = authorize_updater_request(&headers, &state.secret) {
        return err.into_response();
    }
    let current = read_pointer(&state.repo_root, "current");
    let previous = read_pointer(&state.repo_root, "previous");
    let active_operation = active_operation_snapshot(&state);
    Json(serde_json::json!({
        "ok": true,
        "current": current.ok(),
        "previous": previous.ok(),
        "updaterPath": state.repo_root.join(UPDATER_EXE_NAME),
        "busy": active_operation.is_some(),
        "activeOperation": active_operation,
    }))
    .into_response()
}

async fn updater_rollback_http(
    State(state): State<ServeState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(err) = authorize_updater_request(&headers, &state.secret) {
        return err.into_response();
    }
    let _active_operation_guard = match begin_active_operation(&state, "rollback") {
        Ok(guard) => guard,
        Err(err) => return err.into_response(),
    };
    let repo_root = state.repo_root.clone();
    let status_path = state.status_path.clone();
    match tokio::task::spawn_blocking(move || {
        rollback_runtime(&repo_root, true, status_path.as_deref())
    })
    .await
    {
        Ok(Ok(())) => {
            Json(serde_json::json!({ "ok": true, "state": "rolled_back" })).into_response()
        }
        Ok(Err(err)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "ok": false, "error": err })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

fn remote_update_status_path() -> Option<PathBuf> {
    env::var("API_ROUTER_REMOTE_UPDATE_STATUS_PATH")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            env::var("API_ROUTER_USER_DATA_DIR")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .map(|value| {
                    PathBuf::from(value)
                        .join("diagnostics")
                        .join("lan-remote-update-status.json")
                })
        })
}

fn status_string(payload: &Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn status_u64(payload: &Value, key: &str) -> Option<u64> {
    payload.get(key).and_then(Value::as_u64)
}

fn read_status_payload(path: &Path) -> Value {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}))
}

struct RollbackStatusEvent<'a> {
    state: &'a str,
    phase: &'a str,
    label: &'a str,
    detail: &'a str,
    current_git_sha: Option<&'a str>,
    previous_git_sha: &'a str,
    terminal: bool,
    reason_code: Option<&'a str>,
}

fn record_status_event(status_path: &Path, event: RollbackStatusEvent<'_>) -> Result<(), String> {
    let existing = read_status_payload(status_path);
    let now = now_unix_ms();
    let timeline_state = if event.terminal {
        event.state
    } else {
        "running"
    };
    let mut timeline = existing
        .get("timeline")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    timeline.push(serde_json::json!({
        "unix_ms": now,
        "phase": event.phase,
        "label": event.label,
        "detail": event.detail,
        "source": "updater",
        "state": timeline_state,
    }));
    if timeline.len() > 24 {
        timeline = timeline.split_off(timeline.len() - 24);
    }
    let finished_at_unix_ms = if event.terminal { Some(now) } else { None };
    let progress_percent = if event.terminal { 100 } else { 96 };
    let payload = serde_json::json!({
        "state": event.state,
        "target_ref": status_string(&existing, "target_ref").unwrap_or_else(|| event.previous_git_sha.to_string()),
        "from_git_sha": status_string(&existing, "from_git_sha"),
        "to_git_sha": status_string(&existing, "to_git_sha"),
        "current_git_sha": event.current_git_sha.map(ToString::to_string).or_else(|| status_string(&existing, "current_git_sha")),
        "previous_git_sha": status_string(&existing, "previous_git_sha").unwrap_or_else(|| event.previous_git_sha.to_string()),
        "progress_percent": progress_percent,
        "rollback_available": true,
        "request_id": status_string(&existing, "request_id"),
        "reason_code": event.reason_code.map(ToString::to_string),
        "requester_node_id": status_string(&existing, "requester_node_id"),
        "requester_node_name": status_string(&existing, "requester_node_name"),
        "worker_script": status_string(&existing, "worker_script"),
        "worker_pid": existing.get("worker_pid").and_then(Value::as_u64),
        "worker_exit_code": existing.get("worker_exit_code").and_then(Value::as_i64),
        "detail": event.detail,
        "accepted_at_unix_ms": status_u64(&existing, "accepted_at_unix_ms").unwrap_or(now),
        "started_at_unix_ms": status_u64(&existing, "started_at_unix_ms"),
        "finished_at_unix_ms": finished_at_unix_ms,
        "updated_at_unix_ms": now,
        "timeline": timeline,
    });
    write_json(status_path, &payload)
}

fn record_rollback_status(
    status_path: &Path,
    previous_git_sha: &str,
    phase: &str,
    label: &str,
    detail: &str,
    terminal: bool,
) -> Result<(), String> {
    let state = if terminal { "rolled_back" } else { "running" };
    record_status_event(
        status_path,
        RollbackStatusEvent {
            state,
            phase,
            label,
            detail,
            current_git_sha: Some(previous_git_sha),
            previous_git_sha,
            terminal,
            reason_code: None,
        },
    )
}

fn record_rollback_failure(
    status_path: &Path,
    previous_git_sha: &str,
    error: &str,
) -> Result<(), String> {
    record_status_event(
        status_path,
        RollbackStatusEvent {
            state: "failed",
            phase: "rollback_failed",
            label: "Rollback failed",
            detail: &format!("Rollback failed: {error}"),
            current_git_sha: None,
            previous_git_sha,
            terminal: true,
            reason_code: Some("rollback_failed"),
        },
    )
}

fn rollback_runtime(
    repo_root: &Path,
    start_hidden: bool,
    status_path: Option<&Path>,
) -> Result<(), String> {
    let previous = read_pointer(repo_root, "previous")?;
    let previous_exe = PathBuf::from(&previous.exe_path);
    if !previous_exe.is_file() {
        return Err(format!(
            "previous runtime executable is missing: {}",
            previous_exe.display()
        ));
    }
    let target = repo_root.join(APP_EXE_NAME);
    if let Some(path) = status_path {
        let _ = record_rollback_status(
            path,
            &previous.git_sha,
            "rolling_back",
            "Rolling back runtime",
            &format!("Restoring previous version {}", previous.git_sha),
            false,
        );
    }
    let result: Result<(), String> = (|| {
        stop_api_router_processes(&target);
        wait_api_router_processes_stopped(&target, Duration::from_secs(10))?;
        copy_runtime_with_retry(&previous_exe, &target)?;
        write_pointer(
            repo_root,
            "current",
            &previous.git_sha,
            Some("remote update rollback"),
        )?;
        start_api_router(repo_root, &target, start_hidden)?;
        Ok::<(), String>(())
    })();
    match result {
        Ok(()) => {
            if let Some(path) = status_path {
                let _ = record_rollback_status(
                    path,
                    &previous.git_sha,
                    "rolled_back",
                    "Rolled back runtime",
                    &format!("Rolled back to {}", previous.git_sha),
                    true,
                );
            }
            Ok(())
        }
        Err(err) => {
            if let Some(path) = status_path {
                let _ = record_rollback_failure(path, &previous.git_sha, &err);
            }
            Err(err)
        }
    }
}

fn copy_runtime_with_retry(source: &Path, target: &Path) -> Result<(), String> {
    let mut last_error = None;
    for attempt in 1..=8 {
        match fs::copy(source, target) {
            Ok(_) => return Ok(()),
            Err(err) => {
                last_error = Some(err);
                stop_api_router_processes(target);
                let _ = wait_api_router_processes_stopped(target, Duration::from_secs(10));
                std::thread::sleep(Duration::from_millis(250 * attempt));
            }
        }
    }
    let err = last_error
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unknown copy error".to_string());
    Err(format!(
        "failed to restore {} to {} after retries: {err}",
        source.display(),
        target.display()
    ))
}

#[cfg(windows)]
fn api_router_process_ids_by_target(target: &Path) -> Vec<u32> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    fn widestr_to_string(value: &[u16]) -> String {
        let len = value.iter().position(|ch| *ch == 0).unwrap_or(value.len());
        OsString::from_wide(&value[..len])
            .to_string_lossy()
            .trim()
            .to_string()
    }

    fn normalized_path_key(path: &Path) -> String {
        let resolved = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let mut value = resolved.to_string_lossy().replace('/', "\\");
        if let Some(stripped) = value.strip_prefix(r"\\?\") {
            value = stripped.to_string();
        }
        value.trim_end_matches('\\').to_ascii_lowercase()
    }

    unsafe fn process_image_path(handle: isize) -> Option<PathBuf> {
        let mut buffer = vec![0u16; 32_768];
        let mut len = buffer.len() as u32;
        if QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut len as *mut u32) == 0 {
            return None;
        }
        Some(PathBuf::from(OsString::from_wide(&buffer[..len as usize])))
    }

    let target_key = normalized_path_key(target);
    let mut pids = Vec::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return pids;
        }
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..std::mem::zeroed()
        };
        let mut ok = Process32FirstW(snapshot, &mut entry as *mut PROCESSENTRY32W) != 0;
        while ok {
            let exe_name = widestr_to_string(&entry.szExeFile);
            if exe_name.eq_ignore_ascii_case(APP_EXE_NAME) {
                let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID);
                if handle != 0 {
                    if process_image_path(handle)
                        .as_deref()
                        .map(normalized_path_key)
                        .is_some_and(|process_key| process_key == target_key)
                    {
                        pids.push(entry.th32ProcessID);
                    }
                    let _ = CloseHandle(handle);
                }
            }
            ok = Process32NextW(snapshot, &mut entry as *mut PROCESSENTRY32W) != 0;
        }
        let _ = CloseHandle(snapshot);
    }
    pids
}

#[cfg(windows)]
fn stop_api_router_processes(target: &Path) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    for pid in api_router_process_ids_by_target(target) {
        unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if handle != 0 {
                let _ = TerminateProcess(handle, 1);
                let _ = CloseHandle(handle);
            }
        }
    }
}

#[cfg(windows)]
fn wait_api_router_processes_stopped(target: &Path, timeout: Duration) -> Result<(), String> {
    let deadline = std::time::Instant::now() + timeout;
    let mut remaining = api_router_process_ids_by_target(target);
    while !remaining.is_empty() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
        remaining = api_router_process_ids_by_target(target);
    }
    if remaining.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "timed out waiting for API Router.exe process(es) to exit before rollback restart: {:?}",
            remaining
        ))
    }
}

#[cfg(not(windows))]
fn stop_api_router_processes(_target: &Path) {}

#[cfg(not(windows))]
fn wait_api_router_processes_stopped(_target: &Path, _timeout: Duration) -> Result<(), String> {
    Ok(())
}

fn start_api_router(repo_root: &Path, target: &Path, start_hidden: bool) -> Result<(), String> {
    let mut command = Command::new(target);
    command.current_dir(repo_root);
    if start_hidden {
        command.arg("--start-hidden");
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
        .spawn()
        .map_err(|err| format!("failed to start {}: {err}", target.display()))?;
    Ok(())
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create {}: {err}", parent.display()))?;
    }
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|err| format!("failed to serialize {}: {err}", path.display()))?;
    fs::write(path, bytes).map_err(|err| format!("failed to write {}: {err}", path.display()))
}

fn print_json(value: &serde_json::Value) -> Result<(), String> {
    let stdout = io::stdout();
    serde_json::to_writer_pretty(stdout, value).map_err(|err| err.to_string())?;
    println!();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use http::{Method, Request, StatusCode};
    use tower::ServiceExt;

    fn unique_test_dir(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("api-router-updater-{name}-{}", now_unix_ms()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create test dir");
        path
    }

    fn test_serve_state(repo_root: PathBuf) -> ServeState {
        ServeState {
            repo_root,
            secret: "test-secret".to_string(),
            status_path: None,
            active_operation: Arc::new(Mutex::new(None)),
        }
    }

    async fn response_json(response: axum::response::Response) -> Value {
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("read response body");
        serde_json::from_slice(&bytes).expect("parse response json")
    }

    #[test]
    fn record_rollback_status_marks_status_rolled_back() {
        let dir = unique_test_dir("rollback-status");
        let status_path = dir
            .join("diagnostics")
            .join("lan-remote-update-status.json");
        write_json(
            &status_path,
            &serde_json::json!({
                "state": "succeeded",
                "target_ref": "bad1234567890",
                "from_git_sha": "good1234567890",
                "to_git_sha": "bad1234567890",
                "current_git_sha": "bad1234567890",
                "previous_git_sha": "good1234567890",
                "progress_percent": 100,
                "rollback_available": true,
                "request_id": "ru_1",
                "detail": "Remote self-update completed successfully.",
                "accepted_at_unix_ms": 1775312820000_u64,
                "started_at_unix_ms": 1775312821000_u64,
                "finished_at_unix_ms": 1775312829000_u64,
                "updated_at_unix_ms": 1775312829000_u64,
                "timeline": [
                    {
                        "unix_ms": 1775312829000_u64,
                        "phase": "completed",
                        "label": "Remote update completed",
                        "detail": "Remote self-update completed successfully.",
                        "source": "worker",
                        "state": "succeeded"
                    }
                ]
            }),
        )
        .expect("write initial status");

        record_rollback_status(
            &status_path,
            "good1234567890",
            "rolled_back",
            "Rolled back runtime",
            "Rolled back to good1234567890",
            true,
        )
        .expect("record rollback status");

        let payload: Value = serde_json::from_slice(&fs::read(&status_path).expect("read status"))
            .expect("parse status");
        assert_eq!(payload["state"], "rolled_back");
        assert_eq!(payload["current_git_sha"], "good1234567890");
        assert_eq!(payload["previous_git_sha"], "good1234567890");
        assert_eq!(payload["progress_percent"], 100);
        assert_eq!(payload["request_id"], "ru_1");
        assert_eq!(payload["timeline"][1]["phase"], "rolled_back");
        assert_eq!(payload["timeline"][1]["source"], "updater");
        assert!(payload["finished_at_unix_ms"].as_u64().unwrap() >= 1775312829000);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rollback_waits_for_runtime_process_exit_before_restart() {
        let source = fs::read_to_string(file!()).expect("read updater source");
        let rollback_start = source
            .find("fn rollback_runtime")
            .expect("rollback function");
        let rollback_body = &source[rollback_start..];
        let stop_index = rollback_body
            .find("stop_api_router_processes(&target);")
            .expect("rollback stops target runtime");
        let wait_index = rollback_body
            .find("wait_api_router_processes_stopped(&target, Duration::from_secs(10))?;")
            .expect("rollback waits for target runtime exit");
        let start_index = rollback_body
            .find("start_api_router(repo_root, &target, start_hidden)?;")
            .expect("rollback restarts runtime");
        assert!(stop_index < wait_index);
        assert!(wait_index < start_index);
    }

    #[tokio::test]
    async fn updater_status_http_reports_active_operation() {
        let dir = unique_test_dir("status-active-operation");
        let state = test_serve_state(dir.clone());
        *state
            .active_operation
            .lock()
            .expect("lock active operation") = Some(ActiveOperation {
            name: "rollback".to_string(),
            started_at_unix_ms: 1775312820000,
        });
        let app = updater_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/status")
                    .header(LAN_SYNC_AUTH_NODE_ID_HEADER, "node-a")
                    .header(LAN_SYNC_AUTH_SECRET_HEADER, "test-secret")
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("status response");

        assert_eq!(response.status(), StatusCode::OK);
        let payload = response_json(response).await;
        assert_eq!(payload["ok"], true);
        assert_eq!(payload["busy"], true);
        assert_eq!(payload["activeOperation"]["name"], "rollback");

        let _ = fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn updater_rollback_http_rejects_concurrent_rollback() {
        let dir = unique_test_dir("rollback-busy");
        let state = test_serve_state(dir.clone());
        *state
            .active_operation
            .lock()
            .expect("lock active operation") = Some(ActiveOperation {
            name: "rollback".to_string(),
            started_at_unix_ms: 1775312820000,
        });
        let app = updater_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/rollback")
                    .header(LAN_SYNC_AUTH_NODE_ID_HEADER, "node-a")
                    .header(LAN_SYNC_AUTH_SECRET_HEADER, "test-secret")
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("rollback response");

        assert_eq!(response.status(), StatusCode::CONFLICT);
        let payload = response_json(response).await;
        assert_eq!(payload["ok"], false);
        assert_eq!(payload["busy"], true);
        assert_eq!(payload["activeOperation"]["name"], "rollback");

        let _ = fs::remove_dir_all(dir);
    }
}
