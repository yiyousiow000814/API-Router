use crate::orchestrator::gateway::web_codex_home::WorkspaceTarget;
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TerminalToggleOverride {
    Enabled,
    Disabled,
    #[default]
    Missing,
}

#[derive(Clone, Debug, Default)]
pub struct TerminalSessionTurnOptions {
    pub model: Option<String>,
    pub plan_mode: TerminalToggleOverride,
    pub fast_mode: TerminalToggleOverride,
    pub approval_policy: Option<String>,
    pub sandbox_policy: Option<Value>,
}

#[derive(Clone, Debug)]
pub struct TerminalSessionTurnAck {
    pub payload: Value,
}

#[derive(Clone, Debug)]
pub struct TerminalSessionAttachAck {
    pub thread_id: String,
    pub cwd: Option<String>,
    pub rollout_path: Option<String>,
}

fn session_matches_workspace(
    session: &crate::platform::windows_terminal::InferredWtSession,
    workspace_target: Option<WorkspaceTarget>,
) -> bool {
    match workspace_target {
        Some(WorkspaceTarget::Windows) => {
            !session.wt_session.to_ascii_lowercase().starts_with("wsl:")
        }
        Some(WorkspaceTarget::Wsl2) => session.wt_session.to_ascii_lowercase().starts_with("wsl:"),
        None => true,
    }
}

#[cfg(target_os = "windows")]
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn normalize_session_cwd(raw: &str, workspace_target: Option<WorkspaceTarget>) -> String {
    let text = raw.trim();
    if text.is_empty() {
        return String::new();
    }
    match workspace_target {
        Some(WorkspaceTarget::Wsl2) => {
            crate::orchestrator::gateway::web_codex_home::normalize_wsl_linux_path(text)
                .or_else(|| {
                    crate::orchestrator::gateway::web_codex_home::parse_wsl_unc_to_linux_path(text)
                })
                .unwrap_or_default()
        }
        _ => text
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_ascii_lowercase(),
    }
}

