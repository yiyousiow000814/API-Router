use serde::Serialize;
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;

#[derive(Debug, Clone, Serialize)]
pub struct FirewallStatusSnapshot {
    pub supported: bool,
    pub rule_name: String,
    pub required_profiles: String,
    pub required_protocol: String,
    pub required_local_port: String,
    pub rule_sufficient: bool,
    pub current_profiles: String,
    pub current_protocol: String,
    pub current_local_port: String,
    pub current_action: String,
    pub current_direction: String,
    pub last_checked_unix_ms: u64,
    pub last_fix_requested_unix_ms: u64,
    pub last_fix_error: Option<String>,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Default)]
struct FirewallRuntimeStatus {
    last_checked_unix_ms: u64,
    last_fix_requested_unix_ms: u64,
    last_fix_error: Option<String>,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Default)]
struct FirewallRuleInspection {
    profiles: String,
    protocol: String,
    local_port: String,
    action: String,
    direction: String,
    sufficient: bool,
}

#[cfg(target_os = "windows")]
const API_ROUTER_UDP_RULE_NAME: &str = "API Router Allow UDP";
#[cfg(target_os = "windows")]
const API_ROUTER_UDP_RULE_PROFILES: &str = "domain,private,public";
#[cfg(target_os = "windows")]
const API_ROUTER_UDP_RULE_PORT: &str = "38455";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
static FIREWALL_RUNTIME_STATUS: std::sync::OnceLock<parking_lot::RwLock<FirewallRuntimeStatus>> =
    std::sync::OnceLock::new();

#[cfg(target_os = "windows")]
fn firewall_runtime_status() -> &'static parking_lot::RwLock<FirewallRuntimeStatus> {
    FIREWALL_RUNTIME_STATUS
        .get_or_init(|| parking_lot::RwLock::new(FirewallRuntimeStatus::default()))
}

#[cfg(target_os = "windows")]
fn hidden_command(program: &str) -> std::process::Command {
    use std::os::windows::process::CommandExt;

    let mut cmd = std::process::Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(target_os = "windows")]
pub fn ensure_api_router_udp_firewall_rule(app_path: &std::path::Path) {
    let now = crate::orchestrator::store::unix_ms();
    let inspection = inspect_rule();
    {
        let mut status = firewall_runtime_status().write();
        status.last_checked_unix_ms = now;
    }
    if inspection.sufficient {
        return;
    }
    let request_result = request_elevated_udp_rule_fix(app_path);
    let mut status = firewall_runtime_status().write();
    status.last_fix_requested_unix_ms = now;
    status.last_fix_error = request_result.err();
}

#[cfg(target_os = "windows")]
pub fn status_snapshot() -> FirewallStatusSnapshot {
    let inspection = inspect_rule();
    let runtime = firewall_runtime_status().read().clone();
    FirewallStatusSnapshot {
        supported: true,
        rule_name: API_ROUTER_UDP_RULE_NAME.to_string(),
        required_profiles: API_ROUTER_UDP_RULE_PROFILES.to_string(),
        required_protocol: "UDP".to_string(),
        required_local_port: API_ROUTER_UDP_RULE_PORT.to_string(),
        rule_sufficient: inspection.sufficient,
        current_profiles: inspection.profiles,
        current_protocol: inspection.protocol,
        current_local_port: inspection.local_port,
        current_action: inspection.action,
        current_direction: inspection.direction,
        last_checked_unix_ms: runtime.last_checked_unix_ms,
        last_fix_requested_unix_ms: runtime.last_fix_requested_unix_ms,
        last_fix_error: runtime.last_fix_error,
    }
}

#[cfg(target_os = "windows")]
fn inspect_rule() -> FirewallRuleInspection {
    let output = show_firewall_rule(API_ROUTER_UDP_RULE_NAME).unwrap_or_default();
    FirewallRuleInspection {
        profiles: extract_rule_value(&output, "Profiles:"),
        protocol: extract_rule_value(&output, "Protocol:"),
        local_port: extract_rule_value(&output, "LocalPort:"),
        action: extract_rule_value(&output, "Action:"),
        direction: extract_rule_value(&output, "Direction:"),
        sufficient: rule_output_is_sufficient(
            &output,
            API_ROUTER_UDP_RULE_PROFILES,
            API_ROUTER_UDP_RULE_PORT,
        ),
    }
}

#[cfg(target_os = "windows")]
fn show_firewall_rule(rule_name: &str) -> Result<String, String> {
    let output = hidden_command("netsh")
        .args(["advfirewall", "firewall", "show", "rule"])
        .arg(format!("name={rule_name}"))
        .output()
        .map_err(|err| format!("failed to inspect firewall rule: {err}"))?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(target_os = "windows")]
