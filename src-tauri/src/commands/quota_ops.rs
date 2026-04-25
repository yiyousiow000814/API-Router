use serde::{Deserialize, Serialize};
const USAGE_REFRESH_SUMMARY_WINDOW_MS: u64 = 30 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct UsageAuthPayload {
    pub token: String,
    pub username: String,
    pub password: String,
}

#[derive(Clone, Copy, Debug, Default)]
struct UsageRefreshSummaryWindow {
    window_start_ms: u64,
    first_success_at_ms: u64,
    last_success_at_ms: u64,
    success_count: u64,
    providers: usize,
    consecutive_failures: u64,
}

fn usage_refresh_window_state() -> &'static std::sync::Mutex<UsageRefreshSummaryWindow> {
    static STATE: std::sync::OnceLock<std::sync::Mutex<UsageRefreshSummaryWindow>> =
        std::sync::OnceLock::new();
    STATE.get_or_init(|| std::sync::Mutex::new(UsageRefreshSummaryWindow::default()))
}

fn usage_refresh_on_success(
    now_ms: u64,
    providers: usize,
) -> (Option<UsageRefreshSummaryWindow>, Option<u64>) {
    let lock = usage_refresh_window_state();
    let Ok(mut st) = lock.lock() else {
        return (None, None);
    };

    let mut summary_to_emit: Option<UsageRefreshSummaryWindow> = None;
    let recovered_failures = if st.consecutive_failures > 0 {
        let n = st.consecutive_failures;
        st.consecutive_failures = 0;
        Some(n)
    } else {
        None
    };

    if st.window_start_ms > 0
        && st.success_count > 0
        && now_ms.saturating_sub(st.window_start_ms) >= USAGE_REFRESH_SUMMARY_WINDOW_MS
    {
        summary_to_emit = Some(*st);
        st.window_start_ms = now_ms;
        st.first_success_at_ms = now_ms;
        st.last_success_at_ms = now_ms;
        st.success_count = 0;
        st.providers = providers;
    } else if st.window_start_ms == 0 {
        st.window_start_ms = now_ms;
        st.first_success_at_ms = now_ms;
        st.last_success_at_ms = now_ms;
        st.providers = providers;
    }

    st.success_count = st.success_count.saturating_add(1);
    if st.first_success_at_ms == 0 {
        st.first_success_at_ms = now_ms;
    }
    st.last_success_at_ms = now_ms;
    st.providers = providers;

    (summary_to_emit, recovered_failures)
}

fn usage_refresh_on_failure() {
    let lock = usage_refresh_window_state();
    if let Ok(mut st) = lock.lock() {
        st.consecutive_failures = st.consecutive_failures.saturating_add(1);
    }
}

