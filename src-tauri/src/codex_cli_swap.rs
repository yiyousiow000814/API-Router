use serde_json::json;
use std::path::{Path, PathBuf};

use crate::app_state::AppState;
use crate::orchestrator::store::unix_ms;

fn read_bytes(path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| e.to_string())
}

fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, bytes).map_err(|e| e.to_string())?;
    Ok(())
}

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

#[cfg(windows)]
fn hidden_wsl_command() -> std::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(windows)]
fn default_wsl_distribution_and_home() -> Option<(String, String)> {
    let output = hidden_wsl_command()
        .args([
            "-e",
            "sh",
            "-lc",
            "printf '%s:%s' \"$WSL_DISTRO_NAME\" \"$HOME\"",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let line = text.trim();
    let (distro, home) = line.split_once(':')?;
    let distro = distro.trim();
    let home = home.trim();
    if distro.is_empty() || home.is_empty() {
        return None;
    }
    Some((distro.to_string(), home.to_string()))
}

#[cfg(windows)]
fn wsl_home_to_unc_codex_home(distro: &str, home: &str) -> Option<PathBuf> {
    let distro = distro.trim();
    let home = home.trim().trim_start_matches('/');
    if distro.is_empty() || home.is_empty() {
        return None;
    }
    let home_windows = home.replace('/', "\\");
    Some(PathBuf::from(format!(
        "\\\\wsl.localhost\\{distro}\\{home_windows}\\.codex"
    )))
}

fn dedup_key(cli_home: &Path) -> String {
    // We want stable behavior on Windows where paths are case-insensitive and may use mixed slashes.
    // Avoid `canonicalize()` here (it requires existence and can fail); we already validate existence later.
    let mut s = cli_home.to_string_lossy().to_string();
    if cfg!(windows) {
        s = s.replace('/', "\\");
    }
    while s.len() > 1 && (s.ends_with('\\') || s.ends_with('/')) {
        // Keep "C:\" intact.
        if cfg!(windows) && s.len() == 3 {
            let b = s.as_bytes();
            if b[1] == b':' && (b[2] == b'\\' || b[2] == b'/') {
                break;
            }
        }
        s.pop();
    }
    if cfg!(windows) {
        s = s.to_ascii_lowercase();
    }
    s
}

pub fn default_cli_codex_home() -> Option<PathBuf> {
    // Intentionally *not* CODEX_HOME: the app sets CODEX_HOME to its own isolated directory.
    // This swap targets the user's default Codex CLI home (typically ~/.codex).
    user_profile_dir().map(|p| p.join(".codex"))
}

pub fn default_wsl_cli_codex_home() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let (distro, home) = default_wsl_distribution_and_home()?;
        wsl_home_to_unc_codex_home(&distro, &home)
    }
    #[cfg(not(windows))]
    {
        None
    }
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
    let eol = if cfg.contains("\r\n") { "\r\n" } else { "\n" };
    cfg.lines()
        .filter(|line| {
            let t = line.trim_start();
            // Remove `model_provider = "..."` or `model_provider_id = "..."` (top-level).
            // Note: we intentionally do NOT remove commented lines (e.g. `# model_provider = ...`).
            !(t.starts_with("model_provider ")
                || t.starts_with("model_provider\t")
                || t.starts_with("model_provider=")
                || t.starts_with("model_provider_id ")
                || t.starts_with("model_provider_id\t")
                || t.starts_with("model_provider_id="))
        })
        .collect::<Vec<_>>()
        .join(eol)
        + eol
}

fn read_json(path: &Path) -> Result<serde_json::Value, String> {
    let txt = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&txt).map_err(|e| e.to_string())
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

fn ensure_cli_config_exists(cli_home: &Path) -> Result<(), String> {
    if !cli_home.exists() {
        return Err(format!("Codex dir does not exist: {}", cli_home.display()));
    }
    let cfg = cli_home.join("config.toml");
    if !cfg.exists() {
        return Err(format!("Missing config.toml in: {}", cli_home.display()));
    }
    Ok(())
}

