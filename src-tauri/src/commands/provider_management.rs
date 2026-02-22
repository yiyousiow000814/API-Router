#[tauri::command]
pub(crate) fn set_manual_override(
    state: tauri::State<'_, app_state::AppState>,
    provider: Option<String>,
) -> Result<(), String> {
    if let Some(ref p) = provider {
        let cfg = state.gateway.cfg.read();
        if !cfg.providers.contains_key(p) {
            return Err(format!("unknown provider: {p}"));
        }
        if cfg.providers.get(p).is_some_and(|provider_cfg| provider_cfg.disabled) {
            return Err(format!("provider is deactivated: {p}"));
        }
    }
    state.gateway.router.set_manual_override(provider.clone());
    state.gateway.store.add_event(
        provider.as_deref().unwrap_or("-"),
        "info",
        "routing.manual_override_changed",
        "manual override changed",
        serde_json::Value::Null,
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn get_config(state: tauri::State<'_, app_state::AppState>) -> serde_json::Value {
    let cfg = state.gateway.cfg.read().clone();
    let pricing = state.secrets.list_provider_pricing();
    let now = unix_ms();
    // Never expose keys in UI/API.
    let providers: serde_json::Map<String, serde_json::Value> = cfg
        .providers
        .iter()
        .map(|(name, p)| {
            let key = state.secrets.get_provider_key(name);
            let usage_token = state.secrets.get_usage_token(name);
            let manual_pricing = pricing.get(name).cloned();
            let active_package = active_package_period(manual_pricing.as_ref(), now);
            let active_package_amount = active_package.map(|(amount, _)| amount);
            let active_package_expires = active_package.and_then(|(_, expires)| expires);
            let manual_mode = manual_pricing.as_ref().map(|v| v.mode.clone());
            let manual_amount = manual_pricing.as_ref().and_then(|v| {
                if v.mode == "none" {
                    None
                } else if v.mode == "package_total" {
                    active_package_amount.or(Some(v.amount_usd))
                } else {
                    Some(v.amount_usd)
                }
            });
            let has_key = key.is_some();
            let key_preview = key.as_deref().map(mask_key_preview);
            (
                name.clone(),
                serde_json::json!({
                  "display_name": p.display_name,
                  "base_url": p.base_url,
                  "disabled": p.disabled,
                  "usage_adapter": p.usage_adapter.clone(),
                  "usage_base_url": p.usage_base_url.clone(),
                  "manual_pricing_mode": manual_mode.filter(|m| m != "none"),
                  "manual_pricing_amount_usd": manual_amount,
                  "manual_pricing_expires_at_unix_ms": active_package_expires,
                  "manual_gap_fill_mode": manual_pricing.as_ref().and_then(|v| v.gap_fill_mode.clone()),
                  "manual_gap_fill_amount_usd": manual_pricing.as_ref().and_then(|v| v.gap_fill_amount_usd),
                  "has_key": has_key
                  ,"key_preview": key_preview,
                  "has_usage_token": usage_token.is_some()
                }),
            )
        })
        .collect();

    serde_json::json!({
      "listen": cfg.listen,
      "routing": cfg.routing,
      "providers": providers,
      "provider_order": cfg.provider_order
    })
}

#[tauri::command]
pub(crate) fn get_gateway_token_preview(state: tauri::State<'_, app_state::AppState>) -> String {
    let tok = state.secrets.get_gateway_token().unwrap_or_default();
    mask_key_preview(&tok)
}

#[tauri::command]
pub(crate) fn get_gateway_token(state: tauri::State<'_, app_state::AppState>) -> String {
    state.secrets.get_gateway_token().unwrap_or_default()
}

#[tauri::command]
pub(crate) fn rotate_gateway_token(
    state: tauri::State<'_, app_state::AppState>,
) -> Result<serde_json::Value, String> {
    let token = state.secrets.rotate_gateway_token()?;
    let (failed_targets, sync_hard_failed) =
        match crate::provider_switchboard::sync_gateway_target_for_rotated_token_with_failures(
            &state,
        ) {
            Ok(v) => (v, false),
            Err(e) => {
                state.gateway.store.add_event(
                    "gateway",
                    "error",
                    "codex.provider_switchboard.gateway_token_sync_failed",
                    &format!(
                        "Gateway token rotated, but failed to sync active gateway targets: {e}"
                    ),
                    serde_json::Value::Null,
                );
                (vec![format!("sync state error: {e}")], true)
            }
        };
    if !sync_hard_failed && !failed_targets.is_empty() {
        state.gateway.store.add_event(
            "gateway",
            "error",
            "codex.provider_switchboard.gateway_token_sync_failed",
            "Gateway token rotated, but failed to sync some gateway targets.",
            serde_json::json!({ "failed_targets": failed_targets }),
        );
    }
    Ok(serde_json::json!({
      "token": token,
      "failed_targets": failed_targets
    }))
}

#[tauri::command]
pub(crate) fn set_preferred_provider(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    {
        let mut cfg = state.gateway.cfg.write();
        if !cfg.providers.contains_key(&provider) {
            return Err(format!("unknown provider: {provider}"));
        }
        if cfg.providers.get(&provider).is_some_and(|p| p.disabled) {
            return Err(format!("provider is deactivated: {provider}"));
        }
        cfg.routing.preferred_provider = provider.clone();
    }
    persist_config(&state).map_err(|e| e.to_string())?;
    state.gateway.store.add_event(
        &provider,
        "info",
        "config.preferred_provider_updated",
        "preferred_provider updated",
        serde_json::Value::Null,
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn set_route_mode(
    state: tauri::State<'_, app_state::AppState>,
    mode: String,
) -> Result<(), String> {
    let next_mode = crate::orchestrator::config::RouteMode::from_wire(&mode)
        .ok_or_else(|| format!("unknown route mode: {mode}"))?;
    {
        let mut cfg = state.gateway.cfg.write();
        cfg.routing.route_mode = next_mode;
    }
    persist_config(&state).map_err(|e| e.to_string())?;
    state.gateway.store.add_event(
        "gateway",
        "info",
        "config.route_mode_updated",
        "route_mode updated",
        serde_json::json!({ "route_mode": mode }),
    );
    Ok(())
}

fn session_is_agent(state: &app_state::AppState, codex_session_id: &str) -> bool {
    if state
        .gateway
        .client_sessions
        .read()
        .get(codex_session_id)
        .is_some_and(|s| s.is_agent)
    {
        return true;
    }
    // Agent rows are pruned from runtime sessions when idle, so fall back to rollout discovery.
    let gateway_token = state.secrets.get_gateway_token().unwrap_or_default();
    let expected = (!gateway_token.is_empty()).then_some(gateway_token.as_str());
    let port = state.gateway.cfg.read().listen.port;
    crate::platform::windows_terminal::discover_sessions_using_router(port, expected)
        .into_iter()
        .any(|s| s.is_agent && s.codex_session_id.as_deref() == Some(codex_session_id))
}

#[tauri::command]
pub(crate) fn set_session_preferred_provider(
    state: tauri::State<'_, app_state::AppState>,
    session_id: String,
    provider: String,
) -> Result<(), String> {
    // Canonical session identity: Codex session id (from request headers), not WT_SESSION.
    let codex_session_id = session_id.trim().to_string();
    if codex_session_id.is_empty() {
        return Err("codex_session_id is required".to_string());
    }
    if session_is_agent(&state, &codex_session_id) {
        return Err("agent sessions cannot set preferred provider".to_string());
    }
    let prev_provider: Option<String> = {
        let mut cfg = state.gateway.cfg.write();
        if !cfg.providers.contains_key(&provider) {
            return Err(format!("unknown provider: {provider}"));
        }
        if cfg.providers.get(&provider).is_some_and(|p| p.disabled) {
            return Err(format!("provider is deactivated: {provider}"));
        }
        let prev = cfg
            .routing
            .session_preferred_providers
            .get(&codex_session_id)
            .cloned();
        // No-op: avoid emitting confusing events when the user selects the same provider again.
        if prev.as_deref() == Some(provider.as_str()) {
            return Ok(());
        }
        cfg.routing
            .session_preferred_providers
            .insert(codex_session_id.clone(), provider.clone());
        prev
    };
    persist_config(&state).map_err(|e| e.to_string())?;
    let msg = match prev_provider.as_deref() {
        Some(prev) => format!("session preferred_provider updated: {prev} -> {provider}"),
        None => format!("session preferred_provider set: {provider}"),
    };
    state.gateway.store.add_event(
        &provider,
        "info",
        "config.session_preferred_provider_updated",
        &msg,
        serde_json::json!({
            "codex_session_id": codex_session_id,
            "provider": provider,
            "prev_provider": prev_provider,
        }),
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn clear_session_preferred_provider(
    state: tauri::State<'_, app_state::AppState>,
    session_id: String,
) -> Result<(), String> {
    let codex_session_id = session_id.trim().to_string();
    if codex_session_id.is_empty() {
        return Err("codex_session_id is required".to_string());
    }
    let prev_provider: Option<String> = {
        let mut cfg = state.gateway.cfg.write();
        cfg.routing
            .session_preferred_providers
            .remove(&codex_session_id)
    };
    // No-op: don't write config or emit events if nothing was set.
    if prev_provider.is_none() {
        return Ok(());
    }
    persist_config(&state).map_err(|e| e.to_string())?;
    state.gateway.store.add_event(
        "gateway",
        "info",
        "config.session_preferred_provider_cleared",
        &format!(
            "session preferred_provider cleared (was {})",
            prev_provider.as_deref().unwrap_or("unknown")
        ),
        serde_json::json!({
            "codex_session_id": codex_session_id,
            "prev_provider": prev_provider,
        }),
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn upsert_provider(
    state: tauri::State<'_, app_state::AppState>,
    name: String,
    display_name: String,
    base_url: String,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("name is required".to_string());
    }
    {
        let mut cfg = state.gateway.cfg.write();
        let existing = cfg.providers.get(&name).cloned();
        let is_new = existing.is_none();
        cfg.providers.insert(
            name.clone(),
            crate::orchestrator::config::ProviderConfig {
                display_name,
                base_url,
                disabled: existing.as_ref().is_some_and(|provider| provider.disabled),
                usage_adapter: existing
                    .as_ref()
                    .map(|provider| provider.usage_adapter.clone())
                    .unwrap_or_default(),
                usage_base_url: existing
                    .as_ref()
                    .and_then(|provider| provider.usage_base_url.clone()),
                api_key: existing
                    .as_ref()
                    .map(|provider| provider.api_key.clone())
                    .unwrap_or_default(),
            },
        );
        if is_new {
            cfg.provider_order.push(name.clone());
        }
        app_state::normalize_provider_order(&mut cfg);
    }
    persist_config(&state).map_err(|e| e.to_string())?;
    state.gateway.store.add_event(
        &name,
        "info",
        "config.provider_upserted",
        "provider upserted",
        serde_json::Value::Null,
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn set_provider_disabled(
    state: tauri::State<'_, app_state::AppState>,
    name: String,
    disabled: bool,
) -> Result<(), String> {
    let mut switched_preferred = false;
    {
        let mut cfg = state.gateway.cfg.write();
        let current_disabled = match cfg.providers.get(&name) {
            Some(provider) => provider.disabled,
            None => return Err(format!("unknown provider: {name}")),
        };
        if current_disabled == disabled {
            return Ok(());
        }

        if disabled && cfg.providers.values().filter(|p| !p.disabled).count() <= 1 {
            return Err("cannot deactivate the last active provider".to_string());
        }

        if let Some(provider) = cfg.providers.get_mut(&name) {
            provider.disabled = disabled;
        }

        if disabled {
            cfg.routing
                .session_preferred_providers
                .retain(|_, pref| pref != &name);

            if cfg.routing.preferred_provider == name {
                let fallback = cfg
                    .provider_order
                    .iter()
                    .find(|provider_name| {
                        cfg.providers
                            .get(*provider_name)
                            .is_some_and(|provider| !provider.disabled)
                    })
                    .cloned()
                    .or_else(|| {
                        cfg.providers
                            .iter()
                            .find_map(|(provider_name, provider)| {
                                if provider.disabled {
                                    None
                                } else {
                                    Some(provider_name.clone())
                                }
                            })
                    });
                if let Some(provider) = fallback {
                    cfg.routing.preferred_provider = provider;
                    switched_preferred = true;
                }
            }
        }

        app_state::normalize_provider_order(&mut cfg);
    }

    if disabled {
        let mut manual = state.gateway.router.manual_override.write();
        if manual.as_deref() == Some(name.as_str()) {
            *manual = None;
        }
    }

    persist_config(&state).map_err(|e| e.to_string())?;
    state.gateway.store.add_event(
        &name,
        "info",
        if disabled {
            "config.provider_deactivated"
        } else {
            "config.provider_activated"
        },
        if disabled {
            "provider deactivated"
        } else {
            "provider activated"
        },
        serde_json::Value::Null,
    );
    if switched_preferred {
        state.gateway.store.add_event(
            "gateway",
            "info",
            "config.preferred_provider_updated",
            "preferred_provider updated (deactivated old preferred)",
            serde_json::Value::Null,
        );
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn delete_provider(
    state: tauri::State<'_, app_state::AppState>,
    name: String,
) -> Result<(), String> {
    let next_preferred: Option<String> = {
        let mut cfg = state.gateway.cfg.write();
        if !cfg.providers.contains_key(&name) {
            return Err(format!("unknown provider: {name}"));
        }
        if cfg.providers.len() == 1 {
            return Err("cannot delete the last provider".to_string());
        }

        let preferred_after_delete = next_preferred_after_delete(&cfg, &name)?;

        cfg.providers.remove(&name);
        cfg.provider_order.retain(|p| p != &name);
        cfg.routing
            .session_preferred_providers
            .retain(|_, pref| pref != &name);
        app_state::normalize_provider_order(&mut cfg);

        let next_preferred = preferred_after_delete.clone();
        if let Some(p) = preferred_after_delete {
            cfg.routing.preferred_provider = p;
        }
        next_preferred
    };

    // If the deleted provider was manually locked, return to auto.
    {
        let mut mo = state.gateway.router.manual_override.write();
        if mo.as_deref() == Some(&name) {
            *mo = None;
        }
    }
    let _ = state.secrets.clear_provider_key(&name);
    let _ = state.secrets.clear_provider_pricing(&name);
    persist_config(&state).map_err(|e| e.to_string())?;
    state.gateway.store.add_event(
        &name,
        "info",
        "config.provider_deleted",
        "provider deleted",
        serde_json::Value::Null,
    );
    if let Some(p) = next_preferred {
        state.gateway.store.add_event(
            &p,
            "info",
            "config.preferred_provider_updated",
            "preferred_provider updated (deleted old preferred)",
            serde_json::Value::Null,
        );
    }
    Ok(())
}

fn next_preferred_after_delete(
    cfg: &crate::orchestrator::config::AppConfig,
    deleting_provider: &str,
) -> Result<Option<String>, String> {
    let remaining_active = cfg
        .providers
        .iter()
        .filter(|(name, provider_cfg)| name.as_str() != deleting_provider && !provider_cfg.disabled)
        .count();
    if remaining_active == 0 {
        return Err("cannot delete the last active provider".to_string());
    }
    if cfg.routing.preferred_provider != deleting_provider {
        return Ok(None);
    }

    let next = cfg
        .provider_order
        .iter()
        .find_map(|provider_name| {
            if provider_name == deleting_provider {
                return None;
            }
            cfg.providers
                .get(provider_name)
                .is_some_and(|provider_cfg| !provider_cfg.disabled)
                .then(|| provider_name.clone())
        })
        .or_else(|| {
            cfg.providers.iter().find_map(|(provider_name, provider_cfg)| {
                (provider_name.as_str() != deleting_provider && !provider_cfg.disabled)
                    .then(|| provider_name.clone())
            })
        });

    debug_assert!(
        next.is_some(),
        "remaining_active > 0 implies there must be a next preferred provider"
    );
    Ok(next)
}

#[tauri::command]
pub(crate) fn rename_provider(
    state: tauri::State<'_, app_state::AppState>,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    let old = old_name.trim();
    let new = new_name.trim();
    if old.is_empty() || new.is_empty() {
        return Err("name is required".to_string());
    }
    if old == new {
        return Ok(());
    }

    {
        let mut cfg = state.gateway.cfg.write();
        if !cfg.providers.contains_key(old) {
            return Err(format!("unknown provider: {old}"));
        }
        if cfg.providers.contains_key(new) {
            return Err(format!("provider already exists: {new}"));
        }
        if !app_state::migrate_provider_name(&mut cfg, old, new) {
            return Err("rename failed".to_string());
        }
        if let Some(p) = cfg.providers.get_mut(new) {
            p.display_name = new.to_string();
        }
        if cfg.routing.preferred_provider == old {
            cfg.routing.preferred_provider = new.to_string();
        }
        for (_session, pref) in cfg.routing.session_preferred_providers.iter_mut() {
            if pref == old {
                *pref = new.to_string();
            }
        }
        for entry in cfg.provider_order.iter_mut() {
            if entry == old {
                *entry = new.to_string();
            }
        }
        app_state::normalize_provider_order(&mut cfg);
    }

    {
        let mut mo = state.gateway.router.manual_override.write();
        if mo.as_deref() == Some(old) {
            *mo = Some(new.to_string());
        }
    }

    state.gateway.store.rename_provider(old, new);
    state.secrets.rename_provider(old, new)?;
    persist_config(&state).map_err(|e| e.to_string())?;
    state
        .gateway
        .router
        .sync_with_config(&state.gateway.cfg.read(), unix_ms());

    if let Err(e) = crate::provider_switchboard::on_provider_renamed(&state, old, new) {
        state.gateway.store.add_event(
            new,
            "error",
            "codex.provider_switchboard.rename_sync_failed",
            &format!("provider rename sync to active switchboard target failed: {e}"),
            serde_json::json!({
                "old": old,
                "new": new,
            }),
        );
    }
    state.gateway.store.add_event(
        new,
        "info",
        "config.provider_renamed",
        "provider renamed",
        serde_json::Value::Null,
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn set_provider_key(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    key: String,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    state.secrets.set_provider_key(&provider, &key)?;
    if let Err(e) =
        crate::provider_switchboard::sync_active_provider_target_for_key(&state, &provider)
    {
        state.gateway.store.add_event(
            &provider,
            "error",
            "codex.provider_switchboard.sync_failed",
            &format!("provider key sync to active switchboard target failed: {e}"),
            serde_json::json!({
                "provider": provider,
            }),
        );
    }
    state.gateway.store.add_event(
        &provider,
        "info",
        "config.provider_key_updated",
        "provider key updated (stored in user-data/secrets.json)",
        serde_json::Value::Null,
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn set_provider_order(
    state: tauri::State<'_, app_state::AppState>,
    order: Vec<String>,
) -> Result<(), String> {
    {
        let mut cfg = state.gateway.cfg.write();
        cfg.provider_order = order;
        app_state::normalize_provider_order(&mut cfg);
    }
    persist_config(&state).map_err(|e| e.to_string())?;
    state.gateway.store.add_event(
        "-",
        "info",
        "config.provider_order_updated",
        "provider order updated",
        serde_json::Value::Null,
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn get_provider_key(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<Option<String>, String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    Ok(state.secrets.get_provider_key(&provider))
}

#[tauri::command]
pub(crate) fn clear_provider_key(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    state.secrets.clear_provider_key(&provider)?;
    state.gateway.store.add_event(
        &provider,
        "info",
        "config.provider_key_cleared",
        "provider key cleared (user-data/secrets.json)",
        serde_json::Value::Null,
    );
    Ok(())
}

#[cfg(test)]
mod provider_management_tests {
    use super::next_preferred_after_delete;
    use crate::orchestrator::config::AppConfig;

    #[test]
    fn delete_provider_rejects_removing_last_active_provider() {
        let mut cfg = AppConfig::default_config();
        cfg.routing.preferred_provider = "provider_1".to_string();
        cfg.providers
            .get_mut("official")
            .expect("official exists")
            .disabled = true;
        cfg.providers
            .get_mut("provider_2")
            .expect("provider_2 exists")
            .disabled = true;

        let result = next_preferred_after_delete(&cfg, "provider_1");
        assert_eq!(
            result,
            Err("cannot delete the last active provider".to_string())
        );
    }

    #[test]
    fn delete_preferred_selects_next_active_provider_only() {
        let mut cfg = AppConfig::default_config();
        cfg.routing.preferred_provider = "provider_1".to_string();
        cfg.providers
            .get_mut("official")
            .expect("official exists")
            .disabled = true;

        let result = next_preferred_after_delete(&cfg, "provider_1");
        assert_eq!(result, Ok(Some("provider_2".to_string())));
    }
}