#[tauri::command]
pub(crate) async fn refresh_quota(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    if let Some(owner) = crate::orchestrator::quota::shared_quota_owner_for_provider(
        &state.gateway,
        &state.lan_sync,
        &provider,
    ) {
        if !owner.local_is_owner {
            let cfg = state.gateway.cfg.read().clone();
            let fingerprint = crate::orchestrator::quota::shared_provider_fingerprint(
                &cfg,
                &state.gateway.secrets,
                &provider,
            )
            .ok_or_else(|| "shared quota fingerprint unavailable".to_string())?;
            state.lan_sync.request_remote_quota_refresh(
                &state.gateway,
                &owner.owner_node_id,
                &fingerprint,
            )?;
            state.gateway.store.events().emit(
                &provider,
                crate::orchestrator::store::EventCode::USAGE_REFRESH_FORWARDED,
                &format!("Usage refresh forwarded to {}", owner.owner_node_name),
                serde_json::json!({
                    "owner_node_id": owner.owner_node_id,
                    "owner_node_name": owner.owner_node_name,
                }),
            );
            return Ok(());
        }
    }
    crate::orchestrator::quota::clear_usage_refresh_gate_for_provider(&state.gateway, &provider);
    let snap = crate::orchestrator::quota::refresh_quota_for_provider(&state.gateway, &provider).await;
    if snap.last_error.is_empty() && snap.updated_at_unix_ms > 0 {
        state.gateway.store.events().emit(
            &provider,
            crate::orchestrator::store::EventCode::USAGE_REFRESH_SUCCEEDED,
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
pub(crate) async fn refresh_quota_shared(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    let group =
        crate::orchestrator::quota::refresh_quota_shared(&state.gateway, &state.lan_sync, &provider)
            .await?;
    let n = group.len();
    // Keep the message short (events list is meant to be scannable).
    state.gateway.store.events().emit(
        "gateway",
        crate::orchestrator::store::EventCode::USAGE_REFRESH_SUCCEEDED,
        &format!("Usage refresh succeeded (shared): {n} providers updated"),
        serde_json::json!({ "providers": n }),
    );
    Ok(())
}

#[tauri::command]
pub(crate) async fn refresh_quota_all(
    state: tauri::State<'_, app_state::AppState>,
) -> Result<(), String> {
    let (ok, err, failed) =
        crate::orchestrator::quota::refresh_quota_all_with_summary(&state.gateway, &state.lan_sync)
            .await;
    let now_ms = crate::orchestrator::store::unix_ms();
    if err == 0 {
        let (summary_to_emit, recovered_failures) = usage_refresh_on_success(now_ms, ok);
        if let Some(prev) = summary_to_emit {
            state.gateway.store.events().emit(
                "gateway",
                crate::orchestrator::store::EventCode::USAGE_REFRESH_SUCCEEDED_SUMMARY,
                &format!(
                    "Usage refresh succeeded: {} runs, {} providers, 30m window",
                    prev.success_count, prev.providers
                ),
                serde_json::json!({
                    "runs": prev.success_count,
                    "providers": prev.providers,
                    "window_ms": USAGE_REFRESH_SUMMARY_WINDOW_MS,
                    "first_success_at_unix_ms": prev.first_success_at_ms,
                    "last_success_at_unix_ms": prev.last_success_at_ms
                }),
            );
        }
        if let Some(failed_count) = recovered_failures {
            state.gateway.store.events().emit(
                "gateway",
                crate::orchestrator::store::EventCode::USAGE_REFRESH_RECOVERED,
                &format!("Usage refresh recovered after {failed_count} failures"),
                serde_json::json!({ "failed_runs": failed_count, "providers": ok }),
            );
        }
    } else {
        usage_refresh_on_failure();
        let shown = failed
            .iter()
            .take(3)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        let suffix = if failed.len() > 3 { ", ..." } else { "" };
        state.gateway.store.events().emit(
            "gateway",
            crate::orchestrator::store::EventCode::USAGE_REFRESH_PARTIAL,
            &format!("usage refresh partial: ok={ok} err={err} (failed: {shown}{suffix})"),
            serde_json::json!({ "ok": ok, "err": err, "failed": failed }),
        );
    }
    Ok(())
}

fn ensure_usage_settings_editable(
    state: &app_state::AppState,
    provider: &str,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    ensure_local_provider_definitions_editable(state)
}

fn set_usage_token_impl(
    state: &app_state::AppState,
    provider: &str,
    token: &str,
) -> Result<(), String> {
    ensure_usage_settings_editable(state, provider)?;
    state.secrets.set_usage_token(provider, token)?;
    if let Err(err) = crate::lan_sync::record_provider_definition_patch(
        state,
        provider,
        serde_json::json!({ "usage_token": token }),
    ) {
        state.gateway.store.events().emit(
            provider,
            crate::orchestrator::store::EventCode::LAN_EDIT_SYNC_RECORD_FAILED,
            &format!("failed to record usage token update for LAN sync: {err}"),
            serde_json::Value::Null,
        );
    }
    state.gateway.store.events().emit(
        provider,
        crate::orchestrator::store::EventCode::CONFIG_USAGE_TOKEN_UPDATED,
        "usage token updated (user-data/secrets.json)",
        serde_json::Value::Null,
    );
    Ok(())
}

fn clear_usage_token_impl(state: &app_state::AppState, provider: &str) -> Result<(), String> {
    ensure_usage_settings_editable(state, provider)?;
    state.secrets.clear_usage_token(provider)?;
    if let Err(err) = crate::lan_sync::record_provider_definition_patch(
        state,
        provider,
        serde_json::json!({ "usage_token": serde_json::Value::Null }),
    ) {
        state.gateway.store.events().emit(
            provider,
            crate::orchestrator::store::EventCode::LAN_EDIT_SYNC_RECORD_FAILED,
            &format!("failed to record usage token clear for LAN sync: {err}"),
            serde_json::Value::Null,
        );
    }
    state.gateway.store.events().emit(
        provider,
        crate::orchestrator::store::EventCode::CONFIG_USAGE_TOKEN_CLEARED,
        "usage token cleared (user-data/secrets.json)",
        serde_json::Value::Null,
    );
    Ok(())
}

fn set_usage_auth_impl(
    state: &app_state::AppState,
    provider: &str,
    token: &str,
    username: &str,
    password: &str,
) -> Result<(), String> {
    ensure_usage_settings_editable(state, provider)?;
    let normalized_token = token.trim().to_string();
    let normalized_username = username.trim().to_string();
    if normalized_token.is_empty() {
        state.secrets.clear_usage_token(provider)?;
    } else {
        state.secrets.set_usage_token(provider, &normalized_token)?;
    }
    if normalized_username.is_empty() || password.is_empty() {
        state.secrets.clear_usage_login(provider)?;
    } else {
        state
            .secrets
            .set_usage_login(provider, &normalized_username, password)?;
    }
    if let Err(err) = crate::lan_sync::record_provider_definition_patch(
        state,
        provider,
        serde_json::json!({
            "usage_token": if normalized_token.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(normalized_token.clone()) },
            "usage_login_username": if normalized_username.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(normalized_username.clone()) },
            "usage_login_password": if normalized_username.is_empty() || password.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(password.to_string()) },
        }),
    ) {
        state.gateway.store.events().emit(
            provider,
            crate::orchestrator::store::EventCode::LAN_EDIT_SYNC_RECORD_FAILED,
            &format!("failed to record usage auth update for LAN sync: {err}"),
            serde_json::Value::Null,
        );
    }
    state.gateway.store.events().emit(
        provider,
        crate::orchestrator::store::EventCode::CONFIG_USAGE_AUTH_UPDATED,
        "usage auth updated (user-data/secrets.json)",
        serde_json::json!({
            "has_token": !normalized_token.is_empty(),
            "has_login": !normalized_username.is_empty() && !password.is_empty(),
        }),
    );
    Ok(())
}

