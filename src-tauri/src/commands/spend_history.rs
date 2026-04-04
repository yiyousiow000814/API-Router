fn spend_history_provider_names(
    cfg: &crate::orchestrator::config::AppConfig,
    store: &crate::orchestrator::store::Store,
) -> Vec<String> {
    let mut providers = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for provider_name in &cfg.provider_order {
        if cfg.providers.contains_key(provider_name) && seen.insert(provider_name.clone()) {
            providers.push(provider_name.clone());
        }
    }
    for provider_name in cfg.providers.keys() {
        if seen.insert(provider_name.clone()) {
            providers.push(provider_name.clone());
        }
    }
    for provider_name in store.list_spend_history_provider_names() {
        if seen.insert(provider_name.clone()) {
            providers.push(provider_name);
        }
    }
    providers
}

fn tracked_spend_history_day_key(day: &Value) -> Option<String> {
    let started_at_unix_ms = day
        .get("started_at_unix_ms")
        .and_then(|v| v.as_u64())
        .or_else(|| {
            day.get("ended_at_unix_ms")
                .and_then(|v| v.as_u64())
                .map(|value| value.saturating_sub(1))
        })
        .or_else(|| day.get("updated_at_unix_ms").and_then(|v| v.as_u64()))?;
    local_day_key_from_unix_ms(started_at_unix_ms)
}

fn tracked_spend_history_snapshot(day: &Value) -> Option<(String, f64, u64)> {
    let tracked_spend_usd = day
        .get("tracked_spend_usd")
        .and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_i64().map(|n| n as f64))
                .or_else(|| value.as_u64().map(|n| n as f64))
        })
        .filter(|value| value.is_finite() && *value > 0.0)?;
    let updated_at_unix_ms = day
        .get("updated_at_unix_ms")
        .and_then(|v| v.as_u64())
        .or_else(|| {
            day.get("ended_at_unix_ms")
                .and_then(|v| v.as_u64())
                .map(|value| value.saturating_sub(1))
        })
        .or_else(|| day.get("started_at_unix_ms").and_then(|v| v.as_u64()))?;
    let day_key = tracked_spend_history_day_key(day)?;
    Some((day_key, tracked_spend_usd, updated_at_unix_ms))
}

fn include_compact_spend_history_row(
    compact_only: bool,
    req_count: u64,
    tracked_total: Option<f64>,
    manual_total: Option<f64>,
    manual_per_req: Option<f64>,
) -> bool {
    if !compact_only {
        return true;
    }
    if req_count > 0 {
        return true;
    }
    if tracked_total.is_some() {
        return true;
    }
    manual_total.is_some() || manual_per_req.is_some()
}

