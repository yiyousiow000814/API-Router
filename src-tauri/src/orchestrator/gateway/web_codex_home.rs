use serde::Serialize;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};

const MAX_FOLDER_LIST_ITEMS: usize = 1200;
const WSL_IDENTITY_CACHE_SECS: i64 = 600;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub(crate) enum WorkspaceTarget {
    Windows,
    Wsl2,
}

fn workspace_is_wsl2(value: &str) -> bool {
    value.trim().eq_ignore_ascii_case("wsl2")
}

fn workspace_is_windows(value: &str) -> bool {
    value.trim().eq_ignore_ascii_case("windows")
}

pub(super) fn parse_workspace_target(value: &str) -> Option<WorkspaceTarget> {
    if workspace_is_wsl2(value) {
        Some(WorkspaceTarget::Wsl2)
    } else if workspace_is_windows(value) {
        Some(WorkspaceTarget::Windows)
    } else {
        None
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FolderListItem {
    pub(super) name: String,
    pub(super) path: String,
}

fn sort_folder_items(items: &mut [FolderListItem]) {
    items.sort_by(|a, b| {
        let a_lc = a.name.to_ascii_lowercase();
        let b_lc = b.name.to_ascii_lowercase();
        a_lc.cmp(&b_lc).then_with(|| a.name.cmp(&b.name))
    });
}

pub(super) fn windows_root_folders() -> Vec<FolderListItem> {
    let mut items = Vec::new();
    if !cfg!(target_os = "windows") {
        return items;
    }
    for drive in b'A'..=b'Z' {
        let letter = char::from(drive);
        let path = format!("{letter}:\\");
        let p = Path::new(&path);
        if p.is_dir() {
            items.push(FolderListItem {
                name: path.clone(),
                path,
            });
        }
    }
    sort_folder_items(&mut items);
    items
}

pub(super) fn list_local_subdirectories(path: &Path) -> Result<Vec<FolderListItem>, String> {
    let mut items = Vec::new();
    let read = std::fs::read_dir(path).map_err(|e| e.to_string())?;
    for entry in read.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().trim().to_string();
        if name.is_empty() {
            continue;
        }
        let child_path = entry.path();
        items.push(FolderListItem {
            name,
            path: child_path.to_string_lossy().to_string(),
        });
        if items.len() >= MAX_FOLDER_LIST_ITEMS {
            break;
        }
    }
    sort_folder_items(&mut items);
    Ok(items)
}

#[derive(Clone)]
pub(crate) struct WslIdentityCache {
    pub(crate) distro: String,
    pub(crate) home: String,
    pub(crate) updated_at_unix_secs: i64,
}

fn current_unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|v| v.as_secs() as i64)
        .unwrap_or(0)
}

fn wsl_identity_cache() -> &'static std::sync::Mutex<Option<WslIdentityCache>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<Option<WslIdentityCache>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(None))
}

pub(crate) fn lock_wsl_identity_cache() -> std::sync::MutexGuard<'static, Option<WslIdentityCache>>
{
    match wsl_identity_cache().lock() {
        Ok(v) => v,
        Err(err) => err.into_inner(),
    }
}

pub(crate) fn normalize_wsl_linux_path(value: &str) -> Option<String> {
    let raw = value.trim();
    if raw.is_empty() {
        return None;
    }
    let mut normalized = raw.replace('\\', "/");
    if !normalized.starts_with('/') {
        return None;
    }
    while normalized.contains("//") {
        normalized = normalized.replace("//", "/");
    }
    if normalized.len() > 1 {
        normalized = normalized.trim_end_matches('/').to_string();
    }
    if normalized.is_empty() {
        Some("/".to_string())
    } else {
        Some(normalized)
    }
}

pub(super) fn linux_path_parent(path: &str) -> Option<String> {
    let normalized = normalize_wsl_linux_path(path)?;
    if normalized == "/" {
        return None;
    }
    let mut parts = normalized
        .trim_start_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.is_empty() {
        return Some("/".to_string());
    }
    parts.pop();
    if parts.is_empty() {
        Some("/".to_string())
    } else {
        Some(format!("/{}", parts.join("/")))
    }
}

pub(super) fn linux_path_join(base: &str, name: &str) -> String {
    let cleaned_name = name.trim().trim_matches('/');
    if cleaned_name.is_empty() {
        return normalize_wsl_linux_path(base).unwrap_or_else(|| "/".to_string());
    }
    let base_norm = normalize_wsl_linux_path(base).unwrap_or_else(|| "/".to_string());
    if base_norm == "/" {
        format!("/{cleaned_name}")
    } else {
        format!("{base_norm}/{cleaned_name}")
    }
}

