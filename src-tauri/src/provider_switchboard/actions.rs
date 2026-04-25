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
    let supports_websockets = cfg.supports_websockets;
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
        let orig_cfg = read_cfg_base_text(&state.config_path, h)?;
        let storage_mode = state.secrets.get_provider_key_storage_mode(new);
        let use_config_storage = provider_key_storage_uses_config(&storage_mode);
        let next_cfg = build_direct_provider_cfg(
            &orig_cfg,
            new,
            &base_url,
            supports_websockets,
            use_config_storage.then_some(key.trim()),
        );
        let next_auth = if use_config_storage {
            auth_without_openai_key()
        } else {
            auth_with_openai_key(key.trim())
        };
        write_swapped_files(&state.config_path, h, &next_auth, &next_cfg)?;
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
    let runtime = ProviderSwitchboardRuntime::from_app_state(state);
    set_target_for_runtime(&runtime, cli_homes, target, provider)
}

pub fn set_target_for_runtime(
    runtime: &ProviderSwitchboardRuntime<'_>,
    cli_homes: Vec<String>,
    target: String,
    provider: Option<String>,
) -> Result<serde_json::Value, String> {
    set_target_for_runtime_with_official_auth(runtime, cli_homes, target, provider, None)
}

pub fn set_target_for_runtime_with_official_auth(
    runtime: &ProviderSwitchboardRuntime<'_>,
    cli_homes: Vec<String>,
    target: String,
    provider: Option<String>,
    official_auth_override: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let homes = resolve_cli_homes(cli_homes)?;
    let target = target.trim().to_ascii_lowercase();

    let app_cfg = runtime.gateway.cfg.read().clone();
    let app_auth = if target == "official" {
        let auth = if let Some(auth) = official_auth_override {
            ensure_signed_in(&auth)?;
            auth
        } else {
            let auth = resolve_selected_official_auth_from_secrets(runtime.secrets)?;
            crate::commands::write_selected_official_account_to_app(
                runtime.config_path,
                runtime.secrets,
            )?;
            auth
        };
        Some(auth)
    } else {
        None
    };

    let provider_name = provider
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let (direct_name, direct_base_url, direct_supports_websockets, direct_key) =
        if target == "provider" {
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
        let key = runtime
            .secrets
            .get_provider_key(&name)
            .ok_or_else(|| format!("provider key is missing: {name}"))?;
        if key.trim().is_empty() {
            return Err(format!("provider key is empty: {name}"));
        }
        (Some(name), Some(base_url), Some(cfg.supports_websockets), Some(key))
    } else {
        (None, None, None, None)
    };

    let mut applied: Vec<PathBuf> = Vec::new();
    for h in &homes {
        let res = match target.as_str() {
            "gateway" => switch_to_gateway_home_impl(runtime, h),
            "official" => (|| {
                let orig_cfg = read_cfg_base_text(runtime.config_path, h)?;
                let next_cfg = strip_model_provider_line(&orig_cfg);
                let auth = app_auth.as_ref().ok_or_else(|| {
                    "Missing app Codex auth.json. Try logging in first.".to_string()
                })?;
                write_swapped_files(runtime.config_path, h, auth, &next_cfg)
            })(),
            "provider" => (|| {
                let name = direct_name
                    .as_deref()
                    .ok_or_else(|| "provider is required for target=provider".to_string())?;
                let base_url = direct_base_url
                    .as_deref()
                    .ok_or_else(|| "provider base_url is missing".to_string())?;
                let supports_websockets = direct_supports_websockets
                    .ok_or_else(|| "provider websocket capability is missing".to_string())?;
                let key = direct_key
                    .as_deref()
                    .ok_or_else(|| "provider key is missing".to_string())?;
                let orig_cfg = read_cfg_base_text(runtime.config_path, h)?;
                let storage_mode = runtime.secrets.get_provider_key_storage_mode(name);
                let use_config_storage = provider_key_storage_uses_config(&storage_mode);
                let next_cfg = build_direct_provider_cfg(
                    &orig_cfg,
                    name,
                    base_url,
                    supports_websockets,
                    use_config_storage.then_some(key.trim()),
                );
                let next_auth = if use_config_storage {
                    auth_without_openai_key()
                } else {
                    auth_with_openai_key(key.trim())
                };
                write_swapped_files(runtime.config_path, h, &next_auth, &next_cfg)
            })(),
            _ => Err("target must be one of: gateway | official | provider".to_string()),
        };
        if let Err(e) = res {
            if target != "gateway" {
                for p in applied.iter().rev() {
                    let _ = restore_home_original(runtime.config_path, p);
                }
            }
            return Err(e);
        }
        applied.push(h.clone());
    }

    // State persistence should not turn a successful home rewrite into an error.
    // If we can't persist the state (disk full / permission issues), the switch still
    // took effect; we log an event so the user can troubleshoot, and future key-sync
    // may not work until state can be saved.
    if let Err(e) =
        save_switchboard_state_to_config_path(runtime.config_path, &homes, &target, provider_name.as_deref())
    {
        runtime.gateway.store.events().emit(
            "codex",
            crate::orchestrator::store::EventCode::CODEX_PROVIDER_SWITCHBOARD_STATE_SAVE_FAILED,
            &format!("Provider switchboard state save failed: {e}"),
            json!({
              "target": target,
              "provider": provider_name,
              "cli_homes": homes.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
              "updated_at_unix_ms": unix_ms()
            }),
        );
    }

    runtime.gateway.store.events().emit(
        "codex",
        crate::orchestrator::store::EventCode::CODEX_PROVIDER_SWITCHBOARD_UPDATED,
        "Provider switchboard target updated",
        json!({
          "target": target,
          "provider": provider_name,
          "cli_homes": homes.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
          "updated_at_unix_ms": unix_ms()
        }),
    );

    get_status_for_gateway(
        runtime.gateway,
        homes
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect(),
    )
}

#[cfg(test)]
pub(crate) fn resolve_selected_official_auth(
    state: &AppState,
) -> Result<serde_json::Value, String> {
    resolve_selected_official_auth_from_secrets(&state.secrets)
}

fn resolve_selected_official_auth_from_secrets(
    secrets: &crate::orchestrator::secrets::SecretStore,
) -> Result<serde_json::Value, String> {
    let auth = secrets
        .active_official_account_profile_auth_json()
        .ok_or_else(|| "Missing selected official Codex auth profile. Try logging in first.".to_string())?;
    ensure_signed_in(&auth)?;
    Ok(auth)
}
