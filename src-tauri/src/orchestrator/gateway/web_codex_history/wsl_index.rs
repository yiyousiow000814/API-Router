use super::ThreadHistoryPage;
use crate::diagnostics::codex_web_pipeline::{
    append_pipeline_event, elapsed_ms_u64, CodexWebPipelineEvent,
};
use crate::orchestrator::gateway::web_codex_home::{
    linux_path_join, parse_wsl_unc_to_linux_path, web_codex_wsl_launch_distro,
    web_codex_wsl_linux_home_override,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, Output, Stdio};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

const WSL_HISTORY_INDEX_SCRIPT: &str = include_str!("wsl_history_index.py");
const WSL_HISTORY_PREWARM_ITEMS: usize = 3;
const WSL_HISTORY_BUILD_TIMEOUT: Duration = Duration::from_secs(20);

#[cfg(test)]
type TestWslHistoryLoader = std::sync::Arc<
    dyn Fn(
            String,
            Option<String>,
            String,
            String,
            Option<String>,
            usize,
        ) -> Result<ThreadHistoryPage, String>
        + Send
        + Sync,
>;

#[cfg(test)]
fn test_wsl_history_loader() -> &'static std::sync::Mutex<Option<TestWslHistoryLoader>> {
    static LOADER: std::sync::OnceLock<std::sync::Mutex<Option<TestWslHistoryLoader>>> =
        std::sync::OnceLock::new();
    LOADER.get_or_init(|| std::sync::Mutex::new(None))
}

#[cfg(test)]
pub(super) fn _set_test_wsl_history_loader(loader: Option<TestWslHistoryLoader>) {
    match test_wsl_history_loader().lock() {
        Ok(mut guard) => *guard = loader,
        Err(err) => *err.into_inner() = loader,
    }
}

pub(super) fn load_wsl_history_page(
    thread_id: &str,
    workspace_value: Option<&str>,
    raw_rollout_path: &str,
    _rollout_local_path: &Path,
    linux_rollout_path: &str,
    before: Option<&str>,
    normalized_limit: usize,
) -> Result<ThreadHistoryPage, String> {
    #[cfg(test)]
    if let Some(loader) = match test_wsl_history_loader().lock() {
        Ok(guard) => guard.clone(),
        Err(err) => err.into_inner().clone(),
    } {
        return loader(
            thread_id.to_string(),
            workspace_value.map(str::to_string),
            raw_rollout_path.to_string(),
            linux_rollout_path.to_string(),
            before.map(str::to_string),
            normalized_limit,
        );
    }

    let build_running = wsl_history_build_job(linux_rollout_path).is_some();
    if should_wait_for_wsl_history_build(before, build_running) {
        wait_for_wsl_history_build(linux_rollout_path);
    }

    let cache_root = wsl_history_cache_root()?;
    let value = run_wsl_history_page_script(
        thread_id,
        workspace_value,
        raw_rollout_path,
        linux_rollout_path,
        before,
        normalized_limit,
        &cache_root,
    )?;
    let source = value
        .get("meta")
        .and_then(|meta| meta.get("source"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    if source == "wsl-tail-fast" {
        spawn_wsl_history_build(linux_rollout_path.to_string());
    }
    log_wsl_history_meta(value.get("meta"), raw_rollout_path);
    let mut thread = value.get("thread").cloned().unwrap_or(Value::Null);
    super::ensure_history_thread_path(&mut thread);
    Ok(ThreadHistoryPage {
        thread,
        page: value.get("page").cloned().unwrap_or(Value::Null),
    })
}

pub(super) fn spawn_wsl_history_prewarm(items: &[Value]) {
    let started = Instant::now();
    let jobs = wsl_history_prewarm_jobs_to_start(items);
    if !jobs.is_empty() {
        let mut pipeline = CodexWebPipelineEvent::new(
            "/codex/threads",
            "wsl2",
            "wsl_history_prewarm",
            elapsed_ms_u64(started),
        );
        pipeline.source = Some("wsl-history".to_string());
        pipeline.item_count = Some(jobs.len());
        pipeline.metrics = Some(json!({
            "startedCount": jobs.len(),
        }));
        append_pipeline_event(pipeline);
    }
    for linux_rollout_path in jobs {
        spawn_wsl_history_build(linux_rollout_path);
    }
}

fn should_wait_for_wsl_history_build(before: Option<&str>, build_running: bool) -> bool {
    build_running && before.map(str::trim).is_some_and(|value| !value.is_empty())
}

fn wsl_history_cache_root() -> Result<String, String> {
    let codex_home =
        web_codex_wsl_linux_home_override().ok_or_else(|| "missing WSL Codex home".to_string())?;
    Ok(linux_path_join(&codex_home, "api-router-history-cache-v1"))
}

fn build_wsl_history_python_args(extra: &[String]) -> Vec<String> {
    let mut args = Vec::with_capacity(extra.len() + 4);
    args.push("-e".to_string());
    args.push("python3".to_string());
    args.push("-".to_string());
    args.extend(extra.iter().cloned());
    args
}

#[cfg(test)]
fn estimate_wsl_launch_len(args: &[String]) -> usize {
    "wsl.exe".len() + args.iter().map(|arg| arg.len() + 1).sum::<usize>()
}

fn run_wsl_history_page_script(
    thread_id: &str,
    workspace_value: Option<&str>,
    raw_rollout_path: &str,
    linux_rollout_path: &str,
    before: Option<&str>,
    normalized_limit: usize,
    cache_root: &str,
) -> Result<Value, String> {
    let output = run_wsl_history_python(
        &[
            "page".to_string(),
            thread_id.to_string(),
            linux_rollout_path.to_string(),
            before.unwrap_or_default().to_string(),
            normalized_limit.to_string(),
            workspace_value.unwrap_or_default().to_string(),
            raw_rollout_path.to_string(),
            cache_root.to_string(),
        ],
        "reader",
        None,
    )?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "WSL history reader failed".to_string()
        } else {
            stderr
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    serde_json::from_str::<Value>(&stdout).map_err(|e| format!("invalid WSL history JSON: {e}"))
}

fn run_wsl_history_build_script(linux_rollout_path: &str, cache_root: &str) -> Result<(), String> {
    let output = run_wsl_history_python(
        &[
            "build-index".to_string(),
            linux_rollout_path.to_string(),
            cache_root.to_string(),
        ],
        "index builder",
        Some(WSL_HISTORY_BUILD_TIMEOUT),
    )?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "WSL history index builder failed".to_string()
        } else {
            stderr
        });
    }
    Ok(())
}

