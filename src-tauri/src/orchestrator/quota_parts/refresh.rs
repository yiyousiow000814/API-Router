async fn compute_quota_snapshot(
    kind: UsageKind,
    bases: &[String],
    provider_key: Option<&str>,
    usage_token: Option<&str>,
) -> QuotaSnapshot {
    match kind {
        UsageKind::TokenStats => fetch_token_stats_any(bases, provider_key).await,
        UsageKind::BudgetInfo => fetch_budget_info_any(bases, usage_token).await,
        UsageKind::None => {
            if provider_key.is_some() {
                let s = fetch_token_stats_any(bases, provider_key).await;
                if s.last_error.is_empty() {
                    s
                } else if usage_token.is_some() {
                    fetch_budget_info_any(bases, usage_token).await
                } else {
                    s
                }
            } else if usage_token.is_some() {
                fetch_budget_info_any(bases, usage_token).await
            } else {
                let mut out = QuotaSnapshot::empty(UsageKind::None);
                out.last_error = "missing credentials for quota refresh".to_string();
                out
            }
        }
    }
}

fn store_quota_snapshot(st: &GatewayState, provider_name: &str, snap: &QuotaSnapshot) {
    let _ = st.store.put_quota_snapshot(provider_name, &snap.to_json());
    track_budget_spend(st, provider_name, snap);
    if snap.last_error.is_empty() && snap.updated_at_unix_ms > 0 {
        st.store.reset_ledger(provider_name);
    }
    // Avoid spamming the event log on routine/background refreshes. Only surface failures here;
    // user-initiated success summaries are logged by the tauri command layer.
    if !snap.last_error.is_empty() {
        let err = snap.last_error.chars().take(300).collect::<String>();
        st.store.add_event(
            provider_name,
            "error",
            "usage.refresh_failed",
            &format!("usage refresh failed: {err}"),
            Value::Null,
        );
    }
}

fn store_quota_snapshot_silent(st: &GatewayState, provider_name: &str, snap: &QuotaSnapshot) {
    let _ = st.store.put_quota_snapshot(provider_name, &snap.to_json());
    // Propagation writes should not affect per-provider ledgers; only a real refresh should reset.
    // Tracking budget spend here would duplicate the same shared-key delta across propagated
    // providers and inflate total usage cost.
}

