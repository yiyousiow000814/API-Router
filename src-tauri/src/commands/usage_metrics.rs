fn normalize_usage_origin(origin: Option<&str>) -> String {
    let normalized = origin
        .map(str::trim)
        .unwrap_or_default()
        .to_ascii_lowercase();
    match normalized.as_str() {
        crate::constants::USAGE_ORIGIN_WINDOWS => crate::constants::USAGE_ORIGIN_WINDOWS,
        crate::constants::USAGE_ORIGIN_WSL2 => crate::constants::USAGE_ORIGIN_WSL2,
        _ => crate::constants::USAGE_ORIGIN_UNKNOWN,
    }
    .to_string()
}

#[tauri::command]
pub(crate) fn get_usage_request_entries(
    state: tauri::State<'_, app_state::AppState>,
    hours: Option<u64>,
    providers: Option<Vec<String>>,
    models: Option<Vec<String>>,
    origins: Option<Vec<String>>,
    limit: Option<u64>,
    offset: Option<u64>,
) -> serde_json::Value {
    let now = unix_ms();
    let window_hours = hours.unwrap_or(24).clamp(1, 24 * 365 * 20);
    let window_ms = window_hours.saturating_mul(60 * 60 * 1000);
    let since_unix_ms = now.saturating_sub(window_ms);
    let provider_filter: BTreeSet<String> = providers
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    let model_filter: BTreeSet<String> = models
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    let origin_filter: BTreeSet<String> = origins
        .unwrap_or_default()
        .into_iter()
        .map(|s| normalize_usage_origin(Some(&s)))
        .collect();
    let has_provider_filter = !provider_filter.is_empty();
    let has_model_filter = !model_filter.is_empty();
    let has_origin_filter = !origin_filter.is_empty();

    let page_limit = limit.unwrap_or(200).clamp(1, 1000) as usize;
    let page_offset = offset.unwrap_or(0) as usize;

    let provider_filter_list: Vec<String> = if has_provider_filter {
        provider_filter.iter().cloned().collect()
    } else {
        Vec::new()
    };
    let model_filter_list: Vec<String> = if has_model_filter {
        model_filter.iter().cloned().collect()
    } else {
        Vec::new()
    };
    let origin_filter_list: Vec<String> = if has_origin_filter {
        origin_filter.iter().cloned().collect()
    } else {
        Vec::new()
    };
    let (rows, has_more) = state.gateway.store.list_usage_requests_page(
        since_unix_ms,
        &provider_filter_list,
        &model_filter_list,
        &origin_filter_list,
        page_limit,
        page_offset,
    );

    serde_json::json!({
        "ok": true,
        "rows": rows,
        "has_more": has_more,
        "next_offset": page_offset.saturating_add(rows.len()),
    })
}

