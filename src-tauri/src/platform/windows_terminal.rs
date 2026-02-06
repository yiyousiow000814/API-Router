//! Windows Terminal integrations.
//!
//! Currently this module supports inferring `WT_SESSION` for a request by mapping the loopback TCP
//! connection to the owning process PID, then reading the process environment.

#[cfg(windows)]
use std::io::BufRead;
use std::net::SocketAddr;

#[cfg(windows)]
use std::sync::{Mutex, OnceLock};
#[cfg(windows)]
use std::time::{Duration, SystemTime};

#[derive(Clone, Debug)]
pub struct InferredWtSession {
    pub wt_session: String,
    pub pid: u32,
    pub codex_session_id: Option<String>,
    pub reported_model_provider: Option<String>,
    pub reported_base_url: Option<String>,
    pub router_confirmed: bool,
}

#[cfg(windows)]
fn parse_codex_session_id_from_cmdline(cmd: &str) -> Option<String> {
    // `codex` commonly launches as: `codex.exe resume <uuid>`.
    // If we see `resume`, take the next UUID token.
    let toks: Vec<&str> = cmd.split_whitespace().collect();
    for i in 0..toks.len() {
        if toks[i].eq_ignore_ascii_case("resume") {
            if let Some(next) = toks.get(i + 1) {
                if uuid::Uuid::parse_str(next).is_ok() {
                    return Some((*next).to_string());
                }
            }
        }
    }
    None
}

#[cfg(windows)]
fn looks_like_router_base(v: &str, port: u16) -> bool {
    let v = v.to_ascii_lowercase();
    let port_s = format!(":{port}");
    (v.contains("127.0.0.1") || v.contains("localhost")) && v.contains(&port_s)
}

#[cfg(windows)]
#[derive(Clone, Debug)]
struct RolloutSessionMeta {
    model_provider: Option<String>,
    base_url: Option<String>,
}

#[cfg(windows)]
fn parse_rollout_session_meta(first_line: &str) -> Option<RolloutSessionMeta> {
    let meta: serde_json::Value = serde_json::from_str(first_line.trim()).ok()?;
    let payload = meta.get("payload")?;
    let model_provider = payload
        .get("model_provider")
        .or_else(|| payload.get("modelProvider"))
        .and_then(|v| v.as_str())
        .and_then(|s| {
            let s = s.trim();
            if s.is_empty() {
                None
            } else {
                Some(s.to_string())
            }
        });
    let base_url = payload
        .get("base_url")
        .or_else(|| payload.get("model_provider_base_url"))
        .and_then(|v| v.as_str())
        .and_then(|s| {
            let s = s.trim();
            if s.is_empty() {
                None
            } else {
                Some(s.to_string())
            }
        });
    Some(RolloutSessionMeta {
        model_provider,
        base_url,
    })
}

#[cfg(windows)]
fn rollout_base_url_matches_router(meta: &RolloutSessionMeta, router_port: u16) -> Option<bool> {
    // We treat base_url as the source of truth. The provider name/id can be user-edited and is not
    // sufficient to prove the process is actually using this gateway.
    let u = meta.base_url.as_deref()?;
    Some(looks_like_router_base(u, router_port))
}

#[cfg(windows)]
fn parse_session_id_from_rollout_filename(path: &std::path::Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    if !name.to_ascii_lowercase().ends_with(".jsonl") {
        return None;
    }
    let stem = name.strip_suffix(".jsonl").unwrap_or(name);
    let last = stem.rsplit('-').next()?;
    if uuid::Uuid::parse_str(last).is_ok() {
        Some(last.to_string())
    } else {
        None
    }
}

