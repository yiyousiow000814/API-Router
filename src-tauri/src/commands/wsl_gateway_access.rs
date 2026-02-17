use std::fs;
use std::process::Command;
use serde_json::json;
use crate::constants::{GATEWAY_ANY_HOST, GATEWAY_WINDOWS_HOST};
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn hidden_command(program: &str) -> Command {
    #[cfg(windows)]
    let mut cmd = Command::new(program);
    #[cfg(not(windows))]
    let cmd = Command::new(program);
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn ps_quote_single(s: &str) -> String {
    s.replace('\'', "''")
}

fn ensure_last_exit_ok(step: &str) -> String {
    format!(
        "if ($LASTEXITCODE -ne 0) {{ throw \"{step} failed with exit code $LASTEXITCODE\" }}"
    )
}

fn authorize_access_script(wsl_host: &str) -> String {
    format!(
        r#"
param(
  [Parameter(Mandatory=$true)][int]$Port,
  [Parameter(Mandatory=$true)][string]$StatusFile
)
$ErrorActionPreference = 'Stop'
try {{
  $null = Start-Service iphlpsvc -ErrorAction SilentlyContinue
  $rule = "API Router WSL Port $Port"
  if (-not (Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue)) {{
    New-NetFirewallRule -DisplayName $rule -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Any | Out-Null
  }}
  netsh interface portproxy delete v4tov4 listenaddress={wsl_host} listenport=$Port | Out-Null
  netsh interface portproxy delete v4tov4 listenaddress={any_host} listenport=$Port | Out-Null
  netsh interface portproxy add v4tov4 listenaddress={wsl_host} listenport=$Port connectaddress={win_host} connectport=$Port | Out-Null
  {check_add}
  Set-Content -Path $StatusFile -Value 'ok' -Encoding utf8
}} catch {{
  Set-Content -Path $StatusFile -Value ("error: " + $_.Exception.Message) -Encoding utf8
  exit 1
}}
"#,
        wsl_host = wsl_host,
        any_host = GATEWAY_ANY_HOST,
        win_host = GATEWAY_WINDOWS_HOST,
        check_add = ensure_last_exit_ok("portproxy add wsl host"),
    )
}

fn revoke_access_script(wsl_host: &str) -> String {
    format!(
        r#"
param(
  [Parameter(Mandatory=$true)][int]$Port,
  [Parameter(Mandatory=$true)][string]$StatusFile
)
$ErrorActionPreference = 'Stop'
try {{
  $rule = "API Router WSL Port $Port"
  $r = Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue
  if ($r) {{ Remove-NetFirewallRule -DisplayName $rule | Out-Null }}
  netsh interface portproxy delete v4tov4 listenaddress={wsl_host} listenport=$Port | Out-Null
  netsh interface portproxy delete v4tov4 listenaddress={any_host} listenport=$Port | Out-Null
  Set-Content -Path $StatusFile -Value 'ok' -Encoding utf8
}} catch {{
  Set-Content -Path $StatusFile -Value ("error: " + $_.Exception.Message) -Encoding utf8
  exit 1
}}
    "#,
        wsl_host = wsl_host,
        any_host = GATEWAY_ANY_HOST,
    )
}

fn run_elevated_script(script_body: &str, port: u16) -> Result<(), String> {
    let temp = std::env::temp_dir();
    let script_path = temp.join(format!(
        "api_router_wsl_access_{}.ps1",
        crate::orchestrator::store::unix_ms()
    ));
    let status_path = temp.join(format!(
        "api_router_wsl_access_status_{}.txt",
        crate::orchestrator::store::unix_ms()
    ));
    fs::write(&script_path, script_body).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&status_path);

    let script_arg = ps_quote_single(&script_path.to_string_lossy());
    let status_arg = ps_quote_single(&status_path.to_string_lossy());
    let cmd = format!(
        "Start-Process powershell -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','{script}','-Port','{port}','-StatusFile','{status}')",
        script = script_arg,
        port = port,
        status = status_arg
    );
    let launch = hidden_command("powershell.exe")
        .args(["-NoProfile", "-Command", &cmd])
        .status()
        .map_err(|e| e.to_string())?;
    if !launch.success() {
        let _ = fs::remove_file(&script_path);
        return Err("UAC request was cancelled or failed to launch.".to_string());
    }

    let result = fs::read_to_string(&status_path)
        .unwrap_or_else(|_| "error: elevated script did not return status".to_string());
    let _ = fs::remove_file(&script_path);
    let _ = fs::remove_file(&status_path);
    // PowerShell Set-Content -Encoding utf8 may include BOM on Windows PowerShell 5.x.
    // Treat BOM-prefixed "ok" as success to avoid false negatives in UI state updates.
    let trimmed = result.trim().trim_start_matches('\u{feff}').to_string();
    if trimmed.eq_ignore_ascii_case("ok") {
        Ok(())
    } else {
        Err(trimmed)
    }
}

fn authorize_access_impl(port: u16, wsl_host: &str) -> Result<serde_json::Value, String> {
    let script = authorize_access_script(wsl_host);
    run_elevated_script(&script, port)?;
    Ok(json!({
      "ok": true,
      "authorized": access_authorized_impl(port, wsl_host),
      "wsl_host": wsl_host
    }))
}