fn clear_usage_auth_impl(state: &app_state::AppState, provider: &str) -> Result<(), String> {
    ensure_usage_settings_editable(state, provider)?;
    state.secrets.clear_usage_token(provider)?;
    state.secrets.clear_usage_login(provider)?;
    if let Err(err) = crate::lan_sync::record_provider_definition_patch(
        state,
        provider,
        serde_json::json!({
            "usage_token": serde_json::Value::Null,
            "usage_login_username": serde_json::Value::Null,
            "usage_login_password": serde_json::Value::Null,
        }),
    ) {
        state.gateway.store.events().emit(
            provider,
            crate::orchestrator::store::EventCode::LAN_EDIT_SYNC_RECORD_FAILED,
            &format!("failed to record usage auth clear for LAN sync: {err}"),
            serde_json::Value::Null,
        );
    }
    state.gateway.store.events().emit(
        provider,
        crate::orchestrator::store::EventCode::CONFIG_USAGE_AUTH_CLEARED,
        "usage auth cleared (user-data/secrets.json)",
        serde_json::Value::Null,
    );
    Ok(())
}

fn set_usage_base_url_impl(
    state: &app_state::AppState,
    provider: &str,
    url: &str,
) -> Result<(), String> {
    ensure_usage_settings_editable(state, provider)?;
    let provider_base_url = state
        .gateway
        .cfg
        .read()
        .providers
        .get(provider)
        .map(|provider| provider.base_url.clone())
        .ok_or_else(|| format!("unknown provider: {provider}"))?;
    let parsed = url.trim().trim_end_matches('/').to_string();
    let usage_base_url = crate::orchestrator::quota::normalize_usage_base_url(&provider_base_url, &parsed)
        .unwrap_or(parsed);
    if usage_base_url.is_empty() {
        return Err("url is required".to_string());
    }
    if reqwest::Url::parse(&usage_base_url).is_err() {
        return Err("invalid url".to_string());
    }
    {
        let mut cfg = state.gateway.cfg.write();
        if let Some(p) = cfg.providers.get_mut(provider) {
            p.usage_base_url = Some(usage_base_url.clone());
        }
    }
    persist_config_for_app_state(state).map_err(|e| e.to_string())?;
    if let Err(err) = crate::lan_sync::record_provider_definition_patch(
        state,
        provider,
        serde_json::json!({ "usage_base_url": usage_base_url.clone() }),
    ) {
        state.gateway.store.events().emit(
            provider,
            crate::orchestrator::store::EventCode::LAN_EDIT_SYNC_RECORD_FAILED,
            &format!("failed to record usage base url update for LAN sync: {err}"),
            serde_json::Value::Null,
        );
    }
    state.gateway.store.events().emit(
        provider,
        crate::orchestrator::store::EventCode::CONFIG_USAGE_BASE_URL_UPDATED,
        "usage base url updated",
        serde_json::Value::Null,
    );
    Ok(())
}