#[cfg(windows)]
fn infer_codex_session_id_from_rollout_filenames(
    codex_home: &std::path::Path,
    process_start: Option<SystemTime>,
) -> Option<String> {
    // Codex writes rollouts as `.../sessions/YYYY/MM/DD/rollout-...-<uuid>.jsonl`.
    // Some rollouts can be locked for reading while Codex is running; we rely only on filenames
    // + filesystem timestamps here.
    let sessions_dir = codex_home.join("sessions");
    let mut stack: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&sessions_dir) {
        stack.extend(rd.flatten().map(|e| e.path()));
    } else {
        return None;
    }

    let mut candidates: Vec<(String, SystemTime)> = Vec::new();

    while let Some(p) = stack.pop() {
        let Ok(md) = std::fs::metadata(&p) else {
            continue;
        };
        if md.is_dir() {
            if let Ok(rd) = std::fs::read_dir(&p) {
                for e in rd.flatten() {
                    stack.push(e.path());
                }
            }
            continue;
        }
        if !md.is_file() {
            continue;
        }
        let Some(id) = parse_session_id_from_rollout_filename(&p) else {
            continue;
        };

        // `created()` is a better proxy for "session start" than `modified()` because the rollout
        // file can keep getting appended to during the session.
        let t = md
            .created()
            .ok()
            .or_else(|| md.modified().ok())
            .unwrap_or(SystemTime::UNIX_EPOCH);

        candidates.push((id, t));

        // Cap traversal to keep status polling cheap.
        if candidates.len() > 300 {
            break;
        }
    }

    if candidates.is_empty() {
        return None;
    }

    candidates.sort_by_key(|(_id, t)| std::cmp::Reverse(*t));

    // If we don't have a start time, keep the newest.
    let Some(start) = process_start else {
        return Some(candidates[0].0.clone());
    };

    // Prefer rollouts created at/after process start (small tolerance), and close in time.
    const BEFORE_TOLERANCE: Duration = Duration::from_secs(5);
    const MAX_WINDOW: Duration = Duration::from_secs(5 * 60);

    let mut best: Option<(&str, Duration)> = None;
    for (id, t) in candidates.iter().take(120) {
        if *t + BEFORE_TOLERANCE < start {
            continue;
        }
        let Some(dt) = t
            .duration_since(start)
            .ok()
            .or_else(|| start.duration_since(*t).ok())
        else {
            continue;
        };
        if dt > MAX_WINDOW {
            continue;
        }
        if best.map(|(_, bdt)| dt < bdt).unwrap_or(true) {
            best = Some((id.as_str(), dt));
        }
    }

    best.map(|(id, _dt)| id.to_string())
}

#[cfg(windows)]
fn auth_status(expected: &str, actual: Option<&str>) -> &'static str {
    match actual {
        Some(a) if a == expected => "match",
        Some(_) => "mismatch",
        None => "unknown",
    }
}

pub fn infer_wt_session(peer: SocketAddr, server_port: u16) -> Option<InferredWtSession> {
    #[cfg(not(windows))]
    {
        let _ = (peer, server_port);
        None
    }

    #[cfg(windows)]
    {
        let pid =
            crate::platform::windows_loopback_peer::infer_loopback_peer_pid(peer, server_port)?;
        let wt = crate::platform::windows_loopback_peer::read_process_env_var(pid, "WT_SESSION")?;
        if wt.trim().is_empty() {
            return None;
        }
        let codex_session_id =
            crate::platform::windows_loopback_peer::read_process_command_line(pid)
                .as_deref()
                .and_then(parse_codex_session_id_from_cmdline);
        Some(InferredWtSession {
            wt_session: wt,
            pid,
            codex_session_id,
            reported_model_provider: None,
            reported_base_url: None,
            router_confirmed: true,
        })
    }
}

#[cfg(windows)]
fn read_toml_model_provider_id(cfg: &toml::Value) -> Option<String> {
    let t = cfg.as_table()?;
    t.get("model_provider")
        .or_else(|| t.get("model_provider_id"))
        .and_then(|v| v.as_str())
        .and_then(|s| {
            let s = s.trim();
            if s.is_empty() {
                None
            } else {
                Some(s.to_string())
            }
        })
}

#[cfg(windows)]
fn read_toml_file(path: &std::path::Path) -> Option<toml::Value> {
    let s = std::fs::read_to_string(path).ok()?;
    toml::from_str::<toml::Value>(&s).ok()
}

#[cfg(windows)]
fn find_project_codex_config(cwd: &std::path::Path) -> Option<std::path::PathBuf> {
    // Walk up from cwd looking for `.codex/config.toml`.
    // Keep it bounded to avoid pathological traversals on deep paths.
    let mut cur = Some(cwd);
    for _ in 0..32 {
        let dir = cur?;
        let p = dir.join(".codex").join("config.toml");
        if p.exists() {
            return Some(p);
        }
        cur = dir.parent();
    }
    None
}

