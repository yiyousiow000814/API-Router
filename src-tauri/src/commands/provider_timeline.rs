#[tauri::command]
pub(crate) fn get_provider_schedule(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<serde_json::Value, String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let periods = state.secrets.list_provider_schedule(&provider);
    let rows = periods
        .into_iter()
        .filter_map(|period| {
            let ended = period.ended_at_unix_ms?;
            Some(serde_json::json!({
                "id": period.id,
                "amount_usd": period.amount_usd,
                "api_key_ref": period.api_key_ref,
                "started_at_unix_ms": period.started_at_unix_ms,
                "ended_at_unix_ms": ended,
            }))
        })
        .collect::<Vec<_>>();
    Ok(serde_json::json!({
        "ok": true,
        "provider": provider,
        "periods": rows
    }))
}

#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct ProviderSchedulePeriodInput {
    id: Option<String>,
    #[serde(alias = "amountUsd")]
    amount_usd: f64,
    #[serde(default, alias = "apiKeyRef")]
    api_key_ref: Option<String>,
    #[serde(alias = "startedAtUnixMs")]
    started_at_unix_ms: u64,
    #[serde(alias = "endedAtUnixMs")]
    ended_at_unix_ms: u64,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct ProviderTimelinePeriodInput {
    id: Option<String>,
    mode: String,
    #[serde(alias = "amountUsd")]
    amount_usd: f64,
    #[serde(default, alias = "apiKeyRef")]
    api_key_ref: Option<String>,
    #[serde(alias = "startedAtUnixMs")]
    started_at_unix_ms: u64,
    #[serde(default, alias = "endedAtUnixMs")]
    ended_at_unix_ms: Option<u64>,
}

fn provider_api_key_ref(state: &tauri::State<'_, app_state::AppState>, provider: &str) -> String {
    state
        .secrets
        .get_provider_key(provider)
        .as_deref()
        .map(mask_key_preview)
        .unwrap_or_else(|| "-".to_string())
}
#[tauri::command]
pub(crate) fn get_provider_timeline(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<serde_json::Value, String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let rows = state
        .secrets
        .list_provider_timeline(&provider)
        .into_iter()
        .map(|period| {
            serde_json::json!({
                "id": period.id,
                "mode": period.mode,
                "amount_usd": period.amount_usd,
                "api_key_ref": period.api_key_ref,
                "started_at_unix_ms": period.started_at_unix_ms,
                "ended_at_unix_ms": period.ended_at_unix_ms,
            })
        })
        .collect::<Vec<_>>();
    Ok(serde_json::json!({
        "ok": true,
        "provider": provider,
        "periods": rows
    }))
}

#[tauri::command]
pub(crate) fn set_provider_timeline(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    periods: Vec<ProviderTimelinePeriodInput>,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let default_key_ref = provider_api_key_ref(&state, &provider);

    let mut normalized = periods
        .into_iter()
        .map(|period| {
            let mode = period.mode.trim().to_ascii_lowercase();
            if mode != "package_total" && mode != "per_request" {
                return Err("timeline mode must be package_total or per_request".to_string());
            }
            if !period.amount_usd.is_finite() || period.amount_usd <= 0.0 {
                return Err("timeline amount_usd must be > 0".to_string());
            }
            if period.started_at_unix_ms == 0 {
                return Err("timeline started_at_unix_ms must be valid".to_string());
            }
            if mode == "package_total" && period.ended_at_unix_ms.is_none() {
                return Err("package_total timeline requires ended_at_unix_ms".to_string());
            }
            if let Some(end) = period.ended_at_unix_ms {
                if end == 0 || period.started_at_unix_ms >= end {
                    return Err(
                        "timeline started_at_unix_ms must be less than ended_at_unix_ms"
                            .to_string(),
                    );
                }
            }
            Ok(crate::orchestrator::secrets::ProviderPricingPeriod {
                id: period.id.unwrap_or_default(),
                mode,
                amount_usd: period.amount_usd,
                api_key_ref: period
                    .api_key_ref
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| default_key_ref.clone()),
                started_at_unix_ms: period.started_at_unix_ms,
                ended_at_unix_ms: period.ended_at_unix_ms,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    normalized.sort_by(|a, b| a.started_at_unix_ms.cmp(&b.started_at_unix_ms));
    for pair in normalized.windows(2) {
        let left = &pair[0];
        let right = &pair[1];
        let Some(left_end) = left.ended_at_unix_ms else {
            return Err("open-ended timeline period must be the latest row".to_string());
        };
        if left_end > right.started_at_unix_ms {
            return Err("timeline periods must not overlap".to_string());
        }
    }

    let count = normalized.len();
    state.secrets.set_provider_timeline(&provider, normalized)?;
    state.gateway.store.add_event(
        &provider,
        "info",
        "config.provider_timeline_updated",
        "provider pricing timeline updated",
        serde_json::json!({ "count": count }),
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn set_provider_schedule(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    periods: Vec<ProviderSchedulePeriodInput>,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }

    let default_key_ref = provider_api_key_ref(&state, &provider);
    let mut normalized = periods
        .into_iter()
        .map(|period| {
            if !period.amount_usd.is_finite() || period.amount_usd <= 0.0 {
                return Err("period amount_usd must be > 0".to_string());
            }
            if period.started_at_unix_ms == 0 || period.ended_at_unix_ms == 0 {
                return Err("period start/end must be valid timestamps".to_string());
            }
            if period.started_at_unix_ms >= period.ended_at_unix_ms {
                return Err(
                    "period started_at_unix_ms must be less than ended_at_unix_ms".to_string(),
                );
            }
            Ok(crate::orchestrator::secrets::ProviderPricingPeriod {
                id: period.id.unwrap_or_default(),
                mode: "package_total".to_string(),
                amount_usd: period.amount_usd,
                api_key_ref: period
                    .api_key_ref
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| default_key_ref.clone()),
                started_at_unix_ms: period.started_at_unix_ms,
                ended_at_unix_ms: Some(period.ended_at_unix_ms),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    normalized.sort_by(|a, b| a.started_at_unix_ms.cmp(&b.started_at_unix_ms));
    for pair in normalized.windows(2) {
        let left = &pair[0];
        let right = &pair[1];
        let left_end = left.ended_at_unix_ms.unwrap_or(0);
        if left_end > right.started_at_unix_ms {
            return Err("schedule periods must not overlap".to_string());
        }
    }

    let count = normalized.len();
    state.secrets.set_provider_schedule(&provider, normalized)?;
    state.gateway.store.add_event(
        &provider,
        "info",
        "config.provider_schedule_updated",
        "provider scheduled package periods updated",
        serde_json::json!({ "count": count }),
    );
    Ok(())
}

