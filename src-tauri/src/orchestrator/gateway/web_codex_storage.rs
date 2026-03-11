use super::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;

const CODEX_LIVE_TRACE_MAX_BYTES: u64 = 8 * 1024 * 1024;

pub(crate) fn codex_data_dir() -> Result<PathBuf, String> {
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

pub(crate) fn codex_live_trace_file_path() -> Result<PathBuf, String> {
    Ok(codex_data_dir()?.join("logs").join("codex-web-live.ndjson"))
}

pub(crate) fn codex_unsupported_rpc_cache_file_path() -> Result<PathBuf, String> {
    Ok(codex_data_dir()?.join("web-codex.unsupported-rpc.json"))
}

fn rotate_live_trace_file_if_needed(path: &Path) -> Result<(), String> {
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err.to_string()),
    };
    if meta.len() < CODEX_LIVE_TRACE_MAX_BYTES {
        return Ok(());
    }
    let rotated = path.with_extension("ndjson.1");
    let _ = std::fs::remove_file(&rotated);
    std::fs::rename(path, rotated).map_err(|err| err.to_string())
}

pub(crate) fn append_codex_live_trace_entry(entry: &Value) -> Result<(), String> {
    let path = codex_live_trace_file_path()?;
    append_codex_live_trace_entry_to_path(&path, entry)
}

fn append_codex_live_trace_entry_to_path(path: &Path, entry: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    rotate_live_trace_file_if_needed(path)?;
    let line = serde_json::to_string(entry).map_err(|err| err.to_string())?;
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| err.to_string())?;
    writeln!(file, "{line}").map_err(|err| err.to_string())
}

pub(crate) fn read_unsupported_rpc_cache() -> Result<HashSet<String>, String> {
    let path = codex_unsupported_rpc_cache_file_path()?;
    read_unsupported_rpc_cache_from_path(&path)
}

fn read_unsupported_rpc_cache_from_path(path: &Path) -> Result<HashSet<String>, String> {
    if !path.exists() {
        return Ok(HashSet::new());
    }
    let text = std::fs::read_to_string(path).map_err(|err| err.to_string())?;
    let items = serde_json::from_str::<Vec<String>>(&text).map_err(|err| err.to_string())?;
    Ok(items.into_iter().collect())
}

pub(crate) fn write_unsupported_rpc_cache(cache: &HashSet<String>) -> Result<(), String> {
    let path = codex_unsupported_rpc_cache_file_path()?;
    write_unsupported_rpc_cache_to_path(&path, cache)
}

fn write_unsupported_rpc_cache_to_path(path: &Path, cache: &HashSet<String>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let mut items = cache.iter().cloned().collect::<Vec<_>>();
    items.sort();
    let text = serde_json::to_string_pretty(&items).map_err(|err| err.to_string())?;
    std::fs::write(path, text).map_err(|err| err.to_string())
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
    read_hosts_file_from_path(&path)
}

fn read_hosts_file_from_path(path: &Path) -> Result<WebCodexHostsFile, String> {
    if !path.exists() {
        return Ok(WebCodexHostsFile::default());
    }
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

pub(super) fn write_hosts_file(data: &WebCodexHostsFile) -> Result<(), String> {
    let path = codex_hosts_file_path()?;
    write_hosts_file_to_path(&path, data)
}

fn write_hosts_file_to_path(path: &Path, data: &WebCodexHostsFile) -> Result<(), String> {
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
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("web-codex.hosts.json");

        let file = WebCodexHostsFile {
            items: vec![WebCodexHost {
                id: "h_1".to_string(),
                name: "Local".to_string(),
                base_url: "http://127.0.0.1:4000".to_string(),
                token_hint: "hint".to_string(),
            }],
        };
        write_hosts_file_to_path(&path, &file).unwrap();
        let loaded = read_hosts_file_from_path(&path).unwrap();
        assert_eq!(loaded.items.len(), 1);
        assert_eq!(loaded.items[0].id, "h_1");
    }

    #[test]
    fn live_trace_append_writes_ndjson_line() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("logs").join("codex-web-live.ndjson");

        let entry = serde_json::json!({
            "source": "test",
            "kind": "trace.test",
            "at": 1,
        });
        append_codex_live_trace_entry_to_path(&path, &entry).unwrap();
        let text = std::fs::read_to_string(path).unwrap();
        assert!(text.contains("\"kind\":\"trace.test\""));
    }

    #[test]
    fn unsupported_rpc_cache_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("web-codex.unsupported-rpc.json");

        let mut cache = HashSet::new();
        cache.insert("::request_user_input/list".to_string());
        write_unsupported_rpc_cache_to_path(&path, &cache).unwrap();
        let loaded = read_unsupported_rpc_cache_from_path(&path).unwrap();
        assert!(loaded.contains("::request_user_input/list"));
    }
}
