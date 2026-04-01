fn spend_history_configured_provider_names(
    cfg: &crate::orchestrator::config::AppConfig,
) -> Vec<String> {
    let mut providers = Vec::new();
    for provider_name in &cfg.provider_order {
        if cfg.providers.contains_key(provider_name) {
            providers.push(provider_name.clone());
        }
    }
    for provider_name in cfg.providers.keys() {
        if !providers.iter().any(|entry| entry == provider_name) {
            providers.push(provider_name.clone());
        }
    }
    providers
}

#[tauri::command]
pub(crate) fn get_spend_history(
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
    let requested_provider = provider
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
    let provider_filter = requested_provider
        .as_deref()
        .map(|s| s.to_ascii_lowercase());

    let cfg = state.gateway.cfg.read().clone();
    let mut pricing = state.gateway.store.list_provider_pricing_configs();
    for (provider_name, config) in state.secrets.list_provider_pricing() {
        pricing.insert(provider_name, config);
    }
    let providers: Vec<String> = if let Some(filter) = requested_provider {
        vec![filter]
    } else {
        spend_history_configured_provider_names(&cfg)
    };

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
        let mut usage_by_day_from_req: BTreeMap<String, (u64, u64, u64)> = BTreeMap::new();
        let mut api_key_ref_counts_by_day: BTreeMap<String, BTreeMap<String, u64>> =
            BTreeMap::new();
        const PAGE_SIZE: usize = 2_000;
        let provider_only = vec![provider_name.clone()];
        let mut req_offset = 0usize;
        loop {
            let (req_rows, has_more) = state.gateway.store.list_usage_requests_page(
                since,
                None,
                None,
                &[],
                &provider_only,
                &[],
                &[],
                &[],
                PAGE_SIZE,
                req_offset,
            );
            if req_rows.is_empty() {
                break;
            }
            req_offset = req_offset.saturating_add(req_rows.len());
            for req in req_rows {
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
                    .entry(day_key.clone())
                    .and_modify(|(r, t, u)| {
                        *r = r.saturating_add(1);
                        *t = t.saturating_add(total_tokens);
                        *u = (*u).max(ts);
                    })
                    .or_insert((1, total_tokens, ts));
                let req_api_key_ref = req
                    .get("api_key_ref")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty() && *s != "-")
                    .map(|s| s.to_string());
                if let Some(key_ref) = req_api_key_ref {
                    api_key_ref_counts_by_day
                        .entry(day_key)
                        .or_default()
                        .entry(key_ref)
                        .and_modify(|v| *v = v.saturating_add(1))
                        .or_insert(1);
                }
            }
            if !has_more {
                break;
            }
        }
        merge_usage_history_day_counts(&mut usage_by_day, usage_by_day_from_req);

        let mut tracked_by_day: BTreeMap<String, f64> = BTreeMap::new();
        let mut tracked_api_key_ref_by_day: BTreeMap<String, String> = BTreeMap::new();
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
            if let Some(key_ref) = day
                .get("api_key_ref")
                .and_then(|v| v.as_str())
                .map(|s| s.trim())
                .filter(|s| !s.is_empty() && *s != "-")
            {
                tracked_api_key_ref_by_day.insert(day_key.clone(), key_ref.to_string());
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
                as_f64(day.get("manual_total_usd")).filter(|v| v.is_finite() && *v != 0.0);
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
        let mut day_keys: BTreeSet<String> = BTreeSet::new();
        day_keys.extend(usage_by_day.keys().cloned());
        day_keys.extend(tracked_by_day.keys().cloned());
        day_keys.extend(manual_by_day.keys().cloned());

        for day_key in day_keys {
            let Some((day_start, day_end)) = local_day_range_from_key(&day_key) else {
                continue;
            };
            if day_start < since || day_start > now {
                continue;
            }
            let history_api_key_ref = api_key_ref_counts_by_day
                .get(&day_key)
                .and_then(|counts| {
                    counts
                        .iter()
                        .max_by(|a, b| a.1.cmp(b.1).then_with(|| a.0.cmp(b.0)))
                        .map(|(key_ref, _)| key_ref.clone())
                })
                .or_else(|| tracked_api_key_ref_by_day.get(&day_key).cloned())
                .unwrap_or_else(|| "-".to_string());
            let (req_count, total_tokens, usage_updated_at) =
                usage_by_day.get(&day_key).copied().unwrap_or((0, 0, 0));
            let pricing_cfg = crate::orchestrator::secrets::resolve_provider_pricing_config(
                &pricing,
                &provider_name,
                Some(&history_api_key_ref),
                day_start,
            );
            let package_profile = package_profile_for_day(pricing_cfg, day_start);
            let tracked_total = tracked_by_day.get(&day_key).copied();
            let scheduled_total = package_total_schedule_by_day(pricing_cfg, day_start, day_end)
                .remove(&day_key)
                .filter(|value| value.is_finite() && *value > 0.0);
            let per_request_total = if req_count > 0 {
                per_request_amount_at(pricing_cfg, day_start)
                    .filter(|value| value.is_finite() && *value > 0.0)
                    .map(|value| value * req_count as f64)
            } else {
                None
            };
            let scheduled_package_total_usd =
                package_profile.as_ref().map(|(amount, _, _)| *amount);
            let (manual_total, manual_per_req, manual_updated_at) = manual_by_day
                .get(&day_key)
                .copied()
                .unwrap_or((None, None, 0));
            let has_scheduled = scheduled_total.is_some()
                || scheduled_package_total_usd.is_some()
                || per_request_total.is_some();
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
            } else if per_request_total.is_some() {
                per_request_total
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
                "api_key_ref": history_api_key_ref,
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

fn merge_usage_history_day_counts(
    usage_by_day: &mut BTreeMap<String, (u64, u64, u64)>,
    usage_by_day_from_req: BTreeMap<String, (u64, u64, u64)>,
) {
    for (day_key, req_row) in usage_by_day_from_req {
        match usage_by_day.get_mut(&day_key) {
            Some((req_count, total_tokens, updated_at)) => {
                // Raw usage_requests are the canonical source for per-day req/token counts.
                // usage_day is only a fallback when raw rows for that day are unavailable.
                *req_count = req_row.0;
                *total_tokens = req_row.1;
                *updated_at = (*updated_at).max(req_row.2);
            }
            None => {
                usage_by_day.insert(day_key, req_row);
            }
        }
    }
}

#[tauri::command]
pub(crate) fn set_spend_history_entry(
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
        .filter(|v| v.is_finite() && *v != 0.0)
        .or(None);
    let usd_per_req = usd_per_req.filter(|v| v.is_finite() && *v > 0.0).or(None);

    if total_used_usd.is_none() && usd_per_req.is_none() {
        state
            .gateway
            .store
            .remove_spend_manual_day(&provider, &day_key);
        if let Err(err) =
            crate::lan_sync::record_spend_manual_day(&state, &provider, &day_key, None, None)
        {
            state.gateway.store.add_event(
                &provider,
                "error",
                "lan.edit_sync_record_failed",
                &format!("failed to record spend manual clear for LAN sync: {err}"),
                serde_json::json!({ "day_key": day_key }),
            );
        }
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
    if let Err(err) = crate::lan_sync::record_spend_manual_day(
        &state,
        &provider,
        &day_key,
        total_used_usd,
        usd_per_req,
    ) {
        state.gateway.store.add_event(
            &provider,
            "error",
            "lan.edit_sync_record_failed",
            &format!("failed to record spend manual update for LAN sync: {err}"),
            serde_json::json!({ "day_key": day_key }),
        );
    }
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

#[cfg(test)]
mod spend_history_tests {
    use std::collections::BTreeMap;

    use crate::orchestrator::secrets::{
        resolve_provider_pricing_config, ProviderPricingConfig, ProviderPricingPeriod,
    };
    use crate::orchestrator::config::{AppConfig, ProviderConfig};

    use super::{merge_usage_history_day_counts, spend_history_configured_provider_names};

    #[test]
    fn resolves_history_pricing_by_api_key_ref_when_provider_was_renamed() {
        let pricing = std::collections::BTreeMap::from([(
            "codex-for.me".to_string(),
            ProviderPricingConfig {
                mode: "package_total".to_string(),
                amount_usd: 56.10,
                periods: vec![ProviderPricingPeriod {
                    id: "period-1".to_string(),
                    mode: "package_total".to_string(),
                    amount_usd: 56.10,
                    api_key_ref: "sk-tPN******hxNs".to_string(),
                    started_at_unix_ms: 1_700_000_000_000,
                    ended_at_unix_ms: Some(1_800_000_000_000),
                }],
                gap_fill_mode: None,
                gap_fill_amount_usd: None,
            },
        )]);

        let resolved = resolve_provider_pricing_config(
            &pricing,
            "packycode",
            Some("sk-tPN******hxNs"),
            1_700_100_000_000,
        );

        assert!(resolved.is_some());
        assert_eq!(resolved.expect("pricing").amount_usd, 56.10);
    }

    #[test]
    fn resolves_history_per_request_pricing_by_api_key_ref_when_provider_was_renamed() {
        let pricing = std::collections::BTreeMap::from([(
            "codex-for.me".to_string(),
            ProviderPricingConfig {
                mode: "per_request".to_string(),
                amount_usd: 0.035,
                periods: vec![ProviderPricingPeriod {
                    id: "period-1".to_string(),
                    mode: "per_request".to_string(),
                    amount_usd: 0.035,
                    api_key_ref: "sk-tPN******hxNs".to_string(),
                    started_at_unix_ms: 1_700_000_000_000,
                    ended_at_unix_ms: Some(1_800_000_000_000),
                }],
                gap_fill_mode: None,
                gap_fill_amount_usd: None,
            },
        )]);

        let resolved = resolve_provider_pricing_config(
            &pricing,
            "packycode",
            Some("sk-tPN******hxNs"),
            1_700_100_000_000,
        );

        assert!(resolved.is_some());
        assert_eq!(resolved.expect("pricing").amount_usd, 0.035);
    }

    #[test]
    fn raw_usage_requests_override_stale_usage_day_counts_for_daily_history() {
        let mut usage_by_day = BTreeMap::from([("2026-03-31".to_string(), (2_u64, 111_u64, 10_u64))]);
        let usage_by_day_from_req =
            BTreeMap::from([("2026-03-31".to_string(), (86_u64, 999_u64, 20_u64))]);

        merge_usage_history_day_counts(&mut usage_by_day, usage_by_day_from_req);

        assert_eq!(
            usage_by_day.get("2026-03-31").copied(),
            Some((86_u64, 999_u64, 20_u64))
        );
    }

    #[test]
    fn raw_usage_requests_add_missing_daily_history_day() {
        let mut usage_by_day = BTreeMap::new();
        let usage_by_day_from_req =
            BTreeMap::from([("2026-04-01".to_string(), (5_u64, 1234_u64, 30_u64))]);

        merge_usage_history_day_counts(&mut usage_by_day, usage_by_day_from_req);

        assert_eq!(
            usage_by_day.get("2026-04-01").copied(),
            Some((5_u64, 1234_u64, 30_u64))
        );
    }

    #[test]
    fn resolves_history_per_request_pricing_for_daily_totals() {
        let pricing = std::collections::BTreeMap::from([(
            "codex-for.me".to_string(),
            ProviderPricingConfig {
                mode: "per_request".to_string(),
                amount_usd: 0.0,
                periods: vec![ProviderPricingPeriod {
                    id: "period-1".to_string(),
                    mode: "per_request".to_string(),
                    amount_usd: 0.035,
                    api_key_ref: "sk-tPN******hxNs".to_string(),
                    started_at_unix_ms: 1_700_000_000_000,
                    ended_at_unix_ms: Some(1_800_000_000_000),
                }],
                gap_fill_mode: None,
                gap_fill_amount_usd: None,
            },
        )]);

        let resolved = resolve_provider_pricing_config(
            &pricing,
            "packycode",
            Some("sk-tPN******hxNs"),
            1_700_100_000_000,
        );
        let per_request =
            crate::orchestrator::secrets::pricing_per_request_amount_at(resolved, 1_700_100_000_000);

        assert_eq!(per_request, Some(0.035));
        let total = per_request.map(|v| (v * 100.0 * 1000.0).round() / 1000.0);
        assert_eq!(total, Some(3.5));
    }

    #[test]
    fn configured_provider_names_follow_config_order_first() {
        let mut cfg = AppConfig::default_config();
        cfg.providers = BTreeMap::from([
            (
                "official".to_string(),
                ProviderConfig {
                    display_name: "Official".to_string(),
                    base_url: "https://official.example/v1".to_string(),
                    group: None,
                    disabled: false,
                    usage_adapter: String::new(),
                    usage_base_url: None,
                    api_key: String::new(),
                },
            ),
            (
                "packycode".to_string(),
                ProviderConfig {
                    display_name: "Packycode".to_string(),
                    base_url: "https://packycode.example/v1".to_string(),
                    group: None,
                    disabled: false,
                    usage_adapter: String::new(),
                    usage_base_url: None,
                    api_key: String::new(),
                },
            ),
            (
                "aigateway".to_string(),
                ProviderConfig {
                    display_name: "AIGateway".to_string(),
                    base_url: "https://aigateway.example/v1".to_string(),
                    group: None,
                    disabled: false,
                    usage_adapter: String::new(),
                    usage_base_url: None,
                    api_key: String::new(),
                },
            ),
        ]);
        cfg.provider_order = vec!["packycode".to_string(), "official".to_string()];

        assert_eq!(
            spend_history_configured_provider_names(&cfg),
            vec![
                "packycode".to_string(),
                "official".to_string(),
                "aigateway".to_string()
            ]
        );
    }
}
