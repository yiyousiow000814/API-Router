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
    pub is_review: bool,
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
    is_review: bool,
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
fn rollout_source_is_review(source: Option<&serde_json::Value>) -> bool {
    let Some(source) = source else {
        return false;
    };
    match source {
        serde_json::Value::Object(map) => map
            .get("subagent")
            .or_else(|| map.get("subAgent"))
            .and_then(|v| v.as_str())
            .is_some_and(|v| v.eq_ignore_ascii_case("review")),
        serde_json::Value::String(s) => s.to_ascii_lowercase().contains("review"),
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
    let source = payload.get("source");
    let is_agent = rollout_source_is_agent(source);
    let is_review = rollout_source_is_review(source);
    Some(RolloutSessionMeta {
        id,
        cwd,
        model_provider,
        base_url,
        is_agent,
        is_review,
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
        is_agent: bool,
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
            is_agent: m.is_agent,
        });
    }

    if candidates.is_empty() {
        return None;
    }

    // Prefer primary CLI sessions over subagent/review sessions when both exist for the same
    // process window. Subagent sessions are derived from a main CLI session and should follow it.
    let preferred_candidates: Vec<Candidate> = if candidates.iter().any(|c| !c.is_agent) {
        candidates
            .iter()
            .filter(|&c| !c.is_agent)
            .cloned()
            .collect()
    } else {
        candidates.clone()
    };

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
    let router_matches: Vec<Candidate> = preferred_candidates
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
        return pick_closest(&preferred_candidates, start);
    }
    Some(preferred_candidates[0].id.clone())
}

#[cfg(windows)]
fn parse_tui_log_session_line(line: &str) -> Option<(SystemTime, String)> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let ts = line.split_whitespace().next()?;
    let dt = chrono::DateTime::parse_from_rfc3339(ts).ok()?;
    let mut idx = line.find("thread_id=")?;
    idx += "thread_id=".len();
    let rest = &line[idx..];
    let end = rest
        .find(|c: char| c == '}' || c == ':' || c.is_whitespace())
        .unwrap_or(rest.len());
    let id = rest[..end].trim();
    if uuid::Uuid::parse_str(id).is_err() {
        return None;
    }
    let ts_ms = u64::try_from(dt.timestamp_millis()).ok()?;
    let sys = SystemTime::UNIX_EPOCH + Duration::from_millis(ts_ms);
    Some((sys, id.to_string()))
}

#[cfg(windows)]
fn infer_codex_session_id_from_tui_log(
    codex_home: &std::path::Path,
    start: SystemTime,
) -> Option<String> {
    // Codex writes runtime thread ids into `log/codex-tui.log` at session init. This is a useful
    // fallback for processes started as plain `codex.exe` without a session id in argv.
    const LOG_SCAN_MAX_BYTES: u64 = 4 * 1024 * 1024;
    const MAX_WINDOW: Duration = Duration::from_secs(8);

    let log_path = codex_home.join("log").join("codex-tui.log");
    let file = std::fs::File::open(&log_path).ok()?;
    let mut reader = std::io::BufReader::new(file);
    let len = reader.get_ref().metadata().ok()?.len();
    if len > LOG_SCAN_MAX_BYTES {
        let _ = std::io::Seek::seek(
            &mut reader,
            std::io::SeekFrom::Start(len - LOG_SCAN_MAX_BYTES),
        );
    }

    let mut line = String::new();
    let mut best: Option<(String, Duration)> = None;
    loop {
        line.clear();
        if reader.read_line(&mut line).ok().unwrap_or(0) == 0 {
            break;
        }
        let Some((ts, id)) = parse_tui_log_session_line(&line) else {
            continue;
        };
        let Some(dt) = (if ts >= start {
            ts.duration_since(start).ok()
        } else {
            start.duration_since(ts).ok()
        }) else {
            continue;
        };
        if dt > MAX_WINDOW {
            continue;
        }
        if best.as_ref().map(|(_, b)| dt < *b).unwrap_or(true) {
            best = Some((id, dt));
        }
    }
    best.map(|(id, _)| id)
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
            is_review: false,
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

pub fn is_pid_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        crate::platform::windows_loopback_peer::is_pid_alive(pid)
    }

    #[cfg(not(windows))]
    {
        let _ = pid;
        false
    }
}

#[cfg(windows)]
include!("windows_terminal/discovery_backend.rs");
include!("windows_terminal/tests.rs");