fn clear_usage_base_url_impl(state: &app_state::AppState, provider: &str) -> Result<(), String> {
    ensure_usage_settings_editable(state, provider)?;
    {
        let mut cfg = state.gateway.cfg.write();
        if let Some(p) = cfg.providers.get_mut(provider) {
            p.usage_base_url = None;
        }
    }
    persist_config_for_app_state(state).map_err(|e| e.to_string())?;
    crate::orchestrator::quota::clear_quota_snapshot(&state.gateway, provider);
    if let Err(err) = crate::lan_sync::record_provider_definition_patch(
        state,
        provider,
        serde_json::json!({ "usage_base_url": serde_json::Value::Null }),
    ) {
        state.gateway.store.events().emit(
            provider,
            crate::orchestrator::store::EventCode::LAN_EDIT_SYNC_RECORD_FAILED,
            &format!("failed to record usage base url clear for LAN sync: {err}"),
            serde_json::Value::Null,
        );
    }
    state.gateway.store.events().emit(
        provider,
        crate::orchestrator::store::EventCode::CONFIG_USAGE_BASE_URL_CLEARED,
        "usage base url cleared",
        serde_json::Value::Null,
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn set_usage_token(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    token: String,
) -> Result<(), String> {
    set_usage_token_impl(&state, &provider, &token)
}

#[tauri::command]
pub(crate) fn clear_usage_token(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    clear_usage_token_impl(&state, &provider)
}

#[tauri::command]
pub(crate) fn get_usage_auth(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<UsageAuthPayload, String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let token = state.secrets.get_usage_token(&provider).unwrap_or_default();
    let login = state.secrets.get_usage_login(&provider);
    Ok(UsageAuthPayload {
        token,
        username: login
            .as_ref()
            .map(|entry| entry.username.clone())
            .unwrap_or_default(),
        password: login.map(|entry| entry.password).unwrap_or_default(),
    })
}

#[tauri::command]
pub(crate) fn set_usage_auth(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    token: String,
    username: String,
    password: String,
) -> Result<(), String> {
    set_usage_auth_impl(&state, &provider, &token, &username, &password)
}

#[tauri::command]
pub(crate) fn clear_usage_auth(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    clear_usage_auth_impl(&state, &provider)
}

#[tauri::command]
pub(crate) fn set_usage_base_url(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    url: String,
) -> Result<(), String> {
    set_usage_base_url_impl(&state, &provider, &url)
}

#[tauri::command]
pub(crate) fn clear_usage_base_url(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    clear_usage_base_url_impl(&state, &provider)
}

#[tauri::command]
pub(crate) fn set_usage_proxy_pool(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    proxies: Vec<String>,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    state.secrets.set_usage_proxy_pool(&provider, proxies.clone())?;
    state.gateway.store.events().emit(
        &provider,
        crate::orchestrator::store::EventCode::CONFIG_USAGE_PROXY_POOL_UPDATED,
        "usage proxy pool updated",
        serde_json::json!({ "count": proxies.len() }),
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn set_provider_quota_hard_cap(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    daily: bool,
    weekly: bool,
    monthly: bool,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let hard_cap = crate::orchestrator::secrets::ProviderQuotaHardCapConfig {
        daily,
        weekly,
        monthly,
    };
    state
        .secrets
        .set_provider_quota_hard_cap(&provider, hard_cap)?;
    crate::orchestrator::gateway::clear_web_codex_provider_switchboard_cache();
    state.gateway.store.events().emit(
        &provider,
        crate::orchestrator::store::EventCode::CONFIG_PROVIDER_QUOTA_HARD_CAP_UPDATED,
        "provider quota hard cap updated",
        serde_json::json!({
            "daily": daily,
            "weekly": weekly,
            "monthly": monthly,
        }),
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn set_provider_quota_hard_cap_field(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    field: String,
    enabled: bool,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let normalized_field = field.trim().to_ascii_lowercase();
    let hard_cap = state
        .secrets
        .set_provider_quota_hard_cap_field(&provider, normalized_field.as_str(), enabled)?;
    crate::orchestrator::gateway::clear_web_codex_provider_switchboard_cache();
    state.gateway.store.events().emit(
        &provider,
        crate::orchestrator::store::EventCode::CONFIG_PROVIDER_QUOTA_HARD_CAP_UPDATED,
        "provider quota hard cap updated",
        serde_json::json!({
            "field": normalized_field,
            "enabled": enabled,
            "daily": hard_cap.daily,
            "weekly": hard_cap.weekly,
            "monthly": hard_cap.monthly,
        }),
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn set_provider_manual_pricing(
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
            state
                .gateway
                .store
                .sync_provider_pricing_configs(&state.secrets.list_provider_pricing());
            if let Err(err) = crate::lan_sync::record_provider_pricing_snapshot(&state, &provider) {
                state.gateway.store.events().emit(
                    &provider,
                    crate::orchestrator::store::EventCode::LAN_EDIT_SYNC_RECORD_FAILED,
                    &format!("failed to record pricing clear for LAN sync: {err}"),
                    serde_json::Value::Null,
                );
            }
            state.gateway.store.events().emit(
                &provider,
                crate::orchestrator::store::EventCode::CONFIG_PROVIDER_PRICING_CLEARED,
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
            state
                .gateway
                .store
                .sync_provider_pricing_configs(&state.secrets.list_provider_pricing());
            if let Err(err) = crate::lan_sync::record_provider_pricing_snapshot(&state, &provider) {
                state.gateway.store.events().emit(
                    &provider,
                    crate::orchestrator::store::EventCode::LAN_EDIT_SYNC_RECORD_FAILED,
                    &format!("failed to record pricing update for LAN sync: {err}"),
                    serde_json::Value::Null,
                );
            }
            state.gateway.store.events().emit(
                &provider,
                crate::orchestrator::store::EventCode::CONFIG_PROVIDER_PRICING_UPDATED,
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
pub(crate) fn set_provider_gap_fill(
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
            state
                .gateway
                .store
                .sync_provider_pricing_configs(&state.secrets.list_provider_pricing());
            if let Err(err) = crate::lan_sync::record_provider_pricing_snapshot(&state, &provider) {
                state.gateway.store.events().emit(
                    &provider,
                    crate::orchestrator::store::EventCode::LAN_EDIT_SYNC_RECORD_FAILED,
                    &format!("failed to record gap-fill clear for LAN sync: {err}"),
                    serde_json::Value::Null,
                );
            }
            state.gateway.store.events().emit(
                &provider,
                crate::orchestrator::store::EventCode::CONFIG_PROVIDER_GAP_FILL_CLEARED,
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
            state
                .gateway
                .store
                .sync_provider_pricing_configs(&state.secrets.list_provider_pricing());
            if let Err(err) = crate::lan_sync::record_provider_pricing_snapshot(&state, &provider) {
                state.gateway.store.events().emit(
                    &provider,
                    crate::orchestrator::store::EventCode::LAN_EDIT_SYNC_RECORD_FAILED,
                    &format!("failed to record gap-fill update for LAN sync: {err}"),
                    serde_json::Value::Null,
                );
            }
            state.gateway.store.events().emit(
                &provider,
                crate::orchestrator::store::EventCode::CONFIG_PROVIDER_GAP_FILL_UPDATED,
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
pub(crate) async fn get_effective_usage_base(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<Option<String>, String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    Ok(crate::orchestrator::quota::effective_usage_base(&state.gateway, &provider).await)
}

#[tauri::command]
pub(crate) async fn probe_provider(
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
            state.gateway.store.events().emit(
                &provider,
                crate::orchestrator::store::EventCode::HEALTH_PROBE_FAILED,
                "health probe failed (request error)",
                serde_json::Value::Null,
            );
            format!("request error: {e}")
        })?;

    if (200..300).contains(&status) {
        state.gateway.router.mark_success(&provider, now);
        state.gateway.store.events().emit(
            &provider,
            crate::orchestrator::store::EventCode::HEALTH_PROBE_OK,
            "Provider is reachable and responding",
            serde_json::Value::Null,
        );
        return Ok(());
    }

    let err = format!("http {status}");
    state
        .gateway
        .router
        .mark_failure(&provider, &cfg, &err, now);
    state.gateway.store.events().emit(
        &provider,
        crate::orchestrator::store::EventCode::HEALTH_PROBE_FAILED,
        "health probe failed",
        serde_json::Value::Null,
    );
    Err(err)
}

#[cfg(test)]
mod quota_ops_tests {
    use super::{set_usage_auth_impl, set_usage_base_url_impl, set_usage_token_impl};
    use crate::app_state::AppState;

    fn build_test_state() -> (tempfile::TempDir, AppState) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("data");
        let state = crate::app_state::build_state(config_path, data_dir).expect("build state");
        (tmp, state)
    }

    #[test]
    fn usage_secret_mutations_are_blocked_while_following_remote() {
        let (_tmp, state) = build_test_state();
        state
            .secrets
            .set_followed_config_source_node_id(Some("node-remote"))
            .expect("set followed source");

        let token_result = set_usage_token_impl(&state, "provider_1", "usage-token");
        let auth_result = set_usage_auth_impl(
            &state,
            "provider_1",
            "usage-token",
            "alice@example.com",
            "secret",
        );

        let expected = Err(
            "provider definitions are borrowed from a followed source; switch back to Local or copy first"
                .to_string(),
        );
        assert_eq!(token_result, expected);
        assert_eq!(
            auth_result,
            Err(
                "provider definitions are borrowed from a followed source; switch back to Local or copy first"
                    .to_string()
            )
        );
        assert_eq!(state.secrets.get_usage_token("provider_1"), None);
        assert_eq!(state.secrets.get_usage_login("provider_1"), None);
    }

    #[test]
    fn usage_base_url_mutations_are_blocked_while_following_remote() {
        let (_tmp, state) = build_test_state();
        state
            .secrets
            .set_followed_config_source_node_id(Some("node-remote"))
            .expect("set followed source");
        let original = state
            .gateway
            .cfg
            .read()
            .providers
            .get("provider_1")
            .and_then(|provider| provider.usage_base_url.clone());

        let result = set_usage_base_url_impl(&state, "provider_1", "https://usage.example/v1");

        assert_eq!(
            result,
            Err(
                "provider definitions are borrowed from a followed source; switch back to Local or copy first"
                    .to_string()
            )
        );
        assert_eq!(
            state
                .gateway
                .cfg
                .read()
                .providers
                .get("provider_1")
                .and_then(|provider| provider.usage_base_url.clone()),
            original
        );
    }
}
