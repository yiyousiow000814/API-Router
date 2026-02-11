use crate::app_state::AppState;
use crate::orchestrator::store::unix_ms;
use serde_json::json;
use std::path::{Path, PathBuf};

fn dedup_key(cli_home: &Path) -> String {
    let mut s = cli_home.to_string_lossy().to_string();
    if cfg!(windows) {
        s = s.replace('/', "\\");
    }
    while s.len() > 1 && (s.ends_with('\\') || s.ends_with('/')) {
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

fn resolve_cli_homes(cli_homes: Vec<String>) -> Result<Vec<PathBuf>, String> {
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
        homes.push(
            crate::codex_cli_swap::default_cli_codex_home()
                .ok_or_else(|| "missing HOME/USERPROFILE".to_string())?,
        );
    }
    if homes.len() > 2 {
        return Err("At most 2 Codex dirs are supported.".to_string());
    }
    Ok(homes)
}

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

fn read_text(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

fn write_text(path: &Path, s: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, s).map_err(|e| e.to_string())?;
    Ok(())
}

fn read_json(path: &Path) -> Result<serde_json::Value, String> {
    let txt = read_text(path)?;
    serde_json::from_str(&txt).map_err(|e| e.to_string())
}

fn write_json(path: &Path, v: &serde_json::Value) -> Result<(), String> {
    let txt = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    write_text(path, &txt)
}

fn swap_state_dir(cli_home: &Path) -> PathBuf {
    cli_home.join(".api-router-swap")
}

fn backup_auth_path(cli_home: &Path) -> PathBuf {
    swap_state_dir(cli_home).join("auth.json.bak")
}

fn backup_cfg_path(cli_home: &Path) -> PathBuf {
    swap_state_dir(cli_home).join("config.toml.bak")
}

fn cli_auth_path(cli_home: &Path) -> PathBuf {
    cli_home.join("auth.json")
}

fn cli_cfg_path(cli_home: &Path) -> PathBuf {
    cli_home.join("config.toml")
}

fn app_codex_home_from_config_path(config_path: &Path) -> PathBuf {
    config_path
        .parent()
        .unwrap_or(Path::new("."))
        .join("codex-home")
}

fn app_codex_home(state: &tauri::State<'_, AppState>) -> PathBuf {
    app_codex_home_from_config_path(&state.config_path)
}

fn app_auth_path(state: &tauri::State<'_, AppState>) -> PathBuf {
    app_codex_home(state).join("auth.json")
}

fn switchboard_state_path_from_config_path(config_path: &Path) -> PathBuf {
    app_codex_home_from_config_path(config_path).join("provider-switchboard-state.json")
}

fn save_switchboard_state_to_config_path(
    config_path: &Path,
    homes: &[PathBuf],
    target: &str,
    provider: Option<&str>,
) -> Result<(), String> {
    let v = json!({
      "target": target,
      "provider": provider,
      "cli_homes": homes.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>()
    });
    write_json(&switchboard_state_path_from_config_path(config_path), &v)
}

fn save_switchboard_state(
    state: &tauri::State<'_, AppState>,
    homes: &[PathBuf],
    target: &str,
    provider: Option<&str>,
) -> Result<(), String> {
    save_switchboard_state_to_config_path(&state.config_path, homes, target, provider)
}

fn load_switchboard_state_from_config_path(config_path: &Path) -> Option<serde_json::Value> {
    read_json(&switchboard_state_path_from_config_path(config_path)).ok()
}

fn ensure_cli_files_exist(cli_home: &Path) -> Result<(), String> {
    if !cli_home.exists() {
        return Err(format!("Codex dir does not exist: {}", cli_home.display()));
    }
    let auth = cli_auth_path(cli_home);
    let cfg = cli_cfg_path(cli_home);
    if !auth.exists() {
        return Err(format!("Missing auth.json in: {}", cli_home.display()));
    }
    if !cfg.exists() {
        return Err(format!("Missing config.toml in: {}", cli_home.display()));
    }
    Ok(())
}

fn home_swap_state(cli_home: &Path) -> Result<&'static str, String> {
    let state_dir = swap_state_dir(cli_home);
    if !state_dir.exists() {
        return Ok("original");
    }
    let backup_auth = backup_auth_path(cli_home);
    let backup_cfg = backup_cfg_path(cli_home);
    if backup_auth.exists() && backup_cfg.exists() {
        return Ok("swapped");
    }
    Err(format!(
        "Swap state is corrupted in: {}",
        state_dir.display()
    ))
}

