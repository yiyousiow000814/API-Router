#[cfg(windows)]
const TAILSCALE_CREATE_NO_WINDOW: u32 = 0x08000000;

fn tailscale_hidden_command(program: &str) -> std::process::Command {
    #[cfg(windows)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(not(windows))]
    let cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        std::os::windows::process::CommandExt::creation_flags(
            &mut cmd,
            TAILSCALE_CREATE_NO_WINDOW,
        );
    }
    cmd
}

#[tauri::command]
pub(crate) async fn tailscale_status() -> Result<Value, String> {
    let output = tailscale_hidden_command("tailscale")
        .args(["status", "--json"])
        .output()
        .map_err(|_| "tailscale_not_found".to_string());

    let Ok(output) = output else {
        return Ok(serde_json::json!({
            "ok": true,
            "installed": false,
            "connected": false,
            "dnsName": Value::Null,
            "ipv4": [],
            "downloadUrl": "https://tailscale.com/download",
        }));
    };

    if !output.status.success() {
        return Ok(serde_json::json!({
            "ok": true,
            "installed": true,
            "connected": false,
            "dnsName": Value::Null,
            "ipv4": [],
            "downloadUrl": "https://tailscale.com/download",
        }));
    }

    let parsed: Value = serde_json::from_slice(&output.stdout).unwrap_or_else(|_| serde_json::json!({}));
    let backend_state = parsed
        .get("BackendState")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let connected = matches!(backend_state, "Running" | "Starting");

    let self_info = parsed.get("Self").cloned().unwrap_or(Value::Null);
    let dns_name = self_info
        .get("DNSName")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .trim_end_matches('.')
        .to_string();

    let mut ipv4 = Vec::new();
    if let Some(arr) = self_info.get("TailscaleIPs").and_then(|v| v.as_array()) {
        for item in arr {
            if let Some(ip) = item.as_str() {
                if ip.contains('.') {
                    ipv4.push(ip.to_string());
                }
            }
        }
    }

    Ok(serde_json::json!({
        "ok": true,
        "installed": true,
        "connected": connected,
        "dnsName": if dns_name.is_empty() { Value::Null } else { Value::String(dns_name) },
        "ipv4": ipv4,
        "downloadUrl": "https://tailscale.com/download",
    }))
}
