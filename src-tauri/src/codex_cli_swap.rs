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

pub fn default_cli_codex_home() -> Option<PathBuf> {
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

fn swap_state(cli_home: &Path) -> Result<&'static str, String> {
    // `original` => no swap state dir
    // `swapped`  => swap state dir exists and backups exist
    let state_dir = swap_state_dir(cli_home);
    if !state_dir.exists() {
        return Ok("original");
    }
    let backup_auth = state_dir.join("auth.json.bak");
    let backup_cfg = state_dir.join("config.toml.bak");
    if backup_auth.exists() && backup_cfg.exists() {
        return Ok("swapped");
    }
    Err(format!(
        "Swap state is corrupted in: {}",
        state_dir.display()
    ))
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

fn ensure_cli_files_exist(cli_home: &Path) -> Result<(), String> {
    if !cli_home.exists() {
        return Err(format!("Codex dir does not exist: {}", cli_home.display()));
    }
    let auth = cli_home.join("auth.json");
    let cfg = cli_home.join("config.toml");
    if !auth.exists() {
        return Err(format!("Missing auth.json in: {}", cli_home.display()));
    }
    if !cfg.exists() {
        return Err(format!("Missing config.toml in: {}", cli_home.display()));
    }
    Ok(())
}

fn swap_mode_for_dir(cli_home: &Path) -> Result<&'static str, String> {
    match swap_state(cli_home)? {
        "original" => Ok("swap"),
        "swapped" => Ok("restore"),
        _ => Err("unexpected swap state".to_string()),
    }
}

fn restore_dir(cli_home: &Path) -> Result<(), String> {
    ensure_cli_files_exist(cli_home)?;

    let state_dir = swap_state_dir(cli_home);
    let backup_auth = state_dir.join("auth.json.bak");
    let backup_cfg = state_dir.join("config.toml.bak");
    let cli_auth = cli_home.join("auth.json");
    let cli_cfg = cli_home.join("config.toml");

    let bak_auth = read_json(&backup_auth)?;
    write_json_pretty(&cli_auth, &bak_auth)?;
    let bak_cfg = std::fs::read_to_string(&backup_cfg).map_err(|e| e.to_string())?;
    write_text(&cli_cfg, &bak_cfg)?;
    let _ = std::fs::remove_dir_all(&state_dir);
    Ok(())
}

fn swap_dir(cli_home: &Path, app_auth_json: &serde_json::Value) -> Result<(), String> {
    ensure_cli_files_exist(cli_home)?;

    let state_dir = swap_state_dir(cli_home);
    let backup_auth = state_dir.join("auth.json.bak");
    let backup_cfg = state_dir.join("config.toml.bak");
    let cli_auth = cli_home.join("auth.json");
    let cli_cfg = cli_home.join("config.toml");

    std::fs::create_dir_all(&state_dir).map_err(|e| e.to_string())?;
    write_json_pretty(&backup_auth, &read_json(&cli_auth)?)?;
    let orig_cfg_txt = std::fs::read_to_string(&cli_cfg).map_err(|e| e.to_string())?;
    write_text(&backup_cfg, &orig_cfg_txt)?;

    write_json_pretty(&cli_auth, app_auth_json)?;
    let next_cfg = strip_model_provider_line(&orig_cfg_txt);
    write_text(&cli_cfg, &next_cfg)?;
    Ok(())
}

pub fn toggle_cli_auth_config_swap(
    state: &tauri::State<'_, AppState>,
    cli_homes: Vec<String>,
) -> Result<serde_json::Value, String> {
    let mut homes: Vec<PathBuf> = cli_homes
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .collect();

    homes.sort();
    homes.dedup();
    if homes.is_empty() {
        homes.push(default_cli_codex_home().ok_or_else(|| "missing HOME/USERPROFILE".to_string())?);
    }
    if homes.len() > 2 {
        return Err("At most 2 Codex dirs are supported.".to_string());
    }

    // Enforce consistent mode across multiple dirs to avoid confusing partial swaps.
    let mut mode: Option<&'static str> = None;
    for h in &homes {
        let m = swap_mode_for_dir(h)?;
        if mode.is_none() {
            mode = Some(m);
        } else if mode != Some(m) {
            return Err("Codex dirs are in different swap states. Restore first.".to_string());
        }
    }
    let mode = mode.unwrap_or("swap");

    if mode == "restore" {
        for h in &homes {
            restore_dir(h)?;
        }
        return Ok(json!({
          "ok": true,
          "mode": "restored",
          "cli_homes": homes.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
        }));
    }

    // Read app's signed-in auth.json (stored in the app's isolated CODEX_HOME).
    let app_home = app_codex_home(state);
    let app_auth = app_home.join("auth.json");
    let app_auth_json = read_json(&app_auth)
        .map_err(|_| "Missing app Codex auth.json. Try logging in first.".to_string())?;
    ensure_signed_in(&app_auth_json)?;

    for h in &homes {
        swap_dir(h, &app_auth_json)?;
    }

    // Emit an event for auditability.
    state.gateway.store.add_event(
        "codex",
        "info",
        "codex.cli_auth_config_swapped",
        "Codex CLI auth/config swapped",
        json!({
          "cli_homes": homes.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
          "swapped_at_unix_ms": unix_ms(),
        }),
    );

    Ok(json!({
      "ok": true,
      "mode": "swapped",
      "cli_homes": homes.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
    }))
}

pub fn cli_auth_config_swap_status(cli_homes: Vec<String>) -> Result<serde_json::Value, String> {
    let mut homes: Vec<PathBuf> = cli_homes
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .collect();

    homes.sort();
    homes.dedup();
    if homes.is_empty() {
        homes.push(default_cli_codex_home().ok_or_else(|| "missing HOME/USERPROFILE".to_string())?);
    }
    if homes.len() > 2 {
        return Err("At most 2 Codex dirs are supported.".to_string());
    }

    let mut dirs: Vec<serde_json::Value> = Vec::new();
    for h in &homes {
        // Keep status call non-destructive and informative.
        let s = match ensure_cli_files_exist(h) {
            Ok(()) => match swap_state(h) {
                Ok(v) => v.to_string(),
                Err(e) => format!("error:{e}"),
            },
            Err(e) => format!("error:{e}"),
        };
        dirs.push(json!({
          "cli_home": h.to_string_lossy(),
          "state": s,
        }));
    }

    let mut has_swapped = false;
    let mut has_original = false;
    let mut has_error = false;
    for d in &dirs {
        let s = d.get("state").and_then(|v| v.as_str()).unwrap_or("");
        if s == "swapped" {
            has_swapped = true;
        } else if s == "original" {
            has_original = true;
        } else {
            has_error = true;
        }
    }

    let overall = if has_error {
        "error"
    } else if has_swapped && has_original {
        "mixed"
    } else if has_swapped {
        "swapped"
    } else {
        "original"
    };

    Ok(json!({
      "ok": true,
      "overall": overall,
      "dirs": dirs,
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