fn session_thread_id(
    session: &crate::platform::windows_terminal::InferredWtSession,
) -> Option<String> {
    session
        .codex_session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn session_rollout_path(
    session: &crate::platform::windows_terminal::InferredWtSession,
) -> Option<String> {
    session
        .rollout_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn session_matches_thread_id(
    session: &crate::platform::windows_terminal::InferredWtSession,
    workspace_target: Option<WorkspaceTarget>,
    thread_id: &str,
) -> bool {
    let normalized_thread_id = thread_id.trim();
    !normalized_thread_id.is_empty()
        && session_matches_workspace(session, workspace_target)
        && session_thread_id(session)
            .as_deref()
            .is_some_and(|value| value == normalized_thread_id)
}

fn session_matches_cwd(
    session: &crate::platform::windows_terminal::InferredWtSession,
    workspace_target: Option<WorkspaceTarget>,
    cwd: &str,
) -> bool {
    let requested = normalize_session_cwd(cwd, workspace_target);
    let observed =
        normalize_session_cwd(session.cwd.as_deref().unwrap_or_default(), workspace_target);
    !requested.is_empty() && !observed.is_empty() && requested == observed
}

fn select_live_session_for_thread(
    sessions: &[crate::platform::windows_terminal::InferredWtSession],
    workspace_target: Option<WorkspaceTarget>,
    thread_id: &str,
) -> Option<crate::platform::windows_terminal::InferredWtSession> {
    sessions
        .iter()
        .find(|session| session_matches_thread_id(session, workspace_target, thread_id))
        .cloned()
}

fn select_attachable_live_session_by_cwd(
    sessions: &[crate::platform::windows_terminal::InferredWtSession],
    workspace_target: Option<WorkspaceTarget>,
    cwd: &str,
) -> Option<crate::platform::windows_terminal::InferredWtSession> {
    let mut matches = sessions
        .iter()
        .filter(|session| {
            session_matches_workspace(session, workspace_target)
                && !session.is_agent
                && !session.is_review
                && session_thread_id(session).is_some()
                && session_matches_cwd(session, workspace_target, cwd)
        })
        .cloned()
        .collect::<Vec<_>>();
    if matches.len() == 1 {
        matches.pop()
    } else {
        None
    }
}

#[cfg(test)]
fn test_discovery_sessions_store(
) -> &'static std::sync::Mutex<Option<Vec<crate::platform::windows_terminal::InferredWtSession>>> {
    static STORE: std::sync::OnceLock<
        std::sync::Mutex<Option<Vec<crate::platform::windows_terminal::InferredWtSession>>>,
    > = std::sync::OnceLock::new();
    STORE.get_or_init(|| std::sync::Mutex::new(None))
}

#[cfg(test)]
pub fn _set_test_discovery_sessions(
    sessions: Option<Vec<crate::platform::windows_terminal::InferredWtSession>>,
) {
    if let Ok(mut guard) = test_discovery_sessions_store().lock() {
        *guard = sessions;
    }
}

fn discovered_sessions(
    server_port: u16,
    expected_gateway_token: Option<&str>,
) -> Vec<crate::platform::windows_terminal::InferredWtSession> {
    #[cfg(test)]
    if let Ok(guard) = test_discovery_sessions_store().lock() {
        if let Some(items) = guard.as_ref() {
            return items.clone();
        }
    }

    crate::platform::windows_terminal::discover_sessions_using_router_snapshot(
        server_port,
        expected_gateway_token,
    )
    .items
}

fn append_runtime_sync_commands(out: &mut Vec<String>, options: &TerminalSessionTurnOptions) {
    fn matches_variant(value: &str, variants: &[&str]) -> bool {
        variants
            .iter()
            .any(|variant| value.eq_ignore_ascii_case(variant))
    }

    if let Some(model) = options
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        out.push(format!("/model {model}"));
    }

    match options.plan_mode {
        TerminalToggleOverride::Enabled => out.push("/plan on".to_string()),
        TerminalToggleOverride::Disabled => out.push("/plan off".to_string()),
        TerminalToggleOverride::Missing => {}
    }

    match options.fast_mode {
        TerminalToggleOverride::Enabled => out.push("/fast on".to_string()),
        TerminalToggleOverride::Disabled => out.push("/fast off".to_string()),
        TerminalToggleOverride::Missing => {}
    }

    let permission_command = match (
        options
            .approval_policy
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
        options.sandbox_policy.as_ref().and_then(Value::as_object),
    ) {
        (Some("never"), Some(policy))
            if policy
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|value| {
                    matches_variant(value, &["dangerFullAccess", "danger-full-access"])
                }) =>
        {
            Some("/permission full-access")
        }
        (Some("untrusted"), Some(policy))
            if policy
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|value| matches_variant(value, &["readOnly", "read-only"])) =>
        {
            Some("/permission read-only")
        }
        (Some("on-request"), Some(policy))
            if policy
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|value| {
                    matches_variant(value, &["workspaceWrite", "workspace-write"])
                }) =>
        {
            Some("/permission auto")
        }
        _ => None,
    };
    if let Some(command) = permission_command {
        out.push(command.to_string());
    }
}

