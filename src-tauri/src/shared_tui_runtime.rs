use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};

const SHARED_TUI_RUNTIME_DIR_NAME: &str = ".api-router";
const SHARED_TUI_DAEMON_EXE_NAME: &str = "API Router-shared-tui-daemon.exe";
const SHARED_TUI_DAEMON_STATE_FILE_NAME: &str = "shared-tui-daemon.json";
const SHARED_TUI_DAEMON_RUNTIME_MANIFEST_FILE_NAME: &str = "shared-tui-daemon.runtime.json";
const SHARED_TUI_DAEMON_RUNTIME_MANIFEST_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SharedTuiRuntimeIdentity {
    pub(crate) app_version: String,
    pub(crate) build_git_sha: String,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct SharedTuiRuntimeCleanupResult {
    pub(crate) removed_daemon_exe: bool,
    pub(crate) removed_state_file: bool,
    pub(crate) removed_unsupported_rpc_cache: bool,
    pub(crate) wrote_runtime_manifest: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct SharedTuiRuntimeManifest {
    version: u32,
    app_version: String,
    build_git_sha: String,
}

fn shared_tui_runtime_dir(user_data_dir: &Path) -> PathBuf {
    user_data_dir.join(SHARED_TUI_RUNTIME_DIR_NAME)
}

fn shared_tui_daemon_exe_path(user_data_dir: &Path) -> PathBuf {
    shared_tui_runtime_dir(user_data_dir).join(SHARED_TUI_DAEMON_EXE_NAME)
}

fn shared_tui_state_path(user_data_dir: &Path) -> PathBuf {
    shared_tui_runtime_dir(user_data_dir).join(SHARED_TUI_DAEMON_STATE_FILE_NAME)
}

fn shared_tui_runtime_manifest_path(user_data_dir: &Path) -> PathBuf {
    shared_tui_runtime_dir(user_data_dir).join(SHARED_TUI_DAEMON_RUNTIME_MANIFEST_FILE_NAME)
}

fn unsupported_rpc_cache_path(user_data_dir: &Path) -> PathBuf {
    user_data_dir.join("web-codex.unsupported-rpc.json")
}

fn identity_build_sha(identity: &SharedTuiRuntimeIdentity) -> Option<&str> {
    let trimmed = identity.build_git_sha.trim();
    (!trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("unknown")).then_some(trimmed)
}

fn daemon_manifest(identity: &SharedTuiRuntimeIdentity) -> SharedTuiRuntimeManifest {
    SharedTuiRuntimeManifest {
        version: SHARED_TUI_DAEMON_RUNTIME_MANIFEST_VERSION,
        app_version: identity.app_version.trim().to_string(),
        build_git_sha: identity.build_git_sha.trim().to_string(),
    }
}

fn read_runtime_manifest(path: &Path) -> Result<Option<SharedTuiRuntimeManifest>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(path).map_err(|err| err.to_string())?;
    let manifest =
        serde_json::from_str::<SharedTuiRuntimeManifest>(&text).map_err(|err| err.to_string())?;
    if manifest.version != SHARED_TUI_DAEMON_RUNTIME_MANIFEST_VERSION {
        return Ok(None);
    }
    Ok(Some(manifest))
}

fn runtime_manifest_matches_identity(
    manifest: &SharedTuiRuntimeManifest,
    identity: &SharedTuiRuntimeIdentity,
) -> bool {
    manifest == &daemon_manifest(identity)
}

fn write_runtime_manifest(
    path: &Path,
    identity: &SharedTuiRuntimeIdentity,
) -> Result<bool, String> {
    let manifest = daemon_manifest(identity);
    if let Some(existing) = read_runtime_manifest(path)? {
        if existing == manifest {
            return Ok(false);
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(&manifest).map_err(|err| err.to_string())?;
    std::fs::write(path, bytes).map_err(|err| err.to_string())?;
    Ok(true)
}

fn file_contains_ascii_marker(path: &Path, marker: &str) -> Result<bool, String> {
    let bytes = std::fs::read(path).map_err(|err| err.to_string())?;
    let marker = marker.as_bytes();
    if marker.is_empty() {
        return Ok(false);
    }
    Ok(bytes.windows(marker.len()).any(|window| window == marker))
}

fn daemon_binary_matches_identity(
    daemon_exe_path: &Path,
    identity: &SharedTuiRuntimeIdentity,
) -> Result<bool, String> {
    if let Some(build_git_sha) = identity_build_sha(identity) {
        return file_contains_ascii_marker(daemon_exe_path, build_git_sha);
    }
    let app_version = identity.app_version.trim();
    if app_version.is_empty() {
        return Ok(false);
    }
    file_contains_ascii_marker(daemon_exe_path, app_version)
}

fn maybe_terminate_stale_daemon(state_path: &Path) {
    #[cfg(target_os = "windows")]
    {
        let pid = std::fs::read_to_string(state_path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| value.get("pid").and_then(Value::as_u64))
            .and_then(|pid| u32::try_from(pid).ok())
            .filter(|pid| *pid > 0);
        let Some(pid) = pid else {
            return;
        };
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .creation_flags(0x08000000)
            .output();
    }
}

fn remove_file_if_exists(path: &Path) -> Result<bool, String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err.to_string()),
    }
}

