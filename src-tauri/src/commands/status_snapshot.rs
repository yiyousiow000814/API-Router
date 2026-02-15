#[tauri::command]
pub(crate) fn get_status(state: tauri::State<'_, app_state::AppState>) -> serde_json::Value {
    let cfg = state.gateway.cfg.read().clone();
    let now = unix_ms();
    state.gateway.router.sync_with_config(&cfg, now);
    let providers = state.gateway.router.snapshot(now);
    let manual_override = state.gateway.router.manual_override.read().clone();
    let recent_events = state.gateway.store.list_events_split(5, 5);
    let metrics = state.gateway.store.get_metrics();
    let quota = state.gateway.store.list_quota_snapshots();
    let ledgers = state.gateway.store.list_ledgers();
    let last_activity = state.gateway.last_activity_unix_ms.load(Ordering::Relaxed);
    let active_recent = last_activity > 0 && now.saturating_sub(last_activity) < 2 * 60 * 1000;
    let (active_provider, active_reason, active_provider_counts) = if active_recent {
        let map = state.gateway.last_used_by_session.read();

        // Multiple Codex sessions can be active simultaneously, potentially routing through different
        // providers. Expose the full active provider set so the UI can mark multiple providers as
        // "effective" at once.
        //
        // Keep this a single pass so `active_provider` (most recent) and `active_provider_counts`
        // share the same time window semantics.
        let mut counts: std::collections::BTreeMap<String, u64> = std::collections::BTreeMap::new();
        let mut last: Option<crate::orchestrator::gateway::LastUsedRoute> = None;

        for v in map.values() {
            if now.saturating_sub(v.unix_ms) >= 2 * 60 * 1000 {
                continue;
            }
            *counts.entry(v.provider.clone()).or_default() += 1;
            if last
                .as_ref()
                .map(|cur| v.unix_ms > cur.unix_ms)
                .unwrap_or(true)
            {
                last = Some(v.clone());
            }
        }

        (
            last.as_ref().map(|v| v.provider.clone()),
            last.map(|v| v.reason),
            counts,
        )
    } else {
        (None, None, std::collections::BTreeMap::<String, u64>::new())
    };
    let codex_account = state
        .gateway
        .store
        .get_codex_account_snapshot()
        .unwrap_or(serde_json::json!({"ok": false}));

    let client_sessions = {
        // Best-effort: discover running Codex processes configured to use this router, even before
        // the first request is sent (Windows Terminal only).
        let gateway_token = state.secrets.get_gateway_token().unwrap_or_default();
        let expected = (!gateway_token.is_empty()).then_some(gateway_token.as_str());
        let discovered = crate::platform::windows_terminal::discover_sessions_using_router(
            cfg.listen.port,
            expected,
        );

        // Track all discovered sessions, but only allow provider preference changes once we have
        // strong evidence that the session is using this gateway.
        {
            let mut map = state.gateway.client_sessions.write();
            for s in discovered {
                let Some(codex_session_id) = s.codex_session_id.as_deref() else {
                    continue;
                };
                let entry = map.entry(codex_session_id.to_string()).or_insert_with(|| {
                    crate::orchestrator::gateway::ClientSessionRuntime {
                        codex_session_id: codex_session_id.to_string(),
                        pid: s.pid,
                        wt_session: Some(s.wt_session.clone()),
                        last_request_unix_ms: 0,
                        last_discovered_unix_ms: 0,
                        last_reported_model_provider: None,
                        last_reported_model: None,
                        last_reported_base_url: None,
                        is_agent: s.is_agent,
                        is_review: s.is_review,
                        confirmed_router: s.router_confirmed,
                    }
                });
                entry.pid = s.pid;
                entry.wt_session = Some(s.wt_session.clone());
                entry.last_discovered_unix_ms = now;
                apply_discovered_router_confirmation(entry, s.router_confirmed, s.is_agent);
                merge_discovered_model_provider(entry, s.reported_model_provider.as_deref());
                if let Some(bu) = s.reported_base_url.as_deref() {
                    entry.last_reported_base_url = Some(bu.to_string());
                }
                if s.is_agent {
                    entry.is_agent = true;
                }
                if s.is_review {
                    entry.is_review = true;
                    entry.is_agent = true;
                }
            }
            backfill_main_confirmation_from_verified_review(&mut map, now);
        }

        // Drop dead sessions aggressively (e.g. user Ctrl+C'd Codex).
        // We keep the persisted preference mapping in config; only the runtime list is pruned.
        {
            let mut map = state.gateway.client_sessions.write();
            // Some sessions (e.g. non-Windows or when PID inference fails) can have pid=0. Keep them
            // around briefly for UI visibility, but prune if they go cold to avoid unbounded growth.
            const STALE_NO_PID_MS: u64 = 5 * 60 * 1000;
            map.retain(|_, v| {
                let active = v.last_request_unix_ms > 0
                    && now.saturating_sub(v.last_request_unix_ms) < 60_000;
                if v.is_agent && !active {
                    return false;
                }
                if v.pid != 0 && !crate::platform::windows_terminal::is_pid_alive(v.pid) {
                    return false;
                }
                if v.pid == 0 {
                    let last_seen = v.last_request_unix_ms.max(v.last_discovered_unix_ms);
                    if last_seen > 0 && now.saturating_sub(last_seen) > STALE_NO_PID_MS {
                        return false;
                    }
                }
                true
            });
        }

        let map = state.gateway.client_sessions.read().clone();
        let mut items: Vec<_> = map.into_iter().collect();
        items.sort_by_key(|(_k, v)| {
            std::cmp::Reverse(v.last_request_unix_ms.max(v.last_discovered_unix_ms))
        });
        items.truncate(20);
        let sessions = items
            .into_iter()
            .map(|(_codex_session_id, v)| {
                // Consider a session "active" only if it has recently made requests through the router.
                // Discovery scans run frequently and should not keep sessions pinned as active forever.
                let active = v.last_request_unix_ms > 0
                    && now.saturating_sub(v.last_request_unix_ms) < 60_000;

                let codex_id = v.codex_session_id.clone();
                let pref = cfg
                    .routing
                    .session_preferred_providers
                    .get(&codex_id)
                    .cloned()
                    .filter(|p| cfg.providers.contains_key(p));
                let last_seen_unix_ms = v.last_request_unix_ms.max(v.last_discovered_unix_ms);
                serde_json::json!({
                    "id": codex_id,
                    "wt_session": v.wt_session,
                    "codex_session_id": v.codex_session_id,
                    "reported_model_provider": v.last_reported_model_provider,
                    "reported_model": v.last_reported_model,
                    "reported_base_url": v.last_reported_base_url,
                    "last_seen_unix_ms": last_seen_unix_ms,
                    "active": active,
                    "preferred_provider": pref,
                    "verified": v.confirmed_router,
                    "is_agent": v.is_agent,
                    "is_review": v.is_review
                })
            })
            .collect::<Vec<_>>();
        sessions
    };

    serde_json::json!({
      "listen": { "host": cfg.listen.host, "port": cfg.listen.port },
      "preferred_provider": cfg.routing.preferred_provider,
      "manual_override": manual_override,
      "providers": providers,
      "metrics": metrics,
      "recent_events": recent_events,
      "active_provider": active_provider,
      "active_reason": active_reason,
      "active_provider_counts": active_provider_counts,
      "quota": quota,
      "ledgers": ledgers,
      "last_activity_unix_ms": last_activity,
      "codex_account": codex_account,
      "client_sessions": client_sessions
    })
}

