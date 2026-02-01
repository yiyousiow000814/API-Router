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
        Some(InferredWtSession {
            wt_session: wt,
            pid,
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

    fn codex_config_uses_router_port(codex_home: Option<&str>, port: u16) -> bool {
        // Codex config supports `model_providers.<id>.base_url` entries.
        // If any provider points at our listen port, treat it as "configured".
        //
        // We check:
        // - $CODEX_HOME/config.toml (if present in the Codex process)
        // - %USERPROFILE%/.codex/config.toml as a default fallback
        fn read_config(path: &std::path::Path) -> Option<toml::Value> {
            let s = std::fs::read_to_string(path).ok()?;
            toml::from_str::<toml::Value>(&s).ok()
        }

        fn any_provider_matches(cfg: &toml::Value, port: u16) -> bool {
            let tbl = match cfg.as_table() {
                Some(t) => t,
                None => return false,
            };
            let providers = match tbl.get("model_providers").and_then(|v| v.as_table()) {
                Some(p) => p,
                None => return false,
            };
            providers.values().any(|p| {
                p.as_table()
                    .and_then(|t| t.get("base_url"))
                    .and_then(|v| v.as_str())
                    .is_some_and(|u| looks_like_router_base(u, port))
            })
        }

        let mut paths: Vec<std::path::PathBuf> = Vec::new();
        if let Some(home) = codex_home {
            if !home.trim().is_empty() {
                paths.push(std::path::PathBuf::from(home).join("config.toml"));
            }
        }
        if let Ok(profile) = std::env::var("USERPROFILE") {
            if !profile.trim().is_empty() {
                paths.push(std::path::PathBuf::from(profile).join(".codex").join("config.toml"));
            }
        }

        for p in paths {
            if let Some(cfg) = read_config(&p) {
                if any_provider_matches(&cfg, port) {
                    return true;
                }
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
    let candidates = ["codex.exe", "codex", "node.exe", "node"];

    // If Codex is configured via config.toml (instead of env vars), we still want to pre-discover
    // sessions before the first request. Cache the default (no CODEX_HOME) check once per scan.
    let default_codex_configured = codex_config_uses_router_port(None, server_port);

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
                // Prefer process-local env vars (fast), but fall back to Codex config.toml
                // for setups where the base URL is configured via config rather than env.
                let keys = [
                    "OPENAI_BASE_URL",
                    "OPENAI_API_BASE",
                    "OPENAI_BASE",
                    "OPENAI_API_HOST",
                ];
                let mut matched = false;
                for k in keys {
                    if let Some(v) =
                        crate::platform::windows_loopback_peer::read_process_env_var(pid, k)
                    {
                        if looks_like_router_base(&v, server_port) {
                            matched = true;
                            break;
                        }
                    }
                }
                if !matched && (exe_lc == "codex" || exe_lc == "codex.exe") {
                    let codex_home =
                        crate::platform::windows_loopback_peer::read_process_env_var(pid, "CODEX_HOME");
                    matched = codex_home
                        .as_deref()
                        .map(|h| codex_config_uses_router_port(Some(h), server_port))
                        .unwrap_or(default_codex_configured);
                }
                if matched {
                    out.push(InferredWtSession {
                        wt_session: wt,
                        pid,
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