#[cfg(target_os = "windows")]
fn write_windows_process_stdin(pid: u32, line: &str) -> Result<(), String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Storage::FileSystem::WriteFile;

    let bytes = format!("{line}\r\n").into_bytes();
    let handle = crate::platform::windows_loopback_peer::duplicate_process_stdin_write_handle(pid)
        .ok_or_else(|| format!("failed to duplicate stdin handle for pid {pid}"))?;
    let mut written = 0_u32;
    let ok = unsafe {
        WriteFile(
            handle,
            bytes.as_ptr() as *const _,
            u32::try_from(bytes.len()).unwrap_or(u32::MAX),
            &mut written as *mut u32,
            std::ptr::null_mut(),
        )
    };
    let _ = unsafe { CloseHandle(handle) };
    if ok == 0 {
        return Err(format!("failed to write stdin for pid {pid}"));
    }
    if usize::try_from(written).unwrap_or_default() < bytes.len() {
        return Err(format!("short stdin write for pid {pid}"));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn write_windows_process_stdin(_pid: u32, _line: &str) -> Result<(), String> {
    Err("windows terminal stdin injection is unavailable on this host".to_string())
}

#[cfg(target_os = "windows")]
async fn write_wsl_process_stdin(distro: &str, pid: u32, line: &str) -> Result<(), String> {
    let payload = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(line.as_bytes())
    };
    let script = "import base64, os, sys; fd=os.open(f'/proc/{sys.argv[1]}/fd/0', os.O_WRONLY); os.write(fd, base64.b64decode(sys.argv[2]) + b'\\n'); os.close(fd)";
    let output = tokio::process::Command::new("wsl.exe")
        .args([
            "-d",
            distro,
            "--",
            "python3",
            "-c",
            script,
            &pid.to_string(),
            &payload,
        ])
        .output()
        .await
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            Err(format!("failed to write WSL stdin for pid {pid}"))
        } else {
            Err(stderr)
        }
    }
}

#[cfg(not(target_os = "windows"))]
async fn write_wsl_process_stdin(_distro: &str, _pid: u32, _line: &str) -> Result<(), String> {
    Err("wsl stdin injection is unavailable on this host".to_string())
}

#[cfg(target_os = "windows")]
async fn interrupt_wsl_process(distro: &str, pid: u32) -> Result<(), String> {
    let output = tokio::process::Command::new("wsl.exe")
        .args([
            "-d",
            distro,
            "--",
            "sh",
            "-lc",
            &format!("kill -INT {}", shell_single_quote(&pid.to_string())),
        ])
        .output()
        .await
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            Err(format!("failed to interrupt WSL pid {pid}"))
        } else {
            Err(stderr)
        }
    }
}

#[cfg(not(target_os = "windows"))]
async fn interrupt_wsl_process(_distro: &str, _pid: u32) -> Result<(), String> {
    Err("wsl interrupt is unavailable on this host".to_string())
}

#[cfg(target_os = "windows")]
fn interrupt_windows_process(pid: u32) -> Result<(), String> {
    let handle = crate::platform::windows_loopback_peer::duplicate_process_stdin_write_handle(pid)
        .ok_or_else(|| format!("failed to duplicate stdin handle for pid {pid}"))?;
    let _ = handle;
    write_windows_process_stdin(pid, "\u{3}")
}

#[cfg(not(target_os = "windows"))]
fn interrupt_windows_process(_pid: u32) -> Result<(), String> {
    Err("windows interrupt is unavailable on this host".to_string())
}

fn terminal_turn_ack(
    thread_id: &str,
    workspace_target: Option<WorkspaceTarget>,
) -> TerminalSessionTurnAck {
    TerminalSessionTurnAck {
        payload: json!({
            "threadId": thread_id,
            "turnId": Value::Null,
            "transport": "terminal-session",
            "workspace": match workspace_target {
                Some(WorkspaceTarget::Wsl2) => "wsl2",
                Some(WorkspaceTarget::Windows) => "windows",
                None => "",
            },
            "result": {
                "accepted": true,
                "transport": "terminal-session"
            }
        }),
    }
}

