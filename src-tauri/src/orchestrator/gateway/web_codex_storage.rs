use super::*;
use serde::{Deserialize, Serialize};

pub(super) fn codex_data_dir() -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("API_ROUTER_USER_DATA_DIR") {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    let codex_home =
        std::env::var("CODEX_HOME").map_err(|_| "CODEX_HOME is not set".to_string())?;
    let base = PathBuf::from(codex_home);
    base.parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "failed to resolve user-data directory".to_string())
}

pub(super) fn codex_hosts_file_path() -> Result<PathBuf, String> {
    Ok(codex_data_dir()?.join("web-codex.hosts.json"))
}

pub(super) fn codex_attachments_dir() -> Result<PathBuf, String> {
    Ok(codex_data_dir()?.join("web-codex-attachments"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct WebCodexHost {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) base_url: String,
    #[serde(default)]
    pub(super) token_hint: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub(super) struct WebCodexHostsFile {
    #[serde(default)]
    pub(super) items: Vec<WebCodexHost>,
}

pub(super) fn read_hosts_file() -> Result<WebCodexHostsFile, String> {
    let path = codex_hosts_file_path()?;
    if !path.exists() {
        return Ok(WebCodexHostsFile::default());
    }
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

pub(super) fn write_hosts_file(data: &WebCodexHostsFile) -> Result<(), String> {
    let path = codex_hosts_file_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

pub(super) fn sanitize_name(value: &str, fallback: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn sanitize_name_normalizes_unsafe_characters() {
        assert_eq!(
            sanitize_name("hello world?.png", "fallback"),
            "hello_world_.png"
        );
        assert_eq!(sanitize_name("////", "fallback"), "fallback");
    }

    #[test]
    fn hosts_file_roundtrip_uses_overridden_user_data_dir() {
        let _guard = env_lock().lock().unwrap();
        let previous = std::env::var("API_ROUTER_USER_DATA_DIR").ok();
        let unique = format!(
            "api-router-web-codex-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let base_dir = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&base_dir).unwrap();
        std::env::set_var("API_ROUTER_USER_DATA_DIR", &base_dir);

        let file = WebCodexHostsFile {
            items: vec![WebCodexHost {
                id: "h_1".to_string(),
                name: "Local".to_string(),
                base_url: "http://127.0.0.1:4000".to_string(),
                token_hint: "hint".to_string(),
            }],
        };
        write_hosts_file(&file).unwrap();
        let loaded = read_hosts_file().unwrap();
        assert_eq!(loaded.items.len(), 1);
        assert_eq!(loaded.items[0].id, "h_1");

        std::fs::remove_dir_all(&base_dir).unwrap();
        if let Some(prev) = previous {
            std::env::set_var("API_ROUTER_USER_DATA_DIR", prev);
        } else {
            std::env::remove_var("API_ROUTER_USER_DATA_DIR");
        }
    }
}
