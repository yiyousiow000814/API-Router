use super::*;
use crate::orchestrator::gateway::web_codex_rollout_path::rollout_path_is_already_in_codex_home;
use rusqlite::{params, OptionalExtension};
use std::path::{Path, PathBuf};

pub(super) fn codex_home_dir_for_override(codex_home: Option<&str>) -> Result<PathBuf, String> {
    let Some(home) = codex_home.map(str::trim).filter(|value| !value.is_empty()) else {
        return crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override()
            .map(PathBuf::from)
            .ok_or_else(|| "CODEX_HOME is not set".to_string())
            .or_else(|_| {
                let home =
                    std::env::var("CODEX_HOME").map_err(|_| "CODEX_HOME is not set".to_string())?;
                Ok(PathBuf::from(home))
            });
    };
    #[cfg(target_os = "windows")]
    if home.starts_with('/') {
        let (distro, _) = crate::orchestrator::gateway::web_codex_home::resolve_wsl_identity()?;
        return Ok(crate::orchestrator::gateway::web_codex_home::linux_path_to_unc(home, &distro));
    }
    Ok(PathBuf::from(home))
}

fn default_windows_codex_dir() -> Option<PathBuf> {
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

fn find_rollout_file_by_thread_id(dir: &Path, thread_id: &str) -> Option<PathBuf> {
    let read = std::fs::read_dir(dir).ok()?;
    for entry in read.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_rollout_file_by_thread_id(&path, thread_id) {
                return Some(found);
            }
            continue;
        }
        let file_name = path
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or_default();
        let is_jsonl = path
            .extension()
            .and_then(|v| v.to_str())
            .map(|v| v.eq_ignore_ascii_case("jsonl"))
            .unwrap_or(false);
        if is_jsonl && file_name.contains(thread_id) {
            return Some(path);
        }
    }
    None
}

pub(super) fn import_windows_rollout_into_codex_home(
    codex_home: Option<&str>,
    thread_id: &str,
) -> Result<bool, String> {
    let Some(src_root) = default_windows_codex_dir().map(|p| p.join("sessions")) else {
        return Ok(false);
    };
    if !src_root.exists() {
        return Ok(false);
    }
    let Some(src_file) = find_rollout_file_by_thread_id(&src_root, thread_id) else {
        return Ok(false);
    };
    import_rollout_file_into_codex_home(codex_home, thread_id, src_file.as_path())
}

