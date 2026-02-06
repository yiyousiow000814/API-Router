use serde_json::json;
use std::path::{Path, PathBuf};

use crate::app_state::AppState;
use crate::orchestrator::store::unix_ms;

fn user_profile_dir() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .map(PathBuf::from)
        })
}

fn default_cli_codex_home() -> Option<PathBuf> {
    // Intentionally *not* CODEX_HOME: the app sets CODEX_HOME to its own isolated directory.
    // This swap targets the user's default Codex CLI home (typically ~/.codex).
    user_profile_dir().map(|p| p.join(".codex"))
}

fn app_codex_home(state: &tauri::State<'_, AppState>) -> PathBuf {
    state
        .config_path
        .parent()
        .unwrap_or(Path::new("."))
        .join("codex-home")
}

fn swap_state_dir(cli_home: &Path) -> PathBuf {
    cli_home.join(".api-router-swap")
}

fn strip_model_provider_line(cfg: &str) -> String {
    // Keep this minimal and deterministic: remove only the top-level key assignment.
    // We intentionally do NOT attempt to rewrite other parts of the file.
    cfg.lines()
        .filter(|line| {
            let t = line.trim_start();
            // Remove `model_provider = "..."` or `model_provider_id = "..."` (top-level).
            // We also remove commented variants that only differ by leading whitespace.
            !(t.starts_with("model_provider ")
                || t.starts_with("model_provider\t")
                || t.starts_with("model_provider=")
                || t.starts_with("model_provider_id ")
                || t.starts_with("model_provider_id\t")
                || t.starts_with("model_provider_id="))
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

fn read_json(path: &Path) -> Result<serde_json::Value, String> {
    let txt = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&txt).map_err(|e| e.to_string())
}

fn write_json_pretty(path: &Path, v: &serde_json::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let txt = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    std::fs::write(path, txt).map_err(|e| e.to_string())?;
    Ok(())
}

fn write_text(path: &Path, s: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, s).map_err(|e| e.to_string())?;
    Ok(())
}

fn ensure_signed_in(app_auth_json: &serde_json::Value) -> Result<(), String> {
    // Best-effort: require a token shape. We do not validate expiry here.
    let has_token = app_auth_json
        .get("tokens")
        .and_then(|t| t.as_object())
        .is_some_and(|o| !o.is_empty());
    if has_token {
        return Ok(());
    }
    Err("Codex is not signed in yet. Click Log in first.".to_string())
}

pub fn toggle_cli_auth_config_swap(
    state: &tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let cli_home =
        default_cli_codex_home().ok_or_else(|| "missing HOME/USERPROFILE".to_string())?;

    let state_dir = swap_state_dir(&cli_home);
    let backup_auth = state_dir.join("auth.json.bak");
    let backup_cfg = state_dir.join("config.toml.bak");

    let cli_auth = cli_home.join("auth.json");
    let cli_cfg = cli_home.join("config.toml");

    // Toggle behavior:
    // - If swap state exists, restore backups and remove state dir.
    // - Otherwise, create backups, then write "signed-in auth" and "config without model_provider".
    if state_dir.exists() {
        if backup_auth.exists() {
            let bak = read_json(&backup_auth)?;
            write_json_pretty(&cli_auth, &bak)?;
        }
        if backup_cfg.exists() {
            let bak = std::fs::read_to_string(&backup_cfg).map_err(|e| e.to_string())?;
            write_text(&cli_cfg, &bak)?;
        }
        let _ = std::fs::remove_dir_all(&state_dir);
        return Ok(json!({
          "ok": true,
          "mode": "restored",
          "cli_home": cli_home.to_string_lossy(),
        }));
    }

    // Read app's signed-in auth.json (stored in the app's isolated CODEX_HOME).
    let app_home = app_codex_home(state);
    let app_auth = app_home.join("auth.json");
    let app_auth_json = read_json(&app_auth)
        .map_err(|_| "Missing app Codex auth.json. Try logging in first.".to_string())?;
    ensure_signed_in(&app_auth_json)?;

    // Backup current CLI auth/config (if present).
    std::fs::create_dir_all(&state_dir).map_err(|e| e.to_string())?;
    write_json_pretty(&backup_auth, &read_json(&cli_auth).unwrap_or(json!({})))?;
    let orig_cfg_txt = std::fs::read_to_string(&cli_cfg).unwrap_or_default();
    write_text(&backup_cfg, &orig_cfg_txt)?;

    // Replace CLI auth with the app's signed-in auth.
    write_json_pretty(&cli_auth, &app_auth_json)?;

    // Replace CLI config with the current config with `model_provider = ...` removed.
    let next_cfg = strip_model_provider_line(&orig_cfg_txt);
    write_text(&cli_cfg, &next_cfg)?;

    // Emit an event for auditability.
    state.gateway.store.add_event(
        "codex",
        "info",
        "codex.cli_auth_config_swapped",
        "Codex CLI auth/config swapped",
        json!({
          "cli_home": cli_home.to_string_lossy(),
          "swapped_at_unix_ms": unix_ms(),
        }),
    );

    Ok(json!({
      "ok": true,
      "mode": "swapped",
      "cli_home": cli_home.to_string_lossy(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_model_provider_removes_top_level_keys_only() {
        let cfg = r#"
model_provider = "api_router"
model_provider_id="api_router"
model = "gpt-5.2"

[model_providers.api_router]
base_url = "http://127.0.0.1:4000/v1"
"#;
        let out = strip_model_provider_line(cfg);
        assert!(!out.contains("model_provider ="));
        assert!(!out.contains("model_provider_id="));
        assert!(out.contains("model = \"gpt-5.2\""));
        assert!(out.contains("[model_providers.api_router]"));
    }
}