fn ensure_signed_in(app_auth_json: &serde_json::Value) -> Result<(), String> {
    let has_token = app_auth_json
        .get("tokens")
        .and_then(|t| t.as_object())
        .is_some_and(|o| !o.is_empty());
    if has_token {
        return Ok(());
    }
    Err("Codex is not signed in yet. Click Log in first.".to_string())
}

fn ensure_backup_exists(cli_home: &Path) -> Result<(), String> {
    ensure_cli_files_exist(cli_home)?;
    if home_swap_state(cli_home)? == "swapped" {
        return Ok(());
    }
    let state_dir = swap_state_dir(cli_home);
    std::fs::create_dir_all(&state_dir).map_err(|e| e.to_string())?;
    let auth_src = read_bytes(&cli_auth_path(cli_home))?;
    let cfg_src = read_bytes(&cli_cfg_path(cli_home))?;
    write_bytes(&backup_auth_path(cli_home), &auth_src)?;
    write_bytes(&backup_cfg_path(cli_home), &cfg_src)?;
    Ok(())
}

fn restore_home_original(cli_home: &Path) -> Result<(), String> {
    ensure_cli_files_exist(cli_home)?;
    if home_swap_state(cli_home)? != "swapped" {
        return Ok(());
    }
    let cli_auth = cli_auth_path(cli_home);
    let cli_cfg = cli_cfg_path(cli_home);
    let cur_auth = read_bytes(&cli_auth)?;
    let cur_cfg = read_bytes(&cli_cfg)?;
    let bak_auth = read_bytes(&backup_auth_path(cli_home))?;
    let bak_cfg = read_bytes(&backup_cfg_path(cli_home))?;
    write_bytes(&cli_auth, &bak_auth).map_err(|e| format!("restore auth.json failed: {e}"))?;
    if let Err(e) =
        write_bytes(&cli_cfg, &bak_cfg).map_err(|e| format!("restore config.toml failed: {e}"))
    {
        let _ = write_bytes(&cli_auth, &cur_auth);
        let _ = write_bytes(&cli_cfg, &cur_cfg);
        return Err(e);
    }
    let _ = std::fs::remove_dir_all(swap_state_dir(cli_home));
    Ok(())
}

fn read_original_cfg_text(cli_home: &Path) -> Result<String, String> {
    ensure_cli_files_exist(cli_home)?;
    if home_swap_state(cli_home)? == "swapped" {
        let bytes = read_bytes(&backup_cfg_path(cli_home))?;
        return String::from_utf8(bytes).map_err(|_| "config.toml is not valid UTF-8".to_string());
    }
    read_text(&cli_cfg_path(cli_home))
}