fn merge_discovered_model_provider(
    entry: &mut crate::orchestrator::gateway::ClientSessionRuntime,
    discovered_model_provider: Option<&str>,
) {
    let Some(mp) = discovered_model_provider else {
        return;
    };
    if entry.confirmed_router {
        return;
    }
    entry.last_reported_model_provider = Some(mp.to_string());
}

fn apply_discovered_router_confirmation(
    entry: &mut crate::orchestrator::gateway::ClientSessionRuntime,
    router_confirmed: bool,
    discovered_is_agent: bool,
) {
    if !router_confirmed {
        return;
    }
    entry.confirmed_router = true;
    // For verified non-agent sessions discovered before first request, show codex provider as
    // API Router instead of blank to match gateway ownership semantics.
    if !(discovered_is_agent || entry.is_agent) {
        entry.last_reported_model_provider = Some(crate::constants::GATEWAY_MODEL_PROVIDER_ID.to_string());
    }
}

fn backfill_main_confirmation_from_verified_review(
    map: &mut std::collections::HashMap<String, crate::orchestrator::gateway::ClientSessionRuntime>,
    now_unix_ms: u64,
) {
    let anchors: Vec<(u32, Option<String>)> = map
        .values()
        .filter(|v| v.confirmed_router && v.is_review && v.last_discovered_unix_ms == now_unix_ms)
        .map(|v| (v.pid, v.wt_session.clone()))
        .collect();

    if anchors.is_empty() {
        return;
    }

    for entry in map.values_mut() {
        if entry.confirmed_router || entry.is_agent || entry.is_review {
            continue;
        }
        if entry.last_discovered_unix_ms != now_unix_ms {
            continue;
        }
        let same_proc = anchors.iter().any(|(pid, wt)| {
            let pid_match = *pid != 0 && entry.pid != 0 && *pid == entry.pid;
            let wt_match = wt
                .as_deref()
                .zip(entry.wt_session.as_deref())
                .is_some_and(|(a, b)| a == b);
            pid_match || wt_match
        });
        if !same_proc {
            continue;
        }
        entry.confirmed_router = true;
        entry.last_reported_model_provider =
            Some(crate::constants::GATEWAY_MODEL_PROVIDER_ID.to_string());
    }
}