pub(crate) fn linux_path_to_unc(path: &str, distro: &str) -> PathBuf {
    let normalized = normalize_wsl_linux_path(path).unwrap_or_else(|| "/".to_string());
    let rel = normalized.trim_start_matches('/');
    if rel.is_empty() {
        PathBuf::from(format!(r"\\wsl.localhost\{distro}\"))
    } else {
        PathBuf::from(format!(
            r"\\wsl.localhost\{distro}\{}",
            rel.replace('/', "\\")
        ))
    }
}

pub(crate) fn parse_wsl_unc_to_linux_path(value: &str) -> Option<String> {
    let mut text = value.trim().replace('/', "\\");
    if let Some(stripped) = text.strip_prefix(r"\\?\UNC\") {
        text = format!(r"\\{stripped}");
    }
    let stripped = text
        .strip_prefix(r"\\wsl.localhost\")
        .or_else(|| text.strip_prefix(r"\\wsl$\\"))?;
    let mut parts = stripped.split('\\').filter(|part| !part.is_empty());
    let _distro = parts.next()?;
    let rest = parts.collect::<Vec<_>>();
    if rest.is_empty() {
        Some("/".to_string())
    } else {
        Some(format!("/{}", rest.join("/")))
    }
}

fn detect_wsl_identity_uncached() -> Result<(String, String), String> {
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.arg("-e")
        .arg("bash")
        .arg("-lc")
        .arg(r#"printf '%s\n%s\n' "${WSL_DISTRO_NAME:-}" "${HOME:-/}""#);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }
    let output = cmd.output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            return Err("failed to detect WSL identity".to_string());
        }
        return Err(stderr);
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines = stdout.lines().map(str::trim);
    let distro = lines.next().unwrap_or_default().to_string();
    let home_raw = lines.next().unwrap_or("/").to_string();
    if distro.trim().is_empty() {
        return Err("failed to detect default WSL distro".to_string());
    }
    let home = normalize_wsl_linux_path(&home_raw).unwrap_or_else(|| "/".to_string());
    Ok((distro, home))
}

pub(crate) fn resolve_wsl_identity() -> Result<(String, String), String> {
    let now = current_unix_secs();
    if let Some(cached) = lock_wsl_identity_cache().clone() {
        if now.saturating_sub(cached.updated_at_unix_secs) < WSL_IDENTITY_CACHE_SECS {
            return Ok((cached.distro, cached.home));
        }
    }
    let (distro, home) = detect_wsl_identity_uncached()?;
    {
        let mut cache = lock_wsl_identity_cache();
        *cache = Some(WslIdentityCache {
            distro: distro.clone(),
            home: home.clone(),
            updated_at_unix_secs: now,
        });
    }
    Ok((distro, home))
}

pub(super) fn list_wsl_subdirectories(
    path: Option<&str>,
) -> Result<(String, Option<String>, Vec<FolderListItem>), String> {
    if !cfg!(target_os = "windows") {
        return Err("wsl2 workspace browsing is only available on Windows host".to_string());
    }
    let (distro, home) = resolve_wsl_identity()?;
    let current_path = path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(normalize_wsl_linux_path)
        .unwrap_or(home);
    let unc_path = linux_path_to_unc(&current_path, &distro);
    if !unc_path.is_dir() {
        return Err("path is not a directory".to_string());
    }
    let mut items = Vec::new();
    let read = std::fs::read_dir(&unc_path).map_err(|e| e.to_string())?;
    for entry in read.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().trim().to_string();
        if name.is_empty() {
            continue;
        }
        let child_linux_path = linux_path_join(&current_path, &name);
        items.push(FolderListItem {
            name,
            path: child_linux_path,
        });
        if items.len() >= MAX_FOLDER_LIST_ITEMS {
            break;
        }
    }
    sort_folder_items(&mut items);
    Ok((
        current_path.clone(),
        linux_path_parent(&current_path),
        items,
    ))
}

pub(super) fn default_windows_codex_dir() -> Option<PathBuf> {
    if !cfg!(target_os = "windows") {
        return None;
    }
    let user_profile = std::env::var("USERPROFILE").ok()?;
    let path = PathBuf::from(user_profile).join(".codex");
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

fn user_data_codex_home() -> Option<PathBuf> {
    std::env::var_os("API_ROUTER_USER_DATA_DIR")
        .map(PathBuf::from)
        .map(|path| path.join("codex-home"))
}

pub(super) fn web_codex_windows_session_home() -> Option<PathBuf> {
    default_windows_codex_dir()
}

pub(super) fn web_codex_wsl_session_home() -> Option<String> {
    let (_, home) = resolve_wsl_identity().ok()?;
    Some(linux_path_join(&home, ".codex"))
}

pub(super) fn web_codex_session_home_for_target(target: WorkspaceTarget) -> Option<String> {
    match target {
        WorkspaceTarget::Windows => {
            web_codex_windows_session_home().map(|path| path.to_string_lossy().to_string())
        }
        WorkspaceTarget::Wsl2 => web_codex_wsl_session_home(),
    }
}

pub(super) fn web_codex_rpc_home_override() -> Option<String> {
    let explicit = std::env::var("API_ROUTER_WEB_CODEX_CODEX_HOME")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if explicit.is_some() {
        return explicit;
    }
    let process_home = std::env::var("CODEX_HOME")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if process_home.is_some() {
        return process_home;
    }
    user_data_codex_home().map(|path| path.to_string_lossy().to_string())
}

pub(super) fn web_codex_rpc_home_override_for_target(
    target: Option<WorkspaceTarget>,
) -> Option<String> {
    match target {
        Some(WorkspaceTarget::Wsl2) => web_codex_wsl_linux_home_override(),
        _ => web_codex_rpc_home_override(),
    }
}

pub(super) fn web_codex_wsl_linux_home_override() -> Option<String> {
    let explicit = std::env::var("API_ROUTER_WEB_CODEX_WSL_CODEX_HOME")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if let Some(explicit) = explicit {
        if explicit.starts_with('/') {
            return normalize_wsl_linux_path(&explicit);
        }
        if let Some(converted) = parse_wsl_unc_to_linux_path(&explicit) {
            return Some(converted);
        }
        return None;
    }
    let (_, home) = resolve_wsl_identity().ok()?;
    Some(linux_path_join(&home, ".api-router/codex-web-home"))
}

fn backup_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("backup");
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    path.with_file_name(format!("{name}.web-codex-backup-{timestamp}"))
}

fn paths_refer_to_same_target(link: &Path, target: &Path) -> bool {
    match (std::fs::canonicalize(link), std::fs::canonicalize(target)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn prepare_link_location(link: &Path, target: &Path) -> Result<bool, String> {
    if !link.exists() {
        return Ok(true);
    }
    if paths_refer_to_same_target(link, target) {
        return Ok(false);
    }
    let backup = backup_path(link);
    std::fs::rename(link, &backup).map_err(|err| {
        format!(
            "failed to move existing Web Codex session path {} to {}: {err}",
            link.display(),
            backup.display()
        )
    })?;
    Ok(true)
}

#[cfg(target_os = "windows")]
fn create_dir_link(link: &Path, target: &Path) -> Result<(), String> {
    let mut cmd = std::process::Command::new("cmd.exe");
    cmd.arg("/C").arg("mklink").arg("/J").arg(link).arg(target);
    cmd.creation_flags(0x08000000);
    let output = cmd.output().map_err(|err| err.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

#[cfg(not(target_os = "windows"))]
fn create_dir_link(link: &Path, target: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(target, link).map_err(|err| err.to_string())
}

fn create_file_link(link: &Path, target: &Path) -> Result<(), String> {
    std::fs::hard_link(target, link)
        .or_else(|_| {
            #[cfg(target_os = "windows")]
            {
                std::os::windows::fs::symlink_file(target, link)
            }
            #[cfg(not(target_os = "windows"))]
            {
                std::os::unix::fs::symlink(target, link)
            }
        })
        .map_err(|err| err.to_string())
}

fn ensure_windows_overlay_session_links(
    overlay_home: &Path,
    session_home: &Path,
) -> Result<(), String> {
    if paths_refer_to_same_target(overlay_home, session_home) {
        return Ok(());
    }
    std::fs::create_dir_all(overlay_home).map_err(|err| err.to_string())?;
    std::fs::create_dir_all(session_home.join("sessions")).map_err(|err| err.to_string())?;
    let history = session_home.join("history.jsonl");
    if !history.exists() {
        std::fs::write(&history, "").map_err(|err| err.to_string())?;
    }

    let sessions_link = overlay_home.join("sessions");
    if prepare_link_location(&sessions_link, &session_home.join("sessions"))? {
        create_dir_link(&sessions_link, &session_home.join("sessions"))?;
    }

    let history_link = overlay_home.join("history.jsonl");
    if prepare_link_location(&history_link, &history)? {
        create_file_link(&history_link, &history)?;
    }
    Ok(())
}

fn copy_if_missing(src: &Path, dst: &Path) -> Result<(), String> {
    if dst.exists() || !src.exists() {
        return Ok(());
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    std::fs::copy(src, dst)
        .map(|_| ())
        .map_err(|err| err.to_string())
}

fn ensure_windows_provider_overlay_files(
    overlay_home: &Path,
    session_home: &Path,
) -> Result<(), String> {
    if paths_refer_to_same_target(overlay_home, session_home) {
        return Ok(());
    }
    std::fs::create_dir_all(overlay_home).map_err(|err| err.to_string())?;
    copy_if_missing(
        &session_home.join("config.toml"),
        &overlay_home.join("config.toml"),
    )?;
    copy_if_missing(
        &session_home.join("auth.json"),
        &overlay_home.join("auth.json"),
    )?;
    Ok(())
}

pub(crate) fn ensure_web_codex_runtime_session_links(
    codex_home: Option<&str>,
) -> Result<(), String> {
    let Some(home) = codex_home.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    if home.starts_with('/') {
        return Ok(());
    }
    let overlay_home = PathBuf::from(home);
    let Some(windows_overlay) = web_codex_rpc_home_override().map(PathBuf::from) else {
        return Ok(());
    };
    if !paths_refer_to_same_target(&overlay_home, &windows_overlay)
        && overlay_home != windows_overlay
    {
        return Ok(());
    }
    let Some(session_home) = web_codex_windows_session_home() else {
        return Ok(());
    };
    ensure_windows_overlay_session_links(&overlay_home, &session_home)
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(target_os = "windows")]
fn ensure_wsl_provider_overlay_ready(overlay_home: &str) -> Result<(), String> {
    let session_home = web_codex_wsl_session_home().ok_or_else(|| {
        "failed to resolve WSL Codex session home for Web Codex provider overlay".to_string()
    })?;
    if normalize_wsl_linux_path(overlay_home) == normalize_wsl_linux_path(&session_home) {
        return Ok(());
    }
    let script = format!(
        r#"
set -e
overlay={overlay}
official={official}
mkdir -p "$overlay"
if [ ! -e "$overlay/config.toml" ] && [ -e "$official/config.toml" ]; then cp "$official/config.toml" "$overlay/config.toml"; fi
if [ ! -e "$overlay/auth.json" ] && [ -e "$official/auth.json" ]; then cp "$official/auth.json" "$overlay/auth.json"; fi
mkdir -p "$official/sessions"
touch "$official/history.jsonl"
if [ -e "$overlay/sessions" ] || [ -L "$overlay/sessions" ]; then
  if [ "$(readlink -f "$overlay/sessions" 2>/dev/null || true)" != "$(readlink -f "$official/sessions" 2>/dev/null || true)" ]; then
    mv "$overlay/sessions" "$overlay/sessions.web-codex-backup-$(date +%s)"
  fi
fi
if [ ! -e "$overlay/sessions" ] && [ ! -L "$overlay/sessions" ]; then ln -s "$official/sessions" "$overlay/sessions"; fi
if [ -e "$overlay/history.jsonl" ] || [ -L "$overlay/history.jsonl" ]; then
  if [ "$(readlink -f "$overlay/history.jsonl" 2>/dev/null || true)" != "$(readlink -f "$official/history.jsonl" 2>/dev/null || true)" ]; then
    mv "$overlay/history.jsonl" "$overlay/history.jsonl.web-codex-backup-$(date +%s)"
  fi
fi
if [ ! -e "$overlay/history.jsonl" ] && [ ! -L "$overlay/history.jsonl" ]; then ln -s "$official/history.jsonl" "$overlay/history.jsonl"; fi
"#,
        overlay = shell_single_quote(overlay_home),
        official = shell_single_quote(&session_home),
    );
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.arg("-e").arg("bash").arg("-lc").arg(script);
    cmd.creation_flags(0x08000000);
    let output = cmd.output().map_err(|err| err.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

#[cfg(not(target_os = "windows"))]
fn ensure_wsl_provider_overlay_ready(_overlay_home: &str) -> Result<(), String> {
    Ok(())
}

pub(super) fn ensure_web_codex_provider_overlay_ready(
    target: WorkspaceTarget,
) -> Result<(), String> {
    match target {
        WorkspaceTarget::Windows => {
            let Some(overlay_home) = web_codex_rpc_home_override().map(PathBuf::from) else {
                return Ok(());
            };
            let Some(session_home) = web_codex_windows_session_home() else {
                return Ok(());
            };
            ensure_windows_provider_overlay_files(&overlay_home, &session_home)?;
            ensure_windows_overlay_session_links(&overlay_home, &session_home)
        }
        WorkspaceTarget::Wsl2 => {
            let Some(overlay_home) = web_codex_wsl_linux_home_override() else {
                return Ok(());
            };
            ensure_wsl_provider_overlay_ready(&overlay_home)
        }
    }
}

pub(crate) fn web_codex_session_home_for_runtime_home(codex_home: Option<&str>) -> Option<String> {
    let raw = codex_home?.trim();
    if raw.is_empty() {
        return None;
    }
    let runtime_home = PathBuf::from(raw);
    if let Some(windows_overlay) = web_codex_rpc_home_override().map(PathBuf::from) {
        if runtime_home == windows_overlay
            || paths_refer_to_same_target(&runtime_home, &windows_overlay)
        {
            return web_codex_session_home_for_target(WorkspaceTarget::Windows);
        }
    }
    let raw_linux = normalize_wsl_linux_path(raw).or_else(|| parse_wsl_unc_to_linux_path(raw));
    let overlay_linux = web_codex_wsl_linux_home_override();
    if raw_linux.is_some() && raw_linux == overlay_linux {
        return web_codex_session_home_for_target(WorkspaceTarget::Wsl2);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_web_codex_provider_overlay_ready, ensure_web_codex_runtime_session_links,
        linux_path_join, linux_path_parent, normalize_wsl_linux_path, parse_workspace_target,
        web_codex_rpc_home_override_for_target, web_codex_session_home_for_target, WorkspaceTarget,
    };

    #[test]
    fn parses_workspace_target() {
        assert_eq!(
            parse_workspace_target("windows"),
            Some(WorkspaceTarget::Windows)
        );
        assert_eq!(parse_workspace_target("wsl2"), Some(WorkspaceTarget::Wsl2));
        assert_eq!(parse_workspace_target("other"), None);
    }

    #[test]
    fn wsl_path_helpers_normalize_and_join() {
        assert_eq!(
            normalize_wsl_linux_path(r"\home\user\repo").as_deref(),
            Some("/home/user/repo")
        );
        assert_eq!(
            normalize_wsl_linux_path("/home/user/repo///").as_deref(),
            Some("/home/user/repo")
        );
        assert_eq!(
            linux_path_parent("/home/user/repo").as_deref(),
            Some("/home/user")
        );
        assert_eq!(linux_path_parent("/home").as_deref(), Some("/"));
        assert_eq!(linux_path_parent("/").as_deref(), None);
        assert_eq!(linux_path_join("/home/user", "repo"), "/home/user/repo");
        assert_eq!(linux_path_join("/", "tmp"), "/tmp");
    }

    #[test]
    fn rpc_home_override_uses_workspace_specific_home() {
        let _test_guard = crate::codex_app_server::lock_test_globals();
        unsafe {
            std::env::set_var("API_ROUTER_WEB_CODEX_CODEX_HOME", r"C:\tmp\win-codex");
            std::env::set_var("API_ROUTER_WEB_CODEX_WSL_CODEX_HOME", "/home/test/.codex");
        }
        assert_eq!(
            web_codex_rpc_home_override_for_target(Some(WorkspaceTarget::Windows)).as_deref(),
            Some(r"C:\tmp\win-codex")
        );
        assert_eq!(
            web_codex_rpc_home_override_for_target(Some(WorkspaceTarget::Wsl2)).as_deref(),
            Some("/home/test/.codex")
        );
        unsafe {
            std::env::remove_var("API_ROUTER_WEB_CODEX_CODEX_HOME");
            std::env::remove_var("API_ROUTER_WEB_CODEX_WSL_CODEX_HOME");
        }
    }

    #[test]
    fn web_codex_sessions_stay_on_default_windows_codex_home() {
        let _test_guard = crate::codex_app_server::lock_test_globals();
        let user_profile = tempfile::tempdir().expect("user profile");
        let app_data = tempfile::tempdir().expect("app data");
        unsafe {
            std::env::set_var("USERPROFILE", user_profile.path());
            std::env::set_var("API_ROUTER_USER_DATA_DIR", app_data.path());
            std::env::remove_var("API_ROUTER_WEB_CODEX_CODEX_HOME");
            std::env::remove_var("CODEX_HOME");
        }
        std::fs::create_dir_all(user_profile.path().join(".codex")).expect("codex home");

        assert_eq!(
            web_codex_rpc_home_override_for_target(Some(WorkspaceTarget::Windows)).as_deref(),
            Some(
                app_data
                    .path()
                    .join("codex-home")
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert_eq!(
            web_codex_session_home_for_target(WorkspaceTarget::Windows).as_deref(),
            Some(
                user_profile
                    .path()
                    .join(".codex")
                    .to_string_lossy()
                    .as_ref()
            )
        );

        unsafe {
            std::env::remove_var("USERPROFILE");
            std::env::remove_var("API_ROUTER_USER_DATA_DIR");
        }
    }

    #[test]
    fn windows_overlay_links_sessions_to_default_codex_home() {
        let _test_guard = crate::codex_app_server::lock_test_globals();
        let user_profile = tempfile::tempdir().expect("user profile");
        let app_data = tempfile::tempdir().expect("app data");
        let official_home = user_profile.path().join(".codex");
        let overlay_home = app_data.path().join("codex-home");
        std::fs::create_dir_all(official_home.join("sessions")).expect("official sessions");
        std::fs::create_dir_all(overlay_home.join("sessions").join("imported"))
            .expect("old overlay sessions");
        std::fs::write(
            overlay_home
                .join("sessions")
                .join("imported")
                .join("thread.jsonl"),
            "{}",
        )
        .expect("old imported copy");
        unsafe {
            std::env::set_var("USERPROFILE", user_profile.path());
            std::env::set_var("API_ROUTER_USER_DATA_DIR", app_data.path());
            std::env::remove_var("API_ROUTER_WEB_CODEX_CODEX_HOME");
            std::env::remove_var("CODEX_HOME");
        }

        ensure_web_codex_runtime_session_links(Some(overlay_home.to_string_lossy().as_ref()))
            .expect("link sessions");

        assert!(std::fs::canonicalize(overlay_home.join("sessions")).is_ok());
        assert_eq!(
            std::fs::canonicalize(overlay_home.join("sessions")).expect("linked sessions"),
            std::fs::canonicalize(official_home.join("sessions")).expect("official sessions")
        );
        assert!(
            overlay_home
                .read_dir()
                .expect("read overlay")
                .flatten()
                .any(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .contains("sessions.web-codex-backup-")),
            "existing overlay sessions should be preserved outside the active CODEX_HOME"
        );

        unsafe {
            std::env::remove_var("USERPROFILE");
            std::env::remove_var("API_ROUTER_USER_DATA_DIR");
        }
    }

    #[test]
    fn windows_provider_overlay_initializes_provider_files_without_owning_sessions() {
        let _test_guard = crate::codex_app_server::lock_test_globals();
        let user_profile = tempfile::tempdir().expect("user profile");
        let app_data = tempfile::tempdir().expect("app data");
        let official_home = user_profile.path().join(".codex");
        let overlay_home = app_data.path().join("codex-home");
        std::fs::create_dir_all(&official_home).expect("official home");
        std::fs::write(
            official_home.join("config.toml"),
            "model_provider = \"openai\"\n",
        )
        .expect("official config");
        std::fs::write(official_home.join("auth.json"), "{}\n").expect("official auth");
        unsafe {
            std::env::set_var("USERPROFILE", user_profile.path());
            std::env::set_var("API_ROUTER_USER_DATA_DIR", app_data.path());
            std::env::remove_var("API_ROUTER_WEB_CODEX_CODEX_HOME");
            std::env::remove_var("CODEX_HOME");
        }

        ensure_web_codex_provider_overlay_ready(WorkspaceTarget::Windows)
            .expect("provider overlay ready");

        assert!(overlay_home.join("config.toml").exists());
        assert!(overlay_home.join("auth.json").exists());
        assert_eq!(
            std::fs::canonicalize(overlay_home.join("sessions")).expect("linked sessions"),
            std::fs::canonicalize(official_home.join("sessions")).expect("official sessions")
        );

        unsafe {
            std::env::remove_var("USERPROFILE");
            std::env::remove_var("API_ROUTER_USER_DATA_DIR");
        }
    }
}
