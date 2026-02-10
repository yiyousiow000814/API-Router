#[tauri::command]
fn get_provider_schedule(
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
struct ProviderSchedulePeriodInput {
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
struct ProviderTimelinePeriodInput {
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
fn get_provider_timeline(
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
fn set_provider_timeline(
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
fn set_provider_schedule(
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

#[tauri::command]
fn get_spend_history(
    state: tauri::State<'_, app_state::AppState>,
    provider: Option<String>,
    days: Option<u64>,
    compact_only: Option<bool>,
) -> serde_json::Value {
    fn as_f64(v: Option<&Value>) -> Option<f64> {
        v.and_then(|x| {
            x.as_f64().or_else(|| {
                x.as_i64()
                    .map(|n| n as f64)
                    .or_else(|| x.as_u64().map(|n| n as f64))
            })
        })
    }

    fn round3(v: f64) -> f64 {
        (v * 1000.0).round() / 1000.0
    }

    let now = unix_ms();
    let keep_days = days.unwrap_or(60).clamp(1, 365);
    let compact_only = compact_only.unwrap_or(true);
    let since = now.saturating_sub(keep_days.saturating_mul(24 * 60 * 60 * 1000));
    let provider_filter = provider
        .as_deref()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty());

    let cfg = state.gateway.cfg.read().clone();
    let pricing = state.secrets.list_provider_pricing();
    let mut providers: Vec<String> = cfg.providers.keys().cloned().collect();
    providers.sort();

    let mut rows: Vec<Value> = Vec::new();
    for provider_name in providers {
        if provider_filter
            .as_deref()
            .is_some_and(|f| f != provider_name.to_ascii_lowercase())
        {
            continue;
        }

        let mut usage_by_day: BTreeMap<String, (u64, u64, u64)> = BTreeMap::new();
        for day in state.gateway.store.list_usage_days(&provider_name) {
            let Some(day_key) = day.get("day_key").and_then(|v| v.as_str()) else {
                continue;
            };
            let req_count = day.get("req_count").and_then(|v| v.as_u64()).unwrap_or(0);
            let total_tokens = day
                .get("total_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let updated_at = day
                .get("updated_at_unix_ms")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            usage_by_day
                .entry(day_key.to_string())
                .and_modify(|(r, t, u)| {
                    *r = r.saturating_add(req_count);
                    *t = t.saturating_add(total_tokens);
                    *u = (*u).max(updated_at);
                })
                .or_insert((req_count, total_tokens, updated_at));
        }
        // Backfill from raw usage requests so History can show days that existed
        // before `usage_day:*` aggregation was introduced or when day aggregates are missing.
        let mut usage_by_day_from_req: BTreeMap<String, (u64, u64, u64)> = BTreeMap::new();
        for req in state.gateway.store.list_usage_requests(100_000) {
            let req_provider = req.get("provider").and_then(|v| v.as_str()).unwrap_or("");
            if req_provider != provider_name {
                continue;
            }
            let ts = req.get("unix_ms").and_then(|v| v.as_u64()).unwrap_or(0);
            if ts == 0 {
                continue;
            }
            let Some(day_key) = local_day_key_from_unix_ms(ts) else {
                continue;
            };
            let total_tokens = req
                .get("total_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or_else(|| {
                    let input_tokens = req
                        .get("input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let output_tokens = req
                        .get("output_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    input_tokens.saturating_add(output_tokens)
                });
            usage_by_day_from_req
                .entry(day_key)
                .and_modify(|(r, t, u)| {
                    *r = r.saturating_add(1);
                    *t = t.saturating_add(total_tokens);
                    *u = (*u).max(ts);
                })
                .or_insert((1, total_tokens, ts));
        }
        // Backfill only missing days from raw requests; keep existing usage_day aggregation
        // as the canonical source when both are present.
        for (day_key, row) in usage_by_day_from_req {
            usage_by_day.entry(day_key).or_insert(row);
        }

        let mut tracked_by_day: BTreeMap<String, f64> = BTreeMap::new();
        let mut updated_by_day: BTreeMap<String, u64> = BTreeMap::new();
        for day in state.gateway.store.list_spend_days(&provider_name) {
            let started = day
                .get("started_at_unix_ms")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let Some(day_key) = local_day_key_from_unix_ms(started) else {
                continue;
            };
            let tracked = as_f64(day.get("tracked_spend_usd")).unwrap_or(0.0);
            if tracked > 0.0 && tracked.is_finite() {
                tracked_by_day
                    .entry(day_key.clone())
                    .and_modify(|v| *v += tracked)
                    .or_insert(tracked);
            }
            let updated_at = day
                .get("updated_at_unix_ms")
                .and_then(|v| v.as_u64())
                .unwrap_or(started);
            updated_by_day
                .entry(day_key)
                .and_modify(|v| *v = (*v).max(updated_at))
                .or_insert(updated_at);
        }

        let mut manual_by_day: BTreeMap<String, (Option<f64>, Option<f64>, u64)> = BTreeMap::new();
        for day in state.gateway.store.list_spend_manual_days(&provider_name) {
            let Some(day_key) = day.get("day_key").and_then(|v| v.as_str()) else {
                continue;
            };
            let manual_total =
                as_f64(day.get("manual_total_usd")).filter(|v| v.is_finite() && *v > 0.0);
            let manual_per_req =
                as_f64(day.get("manual_usd_per_req")).filter(|v| v.is_finite() && *v > 0.0);
            let updated_at = day
                .get("updated_at_unix_ms")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            manual_by_day.insert(
                day_key.to_string(),
                (manual_total, manual_per_req, updated_at),
            );
        }
        let mut scheduled_by_day =
            package_total_schedule_by_day(pricing.get(&provider_name), since, now);
        scheduled_by_day.retain(|_, v| v.is_finite() && *v > 0.0);

        let mut day_keys: BTreeSet<String> = BTreeSet::new();
        day_keys.extend(usage_by_day.keys().cloned());
        day_keys.extend(tracked_by_day.keys().cloned());
        day_keys.extend(manual_by_day.keys().cloned());
        day_keys.extend(scheduled_by_day.keys().cloned());

        for day_key in day_keys {
            let Some((day_start, _day_end)) = local_day_range_from_key(&day_key) else {
                continue;
            };
            if day_start < since || day_start > now {
                continue;
            }
            let (req_count, total_tokens, usage_updated_at) =
                usage_by_day.get(&day_key).copied().unwrap_or((0, 0, 0));
            let package_profile = package_profile_for_day(pricing.get(&provider_name), day_start);
            let tracked_total = tracked_by_day.get(&day_key).copied();
            let scheduled_total = scheduled_by_day.get(&day_key).copied();
            let scheduled_package_total_usd = package_profile.map(|(amount, _)| amount);
            let (manual_total, manual_per_req, manual_updated_at) = manual_by_day
                .get(&day_key)
                .copied()
                .unwrap_or((None, None, 0));
            let has_scheduled = scheduled_total.is_some() || scheduled_package_total_usd.is_some();
            if compact_only && req_count == 0 && manual_total.is_none() && manual_per_req.is_none()
            {
                continue;
            }

            let manual_additional = if let Some(v) = manual_total {
                Some(v)
            } else if let Some(v) = manual_per_req {
                if req_count > 0 {
                    Some(v * req_count as f64)
                } else {
                    None
                }
            } else {
                None
            };
            let effective_extra = if manual_additional.is_some() {
                manual_additional
            } else {
                scheduled_total
            };
            let effective_total = match (tracked_total, effective_extra) {
                (Some(a), Some(b)) => Some(a + b),
                (Some(a), None) => Some(a),
                (None, Some(b)) => Some(b),
                (None, None) => None,
            };
            let effective_per_req = if let Some(v) = manual_per_req {
                Some(v)
            } else if let Some(total) = effective_total {
                if req_count > 0 {
                    Some(total / req_count as f64)
                } else {
                    None
                }
            } else {
                None
            };
            let source = match (tracked_total, has_scheduled, manual_total, manual_per_req) {
                (Some(_), _, Some(_), _) => "tracked+manual_total",
                (Some(_), _, None, Some(_)) => "tracked+manual_per_request",
                (Some(_), true, None, None) => "tracked+scheduled",
                (Some(_), false, None, None) => "tracked",
                (None, _, Some(_), _) => "manual_total",
                (None, _, None, Some(_)) => "manual_per_request",
                (None, true, None, None) => "scheduled_package_total",
                _ => "none",
            };
            let updated_at = usage_updated_at
                .max(manual_updated_at)
                .max(updated_by_day.get(&day_key).copied().unwrap_or(0));
            rows.push(serde_json::json!({
                "provider": provider_name,
                "day_key": day_key,
                "req_count": req_count,
                "total_tokens": total_tokens,
                "tracked_total_usd": tracked_total.map(round3),
                "scheduled_total_usd": scheduled_total.map(round3),
                "scheduled_package_total_usd": scheduled_package_total_usd.map(round3),
                "manual_total_usd": manual_total.map(round3),
                "manual_usd_per_req": manual_per_req.map(round3),
                "effective_total_usd": effective_total.map(round3),
                "effective_usd_per_req": effective_per_req.map(round3),
                "source": source,
                "updated_at_unix_ms": updated_at
            }));
        }
    }

    rows.sort_by(|a, b| {
        let ad = a.get("day_key").and_then(|v| v.as_str()).unwrap_or("");
        let bd = b.get("day_key").and_then(|v| v.as_str()).unwrap_or("");
        match bd.cmp(ad) {
            std::cmp::Ordering::Equal => {
                let ap = a.get("provider").and_then(|v| v.as_str()).unwrap_or("");
                let bp = b.get("provider").and_then(|v| v.as_str()).unwrap_or("");
                ap.cmp(bp)
            }
            ord => ord,
        }
    });

    serde_json::json!({
        "ok": true,
        "generated_at_unix_ms": now,
        "days": keep_days,
        "rows": rows
    })
}

#[tauri::command]
fn set_spend_history_entry(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    day_key: String,
    total_used_usd: Option<f64>,
    usd_per_req: Option<f64>,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let day_key = day_key.trim().to_string();
    if local_day_range_from_key(&day_key).is_none() {
        return Err("day_key must be YYYY-MM-DD".to_string());
    }
    let total_used_usd = total_used_usd
        .filter(|v| v.is_finite() && *v > 0.0)
        .or(None);
    let usd_per_req = usd_per_req.filter(|v| v.is_finite() && *v > 0.0).or(None);

    if total_used_usd.is_none() && usd_per_req.is_none() {
        state
            .gateway
            .store
            .remove_spend_manual_day(&provider, &day_key);
        state.gateway.store.add_event(
            &provider,
            "info",
            "usage.spend_history_entry_cleared",
            "spend history manual entry cleared",
            serde_json::json!({ "day_key": day_key }),
        );
        return Ok(());
    }

    let row = serde_json::json!({
        "provider": provider,
        "day_key": day_key,
        "manual_total_usd": total_used_usd,
        "manual_usd_per_req": usd_per_req,
        "updated_at_unix_ms": unix_ms()
    });
    state
        .gateway
        .store
        .put_spend_manual_day(&provider, &day_key, &row);
    state.gateway.store.add_event(
        &provider,
        "info",
        "usage.spend_history_entry_updated",
        "spend history manual entry updated",
        serde_json::json!({
            "day_key": day_key,
            "manual_total_usd": total_used_usd,
            "manual_usd_per_req": usd_per_req
        }),
    );
    Ok(())
}