pub(crate) fn reconcile_shared_tui_runtime_in_dir(
    user_data_dir: &Path,
    identity: &SharedTuiRuntimeIdentity,
) -> Result<SharedTuiRuntimeCleanupResult, String> {
    let daemon_exe_path = shared_tui_daemon_exe_path(user_data_dir);
    let state_path = shared_tui_state_path(user_data_dir);
    let manifest_path = shared_tui_runtime_manifest_path(user_data_dir);
    let unsupported_rpc_cache_path = unsupported_rpc_cache_path(user_data_dir);
    let mut result = SharedTuiRuntimeCleanupResult::default();

    if !daemon_exe_path.exists() {
        let _ = remove_file_if_exists(&manifest_path)?;
        return Ok(result);
    }

    let manifest = read_runtime_manifest(&manifest_path)?;
    let stale_runtime = if let Some(manifest) = manifest.as_ref() {
        !runtime_manifest_matches_identity(manifest, identity)
    } else {
        !daemon_binary_matches_identity(&daemon_exe_path, identity)?
    };

    if stale_runtime {
        maybe_terminate_stale_daemon(&state_path);
        result.removed_daemon_exe = remove_file_if_exists(&daemon_exe_path)?;
        result.removed_state_file = remove_file_if_exists(&state_path)?;
        let _ = remove_file_if_exists(&manifest_path)?;
        result.removed_unsupported_rpc_cache = remove_file_if_exists(&unsupported_rpc_cache_path)?;
        return Ok(result);
    }

    result.wrote_runtime_manifest = write_runtime_manifest(&manifest_path, identity)?;
    Ok(result)
}