fn track_budget_spend(st: &GatewayState, provider_name: &str, snap: &QuotaSnapshot) {
    if snap.kind != UsageKind::BudgetInfo {
        return;
    }
    if !snap.last_error.is_empty() || snap.updated_at_unix_ms == 0 {
        return;
    }
    let Some(current_daily_spent) = snap.daily_spent_usd.filter(|v| v.is_finite() && *v >= 0.0)
    else {
        return;
    };

    let now = snap.updated_at_unix_ms;
    let existing_state = st.store.get_spend_state(provider_name);

    let mut tracking_started_unix_ms = existing_state
        .as_ref()
        .and_then(|s| s.get("tracking_started_unix_ms"))
        .and_then(|v| v.as_u64())
        .unwrap_or(now);
    let mut open_day_started_at_unix_ms = existing_state
        .as_ref()
        .and_then(|s| s.get("open_day_started_at_unix_ms"))
        .and_then(|v| v.as_u64())
        .unwrap_or(now);
    let mut last_seen_daily_spent = existing_state
        .as_ref()
        .and_then(|s| as_f64(s.get("last_seen_daily_spent_usd")))
        .unwrap_or(current_daily_spent);

    // First observed snapshot for this provider: initialize tracking baseline.
    if existing_state.is_none() {
        tracking_started_unix_ms = now;
        open_day_started_at_unix_ms = now;
        last_seen_daily_spent = current_daily_spent;
        let day = serde_json::json!({
            "provider": provider_name,
            "started_at_unix_ms": open_day_started_at_unix_ms,
            "ended_at_unix_ms": Value::Null,
            // First snapshot of the day already includes spend that happened before refresh.
            "tracked_spend_usd": current_daily_spent,
            "last_seen_daily_spent_usd": current_daily_spent,
            "updated_at_unix_ms": now
        });
        st.store
            .put_spend_day(provider_name, open_day_started_at_unix_ms, &day);
    } else {
        let epsilon = 1e-7_f64;
        if current_daily_spent + epsilon < last_seen_daily_spent {
            if let Some(mut prev_day) = st
                .store
                .get_spend_day(provider_name, open_day_started_at_unix_ms)
            {
                if prev_day.get("ended_at_unix_ms").is_none()
                    || prev_day.get("ended_at_unix_ms").is_some_and(Value::is_null)
                {
                    prev_day["ended_at_unix_ms"] = serde_json::json!(now);
                }
                prev_day["updated_at_unix_ms"] = serde_json::json!(now);
                prev_day["last_seen_daily_spent_usd"] = serde_json::json!(last_seen_daily_spent);
                st.store
                    .put_spend_day(provider_name, open_day_started_at_unix_ms, &prev_day);
            }

            open_day_started_at_unix_ms = now;
            let day = serde_json::json!({
                "provider": provider_name,
                "started_at_unix_ms": open_day_started_at_unix_ms,
                "ended_at_unix_ms": Value::Null,
                // New day baseline can be non-zero if first refresh happens after early usage.
                "tracked_spend_usd": current_daily_spent,
                "last_seen_daily_spent_usd": current_daily_spent,
                "updated_at_unix_ms": now
            });
            st.store
                .put_spend_day(provider_name, open_day_started_at_unix_ms, &day);
            last_seen_daily_spent = current_daily_spent;
        } else {
            let delta = (current_daily_spent - last_seen_daily_spent).max(0.0);
            let mut day = st
                .store
                .get_spend_day(provider_name, open_day_started_at_unix_ms)
                .unwrap_or_else(|| {
                    serde_json::json!({
                        "provider": provider_name,
                        "started_at_unix_ms": open_day_started_at_unix_ms,
                        "ended_at_unix_ms": Value::Null,
                        "tracked_spend_usd": 0.0,
                        "last_seen_daily_spent_usd": last_seen_daily_spent,
                        "updated_at_unix_ms": now
                    })
                });
            let tracked = as_f64(day.get("tracked_spend_usd")).unwrap_or(0.0);
            day["tracked_spend_usd"] = serde_json::json!(tracked + delta);
            day["last_seen_daily_spent_usd"] = serde_json::json!(current_daily_spent);
            day["updated_at_unix_ms"] = serde_json::json!(now);
            st.store
                .put_spend_day(provider_name, open_day_started_at_unix_ms, &day);
            last_seen_daily_spent = current_daily_spent;
        }
    }

    let state = serde_json::json!({
        "provider": provider_name,
        "tracking_started_unix_ms": tracking_started_unix_ms,
        "open_day_started_at_unix_ms": open_day_started_at_unix_ms,
        "last_seen_daily_spent_usd": last_seen_daily_spent,
        "updated_at_unix_ms": now
    });
    st.store.put_spend_state(provider_name, &state);
}

async fn propagate_quota_snapshot_shared(
    st: &GatewayState,
    source_provider: &str,
    source_shared_key: &UsageSharedKey,
    snap: &QuotaSnapshot,
) {
    if !snap.last_error.is_empty() || snap.updated_at_unix_ms == 0 {
        return;
    }

    let cfg = st.cfg.read().clone();
    for (name, p) in cfg.providers.iter() {
        if name == source_provider {
            continue;
        }

        let provider_key = st.secrets.get_provider_key(name);
        let mut usage_token = st.secrets.get_usage_token(name);
        if usage_token.is_none() && is_packycode_base(&p.base_url) {
            usage_token = provider_key.clone();
        }

        let bases = candidate_quota_bases(p);
        let Some(shared_base) = bases.first().map(|s| s.as_str()) else {
            continue;
        };
        let shared = usage_shared_key(shared_base, &provider_key, &usage_token);
        if &shared != source_shared_key {
            continue;
        }

        // If the target provider explicitly pins a usage adapter, only propagate matching snapshots.
        // (Auto-detected providers use `UsageKind::None` and can accept either kind.)
        let other_kind = detect_usage_kind(p);
        if other_kind != UsageKind::None && other_kind != snap.kind {
            continue;
        }

        let mut copied = snap.clone();
        copied.effective_usage_base = Some(shared_base.to_string());
        store_quota_snapshot_silent(st, name, &copied);
    }
}

