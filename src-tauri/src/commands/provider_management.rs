fn clear_observed_session_routes(state: &app_state::AppState) -> usize {
    let mut routes = state.gateway.last_used_by_session.write();
    let cleared = routes.len();
    routes.clear();
    cleared
}

fn clear_observed_session_routes_for_provider(state: &app_state::AppState, provider: &str) -> usize {
    let mut routes = state.gateway.last_used_by_session.write();
    let before = routes.len();
    routes.retain(|_, route| route.provider != provider);
    before.saturating_sub(routes.len())
}

fn rename_observed_session_routes_provider_refs(
    state: &app_state::AppState,
    old_provider: &str,
    new_provider: &str,
) -> usize {
    let mut routes = state.gateway.last_used_by_session.write();
    let mut updated = 0_usize;
    for route in routes.values_mut() {
        let mut changed = false;
        if route.provider == old_provider {
            route.provider = new_provider.to_string();
            changed = true;
        }
        if route.preferred == old_provider {
            route.preferred = new_provider.to_string();
            changed = true;
        }
        if changed {
            updated = updated.saturating_add(1);
        }
    }
    updated
}

fn set_manual_override_impl(
    state: &app_state::AppState,
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
    let prev_override = state.gateway.router.manual_override.read().clone();
    if prev_override == provider {
        return Ok(());
    }
    state.gateway.router.set_manual_override(provider.clone());
    let cleared_assignments = state.gateway.store.delete_all_session_route_assignments();
    let cleared_observed_routes = clear_observed_session_routes(state);
    state.gateway.store.add_event(
        provider.as_deref().unwrap_or("-"),
        "info",
        "routing.manual_override_changed",
        "manual override changed",
        serde_json::json!({
            "previous_manual_override": prev_override,
            "manual_override": provider,
            "cleared_session_route_assignments": cleared_assignments,
            "cleared_observed_session_routes": cleared_observed_routes,
        }),
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn set_manual_override(
    state: tauri::State<'_, app_state::AppState>,
    provider: Option<String>,
) -> Result<(), String> {
    set_manual_override_impl(&state, provider)
}

#[tauri::command]
pub(crate) fn get_config(state: tauri::State<'_, app_state::AppState>) -> serde_json::Value {
    let cfg = state.gateway.cfg.read().clone();
    let pricing = state.secrets.list_provider_pricing();
    let quota_hard_caps = state.secrets.list_provider_quota_hard_cap();
    let now = unix_ms();
    // Never expose keys in UI/API.
    let providers: serde_json::Map<String, serde_json::Value> = cfg
        .providers
        .iter()
        .map(|(name, p)| {
            let key = state.secrets.get_provider_key(name);
            let usage_token = state.secrets.get_usage_token(name);
            let manual_pricing = pricing.get(name).cloned();
            let quota_hard_cap = quota_hard_caps.get(name).copied().unwrap_or_default();
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
                  "group": p.group.clone(),
                  "disabled": p.disabled,
                  "usage_adapter": p.usage_adapter.clone(),
                  "usage_base_url": p.usage_base_url.clone(),
                  "quota_hard_cap": quota_hard_cap,
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

fn set_route_mode_impl(state: &app_state::AppState, mode: &str) -> Result<(), String> {
    let next_mode = crate::orchestrator::config::RouteMode::from_wire(mode)
        .ok_or_else(|| format!("unknown route mode: {mode}"))?;
    let prev_mode = {
        let mut cfg = state.gateway.cfg.write();
        let prev_mode = cfg.routing.route_mode;
        if prev_mode == next_mode {
            return Ok(());
        }
        cfg.routing.route_mode = next_mode;
        prev_mode
    };

    if let Err(err) = persist_config_for_app_state(state) {
        state.gateway.cfg.write().routing.route_mode = prev_mode;
        return Err(err.to_string());
    }

    let cleared_assignments = state.gateway.store.delete_all_session_route_assignments();
    let cleared_observed_routes = clear_observed_session_routes(state);

    state.gateway.store.add_event(
        "gateway",
        "info",
        "config.route_mode_updated",
        "route_mode updated",
        serde_json::json!({
            "route_mode": mode,
            "previous_route_mode": match prev_mode {
                crate::orchestrator::config::RouteMode::FollowPreferredAuto => "follow_preferred_auto",
                crate::orchestrator::config::RouteMode::BalancedAuto => "balanced_auto",
            },
            "cleared_session_route_assignments": cleared_assignments,
            "cleared_observed_session_routes": cleared_observed_routes,
        }),
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn set_route_mode(
    state: tauri::State<'_, app_state::AppState>,
    mode: String,
) -> Result<(), String> {
    set_route_mode_impl(&state, &mode)
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

fn set_session_preferred_provider_impl(
    state: &app_state::AppState,
    session_id: String,
    provider: String,
) -> Result<(), String> {
    // Canonical session identity: Codex session id (from request headers), not WT_SESSION.
    let codex_session_id = session_id.trim().to_string();
    if codex_session_id.is_empty() {
        return Err("codex_session_id is required".to_string());
    }
    if session_is_agent(state, &codex_session_id) {
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
    if let Err(e) = persist_config_for_app_state(state) {
        let mut cfg = state.gateway.cfg.write();
        if let Some(prev) = prev_provider.as_deref() {
            cfg.routing
                .session_preferred_providers
                .insert(codex_session_id.clone(), prev.to_string());
        } else {
            cfg.routing
                .session_preferred_providers
                .remove(&codex_session_id);
        }
        return Err(e.to_string());
    }
    state
        .gateway
        .store
        .delete_session_route_assignment(&codex_session_id);
    state
        .gateway
        .last_used_by_session
        .write()
        .remove(&codex_session_id);
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
pub(crate) fn set_session_preferred_provider(
    state: tauri::State<'_, app_state::AppState>,
    session_id: String,
    provider: String,
) -> Result<(), String> {
    set_session_preferred_provider_impl(&state, session_id, provider)
}

fn clear_session_preferred_provider_impl(
    state: &app_state::AppState,
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
    if let Err(e) = persist_config_for_app_state(state) {
        if let Some(prev) = prev_provider.as_deref() {
            state
                .gateway
                .cfg
                .write()
                .routing
                .session_preferred_providers
                .insert(codex_session_id.clone(), prev.to_string());
        }
        return Err(e.to_string());
    }
    state
        .gateway
        .store
        .delete_session_route_assignment(&codex_session_id);
    state
        .gateway
        .last_used_by_session
        .write()
        .remove(&codex_session_id);
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
pub(crate) fn clear_session_preferred_provider(
    state: tauri::State<'_, app_state::AppState>,
    session_id: String,
) -> Result<(), String> {
    clear_session_preferred_provider_impl(&state, session_id)
}

#[tauri::command]
pub(crate) fn upsert_provider(
    state: tauri::State<'_, app_state::AppState>,
    name: String,
    display_name: String,
    base_url: String,
    group: Option<String>,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("name is required".to_string());
    }
    let normalized_group = group.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    {
        let mut cfg = state.gateway.cfg.write();
        let existing = cfg.providers.get(&name).cloned();
        let is_new = existing.is_none();
        cfg.providers.insert(
            name.clone(),
            crate::orchestrator::config::ProviderConfig {
                display_name,
                base_url,
                group: normalized_group,
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
    if disabled {
        let _ = clear_observed_session_routes_for_provider(&state, &name);
    }
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
pub(crate) fn set_provider_group(
    state: tauri::State<'_, app_state::AppState>,
    name: String,
    group: Option<String>,
) -> Result<(), String> {
    let (changed, normalized_group) = set_provider_group_impl(&state, name.clone(), group)?;
    if !changed {
        return Ok(());
    }
    state.gateway.store.add_event(
        &name,
        "info",
        "config.provider_group_updated",
        "provider group updated",
        serde_json::json!({ "group": normalized_group }),
    );
    Ok(())
}

fn normalize_provider_group(group: Option<String>) -> Option<String> {
    group.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn set_provider_group_impl(
    state: &app_state::AppState,
    name: String,
    group: Option<String>,
) -> Result<(bool, Option<String>), String> {
    let normalized_group = normalize_provider_group(group);
    let previous_group = {
        let mut cfg = state.gateway.cfg.write();
        let provider = cfg
            .providers
            .get_mut(&name)
            .ok_or_else(|| format!("unknown provider: {name}"))?;
        if provider.group == normalized_group {
            return Ok((false, normalized_group));
        }
        let previous = provider.group.clone();
        provider.group = normalized_group.clone();
        previous
    };

    if let Err(error) = persist_config_for_app_state(state) {
        let mut cfg = state.gateway.cfg.write();
        if let Some(provider) = cfg.providers.get_mut(&name) {
            provider.group = previous_group;
        }
        return Err(error.to_string());
    }

    Ok((true, normalized_group))
}

fn set_providers_group_impl(
    state: &app_state::AppState,
    providers: Vec<String>,
    group: Option<String>,
) -> Result<(Vec<String>, Option<String>), String> {
    if providers.is_empty() {
        return Ok((Vec::new(), normalize_provider_group(group)));
    }

    let normalized_group = normalize_provider_group(group);
    let mut deduped_providers: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for provider in providers {
        let name = provider.trim();
        if name.is_empty() {
            continue;
        }
        if seen.insert(name.to_string()) {
            deduped_providers.push(name.to_string());
        }
    }
    if deduped_providers.is_empty() {
        return Ok((Vec::new(), normalized_group));
    }

    {
        let cfg = state.gateway.cfg.read();
        for name in &deduped_providers {
            if !cfg.providers.contains_key(name) {
                return Err(format!("unknown provider: {name}"));
            }
        }
    }

    let mut updated: Vec<String> = Vec::new();
    let mut previous_groups: Vec<(String, Option<String>)> = Vec::new();
    {
        let mut cfg = state.gateway.cfg.write();
        for name in &deduped_providers {
            let provider = cfg
                .providers
                .get_mut(name)
                .ok_or_else(|| format!("unknown provider: {name}"))?;
            if provider.group == normalized_group {
                continue;
            }
            previous_groups.push((name.clone(), provider.group.clone()));
            provider.group = normalized_group.clone();
            updated.push(name.clone());
        }
    }

    if updated.is_empty() {
        return Ok((updated, normalized_group));
    }

    if let Err(error) = persist_config_for_app_state(state) {
        let mut cfg = state.gateway.cfg.write();
        for (name, previous_group) in previous_groups {
            if let Some(provider) = cfg.providers.get_mut(&name) {
                provider.group = previous_group;
            }
        }
        return Err(error.to_string());
    }

    Ok((updated, normalized_group))
}

#[tauri::command]
pub(crate) fn set_providers_group(
    state: tauri::State<'_, app_state::AppState>,
    providers: Vec<String>,
    group: Option<String>,
) -> Result<(), String> {
    let (updated, normalized_group) = set_providers_group_impl(&state, providers, group)?;
    if updated.is_empty() {
        return Ok(());
    }
    state.gateway.store.add_event(
        "gateway",
        "info",
        "config.provider_group_bulk_updated",
        "provider groups updated",
        serde_json::json!({ "group": normalized_group, "providers": updated }),
    );
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
    let _ = state.secrets.clear_provider_quota_hard_cap(&name);
    persist_config(&state).map_err(|e| e.to_string())?;
    let _ = clear_observed_session_routes_for_provider(&state, &name);
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
    let renamed_observed_session_routes =
        rename_observed_session_routes_provider_refs(&state, old, new);
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
        serde_json::json!({
            "renamed_observed_session_routes": renamed_observed_session_routes,
        }),
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
    use super::{
        clear_session_preferred_provider_impl, next_preferred_after_delete, set_manual_override_impl,
        rename_observed_session_routes_provider_refs, set_provider_group_impl, set_route_mode_impl,
        set_providers_group_impl, set_session_preferred_provider_impl,
    };
    use crate::app_state::AppState;
    use crate::constants::GATEWAY_MODEL_PROVIDER_ID;
    use crate::orchestrator::config::AppConfig;
    use crate::orchestrator::gateway::{ClientSessionRuntime, LastUsedRoute};
    use crate::orchestrator::store::unix_ms;

    fn build_test_state() -> (tempfile::TempDir, AppState) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("data");
        let state = crate::app_state::build_state(config_path, data_dir).expect("build state");
        (tmp, state)
    }

    fn seed_non_agent_session(state: &AppState, session_id: &str) {
        let now = unix_ms();
        state.gateway.client_sessions.write().insert(
            session_id.to_string(),
            ClientSessionRuntime {
                codex_session_id: session_id.to_string(),
                pid: 1,
                wt_session: Some("wt-main".to_string()),
                last_request_unix_ms: now,
                last_discovered_unix_ms: now,
                last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
                last_reported_model: None,
                last_reported_base_url: Some("http://127.0.0.1:4000/v1".to_string()),
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: true,
            },
        );
    }

    fn seed_last_used_route(state: &AppState, session_id: &str, provider: &str, preferred: &str) {
        state.gateway.last_used_by_session.write().insert(
            session_id.to_string(),
            LastUsedRoute {
                provider: provider.to_string(),
                reason: "seed".to_string(),
                preferred: preferred.to_string(),
                unix_ms: unix_ms(),
            },
        );
    }

    fn latest_event_by_code(state: &AppState, code: &str) -> serde_json::Value {
        state
            .gateway
            .store
            .list_events(20)
            .into_iter()
            .find(|event| event.get("code").and_then(|v| v.as_str()) == Some(code))
            .expect("event by code")
    }

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

    #[test]
    fn set_manual_override_clears_observed_routes_and_emits_count() {
        let (_tmp, state) = build_test_state();
        seed_last_used_route(&state, "s1", "provider_1", "provider_1");
        state
            .gateway
            .store
            .put_session_route_assignment("s1", "provider_1", unix_ms());

        set_manual_override_impl(&state, Some("provider_2".to_string())).expect("set manual");

        assert!(state.gateway.last_used_by_session.read().is_empty());
        assert!(
            state
                .gateway
                .store
                .get_session_route_assignment("s1")
                .is_none()
        );
        let event = latest_event_by_code(&state, "routing.manual_override_changed");
        assert_eq!(
            event["fields"]["cleared_observed_session_routes"].as_u64(),
            Some(1)
        );
        assert_eq!(
            event["fields"]["cleared_session_route_assignments"].as_u64(),
            Some(1)
        );
    }

    #[test]
    fn set_route_mode_clears_observed_routes_and_emits_count() {
        let (_tmp, state) = build_test_state();
        seed_last_used_route(&state, "s1", "provider_1", "provider_1");
        state
            .gateway
            .store
            .put_session_route_assignment("s1", "provider_1", unix_ms());

        set_route_mode_impl(&state, "balanced_auto").expect("set route mode");

        assert_eq!(
            state.gateway.cfg.read().routing.route_mode,
            crate::orchestrator::config::RouteMode::BalancedAuto
        );
        assert!(state.gateway.last_used_by_session.read().is_empty());
        assert!(
            state
                .gateway
                .store
                .get_session_route_assignment("s1")
                .is_none()
        );
        let event = latest_event_by_code(&state, "config.route_mode_updated");
        assert_eq!(
            event["fields"]["cleared_observed_session_routes"].as_u64(),
            Some(1)
        );
        assert_eq!(
            event["fields"]["cleared_session_route_assignments"].as_u64(),
            Some(1)
        );
    }

    #[test]
    fn set_route_mode_rolls_back_when_persist_fails() {
        let (_tmp, mut state) = build_test_state();
        let bad_path = state
            .config_path
            .parent()
            .expect("config parent")
            .join("persist-fail-dir");
        std::fs::create_dir_all(&bad_path).expect("create bad path");
        state.config_path = bad_path;

        seed_last_used_route(&state, "s1", "provider_1", "provider_1");
        state
            .gateway
            .store
            .put_session_route_assignment("s1", "provider_1", unix_ms());

        let prev_mode = state.gateway.cfg.read().routing.route_mode;
        let result = set_route_mode_impl(&state, "balanced_auto");
        assert!(result.is_err());
        assert_eq!(state.gateway.cfg.read().routing.route_mode, prev_mode);
        assert_eq!(state.gateway.last_used_by_session.read().len(), 1);
        assert!(
            state
                .gateway
                .store
                .get_session_route_assignment("s1")
                .is_some()
        );
    }

    #[test]
    fn set_provider_group_rolls_back_when_persist_fails() {
        let (_tmp, mut state) = build_test_state();
        {
            let mut cfg = state.gateway.cfg.write();
            cfg.providers
                .get_mut("provider_1")
                .expect("provider_1")
                .group = Some("alpha".to_string());
        }
        let bad_path = state
            .config_path
            .parent()
            .expect("config parent")
            .join("persist-fail-dir");
        std::fs::create_dir_all(&bad_path).expect("create bad path");
        state.config_path = bad_path;

        let result = set_provider_group_impl(
            &state,
            "provider_1".to_string(),
            Some("new_group".to_string()),
        );
        assert!(result.is_err());

        let cfg = state.gateway.cfg.read();
        assert_eq!(
            cfg.providers
                .get("provider_1")
                .and_then(|provider| provider.group.as_deref()),
            Some("alpha")
        );
    }

    #[test]
    fn set_provider_group_validates_unknown_provider_before_mutation() {
        let (_tmp, state) = build_test_state();
        let result = set_provider_group_impl(
            &state,
            "missing_provider".to_string(),
            Some("new_group".to_string()),
        );
        assert!(result.is_err());
    }

    #[test]
    fn set_providers_group_validates_all_names_before_mutation() {
        let (_tmp, state) = build_test_state();
        {
            let mut cfg = state.gateway.cfg.write();
            cfg.providers
                .get_mut("provider_1")
                .expect("provider_1")
                .group = Some("existing".to_string());
        }

        let result = set_providers_group_impl(
            &state,
            vec!["provider_1".to_string(), "missing_provider".to_string()],
            Some("new_group".to_string()),
        );
        assert!(result.is_err());

        let cfg = state.gateway.cfg.read();
        assert_eq!(
            cfg.providers
                .get("provider_1")
                .and_then(|provider| provider.group.as_deref()),
            Some("existing")
        );
    }

    #[test]
    fn set_providers_group_rolls_back_when_persist_fails() {
        let (_tmp, mut state) = build_test_state();
        {
            let mut cfg = state.gateway.cfg.write();
            cfg.providers
                .get_mut("provider_1")
                .expect("provider_1")
                .group = Some("alpha".to_string());
            cfg.providers
                .get_mut("provider_2")
                .expect("provider_2")
                .group = Some("beta".to_string());
        }
        let bad_path = state
            .config_path
            .parent()
            .expect("config parent")
            .join("persist-fail-dir");
        std::fs::create_dir_all(&bad_path).expect("create bad path");
        state.config_path = bad_path;

        let result = set_providers_group_impl(
            &state,
            vec!["provider_1".to_string(), "provider_2".to_string()],
            Some("new_group".to_string()),
        );
        assert!(result.is_err());

        let cfg = state.gateway.cfg.read();
        assert_eq!(
            cfg.providers
                .get("provider_1")
                .and_then(|provider| provider.group.as_deref()),
            Some("alpha")
        );
        assert_eq!(
            cfg.providers
                .get("provider_2")
                .and_then(|provider| provider.group.as_deref()),
            Some("beta")
        );
    }

    #[test]
    fn set_session_preferred_provider_clears_only_target_observed_route() {
        let (_tmp, state) = build_test_state();
        seed_non_agent_session(&state, "s1");
        seed_non_agent_session(&state, "s2");
        seed_last_used_route(&state, "s1", "provider_1", "provider_1");
        seed_last_used_route(&state, "s2", "provider_2", "provider_1");
        state
            .gateway
            .store
            .put_session_route_assignment("s1", "provider_1", unix_ms());
        state
            .gateway
            .store
            .put_session_route_assignment("s2", "provider_2", unix_ms());

        set_session_preferred_provider_impl(
            &state,
            "s1".to_string(),
            "provider_2".to_string(),
        )
        .expect("set session preferred");

        let routes = state.gateway.last_used_by_session.read();
        assert!(!routes.contains_key("s1"));
        assert!(routes.contains_key("s2"));
        assert!(
            state
                .gateway
                .cfg
                .read()
                .routing
                .session_preferred_providers
                .contains_key("s1")
        );
        assert!(
            state
                .gateway
                .store
                .get_session_route_assignment("s1")
                .is_none()
        );
        assert!(
            state
                .gateway
                .store
                .get_session_route_assignment("s2")
                .is_some()
        );
    }

    #[test]
    fn clear_session_preferred_provider_clears_only_target_observed_route() {
        let (_tmp, state) = build_test_state();
        state.gateway.cfg.write().routing.session_preferred_providers.insert(
            "s1".to_string(),
            "provider_2".to_string(),
        );
        seed_last_used_route(&state, "s1", "provider_2", "provider_1");
        seed_last_used_route(&state, "s2", "provider_1", "provider_1");
        state
            .gateway
            .store
            .put_session_route_assignment("s1", "provider_2", unix_ms());
        state
            .gateway
            .store
            .put_session_route_assignment("s2", "provider_1", unix_ms());

        clear_session_preferred_provider_impl(&state, "s1".to_string())
            .expect("clear session preferred");

        let routes = state.gateway.last_used_by_session.read();
        assert!(!routes.contains_key("s1"));
        assert!(routes.contains_key("s2"));
        assert!(
            !state
                .gateway
                .cfg
                .read()
                .routing
                .session_preferred_providers
                .contains_key("s1")
        );
        assert!(
            state
                .gateway
                .store
                .get_session_route_assignment("s1")
                .is_none()
        );
        assert!(
            state
                .gateway
                .store
                .get_session_route_assignment("s2")
                .is_some()
        );
    }

    #[test]
    fn set_session_preferred_provider_rolls_back_when_persist_fails() {
        let (_tmp, mut state) = build_test_state();
        seed_non_agent_session(&state, "s1");
        state.gateway.cfg.write().routing.session_preferred_providers.insert(
            "s1".to_string(),
            "provider_1".to_string(),
        );
        seed_last_used_route(&state, "s1", "provider_1", "provider_1");
        state
            .gateway
            .store
            .put_session_route_assignment("s1", "provider_1", unix_ms());
        let bad_path = state
            .config_path
            .parent()
            .expect("config parent")
            .join("persist-fail-dir");
        std::fs::create_dir_all(&bad_path).expect("create bad path");
        state.config_path = bad_path;

        let result =
            set_session_preferred_provider_impl(&state, "s1".to_string(), "provider_2".to_string());
        assert!(result.is_err());
        assert_eq!(
            state
                .gateway
                .cfg
                .read()
                .routing
                .session_preferred_providers
                .get("s1")
                .cloned(),
            Some("provider_1".to_string())
        );
        assert!(
            state
                .gateway
                .store
                .get_session_route_assignment("s1")
                .is_some()
        );
        assert!(state.gateway.last_used_by_session.read().contains_key("s1"));
    }

    #[test]
    fn clear_session_preferred_provider_rolls_back_when_persist_fails() {
        let (_tmp, mut state) = build_test_state();
        state.gateway.cfg.write().routing.session_preferred_providers.insert(
            "s1".to_string(),
            "provider_2".to_string(),
        );
        seed_last_used_route(&state, "s1", "provider_2", "provider_1");
        state
            .gateway
            .store
            .put_session_route_assignment("s1", "provider_2", unix_ms());
        let bad_path = state
            .config_path
            .parent()
            .expect("config parent")
            .join("persist-fail-dir");
        std::fs::create_dir_all(&bad_path).expect("create bad path");
        state.config_path = bad_path;

        let result = clear_session_preferred_provider_impl(&state, "s1".to_string());
        assert!(result.is_err());
        assert_eq!(
            state
                .gateway
                .cfg
                .read()
                .routing
                .session_preferred_providers
                .get("s1")
                .cloned(),
            Some("provider_2".to_string())
        );
        assert!(
            state
                .gateway
                .store
                .get_session_route_assignment("s1")
                .is_some()
        );
        assert!(state.gateway.last_used_by_session.read().contains_key("s1"));
    }

    #[test]
    fn rename_observed_routes_updates_provider_and_preferred_refs() {
        let (_tmp, state) = build_test_state();
        seed_last_used_route(&state, "s1", "provider_1", "provider_1");
        seed_last_used_route(&state, "s2", "provider_2", "provider_1");
        seed_last_used_route(&state, "s3", "provider_2", "provider_2");

        let updated =
            rename_observed_session_routes_provider_refs(&state, "provider_1", "provider_x");
        assert_eq!(updated, 2);

        let routes = state.gateway.last_used_by_session.read();
        assert_eq!(
            routes.get("s1").map(|route| route.provider.as_str()),
            Some("provider_x")
        );
        assert_eq!(
            routes.get("s1").map(|route| route.preferred.as_str()),
            Some("provider_x")
        );
        assert_eq!(
            routes.get("s2").map(|route| route.provider.as_str()),
            Some("provider_2")
        );
        assert_eq!(
            routes.get("s2").map(|route| route.preferred.as_str()),
            Some("provider_x")
        );
        assert_eq!(
            routes.get("s3").map(|route| route.preferred.as_str()),
            Some("provider_2")
        );
    }
}