pub(crate) fn reconcile_shared_tui_runtime(
    user_data_dir: &Path,
) -> Result<SharedTuiRuntimeCleanupResult, String> {
    let current_build = crate::lan_sync::current_build_identity();
    let identity = SharedTuiRuntimeIdentity {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        build_git_sha: current_build.build_git_sha,
    };
    reconcile_shared_tui_runtime_in_dir(user_data_dir, &identity)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_daemon_binary_removes_runtime_and_cache() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let user_data_dir = tmp.path();
        let daemon_path = shared_tui_daemon_exe_path(user_data_dir);
        let state_path = shared_tui_state_path(user_data_dir);
        let cache_path = unsupported_rpc_cache_path(user_data_dir);
        std::fs::create_dir_all(daemon_path.parent().expect("daemon parent")).expect("mkdir");
        std::fs::write(&daemon_path, "old daemon without current build sha").expect("daemon");
        std::fs::write(&state_path, "{\"pid\":1668}").expect("state");
        std::fs::write(&cache_path, "{\"schema_version\":1,\"items\":[]}").expect("cache");

        let result = reconcile_shared_tui_runtime_in_dir(
            user_data_dir,
            &SharedTuiRuntimeIdentity {
                app_version: "0.4.0".to_string(),
                build_git_sha: "254b59607d4417e9dffbc307138ae5c86280fe4c".to_string(),
            },
        )
        .expect("reconcile");

        assert!(result.removed_daemon_exe);
        assert!(result.removed_state_file);
        assert!(result.removed_unsupported_rpc_cache);
        assert!(!daemon_path.exists(), "stale daemon should be removed");
        assert!(!state_path.exists(), "stale daemon state should be removed");
        assert!(
            !cache_path.exists(),
            "unsupported rpc cache should be removed"
        );
    }

    #[test]
    fn current_daemon_binary_is_kept_and_manifested() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let user_data_dir = tmp.path();
        let daemon_path = shared_tui_daemon_exe_path(user_data_dir);
        let manifest_path = shared_tui_runtime_manifest_path(user_data_dir);
        std::fs::create_dir_all(daemon_path.parent().expect("daemon parent")).expect("mkdir");
        std::fs::write(
            &daemon_path,
            "daemon payload 254b59607d4417e9dffbc307138ae5c86280fe4c current",
        )
        .expect("daemon");

        let result = reconcile_shared_tui_runtime_in_dir(
            user_data_dir,
            &SharedTuiRuntimeIdentity {
                app_version: "0.4.0".to_string(),
                build_git_sha: "254b59607d4417e9dffbc307138ae5c86280fe4c".to_string(),
            },
        )
        .expect("reconcile");

        assert!(!result.removed_daemon_exe);
        assert!(daemon_path.exists(), "current daemon should stay in place");
        assert!(result.wrote_runtime_manifest);
        let manifest = read_runtime_manifest(&manifest_path)
            .expect("manifest read")
            .expect("manifest exists");
        assert_eq!(
            manifest,
            SharedTuiRuntimeManifest {
                version: SHARED_TUI_DAEMON_RUNTIME_MANIFEST_VERSION,
                app_version: "0.4.0".to_string(),
                build_git_sha: "254b59607d4417e9dffbc307138ae5c86280fe4c".to_string(),
            }
        );
    }

    #[test]
    fn stale_manifest_removes_matching_binary_and_cache() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let user_data_dir = tmp.path();
        let daemon_path = shared_tui_daemon_exe_path(user_data_dir);
        let state_path = shared_tui_state_path(user_data_dir);
        let manifest_path = shared_tui_runtime_manifest_path(user_data_dir);
        let cache_path = unsupported_rpc_cache_path(user_data_dir);
        std::fs::create_dir_all(daemon_path.parent().expect("daemon parent")).expect("mkdir");
        std::fs::write(
            &daemon_path,
            "daemon payload 254b59607d4417e9dffbc307138ae5c86280fe4c current",
        )
        .expect("daemon");
        std::fs::write(&state_path, "{\"pid\":1776}").expect("state");
        std::fs::write(&cache_path, "{\"schema_version\":1,\"items\":[]}").expect("cache");
        std::fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&SharedTuiRuntimeManifest {
                version: SHARED_TUI_DAEMON_RUNTIME_MANIFEST_VERSION,
                app_version: "0.4.0".to_string(),
                build_git_sha: "old-build".to_string(),
            })
            .expect("manifest"),
        )
        .expect("manifest write");

        let result = reconcile_shared_tui_runtime_in_dir(
            user_data_dir,
            &SharedTuiRuntimeIdentity {
                app_version: "0.4.0".to_string(),
                build_git_sha: "254b59607d4417e9dffbc307138ae5c86280fe4c".to_string(),
            },
        )
        .expect("reconcile");

        assert!(result.removed_daemon_exe);
        assert!(result.removed_state_file);
        assert!(result.removed_unsupported_rpc_cache);
        assert!(!daemon_path.exists(), "stale daemon should be removed");
        assert!(!state_path.exists(), "stale state should be removed");
        assert!(!cache_path.exists(), "cache should be cleared");
        assert!(!manifest_path.exists(), "stale manifest should be removed");
    }
}
