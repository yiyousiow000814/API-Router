use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const WSL_HOST_CACHE_FILE: &str = "wsl-gateway-host.txt";
const DETECT_RETRY_MS: u64 = 30_000;

#[derive(Default)]
struct RuntimeCache {
    host: Option<String>,
    last_detect_attempt_unix_ms: u64,
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn cache_path_from_config_path(config_path: &Path) -> PathBuf {
    config_path
        .parent()
        .unwrap_or(Path::new("."))
        .join(WSL_HOST_CACHE_FILE)
}

fn cache_path_from_env() -> Option<PathBuf> {
    let codex_home = std::env::var("CODEX_HOME").ok()?;
    let codex_home = PathBuf::from(codex_home);
    let parent = codex_home.parent()?.to_path_buf();
    Some(parent.join(WSL_HOST_CACHE_FILE))
}

fn resolve_cache_path(config_path: Option<&Path>) -> Option<PathBuf> {
    config_path
        .map(cache_path_from_config_path)
        .or_else(cache_path_from_env)
}

fn normalize_ipv4(raw: &str) -> Option<String> {
    let token = raw
        .trim()
        .split(|c: char| c.is_whitespace() || c == ',' || c == ';')
        .find(|s| !s.trim().is_empty())?
        .trim();
    let ip: Ipv4Addr = token.parse().ok()?;
    Some(ip.to_string())
}

fn read_cached_host(cache_path: &Path) -> Option<String> {
    let txt = std::fs::read_to_string(cache_path).ok()?;
    normalize_ipv4(&txt)
}

fn write_cached_host(cache_path: &Path, host: &str) {
    if let Some(parent) = cache_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(cache_path, format!("{host}\n"));
}

#[cfg(windows)]
fn hidden_wsl_command() -> std::process::Command {
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(windows)]
fn decode_wsl_output(bytes: &[u8]) -> String {
    // `wsl.exe -l -q` commonly returns UTF-16LE on Windows.
    if bytes.len() >= 2 && bytes.len() % 2 == 0 && bytes.iter().skip(1).step_by(2).any(|b| *b == 0)
    {
        let utf16: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&utf16);
    }
    String::from_utf8_lossy(bytes).to_string()
}

#[cfg(windows)]
fn detect_host_in_distro(distro: Option<&str>) -> Option<String> {
    let mut cmd = hidden_wsl_command();
    if let Some(distro) = distro {
        cmd.args(["-d", distro]);
    }
    let out = cmd
        .args([
            "--",
            "sh",
            "-lc",
            "ip route show default 2>/dev/null | awk 'NR==1 {print $3}'",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let txt = String::from_utf8_lossy(&out.stdout);
    normalize_ipv4(&txt)
}

#[cfg(windows)]
fn detect_wsl_gateway_host() -> Option<String> {
    if let Some(host) = detect_host_in_distro(None) {
        return Some(host);
    }

    let distros = hidden_wsl_command().args(["-l", "-q"]).output().ok()?;
    if !distros.status.success() {
        return None;
    }
    for distro in decode_wsl_output(&distros.stdout)
        .lines()
        .map(|s| s.replace('\0', ""))
        .map(|s| s.trim().trim_start_matches('*').trim().to_string())
        .filter(|s| !s.is_empty())
    {
        if let Some(host) = detect_host_in_distro(Some(&distro)) {
            return Some(host);
        }
    }
    None
}

#[cfg(not(windows))]
fn detect_wsl_gateway_host() -> Option<String> {
    None
}

pub fn resolve_wsl_gateway_host(config_path: Option<&Path>) -> String {
    static CACHE: OnceLock<Mutex<RuntimeCache>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(RuntimeCache::default()));

    let cache_path = resolve_cache_path(config_path);
    if let Some(path) = cache_path.as_deref() {
        if let Some(host) = read_cached_host(path) {
            if let Ok(mut guard) = cache.lock() {
                guard.host = Some(host.clone());
            }
            return host;
        }
    }

    let now = now_unix_ms();
    if let Ok(guard) = cache.lock() {
        if let Some(host) = guard.host.as_deref() {
            return host.to_string();
        }
        if now.saturating_sub(guard.last_detect_attempt_unix_ms) < DETECT_RETRY_MS {
            return crate::constants::GATEWAY_WSL2_HOST.to_string();
        }
    }

    if let Ok(mut guard) = cache.lock() {
        guard.last_detect_attempt_unix_ms = now;
    }

    if let Some(host) = detect_wsl_gateway_host() {
        if let Some(path) = cache_path.as_deref() {
            write_cached_host(path, &host);
        }
        if let Ok(mut guard) = cache.lock() {
            guard.host = Some(host.clone());
        }
        return host;
    }

    crate::constants::GATEWAY_WSL2_HOST.to_string()
}

#[cfg(test)]
mod tests {
    use super::{normalize_ipv4, read_cached_host, write_cached_host};

    #[test]
    fn normalize_ipv4_accepts_valid_ipv4() {
        assert_eq!(
            normalize_ipv4("172.29.144.1"),
            Some("172.29.144.1".to_string())
        );
        assert_eq!(
            normalize_ipv4("172.29.144.1  \r\n"),
            Some("172.29.144.1".to_string())
        );
    }

    #[test]
    fn normalize_ipv4_rejects_invalid_input() {
        assert_eq!(normalize_ipv4(""), None);
        assert_eq!(normalize_ipv4("localhost"), None);
        assert_eq!(normalize_ipv4("999.1.1.1"), None);
    }

    #[test]
    fn cache_roundtrip_keeps_normalized_ipv4() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("wsl-gateway-host.txt");
        write_cached_host(&path, "172.18.80.1");
        assert_eq!(read_cached_host(&path), Some("172.18.80.1".to_string()));
    }
}