fn local_day_key_from_unix_ms(ts_unix_ms: u64) -> Option<String> {
    let ts = i64::try_from(ts_unix_ms).ok()?;
    let dt = Local.timestamp_millis_opt(ts).single()?;
    Some(dt.format("%Y-%m-%d").to_string())
}

#[cfg(test)]
mod tests {
    use crate::constants::GATEWAY_MODEL_PROVIDER_ID;
    use crate::commands::{
        apply_discovered_router_confirmation, backfill_main_confirmation_from_verified_review,
        merge_discovered_model_provider,
    };
    use crate::orchestrator::gateway::ClientSessionRuntime;

    #[test]
    fn discovered_provider_does_not_override_confirmed_gateway_session() {
        let mut entry = ClientSessionRuntime {
            codex_session_id: "s1".to_string(),
            pid: 1,
            wt_session: None,
            last_request_unix_ms: 1,
            last_discovered_unix_ms: 1,
            last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
            last_reported_model: None,
            last_reported_base_url: None,
            is_agent: false,
            is_review: false,
            confirmed_router: true,
        };
        merge_discovered_model_provider(&mut entry, Some("openai"));
        assert_eq!(
            entry.last_reported_model_provider.as_deref(),
            Some(GATEWAY_MODEL_PROVIDER_ID)
        );
    }

    #[test]
    fn discovered_provider_sets_value_when_session_not_confirmed() {
        let mut entry = ClientSessionRuntime {
            codex_session_id: "s2".to_string(),
            pid: 1,
            wt_session: None,
            last_request_unix_ms: 0,
            last_discovered_unix_ms: 1,
            last_reported_model_provider: None,
            last_reported_model: None,
            last_reported_base_url: None,
            is_agent: false,
            is_review: false,
            confirmed_router: false,
        };
        merge_discovered_model_provider(&mut entry, Some("openai"));
        assert_eq!(entry.last_reported_model_provider.as_deref(), Some("openai"));
    }

    #[test]
    fn confirmed_non_agent_discovery_sets_gateway_provider() {
        let mut entry = ClientSessionRuntime {
            codex_session_id: "s3".to_string(),
            pid: 1,
            wt_session: None,
            last_request_unix_ms: 0,
            last_discovered_unix_ms: 1,
            last_reported_model_provider: None,
            last_reported_model: None,
            last_reported_base_url: None,
            is_agent: false,
            is_review: false,
            confirmed_router: false,
        };
        apply_discovered_router_confirmation(&mut entry, true, false);
        assert!(entry.confirmed_router);
        assert_eq!(
            entry.last_reported_model_provider.as_deref(),
            Some(GATEWAY_MODEL_PROVIDER_ID)
        );
    }

    #[test]
    fn confirmed_agent_discovery_keeps_provider_unset() {
        let mut entry = ClientSessionRuntime {
            codex_session_id: "s4".to_string(),
            pid: 1,
            wt_session: None,
            last_request_unix_ms: 0,
            last_discovered_unix_ms: 1,
            last_reported_model_provider: None,
            last_reported_model: None,
            last_reported_base_url: None,
            is_agent: true,
            is_review: false,
            confirmed_router: false,
        };
        apply_discovered_router_confirmation(&mut entry, true, true);
        assert!(entry.confirmed_router);
        assert_eq!(entry.last_reported_model_provider.as_deref(), None);
    }

