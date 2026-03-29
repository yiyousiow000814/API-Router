use crate::orchestrator::gateway::web_codex_home::{resolve_wsl_identity, WorkspaceTarget};
use reqwest::Url;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManagedTerminalLaunchRequest {
    pub server_port: u16,
    pub gateway_token: Option<String>,
    pub workspace_target: WorkspaceTarget,
    pub cwd: Option<String>,
    pub home_override: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManagedTerminalLaunchSpec {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

fn normalize_optional_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn powershell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(test)]
fn test_launch_handler_store() -> &'static std::sync::Mutex<
    Option<std::sync::Arc<dyn Fn(&ManagedTerminalLaunchSpec) -> Result<(), String> + Send + Sync>>,
> {
    static STORE: std::sync::OnceLock<
        std::sync::Mutex<
            Option<
                std::sync::Arc<
                    dyn Fn(&ManagedTerminalLaunchSpec) -> Result<(), String> + Send + Sync,
                >,
            >,
        >,
    > = std::sync::OnceLock::new();
    STORE.get_or_init(|| std::sync::Mutex::new(None))
}

#[cfg(test)]
fn test_wsl_gateway_host_store() -> &'static std::sync::Mutex<Option<String>> {
    static STORE: std::sync::OnceLock<std::sync::Mutex<Option<String>>> =
        std::sync::OnceLock::new();
    STORE.get_or_init(|| std::sync::Mutex::new(None))
}

#[cfg(test)]
fn test_wsl_identity_store() -> &'static std::sync::Mutex<Option<(String, String)>> {
    static STORE: std::sync::OnceLock<std::sync::Mutex<Option<(String, String)>>> =
        std::sync::OnceLock::new();
    STORE.get_or_init(|| std::sync::Mutex::new(None))
}

#[cfg(test)]
pub fn _set_test_launch_handler(
    handler: Option<
        std::sync::Arc<dyn Fn(&ManagedTerminalLaunchSpec) -> Result<(), String> + Send + Sync>,
    >,
) {
    if let Ok(mut guard) = test_launch_handler_store().lock() {
        *guard = handler;
    }
}

#[cfg(test)]
pub fn _set_test_wsl_gateway_host(host: Option<String>) {
    if let Ok(mut guard) = test_wsl_gateway_host_store().lock() {
        *guard = host;
    }
}

#[cfg(test)]
pub fn _set_test_wsl_identity(identity: Option<(String, String)>) {
    if let Ok(mut guard) = test_wsl_identity_store().lock() {
        *guard = identity;
    }
}

fn resolved_wsl_gateway_host() -> String {
    #[cfg(test)]
    if let Ok(guard) = test_wsl_gateway_host_store().lock() {
        if let Some(host) = guard.as_deref() {
            return host.to_string();
        }
    }
    crate::platform::wsl_gateway_host::resolve_wsl_gateway_host(None)
}

fn resolved_wsl_identity() -> Result<(String, String), String> {
    #[cfg(test)]
    if let Ok(guard) = test_wsl_identity_store().lock() {
        if let Some(identity) = guard.clone() {
            return Ok(identity);
        }
    }
    resolve_wsl_identity()
}

const REMOTE_AUTH_TOKEN_ENV: &str = "API_ROUTER_GATEWAY_TOKEN";

fn remote_host_for_workspace(workspace_target: WorkspaceTarget) -> String {
    match workspace_target {
        WorkspaceTarget::Windows => "127.0.0.1".to_string(),
        WorkspaceTarget::Wsl2 => resolved_wsl_gateway_host(),
    }
}

pub fn build_remote_addr(request: &ManagedTerminalLaunchRequest) -> Result<String, String> {
    let mut url = Url::parse(&format!(
        "ws://{}:{}",
        remote_host_for_workspace(request.workspace_target),
        request.server_port
    ))
    .map_err(|error| error.to_string())?;
    url.set_query(None);
    url.set_path("");
    Ok(url.to_string())
}