fn merge_manual_per_req_for_spend_history_day(
    current_per_req: &mut Option<f64>,
    current_per_req_updated_at: &mut u64,
    manual_per_req: Option<f64>,
    updated_at: u64,
) {
    let Some(candidate) = manual_per_req else {
        return;
    };
    let should_replace = current_per_req.is_none()
        || updated_at > *current_per_req_updated_at
        || (updated_at == *current_per_req_updated_at
            && candidate > current_per_req.unwrap_or_default());
    if should_replace {
        *current_per_req = Some(candidate);
        *current_per_req_updated_at = updated_at;
    }
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
        spend_history_provider_names(&cfg, &state.gateway.store)
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
        for (day_key, api_key_ref, req_count, total_tokens, updated_at) in state
            .gateway
            .store
            .list_usage_request_day_rollups_for_provider(&provider_name, since)
        {
            usage_by_day_from_req
                .entry(day_key.clone())
                .and_modify(|(r, t, u)| {
                    *r = r.saturating_add(req_count);
                    *t = t.saturating_add(total_tokens);
                    *u = (*u).max(updated_at);
                })
                .or_insert((req_count, total_tokens, updated_at));
            if api_key_ref != "-" {
                api_key_ref_counts_by_day
                    .entry(day_key)
                    .or_default()
                    .entry(api_key_ref)
                    .and_modify(|v| *v = v.saturating_add(req_count))
                    .or_insert(req_count);
            }
        }
        merge_usage_history_day_counts(&mut usage_by_day, usage_by_day_from_req);

        let mut tracked_by_day: BTreeMap<String, f64> = BTreeMap::new();
        let mut tracked_api_key_ref_by_day: BTreeMap<String, String> = BTreeMap::new();
        let mut updated_by_day: BTreeMap<String, u64> = BTreeMap::new();
        let mut tracked_day_meta_by_day: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for day in state.gateway.store.list_spend_days(&provider_name) {
            let Some((snapshot_day_key, tracked_spend_usd, updated_at_unix_ms)) =
                tracked_spend_history_snapshot(&day) else {
                continue;
            };
            tracked_by_day
                .entry(snapshot_day_key.clone())
                .and_modify(|current| *current += tracked_spend_usd)
                .or_insert(tracked_spend_usd);
            updated_by_day
                .entry(snapshot_day_key.clone())
                .and_modify(|current| *current = (*current).max(updated_at_unix_ms))
                .or_insert(updated_at_unix_ms);
            tracked_day_meta_by_day
                .entry(snapshot_day_key.clone())
                .or_default()
                .push(day.clone());
            if let Some(key_ref) = day
                .get("api_key_ref")
                .and_then(|v| v.as_str())
                .map(|s| s.trim())
                .filter(|s| !s.is_empty() && *s != "-")
            {
                tracked_api_key_ref_by_day.insert(snapshot_day_key, key_ref.to_string());
            }
        }

        let mut manual_by_day: BTreeMap<String, (Option<f64>, Option<f64>, u64, u64)> =
            BTreeMap::new();
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
            manual_by_day
                .entry(day_key.to_string())
                .and_modify(
                    |(
                        current_total,
                        current_per_req,
                        current_updated_at,
                        current_per_req_updated_at,
                    )| {
                        *current_updated_at = (*current_updated_at).max(updated_at);
                        *current_total = match (*current_total, manual_total) {
                            (Some(left), Some(right)) => Some(left + right),
                            (Some(left), None) => Some(left),
                            (None, Some(right)) => Some(right),
                            (None, None) => None,
                        };
                        merge_manual_per_req_for_spend_history_day(
                            current_per_req,
                            current_per_req_updated_at,
                            manual_per_req,
                            updated_at,
                        );
                    },
                )
                .or_insert((manual_total, manual_per_req, updated_at, updated_at));
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
            let tracked_days = tracked_day_meta_by_day.get(&day_key);
            let tracked_day = tracked_days.and_then(|days| {
                days.iter().max_by_key(|day| {
                    (
                        day.get("updated_at_unix_ms")
                            .and_then(|value| value.as_u64())
                            .unwrap_or(0),
                        day.get("started_at_unix_ms")
                            .and_then(|value| value.as_u64())
                            .unwrap_or(0),
                    )
                })
            });
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
            let (manual_total, manual_per_req, manual_updated_at, _) = manual_by_day
                .get(&day_key)
                .copied()
                .unwrap_or((None, None, 0, 0));
            let has_scheduled = scheduled_total.is_some()
                || scheduled_package_total_usd.is_some()
                || per_request_total.is_some();
            if !include_compact_spend_history_row(
                compact_only,
                req_count,
                tracked_total,
                manual_total,
                manual_per_req,
            ) {
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
                "updated_at_unix_ms": updated_at,
                "tracked_producer_node_id": tracked_day.as_ref().and_then(|day| day.get("producer_node_id")).and_then(|value| value.as_str()),
                "tracked_producer_node_name": tracked_day.as_ref().and_then(|day| day.get("producer_node_name")).and_then(|value| value.as_str()),
                "tracked_applied_from_node_id": tracked_day.as_ref().and_then(|day| day.get("applied_from_node_id")).and_then(|value| value.as_str()),
                "tracked_applied_from_node_name": tracked_day.as_ref().and_then(|day| day.get("applied_from_node_name")).and_then(|value| value.as_str()),
                "tracked_applied_at_unix_ms": tracked_day.as_ref().and_then(|day| day.get("applied_at_unix_ms")).and_then(|value| value.as_u64()),
                "tracked_source_nodes": tracked_days
                    .map(|days| {
                        let mut seen = std::collections::BTreeSet::new();
                        days.iter()
                            .filter_map(|day| {
                                let node_id = day
                                    .get("producer_node_id")
                                    .and_then(|value| value.as_str())
                                    .map(str::trim)
                                    .filter(|value| !value.is_empty())?;
                                if !seen.insert(node_id.to_string()) {
                                    return None;
                                }
                                Some(serde_json::json!({
                                    "node_id": node_id,
                                    "node_name": day.get("producer_node_name").and_then(|value| value.as_str()).unwrap_or("")
                                }))
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default()
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

fn tracked_spend_day_source_node_id<'a>(day: &'a Value, local_node_id: &'a str) -> &'a str {
    day.get("producer_node_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(local_node_id)
}

fn tracked_spend_day_matches_history_target(
    day: &Value,
    target_day_key: &str,
    target_source_node_id: &str,
    local_node_id: &str,
) -> bool {
    tracked_spend_history_snapshot(day)
        .map(|(day_key, _, _)| day_key == target_day_key)
        .unwrap_or(false)
        && tracked_spend_day_source_node_id(day, local_node_id) == target_source_node_id
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

fn remove_tracked_spend_history_entries_impl(
    state: &app_state::AppState,
    provider: &str,
    day_key: &str,
) -> Result<usize, String> {
    if !state.gateway.cfg.read().providers.contains_key(provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let day_key = day_key.trim().to_string();
    if local_day_range_from_key(&day_key).is_none() {
        return Err("day_key must be YYYY-MM-DD".to_string());
    }
    let local_node_id = crate::lan_sync::current_local_node_identity()
        .map(|node| node.node_id)
        .unwrap_or_default();
    let mut removed = 0usize;
    let mut removed_entries = std::collections::BTreeSet::<(String, u64)>::new();

    for day in state.gateway.store.list_local_spend_days(provider) {
        let Some(day_started_at_unix_ms) = day.get("started_at_unix_ms").and_then(Value::as_u64)
        else {
            continue;
        };
        if tracked_spend_day_matches_history_target(&day, &day_key, &local_node_id, &local_node_id)
        {
            state
                .gateway
                .store
                .remove_spend_day(provider, day_started_at_unix_ms);
            removed = removed.saturating_add(1);
            removed_entries.insert((local_node_id.clone(), day_started_at_unix_ms));
        }
    }

    for day in state.gateway.store.list_remote_spend_days(provider) {
        let Some(day_started_at_unix_ms) = day.get("started_at_unix_ms").and_then(Value::as_u64)
        else {
            continue;
        };
        let producer_node_id = tracked_spend_day_source_node_id(&day, &local_node_id).to_string();
        if tracked_spend_day_matches_history_target(
            &day,
            &day_key,
            &producer_node_id,
            &local_node_id,
        )
        {
            state.gateway.store.remove_remote_spend_day(
                provider,
                &producer_node_id,
                day_started_at_unix_ms,
            );
            removed = removed.saturating_add(1);
            removed_entries.insert((producer_node_id, day_started_at_unix_ms));
        }
    }

    if removed == 0 {
        return Err(format!("no tracked spend entries matched {provider} {day_key}"));
    }

    for (source_node_id, day_started_at_unix_ms) in removed_entries {
        if let Err(err) = crate::lan_sync::record_tracked_spend_day_removal_from_gateway(
            &state.gateway,
            &state.secrets,
            provider,
            day_started_at_unix_ms,
            Some(&source_node_id),
        ) {
            state.gateway.store.add_event(
                    provider,
                    "error",
                    "lan.edit_sync_record_failed",
                &format!("failed to record tracked spend removal for LAN sync: {err}"),
                serde_json::json!({
                    "day_key": day_key,
                    "source_node_id": source_node_id,
                    "day_started_at_unix_ms": day_started_at_unix_ms
                }),
            );
        }
    }

    state.gateway.store.add_event(
        provider,
        "warning",
        "usage.tracked_spend_history_entries_removed",
        "tracked spend history entries removed",
        serde_json::json!({
            "day_key": day_key,
            "removed": removed
        }),
    );
    Ok(removed)
}

#[tauri::command]
pub(crate) fn remove_tracked_spend_history_entries(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    day_key: String,
) -> Result<usize, String> {
    remove_tracked_spend_history_entries_impl(&state, &provider, &day_key)
}

#[cfg(test)]
mod spend_history_tests {
    use std::collections::BTreeMap;

    use chrono::{Local, LocalResult, TimeZone};

    use crate::lan_sync::{self, LanNodeIdentity, LanSyncRuntime};
    use crate::orchestrator::config::{AppConfig, ProviderConfig};
    use crate::orchestrator::secrets::{
        resolve_provider_pricing_config, ProviderPricingConfig, ProviderPricingPeriod,
    };

    use super::{
        include_compact_spend_history_row, merge_manual_per_req_for_spend_history_day,
        merge_usage_history_day_counts,
        remove_tracked_spend_history_entries_impl, spend_history_provider_names,
        tracked_spend_day_matches_history_target,
        tracked_spend_history_day_key, tracked_spend_history_snapshot,
    };

    fn build_test_state() -> (tempfile::TempDir, crate::app_state::AppState) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("data");
        let state = crate::app_state::build_state(config_path, data_dir).expect("build state");
        lan_sync::register_gateway_status_runtime(LanSyncRuntime::new(LanNodeIdentity {
            node_id: "node-local".to_string(),
            node_name: "Local Node".to_string(),
        }));
        (tmp, state)
    }

    fn local_unix_ms(year: i32, month: u32, day: u32, hour: u32, minute: u32, second: u32) -> u64 {
        let dt = match Local.with_ymd_and_hms(year, month, day, hour, minute, second) {
            LocalResult::Single(value) => value,
            LocalResult::Ambiguous(earliest, _) => earliest,
            LocalResult::None => panic!(
                "invalid local datetime {year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}"
            ),
        };
        u64::try_from(dt.timestamp_millis()).expect("positive local timestamp")
    }

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
    fn manual_per_req_prefers_latest_source_value_for_day() {
        let mut current_per_req = Some(0.05);
        let mut current_updated_at = 100;

        merge_manual_per_req_for_spend_history_day(
            &mut current_per_req,
            &mut current_updated_at,
            Some(0.03),
            90,
        );
        assert_eq!(current_per_req, Some(0.05));
        assert_eq!(current_updated_at, 100);

        merge_manual_per_req_for_spend_history_day(
            &mut current_per_req,
            &mut current_updated_at,
            Some(0.03),
            110,
        );
        assert_eq!(current_per_req, Some(0.03));
        assert_eq!(current_updated_at, 110);
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
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = crate::orchestrator::gateway::open_store_dir(tmp.path().join("data"))
            .expect("store");
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
            spend_history_provider_names(&cfg, &store),
            vec![
                "packycode".to_string(),
                "official".to_string(),
                "aigateway".to_string()
            ]
        );
    }

    #[test]
    fn provider_names_append_historical_providers_after_current_config() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = crate::orchestrator::gateway::open_store_dir(tmp.path().join("data"))
            .expect("store");
        store.put_spend_day(
            "removed-provider",
            1_700_000_000_000,
            &serde_json::json!({"day":"2026-03-31"}),
        );
        let mut cfg = AppConfig::default_config();
        cfg.providers = BTreeMap::from([(
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
        )]);
        cfg.provider_order = vec!["official".to_string()];

        assert_eq!(
            spend_history_provider_names(&cfg, &store),
            vec!["official".to_string(), "removed-provider".to_string()]
        );
    }

    #[test]
    fn tracked_spend_uses_started_day_for_history_rows() {
        let started_at_unix_ms = local_unix_ms(2026, 4, 2, 12, 0, 0);
        let updated_at_unix_ms = local_unix_ms(2026, 4, 3, 0, 1, 0);
        let day = serde_json::json!({
            "provider": "aigateway",
            "started_at_unix_ms": started_at_unix_ms,
            "ended_at_unix_ms": updated_at_unix_ms,
            "tracked_spend_usd": 94.406078,
            "updated_at_unix_ms": updated_at_unix_ms
        });

        assert_eq!(
            tracked_spend_history_day_key(&day).as_deref(),
            Some("2026-04-02")
        );
    }

    #[test]
    fn tracked_spend_snapshot_uses_started_day_with_latest_update_metadata() {
        let started_at_unix_ms = local_unix_ms(2026, 4, 2, 3, 58, 3);
        let updated_at_unix_ms = local_unix_ms(2026, 4, 3, 0, 1, 3);
        let day = serde_json::json!({
            "provider": "codex-for.me",
            "started_at_unix_ms": started_at_unix_ms,
            "ended_at_unix_ms": updated_at_unix_ms,
            "tracked_spend_usd": 153.7,
            "updated_at_unix_ms": updated_at_unix_ms
        });

        assert_eq!(
            tracked_spend_history_snapshot(&day),
            Some(("2026-04-02".to_string(), 153.7, updated_at_unix_ms))
        );
    }

    #[test]
    fn tracked_spend_ended_at_midnight_still_uses_started_day() {
        let started_at_unix_ms = local_unix_ms(2026, 4, 2, 3, 58, 3);
        let ended_at_unix_ms = local_unix_ms(2026, 4, 4, 0, 0, 0);
        let day = serde_json::json!({
            "provider": "codex-for.me",
            "started_at_unix_ms": started_at_unix_ms,
            "ended_at_unix_ms": ended_at_unix_ms,
            "tracked_spend_usd": 153.7
        });

        assert_eq!(
            tracked_spend_history_day_key(&day).as_deref(),
            Some("2026-04-02")
        );
        assert_eq!(
            tracked_spend_history_snapshot(&day),
            Some(("2026-04-02".to_string(), 153.7, ended_at_unix_ms.saturating_sub(1)))
        );
    }

    #[test]
    fn tracked_spend_same_day_prefers_latest_snapshot() {
        let first_updated_at_unix_ms = local_unix_ms(2026, 4, 3, 0, 1, 3);
        let second_updated_at_unix_ms = local_unix_ms(2026, 4, 3, 15, 38, 3);
        let days = vec![
            serde_json::json!({
                "provider": "codex-for.me",
                "started_at_unix_ms": local_unix_ms(2026, 4, 2, 3, 58, 3),
                "ended_at_unix_ms": first_updated_at_unix_ms,
                "tracked_spend_usd": 153.7,
                "updated_at_unix_ms": first_updated_at_unix_ms
            }),
            serde_json::json!({
                "provider": "codex-for.me",
                "started_at_unix_ms": first_updated_at_unix_ms,
                "ended_at_unix_ms": serde_json::Value::Null,
                "tracked_spend_usd": 93.26,
                "updated_at_unix_ms": second_updated_at_unix_ms
            }),
        ];

        let latest = days
            .iter()
            .filter_map(tracked_spend_history_snapshot)
            .filter(|(day_key, _, _)| day_key == "2026-04-03")
            .max_by_key(|(_, _, updated_at_unix_ms)| *updated_at_unix_ms);

        assert_eq!(
            latest,
            Some(("2026-04-03".to_string(), 93.26, second_updated_at_unix_ms))
        );
    }

    #[test]
    fn tracked_source_nodes_are_unique_per_source_node() {
        let days = vec![
            serde_json::json!({
                "producer_node_id": "node-local",
                "producer_node_name": "Local Node",
            }),
            serde_json::json!({
                "producer_node_id": "node-local",
                "producer_node_name": "Local Node",
            }),
            serde_json::json!({
                "producer_node_id": "node-remote",
                "producer_node_name": "Remote Node",
            }),
        ];

        let mut seen = std::collections::BTreeSet::new();
        let tracked_source_nodes = days
            .iter()
            .filter_map(|day| {
                let node_id = day
                    .get("producer_node_id")
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())?;
                if !seen.insert(node_id.to_string()) {
                    return None;
                }
                Some((
                    node_id.to_string(),
                    day.get("producer_node_name")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string(),
                ))
            })
            .collect::<Vec<_>>();

        assert_eq!(
            tracked_source_nodes,
            vec![
                ("node-local".to_string(), "Local Node".to_string()),
                ("node-remote".to_string(), "Remote Node".to_string())
            ]
        );
    }

    #[test]
    fn compact_view_keeps_tracked_only_rows() {
        assert!(include_compact_spend_history_row(
            true,
            0,
            Some(17.47),
            None,
            None
        ));
        assert!(!include_compact_spend_history_row(
            true, 0, None, None, None
        ));
    }

    #[test]
    fn tracked_spend_target_match_uses_history_day_and_source_node() {
        let updated_at_unix_ms = local_unix_ms(2026, 4, 1, 4, 41, 20);
        let day = serde_json::json!({
            "provider": "aigateway",
            "started_at_unix_ms": local_unix_ms(2026, 4, 1, 0, 58, 0),
            "updated_at_unix_ms": updated_at_unix_ms,
            "tracked_spend_usd": 17.4690825,
            "producer_node_id": "node-local"
        });

        assert!(tracked_spend_day_matches_history_target(
            &day,
            "2026-04-01",
            "node-local",
            "node-local"
        ));
        assert!(!tracked_spend_day_matches_history_target(
            &day,
            "2026-03-31",
            "node-local",
            "node-local"
        ));
        assert!(!tracked_spend_day_matches_history_target(
            &day,
            "2026-04-01",
            "node-remote",
            "node-local"
        ));
    }

    #[test]
    fn tracked_spend_target_match_uses_started_day_for_cross_midnight_rows() {
        let started_at_unix_ms = local_unix_ms(2026, 4, 4, 0, 1, 1);
        let updated_at_unix_ms = local_unix_ms(2026, 4, 5, 0, 1, 2);
        let day = serde_json::json!({
            "provider": "ailongjuanfeng",
            "started_at_unix_ms": started_at_unix_ms,
            "ended_at_unix_ms": updated_at_unix_ms,
            "updated_at_unix_ms": updated_at_unix_ms,
            "tracked_spend_usd": 1.55,
            "producer_node_id": "node-remote"
        });

        assert!(tracked_spend_day_matches_history_target(
            &day,
            "2026-04-04",
            "node-remote",
            "node-local"
        ));
        assert!(!tracked_spend_day_matches_history_target(
            &day,
            "2026-04-05",
            "node-remote",
            "node-local"
        ));
    }

    #[test]
    fn remove_tracked_spend_history_entries_removes_entire_daily_row_and_records_delete_events() {
        let (_tmp, state) = build_test_state();
        let provider = "official";
        let local_node_id = crate::lan_sync::current_local_node_identity()
            .map(|node| node.node_id)
            .unwrap_or_else(|| "node-local".to_string());
        let local_started_at = local_unix_ms(2026, 4, 1, 2, 0, 0);
        let remote_started_at = local_unix_ms(2026, 4, 1, 6, 0, 0);
        state.gateway.store.put_spend_day(
            provider,
            local_started_at,
            &serde_json::json!({
                "provider": provider,
                "started_at_unix_ms": local_started_at,
                "tracked_spend_usd": 10.0,
                "updated_at_unix_ms": local_started_at,
                "producer_node_id": local_node_id,
                "producer_node_name": "Local Node"
            }),
        );
        state.gateway.store.put_remote_spend_day(
            provider,
            "node-remote",
            "Remote Node",
            remote_started_at,
            &serde_json::json!({
                "provider": provider,
                "started_at_unix_ms": remote_started_at,
                "tracked_spend_usd": 7.0,
                "updated_at_unix_ms": remote_started_at
            }),
        );

        let removed =
            remove_tracked_spend_history_entries_impl(&state, provider, "2026-04-01").expect("remove row");

        assert_eq!(removed, 2);
        let remaining = state.gateway.store.list_spend_days(provider);
        assert!(!remaining.iter().any(|day| {
            day.get("started_at_unix_ms").and_then(|value| value.as_u64()) == Some(local_started_at)
        }));
        assert!(!remaining.iter().any(|day| {
            day.get("started_at_unix_ms").and_then(|value| value.as_u64()) == Some(remote_started_at)
                && day.get("producer_node_id").and_then(|value| value.as_str()) == Some("node-remote")
        }));
        let (events, _has_more) = state.gateway.store.list_lan_edit_events_batch(0, None, 20);
        let deletes = events
            .iter()
            .filter(|event| event.entity_type == "tracked_spend_day" && event.op == "delete")
            .map(|event| event.entity_id.clone())
            .collect::<std::collections::BTreeSet<_>>();
        assert!(deletes.iter().any(|entity_id| entity_id.ends_with("|node-local")));
        assert!(deletes.iter().any(|entity_id| entity_id.ends_with("|node-remote")));
    }

    #[test]
    fn remove_tracked_spend_history_entries_also_deletes_local_source_rows_stored_in_remote_table() {
        let (_tmp, state) = build_test_state();
        let provider = "official";
        let local_node_id = crate::lan_sync::current_local_node_identity()
            .map(|node| node.node_id)
            .unwrap_or_else(|| "node-local".to_string());
        let local_started_at = local_unix_ms(2026, 4, 1, 8, 0, 0);
        state.gateway.store.put_remote_spend_day(
            provider,
            &local_node_id,
            "Local Node",
            local_started_at,
            &serde_json::json!({
                "provider": provider,
                "started_at_unix_ms": local_started_at,
                "tracked_spend_usd": 64.802289,
                "updated_at_unix_ms": local_started_at,
                "producer_node_id": local_node_id,
                "producer_node_name": "Local Node"
            }),
        );

        let result = remove_tracked_spend_history_entries_impl(&state, provider, "2026-04-01");

        assert!(
            result.is_ok(),
            "local-source rows in spend_days_remote should still be removable"
        );
        let remaining = state.gateway.store.list_spend_days(provider);
        assert!(!remaining.iter().any(|day| {
            day.get("started_at_unix_ms").and_then(|value| value.as_u64()) == Some(local_started_at)
                && day.get("producer_node_id").and_then(|value| value.as_str())
                    == Some(local_node_id.as_str())
        }));
        let (events, _has_more) = state.gateway.store.list_lan_edit_events_batch(0, None, 20);
        assert!(events.iter().any(|event| {
            event.entity_type == "tracked_spend_day"
                && event.op == "delete"
                && event.entity_id.ends_with(&format!("|{local_node_id}"))
        }));
    }
}
