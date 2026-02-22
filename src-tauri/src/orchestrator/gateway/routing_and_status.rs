async fn health() -> impl IntoResponse {
    Json(json!({"ok": true}))
}

pub(crate) fn provider_has_remaining_quota(quota_snapshots: &Value, provider: &str) -> bool {
    let Some(snap) = quota_snapshots.get(provider) else {
        return true;
    };

    // Budget caps are hard limits. If any configured cap is exhausted,
    // provider is closed regardless of token-style remaining fields.
    let budget_pairs = [
        (
            snap.get("daily_spent_usd").and_then(|v| v.as_f64()),
            snap.get("daily_budget_usd").and_then(|v| v.as_f64()),
        ),
        (
            snap.get("weekly_spent_usd").and_then(|v| v.as_f64()),
            snap.get("weekly_budget_usd").and_then(|v| v.as_f64()),
        ),
        (
            snap.get("monthly_spent_usd").and_then(|v| v.as_f64()),
            snap.get("monthly_budget_usd").and_then(|v| v.as_f64()),
        ),
    ];
    for (spent, budget) in budget_pairs {
        if let (Some(spent), Some(budget)) = (spent, budget) {
            if budget <= 0.0 || spent >= budget {
                return false;
            }
        }
    }

    if let Some(remaining) = snap.get("remaining").and_then(|v| v.as_f64()) {
        return remaining > 0.0;
    }

    let today_used = snap.get("today_used").and_then(|v| v.as_f64());
    let today_added = snap.get("today_added").and_then(|v| v.as_f64());
    if let (Some(used), Some(added)) = (today_used, today_added) {
        return used < added;
    }

    true
}

