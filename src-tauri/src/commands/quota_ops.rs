const USAGE_REFRESH_SUMMARY_WINDOW_MS: u64 = 30 * 60 * 1000;

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
pub(crate) async fn refresh_quota_shared(
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
pub(crate) async fn refresh_quota_all(
    state: tauri::State<'_, app_state::AppState>,
) -> Result<(), String> {
    let (ok, err, failed) =
        crate::orchestrator::quota::refresh_quota_all_with_summary(&state.gateway).await;
    let now_ms = crate::orchestrator::store::unix_ms();
    if err == 0 {
        let (summary_to_emit, recovered_failures) = usage_refresh_on_success(now_ms, ok);
        if let Some(prev) = summary_to_emit {
            state.gateway.store.add_event(
                "gateway",
                "info",
                "usage.refresh_succeeded_summary",
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
            state.gateway.store.add_event(
                "gateway",
                "info",
                "usage.refresh_recovered",
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
pub(crate) fn set_usage_token(
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
pub(crate) fn clear_usage_token(
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
pub(crate) fn set_usage_base_url(
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
pub(crate) fn clear_usage_base_url(
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
    state.gateway.store.add_event(
        &provider,
        "error",
        "health.probe_failed",
        "health probe failed",
        serde_json::Value::Null,
    );
    Err(err)
}
