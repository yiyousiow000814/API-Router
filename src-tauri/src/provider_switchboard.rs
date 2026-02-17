use crate::app_state::AppState;
use crate::constants::{GATEWAY_MODEL_PROVIDER_ID, GATEWAY_WINDOWS_HOST};
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

fn switchboard_base_dir_from_config_path(config_path: &Path) -> PathBuf {
    app_codex_home_from_config_path(config_path).join("provider-switchboard-base")
}

fn switchboard_base_key(cli_home: &Path) -> String {
    // Must be safe as a single filename component on Windows and Linux.
    // We use a short stable hash to avoid path-separator / drive-prefix edge cases.
    fn fnv1a64(s: &str) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        for b in s.as_bytes() {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        h
    }

    let canon = dedup_key(cli_home);
    format!("cli_home_{:016x}", fnv1a64(&canon))
}

fn switchboard_base_cfg_path_from_config_path(config_path: &Path, cli_home: &Path) -> PathBuf {
    // Keep one base config per Codex dir, so swapping back to gateway doesn't lose
    // user edits made while swapped (without mutating the user's gateway config).
    let key = switchboard_base_key(cli_home);
    switchboard_base_dir_from_config_path(config_path).join(format!("{key}.toml"))
}

fn switchboard_base_meta_path_from_config_path(config_path: &Path, cli_home: &Path) -> PathBuf {
    let key = switchboard_base_key(cli_home);
    switchboard_base_dir_from_config_path(config_path).join(format!("{key}.meta.json"))
}

fn save_switchboard_base_cfg(
    config_path: &Path,
    cli_home: &Path,
    base_cfg_text: &str,
) -> Result<(), String> {
    write_text(
        &switchboard_base_cfg_path_from_config_path(config_path, cli_home),
        base_cfg_text,
    )
}

fn save_switchboard_base_meta(
    config_path: &Path,
    cli_home: &Path,
    gateway_norm_cfg: &str,
) -> Result<(), String> {
    write_json(
        &switchboard_base_meta_path_from_config_path(config_path, cli_home),
        &json!({
          "gateway_norm_cfg": gateway_norm_cfg,
          "updated_at_unix_ms": unix_ms(),
        }),
    )
}

fn load_switchboard_base_cfg(config_path: &Path, cli_home: &Path) -> Option<String> {
    read_text(&switchboard_base_cfg_path_from_config_path(
        config_path,
        cli_home,
    ))
    .ok()
}