fn strip_model_provider_line(cfg: &str) -> String {
    let eol = if cfg.contains("\r\n") { "\r\n" } else { "\n" };
    cfg.lines()
        .filter(|line| {
            let t = line.trim_start();
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

fn remove_model_provider_sections(cfg: &str, names: &[&str]) -> String {
    let eol = if cfg.contains("\r\n") { "\r\n" } else { "\n" };
    let targets = names
        .iter()
        .flat_map(|n| {
            let escaped = n.replace('\\', "\\\\").replace('"', "\\\"");
            [
                format!("[model_providers.{n}]"),
                format!("[model_providers.\"{escaped}\"]"),
            ]
        })
        .collect::<Vec<_>>();
    let mut out: Vec<String> = Vec::new();
    let mut skipping = false;
    for line in cfg.lines() {
        let t = line.trim();
        let is_section = t.starts_with('[') && t.ends_with(']');
        if is_section {
            if targets.iter().any(|x| x == t) {
                skipping = true;
                continue;
            }
            if skipping {
                skipping = false;
            }
        }
        if !skipping {
            out.push(line.to_string());
        }
    }
    out.join(eol) + eol
}

fn escape_toml(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn build_direct_provider_cfg(orig_cfg: &str, provider: &str, base_url: &str) -> String {
    let mut base = strip_model_provider_line(orig_cfg);
    base = remove_model_provider_sections(&base, &["api_router", provider]);
    let eol = if base.contains("\r\n") { "\r\n" } else { "\n" };
    let provider_esc = escape_toml(provider);
    let base_url_esc = escape_toml(base_url);
    let mut out = String::new();
    out.push_str(&format!("model_provider = \"{}\"{}", provider_esc, eol));
    out.push_str(eol);
    out.push_str(base.trim_end());
    out.push_str(eol);
    out.push_str(eol);
    out.push_str(&format!("[model_providers.\"{}\"]{}", provider_esc, eol));
    out.push_str(&format!("name = \"{}\"{}", provider_esc, eol));
    out.push_str(&format!("base_url = \"{}\"{}", base_url_esc, eol));
    out.push_str(&format!("wire_api = \"responses\"{}", eol));
    out.push_str(&format!("requires_openai_auth = true{}", eol));
    out
}

fn auth_with_openai_key(key: &str) -> serde_json::Value {
    json!({ "OPENAI_API_KEY": key })
}

fn write_swapped_files(
    cli_home: &Path,
    next_auth: &serde_json::Value,
    next_cfg_text: &str,
) -> Result<(), String> {
    ensure_backup_exists(cli_home)?;
    let auth_path = cli_auth_path(cli_home);
    let cfg_path = cli_cfg_path(cli_home);
    let cur_auth = read_bytes(&auth_path)?;
    let cur_cfg = read_bytes(&cfg_path)?;
    write_json(&auth_path, next_auth).map_err(|e| format!("write auth.json failed: {e}"))?;
    if let Err(e) =
        write_text(&cfg_path, next_cfg_text).map_err(|e| format!("write config.toml failed: {e}"))
    {
        let _ = write_bytes(&auth_path, &cur_auth);
        let _ = write_bytes(&cfg_path, &cur_cfg);
        return Err(e);
    }
    Ok(())
}

fn model_provider_id(cfg_txt: &str) -> Option<String> {
    let v = toml::from_str::<toml::Value>(cfg_txt).ok()?;
    let t = v.as_table()?;
    t.get("model_provider")
        .or_else(|| t.get("model_provider_id"))
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn home_mode(cli_home: &Path) -> Result<(String, Option<String>), String> {
    let state = home_swap_state(cli_home)?;
    if state == "original" {
        return Ok(("gateway".to_string(), None));
    }
    let cfg = read_text(&cli_cfg_path(cli_home))?;
    let provider = model_provider_id(&cfg);
    let mode = if provider.is_some() {
        "provider"
    } else {
        "official"
    };
    Ok((mode.to_string(), provider))
}

pub fn get_status(
    state: &tauri::State<'_, AppState>,
    cli_homes: Vec<String>,
) -> Result<serde_json::Value, String> {
    let homes = resolve_cli_homes(cli_homes)?;
    let app_cfg = state.gateway.cfg.read().clone();
    let provider_options = app_cfg
        .provider_order
        .iter()
        .filter(|n| app_cfg.providers.contains_key(n.as_str()) && n.as_str() != "official")
        .cloned()
        .collect::<Vec<_>>();

    let mut dirs = Vec::new();
    for h in &homes {
        ensure_cli_files_exist(h)?;
        let (mode, provider) = home_mode(h)?;
        dirs.push(json!({
          "cli_home": h.to_string_lossy(),
          "mode": mode,
          "model_provider": provider
        }));
    }

    let unique_modes = dirs
        .iter()
        .filter_map(|d| d.get("mode").and_then(|x| x.as_str()))
        .collect::<std::collections::BTreeSet<_>>();
    let overall_mode = if unique_modes.len() == 1 {
        unique_modes.iter().next().copied().unwrap_or("gateway")
    } else {
        "mixed"
    };

    let first_provider = dirs
        .first()
        .and_then(|d| d.get("model_provider"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());

    Ok(json!({
      "ok": true,
      "mode": overall_mode,
      "model_provider": first_provider,
      "dirs": dirs,
      "provider_options": provider_options
    }))
}

fn sync_active_provider_target_for_key_impl(
    state: &AppState,
    provider: &str,
) -> Result<(), String> {
    let Some(sw) = load_switchboard_state_from_config_path(&state.config_path) else {
        return Ok(());
    };
    if sw
        .get("target")
        .and_then(|v| v.as_str())
        .map(|v| v != "provider")
        .unwrap_or(true)
    {
        return Ok(());
    }
    let active_provider = sw
        .get("provider")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("");
    if active_provider != provider {
        return Ok(());
    }

    let homes = sw
        .get("cli_homes")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let homes = resolve_cli_homes(homes)?;

    let app_cfg = state.gateway.cfg.read().clone();
    let cfg = app_cfg
        .providers
        .get(provider)
        .ok_or_else(|| format!("unknown provider: {provider}"))?;
    let base_url = cfg.base_url.trim().to_string();
    if base_url.is_empty() {
        return Err(format!("provider base_url is empty: {provider}"));
    }
    let key = state
        .secrets
        .get_provider_key(provider)
        .ok_or_else(|| format!("provider key is missing: {provider}"))?;
    if key.trim().is_empty() {
        return Err(format!("provider key is empty: {provider}"));
    }

    for h in &homes {
        let (mode, mp) = home_mode(h)?;
        if mode != "provider" || mp.as_deref() != Some(provider) {
            continue;
        }
        let orig_cfg = read_original_cfg_text(h)?;
        let next_cfg = build_direct_provider_cfg(&orig_cfg, provider, &base_url);
        let next_auth = auth_with_openai_key(key.trim());
        write_swapped_files(h, &next_auth, &next_cfg)?;
    }

    Ok(())
}

pub fn sync_active_provider_target_for_key(
    state: &tauri::State<'_, AppState>,
    provider: &str,
) -> Result<(), String> {
    sync_active_provider_target_for_key_impl(state, provider)
}

fn on_provider_renamed_impl(state: &AppState, old: &str, new: &str) -> Result<(), String> {
    let Some(mut sw) = load_switchboard_state_from_config_path(&state.config_path) else {
        return Ok(());
    };

    let homes = sw
        .get("cli_homes")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let homes = resolve_cli_homes(homes)?;

    // Update the persisted switchboard state (if it references the renamed provider).
    let mut updated_state = false;
    let state_target = sw
        .get("target")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("");
    let state_provider = sw
        .get("provider")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("");
    if state_target == "provider" && state_provider == old {
        sw["provider"] = json!(new);
        updated_state = true;
    }

    // Persist the state update immediately. A provider rename in the app config can succeed
    // even if syncing the swapped Codex home fails; in that case we still want future
    // key updates to match the renamed provider instead of a stale old name.
    if updated_state {
        write_json(
            &switchboard_state_path_from_config_path(&state.config_path),
            &sw,
        )?;
    }

    // If any swapped Codex homes still point at the old provider id, rewrite them.
    let app_cfg = state.gateway.cfg.read().clone();
    let Some(cfg) = app_cfg.providers.get(new) else {
        return Ok(());
    };
    let base_url = cfg.base_url.trim().to_string();
    if base_url.is_empty() {
        return Err(format!("provider base_url is empty: {new}"));
    }
    let Some(key) = state.secrets.get_provider_key(new) else {
        return Ok(());
    };
    if key.trim().is_empty() {
        return Err(format!("provider key is empty: {new}"));
    }

    for h in &homes {
        let (mode, mp) = home_mode(h)?;
        if mode != "provider" || mp.as_deref() != Some(old) {
            continue;
        }
        let orig_cfg = read_original_cfg_text(h)?;
        let next_cfg = build_direct_provider_cfg(&orig_cfg, new, &base_url);
        let next_auth = auth_with_openai_key(key.trim());
        write_swapped_files(h, &next_auth, &next_cfg)?;
    }

    Ok(())
}

pub fn on_provider_renamed(
    state: &tauri::State<'_, AppState>,
    old: &str,
    new: &str,
) -> Result<(), String> {
    on_provider_renamed_impl(state, old, new)
}

pub fn set_target(
    state: &tauri::State<'_, AppState>,
    cli_homes: Vec<String>,
    target: String,
    provider: Option<String>,
) -> Result<serde_json::Value, String> {
    let homes = resolve_cli_homes(cli_homes)?;
    let target = target.trim().to_ascii_lowercase();

    let app_cfg = state.gateway.cfg.read().clone();
    let app_auth = if target == "official" {
        let auth = read_json(&app_auth_path(state))
            .map_err(|_| "Missing app Codex auth.json. Try logging in first.".to_string())?;
        ensure_signed_in(&auth)?;
        Some(auth)
    } else {
        None
    };

    let provider_name = provider
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let (direct_name, direct_base_url, direct_key) = if target == "provider" {
        let name = provider_name
            .clone()
            .ok_or_else(|| "provider is required for target=provider".to_string())?;
        let cfg = app_cfg
            .providers
            .get(&name)
            .ok_or_else(|| format!("unknown provider: {name}"))?;
        let base_url = cfg.base_url.trim().to_string();
        if base_url.is_empty() {
            return Err(format!("provider base_url is empty: {name}"));
        }
        let key = state
            .secrets
            .get_provider_key(&name)
            .ok_or_else(|| format!("provider key is missing: {name}"))?;
        if key.trim().is_empty() {
            return Err(format!("provider key is empty: {name}"));
        }
        (Some(name), Some(base_url), Some(key))
    } else {
        (None, None, None)
    };

    let mut applied: Vec<PathBuf> = Vec::new();
    for h in &homes {
        let res = match target.as_str() {
            "gateway" => restore_home_original(h),
            "official" => (|| {
                let orig_cfg = read_original_cfg_text(h)?;
                let next_cfg = strip_model_provider_line(&orig_cfg);
                let auth = app_auth.as_ref().ok_or_else(|| {
                    "Missing app Codex auth.json. Try logging in first.".to_string()
                })?;
                write_swapped_files(h, auth, &next_cfg)
            })(),
            "provider" => (|| {
                let name = direct_name
                    .as_deref()
                    .ok_or_else(|| "provider is required for target=provider".to_string())?;
                let base_url = direct_base_url
                    .as_deref()
                    .ok_or_else(|| "provider base_url is missing".to_string())?;
                let key = direct_key
                    .as_deref()
                    .ok_or_else(|| "provider key is missing".to_string())?;
                let orig_cfg = read_original_cfg_text(h)?;
                let next_cfg = build_direct_provider_cfg(&orig_cfg, name, base_url);
                let next_auth = auth_with_openai_key(key.trim());
                write_swapped_files(h, &next_auth, &next_cfg)
            })(),
            _ => Err("target must be one of: gateway | official | provider".to_string()),
        };
        if let Err(e) = res {
            if target != "gateway" {
                for p in applied.iter().rev() {
                    let _ = restore_home_original(p);
                }
            }
            return Err(e);
        }
        applied.push(h.clone());
    }

    save_switchboard_state(state, &homes, &target, provider_name.as_deref())?;

    state.gateway.store.add_event(
        "codex",
        "info",
        "codex.provider_switchboard.updated",
        "Provider switchboard target updated",
        json!({
          "target": target,
          "provider": provider_name,
          "cli_homes": homes.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
          "updated_at_unix_ms": unix_ms()
        }),
    );

    get_status(
        state,
        homes
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_active_provider_target_updates_auth_for_active_provider() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();

        let state = crate::app_state::build_state(config_path.clone(), data_dir).expect("state");

        // Configure a real provider entry and key in the app state.
        {
            let mut cfg = state.gateway.cfg.write();
            cfg.providers.get_mut("provider_1").unwrap().base_url =
                "https://example.com/v1".to_string();
        }
        state
            .secrets
            .set_provider_key("provider_1", "sk-new")
            .expect("set key");

        // Simulate a swapped Codex CLI home already targeting provider_1.
        let cli_home = tmp.path().join("cli-home");
        std::fs::create_dir_all(&cli_home).unwrap();
        std::fs::write(cli_auth_path(&cli_home), r#"{"OPENAI_API_KEY":"sk-old"}"#).unwrap();
        std::fs::write(cli_cfg_path(&cli_home), "model = \"gpt-5.2\"\n").unwrap();

        // Mark as swapped by creating backups.
        let state_dir = swap_state_dir(&cli_home);
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::write(backup_auth_path(&cli_home), r#"{"tokens":{"t":"x"}}"#).unwrap();
        std::fs::write(backup_cfg_path(&cli_home), "model = \"gpt-5.2\"\n").unwrap();

        // Current swapped config: direct provider wiring.
        let current_cfg = build_direct_provider_cfg(
            "model = \"gpt-5.2\"\n",
            "provider_1",
            "https://example.com/v1",
        );
        std::fs::write(cli_cfg_path(&cli_home), current_cfg).unwrap();

        // Persist switchboard state so sync knows where to write.
        let sw_path = switchboard_state_path_from_config_path(&state.config_path);
        std::fs::create_dir_all(sw_path.parent().unwrap()).unwrap();
        std::fs::write(
            sw_path,
            serde_json::to_string_pretty(&json!({
              "target": "provider",
              "provider": "provider_1",
              "cli_homes": [cli_home.to_string_lossy().to_string()]
            }))
            .unwrap(),
        )
        .unwrap();

        sync_active_provider_target_for_key_impl(&state, "provider_1").expect("sync");
        let auth: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(cli_auth_path(&cli_home)).unwrap())
                .unwrap();
        assert_eq!(
            auth.get("OPENAI_API_KEY").and_then(|v| v.as_str()),
            Some("sk-new")
        );
    }

    #[test]
    fn on_provider_renamed_updates_state_and_swapped_cli_config() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();

        let state = crate::app_state::build_state(config_path.clone(), data_dir).expect("state");

        // Prepare app config: the provider is already renamed in the app-side config.
        {
            let mut cfg = state.gateway.cfg.write();
            let p1 = cfg.providers.remove("provider_1").unwrap();
            cfg.providers.insert("provider_x".to_string(), p1);
            cfg.providers.get_mut("provider_x").unwrap().base_url =
                "https://example.com/v1".to_string();
        }
        state
            .secrets
            .set_provider_key("provider_x", "sk-new")
            .expect("set key");

        // Swapped Codex CLI home still points at the old provider id.
        let cli_home = tmp.path().join("cli-home");
        std::fs::create_dir_all(&cli_home).unwrap();
        std::fs::write(cli_auth_path(&cli_home), r#"{"OPENAI_API_KEY":"sk-old"}"#).unwrap();
        std::fs::write(cli_cfg_path(&cli_home), "model = \"gpt-5.2\"\n").unwrap();

        let state_dir = swap_state_dir(&cli_home);
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::write(backup_auth_path(&cli_home), r#"{"tokens":{"t":"x"}}"#).unwrap();
        std::fs::write(backup_cfg_path(&cli_home), "model = \"gpt-5.2\"\n").unwrap();

        let current_cfg = build_direct_provider_cfg(
            "model = \"gpt-5.2\"\n",
            "provider_1",
            "https://example.com/v1",
        );
        std::fs::write(cli_cfg_path(&cli_home), current_cfg).unwrap();

        // Persist switchboard state (still pointing at provider_1).
        let sw_path = switchboard_state_path_from_config_path(&state.config_path);
        std::fs::create_dir_all(sw_path.parent().unwrap()).unwrap();
        std::fs::write(
            &sw_path,
            serde_json::to_string_pretty(&json!({
              "target": "provider",
              "provider": "provider_1",
              "cli_homes": [cli_home.to_string_lossy().to_string()]
            }))
            .unwrap(),
        )
        .unwrap();

        on_provider_renamed_impl(&state, "provider_1", "provider_x").expect("rename hook ok");

        let sw = read_json(&sw_path).expect("sw json");
        assert_eq!(
            sw.get("provider").and_then(|v| v.as_str()),
            Some("provider_x")
        );

        let cfg_txt = read_text(&cli_cfg_path(&cli_home)).expect("cfg");
        assert_eq!(model_provider_id(&cfg_txt).as_deref(), Some("provider_x"));
    }

    #[test]
    fn on_provider_renamed_persists_state_even_if_base_url_is_empty() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();

        let state = crate::app_state::build_state(config_path.clone(), data_dir).expect("state");

        // Provider was renamed, but new provider config is invalid (empty base_url).
        {
            let mut cfg = state.gateway.cfg.write();
            let p1 = cfg.providers.remove("provider_1").unwrap();
            cfg.providers.insert("provider_x".to_string(), p1);
            cfg.providers.get_mut("provider_x").unwrap().base_url = "".to_string();
        }
        state
            .secrets
            .set_provider_key("provider_x", "sk-new")
            .expect("set key");

        let cli_home = tmp.path().join("cli-home");
        std::fs::create_dir_all(&cli_home).unwrap();
        std::fs::write(cli_auth_path(&cli_home), r#"{"OPENAI_API_KEY":"sk-old"}"#).unwrap();
        std::fs::write(cli_cfg_path(&cli_home), "model = \"gpt-5.2\"\n").unwrap();
        let state_dir = swap_state_dir(&cli_home);
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::write(backup_auth_path(&cli_home), r#"{"tokens":{"t":"x"}}"#).unwrap();
        std::fs::write(backup_cfg_path(&cli_home), "model = \"gpt-5.2\"\n").unwrap();

        // Persist switchboard state (still pointing at provider_1).
        let sw_path = switchboard_state_path_from_config_path(&state.config_path);
        std::fs::create_dir_all(sw_path.parent().unwrap()).unwrap();
        std::fs::write(
            &sw_path,
            serde_json::to_string_pretty(&json!({
              "target": "provider",
              "provider": "provider_1",
              "cli_homes": [cli_home.to_string_lossy().to_string()]
            }))
            .unwrap(),
        )
        .unwrap();

        let err = on_provider_renamed_impl(&state, "provider_1", "provider_x").unwrap_err();
        assert!(err.contains("base_url"));

        // Even though we error, the state file should be updated to the new provider name.
        let sw = read_json(&sw_path).expect("sw json");
        assert_eq!(
            sw.get("provider").and_then(|v| v.as_str()),
            Some("provider_x")
        );
    }

    #[test]
    fn on_provider_renamed_persists_state_even_if_key_is_empty() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();

        let state = crate::app_state::build_state(config_path.clone(), data_dir).expect("state");

        // Provider was renamed, but new provider key is invalid (empty string).
        {
            let mut cfg = state.gateway.cfg.write();
            let p1 = cfg.providers.remove("provider_1").unwrap();
            cfg.providers.insert("provider_x".to_string(), p1);
            cfg.providers.get_mut("provider_x").unwrap().base_url =
                "https://example.com/v1".to_string();
        }
        state
            .secrets
            .set_provider_key("provider_x", "")
            .expect("set key");

        let cli_home = tmp.path().join("cli-home");
        std::fs::create_dir_all(&cli_home).unwrap();
        std::fs::write(cli_auth_path(&cli_home), r#"{"OPENAI_API_KEY":"sk-old"}"#).unwrap();
        std::fs::write(cli_cfg_path(&cli_home), "model = \"gpt-5.2\"\n").unwrap();
        let state_dir = swap_state_dir(&cli_home);
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::write(backup_auth_path(&cli_home), r#"{"tokens":{"t":"x"}}"#).unwrap();
        std::fs::write(backup_cfg_path(&cli_home), "model = \"gpt-5.2\"\n").unwrap();

        // Persist switchboard state (still pointing at provider_1).
        let sw_path = switchboard_state_path_from_config_path(&state.config_path);
        std::fs::create_dir_all(sw_path.parent().unwrap()).unwrap();
        std::fs::write(
            &sw_path,
            serde_json::to_string_pretty(&json!({
              "target": "provider",
              "provider": "provider_1",
              "cli_homes": [cli_home.to_string_lossy().to_string()]
            }))
            .unwrap(),
        )
        .unwrap();

        let err = on_provider_renamed_impl(&state, "provider_1", "provider_x").unwrap_err();
        assert!(err.contains("key is empty"));

        // Even though we error, the state file should be updated to the new provider name.
        let sw = read_json(&sw_path).expect("sw json");
        assert_eq!(
            sw.get("provider").and_then(|v| v.as_str()),
            Some("provider_x")
        );
    }

    #[test]
    fn on_provider_renamed_persists_state_even_if_cli_home_sync_fails() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();

        let state = crate::app_state::build_state(config_path.clone(), data_dir).expect("state");

        // Provider was renamed; new config is valid.
        {
            let mut cfg = state.gateway.cfg.write();
            let p1 = cfg.providers.remove("provider_1").unwrap();
            cfg.providers.insert("provider_x".to_string(), p1);
            cfg.providers.get_mut("provider_x").unwrap().base_url =
                "https://example.com/v1".to_string();
        }
        state
            .secrets
            .set_provider_key("provider_x", "sk-new")
            .expect("set key");

        // Create a swapped CLI home that *looks* like it's targeting provider_1, but is missing
        // auth.json so syncing will fail inside the rewrite loop.
        let cli_home = tmp.path().join("cli-home");
        std::fs::create_dir_all(&cli_home).unwrap();
        std::fs::write(
            cli_cfg_path(&cli_home),
            build_direct_provider_cfg("model = \"gpt-5.2\"\n", "provider_1", "https://x.invalid"),
        )
        .unwrap();

        let state_dir = swap_state_dir(&cli_home);
        std::fs::create_dir_all(&state_dir).unwrap();
        // Backups exist so home_mode treats it as swapped.
        std::fs::write(backup_auth_path(&cli_home), r#"{"tokens":{"t":"x"}}"#).unwrap();
        std::fs::write(backup_cfg_path(&cli_home), "model = \"gpt-5.2\"\n").unwrap();

        // Persist switchboard state (still pointing at provider_1).
        let sw_path = switchboard_state_path_from_config_path(&state.config_path);
        std::fs::create_dir_all(sw_path.parent().unwrap()).unwrap();
        std::fs::write(
            &sw_path,
            serde_json::to_string_pretty(&json!({
              "target": "provider",
              "provider": "provider_1",
              "cli_homes": [cli_home.to_string_lossy().to_string()]
            }))
            .unwrap(),
        )
        .unwrap();

        let err = on_provider_renamed_impl(&state, "provider_1", "provider_x").unwrap_err();
        assert!(err.contains("Missing auth.json") || err.contains("Missing auth.json in"));

        // Even though syncing the CLI home failed, the state should still be updated.
        let sw = read_json(&sw_path).expect("sw json");
        assert_eq!(
            sw.get("provider").and_then(|v| v.as_str()),
            Some("provider_x")
        );
    }
}