pub async fn refresh_quota_for_provider(st: &GatewayState, provider_name: &str) -> QuotaSnapshot {
    let cfg = st.cfg.read().clone();
    let Some(p) = cfg.providers.get(provider_name) else {
        let mut out = QuotaSnapshot::empty(UsageKind::None);
        out.last_error = format!("unknown provider: {provider_name}");
        return out;
    };

    let provider_key = st.secrets.get_provider_key(provider_name);
    let mut usage_token = st.secrets.get_usage_token(provider_name);
    if usage_token.is_none() && is_packycode_base(&p.base_url) {
        usage_token = provider_key.clone();
    }
    let bases_raw = candidate_quota_bases(p);
    let Some(shared_base) = bases_raw.first().cloned() else {
        let mut out = QuotaSnapshot::empty(UsageKind::None);
        out.last_error = "missing base_url".to_string();
        return out;
    };
    let bases =
        reorder_bases_for_speed(st, provider_name, bases_raw, provider_key.as_deref()).await;
    let effective_base = bases.first().cloned();

    let kind = detect_usage_kind(p);
    let shared_key = usage_shared_key(&shared_base, &provider_key, &usage_token);
    let mut snap = compute_quota_snapshot(
        kind,
        &bases,
        provider_key.as_deref(),
        usage_token.as_deref(),
    )
    .await;
    if snap.effective_usage_base.is_none() {
        snap.effective_usage_base = effective_base;
    }
    store_quota_snapshot(st, provider_name, &snap);
    propagate_quota_snapshot_shared(st, provider_name, &shared_key, &snap).await;
    snap
}

async fn refresh_quota_for_provider_cached(
    st: &GatewayState,
    provider_name: &str,
    cache: &mut HashMap<UsageRequestKey, QuotaSnapshot>,
) -> QuotaSnapshot {
    let cfg = st.cfg.read().clone();
    let Some(p) = cfg.providers.get(provider_name) else {
        let mut out = QuotaSnapshot::empty(UsageKind::None);
        out.last_error = format!("unknown provider: {provider_name}");
        return out;
    };

    let provider_key = st.secrets.get_provider_key(provider_name);
    let mut usage_token = st.secrets.get_usage_token(provider_name);
    if usage_token.is_none() && is_packycode_base(&p.base_url) {
        usage_token = provider_key.clone();
    }
    let bases_raw = candidate_quota_bases(p);
    let Some(shared_base) = bases_raw.first().cloned() else {
        let mut out = QuotaSnapshot::empty(UsageKind::None);
        out.last_error = "missing base_url".to_string();
        return out;
    };
    let bases =
        reorder_bases_for_speed(st, provider_name, bases_raw, provider_key.as_deref()).await;
    let effective_base = bases.first().cloned();

    let kind = detect_usage_kind(p);
    let key = usage_request_key(&bases, &provider_key, &usage_token, kind);
    let shared_key = usage_shared_key(&shared_base, &provider_key, &usage_token);
    let snap = if let Some(existing) = cache.get(&key) {
        existing.clone()
    } else {
        let mut computed = compute_quota_snapshot(
            kind,
            &bases,
            provider_key.as_deref(),
            usage_token.as_deref(),
        )
        .await;
        if computed.effective_usage_base.is_none() {
            computed.effective_usage_base = effective_base.clone();
        }
        cache.insert(key, computed.clone());
        computed
    };
    let mut snap = snap;
    if snap.effective_usage_base.is_none() {
        snap.effective_usage_base = effective_base;
    }
    store_quota_snapshot(st, provider_name, &snap);
    propagate_quota_snapshot_shared(st, provider_name, &shared_key, &snap).await;
    snap
}