fn revoke_access_impl(port: u16, wsl_host: &str) -> Result<serde_json::Value, String> {
    let script = revoke_access_script(wsl_host);
    run_elevated_script(&script, port)?;
    Ok(json!({
      "ok": true,
      "authorized": access_authorized_impl(port, wsl_host),
      "wsl_host": wsl_host
    }))
}

fn access_authorized_impl(port: u16, wsl_host: &str) -> bool {
    let out = hidden_command("netsh.exe")
        .args(["interface", "portproxy", "show", "v4tov4"])
        .output();
    let Ok(out) = out else {
        return false;
    };
    if !out.status.success() {
        return false;
    }
    let txt = String::from_utf8_lossy(&out.stdout);
    // WSL2 clients use host IP (detected and pinned at runtime). The proxy still forwards to
    // Windows local gateway listener on 127.0.0.1:<port>.
    has_portproxy_rule(&txt, wsl_host, port, GATEWAY_WINDOWS_HOST, port)
}

fn legacy_conflict_impl(port: u16) -> bool {
    let out = hidden_command("netsh.exe")
        .args(["interface", "portproxy", "show", "v4tov4"])
        .output();
    let Ok(out) = out else {
        return false;
    };
    if !out.status.success() {
        return false;
    }
    let txt = String::from_utf8_lossy(&out.stdout);
    has_portproxy_rule(&txt, GATEWAY_ANY_HOST, port, GATEWAY_WINDOWS_HOST, port)
}

fn has_portproxy_rule(
    netsh_output: &str,
    listen_addr: &str,
    listen_port: u16,
    connect_addr: &str,
    connect_port: u16,
) -> bool {
    let listen_addr = listen_addr.to_ascii_lowercase();
    let connect_addr = connect_addr.to_ascii_lowercase();
    let listen_port = listen_port.to_string();
    let connect_port = connect_port.to_string();
    netsh_output.lines().any(|line| {
        let cols = line
            .split_whitespace()
            .map(|s| s.to_ascii_lowercase())
            .collect::<Vec<_>>();
        cols.len() >= 4
            && cols[0] == listen_addr
            && cols[1] == listen_port
            && cols[2] == connect_addr
            && cols[3] == connect_port
    })
}

#[cfg(test)]
mod wsl_gateway_access_tests {
    use super::{authorize_access_script, revoke_access_script};

    #[test]
    fn authorize_script_checks_netsh_exit_codes() {
        let script = authorize_access_script("172.26.144.1");
        assert!(script.contains("portproxy add wsl host failed with exit code"));
        assert!(script.contains("if ($LASTEXITCODE -ne 0)"));
    }

    #[test]
    fn revoke_script_does_not_fail_when_delete_target_missing() {
        let script = revoke_access_script("172.26.144.1");
        assert!(!script.contains("portproxy delete wsl host failed with exit code"));
    }
}

#[tauri::command]
pub(crate) async fn wsl_gateway_access_status(
    state: tauri::State<'_, app_state::AppState>,
) -> Result<serde_json::Value, String> {
    let port = state.gateway.cfg.read().listen.port;
    let config_path = state.config_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let wsl_host =
            crate::platform::wsl_gateway_host::resolve_wsl_gateway_host(Some(&config_path));
        Ok(json!({
          "ok": true,
          "authorized": access_authorized_impl(port, &wsl_host),
          "legacy_conflict": legacy_conflict_impl(port),
          "wsl_host": wsl_host,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn wsl_gateway_access_quick_status(
    state: tauri::State<'_, app_state::AppState>,
) -> Result<serde_json::Value, String> {
    let port = state.gateway.cfg.read().listen.port;
    let config_path = state.config_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let wsl_host =
            crate::platform::wsl_gateway_host::resolve_wsl_gateway_host(Some(&config_path));
        Ok(json!({
          "ok": true,
          "authorized": access_authorized_impl(port, &wsl_host),
          "legacy_conflict": legacy_conflict_impl(port),
          "wsl_host": wsl_host,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn wsl_gateway_authorize_access(
    state: tauri::State<'_, app_state::AppState>,
) -> Result<serde_json::Value, String> {
    let port = state.gateway.cfg.read().listen.port;
    let config_path = state.config_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let wsl_host =
            crate::platform::wsl_gateway_host::resolve_wsl_gateway_host(Some(&config_path));
        if access_authorized_impl(port, &wsl_host) {
            return Ok(json!({
              "ok": true,
              "authorized": true,
              "wsl_host": wsl_host
            }));
        }
        authorize_access_impl(port, &wsl_host)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn wsl_gateway_revoke_access(
    state: tauri::State<'_, app_state::AppState>,
) -> Result<serde_json::Value, String> {
    let port = state.gateway.cfg.read().listen.port;
    let config_path = state.config_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let wsl_host =
            crate::platform::wsl_gateway_host::resolve_wsl_gateway_host(Some(&config_path));
        if !access_authorized_impl(port, &wsl_host) {
            return Ok(json!({
              "ok": true,
              "authorized": false,
              "wsl_host": wsl_host
            }));
        }
        revoke_access_impl(port, &wsl_host)
    })
    .await
    .map_err(|e| e.to_string())?
}