#[cfg(windows)]
pub fn best_effort_codex_model_provider_for_pid(pid: u32) -> Option<String> {
    use crate::platform::windows_loopback_peer;

    // 1) Match Codex precedence: project `.codex/config.toml` overrides CODEX_HOME config.
    if let Some(cwd) = windows_loopback_peer::read_process_cwd(pid) {
        if let Some(p) = find_project_codex_config(&cwd) {
            if let Some(cfg) = read_toml_file(&p) {
                if let Some(v) = read_toml_model_provider_id(&cfg) {
                    return Some(v);
                }
            }
        }
    }

    // 2) CODEX_HOME/config.toml if present for that process.
    if let Some(codex_home) = windows_loopback_peer::read_process_env_var(pid, "CODEX_HOME") {
        let p = std::path::PathBuf::from(codex_home).join("config.toml");
        if let Some(cfg) = read_toml_file(&p) {
            if let Some(v) = read_toml_model_provider_id(&cfg) {
                return Some(v);
            }
        }
    }

    // 3) Last-resort: current user's global config.
    if let Ok(up) = std::env::var("USERPROFILE") {
        let p = std::path::PathBuf::from(up)
            .join(".codex")
            .join("config.toml");
        if let Some(cfg) = read_toml_file(&p) {
            if let Some(v) = read_toml_model_provider_id(&cfg) {
                return Some(v);
            }
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let p = std::path::PathBuf::from(home)
            .join(".codex")
            .join("config.toml");
        if let Some(cfg) = read_toml_file(&p) {
            if let Some(v) = read_toml_model_provider_id(&cfg) {
                return Some(v);
            }
        }
    }

    None
}

#[cfg(not(windows))]
pub fn best_effort_codex_model_provider_for_pid(_pid: u32) -> Option<String> {
    None
}

pub fn discover_sessions_using_router(
    server_port: u16,
    expected_gateway_token: Option<&str>,
) -> Vec<InferredWtSession> {
    #[cfg(not(windows))]
    {
        let _ = (server_port, expected_gateway_token);
        Vec::new()
    }

    #[cfg(windows)]
    {
        #[derive(Clone)]
        struct Cache {
            updated_at_unix_ms: u64,
            items: Vec<InferredWtSession>,
        }

        fn now_unix_ms() -> u64 {
            use std::time::{SystemTime, UNIX_EPOCH};
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .ok()
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0)
        }

        static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
        let cache = CACHE.get_or_init(|| {
            Mutex::new(Cache {
                updated_at_unix_ms: 0,
                items: Vec::new(),
            })
        });

        // This scan involves cross-process memory reads; keep it cheap on frequent UI polling.
        const TTL_MS: u64 = 2_000;
        let now = now_unix_ms();
        {
            let guard = cache.lock().ok();
            if let Some(guard) = guard.as_ref() {
                if now.saturating_sub(guard.updated_at_unix_ms) < TTL_MS {
                    return guard.items.clone();
                }
            }
        }

        let items = discover_sessions_using_router_uncached(server_port, expected_gateway_token);
        if let Ok(mut guard) = cache.lock() {
            guard.updated_at_unix_ms = now;
            guard.items = items.clone();
        }
        items
    }
}