#[tauri::command]
pub(crate) fn get_usage_statistics(
    state: tauri::State<'_, app_state::AppState>,
    hours: Option<u64>,
    providers: Option<Vec<String>>,
    models: Option<Vec<String>>,
    origins: Option<Vec<String>>,
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

    fn projection_hours_until_midnight_cap_16() -> f64 {
        let now = Local::now();
        let secs_since_midnight =
            now.hour() as u64 * 3600 + now.minute() as u64 * 60 + now.second() as u64;
        let secs_to_midnight = 24 * 3600_u64 - secs_since_midnight.min(24 * 3600_u64);
        let hours_to_midnight = secs_to_midnight as f64 / 3600.0;
        hours_to_midnight.clamp(0.0, 16.0)
    }

    #[derive(Clone)]
    struct UsageRow {
        provider: String,
        model: String,
    }

    #[derive(Default)]
    struct ModelAgg {
        requests: u64,
        input_tokens: u64,
        output_tokens: u64,
        total_tokens: u64,
        estimated_total_cost_usd: f64,
        estimated_cost_request_count: u64,
    }

    #[derive(Default)]
    struct ProviderAgg {
        requests: u64,
        total_tokens: u64,
    }

    fn json_num_or_null(value: Option<f64>) -> Value {
        if let Some(v) = value {
            serde_json::json!(round3(v))
        } else {
            Value::Null
        }
    }

    let now = unix_ms();
    let window_hours = hours.unwrap_or(24).clamp(1, 24 * 30);
    let window_ms = window_hours.saturating_mul(60 * 60 * 1000);
    let since_unix_ms = now.saturating_sub(window_ms);
    let provider_filter: BTreeSet<String> = providers
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    let model_filter: BTreeSet<String> = models
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    let origin_filter: BTreeSet<String> = origins
        .unwrap_or_default()
        .into_iter()
        .map(|s| normalize_usage_origin(Some(&s)))
        .collect();
    let has_provider_filter = !provider_filter.is_empty();
    let has_model_filter = !model_filter.is_empty();
    let has_origin_filter = !origin_filter.is_empty();
    let bucket_ms = if window_hours <= 48 {
        60 * 60 * 1000
    } else {
        24 * 60 * 60 * 1000
    };
    let active_bucket_ms = 60 * 60 * 1000;
    let projection_hours = projection_hours_until_midnight_cap_16();

    let records = state.gateway.store.list_usage_requests(usize::MAX);
    let quota = state.gateway.store.list_quota_snapshots();
    let provider_pricing = state.secrets.list_provider_pricing();

    let mut provider_tokens_24h: BTreeMap<String, u64> = BTreeMap::new();
    let mut provider_active_hour_buckets: BTreeMap<String, BTreeSet<u64>> = BTreeMap::new();
    let mut active_window_hour_buckets: BTreeSet<u64> = BTreeSet::new();
    let mut catalog_providers: BTreeSet<String> = BTreeSet::new();
    let mut catalog_models: BTreeSet<String> = BTreeSet::new();
    let mut catalog_origins: BTreeSet<String> = BTreeSet::new();
    let mut timeline: BTreeMap<u64, (u64, u64, u64, u64)> = BTreeMap::new();
    let mut filtered: Vec<UsageRow> = Vec::new();
    let last_24h_unix_ms = now.saturating_sub(24 * 60 * 60 * 1000);
    let mut total_requests = 0u64;
    let mut total_tokens = 0u64;
    let mut total_cache_creation_tokens = 0u64;
    let mut total_cache_read_tokens = 0u64;
    let mut by_model_map: BTreeMap<String, ModelAgg> = BTreeMap::new();
    let mut by_provider_map: BTreeMap<String, ProviderAgg> = BTreeMap::new();
    let mut provider_req_by_key_in_window: BTreeMap<String, BTreeMap<String, (u64, u64)>> =
        BTreeMap::new();
    let mut provider_req_by_day_in_window: BTreeMap<String, BTreeMap<String, u64>> =
        BTreeMap::new();
    let mut provider_req_by_day_all_from_req: BTreeMap<String, BTreeMap<String, u64>> =
        BTreeMap::new();
    let mut provider_request_timestamps_in_window: BTreeMap<String, Vec<u64>> = BTreeMap::new();

    for rec in records {
        let ts = rec.get("unix_ms").and_then(|v| v.as_u64()).unwrap_or(0);
        let provider = rec
            .get("provider")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        let model = rec
            .get("model")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .unwrap_or("unknown")
            .to_string();
        let origin = normalize_usage_origin(rec.get("origin").and_then(|v| v.as_str()));
        let provider_lc = provider.to_ascii_lowercase();
        let model_lc = model.to_ascii_lowercase();
        let origin_lc = origin.to_ascii_lowercase();
        let input_tokens = rec
            .get("input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let output_tokens = rec
            .get("output_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let total_tokens_row = rec
            .get("total_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(input_tokens.saturating_add(output_tokens));
        let cache_creation_input_tokens = rec
            .get("cache_creation_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let cache_read_input_tokens = rec
            .get("cache_read_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        if ts >= last_24h_unix_ms {
            *provider_tokens_24h.entry(provider.clone()).or_default() += total_tokens_row;
        }
        let provider_matches = !has_provider_filter || provider_filter.contains(&provider_lc);
        let model_matches = !has_model_filter || model_filter.contains(&model_lc);
        let origin_matches = !has_origin_filter || origin_filter.contains(&origin_lc);
        if provider_matches {
            if let Some(day_key) = local_day_key_from_unix_ms(ts) {
                provider_req_by_day_all_from_req
                    .entry(provider.clone())
                    .or_default()
                    .entry(day_key)
                    .and_modify(|cur| *cur = cur.saturating_add(1))
                    .or_insert(1);
            }
        }
        if ts < since_unix_ms {
            continue;
        }
        if model_matches && origin_matches {
            catalog_providers.insert(provider.clone());
        }
        if provider_matches && origin_matches {
            catalog_models.insert(model.clone());
        }
        if provider_matches && model_matches {
            catalog_origins.insert(origin.clone());
        }
        if !provider_matches || !model_matches || !origin_matches {
            continue;
        }
        let api_key_ref = rec
            .get("api_key_ref")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .unwrap_or("-")
            .to_string();

        total_requests = total_requests.saturating_add(1);
        total_tokens = total_tokens.saturating_add(total_tokens_row);
        total_cache_creation_tokens =
            total_cache_creation_tokens.saturating_add(cache_creation_input_tokens);
        total_cache_read_tokens = total_cache_read_tokens.saturating_add(cache_read_input_tokens);

        {
            let entry = by_model_map.entry(model.clone()).or_default();
            entry.requests = entry.requests.saturating_add(1);
            entry.input_tokens = entry.input_tokens.saturating_add(input_tokens);
            entry.output_tokens = entry.output_tokens.saturating_add(output_tokens);
            entry.total_tokens = entry.total_tokens.saturating_add(total_tokens_row);
        }
        {
            let entry = by_provider_map.entry(provider.clone()).or_default();
            entry.requests = entry.requests.saturating_add(1);
            entry.total_tokens = entry.total_tokens.saturating_add(total_tokens_row);
        }
        {
            let key_entry = provider_req_by_key_in_window
                .entry(provider.clone())
                .or_default()
                .entry(api_key_ref)
                .or_insert((0, 0));
            key_entry.0 = key_entry.0.saturating_add(1);
            key_entry.1 = key_entry.1.saturating_add(total_tokens_row);
        }
        provider_request_timestamps_in_window
            .entry(provider.clone())
            .or_default()
            .push(ts);
        if let Some(day_key) = local_day_key_from_unix_ms(ts) {
            provider_req_by_day_in_window
                .entry(provider.clone())
                .or_default()
                .entry(day_key)
                .and_modify(|cur| *cur = cur.saturating_add(1))
                .or_insert(1);
        }

        let active_hour_bucket = aligned_bucket_start_unix_ms(ts, active_bucket_ms)
            .unwrap_or((ts / active_bucket_ms) * active_bucket_ms);
        provider_active_hour_buckets
            .entry(provider.clone())
            .or_default()
            .insert(active_hour_bucket);
        active_window_hour_buckets.insert(active_hour_bucket);

        let bucket =
            aligned_bucket_start_unix_ms(ts, bucket_ms).unwrap_or((ts / bucket_ms) * bucket_ms);
        let entry = timeline.entry(bucket).or_insert((0, 0, 0, 0));
        entry.0 += 1;
        entry.1 += total_tokens_row;
        entry.2 += cache_creation_input_tokens;
        entry.3 += cache_read_input_tokens;

        filtered.push(UsageRow { provider, model });
    }

    let mut provider_daily_cost_per_token: BTreeMap<String, f64> = BTreeMap::new();
    let mut provider_daily_spent_usd: BTreeMap<String, f64> = BTreeMap::new();
    if let Some(qmap) = quota.as_object() {
        for (provider, q) in qmap {
            let kind = q.get("kind").and_then(|v| v.as_str()).unwrap_or("none");
            if kind != "budget_info" {
                continue;
            }
            let Some(spent) = as_f64(q.get("daily_spent_usd")) else {
                continue;
            };
            if spent <= 0.0 {
                continue;
            }
            provider_daily_spent_usd.insert(provider.to_string(), spent);
            let tok = provider_tokens_24h.get(provider).copied().unwrap_or(0);
            if tok > 0 {
                provider_daily_cost_per_token.insert(provider.to_string(), spent / tok as f64);
            }
        }
    }

    let mut provider_avg_req_cost: BTreeMap<String, f64> = BTreeMap::new();
    let mut by_provider: Vec<Value> = Vec::new();
    for (provider, agg) in by_provider_map.iter() {
        let active_hours = provider_active_hour_buckets
            .get(provider)
            .map(|buckets| (buckets.len() as f64).max(1.0))
            .unwrap_or_else(|| (window_hours as f64).max(1.0));
        let req_per_hour = if active_hours > 0.0 {
            agg.requests as f64 / active_hours
        } else {
            0.0
        };
        let pricing_cfg = provider_pricing.get(provider);
        let mode = pricing_cfg
            .map(|cfg| cfg.mode.trim().to_ascii_lowercase())
            .unwrap_or_else(|| "none".to_string());
        let amount_usd = pricing_cfg
            .map(|cfg| cfg.amount_usd)
            .filter(|v| v.is_finite() && *v > 0.0);
        let req_by_day_in_window = provider_req_by_day_in_window.get(provider);
        let usage_days = state.gateway.store.list_usage_days(provider);
        let mut req_by_day: BTreeMap<String, u64> = BTreeMap::new();
        for day in usage_days {
            let Some(day_key) = day.get("day_key").and_then(|v| v.as_str()) else {
                continue;
            };
            let req = day.get("req_count").and_then(|v| v.as_u64()).unwrap_or(0);
            req_by_day
                .entry(day_key.to_string())
                .and_modify(|cur| *cur = cur.saturating_add(req))
                .or_insert(req);
        }
        if let Some(by_day_from_req) = provider_req_by_day_all_from_req.get(provider) {
            for (day_key, req_count) in by_day_from_req {
                req_by_day.entry(day_key.clone()).or_insert(*req_count);
            }
        }
        let mut manual_by_day: BTreeMap<String, (Option<f64>, Option<f64>)> = BTreeMap::new();
        for day in state.gateway.store.list_spend_manual_days(provider) {
            let Some(day_key) = day.get("day_key").and_then(|v| v.as_str()) else {
                continue;
            };
            let manual_total =
                as_f64(day.get("manual_total_usd")).filter(|v| v.is_finite() && *v > 0.0);
            let manual_per_req =
                as_f64(day.get("manual_usd_per_req")).filter(|v| v.is_finite() && *v > 0.0);
            if manual_total.is_some() || manual_per_req.is_some() {
                manual_by_day.insert(day_key.to_string(), (manual_total, manual_per_req));
            }
        }

        let mut total_used_cost_usd: Option<f64> = None;
        let mut estimated_avg_request_cost_usd: Option<f64> = None;
        let mut estimated_daily_cost_usd: Option<f64> = None;
        let mut pricing_source = "none".to_string();
        let mut actual_tracked_spend_usd: Option<f64> = None;
        let mut gap_filled_spend_usd: Option<f64> = None;

        match mode.as_str() {
            "per_request" => {
                let mut timeline_total_used = 0.0_f64;
                let mut timeline_priced_reqs = 0u64;
                if let Some(ts_list) = provider_request_timestamps_in_window.get(provider) {
                    for ts in ts_list {
                        if let Some(per_req) = per_request_amount_at(pricing_cfg, *ts) {
                            timeline_total_used += per_req;
                            timeline_priced_reqs = timeline_priced_reqs.saturating_add(1);
                        }
                    }
                }

                if timeline_priced_reqs > 0 && timeline_total_used > 0.0 {
                    total_used_cost_usd = Some(timeline_total_used);
                    let avg_req = timeline_total_used / timeline_priced_reqs as f64;
                    estimated_avg_request_cost_usd = Some(avg_req);
                    estimated_daily_cost_usd = Some(req_per_hour * projection_hours * avg_req);
                    pricing_source = if has_per_request_timeline(pricing_cfg) {
                        "manual_per_request_timeline".to_string()
                    } else {
                        "manual_per_request".to_string()
                    };
                } else if let Some(per_req) = amount_usd {
                    let total_used = per_req * agg.requests as f64;
                    total_used_cost_usd = Some(total_used);
                    estimated_avg_request_cost_usd = Some(per_req);
                    estimated_daily_cost_usd = Some(req_per_hour * projection_hours * per_req);
                    pricing_source = "manual_per_request".to_string();
                }
            }
            "package_total" => {
                let has_package_timeline = pricing_cfg
                    .map(|cfg| {
                        cfg.periods
                            .iter()
                            .any(|period| period.mode == "package_total")
                    })
                    .unwrap_or(false);
                let scheduled_by_day =
                    package_total_schedule_by_day(pricing_cfg, since_unix_ms, now);
                let forward_window_end = now.saturating_add(window_ms);
                let scheduled_total_by_slots = package_total_window_total_by_day_slots(
                    pricing_cfg,
                    now,
                    forward_window_end,
                    window_hours,
                );
                let mut day_keys: BTreeSet<String> = BTreeSet::new();
                day_keys.extend(scheduled_by_day.keys().cloned());
                day_keys.extend(manual_by_day.keys().cloned());

                let mut scheduled_in_window = 0.0_f64;
                let mut manual_in_window = 0.0_f64;
                let mut total_used = 0.0_f64;

                if manual_by_day.is_empty() {
                    scheduled_in_window = scheduled_total_by_slots;
                    total_used = scheduled_total_by_slots;
                } else {
                    for day_key in day_keys {
                        let scheduled_day = scheduled_by_day.get(&day_key).copied().unwrap_or(0.0);
                        if scheduled_day > 0.0 {
                            scheduled_in_window += scheduled_day;
                        }

                        let manual_window = manual_by_day.get(&day_key).and_then(
                            |(manual_total, manual_per_req)| {
                                let (day_start, day_end) = local_day_range_from_key(&day_key)?;
                                let overlap_start = day_start.max(since_unix_ms);
                                let overlap_end = day_end.min(now);
                                if overlap_end <= overlap_start {
                                    return None;
                                }
                                let ratio = (overlap_end.saturating_sub(overlap_start)) as f64
                                    / (day_end.saturating_sub(day_start).max(1) as f64);
                                let day_req_total =
                                    req_by_day.get(&day_key).copied().unwrap_or(0) as f64;
                                let day_req_in_window = req_by_day_in_window
                                    .and_then(|m| m.get(&day_key))
                                    .copied()
                                    .unwrap_or(0)
                                    as f64;
                                if let Some(v) = manual_total {
                                    if day_req_total > 0.0 {
                                        let req_ratio =
                                            (day_req_in_window / day_req_total).clamp(0.0, 1.0);
                                        Some(*v * req_ratio)
                                    } else if has_model_filter {
                                        Some(0.0)
                                    } else {
                                        Some(*v * ratio)
                                    }
                                } else if let Some(v) = manual_per_req {
                                    if day_req_in_window > 0.0 {
                                        Some(*v * day_req_in_window)
                                    } else if has_model_filter {
                                        Some(0.0)
                                    } else {
                                        Some(*v * day_req_total * ratio)
                                    }
                                } else {
                                    None
                                }
                            },
                        );

                        if let Some(v) = manual_window {
                            if v > 0.0 {
                                manual_in_window += v;
                                total_used += v;
                            }
                        } else if scheduled_day > 0.0 {
                            total_used += scheduled_day;
                        }
                    }
                }

                if total_used > 0.0 {
                    total_used_cost_usd = Some(total_used);
                    if agg.requests > 0 {
                        estimated_avg_request_cost_usd = Some(total_used / agg.requests as f64);
                    }
                    let active_package_total = active_package_total_usd(pricing_cfg, now);
                    if let Some(v) = active_package_total {
                        estimated_daily_cost_usd = Some(v / 30.0);
                    } else if window_hours > 0 {
                        estimated_daily_cost_usd = Some(total_used * 24.0 / window_hours as f64);
                    }
                    pricing_source = if scheduled_in_window > 0.0 && manual_in_window > 0.0 {
                        "manual_package_timeline+manual_history".to_string()
                    } else if scheduled_in_window > 0.0 {
                        "manual_package_timeline".to_string()
                    } else {
                        "manual_history".to_string()
                    };
                    if manual_in_window > 0.0 {
                        gap_filled_spend_usd = Some(manual_in_window);
                    }
                } else if !has_package_timeline {
                    if let Some(package_total) = amount_usd {
                        let total_used = if window_hours >= 30 * 24 {
                            package_total
                        } else {
                            package_total * (window_hours as f64 / (30.0 * 24.0))
                        };
                        total_used_cost_usd = Some(total_used);
                        if agg.requests > 0 {
                            estimated_avg_request_cost_usd = Some(total_used / agg.requests as f64);
                        }
                        estimated_daily_cost_usd = Some(package_total / 30.0);
                        pricing_source = "manual_package_total".to_string();
                    }
                }
            }
            _ => {
                let spend_days = state.gateway.store.list_spend_days(provider);
                let mut tracked_in_window = 0.0_f64;
                for day in spend_days {
                    let tracked = as_f64(day.get("tracked_spend_usd")).unwrap_or(0.0);
                    if tracked <= 0.0 || !tracked.is_finite() {
                        continue;
                    }
                    let started = day
                        .get("started_at_unix_ms")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let Some(day_key) = local_day_key_from_unix_ms(started) else {
                        continue;
                    };
                    let Some((day_start, day_end)) = local_day_range_from_key(&day_key) else {
                        continue;
                    };
                    let overlap_start = day_start.max(since_unix_ms);
                    let overlap_end = day_end.min(now);
                    if overlap_end <= overlap_start {
                        continue;
                    }
                    let time_ratio = (overlap_end.saturating_sub(overlap_start)) as f64
                        / (day_end.saturating_sub(day_start).max(1) as f64);
                    let day_req_total = req_by_day.get(&day_key).copied().unwrap_or(0) as f64;
                    let day_req_in_window = req_by_day_in_window
                        .and_then(|m| m.get(&day_key))
                        .copied()
                        .unwrap_or(0) as f64;
                    let ratio = if day_req_total > 0.0 {
                        (day_req_in_window / day_req_total).clamp(0.0, 1.0)
                    } else if has_model_filter {
                        0.0
                    } else {
                        time_ratio
                    };
                    tracked_in_window += tracked * ratio;
                }

                let mut manual_additional_in_window = 0.0_f64;
                for (day_key, (manual_total, manual_per_req)) in manual_by_day.iter() {
                    let Some((day_start, day_end)) = local_day_range_from_key(day_key) else {
                        continue;
                    };
                    let overlap_start = day_start.max(since_unix_ms);
                    let overlap_end = day_end.min(now);
                    if overlap_end <= overlap_start {
                        continue;
                    }
                    let ratio = (overlap_end.saturating_sub(overlap_start)) as f64
                        / (day_end.saturating_sub(day_start).max(1) as f64);
                    let day_req_total = req_by_day.get(day_key).copied().unwrap_or(0) as f64;
                    let day_req_in_window = req_by_day_in_window
                        .and_then(|m| m.get(day_key))
                        .copied()
                        .unwrap_or(0) as f64;
                    if let Some(v) = manual_total {
                        if day_req_total > 0.0 {
                            let req_ratio = (day_req_in_window / day_req_total).clamp(0.0, 1.0);
                            manual_additional_in_window += *v * req_ratio;
                        } else if has_model_filter {
                            manual_additional_in_window += 0.0;
                        } else {
                            manual_additional_in_window += *v * ratio;
                        }
                    } else if let Some(v) = manual_per_req {
                        if day_req_in_window > 0.0 {
                            manual_additional_in_window += *v * day_req_in_window;
                        } else if has_model_filter {
                            manual_additional_in_window += 0.0;
                        } else {
                            manual_additional_in_window += *v * day_req_total * ratio;
                        }
                    }
                }

                if tracked_in_window > 0.0 || manual_additional_in_window > 0.0 {
                    let total_used = tracked_in_window + manual_additional_in_window;
                    total_used_cost_usd = Some(total_used);
                    if tracked_in_window > 0.0 {
                        actual_tracked_spend_usd = Some(tracked_in_window);
                    }
                    if manual_additional_in_window > 0.0 {
                        gap_filled_spend_usd = Some(manual_additional_in_window);
                    }
                    pricing_source = if tracked_in_window > 0.0 && manual_additional_in_window > 0.0
                    {
                        "provider_budget_api+manual_history".to_string()
                    } else if tracked_in_window > 0.0 {
                        "provider_budget_api".to_string()
                    } else {
                        "manual_history".to_string()
                    };
                } else if let Some(spent_today) = provider_daily_spent_usd.get(provider).copied() {
                    total_used_cost_usd = Some(spent_today);
                    actual_tracked_spend_usd = Some(spent_today);
                    pricing_source = "provider_budget_api_latest_day".to_string();
                } else if let Some(per_tok) = provider_daily_cost_per_token.get(provider).copied() {
                    let estimated = per_tok * agg.total_tokens as f64;
                    if estimated > 0.0 {
                        total_used_cost_usd = Some(estimated);
                        pricing_source = "provider_token_rate".to_string();
                    }
                }

                if let Some(total_used) = total_used_cost_usd {
                    if agg.requests > 0 {
                        let avg = total_used / agg.requests as f64;
                        estimated_avg_request_cost_usd = Some(avg);
                        estimated_daily_cost_usd = Some(req_per_hour * projection_hours * avg);
                    } else if let Some(spent_today) =
                        provider_daily_spent_usd.get(provider).copied()
                    {
                        estimated_daily_cost_usd = Some(spent_today);
                    }
                }

                if total_used_cost_usd.is_none() {
                    if let Some(cfg) = pricing_cfg {
                        let gap_mode = cfg
                            .gap_fill_mode
                            .as_ref()
                            .map(|m| m.trim().to_ascii_lowercase())
                            .unwrap_or_else(|| "none".to_string());
                        let gap_amount = cfg
                            .gap_fill_amount_usd
                            .filter(|v| v.is_finite() && *v > 0.0);
                        if let Some(amount) = gap_amount {
                            match gap_mode.as_str() {
                                "per_request" => {
                                    let total_used = amount * agg.requests as f64;
                                    total_used_cost_usd = Some(total_used);
                                    estimated_avg_request_cost_usd = Some(amount);
                                    estimated_daily_cost_usd =
                                        Some(req_per_hour * projection_hours * amount);
                                    gap_filled_spend_usd = Some(total_used);
                                    pricing_source = "gap_fill_per_request".to_string();
                                }
                                "total" => {
                                    total_used_cost_usd = Some(amount);
                                    if agg.requests > 0 {
                                        let avg = amount / agg.requests as f64;
                                        estimated_avg_request_cost_usd = Some(avg);
                                        estimated_daily_cost_usd =
                                            Some(req_per_hour * projection_hours * avg);
                                    }
                                    gap_filled_spend_usd = Some(amount);
                                    pricing_source = "gap_fill_total".to_string();
                                }
                                "per_day_average" => {
                                    let total_used = amount * (window_hours as f64 / 24.0);
                                    total_used_cost_usd = Some(total_used);
                                    if agg.requests > 0 {
                                        estimated_avg_request_cost_usd =
                                            Some(total_used / agg.requests as f64);
                                    }
                                    estimated_daily_cost_usd = Some(amount);
                                    gap_filled_spend_usd = Some(total_used);
                                    pricing_source = "gap_fill_per_day_average".to_string();
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
        }

        if let Some(avg) = estimated_avg_request_cost_usd {
            if avg > 0.0 {
                provider_avg_req_cost.insert(provider.clone(), avg);
            }
        }

        let key_rows = provider_req_by_key_in_window
            .get(provider)
            .cloned()
            .unwrap_or_else(|| {
                let mut fallback = BTreeMap::new();
                fallback.insert(
                    provider_api_key_ref(&state, provider),
                    (agg.requests, agg.total_tokens),
                );
                fallback
            });
        let total_requests_for_split = agg.requests.max(1);
        for (api_key_ref, (key_requests, key_total_tokens)) in key_rows {
            let request_ratio = key_requests as f64 / total_requests_for_split as f64;
            let key_total_used_cost_usd = total_used_cost_usd.map(|v| v * request_ratio);
            let key_estimated_daily_cost_usd = estimated_daily_cost_usd.map(|v| v * request_ratio);
            let key_avg_request_cost_usd = if key_requests > 0 {
                key_total_used_cost_usd.map(|v| v / key_requests as f64)
            } else {
                None
            };
            let tokens_per_request = if key_requests > 0 {
                Some(key_total_tokens as f64 / key_requests as f64)
            } else {
                None
            };
            let usd_per_million_tokens =
                if let (Some(total_used), true) = (key_total_used_cost_usd, key_total_tokens > 0) {
                    Some(total_used / key_total_tokens as f64 * 1_000_000.0)
                } else {
                    None
                };
            let estimated_cost_request_count = if key_avg_request_cost_usd.is_some() {
                key_requests
            } else {
                0
            };
            by_provider.push(serde_json::json!({
                "provider": provider,
                "api_key_ref": api_key_ref,
                "requests": key_requests,
                "total_tokens": key_total_tokens,
                "tokens_per_request": json_num_or_null(tokens_per_request),
                "estimated_total_cost_usd": round3(key_total_used_cost_usd.unwrap_or(0.0)),
                "estimated_avg_request_cost_usd": json_num_or_null(key_avg_request_cost_usd),
                "usd_per_million_tokens": json_num_or_null(usd_per_million_tokens),
                "estimated_daily_cost_usd": json_num_or_null(key_estimated_daily_cost_usd),
                "total_used_cost_usd": json_num_or_null(key_total_used_cost_usd),
                "pricing_source": pricing_source,
                "estimated_cost_request_count": estimated_cost_request_count,
                "actual_tracked_spend_usd": json_num_or_null(actual_tracked_spend_usd.map(|v| v * request_ratio)),
                "gap_filled_spend_usd": json_num_or_null(gap_filled_spend_usd.map(|v| v * request_ratio))
            }));
        }
    }
    by_provider.sort_by(|a, b| {
        let ar = a.get("requests").and_then(|v| v.as_u64()).unwrap_or(0);
        let br = b.get("requests").and_then(|v| v.as_u64()).unwrap_or(0);
        br.cmp(&ar)
    });

    for row in &filtered {
        if let Some(avg_req) = provider_avg_req_cost.get(&row.provider).copied() {
            if let Some(entry) = by_model_map.get_mut(&row.model) {
                entry.estimated_total_cost_usd += avg_req;
                entry.estimated_cost_request_count =
                    entry.estimated_cost_request_count.saturating_add(1);
            }
        }
    }

    let mut by_model: Vec<Value> = by_model_map
        .into_iter()
        .map(|(model, agg)| {
            let share_pct = if total_requests > 0 {
                (agg.requests as f64 / total_requests as f64) * 100.0
            } else {
                0.0
            };
            let avg_req_cost = if agg.estimated_cost_request_count > 0 {
                agg.estimated_total_cost_usd / agg.estimated_cost_request_count as f64
            } else {
                0.0
            };
            serde_json::json!({
                "model": model,
                "requests": agg.requests,
                "input_tokens": agg.input_tokens,
                "output_tokens": agg.output_tokens,
                "total_tokens": agg.total_tokens,
                "share_pct": round3(share_pct),
                "estimated_total_cost_usd": round3(agg.estimated_total_cost_usd),
                "estimated_avg_request_cost_usd": round3(avg_req_cost),
                "estimated_cost_request_count": agg.estimated_cost_request_count
            })
        })
        .collect();
    by_model.sort_by(|a, b| {
        let ar = a.get("requests").and_then(|v| v.as_u64()).unwrap_or(0);
        let br = b.get("requests").and_then(|v| v.as_u64()).unwrap_or(0);
        br.cmp(&ar)
    });

    let first_bucket = aligned_bucket_start_unix_ms(since_unix_ms, bucket_ms)
        .unwrap_or((since_unix_ms / bucket_ms) * bucket_ms);
    let last_bucket =
        aligned_bucket_start_unix_ms(now, bucket_ms).unwrap_or((now / bucket_ms) * bucket_ms);
    let mut timeline_points: Vec<Value> = Vec::new();
    let mut bucket = first_bucket;
    while bucket <= last_bucket {
        let (requests, tokens, cache_creation_tokens, cache_read_tokens) =
            timeline.get(&bucket).copied().unwrap_or((0, 0, 0, 0));
        timeline_points.push(serde_json::json!({
            "bucket_unix_ms": bucket,
            "requests": requests,
            "total_tokens": tokens,
            "cache_creation_tokens": cache_creation_tokens,
            "cache_read_tokens": cache_read_tokens
        }));
        bucket = bucket.saturating_add(bucket_ms);
        if bucket_ms == 0 {
            break;
        }
    }

    let active_window_hours = active_window_hour_buckets.len() as f64;

    let total_used_cost_usd = by_provider
        .iter()
        .filter_map(|p| p.get("total_used_cost_usd").and_then(|v| v.as_f64()))
        .sum::<f64>();
    let estimated_daily_cost_usd = by_provider
        .iter()
        .filter_map(|p| p.get("estimated_daily_cost_usd").and_then(|v| v.as_f64()))
        .sum::<f64>();
    let filter_providers_json = if has_provider_filter {
        serde_json::json!(provider_filter.into_iter().collect::<Vec<_>>())
    } else {
        Value::Null
    };
    let filter_models_json = if has_model_filter {
        serde_json::json!(model_filter.into_iter().collect::<Vec<_>>())
    } else {
        Value::Null
    };
    let filter_origins_json = if has_origin_filter {
        serde_json::json!(origin_filter.into_iter().collect::<Vec<_>>())
    } else {
        Value::Null
    };
    let catalog_provider_values: Vec<String> = catalog_providers.into_iter().collect();
    let catalog_model_values: Vec<String> = catalog_models.into_iter().collect();
    let catalog_origin_values: Vec<String> = catalog_origins.into_iter().collect();

    serde_json::json!({
      "ok": true,
      "generated_at_unix_ms": now,
      "window_hours": window_hours,
      "filter": {
        "providers": filter_providers_json,
        "models": filter_models_json,
        "origins": filter_origins_json
      },
      "catalog": {
        "providers": catalog_provider_values,
        "models": catalog_model_values,
        "origins": catalog_origin_values
      },
      "bucket_seconds": bucket_ms / 1000,
      "summary": {
        "total_requests": total_requests,
        "total_tokens": total_tokens,
        "active_window_hours": round3(active_window_hours),
        "cache_creation_tokens": total_cache_creation_tokens,
        "cache_read_tokens": total_cache_read_tokens,
        "unique_models": by_model.len(),
        "estimated_total_cost_usd": round3(total_used_cost_usd),
        "estimated_daily_cost_usd": round3(estimated_daily_cost_usd),
        "by_model": by_model,
        "by_provider": by_provider,
        "timeline": timeline_points
      }
    })
}

#[cfg(test)]
mod usage_metrics_tests {
    use super::normalize_usage_origin;

    #[test]
    fn normalize_usage_origin_maps_known_values() {
        assert_eq!(normalize_usage_origin(Some("windows")), "windows");
        assert_eq!(normalize_usage_origin(Some("WSL2")), "wsl2");
    }

    #[test]
    fn normalize_usage_origin_falls_back_to_unknown() {
        assert_eq!(normalize_usage_origin(None), "unknown");
        assert_eq!(normalize_usage_origin(Some("  ")), "unknown");
        assert_eq!(normalize_usage_origin(Some("linux")), "unknown");
    }
}