fn collect_child_output(
    child: &mut Child,
    status: std::process::ExitStatus,
    label: &str,
) -> Result<Output, String> {
    let mut stdout = Vec::new();
    if let Some(mut pipe) = child.stdout.take() {
        pipe.read_to_end(&mut stdout)
            .map_err(|e| format!("failed to read WSL history {label} stdout: {e}"))?;
    }
    let mut stderr = Vec::new();
    if let Some(mut pipe) = child.stderr.take() {
        pipe.read_to_end(&mut stderr)
            .map_err(|e| format!("failed to read WSL history {label} stderr: {e}"))?;
    }
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

fn wait_for_child_output(
    mut child: Child,
    label: &str,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let start = Instant::now();
    loop {
        match child
            .try_wait()
            .map_err(|e| format!("failed to poll WSL history {label}: {e}"))?
        {
            Some(status) => return collect_child_output(&mut child, status, label),
            None if start.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "WSL history {label} timed out after {}s",
                    timeout.as_secs()
                ));
            }
            None => std::thread::sleep(Duration::from_millis(25)),
        }
    }
}

fn run_wsl_history_python(
    extra: &[String],
    label: &str,
    timeout: Option<Duration>,
) -> Result<std::process::Output, String> {
    let args = build_wsl_history_python_args(extra);
    let mut cmd = std::process::Command::new("wsl.exe");
    if let Some(distro) = web_codex_wsl_launch_distro()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        cmd.arg("-d").arg(distro);
    }
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to launch WSL history {label}: {e}"))?;
    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("failed to open WSL history {label} stdin"))?;
        stdin
            .write_all(WSL_HISTORY_INDEX_SCRIPT.as_bytes())
            .map_err(|e| format!("failed to stream WSL history {label} script: {e}"))?;
    }
    match timeout {
        Some(timeout) => wait_for_child_output(child, label, timeout),
        None => child
            .wait_with_output()
            .map_err(|e| format!("failed to wait for WSL history {label}: {e}")),
    }
}