pub(crate) fn quota_snapshot_confirms_available(quota_snapshots: &Value, provider: &str) -> bool {
    let Some(snap) = quota_snapshots.get(provider) else {
        return false;
    };
    let updated_at_unix_ms = snap
        .get("updated_at_unix_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let last_error = snap
        .get("last_error")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    updated_at_unix_ms > 0
        && last_error.trim().is_empty()
        && provider_has_remaining_quota(quota_snapshots, provider)
}

fn provider_is_routable_for_selection(
    st: &GatewayState,
    cfg: &AppConfig,
    quota_snapshots: &Value,
    provider: &str,
) -> bool {
    if st.router.is_waiting_usage_confirmation(provider) {
        if quota_snapshot_confirms_available(quota_snapshots, provider) {
            st.router.clear_usage_confirmation_requirement(provider);
        } else {
            return false;
        }
    }
    cfg.providers
        .get(provider)
        .is_some_and(|provider_cfg| !provider_cfg.disabled)
        && st.router.is_provider_routable(provider)
        && provider_has_remaining_quota(quota_snapshots, provider)
}

fn fallback_with_quota(
    st: &GatewayState,
    cfg: &AppConfig,
    preferred: &str,
    quota_snapshots: &Value,
) -> String {
    select_fallback_provider(cfg, preferred, |name| {
        provider_is_routable_for_selection(st, cfg, quota_snapshots, name)
    })
}

fn balanced_session_provider_score(session_key: &str, provider: &str) -> u64 {
    // Stable FNV-1a hash; deterministic across process restarts.
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in session_key
        .as_bytes()
        .iter()
        .chain([0xff_u8].iter())
        .chain(provider.as_bytes().iter())
    {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

const BALANCED_ASSIGNMENT_STICKY_MS: u64 = 24 * 60 * 60 * 1000;
const BALANCED_REBALANCE_MARGIN: usize = 2;

fn provider_key_fingerprint(st: &GatewayState, provider: &str) -> Option<u64> {
    st.secrets
        .get_provider_key(provider)
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
        .map(|key| balanced_session_provider_score("provider_api_key", &key))
}

fn provider_balance_bucket(st: &GatewayState, provider: &str) -> String {
    match provider_key_fingerprint(st, provider) {
        Some(fp) => format!("key:{fp:016x}"),
        None => format!("provider:{provider}"),
    }
}

fn providers_share_api_key(st: &GatewayState, left: &str, right: &str) -> bool {
    match (
        provider_key_fingerprint(st, left),
        provider_key_fingerprint(st, right),
    ) {
        (Some(l), Some(r)) => l == r,
        _ => false,
    }
}

fn provider_is_balanced_candidate(
    st: &GatewayState,
    cfg: &AppConfig,
    quota_snapshots: &Value,
    router_snapshot: &HashMap<String, crate::orchestrator::router::ProviderHealthSnapshot>,
    provider: &str,
) -> bool {
    if !provider_is_routable_for_selection(st, cfg, quota_snapshots, provider) {
        return false;
    }
    // Keep "single-session one provider" stable, but once provider enters explicit unhealthy
    // state we should rebalance immediately.
    !router_snapshot
        .get(provider)
        .is_some_and(|snapshot| snapshot.status == "unhealthy")
}

fn load_balanced_assignment_counts(
    st: &GatewayState,
    cfg: &AppConfig,
    now_ms: u64,
) -> (HashMap<String, usize>, HashMap<String, usize>) {
    let mut provider_loads: HashMap<String, usize> = HashMap::new();
    let mut bucket_loads: HashMap<String, usize> = HashMap::new();
    for row in st.store.list_session_route_assignments() {
        if row.session_id.starts_with("peer:") {
            continue;
        }
        if now_ms.saturating_sub(row.assigned_at_unix_ms) >= BALANCED_ASSIGNMENT_STICKY_MS {
            continue;
        }
        if !cfg
            .providers
            .get(&row.provider)
            .is_some_and(|provider_cfg| !provider_cfg.disabled)
        {
            continue;
        }
        *provider_loads.entry(row.provider.clone()).or_insert(0) += 1;
        let bucket = provider_balance_bucket(st, &row.provider);
        *bucket_loads.entry(bucket).or_insert(0) += 1;
    }
    (provider_loads, bucket_loads)
}

fn pick_balanced_provider(
    st: &GatewayState,
    cfg: &AppConfig,
    quota_snapshots: &Value,
    router_snapshot: &HashMap<String, crate::orchestrator::router::ProviderHealthSnapshot>,
    session_key: &str,
    preferred: &str,
) -> Option<(String, usize, usize)> {
    let candidates = provider_iteration_order(cfg)
        .into_iter()
        .filter(|name| {
            provider_is_balanced_candidate(st, cfg, quota_snapshots, router_snapshot, name)
        })
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return None;
    }

    let (provider_loads, bucket_loads) = load_balanced_assignment_counts(st, cfg, unix_ms());
    candidates
        .into_iter()
        .map(|provider| {
            let provider_load = provider_loads.get(&provider).copied().unwrap_or(0);
            let bucket = provider_balance_bucket(st, &provider);
            let bucket_load = bucket_loads.get(&bucket).copied().unwrap_or(0);
            let preferred_rank = if provider == preferred { 0_u8 } else { 1_u8 };
            let hash_rank = balanced_session_provider_score(session_key, &provider);
            (
                provider,
                (bucket_load, preferred_rank, provider_load, hash_rank),
                provider_load,
                bucket_load,
            )
        })
        .min_by_key(|(_, score, _, _)| *score)
        .map(|(provider, _, provider_load, bucket_load)| (provider, provider_load, bucket_load))
}

fn pick_balanced_provider_for_verified_main_session(
    st: &GatewayState,
    cfg: &AppConfig,
    quota_snapshots: &Value,
    router_snapshot: &HashMap<String, crate::orchestrator::router::ProviderHealthSnapshot>,
    session_key: &str,
    preferred: &str,
) -> Option<String> {
    let now_ms = unix_ms();
    let mut assignment = st.store.get_session_route_assignment(session_key);
    if assignment.as_ref().is_some_and(|row| {
        !cfg.providers
            .get(&row.provider)
            .is_some_and(|provider_cfg| !provider_cfg.disabled)
    }) {
        st.store.delete_session_route_assignment(session_key);
        assignment = None;
    }

    let assignment_is_fresh = assignment.as_ref().is_some_and(|row| {
        now_ms.saturating_sub(row.assigned_at_unix_ms) < BALANCED_ASSIGNMENT_STICKY_MS
    });

    if let Some(row) = assignment.as_ref() {
        if assignment_is_fresh
            && provider_is_balanced_candidate(st, cfg, quota_snapshots, router_snapshot, &row.provider)
        {
            return Some(row.provider.clone());
        }
    }

    let best = pick_balanced_provider(
        st,
        cfg,
        quota_snapshots,
        router_snapshot,
        session_key,
        preferred,
    );
    if let Some(row) = assignment.as_ref() {
        let current_usable =
            provider_is_balanced_candidate(st, cfg, quota_snapshots, router_snapshot, &row.provider);
        if current_usable {
            if assignment_is_fresh {
                return Some(row.provider.clone());
            }
            if let Some((best_provider, _, best_bucket_load)) = best.as_ref() {
                if best_provider == &row.provider || providers_share_api_key(st, &row.provider, best_provider)
                {
                    st.store
                        .put_session_route_assignment(session_key, &row.provider, now_ms);
                    return Some(row.provider.clone());
                }
                let (_, bucket_loads) = load_balanced_assignment_counts(st, cfg, now_ms);
                let current_bucket_load = bucket_loads
                    .get(&provider_balance_bucket(st, &row.provider))
                    .copied()
                    .unwrap_or(0);
                if current_bucket_load
                    <= (*best_bucket_load).saturating_add(BALANCED_REBALANCE_MARGIN)
                {
                    st.store
                        .put_session_route_assignment(session_key, &row.provider, now_ms);
                    return Some(row.provider.clone());
                }
            } else {
                return Some(row.provider.clone());
            }
        }
    }

    let (best_provider, _, _) = best?;
    st.store
        .put_session_route_assignment(session_key, &best_provider, now_ms);
    Some(best_provider)
}

fn pick_balanced_provider_for_verified_session(
    st: &GatewayState,
    cfg: &AppConfig,
    quota_snapshots: &Value,
    router_snapshot: &HashMap<String, crate::orchestrator::router::ProviderHealthSnapshot>,
    session_key: &str,
    preferred: &str,
    depth: u8,
) -> Option<String> {
    if depth > 2 || session_key.starts_with("peer:") {
        return None;
    }
    let session = st.client_sessions.read().get(session_key).cloned()?;
    if !session.confirmed_router {
        return None;
    }
    if session.is_agent || session.is_review {
        let parent_sid_value = session
            .agent_parent_session_id
            .clone()
            .or_else(|| {
                let sessions = st.client_sessions.read();
                sessions
                    .values()
                    .filter(|candidate| {
                        candidate.codex_session_id != session_key
                            && candidate.confirmed_router
                            && !candidate.is_agent
                            && !candidate.is_review
                    })
                    .filter(|candidate| {
                        if let (Some(agent_wt), Some(main_wt)) =
                            (session.wt_session.as_deref(), candidate.wt_session.as_deref())
                        {
                            agent_wt.eq_ignore_ascii_case(main_wt)
                        } else {
                            false
                        }
                    })
                    .max_by_key(|candidate| {
                        candidate
                            .last_request_unix_ms
                            .max(candidate.last_discovered_unix_ms)
                    })
                    .map(|candidate| candidate.codex_session_id.clone())
            });
        let parent_sid = parent_sid_value
            .as_deref()
            .map(str::trim)
            .filter(|sid| !sid.is_empty() && *sid != session_key)?;
        return pick_balanced_provider_for_verified_session(
            st,
            cfg,
            quota_snapshots,
            router_snapshot,
            parent_sid,
            preferred,
            depth.saturating_add(1),
        );
    }
    pick_balanced_provider_for_verified_main_session(
        st,
        cfg,
        quota_snapshots,
        router_snapshot,
        session_key,
        preferred,
    )
}

pub(crate) fn decide_provider(
    st: &GatewayState,
    cfg: &AppConfig,
    preferred: &str,
    session_key: &str,
) -> (String, &'static str) {
    let quota_snapshots = st.store.list_quota_snapshots();
    let now_ms = unix_ms();
    // Manual override wins only when the target is still routable under current
    // config/quota constraints; otherwise we fail over.
    if let Some(manual) = st.router.manual_override.read().clone() {
        if provider_is_routable_for_selection(st, cfg, &quota_snapshots, &manual) {
            return (manual, "manual_override");
        }
        return (
            fallback_with_quota(st, cfg, preferred, &quota_snapshots),
            "manual_override_unhealthy",
        );
    }

    let session_has_explicit_preferred = cfg
        .routing
        .session_preferred_providers
        .contains_key(session_key);
    if cfg.routing.route_mode == crate::orchestrator::config::RouteMode::BalancedAuto
        && !session_has_explicit_preferred
    {
        let router_snapshot = st.router.snapshot(now_ms);
        if let Some(provider) = pick_balanced_provider_for_verified_session(
            st,
            cfg,
            &quota_snapshots,
            &router_snapshot,
            session_key,
            preferred,
            0,
        ) {
            return (provider, "balanced_auto");
        }
    }

    if cfg.routing.auto_return_to_preferred {
        let last_provider = st
            .last_used_by_session
            .read()
            .get(session_key)
            .map(|v| v.provider.clone());

        // If we recently failed over away from preferred, keep using the last successful
        // fallback for a short stabilization window to avoid flapping.
        if last_provider.as_deref().is_some_and(|p| p != preferred)
            && st
                .router
                .should_suppress_preferred(preferred, cfg, now_ms)
        {
            if let Some(p) = last_provider {
                if provider_is_routable_for_selection(st, cfg, &quota_snapshots, &p) {
                    return (p, "preferred_stabilizing");
                }
            }
            return (
                fallback_with_quota(st, cfg, preferred, &quota_snapshots),
                "preferred_stabilizing",
            );
        }
    }

    if provider_is_routable_for_selection(st, cfg, &quota_snapshots, preferred) {
        return (preferred.to_string(), "preferred_healthy");
    }
    (
        fallback_with_quota(st, cfg, preferred, &quota_snapshots),
        "preferred_unhealthy",
    )
}

// Lightweight HTTP status for gateway health/ops.
// Full dashboard session details (including client_sessions/model fields) are exposed
// by the Tauri `get_status` command in `src-tauri/src/lib.rs`.
async fn status(State(st): State<GatewayState>) -> impl IntoResponse {
    let cfg = st.cfg.read().clone();
    let now = unix_ms();
    let mut providers = st.router.snapshot(now);
    let manual_override = st.router.manual_override.read().clone();

    let recent_events = st.store.list_events_split(5, 5);
    let metrics = st.store.get_metrics();
    let quota = st.store.list_quota_snapshots();
    for (provider_name, snapshot) in providers.iter_mut() {
        if !provider_has_remaining_quota(&quota, provider_name) {
            snapshot.status = "closed".to_string();
            snapshot.cooldown_until_unix_ms = 0;
        }
    }
    let ledgers = st.store.list_ledgers();
    let last_activity = st.last_activity_unix_ms.load(Ordering::Relaxed);
    let active_recent = last_activity > 0 && now.saturating_sub(last_activity) < 2 * 60 * 1000;
    let (active_provider, active_reason) = if active_recent {
        let last = st
            .last_used_by_session
            .read()
            .values()
            .max_by_key(|v| v.unix_ms)
            .cloned();
        (
            last.as_ref().map(|v| v.provider.clone()),
            last.map(|v| v.reason),
        )
    } else {
        (None, None)
    };

    Json(json!({
        "listen": { "host": cfg.listen.host, "port": cfg.listen.port },
        "preferred_provider": cfg.routing.preferred_provider,
        "manual_override": manual_override,
        "providers": providers,
        "metrics": metrics,
        "recent_events": recent_events,
        "active_provider": active_provider,
        "active_reason": active_reason,
        "quota": quota,
        "ledgers": ledgers,
        "last_activity_unix_ms": last_activity
    }))
}

async fn models(
    PeerAddr(peer): PeerAddr,
    State(st): State<GatewayState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Some(resp) = require_gateway_auth(&st, &headers) {
        return resp;
    }
    st.last_activity_unix_ms.store(unix_ms(), Ordering::Relaxed);
    let cfg = st.cfg.read().clone();

    // Respect per-session preferred providers (keyed by Codex session id). Fall back to the global
    // preferred provider.
    let session_key = session_key_from_request(&headers, &Value::Null)
        .or_else(|| codex_session_id_for_display(&headers, &Value::Null))
        .unwrap_or_else(|| format!("peer:{peer}"));

    let preferred = cfg
        .routing
        .session_preferred_providers
        .get(&session_key)
        .filter(|p| cfg.providers.contains_key(*p))
        .map(|s| s.as_str())
        .unwrap_or(cfg.routing.preferred_provider.as_str());

    let (provider_name, _reason) = decide_provider(&st, &cfg, preferred, &session_key);
    let p = match cfg.providers.get(&provider_name) {
        Some(p) => p.clone(),
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error":"no provider"})),
            )
                .into_response()
        }
    };

    let client_auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let api_key = st.secrets.get_provider_key(&provider_name);
    let client_auth = upstream_auth(&st, client_auth);

    // Do not update `client_sessions` for `/v1/models`.
    // Codex may call it opportunistically, and it may not carry a stable Codex session id.

    let timeout = cfg.routing.request_timeout_seconds;
    match st
        .upstream
        .get_json(&p, "/v1/models", api_key.as_deref(), client_auth, timeout)
        .await
    {
        Ok((code, j)) if (200..300).contains(&code) => {
            // Do not update `last_used_by_session` for `/v1/models` since Codex may call it
            // opportunistically. We only want to track actual routing decisions for user
            // requests (/v1/responses) to keep "back to preferred" semantics stable.
            st.router.mark_success(&provider_name, unix_ms());
            (StatusCode::OK, Json(j)).into_response()
        }
        _ => (StatusCode::OK, Json(json!({"object":"list","data":[]}))).into_response(),
    }
}
