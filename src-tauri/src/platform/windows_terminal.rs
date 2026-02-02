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

pub fn discover_sessions_using_router(server_port: u16, expected_gateway_token: Option<&str>) -> Vec<InferredWtSession> {
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
        crate::platform::windows_loopback_peer::read_process_env_var(pid, "CODEX_HOME")
            .filter(|s| !s.trim().is_empty())
            .map(std::path::PathBuf::from)
            .or_else(|| {
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

    fn read_effective_codex_gateway_token(pid: u32) -> Option<String> {
        // Prefer per-project `.codex/auth.json` if present; otherwise fall back to CODEX_HOME/auth.json.
        let cwd = crate::platform::windows_loopback_peer::read_process_cwd(pid);
        if let Some(cwd) = cwd.as_deref() {
            if let Some(p) = find_project_auth_json(cwd) {
                if let Some(tok) = read_auth_token(&p) {
                    return Some(tok);
                }
            }
        }
        let codex_home = process_codex_home(pid)?;
        read_auth_token(&codex_home.join("auth.json"))
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
        let cfg_path = process_codex_home(pid).map(|h| h.join("config.toml"));
        let cfg = cfg_path.as_deref().and_then(read_config);

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

    fn codex_uses_expected_gateway_token(pid: u32, expected: &str) -> bool {
        read_effective_codex_gateway_token(pid)
            .as_deref()
            .is_some_and(|tok| tok == expected)
    }

    fn infer_codex_session_id_from_rollouts(
        pid: u32,
        router_port: u16,
    ) -> Option<String> {
        let cwd = crate::platform::windows_loopback_peer::read_process_cwd(pid)?;
        let cwd_norm = cwd.to_string_lossy().replace('\\', "/").to_ascii_lowercase();

        // Scan recent rollouts for a matching cwd + provider.
        let codex_home = process_codex_home(pid)?;
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
            let meta: serde_json::Value = serde_json::from_str(first.trim()).ok()?;
            let payload = meta.get("payload");
            let id = payload.and_then(|p| p.get("id")).and_then(|v| v.as_str());
            let wd = payload
                .and_then(|p| p.get("cwd").or_else(|| p.get("working_directory")))
                .and_then(|v| v.as_str());
            let mp = payload
                .and_then(|p| p.get("model_provider_id").or_else(|| p.get("model_provider")))
                .and_then(|v| v.as_str());

            let Some(id) = id else { continue; };
            let Some(wd) = wd else { continue; };
            let Some(mp) = mp else { continue; };

            if !mp.eq_ignore_ascii_case("api_router") {
                continue;
            }
            let wd_norm = wd.replace('\\', "/").to_ascii_lowercase();
            if wd_norm != cwd_norm {
                continue;
            }

            // Optional: if Codex is configured via env vars or config to point to this router port,
            // confirm that as well. If we can't confirm, still return the session id; token check
            // will filter later.
            let _ = router_port;
            return Some(id.to_string());
        }
        None
    }

    fn is_session_api_router(codex_home: &std::path::Path, session_id: &str) -> bool {
        // Look for a rollout file whose name ends with `-{session_id}.jsonl` and verify its meta.
        let sessions_dir = codex_home.join("sessions");
        let mut candidates: Vec<std::path::PathBuf> = Vec::new();
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
                            candidates.push(p);
                        }
                    }
                }
                if candidates.len() > 8 {
                    break;
                }
            }
        }

        for p in candidates {
            let file = std::fs::File::open(&p).ok();
            let Some(file) = file else { continue; };
            let mut r = std::io::BufReader::new(file);
            let mut first = String::new();
            if r.read_line(&mut first).ok().unwrap_or(0) == 0 {
                continue;
            }
            let meta: serde_json::Value = match serde_json::from_str(first.trim()) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let payload = meta.get("payload");
            let mp = payload
                .and_then(|p| p.get("model_provider_id").or_else(|| p.get("model_provider")))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if mp.eq_ignore_ascii_case("api_router") {
                return true;
            }
        }
        false
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

                let token_ok = expected_gateway_token
                    .map(|t| codex_uses_expected_gateway_token(pid, t))
                    .unwrap_or(true);
                if !token_ok {
                    ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
                    continue;
                }

                // Prefer config/env matching, but if the process already has an api_router session rollout,
                // treat it as configured even if the config has since changed on disk.
                let codex_home = process_codex_home(pid);
                let rollout_says_api_router = codex_home
                    .as_deref()
                    .is_some_and(|h| is_session_api_router(h, &codex_session_id));
                let matched = codex_effective_base_url_uses_router(pid, server_port) || rollout_says_api_router;
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