#[cfg(windows)]
fn discover_sessions_using_router_uncached(
    server_port: u16,
    expected_gateway_token: Option<&str>,
) -> Vec<InferredWtSession> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    fn wide_cstr_to_string(buf: &[u16]) -> String {
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }

    fn read_config(path: &std::path::Path) -> Option<toml::Value> {
        let s = std::fs::read_to_string(path).ok()?;
        toml::from_str::<toml::Value>(&s).ok()
    }

    fn read_config_with_mtime(path: &std::path::Path) -> Option<(toml::Value, SystemTime)> {
        let cfg = read_config(path)?;
        let mtime = std::fs::metadata(path).ok()?.modified().ok()?;
        Some((cfg, mtime))
    }

    fn read_auth_token(path: &std::path::Path) -> Option<String> {
        let s = std::fs::read_to_string(path).ok()?;
        let v: serde_json::Value = serde_json::from_str(&s).ok()?;
        v.get("OPENAI_API_KEY")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    }

    fn find_project_codex_config(cwd: &std::path::Path) -> Option<std::path::PathBuf> {
        // Walk up from cwd looking for `.codex/config.toml`.
        // Keep it bounded to avoid pathological traversals on deep paths.
        let mut cur = Some(cwd);
        for _ in 0..32 {
            let dir = cur?;
            let p = dir.join(".codex").join("config.toml");
            if p.exists() {
                return Some(p);
            }
            cur = dir.parent();
        }
        None
    }

    fn get_model_provider_id(cfg: &toml::Value) -> Option<String> {
        let t = cfg.as_table()?;
        t.get("model_provider")
            .or_else(|| t.get("model_provider_id"))
            .and_then(|v| v.as_str())
            .and_then(|s| {
                let s = s.trim();
                if s.is_empty() {
                    None
                } else {
                    Some(s.to_string())
                }
            })
    }

    fn get_provider_base_url(cfg: &toml::Value, provider_id: &str) -> Option<String> {
        cfg.as_table()?
            .get("model_providers")
            .and_then(|v| v.as_table())
            .and_then(|tbl| tbl.get(provider_id))
            .and_then(|v| v.as_table())
            .and_then(|tbl| tbl.get("base_url"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    }

    fn process_codex_home(pid: u32) -> Option<std::path::PathBuf> {
        // Prefer the target process env to avoid relying on our own environment.
        crate::platform::windows_loopback_peer::read_process_env_var(pid, "CODEX_HOME")
            .filter(|s| !s.trim().is_empty())
            .map(std::path::PathBuf::from)
            .or_else(|| {
                crate::platform::windows_loopback_peer::read_process_env_var(pid, "USERPROFILE")
                    .filter(|s| !s.trim().is_empty())
                    .map(|p| std::path::PathBuf::from(p).join(".codex"))
            })
            .or_else(|| {
                // Some shells (Git Bash / MSYS) use HOME.
                crate::platform::windows_loopback_peer::read_process_env_var(pid, "HOME")
                    .filter(|s| !s.trim().is_empty())
                    .map(|p| std::path::PathBuf::from(p).join(".codex"))
            })
            .or_else(|| {
                // Last-resort fallback: our process USERPROFILE.
                std::env::var("USERPROFILE")
                    .ok()
                    .filter(|s| !s.trim().is_empty())
                    .map(|p| std::path::PathBuf::from(p).join(".codex"))
            })
    }

    fn find_project_auth_json(cwd: &std::path::Path) -> Option<std::path::PathBuf> {
        // Walk up from cwd looking for `.codex/auth.json`.
        // Keep it bounded to avoid pathological traversals on deep paths.
        let mut cur = Some(cwd);
        for _ in 0..32 {
            let dir = cur?;
            let p = dir.join(".codex").join("auth.json");
            if p.exists() {
                return Some(p);
            }
            cur = dir.parent();
        }
        None
    }

    fn filetime_to_systemtime(ft: windows_sys::Win32::Foundation::FILETIME) -> Option<SystemTime> {
        // FILETIME is 100ns ticks since 1601-01-01 UTC.
        let ticks = ((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64);
        if ticks == 0 {
            return None;
        }
        let secs = ticks / 10_000_000;
        let nanos = (ticks % 10_000_000) * 100;
        // Seconds between 1601-01-01 and 1970-01-01.
        const EPOCH_DIFF_SECS: u64 = 11_644_473_600;
        let unix_secs = secs.checked_sub(EPOCH_DIFF_SECS)?;
        Some(SystemTime::UNIX_EPOCH + Duration::new(unix_secs, nanos as u32))
    }

    fn process_create_time(pid: u32) -> Option<SystemTime> {
        use windows_sys::Win32::Foundation::FILETIME;
        use windows_sys::Win32::System::Threading::{
            GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if h == 0 {
            return None;
        }
        let mut creation = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut exit = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut kernel = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut user = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let ok = unsafe { GetProcessTimes(h, &mut creation, &mut exit, &mut kernel, &mut user) };
        let _ = unsafe { CloseHandle(h) };
        if ok == 0 {
            return None;
        }
        filetime_to_systemtime(creation)
    }

    fn read_effective_codex_gateway_token_info(pid: u32) -> (Option<String>, Option<String>) {
        // (token, source)
        let cwd = crate::platform::windows_loopback_peer::read_process_cwd(pid);
        if let Some(cwd) = cwd.as_deref() {
            if let Some(p) = find_project_auth_json(cwd) {
                if let Some(tok) = read_auth_token(&p) {
                    return (Some(tok), Some("project_auth".to_string()));
                }
            }
        }
        if let Some(codex_home) = process_codex_home(pid) {
            if let Some(tok) = read_auth_token(&codex_home.join("auth.json")) {
                return (Some(tok), Some("codex_home_auth".to_string()));
            }
        }
        (None, None)
    }

    fn read_effective_codex_config_with_mtime(pid: u32) -> Option<(toml::Value, SystemTime)> {
        // Match Codex precedence: project `.codex/config.toml` (closest to cwd) overrides CODEX_HOME config.
        let cwd = crate::platform::windows_loopback_peer::read_process_cwd(pid);
        if let Some(cwd) = cwd.as_deref() {
            if let Some(p) = find_project_codex_config(cwd) {
                if let Some(cfg) = read_config_with_mtime(&p) {
                    return Some(cfg);
                }
            }
        }
        let codex_home = process_codex_home(pid)?;
        read_config_with_mtime(&codex_home.join("config.toml"))
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum BaseUrlEvidenceKind {
        Env,
        ConfigTrusted,
        ConfigUntrusted,
        None,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
    struct PidKey {
        pid: u32,
        // Helps avoid PID reuse bugs when the user keeps the app open for a long time.
        created_at_unix_ms: u64,
    }

    #[derive(Clone, Copy, Debug)]
    struct FrozenBaseUrlEvidence {
        kind: BaseUrlEvidenceKind,
        matches_router: bool,
    }

    fn systemtime_to_unix_ms(t: SystemTime) -> Option<u64> {
        t.duration_since(SystemTime::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_millis() as u64)
    }

    fn codex_base_url_evidence(pid: u32, port: u16) -> (BaseUrlEvidenceKind, bool) {
        // 1) Fast path: process env vars (strong signal).
        let keys = [
            "OPENAI_BASE_URL",
            "OPENAI_API_BASE",
            "OPENAI_BASE",
            "OPENAI_API_HOST",
        ];
        for k in keys {
            if let Some(v) = crate::platform::windows_loopback_peer::read_process_env_var(pid, k) {
                let v = v.trim();
                if v.is_empty() {
                    continue;
                }
                return (BaseUrlEvidenceKind::Env, looks_like_router_base(v, port));
            }
        }

        // 2) Config path: determine the selected model_provider, then resolve its base_url.
        let start = process_create_time(pid);
        let cfg = read_effective_codex_config_with_mtime(pid);
        let Some((cfg, cfg_mtime)) = cfg else {
            return (BaseUrlEvidenceKind::None, false);
        };

        let provider_id = get_model_provider_id(&cfg);
        let Some(provider_id) = provider_id else {
            return (BaseUrlEvidenceKind::None, false);
        };
        let base_url = get_provider_base_url(&cfg, &provider_id);
        let Some(base_url) = base_url else {
            return (BaseUrlEvidenceKind::None, false);
        };

        let matches = looks_like_router_base(&base_url, port);

        // If config was modified after the process started, it's an untrusted hint (the running
        // process keeps the old config in memory). Still useful as a fallback when combined with
        // rollout metadata to reduce false positives.
        let trusted = match start {
            Some(start) => cfg_mtime <= start + Duration::from_secs(2),
            None => true,
        };
        (
            if trusted {
                BaseUrlEvidenceKind::ConfigTrusted
            } else {
                BaseUrlEvidenceKind::ConfigUntrusted
            },
            matches,
        )
    }

    fn frozen_codex_base_url_evidence(pid: u32, port: u16) -> FrozenBaseUrlEvidence {
        // Codex effectively "freezes" its config at process start. If the user edits config.toml
        // later, the running process keeps using the old values. To avoid sessions appearing to
        // change/disappear due to on-disk edits while the app is open, we freeze our base_url
        // evidence per (pid, create_time) at first discovery too.
        static FROZEN: OnceLock<Mutex<std::collections::HashMap<PidKey, FrozenBaseUrlEvidence>>> =
            OnceLock::new();
        let frozen = FROZEN.get_or_init(|| Mutex::new(std::collections::HashMap::new()));

        let created_at = process_create_time(pid).and_then(systemtime_to_unix_ms);
        let key = PidKey {
            pid,
            created_at_unix_ms: created_at.unwrap_or(0),
        };

        if let Ok(mut guard) = frozen.lock() {
            // Prune dead PIDs opportunistically to keep the map bounded.
            guard.retain(|k, _| crate::platform::windows_loopback_peer::is_pid_alive(k.pid));
            if let Some(v) = guard.get(&key) {
                return *v;
            }

            let (kind, matches_router) = codex_base_url_evidence(pid, port);
            let v = FrozenBaseUrlEvidence {
                kind,
                matches_router,
            };
            guard.insert(key, v);
            return v;
        }

        // If locking fails, fall back to a non-frozen read.
        let (kind, matches_router) = codex_base_url_evidence(pid, port);
        FrozenBaseUrlEvidence {
            kind,
            matches_router,
        }
    }
    fn frozen_codex_session_id(pid: u32, cmd: Option<&str>, router_port: u16) -> Option<String> {
        let _ = router_port;
        // Session id inference from rollouts can "flip" when multiple Codex processes share the
        // same CWD and new rollouts are written. Freeze the inferred session id per PID for
        // stability during the process lifetime.
        static FROZEN: OnceLock<Mutex<std::collections::HashMap<PidKey, String>>> = OnceLock::new();
        let frozen = FROZEN.get_or_init(|| Mutex::new(std::collections::HashMap::new()));

        let created_at = process_create_time(pid).and_then(systemtime_to_unix_ms);
        let key = PidKey {
            pid,
            created_at_unix_ms: created_at.unwrap_or(0),
        };

        if let Ok(mut guard) = frozen.lock() {
            guard.retain(|k, _| crate::platform::windows_loopback_peer::is_pid_alive(k.pid));
            if let Some(v) = guard.get(&key) {
                return Some(v.clone());
            }
            // Prefer the explicit session id when Codex uses `resume <uuid>`.
            let inferred = cmd
                .and_then(parse_codex_session_id_from_cmdline)
                .or_else(|| {
                    // Best-effort: infer by matching recent rollout filenames to process start time.
                    // This avoids reading locked jsonl files and provides a session id before the first
                    // request, but can still be imperfect if multiple processes start at the same time.
                    let start = process_create_time(pid);
                    let codex_home = process_codex_home(pid)?;
                    infer_codex_session_id_from_rollout_filenames(&codex_home, start)
                });
            if let Some(id) = inferred.as_ref() {
                guard.insert(key, id.clone());
            }
            return inferred;
        }

        // If locking fails, fall back to a non-frozen inference.
        cmd.and_then(parse_codex_session_id_from_cmdline)
            .or_else(|| {
                let start = process_create_time(pid);
                let codex_home = process_codex_home(pid)?;
                infer_codex_session_id_from_rollout_filenames(&codex_home, start)
            })
    }

    fn latest_rollout_for_session(
        codex_home: &std::path::Path,
        session_id: &str,
    ) -> Option<std::path::PathBuf> {
        // Look for rollout files whose name ends with `-{session_id}.jsonl`; pick the newest.
        let sessions_dir = codex_home.join("sessions");
        let mut candidates: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&sessions_dir) {
            let mut stack: Vec<std::path::PathBuf> = rd.flatten().map(|e| e.path()).collect();
            while let Some(p) = stack.pop() {
                if let Ok(md) = std::fs::metadata(&p) {
                    if md.is_dir() {
                        if let Ok(rd2) = std::fs::read_dir(&p) {
                            for e in rd2.flatten() {
                                stack.push(e.path());
                            }
                        }
                    } else if md.is_file()
                        && p.file_name().and_then(|s| s.to_str()).is_some_and(|n| {
                            let n = n.to_ascii_lowercase();
                            n.starts_with("rollout-")
                                && n.ends_with(&format!(
                                    "-{}.jsonl",
                                    session_id.to_ascii_lowercase()
                                ))
                        })
                    {
                        if let Ok(mtime) = md.modified() {
                            candidates.push((p, mtime));
                        }
                    }
                }
            }
        }

        candidates.sort_by_key(|(_p, t)| std::cmp::Reverse(*t));
        candidates.into_iter().map(|(p, _t)| p).next()
    }

    fn frozen_codex_model_provider(pid: u32) -> Option<String> {
        static FROZEN: OnceLock<Mutex<std::collections::HashMap<PidKey, Option<String>>>> =
            OnceLock::new();
        let frozen = FROZEN.get_or_init(|| Mutex::new(std::collections::HashMap::new()));

        let created_at = process_create_time(pid).and_then(systemtime_to_unix_ms);
        let key = PidKey {
            pid,
            created_at_unix_ms: created_at.unwrap_or(0),
        };

        if let Ok(mut guard) = frozen.lock() {
            // Prune dead PIDs opportunistically to keep the map bounded.
            guard.retain(|k, _| crate::platform::windows_loopback_peer::is_pid_alive(k.pid));
            if let Some(v) = guard.get(&key) {
                return v.clone();
            }

            let v = read_effective_codex_config_with_mtime(pid)
                .and_then(|(cfg, _mtime)| get_model_provider_id(&cfg));
            let v = v.or_else(|| {
                // Last-resort fallback: our own user profile config. This is less specific than the
                // per-process "effective" config (which can be project-scoped), but it's still
                // better than showing an empty provider in the UI.
                let up = std::env::var("USERPROFILE").ok()?;
                let cfg = read_config(
                    &std::path::PathBuf::from(up)
                        .join(".codex")
                        .join("config.toml"),
                )?;
                get_model_provider_id(&cfg)
            });
            guard.insert(key, v.clone());
            return v;
        }

        // If locking fails, fall back to a non-frozen read.
        read_effective_codex_config_with_mtime(pid)
            .and_then(|(cfg, _mtime)| get_model_provider_id(&cfg))
            .or_else(|| {
                let up = std::env::var("USERPROFILE").ok()?;
                let cfg = read_config(
                    &std::path::PathBuf::from(up)
                        .join(".codex")
                        .join("config.toml"),
                )?;
                get_model_provider_id(&cfg)
            })
    }

    let mut out: Vec<InferredWtSession> = Vec::new();
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return out;
    }

    // Keep this conservative: scanning + env reads are not free.
    //
    // Note: Toolhelp32's `szExeFile` is documented as the executable name, but we've seen it show
    // up without the `.exe` suffix on some setups. Accept both forms to avoid false negatives.
    // Add more names only if we have strong evidence Codex runs under them.
    let candidates = ["codex.exe", "codex"];

    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while ok {
        let exe = wide_cstr_to_string(&entry.szExeFile);
        let exe_lc = exe.to_ascii_lowercase();
        if candidates.iter().any(|n| *n == exe_lc) {
            let pid = entry.th32ProcessID;

            // Must be inside Windows Terminal so we can map to a stable tab identity.
            let wt =
                crate::platform::windows_loopback_peer::read_process_env_var(pid, "WT_SESSION");
            if let Some(wt) = wt {
                let cmd = crate::platform::windows_loopback_peer::read_process_command_line(pid);
                let _cwd = crate::platform::windows_loopback_peer::read_process_cwd(pid)
                    .map(|p| p.to_string_lossy().to_string());

                // Ignore Codex background helpers that are not user sessions.
                if cmd
                    .as_deref()
                    .is_some_and(|s| s.to_ascii_lowercase().contains("app-server"))
                {
                    ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
                    continue;
                }

                // Infer session id early; we can use it as a stronger signal than the current on-disk config.
                let codex_session_id = frozen_codex_session_id(pid, cmd.as_deref(), server_port);

                // Token: exclude on explicit mismatch; allow unknown (e.g. keyring).
                if let Some(expected) = expected_gateway_token {
                    let (actual, _src) = read_effective_codex_gateway_token_info(pid);
                    if auth_status(expected, actual.as_deref()) == "mismatch" {
                        ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
                        continue;
                    }
                }

                // The rollout meta reflects what the process actually launched/resumed with.
                let codex_home = process_codex_home(pid);
                let rollout_meta = codex_home.as_deref().and_then(|h| {
                    let id = codex_session_id.as_deref()?;
                    let p = latest_rollout_for_session(h, id)?;
                    let file = std::fs::File::open(&p).ok()?;
                    let mut r = std::io::BufReader::new(file);
                    let mut first = String::new();
                    if r.read_line(&mut first).ok().unwrap_or(0) == 0 {
                        return None;
                    }
                    parse_rollout_session_meta(&first)
                });

                let matched = match rollout_meta
                    .as_ref()
                    .and_then(|m| rollout_base_url_matches_router(m, server_port))
                {
                    Some(v) => v,
                    None => {
                        // Only accept env vars or a config file that we consider "trusted" for this
                        // specific process lifetime. If the config has been edited after the
                        // process started, it is not evidence of the *running* base_url.
                        let ev = frozen_codex_base_url_evidence(pid, server_port);
                        ev.matches_router
                            && matches!(
                                ev.kind,
                                BaseUrlEvidenceKind::Env | BaseUrlEvidenceKind::ConfigTrusted
                            )
                    }
                };
                out.push(InferredWtSession {
                    wt_session: wt,
                    pid,
                    reported_model_provider: rollout_meta
                        .as_ref()
                        .and_then(|m| m.model_provider.clone())
                        .or_else(|| frozen_codex_model_provider(pid)),
                    reported_base_url: rollout_meta.as_ref().and_then(|m| m.base_url.clone()),
                    codex_session_id,
                    router_confirmed: matched,
                });
            }
        }

        ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }

    let _ = unsafe { CloseHandle(snapshot) };
    out
}

pub fn is_pid_alive(pid: u32) -> bool {
    crate::platform::windows_loopback_peer::is_pid_alive(pid)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn parse_rollout_session_meta_extracts_fields() {
        let line = r#"{"timestamp":"2026-02-01T17:54:58.654Z","type":"session_meta","payload":{"id":"00000000-0000-0000-0000-000000000000","cwd":"C:\\work\\example-project","model_provider":"api_router"}}"#;
        let m = parse_rollout_session_meta(line).expect("parse");
        assert_eq!(m.model_provider.as_deref(), Some("api_router"));
        assert!(m.base_url.is_none());
    }

    #[test]
    fn parse_rollout_session_meta_treats_empty_fields_as_missing() {
        let line = r#"{"type":"session_meta","payload":{"id":"x","cwd":"C:\\x","model_provider":"  ","base_url":"   "}}"#;
        let m = parse_rollout_session_meta(line).expect("parse");
        assert!(m.model_provider.is_none());
        assert!(m.base_url.is_none());
    }

    #[test]
    fn rollout_base_url_matches_router_prefers_base_url_when_present() {
        let line = r#"{"type":"session_meta","payload":{"id":"x","cwd":"C:\\x","model_provider":"api_router","base_url":"https://example.com/v1"}}"#;
        let m = parse_rollout_session_meta(line).expect("parse");
        assert_eq!(rollout_base_url_matches_router(&m, 4000), Some(false));
    }

    #[test]
    fn rollout_base_url_matches_router_is_none_when_base_url_missing() {
        let good = r#"{"type":"session_meta","payload":{"id":"x","cwd":"C:\\x","model_provider":"api_router"}}"#;
        let mg = parse_rollout_session_meta(good).expect("parse");
        assert_eq!(rollout_base_url_matches_router(&mg, 4000), None);
    }

    #[test]
    fn auth_status_is_stable() {
        assert_eq!(auth_status("t", Some("t")), "match");
        assert_eq!(auth_status("t", Some("x")), "mismatch");
        assert_eq!(auth_status("t", None), "unknown");
    }

    // NOTE: We intentionally do not infer Codex session ids by scanning rollouts; it is ambiguous
    // when multiple sessions share the same CWD.
}