fn load_switchboard_base_gateway_norm_cfg(config_path: &Path, cli_home: &Path) -> Option<String> {
    read_json(&switchboard_base_meta_path_from_config_path(
        config_path,
        cli_home,
    ))
    .ok()
    .and_then(|v| {
        v.get("gateway_norm_cfg")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
    })
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

fn app_auth_path_from_config_path(config_path: &Path) -> PathBuf {
    app_codex_home_from_config_path(config_path).join("auth.json")
}

fn app_auth_path(state: &tauri::State<'_, AppState>) -> PathBuf {
    app_auth_path_from_config_path(&state.config_path)
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

fn normalize_cfg_for_switchboard_base(cfg: &str) -> String {
    // Keep user edits, but drop switchboard-owned provider wiring so we can rebuild
    // the next mode from the latest effective config.
    let mut base = strip_model_provider_line(cfg);
    if let Some(active_provider) = model_provider_id(cfg) {
        base = remove_model_provider_sections(&base, &[active_provider.as_str()]);
    }
    // Prevent accumulating blank lines due to repeatedly inserting/removing model_provider.
    // We only trim leading empty lines; comments at the top should remain intact.
    while base.starts_with("\r\n") {
        base = base.trim_start_matches("\r\n").to_string();
    }
    while base.starts_with('\n') {
        base = base.trim_start_matches('\n').to_string();
    }
    base
}

fn read_cfg_base_text(config_path: &Path, cli_home: &Path) -> Result<String, String> {
    ensure_cli_files_exist(cli_home)?;
    let state = home_swap_state(cli_home)?;
    if state == "original" {
        if let Some(base_txt) = load_switchboard_base_cfg(config_path, cli_home) {
            if let Some(baseline_gateway_norm) =
                load_switchboard_base_gateway_norm_cfg(config_path, cli_home)
            {
                let current = read_text(&cli_cfg_path(cli_home))?;
                let current_norm = normalize_cfg_for_switchboard_base(&current);
                if current_norm != baseline_gateway_norm {
                    // The user edited the gateway config after we restored it. Prefer the latest
                    // gateway config and refresh the saved base to match.
                    save_switchboard_base_cfg(config_path, cli_home, &current_norm)?;
                    save_switchboard_base_meta(config_path, cli_home, &current_norm)?;
                    return Ok(current_norm);
                }
            } else {
                // Base exists but meta is missing/corrupted. Prefer the current gateway config so we
                // don't silently override user edits with a potentially stale saved base.
                let current = read_text(&cli_cfg_path(cli_home))?;
                let current_norm = normalize_cfg_for_switchboard_base(&current);
                save_switchboard_base_cfg(config_path, cli_home, &current_norm)?;
                save_switchboard_base_meta(config_path, cli_home, &current_norm)?;
                return Ok(current_norm);
            }
            return Ok(base_txt);
        }
    }
    let current = read_text(&cli_cfg_path(cli_home))?;
    Ok(normalize_cfg_for_switchboard_base(&current))
}

fn switch_to_gateway_home_impl(state: &AppState, cli_home: &Path) -> Result<(), String> {
    let gateway_token = state.secrets.ensure_gateway_token()?;
    if gateway_token.trim().is_empty() {
        return Err("Gateway token is empty. Generate it in Dashboard first.".to_string());
    }

    let base_cfg = read_cfg_base_text(&state.config_path, cli_home)?;
    if let Err(e) = save_switchboard_base_cfg(&state.config_path, cli_home, &base_cfg) {
        state.gateway.store.add_event(
            "codex",
            "error",
            "codex.provider_switchboard.base_save_failed",
            &format!("Provider switchboard base save failed: {e}"),
            json!({
              "cli_home": cli_home.to_string_lossy(),
              "updated_at_unix_ms": unix_ms(),
            }),
        );
    }
    if let Err(e) = save_switchboard_base_meta(&state.config_path, cli_home, &base_cfg) {
        state.gateway.store.add_event(
            "codex",
            "error",
            "codex.provider_switchboard.base_meta_save_failed",
            &format!("Provider switchboard base meta save failed: {e}"),
            json!({
              "cli_home": cli_home.to_string_lossy(),
              "updated_at_unix_ms": unix_ms(),
            }),
        );
    }

    let listen_port = state.gateway.cfg.read().listen.port;
    let wsl_gateway_host =
        crate::platform::wsl_gateway_host::resolve_wsl_gateway_host(Some(&state.config_path));
    let gateway_host = if is_wsl_unc_home(cli_home) {
        wsl_gateway_host.as_str()
    } else {
        GATEWAY_WINDOWS_HOST
    };
    let gateway_base_url = format!("http://{gateway_host}:{listen_port}/v1");
    let next_cfg =
        build_direct_provider_cfg(&base_cfg, GATEWAY_MODEL_PROVIDER_ID, &gateway_base_url);
    let next_auth = auth_with_openai_key(gateway_token.trim());
    write_swapped_files(cli_home, &next_auth, &next_cfg)
}

fn is_wsl_unc_home(cli_home: &Path) -> bool {
    let s = cli_home
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    s.starts_with("\\\\wsl.localhost\\") || s.starts_with("\\\\wsl$\\")
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
    let targets_lower = targets
        .iter()
        .map(|s| s.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let mut out: Vec<String> = Vec::new();
    let mut skipping = false;
    for line in cfg.lines() {
        let t = line.trim();
        let t_lower = t.to_ascii_lowercase();
        let is_section = t.starts_with('[') && t.ends_with(']');
        if is_section {
            if targets.iter().any(|x| x == t) || targets_lower.iter().any(|x| x == &t_lower) {
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

fn insert_provider_section_near_top(base_cfg: &str, provider_section: &str) -> String {
    let eol = if base_cfg.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut lines = base_cfg.lines().map(|s| s.to_string()).collect::<Vec<_>>();

    // Insert before the first section header (e.g. [notice]) so the overall order
    // matches the typical gateway config layout (top-level keys, then model_providers,
    // then the remaining sections).
    let mut insert_at = lines.len();
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim();
        let is_header = t.starts_with('[') && t.ends_with(']');
        if is_header {
            insert_at = i;
            break;
        }
    }

    // Avoid accumulating blank lines around the insertion point across repeated switches.
    while insert_at > 0 && lines[insert_at - 1].trim().is_empty() {
        lines.remove(insert_at - 1);
        insert_at -= 1;
    }
    while insert_at < lines.len() && lines[insert_at].trim().is_empty() {
        lines.remove(insert_at);
    }

    let mut snippet_lines = provider_section
        .lines()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    if !snippet_lines.is_empty() {
        // Ensure a single empty line before and after the snippet.
        if insert_at > 0 {
            lines.insert(insert_at, String::new());
            insert_at += 1;
        }
        for (off, l) in snippet_lines.drain(..).enumerate() {
            lines.insert(insert_at + off, l);
        }
        insert_at += provider_section.lines().count();
        lines.insert(insert_at, String::new());
    }

    lines.join(eol) + eol
}

fn build_direct_provider_cfg(orig_cfg: &str, provider: &str, base_url: &str) -> String {
    // Use the switchboard base shape to avoid accumulating whitespace while switching.
    let mut base = normalize_cfg_for_switchboard_base(orig_cfg);
    base = remove_model_provider_sections(&base, &[GATEWAY_MODEL_PROVIDER_ID, provider]);
    let eol = if base.contains("\r\n") { "\r\n" } else { "\n" };
    let provider_esc = escape_toml(provider);
    let base_url_esc = escape_toml(base_url);
    let provider_section = format!(
        "[model_providers.\"{provider}\"]{eol}name = \"{provider}\"{eol}base_url = \"{base_url}\"{eol}wire_api = \"responses\"{eol}requires_openai_auth = true{eol}",
        provider = provider_esc,
        base_url = base_url_esc,
        eol = eol
    );
    let base_with_section = insert_provider_section_near_top(&base, &provider_section);

    let mut out = String::new();
    out.push_str(&format!("model_provider = \"{}\"{}", provider_esc, eol));
    // Keep model_provider tight to the next line (model = ...), matching the gateway config layout.
    out.push_str(
        base_with_section
            .trim_start_matches(&['\r', '\n'][..])
            .trim_end(),
    );
    out.push_str(eol);
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
    // Avoid TOML parsing so we can still detect model_provider even if the config is currently
    // syntactically invalid (e.g., an unclosed quote elsewhere).
    //
    // We intentionally keep this simple: read the first matching assignment line.
    for line in cfg_txt.lines() {
        let t = line.trim_start();
        // Note: "model_provider_id" starts with "model_provider", so we must check the longer key
        // first (or validate a delimiter).
        let after_key = if let Some(rest) = t.strip_prefix("model_provider_id") {
            rest
        } else if let Some(rest) = t.strip_prefix("model_provider") {
            rest
        } else {
            continue;
        };
        // Ensure the match is a whole key, not a prefix of another identifier.
        let rest = match after_key.chars().next() {
            Some('=') | Some(' ') | Some('\t') => after_key,
            _ => continue,
        };
        let mut rest = rest;
        rest = rest.trim_start();
        if !rest.starts_with('=') {
            continue;
        }
        rest = rest[1..].trim_start();
        if rest.is_empty() {
            continue;
        }
        let rest = rest.trim();
        if let Some(stripped) = rest.strip_prefix('"') {
            let mut out = String::new();
            for c in stripped.chars() {
                if c == '"' {
                    break;
                }
                out.push(c);
            }
            let out = out.trim().to_string();
            if !out.is_empty() {
                return Some(out);
            }
        } else if let Some(stripped) = rest.strip_prefix('\'') {
            let mut out = String::new();
            for c in stripped.chars() {
                if c == '\'' {
                    break;
                }
                out.push(c);
            }
            let out = out.trim().to_string();
            if !out.is_empty() {
                return Some(out);
            }
        } else {
            // Only treat '#' as a comment delimiter for unquoted values.
            let rest = rest.split('#').next().unwrap_or(rest).trim();
            let val = rest
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim_matches(&['"', '\''][..])
                .trim();
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    None
}

fn parse_toml_string_or_bare_value(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if let Some(stripped) = s.strip_prefix('"') {
        let mut out = String::new();
        for c in stripped.chars() {
            if c == '"' {
                break;
            }
            out.push(c);
        }
        let out = out.trim().to_string();
        return (!out.is_empty()).then_some(out);
    }
    if let Some(stripped) = s.strip_prefix('\'') {
        let mut out = String::new();
        for c in stripped.chars() {
            if c == '\'' {
                break;
            }
            out.push(c);
        }
        let out = out.trim().to_string();
        return (!out.is_empty()).then_some(out);
    }
    let v = s.split('#').next().unwrap_or(s).trim();
    (!v.is_empty()).then_some(v.to_string())
}

fn model_provider_section_base_url(cfg_txt: &str, provider_id: &str) -> Option<String> {
    let mut in_target_section = false;
    for line in cfg_txt.lines() {
        let t = line.trim();
        if t.starts_with('[') && t.ends_with(']') {
            in_target_section = false;
            let inner = &t[1..t.len() - 1];
            let Some(rest) = inner.strip_prefix("model_providers.") else {
                continue;
            };
            let key = if let Some(stripped) = rest.strip_prefix('"') {
                stripped.split('"').next().unwrap_or("").trim().to_string()
            } else {
                rest.trim().to_string()
            };
            in_target_section = key == provider_id;
            continue;
        }
        if !in_target_section {
            continue;
        }
        let Some(after_key) = t.strip_prefix("base_url") else {
            continue;
        };
        let mut rest = after_key.trim_start();
        if !rest.starts_with('=') {
            continue;
        }
        rest = rest[1..].trim_start();
        if let Some(v) = parse_toml_string_or_bare_value(rest) {
            return Some(v);
        }
    }
    None
}

fn normalize_base_url_for_compare(s: &str) -> String {
    let mut out = s.trim().to_ascii_lowercase();
    while out.ends_with('/') {
        out.pop();
    }
    out
}

fn provider_name_by_base_url(
    app_cfg: &crate::orchestrator::config::AppConfig,
    base_url: &str,
) -> Option<String> {
    let target = normalize_base_url_for_compare(base_url);
    if target.is_empty() {
        return None;
    }
    let matches = app_cfg
        .providers
        .iter()
        .filter(|(_, cfg)| normalize_base_url_for_compare(&cfg.base_url) == target)
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    if matches.len() == 1 {
        Some(matches[0].clone())
    } else {
        None
    }
}

fn home_mode(cli_home: &Path) -> Result<(String, Option<String>), String> {
    let cfg = read_text(&cli_cfg_path(cli_home))?;
    let provider = model_provider_id(&cfg);
    if let Some(p) = provider.clone() {
        if p.eq_ignore_ascii_case(GATEWAY_MODEL_PROVIDER_ID) {
            return Ok(("gateway".to_string(), None));
        }
        return Ok(("provider".to_string(), Some(p)));
    }
    Ok(("official".to_string(), None))
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
        let cfg_txt = read_text(&cli_cfg_path(h))?;
        let (mode, provider_raw) = home_mode(h)?;
        let provider = if mode == "provider" {
            provider_raw.and_then(|pid| {
                model_provider_section_base_url(&cfg_txt, &pid)
                    .and_then(|u| provider_name_by_base_url(&app_cfg, &u))
                    .or(Some(pid))
            })
        } else {
            None
        };
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
        let orig_cfg = read_cfg_base_text(&state.config_path, h)?;
        let next_cfg = build_direct_provider_cfg(&orig_cfg, provider, &base_url);
        let next_auth = auth_with_openai_key(key.trim());
        write_swapped_files(h, &next_auth, &next_cfg)?;
    }

    Ok(())
}

fn sync_gateway_target_for_rotated_token_impl(state: &AppState) -> Result<Vec<String>, String> {
    let Some(sw) = load_switchboard_state_from_config_path(&state.config_path) else {
        return Ok(Vec::new());
    };
    if sw
        .get("target")
        .and_then(|v| v.as_str())
        .map(|v| !v.eq_ignore_ascii_case("gateway"))
        .unwrap_or(true)
    {
        return Ok(Vec::new());
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

    let gateway_token = state.secrets.ensure_gateway_token()?;
    if gateway_token.trim().is_empty() {
        return Err("gateway token is empty".to_string());
    }
    let next_auth = auth_with_openai_key(gateway_token.trim());
    let mut failed_targets: Vec<String> = Vec::new();

    for h in &homes {
        let mode = match home_mode(h) {
            Ok((mode, _)) => mode,
            Err(e) => {
                failed_targets.push(format!("{} ({e})", h.to_string_lossy()));
                continue;
            }
        };
        if mode != "gateway" {
            continue;
        }
        let auth_path = cli_auth_path(h);
        let current_gateway_token = read_json(&auth_path).ok().and_then(|v| {
            v.get("OPENAI_API_KEY")
                .and_then(|x| x.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
        });
        if current_gateway_token.as_deref() == Some(gateway_token.trim()) {
            continue;
        }
        if let Err(e) = write_json(&auth_path, &next_auth) {
            failed_targets.push(format!(
                "{} (write auth.json failed: {e})",
                h.to_string_lossy()
            ));
        }
    }

    Ok(failed_targets)
}

pub fn sync_active_provider_target_for_key(
    state: &tauri::State<'_, AppState>,
    provider: &str,
) -> Result<(), String> {
    sync_active_provider_target_for_key_impl(state, provider)
}

pub fn sync_gateway_target_for_rotated_token_with_failures(
    state: &tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    sync_gateway_target_for_rotated_token_impl(state)
}

pub(crate) fn sync_gateway_target_for_current_token_on_startup(
    state: &AppState,
) -> Result<Vec<String>, String> {
    sync_gateway_target_for_rotated_token_impl(state)
}

include!("provider_switchboard/actions.rs");
include!("provider_switchboard/tests.rs");