    #[test]
    fn verified_review_backfills_main_session_confirmation() {
        let mut map = std::collections::HashMap::new();
        map.insert(
            "main".to_string(),
            ClientSessionRuntime {
                codex_session_id: "main".to_string(),
                pid: 9527,
                wt_session: Some("wt-1".to_string()),
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 1,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                is_agent: false,
                is_review: false,
                confirmed_router: false,
            },
        );
        map.insert(
            "review".to_string(),
            ClientSessionRuntime {
                codex_session_id: "review".to_string(),
                pid: 9527,
                wt_session: Some("wt-1".to_string()),
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 1,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                is_agent: true,
                is_review: true,
                confirmed_router: true,
            },
        );

        backfill_main_confirmation_from_verified_review(&mut map, 1);

        let main = map.get("main").expect("main row");
        assert!(main.confirmed_router);
        assert_eq!(
            main.last_reported_model_provider.as_deref(),
            Some(GATEWAY_MODEL_PROVIDER_ID)
        );
    }

    #[test]
    fn backfill_skips_old_main_session_even_if_same_wt() {
        let mut map = std::collections::HashMap::new();
        map.insert(
            "main_old".to_string(),
            ClientSessionRuntime {
                codex_session_id: "main_old".to_string(),
                pid: 9527,
                wt_session: Some("wt-1".to_string()),
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 1,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                is_agent: false,
                is_review: false,
                confirmed_router: false,
            },
        );
        map.insert(
            "review_now".to_string(),
            ClientSessionRuntime {
                codex_session_id: "review_now".to_string(),
                pid: 9527,
                wt_session: Some("wt-1".to_string()),
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 2,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                is_agent: true,
                is_review: true,
                confirmed_router: true,
            },
        );

        backfill_main_confirmation_from_verified_review(&mut map, 2);

        let main = map.get("main_old").expect("main_old row");
        assert!(!main.confirmed_router);
        assert_eq!(main.last_reported_model_provider.as_deref(), None);
    }
}

fn local_day_range_from_key(day_key: &str) -> Option<(u64, u64)> {
    let date = NaiveDate::parse_from_str(day_key, "%Y-%m-%d").ok()?;
    let start_naive = date.and_hms_opt(0, 0, 0)?;
    let start = match Local.from_local_datetime(&start_naive) {
        LocalResult::Single(dt) => dt,
        LocalResult::Ambiguous(a, b) => a.min(b),
        LocalResult::None => return None,
    };
    let end = start + chrono::Duration::days(1);
    let start_ms = u64::try_from(start.timestamp_millis()).ok()?;
    let end_ms = u64::try_from(end.timestamp_millis()).ok()?;
    Some((start_ms, end_ms))
}

fn add_package_total_segment_by_day(
    by_day: &mut BTreeMap<String, f64>,
    package_total_usd: f64,
    segment_start_unix_ms: u64,
    segment_end_unix_ms: u64,
    window_start_unix_ms: u64,
    window_end_unix_ms: u64,
) {
    if !package_total_usd.is_finite() || package_total_usd <= 0.0 {
        return;
    }
    if segment_end_unix_ms <= segment_start_unix_ms || window_end_unix_ms <= window_start_unix_ms {
        return;
    }
    let overlap_start = segment_start_unix_ms.max(window_start_unix_ms);
    let overlap_end = segment_end_unix_ms.min(window_end_unix_ms);
    if overlap_end <= overlap_start {
        return;
    }

    let month_ms = (30_u64 * 24 * 60 * 60 * 1000) as f64;
    let mut cursor = overlap_start;
    while cursor < overlap_end {
        let Some(day_key) = local_day_key_from_unix_ms(cursor) else {
            break;
        };
        let Some((day_start, day_end)) = local_day_range_from_key(&day_key) else {
            break;
        };
        let part_start = cursor.max(day_start);
        let part_end = overlap_end.min(day_end);
        if part_end > part_start {
            let part_ms = (part_end.saturating_sub(part_start)) as f64;
            let cost = package_total_usd * (part_ms / month_ms);
            by_day
                .entry(day_key)
                .and_modify(|v| *v += cost)
                .or_insert(cost);
        }
        if day_end <= cursor {
            break;
        }
        cursor = day_end;
    }
}

