#[tauri::command]
fn get_gateway_token_preview(state: tauri::State<'_, app_state::AppState>) -> String {
    let tok = state.secrets.get_gateway_token().unwrap_or_default();
    mask_key_preview(&tok)
}

#[tauri::command]
fn get_gateway_token(state: tauri::State<'_, app_state::AppState>) -> String {
    state.secrets.get_gateway_token().unwrap_or_default()
}

#[tauri::command]
fn rotate_gateway_token(state: tauri::State<'_, app_state::AppState>) -> Result<String, String> {
    state.secrets.rotate_gateway_token()
}

#[tauri::command]
fn set_preferred_provider(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    {
        let mut cfg = state.gateway.cfg.write();
        if !cfg.providers.contains_key(&provider) {
            return Err(format!("unknown provider: {provider}"));
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
fn set_session_preferred_provider(
    state: tauri::State<'_, app_state::AppState>,
    session_id: String,
    provider: String,
) -> Result<(), String> {
    // Canonical session identity: Codex session id (from request headers), not WT_SESSION.
    let codex_session_id = session_id.trim().to_string();
    if codex_session_id.is_empty() {
        return Err("codex_session_id is required".to_string());
    }
    let prev_provider: Option<String> = {
        let mut cfg = state.gateway.cfg.write();
        if !cfg.providers.contains_key(&provider) {
            return Err(format!("unknown provider: {provider}"));
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
fn clear_session_preferred_provider(
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
fn upsert_provider(
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
        let is_new = !cfg.providers.contains_key(&name);
        cfg.providers.insert(
            name.clone(),
            crate::orchestrator::config::ProviderConfig {
                display_name,
                base_url,
                usage_adapter: String::new(),
                usage_base_url: None,
                api_key: String::new(),
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
fn delete_provider(
    state: tauri::State<'_, app_state::AppState>,
    name: String,
) -> Result<(), String> {
    let mut next_preferred: Option<String> = None;
    {
        let mut cfg = state.gateway.cfg.write();
        cfg.providers.remove(&name);
        cfg.provider_order.retain(|p| p != &name);
        cfg.routing
            .session_preferred_providers
            .retain(|_, pref| pref != &name);
        app_state::normalize_provider_order(&mut cfg);

        if cfg.providers.is_empty() {
            return Err("cannot delete the last provider".to_string());
        }

        if cfg.routing.preferred_provider == name {
            next_preferred = cfg.providers.keys().next().cloned();
            if let Some(p) = next_preferred.clone() {
                cfg.routing.preferred_provider = p;
            }
        }
    }

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

#[tauri::command]
fn rename_provider(
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
fn set_provider_key(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    key: String,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    state.secrets.set_provider_key(&provider, &key)?;
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
fn set_provider_order(
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
fn get_provider_key(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<Option<String>, String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    Ok(state.secrets.get_provider_key(&provider))
}

#[tauri::command]
fn clear_provider_key(
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

#[tauri::command]
async fn refresh_quota(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let snap =
        crate::orchestrator::quota::refresh_quota_for_provider(&state.gateway, &provider).await;
    if snap.last_error.is_empty() && snap.updated_at_unix_ms > 0 {
        state.gateway.store.add_event(
            &provider,
            "info",
            "usage.refresh_succeeded",
            "Usage refresh succeeded",
            serde_json::Value::Null,
        );
    } else {
        // Avoid double-logging: quota.rs already records an error event when refresh fails.
        let err = if snap.last_error.is_empty() {
            "usage refresh failed".to_string()
        } else {
            snap.last_error.chars().take(300).collect::<String>()
        };
        return Err(err);
    }
    Ok(())
}

#[tauri::command]
async fn refresh_quota_shared(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    let group = crate::orchestrator::quota::refresh_quota_shared(&state.gateway, &provider).await?;
    let n = group.len();
    // Keep the message short (events list is meant to be scannable).
    state.gateway.store.add_event(
        "gateway",
        "info",
        "usage.refresh_succeeded",
        &format!("Usage refresh succeeded (shared): {n} providers updated"),
        serde_json::json!({ "providers": n }),
    );
    Ok(())
}

#[tauri::command]
async fn refresh_quota_all(state: tauri::State<'_, app_state::AppState>) -> Result<(), String> {
    let (ok, err, failed) =
        crate::orchestrator::quota::refresh_quota_all_with_summary(&state.gateway).await;
    if err == 0 {
        state.gateway.store.add_event(
            "gateway",
            "info",
            "usage.refresh_succeeded",
            &format!("Usage refresh succeeded: {ok} providers"),
            serde_json::json!({ "providers": ok }),
        );
    } else {
        let shown = failed
            .iter()
            .take(3)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        let suffix = if failed.len() > 3 { ", ..." } else { "" };
        state.gateway.store.add_event(
            "gateway",
            "error",
            "usage.refresh_partial",
            &format!("usage refresh partial: ok={ok} err={err} (failed: {shown}{suffix})"),
            serde_json::json!({ "ok": ok, "err": err, "failed": failed }),
        );
    }
    Ok(())
}

#[tauri::command]
fn set_usage_token(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    token: String,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    state.secrets.set_usage_token(&provider, &token)?;
    state.gateway.store.add_event(
        &provider,
        "info",
        "config.usage_token_updated",
        "usage token updated (user-data/secrets.json)",
        serde_json::Value::Null,
    );
    Ok(())
}

#[tauri::command]
fn clear_usage_token(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    state.secrets.clear_usage_token(&provider)?;
    state.gateway.store.add_event(
        &provider,
        "info",
        "config.usage_token_cleared",
        "usage token cleared (user-data/secrets.json)",
        serde_json::Value::Null,
    );
    Ok(())
}

#[tauri::command]
fn set_usage_base_url(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    url: String,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let u = url.trim().trim_end_matches('/').to_string();
    if u.is_empty() {
        return Err("url is required".to_string());
    }
    if reqwest::Url::parse(&u).is_err() {
        return Err("invalid url".to_string());
    }
    {
        let mut cfg = state.gateway.cfg.write();
        if let Some(p) = cfg.providers.get_mut(&provider) {
            p.usage_base_url = Some(u);
        }
    }
    persist_config(&state).map_err(|e| e.to_string())?;
    state.gateway.store.add_event(
        &provider,
        "info",
        "config.usage_base_url_updated",
        "usage base url updated",
        serde_json::Value::Null,
    );
    Ok(())
}

#[tauri::command]
fn clear_usage_base_url(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    {
        let mut cfg = state.gateway.cfg.write();
        if let Some(p) = cfg.providers.get_mut(&provider) {
            p.usage_base_url = None;
        }
    }
    persist_config(&state).map_err(|e| e.to_string())?;
    state.gateway.store.add_event(
        &provider,
        "info",
        "config.usage_base_url_cleared",
        "usage base url cleared",
        serde_json::Value::Null,
    );
    Ok(())
}

#[tauri::command]
fn set_provider_manual_pricing(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    mode: String,
    amount_usd: Option<f64>,
    package_expires_at_unix_ms: Option<u64>,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let mode = mode.trim().to_lowercase();
    let api_key_ref = provider_api_key_ref(&state, &provider);
    match mode.as_str() {
        "none" => {
            state.secrets.set_provider_pricing(
                &provider,
                "none",
                0.0,
                None,
                Some(api_key_ref.clone()),
            )?;
            state.gateway.store.add_event(
                &provider,
                "info",
                "config.provider_pricing_cleared",
                "provider manual pricing cleared",
                serde_json::Value::Null,
            );
            Ok(())
        }
        "per_request" | "package_total" => {
            let Some(v) = amount_usd else {
                return Err("amount_usd is required".to_string());
            };
            if !v.is_finite() || v <= 0.0 {
                return Err("amount_usd must be > 0".to_string());
            }
            let expires = if mode == "package_total" {
                if let Some(ts) = package_expires_at_unix_ms {
                    if ts <= unix_ms() {
                        return Err("package_expires_at_unix_ms must be in the future".to_string());
                    }
                    Some(ts)
                } else {
                    None
                }
            } else {
                None
            };
            state.secrets.set_provider_pricing(
                &provider,
                &mode,
                v,
                expires,
                Some(api_key_ref.clone()),
            )?;
            state.gateway.store.add_event(
                &provider,
                "info",
                "config.provider_pricing_updated",
                "provider manual pricing updated",
                serde_json::json!({
                    "mode": mode,
                    "amount_usd": v,
                    "package_expires_at_unix_ms": expires,
                }),
            );
            Ok(())
        }
        _ => Err("mode must be one of: none, per_request, package_total".to_string()),
    }
}

#[tauri::command]
fn set_provider_gap_fill(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    mode: String,
    amount_usd: Option<f64>,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let mode = mode.trim().to_lowercase();
    match mode.as_str() {
        "none" => {
            state.secrets.set_provider_gap_fill(&provider, None, None)?;
            state.gateway.store.add_event(
                &provider,
                "info",
                "config.provider_gap_fill_cleared",
                "provider gap-fill pricing cleared",
                serde_json::Value::Null,
            );
            Ok(())
        }
        "per_request" | "total" | "per_day_average" => {
            let Some(v) = amount_usd else {
                return Err("amount_usd is required".to_string());
            };
            if !v.is_finite() || v <= 0.0 {
                return Err("amount_usd must be > 0".to_string());
            }
            state
                .secrets
                .set_provider_gap_fill(&provider, Some(&mode), Some(v))?;
            state.gateway.store.add_event(
                &provider,
                "info",
                "config.provider_gap_fill_updated",
                "provider gap-fill pricing updated",
                serde_json::json!({
                    "mode": mode,
                    "amount_usd": v,
                }),
            );
            Ok(())
        }
        _ => Err("mode must be one of: none, per_request, total, per_day_average".to_string()),
    }
}

#[tauri::command]
async fn get_effective_usage_base(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<Option<String>, String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    Ok(crate::orchestrator::quota::effective_usage_base(&state.gateway, &provider).await)
}

#[tauri::command]
async fn probe_provider(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    let cfg = state.gateway.cfg.read().clone();
    let Some(p) = cfg.providers.get(&provider) else {
        return Err(format!("unknown provider: {provider}"));
    };
    let now = unix_ms();
    state.gateway.router.sync_with_config(&cfg, now);
    let key = state.secrets.get_provider_key(&provider);

    let (status, _payload) = state
        .gateway
        .upstream
        .get_json(
            p,
            "/v1/models",
            key.as_deref(),
            None,
            cfg.routing.request_timeout_seconds,
        )
        .await
        .map_err(|e| {
            state
                .gateway
                .router
                .mark_failure(&provider, &cfg, &format!("request error: {e}"), now);
            state.gateway.store.add_event(
                &provider,
                "error",
                "health.probe_failed",
                "health probe failed (request error)",
                serde_json::Value::Null,
            );
            format!("request error: {e}")
        })?;

    if (200..300).contains(&status) {
        state.gateway.router.mark_success(&provider, now);
        state.gateway.store.add_event(
            &provider,
            "info",
            "health.probe_ok",
            "health probe ok",
            serde_json::Value::Null,
        );
        return Ok(());
    }

    let err = format!("http {status}");
    state
        .gateway
        .router
        .mark_failure(&provider, &cfg, &err, now);
    state.gateway.store.add_event(
        &provider,
        "error",
        "health.probe_failed",
        "health probe failed",
        serde_json::Value::Null,
    );
    Err(err)
}