fn resolve_cli_homes_or_default(
    cli_homes: Vec<String>,
    max_homes: usize,
) -> Result<Vec<PathBuf>, String> {
    let mut homes: Vec<(String, PathBuf)> = cli_homes
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .map(|p| (dedup_key(&p), p))
        .collect();

    homes.sort_by(|a, b| a.0.cmp(&b.0));
    homes.dedup_by(|a, b| a.0 == b.0);
    let mut homes: Vec<PathBuf> = homes.into_iter().map(|(_, p)| p).collect();
    if homes.is_empty() {
        homes.push(default_cli_codex_home().ok_or_else(|| "missing HOME/USERPROFILE".to_string())?);
    }
    if homes.len() > max_homes {
        return Err(format!("At most {max_homes} Codex dirs are supported."));
    }
    Ok(homes)
}

fn resolve_cli_home(cli_home: Option<&str>) -> Result<PathBuf, String> {
    let homes =
        resolve_cli_homes_or_default(cli_home.into_iter().map(str::to_string).collect(), 1)?;
    homes
        .into_iter()
        .next()
        .ok_or_else(|| "missing HOME/USERPROFILE".to_string())
}

pub fn get_cli_config_toml(cli_home: Option<&str>) -> Result<String, String> {
    let home = resolve_cli_home(cli_home)?;
    ensure_cli_config_exists(&home)?;
    std::fs::read_to_string(home.join("config.toml")).map_err(|e| e.to_string())
}

pub fn set_cli_config_toml(cli_home: Option<&str>, toml_text: &str) -> Result<(), String> {
    let home = resolve_cli_home(cli_home)?;
    ensure_cli_config_exists(&home)?;
    let _: toml::Value =
        toml::from_str(toml_text).map_err(|e| format!("invalid config.toml: {e}"))?;
    write_text(&home.join("config.toml"), toml_text)
}

fn restore_dir(cli_home: &Path) -> Result<(), String> {
    ensure_cli_files_exist(cli_home)?;

    let state_dir = swap_state_dir(cli_home);
    let backup_auth = state_dir.join("auth.json.bak");
    let backup_cfg = state_dir.join("config.toml.bak");
    let cli_auth = cli_home.join("auth.json");
    let cli_cfg = cli_home.join("config.toml");

    let cur_auth = read_bytes(&cli_auth)?;
    let cur_cfg = read_bytes(&cli_cfg)?;

    let bak_auth = read_bytes(&backup_auth)?;
    let bak_cfg = read_bytes(&backup_cfg)?;

    // Best-effort local rollback: if restoring cfg fails after auth succeeds, put auth back.
    write_bytes(&cli_auth, &bak_auth).map_err(|e| format!("restore auth.json failed: {e}"))?;
    if let Err(e) =
        write_bytes(&cli_cfg, &bak_cfg).map_err(|e| format!("restore config.toml failed: {e}"))
    {
        let _ = write_bytes(&cli_auth, &cur_auth);
        let _ = write_bytes(&cli_cfg, &cur_cfg);
        return Err(e);
    }
    let _ = std::fs::remove_dir_all(&state_dir);
    Ok(())
}