pub fn build_managed_terminal_launch_spec(
    request: &ManagedTerminalLaunchRequest,
) -> Result<ManagedTerminalLaunchSpec, String> {
    let remote_addr = build_remote_addr(request)?;
    let cwd = normalize_optional_text(request.cwd.as_deref());
    if cwd.is_none() {
        return Err("cwd is required".to_string());
    }
    let home_override = normalize_optional_text(request.home_override.as_deref());
    let gateway_token = normalize_optional_text(request.gateway_token.as_deref());
    match request.workspace_target {
        WorkspaceTarget::Windows => {
            let mut script_parts = Vec::new();
            if let Some(cwd) = cwd.as_deref() {
                let transcript_path = format!("{}\\api-router-managed-terminal.log", cwd);
                script_parts.push(format!(
                    "Start-Transcript -Path {} -Force | Out-Null",
                    powershell_single_quote(&transcript_path)
                ));
            }
            if let Some(token) = gateway_token.as_deref() {
                script_parts.push(format!(
                    "$env:{}={}",
                    REMOTE_AUTH_TOKEN_ENV,
                    powershell_single_quote(token)
                ));
            }
            if let Some(home_override) = home_override.as_deref() {
                script_parts.push(format!(
                    "$env:CODEX_HOME={}",
                    powershell_single_quote(home_override)
                ));
            }
            let mut launch_script = format!(
                "& (Join-Path $env:APPDATA 'npm\\codex.cmd') --remote {}",
                powershell_single_quote(&remote_addr)
            );
            if gateway_token.is_some() {
                launch_script.push_str(&format!(
                    " --remote-auth-token-env {}",
                    powershell_single_quote(REMOTE_AUTH_TOKEN_ENV)
                ));
            }
            if let Some(cwd) = cwd.as_deref() {
                launch_script.push_str(&format!(" --cd {}", powershell_single_quote(cwd)));
            }
            script_parts.push(launch_script);
            let args = vec![
                "/C".to_string(),
                "start".to_string(),
                "".to_string(),
                "powershell.exe".to_string(),
                "-NoLogo".to_string(),
                "-NoExit".to_string(),
                "-Command".to_string(),
                script_parts.join("; "),
            ];
            let mut env = Vec::new();
            if let Some(token) = gateway_token {
                env.push((REMOTE_AUTH_TOKEN_ENV.to_string(), token));
            }
            if let Some(home_override) = home_override {
                env.push(("CODEX_HOME".to_string(), home_override));
            }
            Ok(ManagedTerminalLaunchSpec {
                program: "cmd.exe".to_string(),
                args,
                env,
            })
        }
        WorkspaceTarget::Wsl2 => {
            let (distro, _home) = resolved_wsl_identity()?;
            let mut script = Vec::new();
            if let Some(token) = gateway_token {
                script.push(format!(
                    "export {}={}",
                    REMOTE_AUTH_TOKEN_ENV,
                    shell_single_quote(&token)
                ));
            }
            if let Some(home_override) = home_override {
                script.push(format!(
                    "export CODEX_HOME={}",
                    shell_single_quote(&home_override)
                ));
            }
            if let Some(cwd) = cwd {
                script.push(format!("cd {}", shell_single_quote(&cwd)));
            }
            let mut command = format!("exec codex --remote {}", shell_single_quote(&remote_addr));
            if request
                .gateway_token
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            {
                command.push_str(&format!(
                    " --remote-auth-token-env {}",
                    shell_single_quote(REMOTE_AUTH_TOKEN_ENV)
                ));
            }
            script.push(command);
            Ok(ManagedTerminalLaunchSpec {
                program: "cmd.exe".to_string(),
                args: vec![
                    "/C".to_string(),
                    "start".to_string(),
                    "".to_string(),
                    "wsl.exe".to_string(),
                    "-d".to_string(),
                    distro,
                    "--".to_string(),
                    "bash".to_string(),
                    "-lc".to_string(),
                    script.join("; "),
                ],
                env: Vec::new(),
            })
        }
    }
}

