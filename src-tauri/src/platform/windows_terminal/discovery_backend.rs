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