fn swap_dir(cli_home: &Path, app_auth_json: &serde_json::Value) -> Result<(), String> {
    ensure_cli_files_exist(cli_home)?;
    if swap_state(cli_home)? == "swapped" {
        return Err(format!(
            "Codex dir is already swapped: {}. Restore first.",
            cli_home.display()
        ));
    }

    let state_dir = swap_state_dir(cli_home);
    let backup_auth = state_dir.join("auth.json.bak");
    let backup_cfg = state_dir.join("config.toml.bak");
    let cli_auth = cli_home.join("auth.json");
    let cli_cfg = cli_home.join("config.toml");

    let orig_auth = read_bytes(&cli_auth)?;
    let orig_cfg_bytes = read_bytes(&cli_cfg)?;
    let orig_cfg_txt = String::from_utf8(orig_cfg_bytes.clone())
        .map_err(|_| "config.toml is not valid UTF-8".to_string())?;

    std::fs::create_dir_all(&state_dir).map_err(|e| e.to_string())?;
    write_bytes(&backup_auth, &orig_auth)?;
    write_bytes(&backup_cfg, &orig_cfg_bytes)?;

    // We write to auth/config sequentially, but roll back locally + clean swap state on failure.
    let app_auth_txt = serde_json::to_string_pretty(app_auth_json).map_err(|e| e.to_string())?;
    let next_cfg = strip_model_provider_line(&orig_cfg_txt);

    if let Err(e) =
        write_text(&cli_auth, &app_auth_txt).map_err(|e| format!("write auth.json failed: {e}"))
    {
        let _ = std::fs::remove_dir_all(&state_dir);
        return Err(e);
    }
    if let Err(e) =
        write_text(&cli_cfg, &next_cfg).map_err(|e| format!("write config.toml failed: {e}"))
    {
        let _ = write_bytes(&cli_auth, &orig_auth);
        let _ = write_bytes(&cli_cfg, &orig_cfg_bytes);
        let _ = std::fs::remove_dir_all(&state_dir);
        return Err(e);
    }
    Ok(())
}

pub fn toggle_cli_auth_config_swap(
    state: &tauri::State<'_, AppState>,
    cli_homes: Vec<String>,
) -> Result<serde_json::Value, String> {
    let homes = resolve_cli_homes_or_default(cli_homes, 2)?;

    // Determine action based on current states.
    // If dirs are in a mixed state, we always "restore" (restore only the swapped dirs).
    let mut any_swapped = false;
    for h in &homes {
        match swap_state(h)? {
            "swapped" => any_swapped = true,
            "original" => {}
            _ => return Err("unexpected swap state".to_string()),
        }
    }
    let mode = if any_swapped { "restore" } else { "swap" };

    if mode == "restore" {
        for h in &homes {
            // Restore only dirs that are currently swapped.
            if swap_state(h)? == "swapped" {
                restore_dir(h)?;
            }
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

    let mut swapped: Vec<PathBuf> = Vec::new();
    for h in &homes {
        if let Err(e) = swap_dir(h, &app_auth_json) {
            // Roll back any dirs already swapped in this attempt to avoid mixed state.
            let mut rb_errs: Vec<String> = Vec::new();
            for p in swapped.iter().rev() {
                if let Err(re) = restore_dir(p) {
                    rb_errs.push(format!("{}: {re}", p.display()));
                }
            }
            if rb_errs.is_empty() {
                return Err(e);
            }
            return Err(format!(
                "{e}\nRollback also encountered errors. You may need to restore manually:\n{}",
                rb_errs.join("\n")
            ));
        }
        swapped.push(h.clone());
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
    let homes = resolve_cli_homes_or_default(cli_homes, 2)?;

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
    use crate::constants::GATEWAY_MODEL_PROVIDER_ID;

    #[test]
    fn strip_model_provider_removes_top_level_keys_only() {
        let cfg = format!(
            "\nmodel_provider = \"{provider}\"\nmodel_provider_id=\"{provider}\"\nmodel = \"gpt-5.2\"\n\n[model_providers.{provider}]\nbase_url = \"http://127.0.0.1:4000/v1\"\n",
            provider = GATEWAY_MODEL_PROVIDER_ID
        );
        let out = strip_model_provider_line(&cfg);
        assert!(!out.contains("model_provider ="));
        assert!(!out.contains("model_provider_id="));
        assert!(out.contains("model = \"gpt-5.2\""));
        assert!(out.contains(&format!(
            "[model_providers.{provider}]",
            provider = GATEWAY_MODEL_PROVIDER_ID
        )));
    }
}