fn package_total_schedule_by_day(
    pricing_cfg: Option<&crate::orchestrator::secrets::ProviderPricingConfig>,
    window_start_unix_ms: u64,
    window_end_unix_ms: u64,
) -> BTreeMap<String, f64> {
    let mut by_day: BTreeMap<String, f64> = BTreeMap::new();
    let Some(cfg) = pricing_cfg else {
        return by_day;
    };
    let mut has_timeline = false;
    for period in cfg.periods.iter() {
        if period.mode != "package_total" {
            continue;
        }
        if !period.amount_usd.is_finite() || period.amount_usd <= 0.0 {
            continue;
        }
        let segment_end = period.ended_at_unix_ms.unwrap_or(window_end_unix_ms);
        add_package_total_segment_by_day(
            &mut by_day,
            period.amount_usd,
            period.started_at_unix_ms,
            segment_end,
            window_start_unix_ms,
            window_end_unix_ms,
        );
        has_timeline = true;
    }
    if !has_timeline
        && cfg.mode == "package_total"
        && cfg.amount_usd.is_finite()
        && cfg.amount_usd > 0.0
    {
        add_package_total_segment_by_day(
            &mut by_day,
            cfg.amount_usd,
            window_start_unix_ms,
            window_end_unix_ms,
            window_start_unix_ms,
            window_end_unix_ms,
        );
    }
    by_day
}

fn package_total_amount_for_slice(
    pricing_cfg: Option<&crate::orchestrator::secrets::ProviderPricingConfig>,
    slice_start_unix_ms: u64,
    slice_end_unix_ms: u64,
) -> Option<f64> {
    let cfg = pricing_cfg?;
    if slice_end_unix_ms <= slice_start_unix_ms {
        return None;
    }
    let mut best: Option<(f64, u64, u64)> = None; // (amount, overlap_ms, started_at)
    let mut has_timeline = false;
    for period in cfg.periods.iter() {
        if period.mode != "package_total" {
            continue;
        }
        if !period.amount_usd.is_finite() || period.amount_usd <= 0.0 {
            continue;
        }
        has_timeline = true;
        let period_end = period.ended_at_unix_ms.unwrap_or(u64::MAX);
        let overlap_start = period.started_at_unix_ms.max(slice_start_unix_ms);
        let overlap_end = period_end.min(slice_end_unix_ms);
        if overlap_end <= overlap_start {
            continue;
        }
        let overlap_ms = overlap_end.saturating_sub(overlap_start);
        let should_replace = best
            .as_ref()
            .map(|(_, cur_overlap, cur_started)| {
                overlap_ms > *cur_overlap
                    || (overlap_ms == *cur_overlap && period.started_at_unix_ms >= *cur_started)
            })
            .unwrap_or(true);
        if should_replace {
            best = Some((period.amount_usd, overlap_ms, period.started_at_unix_ms));
        }
    }
    if let Some((amount, _, _)) = best {
        return Some(amount);
    }
    if !has_timeline
        && cfg.mode == "package_total"
        && cfg.amount_usd.is_finite()
        && cfg.amount_usd > 0.0
    {
        return Some(cfg.amount_usd);
    }
    None
}

fn package_total_window_total_by_day_slots(
    pricing_cfg: Option<&crate::orchestrator::secrets::ProviderPricingConfig>,
    window_start_unix_ms: u64,
    window_end_unix_ms: u64,
    window_hours: u64,
) -> f64 {
    if window_end_unix_ms <= window_start_unix_ms || window_hours == 0 {
        return 0.0;
    }
    let slot_ms = 24_u64 * 60 * 60 * 1000;
    let slot_count = (window_hours / 24).max(1);
    let mut total = 0.0_f64;
    for i in 0..slot_count {
        let slot_end = window_end_unix_ms.saturating_sub(i.saturating_mul(slot_ms));
        if slot_end <= window_start_unix_ms {
            break;
        }
        let slot_start = slot_end.saturating_sub(slot_ms).max(window_start_unix_ms);
        if let Some(monthly_total) =
            package_total_amount_for_slice(pricing_cfg, slot_start, slot_end)
        {
            total += monthly_total / 30.0;
        }
    }
    total
}

fn active_package_period(
    pricing_cfg: Option<&crate::orchestrator::secrets::ProviderPricingConfig>,
    now_unix_ms: u64,
) -> Option<(f64, Option<u64>)> {
    let cfg = pricing_cfg?;
    let mut active: Option<(f64, Option<u64>)> = None;
    let mut active_start = 0u64;
    for period in cfg.periods.iter() {
        if period.mode != "package_total" {
            continue;
        }
        if !period.amount_usd.is_finite() || period.amount_usd <= 0.0 {
            continue;
        }
        let ended = period.ended_at_unix_ms.unwrap_or(u64::MAX);
        if period.started_at_unix_ms <= now_unix_ms
            && now_unix_ms < ended
            && period.started_at_unix_ms >= active_start
        {
            active = Some((period.amount_usd, period.ended_at_unix_ms));
            active_start = period.started_at_unix_ms;
        }
    }
    if active.is_some() {
        return active;
    }
    if cfg.mode == "package_total" && cfg.amount_usd.is_finite() && cfg.amount_usd > 0.0 {
        return Some((cfg.amount_usd, None));
    }
    None
}