fn request_elevated_udp_rule_fix(app_path: &std::path::Path) -> Result<(), String> {
    use base64::Engine;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let script = build_udp_rule_script(app_path);
    let encoded = base64::engine::general_purpose::STANDARD.encode(encode_utf16le(&script));
    let parameters = format!(
        "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand {encoded}"
    );
    let operation = widestr("runas");
    let file = widestr("powershell.exe");
    let params = widestr(&parameters);

    let result = unsafe {
        ShellExecuteW(
            0,
            operation.as_ptr(),
            file.as_ptr(),
            params.as_ptr(),
            std::ptr::null(),
            SW_HIDE,
        )
    } as isize;

    if result <= 32 {
        return Err(format!(
            "failed to request elevated firewall update: ShellExecuteW={result}"
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn build_udp_rule_script(app_path: &std::path::Path) -> String {
    let escaped_program = app_path.display().to_string().replace('\'', "''");
    format!(
        "$program = '{escaped_program}'; \
         netsh advfirewall firewall delete rule name=\"{API_ROUTER_UDP_RULE_NAME}\" program=\"$program\" protocol=UDP localport={API_ROUTER_UDP_RULE_PORT} *> $null; \
         netsh advfirewall firewall add rule name=\"{API_ROUTER_UDP_RULE_NAME}\" dir=in action=allow profile={API_ROUTER_UDP_RULE_PROFILES} program=\"$program\" protocol=UDP localport={API_ROUTER_UDP_RULE_PORT} *> $null"
    )
}

#[cfg(target_os = "windows")]
fn encode_utf16le(value: &str) -> Vec<u8> {
    value
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect()
}

#[cfg(target_os = "windows")]
fn widestr(value: &str) -> Vec<u16> {
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn rule_output_is_sufficient(output: &str, required_profiles: &str, required_port: &str) -> bool {
    let normalized = output.to_ascii_lowercase();
    if normalized.contains("no rules match") {
        return false;
    }
    let profiles = extract_rule_value(output, "Profiles:");
    let protocol = extract_rule_value(output, "Protocol:");
    let local_port = extract_rule_value(output, "LocalPort:");
    let action = extract_rule_value(output, "Action:");
    let direction = extract_rule_value(output, "Direction:");
    profiles_match(&profiles, required_profiles)
        && protocol.eq_ignore_ascii_case("UDP")
        && local_port == required_port
        && action.eq_ignore_ascii_case("Allow")
        && direction.eq_ignore_ascii_case("In")
}

fn extract_rule_value(output: &str, key: &str) -> String {
    output
        .lines()
        .find_map(|line| line.strip_prefix(key))
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

fn profiles_match(actual: &str, required: &str) -> bool {
    let actual_set = actual
        .split(',')
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .collect::<std::collections::BTreeSet<_>>();
    let required_set = required
        .split(',')
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .collect::<std::collections::BTreeSet<_>>();
    !required_set.is_empty() && required_set.is_subset(&actual_set)
}

#[cfg(not(target_os = "windows"))]
pub fn ensure_api_router_udp_firewall_rule(_app_path: &std::path::Path) {}

#[cfg(not(target_os = "windows"))]
pub fn status_snapshot() -> FirewallStatusSnapshot {
    FirewallStatusSnapshot {
        supported: false,
        rule_name: "API Router Allow UDP".to_string(),
        required_profiles: "domain,private,public".to_string(),
        required_protocol: "UDP".to_string(),
        required_local_port: "38455".to_string(),
        rule_sufficient: false,
        current_profiles: String::new(),
        current_protocol: String::new(),
        current_local_port: String::new(),
        current_action: String::new(),
        current_direction: String::new(),
        last_checked_unix_ms: 0,
        last_fix_requested_unix_ms: 0,
        last_fix_error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::rule_output_is_sufficient;

    #[test]
    fn firewall_rule_output_requires_udp_public_private_and_domain_profiles() {
        let ok = r#"
Rule Name:                            API Router Allow UDP
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Domain,Private,Public
Protocol:                             UDP
LocalPort:                            38455
Action:                               Allow
"#;
        assert!(rule_output_is_sufficient(
            ok,
            "domain,private,public",
            "38455"
        ));

        let private_only = ok.replace("Domain,Private,Public", "Private");
        assert!(!rule_output_is_sufficient(
            &private_only,
            "domain,private,public",
            "38455"
        ));

        let tcp = ok.replace("UDP", "TCP");
        assert!(!rule_output_is_sufficient(
            &tcp,
            "domain,private,public",
            "38455"
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn udp_rule_script_targets_udp_port_and_program_path() {
        use super::build_udp_rule_script;

        let path = std::path::Path::new(r"C:\Program Files\API Router\API Router.exe");
        let script = build_udp_rule_script(path);
        assert!(script.contains("protocol=UDP"));
        assert!(script.contains("localport=38455"));
        assert!(script.contains("API Router Allow UDP"));
        assert!(script.contains("API Router.exe"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn encoded_command_bytes_use_utf16le() {
        use super::encode_utf16le;

        let bytes = encode_utf16le("AB");
        assert_eq!(bytes, vec![65, 0, 66, 0]);
    }
}