pub fn launch_managed_terminal_surface(
    request: &ManagedTerminalLaunchRequest,
) -> Result<ManagedTerminalLaunchSpec, String> {
    let spec = build_managed_terminal_launch_spec(request)?;
    #[cfg(test)]
    if let Ok(guard) = test_launch_handler_store().lock() {
        if let Some(handler) = guard.as_ref() {
            handler(&spec)?;
            return Ok(spec);
        }
    }

    let mut command = std::process::Command::new(&spec.program);
    command.args(&spec.args);
    for (key, value) in &spec.env {
        command.env(key, value);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.spawn().map_err(|error| error.to_string())?;
    Ok(spec)
}

#[cfg(test)]
mod tests {
    use super::{
        _set_test_wsl_gateway_host, _set_test_wsl_identity, build_managed_terminal_launch_spec,
        build_remote_addr, ManagedTerminalLaunchRequest, REMOTE_AUTH_TOKEN_ENV,
    };
    use crate::orchestrator::gateway::web_codex_home::WorkspaceTarget;

    #[test]
    fn build_remote_addr_uses_base_router_socket() {
        let url = build_remote_addr(&ManagedTerminalLaunchRequest {
            server_port: 4000,
            gateway_token: Some("token-1".to_string()),
            workspace_target: WorkspaceTarget::Windows,
            cwd: Some("C:\\repo".to_string()),
            home_override: Some("C:\\Users\\yiyou\\.codex".to_string()),
        })
        .expect("remote ws url");

        assert_eq!(url, "ws://127.0.0.1:4000/");
    }

    #[test]
    fn windows_launch_spec_uses_remote_interactive_launch_and_codex_home() {
        let spec = build_managed_terminal_launch_spec(&ManagedTerminalLaunchRequest {
            server_port: 4000,
            gateway_token: Some("token-1".to_string()),
            workspace_target: WorkspaceTarget::Windows,
            cwd: Some("C:\\repo".to_string()),
            home_override: Some("C:\\Users\\yiyou\\.codex".to_string()),
        })
        .expect("windows launch spec");

        assert_eq!(spec.program, "cmd.exe");
        assert_eq!(
            spec.args[..7],
            [
                "/C",
                "start",
                "",
                "powershell.exe",
                "-NoLogo",
                "-NoExit",
                "-Command",
            ]
        );
        let command = spec.args.get(7).expect("powershell command");
        assert!(command.contains("Start-Transcript"));
        assert!(command.contains("api-router-managed-terminal.log"));
        assert!(command.contains("$env:API_ROUTER_GATEWAY_TOKEN='token-1'"));
        assert!(command.contains("$env:CODEX_HOME='C:\\Users\\yiyou\\.codex'"));
        assert!(command.contains("Join-Path $env:APPDATA 'npm\\codex.cmd'"));
        assert!(!command.contains("resume "));
        assert!(command.contains("--remote 'ws://127.0.0.1:4000/'"));
        assert!(command.contains("--remote-auth-token-env 'API_ROUTER_GATEWAY_TOKEN'"));
        assert!(command.contains("--cd 'C:\\repo'"));
        assert_eq!(
            spec.env,
            vec![
                (REMOTE_AUTH_TOKEN_ENV.to_string(), "token-1".to_string()),
                (
                    "CODEX_HOME".to_string(),
                    "C:\\Users\\yiyou\\.codex".to_string()
                )
            ]
        );
    }

    #[test]
    fn wsl_launch_spec_uses_gateway_host_and_bash_script() {
        _set_test_wsl_gateway_host(Some("172.29.144.1".to_string()));
        _set_test_wsl_identity(Some(("Ubuntu".to_string(), "/home/yiyou".to_string())));

        let spec = build_managed_terminal_launch_spec(&ManagedTerminalLaunchRequest {
            server_port: 4000,
            gateway_token: Some("token-2".to_string()),
            workspace_target: WorkspaceTarget::Wsl2,
            cwd: Some("/home/yiyou/repo".to_string()),
            home_override: Some("/home/yiyou/.codex".to_string()),
        })
        .expect("wsl launch spec");

        assert_eq!(spec.program, "cmd.exe");
        assert_eq!(
            spec.args,
            vec![
                "/C",
                "start",
                "",
                "wsl.exe",
                "-d",
                "Ubuntu",
                "--",
                "bash",
                "-lc",
                "export API_ROUTER_GATEWAY_TOKEN='token-2'; export CODEX_HOME='/home/yiyou/.codex'; cd '/home/yiyou/repo'; exec codex --remote 'ws://172.29.144.1:4000/' --remote-auth-token-env 'API_ROUTER_GATEWAY_TOKEN'",
            ]
        );

        _set_test_wsl_identity(None);
        _set_test_wsl_gateway_host(None);
    }
}
