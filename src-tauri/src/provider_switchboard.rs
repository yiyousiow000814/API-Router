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

fn app_codex_home(state: &tauri::State<'_, AppState>) -> PathBuf {
    state
        .config_path
        .parent()
        .unwrap_or(Path::new("."))
        .join("codex-home")
}

fn app_auth_path(state: &tauri::State<'_, AppState>) -> PathBuf {
    app_codex_home(state).join("auth.json")
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

    // Preserve user config edits made while swapped before restoring gateway mode.
    let cur_cfg_text = read_text(&cli_cfg)?;
    let normalized_cfg = normalize_cfg_for_switchboard_base(&cur_cfg_text);
    write_text(&backup_cfg_path(cli_home), &normalized_cfg)
        .map_err(|e| format!("sync config backup failed: {e}"))?;
    let bak_cfg = normalized_cfg.into_bytes();

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

fn normalize_cfg_for_switchboard_base(cfg: &str) -> String {
    // Keep user edits, but drop switchboard-owned provider wiring so we can rebuild
    // the next mode from the latest effective config.
    let mut base = strip_model_provider_line(cfg);
    if let Some(active_provider) = model_provider_id(cfg) {
        base = remove_model_provider_sections(&base, &[active_provider.as_str()]);
    }
    base
}

fn read_cfg_base_text(cli_home: &Path) -> Result<String, String> {
    ensure_cli_files_exist(cli_home)?;
    let current = read_text(&cli_cfg_path(cli_home))?;
    Ok(normalize_cfg_for_switchboard_base(&current))
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
                let orig_cfg = read_cfg_base_text(h)?;
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
                let orig_cfg = read_cfg_base_text(h)?;
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