pub async fn try_start_turn_in_live_session(
    server_port: u16,
    expected_gateway_token: Option<&str>,
    workspace_target: Option<WorkspaceTarget>,
    thread_id: &str,
    prompt: &str,
    options: &TerminalSessionTurnOptions,
) -> Result<Option<TerminalSessionTurnAck>, String> {
    let normalized_thread_id = thread_id.trim();
    let normalized_prompt = prompt.trim();
    if normalized_thread_id.is_empty() || normalized_prompt.is_empty() {
        return Ok(None);
    }

    let sessions = discovered_sessions(server_port, expected_gateway_token);
    let matched = select_live_session_for_thread(&sessions, workspace_target, normalized_thread_id);
    let Some(session) = matched else {
        return Ok(None);
    };

    let mut lines = Vec::new();
    append_runtime_sync_commands(&mut lines, options);
    lines.push(normalized_prompt.to_string());

    if session.wt_session.to_ascii_lowercase().starts_with("wsl:") {
        let distro = session
            .wsl_distro
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "matched WSL terminal session is missing distro".to_string())?;
        let pid = session
            .linux_pid
            .filter(|value| *value > 0)
            .ok_or_else(|| "matched WSL terminal session is missing linux pid".to_string())?;
        for line in lines {
            write_wsl_process_stdin(distro, pid, &line).await?;
        }
    } else {
        if session.pid == 0 {
            return Err("matched Windows terminal session is missing pid".to_string());
        }
        for line in lines {
            write_windows_process_stdin(session.pid, &line)?;
        }
    }

    Ok(Some(terminal_turn_ack(
        normalized_thread_id,
        workspace_target,
    )))
}

pub async fn try_attach_live_session(
    server_port: u16,
    expected_gateway_token: Option<&str>,
    workspace_target: Option<WorkspaceTarget>,
    cwd: &str,
) -> Result<Option<TerminalSessionAttachAck>, String> {
    if normalize_session_cwd(cwd, workspace_target).is_empty() {
        return Ok(None);
    }

    let sessions = discovered_sessions(server_port, expected_gateway_token);
    let Some(session) = select_attachable_live_session_by_cwd(&sessions, workspace_target, cwd)
    else {
        return Ok(None);
    };
    let Some(thread_id) = session_thread_id(&session) else {
        return Ok(None);
    };
    Ok(Some(TerminalSessionAttachAck {
        thread_id,
        cwd: session
            .cwd
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        rollout_path: session_rollout_path(&session),
    }))
}

pub async fn lookup_live_session_by_thread(
    server_port: u16,
    expected_gateway_token: Option<&str>,
    workspace_target: Option<WorkspaceTarget>,
    thread_id: &str,
) -> Result<Option<TerminalSessionAttachAck>, String> {
    let normalized_thread_id = thread_id.trim();
    if normalized_thread_id.is_empty() {
        return Ok(None);
    }

    let sessions = discovered_sessions(server_port, expected_gateway_token);
    let Some(session) =
        select_live_session_for_thread(&sessions, workspace_target, normalized_thread_id)
    else {
        return Ok(None);
    };

    Ok(Some(TerminalSessionAttachAck {
        thread_id: normalized_thread_id.to_string(),
        cwd: session
            .cwd
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        rollout_path: session_rollout_path(&session),
    }))
}

