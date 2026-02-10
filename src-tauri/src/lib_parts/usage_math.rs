fn local_day_key_from_unix_ms(ts_unix_ms: u64) -> Option<String> {
    let ts = i64::try_from(ts_unix_ms).ok()?;
    let dt = Local.timestamp_millis_opt(ts).single()?;
    Some(dt.format("%Y-%m-%d").to_string())
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
) -> Option<(f64, Option<u64>)> {
    let cfg = pricing_cfg?;
    let mut matched: Option<(f64, Option<u64>, u64)> = None;
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
                .map(|(_, _, started)| period.started_at_unix_ms >= *started)
                .unwrap_or(true);
            if replace {
                matched = Some((
                    period.amount_usd,
                    period.ended_at_unix_ms,
                    period.started_at_unix_ms,
                ));
            }
        }
    }
    if let Some((amount, expires, _)) = matched {
        return Some((amount, expires));
    }
    if cfg.mode == "package_total" && cfg.amount_usd.is_finite() && cfg.amount_usd > 0.0 {
        return Some((cfg.amount_usd, None));
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