fn is_safe_thread_id(thread_id: &str) -> bool {
    !thread_id.trim().is_empty() && thread_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn find_wsl_rollout_file_by_thread_id(thread_id: &str) -> Option<PathBuf> {
    if !cfg!(target_os = "windows") || !is_safe_thread_id(thread_id) {
        return None;
    }
    let script = format!(
        "python3 - <<'PY'\nfrom pathlib import Path\nimport os\nneedle = '{thread_id}'\nroot = Path.home() / '.codex' / 'sessions'\ndistro = (os.environ.get('WSL_DISTRO_NAME') or '').strip()\nif not root.exists():\n    raise SystemExit(0)\nfor p in root.rglob('*.jsonl'):\n    if needle in p.name:\n        text = str(p)\n        if distro and text.startswith('/'):\n            print('\\\\\\\\wsl.localhost\\\\' + distro + text.replace('/', '\\\\'))\n        else:\n            print(text)\n        break\nPY"
    );
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.arg("-e").arg("bash").arg("-lc").arg(script);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let windows_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if windows_path.is_empty() {
        None
    } else {
        Some(PathBuf::from(windows_path))
    }
}

pub(super) fn import_wsl_rollout_into_codex_home(
    codex_home: Option<&str>,
    thread_id: &str,
) -> Result<bool, String> {
    let Some(src_file) = find_wsl_rollout_file_by_thread_id(thread_id) else {
        return Ok(false);
    };
    import_rollout_file_into_codex_home(codex_home, thread_id, src_file.as_path())
}

pub(super) fn import_rollout_file_into_codex_home(
    codex_home: Option<&str>,
    thread_id: &str,
    src_file: &Path,
) -> Result<bool, String> {
    if !src_file.exists() || !src_file.is_file() {
        return Ok(false);
    }
    let file_name = src_file
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or_default();
    let is_jsonl = src_file
        .extension()
        .and_then(|v| v.to_str())
        .map(|v| v.eq_ignore_ascii_case("jsonl"))
        .unwrap_or(false);
    if !is_jsonl || !file_name.contains(thread_id) {
        return Ok(false);
    }
    crate::orchestrator::gateway::web_codex_home::ensure_web_codex_runtime_session_links(
        codex_home,
    )?;
    let dst_dir = codex_home_dir_for_override(codex_home)?
        .join("sessions")
        .join("imported");
    std::fs::create_dir_all(&dst_dir).map_err(|e| e.to_string())?;
    let dst_file = dst_dir.join(format!("{thread_id}.jsonl"));
    if dst_file.exists() {
        let src_meta = std::fs::metadata(src_file).ok();
        let dst_meta = std::fs::metadata(&dst_file).ok();
        if let (Some(src_meta), Some(dst_meta)) = (src_meta, dst_meta) {
            let same_len = src_meta.len() == dst_meta.len();
            let same_content = if same_len {
                std::fs::read(src_file).ok() == std::fs::read(&dst_file).ok()
            } else {
                false
            };
            let up_to_date = match (src_meta.modified().ok(), dst_meta.modified().ok()) {
                (Some(src_modified), Some(dst_modified)) => dst_modified >= src_modified,
                _ => same_len,
            };
            if same_content && up_to_date {
                sanitize_official_resume_rollout(
                    codex_home,
                    Some(dst_file.to_string_lossy().as_ref()),
                )?;
                return Ok(true);
            }
        }
    }
    std::fs::copy(src_file, &dst_file).map_err(|e| e.to_string())?;
    sanitize_official_resume_rollout(codex_home, Some(dst_file.to_string_lossy().as_ref()))?;
    Ok(true)
}

fn config_text_uses_model_provider(config_text: &str) -> bool {
    config_text.lines().any(|line| {
        let trimmed = line.trim_start();
        trimmed.starts_with("model_provider ")
            || trimmed.starts_with("model_provider\t")
            || trimmed.starts_with("model_provider=")
            || trimmed.starts_with("model_provider_id ")
            || trimmed.starts_with("model_provider_id\t")
            || trimmed.starts_with("model_provider_id=")
    })
}

fn rollout_line_without_gateway_session_provider(line: &str) -> Option<String> {
    let mut value = serde_json::from_str::<Value>(line).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    let payload = value.get_mut("payload")?.as_object_mut()?;
    if payload.get("model_provider").and_then(Value::as_str) != Some("api_router") {
        return None;
    }
    payload.remove("model_provider")?;
    Some(value.to_string())
}

fn strip_gateway_session_provider_from_rollout_path(path: &Path) -> Result<bool, String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let has_trailing_newline = text.ends_with('\n');
    let mut changed = false;
    let lines = text
        .lines()
        .map(|line| {
            if let Some(next) = rollout_line_without_gateway_session_provider(line) {
                changed = true;
                next
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>();
    if !changed {
        return Ok(false);
    }
    let mut next = lines.join("\n");
    if has_trailing_newline {
        next.push('\n');
    }
    std::fs::write(path, next).map_err(|e| e.to_string())?;
    Ok(true)
}

pub(super) fn sanitize_official_resume_rollout(
    codex_home: Option<&str>,
    rollout_path: Option<&str>,
) -> Result<bool, String> {
    let home = codex_home_dir_for_override(codex_home)?;
    let config_text = std::fs::read_to_string(home.join("config.toml")).unwrap_or_default();
    if config_text_uses_model_provider(&config_text) {
        return Ok(false);
    }
    let Some(path) = rollout_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    else {
        return Ok(false);
    };
    if !path.exists() || !path.is_file() {
        return Ok(false);
    }
    strip_gateway_session_provider_from_rollout_path(&path)
}

pub(super) fn sanitize_official_resume_state(
    codex_home: Option<&str>,
    thread_id: &str,
) -> Result<bool, String> {
    let home = codex_home_dir_for_override(codex_home)?;
    let config_text = std::fs::read_to_string(home.join("config.toml")).unwrap_or_default();
    if config_text_uses_model_provider(&config_text) {
        return Ok(false);
    }
    let state_path = home.join("state_5.sqlite");
    if !state_path.exists() || !state_path.is_file() {
        return Ok(false);
    }
    let conn = rusqlite::Connection::open(&state_path).map_err(|e| e.to_string())?;
    let provider: Option<String> = conn
        .query_row(
            "SELECT model_provider FROM threads WHERE id = ?1",
            params![thread_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if provider.as_deref() != Some("api_router") {
        return Ok(false);
    }
    let changed = conn
        .execute(
            "UPDATE threads SET model_provider = ?1 WHERE id = ?2 AND model_provider = ?3",
            params!["openai", thread_id, "api_router"],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed > 0)
}

fn linux_wsl_path_to_windows_path(path: &str) -> Option<PathBuf> {
    if !cfg!(target_os = "windows") {
        return None;
    }
    let trimmed = path.trim();
    if !trimmed.starts_with('/') {
        return None;
    }
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.arg("-e").arg("wslpath").arg("-w").arg(trimmed);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let windows_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if windows_path.is_empty() {
        None
    } else {
        Some(PathBuf::from(windows_path))
    }
}

fn import_wsl_rollout_from_known_path(thread_id: &str, rollout_path: &str) -> Result<bool, String> {
    if !cfg!(target_os = "windows") || !is_safe_thread_id(thread_id) {
        return Ok(false);
    }
    let codex_home =
        crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override_for_target(Some(
            WorkspaceTarget::Wsl2,
        ));
    if rollout_path_is_already_in_codex_home(codex_home.as_deref(), rollout_path) {
        return Ok(false);
    }
    let trimmed = rollout_path.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }
    let src_path =
        linux_wsl_path_to_windows_path(trimmed).unwrap_or_else(|| PathBuf::from(trimmed));
    import_rollout_file_into_codex_home(codex_home.as_deref(), thread_id, src_path.as_path())
}

pub(super) fn import_rollout_from_known_path(
    codex_home: Option<&str>,
    thread_id: &str,
    workspace_hint: Option<WorkspaceTarget>,
    rollout_path: &str,
) -> Result<bool, String> {
    if rollout_path_is_already_in_codex_home(codex_home, rollout_path) {
        return Ok(false);
    }
    let session_home =
        crate::orchestrator::gateway::web_codex_home::web_codex_session_home_for_runtime_home(
            codex_home,
        );
    if rollout_path_is_already_in_codex_home(session_home.as_deref(), rollout_path) {
        return Ok(false);
    }
    match workspace_hint {
        Some(WorkspaceTarget::Wsl2) => import_wsl_rollout_from_known_path(thread_id, rollout_path),
        _ => import_rollout_file_into_codex_home(codex_home, thread_id, Path::new(rollout_path)),
    }
}

pub(super) fn resume_import_order(workspace_hint: Option<WorkspaceTarget>) -> Vec<WorkspaceTarget> {
    match workspace_hint {
        Some(target) => vec![target],
        None => vec![WorkspaceTarget::Windows, WorkspaceTarget::Wsl2],
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "windows")]
    use super::codex_home_dir_for_override;
    use super::{
        import_rollout_file_into_codex_home, import_rollout_from_known_path, resume_import_order,
        sanitize_official_resume_rollout, sanitize_official_resume_state, WorkspaceTarget,
    };
    #[cfg(target_os = "windows")]
    use crate::orchestrator::gateway::web_codex_home::{lock_wsl_identity_cache, WslIdentityCache};
    use std::path::Path;

    #[cfg(target_os = "windows")]
    struct WslIdentityGuard {
        previous: Option<WslIdentityCache>,
    }

    #[cfg(target_os = "windows")]
    impl WslIdentityGuard {
        fn set(distro: &str, home: &str) -> Self {
            let mut cache = lock_wsl_identity_cache();
            let previous = cache.clone();
            *cache = Some(WslIdentityCache {
                distro: distro.to_string(),
                home: home.to_string(),
                updated_at_unix_secs: i64::MAX,
            });
            drop(cache);
            Self { previous }
        }
    }

    #[cfg(target_os = "windows")]
    impl Drop for WslIdentityGuard {
        fn drop(&mut self) {
            let mut cache = lock_wsl_identity_cache();
            *cache = self.previous.clone();
        }
    }

    #[test]
    fn resume_import_order_respects_workspace_hint() {
        let default_order = resume_import_order(None);
        assert_eq!(
            default_order,
            vec![WorkspaceTarget::Windows, WorkspaceTarget::Wsl2]
        );

        let wsl_order = resume_import_order(Some(WorkspaceTarget::Wsl2));
        assert_eq!(wsl_order, vec![WorkspaceTarget::Wsl2]);

        let windows_order = resume_import_order(Some(WorkspaceTarget::Windows));
        assert_eq!(windows_order, vec![WorkspaceTarget::Windows]);
    }

    #[test]
    fn explicit_rpc_home_override_controls_import_destination() {
        let temp = tempfile::tempdir().expect("tempdir");
        let target_home = temp.path().join("target-home");
        let source_file = temp
            .path()
            .join("019c7766-db34-7c43-a808-b2e8f356c907.jsonl");
        std::fs::write(&source_file, "{\"thread_id\":\"t\"}\n").expect("write rollout");

        let imported = import_rollout_file_into_codex_home(
            Some(target_home.to_string_lossy().as_ref()),
            "019c7766-db34-7c43-a808-b2e8f356c907",
            Path::new(&source_file),
        )
        .expect("import");
        assert!(imported);
        assert!(target_home
            .join("sessions")
            .join("imported")
            .join("019c7766-db34-7c43-a808-b2e8f356c907.jsonl")
            .exists());
    }

    #[test]
    fn sanitize_official_resume_rollout_removes_gateway_session_provider() {
        let temp = tempfile::tempdir().expect("tempdir");
        let codex_home = temp.path().join(".codex");
        std::fs::create_dir_all(&codex_home).expect("create home");
        std::fs::write(codex_home.join("config.toml"), "model = \"gpt-5.4\"\n")
            .expect("write config");
        let rollout = codex_home
            .join("sessions")
            .join("2026")
            .join("03")
            .join("20")
            .join("rollout-thread-1.jsonl");
        std::fs::create_dir_all(rollout.parent().expect("rollout parent"))
            .expect("create rollout parent");
        std::fs::write(
            &rollout,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\",\"model_provider\":\"api_router\",\"model\":\"gpt-5.4\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\"}}\n",
            ),
        )
        .expect("write rollout");

        let changed = sanitize_official_resume_rollout(
            Some(codex_home.to_string_lossy().as_ref()),
            Some(rollout.to_string_lossy().as_ref()),
        )
        .expect("sanitize");

        assert!(changed);
        let next = std::fs::read_to_string(&rollout).expect("read rollout");
        assert!(!next.contains("\"model_provider\":\"api_router\""));
        assert!(next.contains("\"model\":\"gpt-5.4\""));
    }

    #[test]
    fn sanitize_official_resume_rollout_keeps_gateway_runtime_rollout() {
        let temp = tempfile::tempdir().expect("tempdir");
        let codex_home = temp.path().join(".codex");
        std::fs::create_dir_all(&codex_home).expect("create home");
        std::fs::write(
            codex_home.join("config.toml"),
            "model_provider = \"api_router\"\nmodel = \"gpt-5.4\"\n",
        )
        .expect("write config");
        let rollout = codex_home.join("sessions").join("rollout-thread-1.jsonl");
        std::fs::create_dir_all(rollout.parent().expect("rollout parent"))
            .expect("create rollout parent");
        std::fs::write(
            &rollout,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\",\"model_provider\":\"api_router\"}}\n",
        )
        .expect("write rollout");

        let changed = sanitize_official_resume_rollout(
            Some(codex_home.to_string_lossy().as_ref()),
            Some(rollout.to_string_lossy().as_ref()),
        )
        .expect("sanitize");

        assert!(!changed);
        let next = std::fs::read_to_string(&rollout).expect("read rollout");
        assert!(next.contains("\"model_provider\":\"api_router\""));
    }

    #[test]
    fn sanitize_official_resume_state_rewrites_gateway_thread_provider() {
        let temp = tempfile::tempdir().expect("tempdir");
        let codex_home = temp.path().join(".codex");
        std::fs::create_dir_all(&codex_home).expect("create home");
        std::fs::write(codex_home.join("config.toml"), "model = \"gpt-5.4\"\n")
            .expect("write config");
        let state = codex_home.join("state_5.sqlite");
        let conn = rusqlite::Connection::open(&state).expect("open sqlite");
        conn.execute(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL)",
            [],
        )
        .expect("create threads");
        conn.execute(
            "INSERT INTO threads (id, model_provider) VALUES (?1, ?2)",
            ["thread-1", "api_router"],
        )
        .expect("insert thread");
        drop(conn);

        let changed =
            sanitize_official_resume_state(Some(codex_home.to_string_lossy().as_ref()), "thread-1")
                .expect("sanitize");

        let conn = rusqlite::Connection::open(&state).expect("open sqlite");
        let provider: String = conn
            .query_row(
                "SELECT model_provider FROM threads WHERE id = ?1",
                ["thread-1"],
                |row| row.get(0),
            )
            .expect("read provider");
        assert!(changed);
        assert_eq!(provider, "openai");
    }

    #[test]
    fn sanitize_official_resume_state_keeps_gateway_thread_provider() {
        let temp = tempfile::tempdir().expect("tempdir");
        let codex_home = temp.path().join(".codex");
        std::fs::create_dir_all(&codex_home).expect("create home");
        std::fs::write(
            codex_home.join("config.toml"),
            "model_provider = \"api_router\"\nmodel = \"gpt-5.4\"\n",
        )
        .expect("write config");
        let state = codex_home.join("state_5.sqlite");
        let conn = rusqlite::Connection::open(&state).expect("open sqlite");
        conn.execute(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL)",
            [],
        )
        .expect("create threads");
        conn.execute(
            "INSERT INTO threads (id, model_provider) VALUES (?1, ?2)",
            ["thread-1", "api_router"],
        )
        .expect("insert thread");
        drop(conn);

        let changed =
            sanitize_official_resume_state(Some(codex_home.to_string_lossy().as_ref()), "thread-1")
                .expect("sanitize");

        let conn = rusqlite::Connection::open(&state).expect("open sqlite");
        let provider: String = conn
            .query_row(
                "SELECT model_provider FROM threads WHERE id = ?1",
                ["thread-1"],
                |row| row.get(0),
            )
            .expect("read provider");
        assert!(!changed);
        assert_eq!(provider, "api_router");
    }

    #[test]
    fn import_rollout_file_sanitizes_official_runtime_copy() {
        let temp = tempfile::tempdir().expect("tempdir");
        let codex_home = temp.path().join(".codex");
        std::fs::create_dir_all(&codex_home).expect("create home");
        std::fs::write(codex_home.join("config.toml"), "model = \"gpt-5.4\"\n")
            .expect("write config");
        let source_file = temp.path().join("rollout-thread-1.jsonl");
        std::fs::write(
            &source_file,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\",\"model_provider\":\"api_router\"}}\n",
        )
        .expect("write source");

        let imported = import_rollout_file_into_codex_home(
            Some(codex_home.to_string_lossy().as_ref()),
            "thread-1",
            Path::new(&source_file),
        )
        .expect("import");

        assert!(imported);
        let imported_file = codex_home
            .join("sessions")
            .join("imported")
            .join("thread-1.jsonl");
        let next = std::fs::read_to_string(imported_file).expect("read imported");
        assert!(!next.contains("\"model_provider\":\"api_router\""));
    }

    #[test]
    fn linux_home_override_resolves_to_unc_path_on_windows() {
        #[cfg(target_os = "windows")]
        {
            let _identity = WslIdentityGuard::set("Ubuntu", "/home/test/.codex");
            let resolved =
                codex_home_dir_for_override(Some("/home/test/.codex")).expect("resolve wsl home");
            let resolved_str = resolved.to_string_lossy();
            assert!(resolved_str.contains("wsl.localhost") || resolved_str.contains("wsl$"));
            assert!(resolved_str.contains(".codex"));
        }
    }

    #[test]
    fn import_rollout_from_known_path_skips_copy_when_rollout_is_already_in_same_home() {
        let temp = tempfile::tempdir().expect("tempdir");
        let codex_home = temp.path().join(".codex");
        let rollout = codex_home
            .join("sessions")
            .join("2026")
            .join("03")
            .join("20")
            .join("rollout-thread-1.jsonl");
        std::fs::create_dir_all(rollout.parent().expect("rollout parent"))
            .expect("create rollout parent");
        std::fs::write(
            &rollout,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\"}}\n",
        )
        .expect("write rollout");

        let imported = import_rollout_from_known_path(
            Some(codex_home.to_string_lossy().as_ref()),
            "thread-1",
            Some(WorkspaceTarget::Windows),
            rollout.to_string_lossy().as_ref(),
        )
        .expect("import");

        assert!(!imported);
        assert!(!codex_home
            .join("sessions")
            .join("imported")
            .join("thread-1.jsonl")
            .exists());
    }

    #[test]
    fn import_rollout_from_known_path_skips_copy_when_runtime_home_uses_session_home() {
        let _guard = crate::codex_app_server::lock_test_globals();
        let user_profile = tempfile::tempdir().expect("user profile");
        let app_data = tempfile::tempdir().expect("app data");
        let codex_home = user_profile.path().join(".codex");
        let runtime_home = app_data.path().join("codex-home");
        let rollout = codex_home
            .join("sessions")
            .join("2026")
            .join("03")
            .join("20")
            .join("rollout-thread-1.jsonl");
        std::fs::create_dir_all(rollout.parent().expect("rollout parent"))
            .expect("create rollout parent");
        std::fs::write(
            &rollout,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\"}}\n",
        )
        .expect("write rollout");
        unsafe {
            std::env::set_var("USERPROFILE", user_profile.path());
            std::env::set_var("API_ROUTER_USER_DATA_DIR", app_data.path());
            std::env::remove_var("API_ROUTER_WEB_CODEX_CODEX_HOME");
            std::env::remove_var("CODEX_HOME");
        }

        let imported = import_rollout_from_known_path(
            Some(runtime_home.to_string_lossy().as_ref()),
            "thread-1",
            Some(WorkspaceTarget::Windows),
            rollout.to_string_lossy().as_ref(),
        )
        .expect("import");

        assert!(!imported);
        assert!(!runtime_home
            .join("sessions")
            .join("imported")
            .join("thread-1.jsonl")
            .exists());

        unsafe {
            std::env::remove_var("USERPROFILE");
            std::env::remove_var("API_ROUTER_USER_DATA_DIR");
        }
    }

    #[test]
    fn import_rollout_file_overwrites_stale_imported_copy() {
        let temp = tempfile::tempdir().expect("tempdir");
        let target_home = temp.path().join("target-home");
        let source_file = temp
            .path()
            .join("019c7766-db34-7c43-a808-b2e8f356c907.jsonl");
        let dest_file = target_home
            .join("sessions")
            .join("imported")
            .join("019c7766-db34-7c43-a808-b2e8f356c907.jsonl");

        std::fs::create_dir_all(dest_file.parent().expect("dest parent")).expect("create dest dir");
        std::fs::write(&source_file, "{\"thread_id\":\"fresh\",\"seq\":2}\n")
            .expect("write source");
        std::fs::write(&dest_file, "{\"thread_id\":\"stale\",\"seq\":1}\n")
            .expect("write stale dest");

        let imported = import_rollout_file_into_codex_home(
            Some(target_home.to_string_lossy().as_ref()),
            "019c7766-db34-7c43-a808-b2e8f356c907",
            Path::new(&source_file),
        )
        .expect("import");

        assert!(imported);
        assert_eq!(
            std::fs::read_to_string(&dest_file).expect("read imported file"),
            "{\"thread_id\":\"fresh\",\"seq\":2}\n"
        );
    }
}
