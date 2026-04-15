use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::OnceLock;

#[cfg(windows)]
use std::collections::HashSet;
#[cfg(windows)]
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
#[cfg(windows)]
use winreg::RegKey;

#[cfg(windows)]
const TAILSCALE_CREATE_NO_WINDOW: u32 = 0x08000000;

const TAILSCALE_DIAGNOSTIC_CACHE_TTL_MS: u64 = 5_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TailscaleBootstrapSummary {
    pub last_stage: Option<String>,
    pub last_detail: Option<String>,
    pub updated_at_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TailscaleDiagnosticSnapshot {
    pub installed: bool,
    pub connected: bool,
    pub backend_state: Option<String>,
    pub dns_name: Option<String>,
    pub ipv4: Vec<String>,
    pub reachable_ipv4: Vec<String>,
    pub gateway_reachable: bool,
    pub needs_gateway_restart: bool,
    pub status_error: Option<String>,
    pub command_path: String,
    pub command_source: String,
    pub probe: TailscaleProbeReport,
    pub bootstrap: Option<TailscaleBootstrapSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TailscaleCommandSource {
    RegistryAppPath,
    RegistryInstallLocation,
    StandardInstallRoot,
    Path,
}

impl std::fmt::Display for TailscaleCommandSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::RegistryAppPath => "registry_app_path",
            Self::RegistryInstallLocation => "registry_install_location",
            Self::StandardInstallRoot => "standard_install_root",
            Self::Path => "path",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TailscaleCliProbeError {
    NotFound,
    LaunchBlocked(String),
    LaunchFailed(String),
    NotConnected,
    BadJson(String),
}

impl TailscaleCliProbeError {
    fn outcome(&self) -> &'static str {
        match self {
            Self::NotFound => "not_found",
            Self::LaunchBlocked(_) => "launch_blocked",
            Self::LaunchFailed(_) => "launch_failed",
            Self::NotConnected => "not_connected",
            Self::BadJson(_) => "bad_json",
        }
    }

    fn detail(&self) -> Option<String> {
        match self {
            Self::LaunchBlocked(detail) | Self::LaunchFailed(detail) | Self::BadJson(detail) => {
                Some(detail.clone())
            }
            Self::NotFound | Self::NotConnected => None,
        }
    }

    fn status_code(&self) -> String {
        match self {
            Self::NotFound => "tailscale_not_found".to_string(),
            Self::LaunchBlocked(_) => "tailscale_launch_blocked".to_string(),
            Self::LaunchFailed(_) => "tailscale_launch_failed".to_string(),
            Self::NotConnected => "tailscale_not_connected".to_string(),
            Self::BadJson(_) => "tailscale_bad_json".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TailscaleProbeAttempt {
    pub command_path: String,
    pub source: TailscaleCommandSource,
    pub outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TailscaleProbeReport {
    pub attempts: Vec<TailscaleProbeAttempt>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_command_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_command_source: Option<TailscaleCommandSource>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TailscaleBaseStatus {
    installed: bool,
    connected: bool,
    backend_state: Option<String>,
    dns_name: Option<String>,
    ipv4: Vec<String>,
    status_error: Option<String>,
    command_path: String,
    command_source: String,
    probe: TailscaleProbeReport,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TailscaleCommandResolution {
    path: PathBuf,
    source: TailscaleCommandSource,
}

fn tailscale_hidden_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    #[cfg(windows)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(not(windows))]
    let cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        std::os::windows::process::CommandExt::creation_flags(&mut cmd, TAILSCALE_CREATE_NO_WINDOW);
    }
    cmd
}

#[cfg(test)]
fn resolve_tailscale_command_resolution_from_roots<I>(
    roots: I,
) -> Option<TailscaleCommandResolution>
where
    I: IntoIterator<Item = PathBuf>,
{
    roots.into_iter().find_map(|root| {
        let candidate = root.join("Tailscale").join("tailscale.exe");
        candidate.exists().then_some(TailscaleCommandResolution {
            path: candidate,
            source: TailscaleCommandSource::StandardInstallRoot,
        })
    })
}

#[cfg(windows)]
fn registry_string_value(root: &RegKey, subkey: &str, value_name: &str) -> Option<String> {
    let key = root.open_subkey(subkey).ok()?;
    key.get_value::<String, _>(value_name)
        .ok()
        .map(|value| value.trim().trim_matches('"').to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(windows)]
fn registry_path_from_text(value: &str) -> Option<PathBuf> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let raw = trimmed.trim_matches('"').trim_end_matches(',').trim();
    if raw.is_empty() {
        return None;
    }
    if PathBuf::from(raw).exists() {
        return Some(PathBuf::from(raw));
    }
    if let Some(rest) = trimmed.strip_prefix('"') {
        let command = rest
            .split('"')
            .next()
            .map(str::trim)?
            .trim_end_matches(',')
            .trim();
        if !command.is_empty() {
            return Some(PathBuf::from(command));
        }
    }
    if let Some(exe_idx) = raw.to_ascii_lowercase().find(".exe") {
        let command = raw[..exe_idx + 4].trim_end_matches(',').trim();
        if !command.is_empty() {
            return Some(PathBuf::from(command));
        }
    }
    raw.split(|ch: char| ch.is_whitespace() || ch == ',')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

#[cfg(windows)]
fn registry_install_dir_from_text(value: &str) -> Option<PathBuf> {
    let path = registry_path_from_text(value)?;
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
    {
        path.parent().map(PathBuf::from)
    } else if path.is_dir() {
        Some(path)
    } else {
        path.parent().map(PathBuf::from)
    }
}

#[cfg(windows)]
fn registry_tailscale_command_resolutions() -> Vec<TailscaleCommandResolution> {
    let roots = [
        (
            RegKey::predef(HKEY_LOCAL_MACHINE),
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\tailscale.exe",
            TailscaleCommandSource::RegistryAppPath,
        ),
        (
            RegKey::predef(HKEY_LOCAL_MACHINE),
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\tailscale.exe",
            TailscaleCommandSource::RegistryAppPath,
        ),
        (
            RegKey::predef(HKEY_CURRENT_USER),
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\tailscale.exe",
            TailscaleCommandSource::RegistryAppPath,
        ),
    ];

    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    for (root, subkey, source) in roots {
        if let Some(path) = registry_string_value(&root, subkey, "") {
            let candidate = registry_path_from_text(&path).unwrap_or_else(|| PathBuf::from(path));
            if seen.insert(candidate.clone()) {
                candidates.push(TailscaleCommandResolution {
                    path: candidate,
                    source: source.clone(),
                });
            }
        }
    }

    let uninstall_roots = [
        (
            RegKey::predef(HKEY_LOCAL_MACHINE),
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
        (
            RegKey::predef(HKEY_LOCAL_MACHINE),
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
        (
            RegKey::predef(HKEY_CURRENT_USER),
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
    ];
    for (root, subkey) in uninstall_roots {
        let Ok(uninstall) = root.open_subkey(subkey) else {
            continue;
        };
        for key_name in uninstall.enum_keys().flatten() {
            let Ok(app) = uninstall.open_subkey(&key_name) else {
                continue;
            };
            let Ok(display_name) = app.get_value::<String, _>("DisplayName") else {
                continue;
            };
            if !display_name.to_ascii_lowercase().contains("tailscale") {
                continue;
            }
            let install_location = app
                .get_value::<String, _>("InstallLocation")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            let install_dir = install_location
                .as_deref()
                .and_then(registry_install_dir_from_text)
                .or_else(|| {
                    app.get_value::<String, _>("DisplayIcon")
                        .ok()
                        .and_then(|value| registry_install_dir_from_text(&value))
                })
                .or_else(|| {
                    app.get_value::<String, _>("UninstallString")
                        .ok()
                        .and_then(|value| registry_install_dir_from_text(&value))
                });
            if let Some(install_dir) = install_dir {
                let candidate = install_dir.join("tailscale.exe");
                if candidate.exists() && seen.insert(candidate.clone()) {
                    candidates.push(TailscaleCommandResolution {
                        path: candidate,
                        source: TailscaleCommandSource::RegistryInstallLocation,
                    });
                }
            }
        }
    }

    candidates
}

#[cfg(test)]
fn resolve_tailscale_command_path_from_roots<I>(roots: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = PathBuf>,
{
    resolve_tailscale_command_resolution_from_roots(roots).map(|resolution| resolution.path)
}

fn enumerate_tailscale_command_resolutions() -> Vec<TailscaleCommandResolution> {
    let mut candidates = Vec::new();

    #[cfg(windows)]
    {
        let mut seen = HashSet::new();
        for resolution in registry_tailscale_command_resolutions() {
            if seen.insert(resolution.path.clone()) {
                candidates.push(resolution);
            }
        }

        let roots = [
            std::env::var_os("ProgramFiles"),
            std::env::var_os("ProgramFiles(x86)"),
            std::env::var_os("ProgramW6432"),
        ]
        .into_iter()
        .flatten()
        .map(PathBuf::from);

        for root in roots {
            let candidate = root.join("Tailscale").join("tailscale.exe");
            if seen.insert(candidate.clone()) {
                candidates.push(TailscaleCommandResolution {
                    path: candidate,
                    source: TailscaleCommandSource::StandardInstallRoot,
                });
            }
        }

        if seen.insert(PathBuf::from("tailscale")) {
            candidates.push(TailscaleCommandResolution {
                path: PathBuf::from("tailscale"),
                source: TailscaleCommandSource::Path,
            });
        }
    }

    #[cfg(not(windows))]
    {
        candidates.push(TailscaleCommandResolution {
            path: PathBuf::from("tailscale"),
            source: TailscaleCommandSource::Path,
        });
    }

    candidates
}

fn resolve_tailscale_command_resolution() -> TailscaleCommandResolution {
    enumerate_tailscale_command_resolutions()
        .into_iter()
        .next()
        .unwrap_or_else(|| TailscaleCommandResolution {
            path: PathBuf::from("tailscale"),
            source: TailscaleCommandSource::Path,
        })
}

pub(crate) fn resolve_tailscale_command_path() -> PathBuf {
    resolve_tailscale_command_resolution().path
}

fn parse_tailscale_summary(parsed: &Value) -> TailscaleBaseStatus {
    let backend_state = parsed
        .get("BackendState")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let connected = backend_state
        .as_deref()
        .is_some_and(|state| matches!(state, "Running" | "Starting"));

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

    TailscaleBaseStatus {
        installed: true,
        connected,
        backend_state,
        dns_name: if dns_name.is_empty() {
            None
        } else {
            Some(dns_name)
        },
        ipv4,
        status_error: None,
        command_path: String::new(),
        command_source: String::new(),
        probe: TailscaleProbeReport {
            attempts: Vec::new(),
            selected_command_path: None,
            selected_command_source: None,
        },
    }
}

fn tailscale_status_json(command_path: &std::path::Path) -> Result<Value, TailscaleCliProbeError> {
    let output = tailscale_hidden_command(command_path)
        .args(["status", "--json"])
        .output()
        .map_err(|err| match err.kind() {
            std::io::ErrorKind::NotFound => TailscaleCliProbeError::NotFound,
            std::io::ErrorKind::PermissionDenied => {
                TailscaleCliProbeError::LaunchBlocked(err.to_string())
            }
            _ => TailscaleCliProbeError::LaunchFailed(err.to_string()),
        })?;
    if !output.status.success() {
        return Err(TailscaleCliProbeError::NotConnected);
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|err| TailscaleCliProbeError::BadJson(err.to_string()))
}

fn attempt_from_probe_error(
    resolution: &TailscaleCommandResolution,
    error: &TailscaleCliProbeError,
) -> TailscaleProbeAttempt {
    TailscaleProbeAttempt {
        command_path: resolution.path.display().to_string(),
        source: resolution.source.clone(),
        outcome: error.outcome().to_string(),
        detail: error.detail(),
    }
}

fn read_gateway_bootstrap_summary() -> Option<TailscaleBootstrapSummary> {
    let path = crate::diagnostics::current_user_data_dir()?.join("gateway-bootstrap.json");
    let bytes = std::fs::read(path).ok()?;
    let parsed = serde_json::from_slice::<Value>(&bytes).ok()?;
    let stages = parsed.get("stages").and_then(|v| v.as_array())?;
    let last = stages.last()?;
    Some(TailscaleBootstrapSummary {
        last_stage: last
            .get("stage")
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        last_detail: last
            .get("detail")
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        updated_at_unix_ms: parsed.get("updatedAtUnixMs").and_then(|v| v.as_u64()),
    })
}

fn current_tailscale_base_status_uncached() -> TailscaleBaseStatus {
    let candidates = enumerate_tailscale_command_resolutions();
    let mut attempts = Vec::new();
    let mut last_probe_error: Option<TailscaleCliProbeError> = None;

    for resolution in candidates {
        match tailscale_status_json(&resolution.path) {
            Ok(parsed) => {
                let mut base = parse_tailscale_summary(&parsed);
                base.command_path = resolution.path.display().to_string();
                base.command_source = resolution.source.to_string();
                base.probe = TailscaleProbeReport {
                    attempts,
                    selected_command_path: Some(base.command_path.clone()),
                    selected_command_source: Some(resolution.source.clone()),
                };
                return base;
            }
            Err(err) => {
                let err_clone = err.clone();
                attempts.push(attempt_from_probe_error(&resolution, &err));
                match err {
                    TailscaleCliProbeError::NotFound => {
                        if last_probe_error.is_none() {
                            last_probe_error = Some(TailscaleCliProbeError::NotFound);
                        }
                    }
                    TailscaleCliProbeError::LaunchBlocked(_)
                    | TailscaleCliProbeError::LaunchFailed(_) => {
                        last_probe_error = Some(err_clone);
                    }
                    TailscaleCliProbeError::NotConnected | TailscaleCliProbeError::BadJson(_) => {
                        let command_path = resolution.path.display().to_string();
                        let command_source = resolution.source.to_string();
                        let selected_command_path = command_path.clone();
                        let selected_command_source = resolution.source.clone();
                        return TailscaleBaseStatus {
                            installed: true,
                            connected: false,
                            backend_state: None,
                            dns_name: None,
                            ipv4: Vec::new(),
                            status_error: Some(err_clone.status_code()),
                            command_path,
                            command_source,
                            probe: TailscaleProbeReport {
                                attempts,
                                selected_command_path: Some(selected_command_path),
                                selected_command_source: Some(selected_command_source),
                            },
                        };
                    }
                }
            }
        }
    }

    let final_error = last_probe_error.unwrap_or(TailscaleCliProbeError::NotFound);
    TailscaleBaseStatus {
        installed: false,
        connected: false,
        backend_state: None,
        dns_name: None,
        ipv4: Vec::new(),
        status_error: Some(final_error.status_code()),
        command_path: String::new(),
        command_source: String::new(),
        probe: TailscaleProbeReport {
            attempts,
            selected_command_path: None,
            selected_command_source: None,
        },
    }
}

fn probe_gateway_addr(addr: SocketAddr) -> bool {
    std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(180)).is_ok()
}

fn resolve_reachable_gateway_ipv4(ipv4: &[String], listen_port: u16) -> Vec<String> {
    ipv4.iter()
        .filter_map(|ip| {
            let parsed_ip = ip.parse().ok()?;
            let addr = SocketAddr::new(parsed_ip, listen_port);
            probe_gateway_addr(addr).then(|| ip.clone())
        })
        .collect()
}

fn current_tailscale_base_status() -> TailscaleBaseStatus {
    static CACHE: OnceLock<RwLock<Option<(u64, TailscaleBaseStatus)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| RwLock::new(None));
    let now = crate::orchestrator::store::unix_ms();
    if let Some((captured_at, snapshot)) = cache.read().clone() {
        if now.saturating_sub(captured_at) < TAILSCALE_DIAGNOSTIC_CACHE_TTL_MS {
            return snapshot;
        }
    }
    let snapshot = current_tailscale_base_status_uncached();
    *cache.write() = Some((now, snapshot.clone()));
    snapshot
}

pub(crate) fn current_tailscale_diagnostic_snapshot(
    listen_port: u16,
) -> TailscaleDiagnosticSnapshot {
    static CACHE: OnceLock<RwLock<Option<(u64, TailscaleDiagnosticSnapshot)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| RwLock::new(None));
    let now = crate::orchestrator::store::unix_ms();
    if let Some((captured_at, snapshot)) = cache.read().clone() {
        if now.saturating_sub(captured_at) < TAILSCALE_DIAGNOSTIC_CACHE_TTL_MS {
            return snapshot;
        }
    }
    let snapshot = current_tailscale_diagnostic_snapshot_uncached(listen_port);
    *cache.write() = Some((now, snapshot.clone()));
    snapshot
}

pub(crate) fn current_tailscale_diagnostic_snapshot_uncached(
    listen_port: u16,
) -> TailscaleDiagnosticSnapshot {
    let base = current_tailscale_base_status();
    let reachable_ipv4 = if base.connected {
        resolve_reachable_gateway_ipv4(&base.ipv4, listen_port)
    } else {
        Vec::new()
    };
    let gateway_reachable = !reachable_ipv4.is_empty();
    TailscaleDiagnosticSnapshot {
        installed: base.installed,
        connected: base.connected,
        backend_state: base.backend_state,
        dns_name: base.dns_name,
        ipv4: base.ipv4.clone(),
        reachable_ipv4,
        gateway_reachable,
        needs_gateway_restart: base.connected && !base.ipv4.is_empty() && !gateway_reachable,
        status_error: base.status_error,
        command_path: base.command_path,
        command_source: base.command_source,
        probe: base.probe,
        bootstrap: read_gateway_bootstrap_summary(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        parse_tailscale_summary, read_gateway_bootstrap_summary,
        resolve_tailscale_command_path_from_roots, TailscaleBaseStatus, TailscaleProbeReport,
    };

    #[test]
    fn parse_tailscale_summary_reads_backend_dns_and_ipv4() {
        let parsed = serde_json::json!({
            "BackendState": "Running",
            "Self": {
                "DNSName": "desktop-kk6sa2d-1.tail997985.ts.net.",
                "TailscaleIPs": ["100.64.208.117", "fd7a:115c:a1e0::201:d089"]
            }
        });
        let summary = parse_tailscale_summary(&parsed);
        assert_eq!(
            summary,
            TailscaleBaseStatus {
                installed: true,
                connected: true,
                backend_state: Some("Running".to_string()),
                dns_name: Some("desktop-kk6sa2d-1.tail997985.ts.net".to_string()),
                ipv4: vec!["100.64.208.117".to_string()],
                status_error: None,
                command_path: String::new(),
                command_source: String::new(),
                probe: TailscaleProbeReport {
                    attempts: Vec::new(),
                    selected_command_path: None,
                    selected_command_source: None,
                },
            }
        );
    }

    #[test]
    fn probe_errors_keep_launch_failures_distinct_from_missing_cli() {
        let blocked = super::TailscaleCliProbeError::LaunchBlocked("access denied".to_string());
        assert_eq!(blocked.outcome(), "launch_blocked");
        assert_eq!(blocked.status_code(), "tailscale_launch_blocked");

        let launch_failed = super::TailscaleCliProbeError::LaunchFailed("bad image".to_string());
        assert_eq!(launch_failed.outcome(), "launch_failed");
        assert_eq!(launch_failed.status_code(), "tailscale_launch_failed");

        let bad_json = super::TailscaleCliProbeError::BadJson("unexpected token".to_string());
        assert_eq!(bad_json.outcome(), "bad_json");
        assert_eq!(bad_json.status_code(), "tailscale_bad_json");
    }

    #[test]
    fn gateway_bootstrap_summary_reads_last_stage() {
        let temp = tempfile::tempdir().expect("temp dir");
        let previous = crate::diagnostics::set_test_user_data_dir_override(Some(temp.path()));
        std::fs::write(
            temp.path().join("gateway-bootstrap.json"),
            serde_json::to_vec(&serde_json::json!({
                "stages": [
                    { "stage": "a", "detail": null, "updatedAtUnixMs": 1 },
                    { "stage": "tailscale_ipv4_detect_ok", "detail": "count=1", "updatedAtUnixMs": 2 }
                ],
                "updatedAtUnixMs": 99
            }))
            .expect("json"),
        )
        .expect("write bootstrap");

        let summary = read_gateway_bootstrap_summary().expect("bootstrap summary");
        assert_eq!(
            summary.last_stage.as_deref(),
            Some("tailscale_ipv4_detect_ok")
        );
        assert_eq!(summary.last_detail.as_deref(), Some("count=1"));
        assert_eq!(summary.updated_at_unix_ms, Some(99));
        crate::diagnostics::set_test_user_data_dir_override(previous.as_deref());
    }

    #[test]
    fn gateway_bootstrap_summary_uses_thread_local_test_override() {
        let temp = tempfile::tempdir().expect("temp dir");
        let previous = crate::diagnostics::set_test_user_data_dir_override(Some(temp.path()));
        std::fs::write(
            temp.path().join("gateway-bootstrap.json"),
            serde_json::to_vec(&serde_json::json!({
                "stages": [
                    { "stage": "tailscale_ok", "detail": "ready", "updatedAtUnixMs": 7 }
                ],
                "updatedAtUnixMs": 7
            }))
            .expect("json"),
        )
        .expect("write bootstrap");

        let summary = read_gateway_bootstrap_summary().expect("bootstrap summary");
        assert_eq!(summary.last_stage.as_deref(), Some("tailscale_ok"));
        assert_eq!(summary.last_detail.as_deref(), Some("ready"));
        crate::diagnostics::set_test_user_data_dir_override(previous.as_deref());
    }

    #[test]
    fn resolve_tailscale_command_path_prefers_standard_install_root() {
        let temp = tempfile::tempdir().expect("temp dir");
        let install_root = temp.path().join("Program Files");
        let tailscale_exe = install_root.join("Tailscale").join("tailscale.exe");
        std::fs::create_dir_all(tailscale_exe.parent().expect("tailscale parent directory"))
            .expect("create tailscale directory");
        std::fs::write(&tailscale_exe, b"fake tailscale binary").expect("write tailscale binary");

        let resolved = resolve_tailscale_command_path_from_roots([install_root]);

        assert_eq!(resolved.as_deref(), Some(tailscale_exe.as_path()));
    }

    #[cfg(windows)]
    #[test]
    fn registry_path_parser_handles_quoted_command_lines() {
        let path =
            super::registry_path_from_text(r#""C:\Program Files\Tailscale\Uninstall.exe",0 /S"#)
                .expect("path");
        assert_eq!(
            path,
            std::path::PathBuf::from(r"C:\Program Files\Tailscale\Uninstall.exe")
        );
        let install_dir = super::registry_install_dir_from_text(
            r#""C:\Program Files\Tailscale\Uninstall.exe",0 /S"#,
        )
        .expect("install dir");
        assert_eq!(
            install_dir,
            std::path::PathBuf::from(r"C:\Program Files\Tailscale")
        );
    }
}
