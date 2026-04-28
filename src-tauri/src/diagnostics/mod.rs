use chrono::Utc;
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};

pub(crate) const DIAGNOSTICS_DIR_NAME: &str = "diagnostics";

#[cfg(test)]
thread_local! {
    static TEST_USER_DATA_DIR_OVERRIDE: std::cell::RefCell<Option<PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn set_test_user_data_dir_override(value: Option<&Path>) -> Option<PathBuf> {
    TEST_USER_DATA_DIR_OVERRIDE.with(|cell| {
        let previous = cell.borrow().clone();
        *cell.borrow_mut() = value.map(|path| path.to_path_buf());
        previous
    })
}

#[cfg(test)]
pub(crate) fn test_user_data_dir_override() -> Option<PathBuf> {
    TEST_USER_DATA_DIR_OVERRIDE.with(|cell| cell.borrow().clone())
}

pub(crate) fn app_diagnostics_dir(config_path: &Path, data_dir: &Path) -> PathBuf {
    config_path
        .parent()
        .map(|parent| parent.join(DIAGNOSTICS_DIR_NAME))
        .unwrap_or_else(|| data_dir.join(DIAGNOSTICS_DIR_NAME))
}

pub(crate) fn current_user_data_dir() -> Option<PathBuf> {
    #[cfg(test)]
    if let Some(path) = test_user_data_dir_override() {
        return Some(path);
    }

    let user_data_dir = std::env::var("API_ROUTER_USER_DATA_DIR").ok()?;
    let trimmed = user_data_dir.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

pub(crate) fn current_diagnostics_dir() -> Option<PathBuf> {
    Some(current_user_data_dir()?.join(DIAGNOSTICS_DIR_NAME))
}

pub(crate) fn diagnostics_file_path(file_name: &str) -> Option<PathBuf> {
    Some(current_diagnostics_dir()?.join(file_name))
}

pub(crate) fn ensure_parent_dir(path: &Path) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    Ok(())
}

pub(crate) mod codex_web_pipeline;
pub(crate) mod codex_web_transport;

/// Prefixes used to identify watchdog dump files written by `UiWatchdog::write_dump`.
/// The `write_dump` function creates filenames as `ui-freeze-{timestamp}-{trigger}.json`,
/// so only `"ui-freeze-"` matches the actual files. The additional prefixes are included
/// for compatibility with any files written by other code paths.
pub(crate) const WATCHDOG_DUMP_PREFIXES: &[&str] = &[
    "ui-freeze-",
    "slow-refresh-",
    "long-task-",
    "frame-stall-",
    "frontend-error-",
    "heartbeat-stall-",
    "invoke-error-",
    "slow-invoke-",
];

pub(crate) fn write_pretty_json(path: &Path, payload: &Value) -> std::io::Result<()> {
    ensure_parent_dir(path)?;
    std::fs::write(path, serde_json::to_vec_pretty(payload).unwrap_or_default())
}

pub(crate) fn append_timestamped_log_line(path: &Path, message: &str) -> std::io::Result<()> {
    ensure_parent_dir(path)?;
    let timestamp = Utc::now().format("%d-%m-%Y %H:%M:%S%.3f UTC");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(file, "[{timestamp}] {message}")
}

pub(crate) fn append_timestamped_log_line_capped(
    path: &Path,
    message: &str,
    max_bytes: usize,
) -> std::io::Result<()> {
    ensure_parent_dir(path)?;
    let timestamp = Utc::now().format("%d-%m-%Y %H:%M:%S%.3f UTC");
    let line = format!("[{timestamp}] {message}\n");
    let mut bytes = std::fs::read(path).unwrap_or_default();
    bytes.extend_from_slice(line.as_bytes());
    let bytes = trim_log_bytes_to_recent_lines(bytes, max_bytes);
    std::fs::write(path, bytes)
}

fn trim_log_bytes_to_recent_lines(mut bytes: Vec<u8>, max_bytes: usize) -> Vec<u8> {
    if bytes.len() <= max_bytes {
        return bytes;
    }
    let start = bytes.len().saturating_sub(max_bytes);
    bytes = bytes.split_off(start);
    if let Some(pos) = bytes.iter().position(|byte| *byte == b'\n') {
        bytes.split_off(pos + 1)
    } else {
        bytes
    }
}

#[cfg(test)]
mod tests {
    use super::trim_log_bytes_to_recent_lines;

    #[test]
    fn trim_capped_log_keeps_recent_complete_lines() {
        let bytes = b"line-000\nline-001\nline-002\nline-003\n".to_vec();
        let trimmed = trim_log_bytes_to_recent_lines(bytes, 18);
        let text = String::from_utf8(trimmed).expect("trimmed text");
        assert_eq!(text, "line-003\n");
    }
}