fn usage_shared_key_for_provider(st: &GatewayState, provider_name: &str) -> Option<UsageSharedKey> {
    let cfg = st.cfg.read().clone();
    let p = cfg.providers.get(provider_name)?;
    let provider_key = st.secrets.get_provider_key(provider_name);
    let mut usage_token = st.secrets.get_usage_token(provider_name);
    if usage_token.is_none() && is_packycode_base(&p.base_url) {
        usage_token = provider_key.clone();
    }
    let bases = candidate_quota_bases(p);
    let shared_base = bases.first()?.as_str();
    Some(usage_shared_key(shared_base, &provider_key, &usage_token))
}

pub async fn refresh_quota_shared(
    st: &GatewayState,
    provider_name: &str,
) -> Result<Vec<String>, String> {
    let cfg = st.cfg.read().clone();
    if !cfg.providers.contains_key(provider_name) {
        return Err(format!("unknown provider: {provider_name}"));
    }
    let target_key = usage_shared_key_for_provider(st, provider_name);
    let mut cache: HashMap<UsageRequestKey, QuotaSnapshot> = HashMap::new();
    let mut group = Vec::new();

    if let Some(target_key) = target_key {
        for name in cfg.providers.keys() {
            if let Some(key) = usage_shared_key_for_provider(st, name) {
                if key == target_key {
                    group.push(name.clone());
                }
            }
        }
    }

    // Fetch once for the requested provider; the "shared base+key" propagation will update peers.
    let snap = refresh_quota_for_provider_cached(st, provider_name, &mut cache).await;
    if !snap.last_error.is_empty() || snap.updated_at_unix_ms == 0 {
        return Err(if snap.last_error.is_empty() {
            "usage refresh failed".to_string()
        } else {
            snap.last_error
        });
    }

    if group.is_empty() {
        group.push(provider_name.to_string());
    }
    Ok(group)
}

pub async fn refresh_quota_all_with_summary(st: &GatewayState) -> (usize, usize, Vec<String>) {
    let cfg = st.cfg.read().clone();
    let mut cache: HashMap<UsageRequestKey, QuotaSnapshot> = HashMap::new();
    let mut ok = 0usize;
    let mut err = 0usize;
    let mut failed = Vec::new();

    for name in cfg.providers.keys() {
        let snap = refresh_quota_for_provider_cached(st, name, &mut cache).await;
        if snap.last_error.is_empty() && snap.updated_at_unix_ms > 0 {
            ok += 1;
        } else {
            err += 1;
            failed.push(name.clone());
        }
        // Manual/all refresh: keep a small delay so we don't look like a burst/DDOS.
        tokio::time::sleep(Duration::from_millis(120)).await;
    }

    (ok, err, failed)
}

pub async fn run_quota_scheduler(st: GatewayState) {
    let mut next_refresh_unix_ms: HashMap<String, u64> = HashMap::new();

    loop {
        tokio::time::sleep(Duration::from_millis(900)).await;

        let now = unix_ms();
        let last = st.last_activity_unix_ms.load(Ordering::Relaxed);
        let active = last > 0 && now.saturating_sub(last) < 10 * 60 * 1000;
        if !active {
            continue;
        }

        let cfg = st.cfg.read().clone();
        let mut cache: HashMap<UsageRequestKey, QuotaSnapshot> = HashMap::new();
        for (name, p) in cfg.providers.iter() {
            let _ = p;
            let has_any_credential = st.secrets.get_provider_key(name).is_some()
                || st.secrets.get_usage_token(name).is_some();
            if !has_any_credential {
                continue;
            }

            let due = next_refresh_unix_ms.get(name).copied().unwrap_or(0);
            if due != 0 && now < due {
                continue;
            }

            let snap = refresh_quota_for_provider_cached(&st, name, &mut cache).await;
            let jitter_ms = if snap.last_error.is_empty() {
                // When actively used, refresh randomly every 1-5 minutes.
                fastrand::u64(60_000..=300_000)
            } else {
                // On failure, back off a bit more to avoid hammering the provider.
                fastrand::u64(180_000..=600_000)
            };
            next_refresh_unix_ms.insert(name.clone(), now.saturating_add(jitter_ms));

            // Avoid "burst" patterns when multiple providers are due at the same time.
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
    }
}

