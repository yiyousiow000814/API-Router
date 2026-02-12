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
    pub is_agent: bool,
}

#[cfg(windows)]
fn parse_codex_session_id_from_cmdline(cmd: &str) -> Option<String> {
    // Codex sometimes launches as: `codex.exe resume <uuid>`.
    //
    // But we also see runs with no args, and different flags across versions.
    // Keep this tolerant: prefer an id after a known keyword/flag; otherwise fall back
    // to a single UUID token if unambiguous.

    fn normalize_uuid_token(tok: &str) -> Option<String> {
        let t =
            tok.trim_matches(|c: char| c == '"' || c == '\'' || c == '(' || c == ')' || c == ',');
        uuid::Uuid::parse_str(t).ok().map(|_| t.to_string())
    }

    let toks: Vec<&str> = cmd.split_whitespace().collect();

    // 1) Keyword form: `resume <uuid>` (or `--resume <uuid>`).
    for i in 0..toks.len() {
        let t = toks[i];
        if t.eq_ignore_ascii_case("resume") || t.eq_ignore_ascii_case("--resume") {
            if let Some(next) = toks.get(i + 1) {
                if let Some(id) = normalize_uuid_token(next) {
                    return Some(id);
                }
            }
        }
    }

    // 2) Flag forms: `--session-id <uuid>` or `--session-id=<uuid>` (future-proof).
    for i in 0..toks.len() {
        let t = toks[i];
        if t.eq_ignore_ascii_case("--session-id") || t.eq_ignore_ascii_case("--session") {
            if let Some(next) = toks.get(i + 1) {
                if let Some(id) = normalize_uuid_token(next) {
                    return Some(id);
                }
            }
        }
        if let Some((k, v)) = t.split_once('=') {
            if k.eq_ignore_ascii_case("--session-id") || k.eq_ignore_ascii_case("--session") {
                if let Some(id) = normalize_uuid_token(v) {
                    return Some(id);
                }
            }
        }
    }

    // 3) Last resort: if there is exactly one UUID token anywhere, use it.
    let mut unique: Option<String> = None;
    for t in toks {
        let Some(id) = normalize_uuid_token(t) else {
            continue;
        };
        match unique.as_ref() {
            None => unique = Some(id),
            Some(prev) if prev == &id => {}
            Some(_) => return None,
        }
    }
    unique
}

#[cfg(windows)]
fn looks_like_router_base(v: &str, port: u16) -> bool {
    let v = v.to_ascii_lowercase();
    let port_s = format!(":{port}");
    (v.contains("127.0.0.1") || v.contains("localhost")) && v.contains(&port_s)
}

