//! Windows Terminal integrations.
//!
//! Currently this module supports inferring `WT_SESSION` for a request by mapping the loopback TCP
//! connection to the owning process PID, then reading the process environment.

use std::net::SocketAddr;
#[cfg(windows)]
use std::io::BufRead;

#[cfg(windows)]
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Debug)]
pub struct InferredWtSession {
    pub wt_session: String,
    pub pid: u32,
    pub codex_session_id: Option<String>,
}

#[cfg(windows)]
fn parse_codex_session_id_from_cmdline(cmd: &str) -> Option<String> {
    // `codex` commonly launches as: `codex.exe resume <uuid>`.
    // If we see `resume`, take the next UUID token. Otherwise take the first UUID token.
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
    for t in toks {
        if uuid::Uuid::parse_str(t).is_ok() {
            return Some(t.to_string());
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
    base_url: Option<String>,
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
    let base_url = payload
        .get("base_url")
        .or_else(|| payload.get("model_provider_base_url"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Some(RolloutSessionMeta {
        id,
        cwd,
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
fn infer_codex_session_id_from_rollouts_dir(
    codex_home: &std::path::Path,
    cwd: &std::path::Path,
    router_port: u16,
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
                } else if md.is_file() {
                    if p.extension()
                        .and_then(|s| s.to_str())
                        .is_some_and(|s| s.eq_ignore_ascii_case("jsonl"))
                        && p.file_name()
                            .and_then(|s| s.to_str())
                            .is_some_and(|n| n.to_ascii_lowercase().starts_with("rollout-"))
                    {
                        if let Ok(mtime) = md.modified() {
                            entries.push((p, mtime));
                        }
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

    for (p, _t) in entries {
        let file = std::fs::File::open(&p).ok();
        let Some(file) = file else { continue; };
        let mut r = std::io::BufReader::new(file);
        let mut first = String::new();
        if r.read_line(&mut first).ok().unwrap_or(0) == 0 {
            continue;
        }
        let Some(m) = parse_rollout_session_meta(&first) else {
            // Some rollouts may not start with a session_meta line; keep scanning.
            continue;
        };
        let id = m.id;
        let wd = m.cwd;
        let base_url = m.base_url;
        if wd.is_empty() {
            continue;
        }
        let wd_norm = norm_cwd_for_match(&wd);
        if wd_norm != cwd_norm {
            continue;
        }

        // Prefer matching by base_url (strong signal). If present and pointing to this router,
        // return immediately; otherwise keep scanning for another cwd match.
        if base_url
            .as_deref()
            .is_some_and(|u| looks_like_router_base(u, router_port))
        {
            return Some(id);
        }

        // base_url missing: newest cwd match.
        return Some(id);
    }

    None
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
        let codex_session_id = crate::platform::windows_loopback_peer::read_process_command_line(pid)
            .as_deref()
            .and_then(parse_codex_session_id_from_cmdline);
        Some(InferredWtSession {
            wt_session: wt,
            pid,
            codex_session_id,
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

    fn read_effective_codex_config(pid: u32) -> Option<toml::Value> {
        // Match Codex precedence: project `.codex/config.toml` (closest to cwd) overrides CODEX_HOME config.
        let cwd = crate::platform::windows_loopback_peer::read_process_cwd(pid);
        if let Some(cwd) = cwd.as_deref() {
            if let Some(p) = find_project_codex_config(cwd) {
                if let Some(cfg) = read_config(&p) {
                    return Some(cfg);
                }
            }
        }
        let codex_home = process_codex_home(pid)?;
        read_config(&codex_home.join("config.toml"))
    }

    fn codex_effective_base_url_uses_router(pid: u32, port: u16) -> bool {
        // 1) Fast path: process env vars.
        let keys = ["OPENAI_BASE_URL", "OPENAI_API_BASE", "OPENAI_BASE", "OPENAI_API_HOST"];
        for k in keys {
            if let Some(v) = crate::platform::windows_loopback_peer::read_process_env_var(pid, k) {
                if looks_like_router_base(&v, port) {
                    return true;
                }
            }
        }

        // 2) Config path: determine the selected model_provider, then resolve its base_url.
        let cfg = read_effective_codex_config(pid);

        let provider_id = cfg.as_ref().and_then(get_model_provider_id);
        let Some(provider_id) = provider_id else {
            // Be conservative: if we can't find the selected provider, don't claim it's using us.
            return false;
        };

        let base_url = cfg.as_ref().and_then(|cfg| get_provider_base_url(cfg, &provider_id));

        base_url
            .as_deref()
            .is_some_and(|u| looks_like_router_base(u, port))
    }
    fn infer_codex_session_id_from_rollouts(pid: u32, router_port: u16) -> Option<String> {
        let cwd = crate::platform::windows_loopback_peer::read_process_cwd(pid)?;
        let codex_home = process_codex_home(pid)?;
        infer_codex_session_id_from_rollouts_dir(&codex_home, &cwd, router_port)
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
                    } else if md.is_file() {
                        if p.file_name()
                            .and_then(|s| s.to_str())
                            .is_some_and(|n| {
                                let n = n.to_ascii_lowercase();
                                n.starts_with("rollout-")
                                    && n.ends_with(&format!("-{}.jsonl", session_id.to_ascii_lowercase()))
                            })
                        {
                            if let Ok(mtime) = md.modified() {
                                candidates.push((p, mtime));
                            }
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
            let wt = crate::platform::windows_loopback_peer::read_process_env_var(pid, "WT_SESSION");
            if let Some(wt) = wt {
                let cmd = crate::platform::windows_loopback_peer::read_process_command_line(pid);
                let _cwd = crate::platform::windows_loopback_peer::read_process_cwd(pid)
                    .map(|p| p.to_string_lossy().to_string());

                // Ignore Codex background helpers that are not user sessions.
                if cmd.as_deref().is_some_and(|s| s.to_ascii_lowercase().contains("app-server")) {
                    ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
                    continue;
                }

                // Infer session id early; we can use it as a stronger signal than the current on-disk config.
                let codex_session_id = cmd
                    .as_deref()
                    .and_then(parse_codex_session_id_from_cmdline)
                    .or_else(|| infer_codex_session_id_from_rollouts(pid, server_port));
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
                    None => codex_effective_base_url_uses_router(pid, server_port),
                };
                if !matched {
                    ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
                    continue;
                }

                out.push(InferredWtSession {
                    wt_session: wt,
                    pid,
                    codex_session_id: Some(codex_session_id),
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
    use std::io::Write;

    #[test]
    fn parse_rollout_session_meta_extracts_fields() {
        let line = r#"{"timestamp":"2026-02-01T17:54:58.654Z","type":"session_meta","payload":{"id":"00000000-0000-0000-0000-000000000000","cwd":"C:\\work\\example-project","model_provider":"api_router"}}"#;
        let m = parse_rollout_session_meta(line).expect("parse");
        assert_eq!(m.id, "00000000-0000-0000-0000-000000000000");
        assert_eq!(m.cwd, "C:\\work\\example-project");
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

    #[test]
    fn norm_cwd_for_match_trims_trailing_slashes() {
        assert_eq!(norm_cwd_for_match("C:\\Work\\Proj\\"), "c:/work/proj");
        assert_eq!(norm_cwd_for_match("C:/Work/Proj"), "c:/work/proj");
    }

    #[test]
    fn infer_session_id_skips_unparseable_newest_rollout() {
        let tmp = tempfile::tempdir().expect("tmpdir");
        let codex_home = tmp.path().join(".codex");
        let sessions_dir = codex_home.join("sessions").join("2026").join("02").join("02");
        std::fs::create_dir_all(&sessions_dir).expect("mkdir");

        // Create a valid rollout first (older).
        let good_id = "00000000-0000-0000-0000-000000000000";
        let good = sessions_dir.join(format!("rollout-good-{good_id}.jsonl"));
        {
            let mut f = std::fs::File::create(&good).expect("create good");
            writeln!(
                f,
                r#"{{"type":"session_meta","payload":{{"id":"{good_id}","cwd":"C:\\work\\proj\\","model_provider":"api_router"}}}}"#
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
        let got = infer_codex_session_id_from_rollouts_dir(&codex_home, &cwd, 4000);
        assert_eq!(got.as_deref(), Some(good_id));
    }
}