pub async fn try_interrupt_live_session(
    server_port: u16,
    expected_gateway_token: Option<&str>,
    workspace_target: Option<WorkspaceTarget>,
    thread_id: &str,
) -> Result<bool, String> {
    let normalized_thread_id = thread_id.trim();
    if normalized_thread_id.is_empty() {
        return Ok(false);
    }

    let sessions = discovered_sessions(server_port, expected_gateway_token);
    let matched = select_live_session_for_thread(&sessions, workspace_target, normalized_thread_id);
    let Some(session) = matched else {
        return Ok(false);
    };

    if session.wt_session.to_ascii_lowercase().starts_with("wsl:") {
        let distro = session
            .wsl_distro
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "matched WSL terminal session is missing distro".to_string())?;
        let pid = session
            .linux_pid
            .filter(|value| *value > 0)
            .ok_or_else(|| "matched WSL terminal session is missing linux pid".to_string())?;
        interrupt_wsl_process(distro, pid).await?;
    } else {
        if session.pid == 0 {
            return Err("matched Windows terminal session is missing pid".to_string());
        }
        interrupt_windows_process(session.pid)?;
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_session(wt_session: &str) -> crate::platform::windows_terminal::InferredWtSession {
        crate::platform::windows_terminal::InferredWtSession {
            wt_session: wt_session.to_string(),
            pid: 42,
            linux_pid: None,
            wsl_distro: None,
            cwd: None,
            rollout_path: None,
            codex_session_id: Some("thread-1".to_string()),
            reported_model_provider: None,
            reported_base_url: None,
            agent_parent_session_id: None,
            router_confirmed: true,
            is_agent: false,
            is_review: false,
        }
    }

    #[test]
    fn session_matching_uses_workspace_prefix() {
        assert!(session_matches_workspace(
            &make_session("wt-1"),
            Some(WorkspaceTarget::Windows)
        ));
        assert!(!session_matches_workspace(
            &make_session("wsl:wt-1"),
            Some(WorkspaceTarget::Windows)
        ));
        assert!(session_matches_workspace(
            &make_session("wsl:wt-1"),
            Some(WorkspaceTarget::Wsl2)
        ));
    }

    #[test]
    fn runtime_options_expand_to_terminal_sync_commands() {
        let mut commands = Vec::new();
        append_runtime_sync_commands(
            &mut commands,
            &TerminalSessionTurnOptions {
                model: Some("gpt-5.4".to_string()),
                plan_mode: TerminalToggleOverride::Enabled,
                fast_mode: TerminalToggleOverride::Enabled,
                approval_policy: Some("never".to_string()),
                sandbox_policy: Some(json!({ "type": "dangerFullAccess" })),
            },
        );
        assert_eq!(
            commands,
            vec![
                "/model gpt-5.4",
                "/plan on",
                "/fast on",
                "/permission full-access",
            ]
        );
    }

    #[test]
    fn runtime_options_expand_to_terminal_sync_commands_accepts_legacy_sandbox_variants() {
        let mut commands = Vec::new();
        append_runtime_sync_commands(
            &mut commands,
            &TerminalSessionTurnOptions {
                model: None,
                plan_mode: TerminalToggleOverride::Missing,
                fast_mode: TerminalToggleOverride::Missing,
                approval_policy: Some("on-request".to_string()),
                sandbox_policy: Some(json!({ "type": "workspace-write" })),
            },
        );
        assert_eq!(commands, vec!["/permission auto"]);
    }

    #[test]
    fn runtime_options_expand_off_commands() {
        let mut commands = Vec::new();
        append_runtime_sync_commands(
            &mut commands,
            &TerminalSessionTurnOptions {
                model: None,
                plan_mode: TerminalToggleOverride::Disabled,
                fast_mode: TerminalToggleOverride::Disabled,
                approval_policy: None,
                sandbox_policy: None,
            },
        );
        assert_eq!(commands, vec!["/plan off", "/fast off"]);
    }

    #[test]
    fn attachable_live_session_requires_single_primary_match() {
        let mut matchable = make_session("wt-1");
        matchable.cwd = Some("C:\\repo".to_string());
        matchable.rollout_path =
            Some("C:\\repo\\.codex\\sessions\\rollout-thread-1.jsonl".to_string());
        matchable.router_confirmed = false;

        let mut duplicate = matchable.clone();
        duplicate.wt_session = "wt-2".to_string();

        let mut agent = matchable.clone();
        agent.is_agent = true;
        agent.wt_session = "wt-agent".to_string();

        assert_eq!(
            select_attachable_live_session_by_cwd(
                &[matchable.clone()],
                Some(WorkspaceTarget::Windows),
                "C:/repo"
            )
            .and_then(|session| session.codex_session_id),
            Some("thread-1".to_string())
        );
        assert!(select_attachable_live_session_by_cwd(
            &[matchable.clone(), duplicate],
            Some(WorkspaceTarget::Windows),
            "C:/repo"
        )
        .is_none());
        assert!(select_attachable_live_session_by_cwd(
            &[agent],
            Some(WorkspaceTarget::Windows),
            "C:/repo"
        )
        .is_none());
    }
}