#[cfg(windows)]
fn norm_cwd_for_match(s: &str) -> String {
    // Codex rollouts and process CWD can differ only by trailing slashes or path separators.
    s.trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

#[cfg(windows)]
#[derive(Clone, Debug)]
struct RolloutSessionMeta {
    id: String,
    cwd: String,
    model_provider: Option<String>,
    base_url: Option<String>,
    is_agent: bool,
}

#[cfg(windows)]
fn rollout_source_is_agent(source: Option<&serde_json::Value>) -> bool {
    let Some(source) = source else {
        return false;
    };
    match source {
        // V1/V2 wire shapes: {"subagent": {...}} / {"subAgent": {...}}
        serde_json::Value::Object(map) => {
            map.contains_key("subagent") || map.contains_key("subAgent")
        }
        serde_json::Value::String(s) => s.to_ascii_lowercase().contains("subagent"),
        _ => false,
    }
}

#[cfg(windows)]
fn parse_rollout_session_meta(first_line: &str) -> Option<RolloutSessionMeta> {
    let meta: serde_json::Value = serde_json::from_str(first_line.trim()).ok()?;
    let payload = meta.get("payload")?;
    let id = payload.get("id")?.as_str()?.to_string();
    let cwd = payload
        .get("cwd")
        .or_else(|| payload.get("working_directory"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let model_provider = payload
        .get("model_provider")
        .or_else(|| payload.get("modelProvider"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let base_url = payload
        .get("base_url")
        .or_else(|| payload.get("model_provider_base_url"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let is_agent = rollout_source_is_agent(payload.get("source"));
    Some(RolloutSessionMeta {
        id,
        cwd,
        model_provider,
        base_url,
        is_agent,
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
fn infer_codex_session_id_from_rollouts_dir(
    codex_home: &std::path::Path,
    cwd: &std::path::Path,
    router_port: u16,
    process_start: Option<SystemTime>,
) -> Option<String> {
    let cwd_norm = norm_cwd_for_match(&cwd.to_string_lossy());

    // Scan recent rollouts for a matching cwd. Prefer a base_url match if present; otherwise fall
    // back to newest cwd match.
    let sessions_dir = codex_home.join("sessions");
    let mut entries: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&sessions_dir) {
        // Layout is typically sessions/YYYY/MM/DD/*.jsonl; recurse to collect rollouts.
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
                    && p.extension()
                        .and_then(|s| s.to_str())
                        .is_some_and(|s| s.eq_ignore_ascii_case("jsonl"))
                    && p.file_name()
                        .and_then(|s| s.to_str())
                        .is_some_and(|n| n.to_ascii_lowercase().starts_with("rollout-"))
                {
                    // Prefer create time: rollouts are appended to, which updates `modified()` and
                    // breaks "closest to process start" inference. `created()` is stable for the
                    // file lifetime on Windows.
                    let t = md.created().or_else(|_| md.modified());
                    if let Ok(t) = t {
                        entries.push((p, t));
                    }
                }
            }
            // Cap traversal to avoid pathological scans.
            if entries.len() > 800 {
                break;
            }
        }
    }

    // Newest first; cap scan size to keep UI polling cheap.
    entries.sort_by_key(|(_p, t)| std::cmp::Reverse(*t));
    entries.truncate(60);

    #[derive(Clone)]
    struct Candidate {
        id: String,
        created: SystemTime,
        base_url_matches_router: Option<bool>,
    }

    let mut candidates: Vec<Candidate> = Vec::new();

    for (p, created) in entries {
        let file = std::fs::File::open(&p).ok();
        let Some(file) = file else {
            continue;
        };
        let mut r = std::io::BufReader::new(file);
        let mut first = String::new();
        if r.read_line(&mut first).ok().unwrap_or(0) == 0 {
            continue;
        }
        let Some(m) = parse_rollout_session_meta(&first) else {
            // Some rollouts may not start with a session_meta line; keep scanning.
            continue;
        };
        if m.cwd.is_empty() {
            continue;
        }
        if norm_cwd_for_match(&m.cwd) != cwd_norm {
            continue;
        }

        let base_url_matches_router = rollout_base_url_matches_router(&m, router_port);
        candidates.push(Candidate {
            id: m.id,
            created,
            base_url_matches_router,
        });
    }

    if candidates.is_empty() {
        return None;
    }

    // Pick the candidate whose rollout time is closest to the process start time (helps avoid
    // misattributing multiple running Codex processes in the same CWD to the newest session).
    // If we don't have a start time, keep the newest (already sorted by mtime desc).
    let pick_closest = |cands: &[Candidate], start: SystemTime| -> Option<String> {
        const MAX_WINDOW: Duration = Duration::from_secs(120);
        let mut best: Option<(&Candidate, Duration)> = None;
        for c in cands {
            let Some(dt) = (if c.created >= start {
                c.created.duration_since(start).ok()
            } else {
                start.duration_since(c.created).ok()
            }) else {
                continue;
            };
            if dt > MAX_WINDOW {
                continue;
            }
            if best.map(|(_, bdt)| dt < bdt).unwrap_or(true) {
                best = Some((c, dt));
            }
        }
        best.map(|(c, _dt)| c.id.clone())
    };

    // 1) If any candidate recorded a base_url matching this router, prefer those.
    let router_matches: Vec<Candidate> = candidates
        .iter()
        .filter(|&c| c.base_url_matches_router == Some(true))
        .cloned()
        .collect();
    if !router_matches.is_empty() {
        if let Some(start) = process_start {
            if let Some(id) = pick_closest(&router_matches, start) {
                return Some(id);
            }
        }
        // Fall back to newest router match.
        return Some(router_matches[0].id.clone());
    }

    // 2) Otherwise fall back to the closest-by-time cwd match, else newest.
    if let Some(start) = process_start {
        // If we can't find a rollout close to process start, do not guess. Guessing causes
        // "session id flips" and duplicate/merged rows when multiple Codex processes share a CWD.
        return pick_closest(&candidates, start);
    }
    Some(candidates[0].id.clone())
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
            is_agent: false,
        })
    }
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
            .map(|s| s.to_string())
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

    fn read_process_codex_session_id(pid: u32) -> Option<String> {
        // New Codex sessions don't always include `resume <uuid>` in argv. Try env vars first.
        // Keep this defensive: only accept valid UUIDs.
        let keys = ["CODEX_SESSION_ID", "CODEX_SESSION", "CODEX_SESSIONID"];
        for k in keys {
            let Some(v) = crate::platform::windows_loopback_peer::read_process_env_var(pid, k)
            else {
                continue;
            };
            let v = v.trim();
            if v.is_empty() {
                continue;
            }
            if uuid::Uuid::parse_str(v).is_ok() {
                return Some(v.to_string());
            }
        }
        None
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
    fn infer_codex_session_id_from_rollouts(pid: u32, router_port: u16) -> Option<String> {
        let cwd = crate::platform::windows_loopback_peer::read_process_cwd(pid)?;
        let codex_home = process_codex_home(pid)?;
        let start = process_create_time(pid);
        infer_codex_session_id_from_rollouts_dir(&codex_home, &cwd, router_port, start)
    }

    fn frozen_codex_session_id(pid: u32, cmd: Option<&str>, router_port: u16) -> Option<String> {
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
            let inferred = cmd
                .and_then(parse_codex_session_id_from_cmdline)
                .or_else(|| read_process_codex_session_id(pid))
                .or_else(|| infer_codex_session_id_from_rollouts(pid, router_port));
            if let Some(id) = inferred.as_ref() {
                guard.insert(key, id.clone());
            }
            return inferred;
        }

        // If locking fails, fall back to a non-frozen inference.
        cmd.and_then(parse_codex_session_id_from_cmdline)
            .or_else(|| read_process_codex_session_id(pid))
            .or_else(|| infer_codex_session_id_from_rollouts(pid, router_port))
    }

    fn frozen_codex_model_provider(pid: u32) -> Option<String> {
        // Codex config is effectively frozen at process start; keep model_provider stable too.
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

            let provider = read_effective_codex_config_with_mtime(pid)
                .as_ref()
                .and_then(|(cfg, _mtime)| get_model_provider_id(cfg));
            if let Some(p) = provider.as_ref() {
                guard.insert(key, p.clone());
            }
            return provider;
        }

        read_effective_codex_config_with_mtime(pid)
            .as_ref()
            .and_then(|(cfg, _mtime)| get_model_provider_id(cfg))
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
                let Some(codex_session_id) = codex_session_id else {
                    ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
                    continue;
                };

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
                    let p = latest_rollout_for_session(h, &codex_session_id)?;
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
                    codex_session_id: Some(codex_session_id),
                    router_confirmed: matched,
                    is_agent: rollout_meta.as_ref().map(|m| m.is_agent).unwrap_or(false),
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
    use crate::constants::GATEWAY_MODEL_PROVIDER_ID;
    use std::collections::BTreeMap;
    use std::io::Write;
    use std::path::PathBuf;
    use std::time::Duration;

    #[test]
    fn parse_rollout_session_meta_extracts_fields() {
        let line = format!(
            r#"{{"timestamp":"2026-02-01T17:54:58.654Z","type":"session_meta","payload":{{"id":"00000000-0000-0000-0000-000000000000","cwd":"C:\\work\\example-project","model_provider":"{provider}"}}}}"#,
            provider = GATEWAY_MODEL_PROVIDER_ID
        );
        let m = parse_rollout_session_meta(&line).expect("parse");
        assert_eq!(m.id, "00000000-0000-0000-0000-000000000000");
        assert_eq!(m.cwd, "C:\\work\\example-project");
        assert_eq!(m.model_provider.as_deref(), Some(GATEWAY_MODEL_PROVIDER_ID));
        assert!(m.base_url.is_none());
        assert!(!m.is_agent);
    }

    #[test]
    fn parse_rollout_session_meta_detects_subagent_source() {
        let line = format!(
            r#"{{"type":"session_meta","payload":{{"id":"x","cwd":"C:\\x","model_provider":"{provider}","source":{{"subagent":{{"thread_spawn":{{"parent_thread_id":"p","depth":1}}}}}}}}}}"#,
            provider = GATEWAY_MODEL_PROVIDER_ID
        );
        let m = parse_rollout_session_meta(&line).expect("parse");
        assert!(m.is_agent);
    }

    #[test]
    fn rollout_base_url_matches_router_prefers_base_url_when_present() {
        let line = format!(
            r#"{{"type":"session_meta","payload":{{"id":"x","cwd":"C:\\x","model_provider":"{provider}","base_url":"https://example.com/v1"}}}}"#,
            provider = GATEWAY_MODEL_PROVIDER_ID
        );
        let m = parse_rollout_session_meta(&line).expect("parse");
        assert_eq!(rollout_base_url_matches_router(&m, 4000), Some(false));
    }

    #[test]
    fn rollout_base_url_matches_router_is_none_when_base_url_missing() {
        let good = format!(
            r#"{{"type":"session_meta","payload":{{"id":"x","cwd":"C:\\x","model_provider":"{provider}"}}}}"#,
            provider = GATEWAY_MODEL_PROVIDER_ID
        );
        let mg = parse_rollout_session_meta(&good).expect("parse");
        assert_eq!(rollout_base_url_matches_router(&mg, 4000), None);
    }

    #[test]
    fn auth_status_is_stable() {
        assert_eq!(auth_status("t", Some("t")), "match");
        assert_eq!(auth_status("t", Some("x")), "mismatch");
        assert_eq!(auth_status("t", None), "unknown");
    }

    #[test]
    fn norm_cwd_for_match_trims_trailing_slashes() {
        assert_eq!(norm_cwd_for_match("C:\\Work\\Proj\\"), "c:/work/proj");
        assert_eq!(norm_cwd_for_match("C:/Work/Proj"), "c:/work/proj");
    }

    #[test]
    fn infer_session_id_skips_unparseable_newest_rollout() {
        let tmp = tempfile::tempdir().expect("tmpdir");
        let codex_home = tmp.path().join(".codex");
        let sessions_dir = codex_home
            .join("sessions")
            .join("2026")
            .join("02")
            .join("02");
        std::fs::create_dir_all(&sessions_dir).expect("mkdir");

        // Create a valid rollout first (older).
        let good_id = "00000000-0000-0000-0000-000000000000";
        let good = sessions_dir.join(format!("rollout-good-{good_id}.jsonl"));
        {
            let mut f = std::fs::File::create(&good).expect("create good");
            writeln!(
                f,
                r#"{{"type":"session_meta","payload":{{"id":"{good_id}","cwd":"C:\\work\\proj\\","model_provider":"{provider}"}}}}"#,
                provider = GATEWAY_MODEL_PROVIDER_ID
            )
            .unwrap();
        }

        // Create a malformed rollout after (newer) that would previously abort inference.
        let bad = sessions_dir.join("rollout-bad.jsonl");
        {
            let mut f = std::fs::File::create(&bad).expect("create bad");
            writeln!(f, "not json").unwrap();
        }

        let cwd = std::path::PathBuf::from("C:\\work\\proj");
        let got = infer_codex_session_id_from_rollouts_dir(&codex_home, &cwd, 4000, None);
        assert_eq!(got.as_deref(), Some(good_id));
    }

    #[test]
    fn infer_session_id_does_not_guess_when_start_time_far() {
        let tmp = tempfile::tempdir().expect("tmpdir");
        let codex_home = tmp.path().join(".codex");
        let sessions_dir = codex_home
            .join("sessions")
            .join("2026")
            .join("02")
            .join("02");
        std::fs::create_dir_all(&sessions_dir).expect("mkdir");

        let id = "00000000-0000-0000-0000-000000000000";
        let good = sessions_dir.join(format!("rollout-good-{id}.jsonl"));
        {
            let mut f = std::fs::File::create(&good).expect("create");
            writeln!(
                f,
                r#"{{"type":"session_meta","payload":{{"id":"{id}","cwd":"C:\\work\\proj\\","model_provider":"{provider}"}}}}"#,
                provider = GATEWAY_MODEL_PROVIDER_ID
            )
            .unwrap();
        }

        let cwd = std::path::PathBuf::from("C:\\work\\proj");
        let start = std::time::SystemTime::now() + Duration::from_secs(3600);
        let got = infer_codex_session_id_from_rollouts_dir(&codex_home, &cwd, 4000, Some(start));
        assert!(got.is_none());
    }

    #[test]
    #[ignore]
    fn manual_print_discovery() {
        fn find_repo_root_from_cwd() -> Option<PathBuf> {
            let mut cur = std::env::current_dir().ok()?;
            for _ in 0..6 {
                if cur.join("user-data").join("config.toml").exists() {
                    return Some(cur);
                }
                cur = cur.parent()?.to_path_buf();
            }
            None
        }

        let Some(root) = find_repo_root_from_cwd() else {
            eprintln!(
                "manual_print_discovery: failed to locate repo root (user-data/config.toml)."
            );
            return;
        };

        let cfg_path = root.join("user-data").join("config.toml");
        let cfg_txt = std::fs::read_to_string(&cfg_path).unwrap_or_default();
        let cfg_val: toml::Value =
            toml::from_str(&cfg_txt).unwrap_or(toml::Value::Table(Default::default()));
        let port = cfg_val
            .get("listen")
            .and_then(|v| v.get("port"))
            .and_then(|v| v.as_integer())
            .unwrap_or(4000) as u16;

        let secrets_path = root.join("user-data").join("secrets.json");
        let secrets_txt = std::fs::read_to_string(&secrets_path).unwrap_or_default();
        let secrets_json: serde_json::Value =
            serde_json::from_str(&secrets_txt).unwrap_or(serde_json::Value::Null);
        let token = secrets_json
            .get("providers")
            .and_then(|v| v.get("__gateway_token__"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        eprintln!("manual_print_discovery: router_port={port}");
        eprintln!(
            "manual_print_discovery: expected_gateway_token={}",
            token.as_deref().unwrap_or("<none>")
        );

        let items = discover_sessions_using_router(port, token.as_deref());
        eprintln!("manual_print_discovery: discovered_count={}", items.len());

        let mut by_id: BTreeMap<String, usize> = BTreeMap::new();
        for s in &items {
            if let Some(id) = s.codex_session_id.as_deref() {
                *by_id.entry(id.to_string()).or_default() += 1;
            }
        }

        for s in items {
            eprintln!("---");
            eprintln!(
                "codex_session_id={}",
                s.codex_session_id.as_deref().unwrap_or("<none>")
            );
            eprintln!("wt_session={}", s.wt_session.trim());
            eprintln!("pid={}", s.pid);
            eprintln!("router_confirmed={}", s.router_confirmed);
            eprintln!("is_agent={}", s.is_agent);
            eprintln!(
                "reported_model_provider={}",
                s.reported_model_provider.as_deref().unwrap_or("<none>")
            );
            eprintln!(
                "reported_base_url={}",
                s.reported_base_url.as_deref().unwrap_or("<none>")
            );
        }

        let dups: Vec<(String, usize)> = by_id.into_iter().filter(|(_k, v)| *v > 1).collect();
        if !dups.is_empty() {
            eprintln!("---");
            eprintln!("duplicate_codex_session_ids:");
            for (k, v) in dups {
                eprintln!("{k} x{v}");
            }
        }
    }
}