fn active_package_total_usd(
    pricing_cfg: Option<&crate::orchestrator::secrets::ProviderPricingConfig>,
    now_unix_ms: u64,
) -> Option<f64> {
    active_package_period(pricing_cfg, now_unix_ms).map(|(amount, _)| amount)
}

fn package_profile_for_day(
    pricing_cfg: Option<&crate::orchestrator::secrets::ProviderPricingConfig>,
    day_start_unix_ms: u64,
) -> Option<(f64, Option<u64>, Option<String>)> {
    let cfg = pricing_cfg?;
    let mut matched: Option<(f64, Option<u64>, u64, String)> = None;
    for period in cfg.periods.iter() {
        if period.mode != "package_total"
            || !period.amount_usd.is_finite()
            || period.amount_usd <= 0.0
        {
            continue;
        }
        let ended = period.ended_at_unix_ms.unwrap_or(u64::MAX);
        if period.started_at_unix_ms <= day_start_unix_ms && day_start_unix_ms < ended {
            let replace = matched
                .as_ref()
                .map(|(_, _, started, _)| period.started_at_unix_ms >= *started)
                .unwrap_or(true);
            if replace {
                matched = Some((
                    period.amount_usd,
                    period.ended_at_unix_ms,
                    period.started_at_unix_ms,
                    period.api_key_ref.clone(),
                ));
            }
        }
    }
    if let Some((amount, expires, _, api_key_ref)) = matched {
        let key = api_key_ref.trim();
        return Some((
            amount,
            expires,
            if key.is_empty() || key == "-" {
                None
            } else {
                Some(key.to_string())
            },
        ));
    }
    if cfg.mode == "package_total" && cfg.amount_usd.is_finite() && cfg.amount_usd > 0.0 {
        return Some((cfg.amount_usd, None, None));
    }
    None
}

fn per_request_amount_at(
    pricing_cfg: Option<&crate::orchestrator::secrets::ProviderPricingConfig>,
    ts_unix_ms: u64,
) -> Option<f64> {
    let cfg = pricing_cfg?;
    let mut matched: Option<(f64, u64)> = None;
    for period in cfg.periods.iter() {
        if period.mode != "per_request"
            || !period.amount_usd.is_finite()
            || period.amount_usd <= 0.0
        {
            continue;
        }
        let ended = period.ended_at_unix_ms.unwrap_or(u64::MAX);
        if period.started_at_unix_ms <= ts_unix_ms && ts_unix_ms < ended {
            let replace = matched
                .as_ref()
                .map(|(_, started)| period.started_at_unix_ms >= *started)
                .unwrap_or(true);
            if replace {
                matched = Some((period.amount_usd, period.started_at_unix_ms));
            }
        }
    }
    if let Some((amount, _)) = matched {
        return Some(amount);
    }
    if cfg.mode == "per_request" && cfg.amount_usd.is_finite() && cfg.amount_usd > 0.0 {
        return Some(cfg.amount_usd);
    }
    None
}

fn has_per_request_timeline(
    pricing_cfg: Option<&crate::orchestrator::secrets::ProviderPricingConfig>,
) -> bool {
    let Some(cfg) = pricing_cfg else {
        return false;
    };
    cfg.periods.iter().any(|period| {
        period.mode == "per_request" && period.amount_usd.is_finite() && period.amount_usd > 0.0
    })
}

fn aligned_bucket_start_unix_ms(ts_unix_ms: u64, bucket_ms: u64) -> Option<u64> {
    if bucket_ms == 24 * 60 * 60 * 1000 {
        let day_key = local_day_key_from_unix_ms(ts_unix_ms)?;
        let (start, _) = local_day_range_from_key(&day_key)?;
        return Some(start);
    }
    if bucket_ms == 60 * 60 * 1000 {
        let ts = i64::try_from(ts_unix_ms).ok()?;
        let dt = Local.timestamp_millis_opt(ts).single()?;
        let hour = dt.with_minute(0)?.with_second(0)?.with_nanosecond(0)?;
        return u64::try_from(hour.timestamp_millis()).ok();
    }
    if bucket_ms == 0 {
        return Some(ts_unix_ms);
    }
    Some((ts_unix_ms / bucket_ms) * bucket_ms)
}
