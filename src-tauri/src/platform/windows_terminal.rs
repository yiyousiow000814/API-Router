//! Windows Terminal integrations.
//!
//! Currently this module supports inferring `WT_SESSION` for a request by mapping the loopback TCP
//! connection to the owning process PID, then reading the process environment.

use std::net::SocketAddr;

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

pub fn discover_sessions_using_router(server_port: u16) -> Vec<InferredWtSession> {
    #[cfg(not(windows))]
    {
        let _ = server_port;
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

        let items = discover_sessions_using_router_uncached(server_port);
        if let Ok(mut guard) = cache.lock() {
            guard.updated_at_unix_ms = now;
            guard.items = items.clone();
        }
        items
    }
}

#[cfg(windows)]
fn discover_sessions_using_router_uncached(server_port: u16) -> Vec<InferredWtSession> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    fn wide_cstr_to_string(buf: &[u16]) -> String {
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }

    fn looks_like_router_base(v: &str, port: u16) -> bool {
        let v = v.to_ascii_lowercase();
        let port_s = format!(":{port}");
        (v.contains("127.0.0.1") || v.contains("localhost")) && v.contains(&port_s)
    }

    fn read_config(path: &std::path::Path) -> Option<toml::Value> {
        let s = std::fs::read_to_string(path).ok()?;
        toml::from_str::<toml::Value>(&s).ok()
    }

    fn get_model_provider_id(cfg: &toml::Value) -> Option<String> {
        cfg.as_table()?
            .get("model_provider")
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
        let cwd = crate::platform::windows_loopback_peer::read_process_cwd(pid);
        let project_cfg_path = cwd.as_deref().and_then(find_project_codex_config);
        let project_cfg = project_cfg_path.as_deref().and_then(read_config);

        let user_cfg_path = std::env::var("USERPROFILE")
            .ok()
            .map(|p| std::path::PathBuf::from(p).join(".codex").join("config.toml"));
        let user_cfg = user_cfg_path.as_deref().and_then(read_config);

        let provider_id = project_cfg
            .as_ref()
            .and_then(get_model_provider_id)
            .or_else(|| user_cfg.as_ref().and_then(get_model_provider_id));

        let Some(provider_id) = provider_id else {
            // Be conservative: if we can't find the selected provider, don't claim it's using us.
            return false;
        };

        let base_url = project_cfg
            .as_ref()
            .and_then(|cfg| get_provider_base_url(cfg, &provider_id))
            .or_else(|| user_cfg.as_ref().and_then(|cfg| get_provider_base_url(cfg, &provider_id)));

        base_url
            .as_deref()
            .is_some_and(|u| looks_like_router_base(u, port))
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
    let candidates = ["codex.exe", "codex", "node.exe", "node"];

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
                // Only show sessions that are actually configured to use this router.
                // This avoids listing unrelated Codex sessions that happen to be running.
                let matched = if exe_lc == "codex" || exe_lc == "codex.exe" {
                    codex_effective_base_url_uses_router(pid, server_port)
                } else {
                    // node is a coarse heuristic; require explicit env vars only.
                    let keys = ["OPENAI_BASE_URL", "OPENAI_API_BASE", "OPENAI_BASE", "OPENAI_API_HOST"];
                    keys.into_iter().any(|k| {
                        crate::platform::windows_loopback_peer::read_process_env_var(pid, k)
                            .is_some_and(|v| looks_like_router_base(&v, server_port))
                    })
                };

                if matched {
                    let codex_session_id =
                        crate::platform::windows_loopback_peer::read_process_command_line(pid)
                            .as_deref()
                            .and_then(parse_codex_session_id_from_cmdline);
                    out.push(InferredWtSession {
                        wt_session: wt,
                        pid,
                        codex_session_id,
                    });
                }
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