fn spawn_wsl_history_build(linux_rollout_path: String) {
    let cache_root = match wsl_history_cache_root() {
        Ok(value) => value,
        Err(_) => return,
    };
    let Some(_guard) = try_start_wsl_history_build(&linux_rollout_path) else {
        return;
    };
    std::thread::spawn(move || {
        let _guard = _guard;
        if let Err(err) = run_wsl_history_build_script(&linux_rollout_path, &cache_root) {
            log::warn!("wsl history background index build failed for {linux_rollout_path}: {err}");
        }
    });
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WslHistoryPrewarmCandidate {
    linux_rollout_path: String,
    revision: i64,
}

fn wsl_history_item_revision(item: &Value) -> i64 {
    match item.get("updatedAt") {
        Some(Value::Number(number)) => number.as_i64().unwrap_or(0),
        Some(Value::String(text)) => text.trim().parse::<i64>().unwrap_or(0),
        _ => 0,
    }
}

fn wsl_history_prewarm_candidates(items: &[Value]) -> Vec<WslHistoryPrewarmCandidate> {
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    for item in items {
        if candidates.len() >= WSL_HISTORY_PREWARM_ITEMS {
            break;
        }
        let workspace = item
            .get("workspace")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !workspace.eq_ignore_ascii_case("wsl2") {
            continue;
        }
        let Some(raw_path) = item
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some(linux_path) = parse_wsl_unc_to_linux_path(raw_path) else {
            continue;
        };
        if seen.insert(linux_path.clone()) {
            candidates.push(WslHistoryPrewarmCandidate {
                linux_rollout_path: linux_path,
                revision: wsl_history_item_revision(item),
            });
        }
    }
    candidates
}

#[cfg(test)]
fn wsl_history_prewarm_paths(items: &[Value]) -> Vec<String> {
    wsl_history_prewarm_candidates(items)
        .into_iter()
        .map(|candidate| candidate.linux_rollout_path)
        .collect()
}

fn wsl_history_prewarm_revisions() -> &'static Mutex<HashMap<String, i64>> {
    static REVISIONS: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
    REVISIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn wsl_history_prewarm_jobs_to_start(items: &[Value]) -> Vec<String> {
    let candidates = wsl_history_prewarm_candidates(items);
    let mut revisions = match wsl_history_prewarm_revisions().lock() {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    };
    candidates
        .into_iter()
        .filter_map(|candidate| {
            let previous = revisions
                .get(&candidate.linux_rollout_path)
                .copied()
                .unwrap_or(i64::MIN);
            if previous >= candidate.revision {
                return None;
            }
            revisions.insert(candidate.linux_rollout_path.clone(), candidate.revision);
            Some(candidate.linux_rollout_path)
        })
        .collect()
}

#[cfg(test)]
fn clear_wsl_history_prewarm_registry_for_test() {
    match wsl_history_prewarm_revisions().lock() {
        Ok(mut guard) => guard.clear(),
        Err(err) => err.into_inner().clear(),
    }
}

struct WslHistoryBuildJobState {
    completed: bool,
}

struct WslHistoryBuildJobSlot {
    state: Mutex<WslHistoryBuildJobState>,
    ready: Condvar,
}

fn wsl_history_build_jobs() -> &'static Mutex<HashMap<String, Arc<WslHistoryBuildJobSlot>>> {
    static JOBS: OnceLock<Mutex<HashMap<String, Arc<WslHistoryBuildJobSlot>>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn wsl_history_build_job(key: &str) -> Option<Arc<WslHistoryBuildJobSlot>> {
    let jobs = match wsl_history_build_jobs().lock() {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    };
    jobs.get(key).cloned()
}

fn try_start_wsl_history_build(key: &str) -> Option<WslHistoryBuildGuard> {
    let mut jobs = match wsl_history_build_jobs().lock() {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    };
    if jobs.contains_key(key) {
        return None;
    }
    jobs.insert(
        key.to_string(),
        Arc::new(WslHistoryBuildJobSlot {
            state: Mutex::new(WslHistoryBuildJobState { completed: false }),
            ready: Condvar::new(),
        }),
    );
    Some(WslHistoryBuildGuard {
        key: key.to_string(),
    })
}

fn wait_for_wsl_history_build(key: &str) {
    let Some(slot) = wsl_history_build_job(key) else {
        return;
    };
    let mut state = match slot.state.lock() {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    };
    while !state.completed {
        state = match slot.ready.wait(state) {
            Ok(guard) => guard,
            Err(err) => err.into_inner(),
        };
    }
}

struct WslHistoryBuildGuard {
    key: String,
}

impl Drop for WslHistoryBuildGuard {
    fn drop(&mut self) {
        let slot = {
            let mut jobs = match wsl_history_build_jobs().lock() {
                Ok(guard) => guard,
                Err(err) => err.into_inner(),
            };
            jobs.remove(&self.key)
        };
        let Some(slot) = slot else {
            return;
        };
        let mut state = match slot.state.lock() {
            Ok(guard) => guard,
            Err(err) => err.into_inner(),
        };
        state.completed = true;
        slot.ready.notify_all();
    }
}

fn log_wsl_history_meta(meta: Option<&Value>, raw_rollout_path: &str) {
    let Some(meta) = meta else {
        return;
    };
    let source = meta
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let build_ms = meta.get("buildMs").and_then(Value::as_u64).unwrap_or(0);
    let page_ms = meta.get("pageMs").and_then(Value::as_u64).unwrap_or(0);
    let total_ms = meta.get("totalMs").and_then(Value::as_u64).unwrap_or(0);
    if source != "wsl-index-hit" || build_ms > 0 || total_ms > 500 {
        log::warn!(
            "wsl history read source={source} build_ms={build_ms} page_ms={page_ms} total_ms={total_ms} rollout={raw_rollout_path}"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_wsl_history_python_args, clear_wsl_history_prewarm_registry_for_test,
        estimate_wsl_launch_len, should_wait_for_wsl_history_build, wait_for_child_output,
        wsl_history_cache_root, wsl_history_prewarm_jobs_to_start, wsl_history_prewarm_paths,
    };
    use serde_json::json;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    struct EnvGuard {
        key: &'static str,
        prev: Option<String>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let prev = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, prev }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            if let Some(prev) = self.prev.as_deref() {
                std::env::set_var(self.key, prev);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    #[test]
    fn wsl_history_cache_root_stays_under_codex_home() {
        let _test_guard = crate::codex_app_server::lock_test_globals();
        let _home = EnvGuard::set("API_ROUTER_WEB_CODEX_WSL_CODEX_HOME", "/home/test/.codex");
        assert_eq!(
            wsl_history_cache_root().expect("cache root"),
            "/home/test/.codex/api-router-history-cache-v1"
        );
    }

    #[test]
    fn wsl_history_prewarm_paths_take_recent_unique_wsl_rollouts() {
        let items = vec![
            json!({
                "workspace": "wsl2",
                "path": r"\\wsl.localhost\Ubuntu\home\test\.codex\sessions\a.jsonl",
            }),
            json!({
                "workspace": "windows",
                "path": r"C:\Users\test\.codex\sessions\b.jsonl",
            }),
            json!({
                "workspace": "wsl2",
                "path": r"\\wsl.localhost\Ubuntu\home\test\.codex\sessions\a.jsonl",
            }),
            json!({
                "workspace": "wsl2",
                "path": r"\\wsl.localhost\Ubuntu\home\test\.codex\sessions\c.jsonl",
            }),
            json!({
                "workspace": "wsl2",
                "path": r"\\wsl.localhost\Ubuntu\home\test\.codex\sessions\d.jsonl",
            }),
            json!({
                "workspace": "wsl2",
                "path": r"\\wsl.localhost\Ubuntu\home\test\.codex\sessions\e.jsonl",
            }),
        ];
        assert_eq!(
            wsl_history_prewarm_paths(&items),
            vec![
                "/home/test/.codex/sessions/a.jsonl".to_string(),
                "/home/test/.codex/sessions/c.jsonl".to_string(),
                "/home/test/.codex/sessions/d.jsonl".to_string(),
            ]
        );
    }

    #[test]
    fn wsl_history_prewarm_jobs_to_start_skips_already_requested_revision() {
        let _test_guard = crate::codex_app_server::lock_test_globals();
        clear_wsl_history_prewarm_registry_for_test();
        let items = vec![json!({
            "workspace": "wsl2",
            "path": r"\\wsl.localhost\Ubuntu\home\test\.codex\sessions\a.jsonl",
            "updatedAt": 1742331000
        })];

        assert_eq!(
            wsl_history_prewarm_jobs_to_start(&items),
            vec!["/home/test/.codex/sessions/a.jsonl".to_string()]
        );
        assert!(
            wsl_history_prewarm_jobs_to_start(&items).is_empty(),
            "unchanged WSL history prewarm should not relaunch wsl.exe on every thread poll"
        );

        let newer_items = vec![json!({
            "workspace": "wsl2",
            "path": r"\\wsl.localhost\Ubuntu\home\test\.codex\sessions\a.jsonl",
            "updatedAt": 1742331001
        })];
        assert_eq!(
            wsl_history_prewarm_jobs_to_start(&newer_items),
            vec!["/home/test/.codex/sessions/a.jsonl".to_string()]
        );
        clear_wsl_history_prewarm_registry_for_test();
    }

    #[test]
    fn initial_latest_page_does_not_wait_for_background_build() {
        assert!(!should_wait_for_wsl_history_build(None, true));
        assert!(!should_wait_for_wsl_history_build(Some(""), true));
        assert!(should_wait_for_wsl_history_build(Some("cursor-1"), true));
        assert!(!should_wait_for_wsl_history_build(Some("cursor-1"), false));
    }

    #[test]
    fn wsl_history_page_command_stays_under_windows_limit_for_long_rollout_paths() {
        let args = build_wsl_history_python_args(&[
            "page".to_string(),
            "019c7766-db34-7c43-a808-b2e8f356c907".to_string(),
            "/home/yiyou/.codex/sessions/2026/02/20/rollout-2026-02-20T03-35-55-019c7766-db34-7c43-a808-b2e8f356c907.jsonl".to_string(),
            String::new(),
            "25".to_string(),
            "wsl2".to_string(),
            r"\\wsl.localhost\Ubuntu\home\yiyou\.codex\sessions\2026\02\20\rollout-2026-02-20T03-35-55-019c7766-db34-7c43-a808-b2e8f356c907.jsonl".to_string(),
            "/home/yiyou/.codex/api-router-history-cache-v1".to_string(),
        ]);
        assert_eq!(args[0], "-e");
        assert_eq!(args[1], "python3");
        assert_eq!(args[2], "-");
        assert!(
            estimate_wsl_launch_len(&args) < 32_767,
            "wsl.exe command line exceeded Windows limit: {}",
            estimate_wsl_launch_len(&args)
        );
    }

    #[test]
    fn wsl_history_result_normalizes_thread_path_from_rollout_path() {
        let mut thread = json!({
            "id": "thread-wsl",
            "rolloutPath": "/home/test/.codex/sessions/2026/03/20/rollout-thread-wsl.jsonl",
        });
        super::super::ensure_history_thread_path(&mut thread);
        assert_eq!(
            thread.get("path").and_then(serde_json::Value::as_str),
            Some("/home/test/.codex/sessions/2026/03/20/rollout-thread-wsl.jsonl")
        );
    }

    fn run_wsl_history_python_self_test() -> Result<std::process::Output, String> {
        let script_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("orchestrator")
            .join("gateway")
            .join("web_codex_history")
            .join("wsl_history_index.py");
        let candidates: &[(&str, &[&str])] = if cfg!(windows) {
            &[("python", &[]), ("py", &["-3"]), ("python3", &[])]
        } else {
            &[("python3", &[]), ("python", &[])]
        };
        let mut last_error = String::new();
        for (program, prefix_args) in candidates {
            let mut command = Command::new(program);
            command
                .args(*prefix_args)
                .arg(&script_path)
                .arg("self-test");
            match command.output() {
                Ok(output) => return Ok(output),
                Err(err) => last_error = format!("{program}: {err}"),
            }
        }
        Err(format!(
            "failed to launch python for WSL history self-test: {last_error}"
        ))
    }

    #[test]
    fn wsl_history_python_script_self_test_passes() {
        let output =
            run_wsl_history_python_self_test().expect("launch WSL history python self-test");
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            output.status.success(),
            "WSL history python self-test failed.\nstdout:\n{stdout}\nstderr:\n{stderr}"
        );
        assert!(
            stdout.contains("\"ok\":true"),
            "unexpected WSL history python self-test stdout: {stdout}"
        );
    }

    #[test]
    fn wait_for_child_output_times_out_and_kills_stuck_process() {
        let mut command = if cfg!(windows) {
            let powershell = std::env::var("WINDIR")
                .map(|windir| format!(r"{windir}\System32\WindowsPowerShell\v1.0\powershell.exe"))
                .unwrap_or_else(|_| {
                    String::from(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")
                });
            let mut cmd = Command::new(powershell);
            cmd.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 5"]);
            cmd
        } else {
            let mut cmd = Command::new("sh");
            cmd.args(["-lc", "sleep 5"]);
            cmd
        };
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        let child = command.spawn().expect("spawn stuck process");
        let started = Instant::now();
        let err = wait_for_child_output(child, "test timeout", Duration::from_millis(100))
            .expect_err("timeout");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "timeout helper took too long: {:?}",
            started.elapsed()
        );
        assert!(err.contains("timed out"), "unexpected timeout error: {err}");
    }
}
