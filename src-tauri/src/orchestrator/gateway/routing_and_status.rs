async fn health() -> impl IntoResponse {
    Json(json!({"ok": true}))
}

pub(crate) fn provider_has_remaining_quota_with_hard_cap(
    cfg: &AppConfig,
    quota_snapshots: &Value,
    provider: &str,
    hard_cap: &crate::orchestrator::secrets::ProviderQuotaHardCapConfig,
) -> bool {
    let Some(snap) = quota_snapshots.get(provider) else {
        return true;
    };

    // Budget caps are hard limits. If any configured cap is exhausted,
    // provider is closed regardless of token-style remaining fields.
    let budget_pairs = [
        (
            hard_cap.daily,
            snap.get("daily_spent_usd").and_then(|v| v.as_f64()),
            snap.get("daily_budget_usd").and_then(|v| v.as_f64()),
        ),
        (
            hard_cap.weekly,
            snap.get("weekly_spent_usd").and_then(|v| v.as_f64()),
            snap.get("weekly_budget_usd").and_then(|v| v.as_f64()),
        ),
        (
            hard_cap.monthly,
            snap.get("monthly_spent_usd").and_then(|v| v.as_f64()),
            snap.get("monthly_budget_usd").and_then(|v| v.as_f64()),
        ),
    ];
    let mut saw_enabled_budget_pair = false;
    for (enabled, spent, budget) in budget_pairs {
        if !enabled {
            continue;
        }
        if let (Some(spent), Some(budget)) = (spent, budget) {
            saw_enabled_budget_pair = true;
            if budget <= 0.0 || spent >= budget {
                return false;
            }
        }
    }

    let prefers_budget_over_remaining = cfg
        .providers
        .get(provider)
        .map(crate::orchestrator::providers::resolve_quota_profile)
        .is_some_and(|profile| profile.ignore_remaining_when_budget_present);
    if prefers_budget_over_remaining && saw_enabled_budget_pair {
        return true;
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

pub(crate) fn quota_snapshot_confirms_available(
    cfg: &AppConfig,
    quota_snapshots: &Value,
    provider: &str,
    hard_cap: &crate::orchestrator::secrets::ProviderQuotaHardCapConfig,
) -> bool {
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
        && provider_has_remaining_quota_with_hard_cap(cfg, quota_snapshots, provider, hard_cap)
}

fn provider_is_routable_for_selection(
    st: &GatewayState,
    cfg: &AppConfig,
    quota_snapshots: &Value,
    provider: &str,
    clear_usage_confirmation_requirement: bool,
) -> bool {
    let hard_cap = st.secrets.get_provider_quota_hard_cap(provider);
    let waiting_usage_confirmation = st.router.is_waiting_usage_confirmation(provider);
    if waiting_usage_confirmation {
        if quota_snapshot_confirms_available(cfg, quota_snapshots, provider, &hard_cap) {
            if clear_usage_confirmation_requirement {
                st.router.clear_usage_confirmation_requirement(provider);
            }
        } else {
            return false;
        }
    }
    let router_routable = if waiting_usage_confirmation && !clear_usage_confirmation_requirement {
        !st.router.is_provider_in_cooldown(provider)
    } else {
        st.router.is_provider_routable(provider)
    };
    cfg.providers
        .get(provider)
        .is_some_and(|provider_cfg| !provider_cfg.disabled)
        && router_routable
        && provider_has_remaining_quota_with_hard_cap(cfg, quota_snapshots, provider, &hard_cap)
}

fn fallback_with_quota(
    st: &GatewayState,
    cfg: &AppConfig,
    preferred: &str,
    quota_snapshots: &Value,
    clear_usage_confirmation_requirement: bool,
) -> String {
    select_fallback_provider(cfg, preferred, |name| {
        provider_is_routable_for_selection(
            st,
            cfg,
            quota_snapshots,
            name,
            clear_usage_confirmation_requirement,
        )
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

const BALANCED_ASSIGNMENT_STICKY_MS: u64 = 2 * 60 * 60 * 1000;
const BALANCED_REBALANCE_MARGIN: usize = 3;
const BALANCED_ASSIGNMENT_CLEANUP_INTERVAL_MS: u64 = 15 * 60 * 1000;
const BALANCED_CAPACITY_FLOOR_RATIO: f64 = 0.25;
const BALANCED_CAPACITY_FIT_RANK_SCALE: f64 = 100.0;
const BALANCED_SESSION_LOAD_WINDOW_MS: u64 = 2 * 60 * 60 * 1000;
const BALANCED_UNHEALTHY_LOAD_PENALTY: u64 = 2;
const BALANCED_DAILY_BUDGET_PRESSURE_EXPONENT: f64 = 2.2;
const BALANCED_DAILY_BUDGET_PRESSURE_SCALE: f64 = 16.0;
const BALANCED_DAILY_BUDGET_PRESSURE_WARN_RATIO: f64 = 0.90;
const BALANCED_DAILY_BUDGET_PRESSURE_CRITICAL_RATIO: f64 = 0.98;
const BALANCED_DAILY_BUDGET_PRESSURE_WARN_FLOOR: u64 = 14;
const BALANCED_DAILY_BUDGET_PRESSURE_CRITICAL_FLOOR: u64 = 20;

fn balanced_assignment_window(unix_ms: u64) -> u64 {
    unix_ms / BALANCED_ASSIGNMENT_STICKY_MS
}

fn balanced_assignment_window_start(unix_ms: u64) -> u64 {
    balanced_assignment_window(unix_ms).saturating_mul(BALANCED_ASSIGNMENT_STICKY_MS)
}

fn assignment_is_fresh_for_current_window(assigned_at_unix_ms: u64, now_ms: u64) -> bool {
    balanced_assignment_window(assigned_at_unix_ms) == balanced_assignment_window(now_ms)
}

fn unhealthy_retry_delay_ms(cfg: &AppConfig) -> u64 {
    cfg.routing.effective_cooldown_seconds().saturating_mul(1000)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BalancedAssignmentPersistMode {
    Full,
    Bootstrap,
}

impl BalancedAssignmentPersistMode {
    fn clears_usage_confirmation_requirement(self) -> bool {
        matches!(self, Self::Full)
    }

    fn allows_assignment_cleanup(self) -> bool {
        matches!(self, Self::Full)
    }

    fn persists_assignments(self) -> bool {
        matches!(self, Self::Full | Self::Bootstrap)
    }

    fn rewrites_existing_assignment(self) -> bool {
        matches!(self, Self::Full)
    }
}

#[derive(Default)]
struct BalancedAssignmentCounts {
    provider_loads: HashMap<String, usize>,
    bucket_loads: HashMap<String, usize>,
}

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

fn provider_capacity_units_for_balancing(
    quota_snapshots: &Value,
    provider: &str,
    hard_cap: &crate::orchestrator::secrets::ProviderQuotaHardCapConfig,
) -> f64 {
    let Some(snap) = quota_snapshots.get(provider) else {
        return 1.0;
    };

    let mut budget_remaining = Vec::new();
    for (enabled, spent, budget) in [
        (
            hard_cap.daily,
            snap.get("daily_spent_usd").and_then(|v| v.as_f64()),
            snap.get("daily_budget_usd").and_then(|v| v.as_f64()),
        ),
        (
            hard_cap.weekly,
            snap.get("weekly_spent_usd").and_then(|v| v.as_f64()),
            snap.get("weekly_budget_usd").and_then(|v| v.as_f64()),
        ),
        (
            hard_cap.monthly,
            snap.get("monthly_spent_usd").and_then(|v| v.as_f64()),
            snap.get("monthly_budget_usd").and_then(|v| v.as_f64()),
        ),
    ] {
        if !enabled {
            continue;
        }
        if let Some(budget) = budget.filter(|v| *v > 0.0) {
            let spent = spent.unwrap_or(0.0).max(0.0);
            budget_remaining.push((budget - spent).max(0.0));
        }
    }

    if !budget_remaining.is_empty() {
        let bottleneck_remaining = budget_remaining
            .into_iter()
            .fold(f64::INFINITY, f64::min)
            .max(0.0);
        return bottleneck_remaining.ln_1p().max(1.0);
    }

    if let Some(remaining) = snap.get("remaining").and_then(|v| v.as_f64()) {
        return remaining.max(0.0).ln_1p().max(1.0);
    }

    if let (Some(used), Some(added)) = (
        snap.get("today_used").and_then(|v| v.as_f64()),
        snap.get("today_added").and_then(|v| v.as_f64()),
    ) {
        return (added - used).max(0.0).ln_1p().max(1.0);
    }

    1.0
}

fn provider_daily_budget_pressure_for_balancing(
    quota_snapshots: &Value,
    provider: &str,
    hard_cap: &crate::orchestrator::secrets::ProviderQuotaHardCapConfig,
) -> u64 {
    let Some(snap) = quota_snapshots.get(provider) else {
        return 0;
    };
    let Some(daily_budget) = snap
        .get("daily_budget_usd")
        .and_then(|v| v.as_f64())
        .filter(|v| *v > 0.0)
    else {
        return 0;
    };
    let daily_spent = snap
        .get("daily_spent_usd")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
        .max(0.0);
    let spent_ratio = (daily_spent / daily_budget).clamp(0.0, 2.0);
    // This is a soft balancing signal and stays active even when hard daily caps are disabled.
    let mut pressure_units = (spent_ratio.powf(BALANCED_DAILY_BUDGET_PRESSURE_EXPONENT)
        * BALANCED_DAILY_BUDGET_PRESSURE_SCALE)
        .round() as u64;
    // Near hard-cap, increase pressure aggressively so routing drains other providers first.
    if hard_cap.daily {
        if spent_ratio >= BALANCED_DAILY_BUDGET_PRESSURE_CRITICAL_RATIO {
            pressure_units = pressure_units.max(BALANCED_DAILY_BUDGET_PRESSURE_CRITICAL_FLOOR);
        } else if spent_ratio >= BALANCED_DAILY_BUDGET_PRESSURE_WARN_RATIO {
            pressure_units = pressure_units.max(BALANCED_DAILY_BUDGET_PRESSURE_WARN_FLOOR);
        }
    }
    pressure_units
}

fn session_demand_ratio_from_usage(request_count: u64, total_tokens: u64) -> f64 {
    if request_count == 0 {
        // Unknown / fresh sessions are usually lighter and should prefer smaller providers.
        return 0.25;
    }
    let avg_tokens_per_request = (total_tokens as f64) / (request_count as f64);
    let request_factor = ((request_count as f64) / 20.0).min(1.0);
    let total_factor = ((total_tokens as f64) / 320_000.0).min(1.0);
    let avg_factor = (avg_tokens_per_request / 16_000.0).min(1.0);
    (0.25 + (request_factor * 0.35) + (total_factor * 0.25) + (avg_factor * 0.25)).min(1.0)
}

fn session_demand_ratio_for_balancing(st: &GatewayState, session_key: &str, now_ms: u64) -> f64 {
    if session_key.trim().is_empty() || session_key.starts_with("peer:") {
        return 0.25;
    }
    let since = now_ms.saturating_sub(BALANCED_SESSION_LOAD_WINDOW_MS);
    let sessions = vec![session_key.to_string()];
    let (request_count, _, _, total_tokens, _, _) = st.store.summarize_usage_requests(
        since,
        Some(since),
        None,
        &[],
        &[],
        &[],
        &[],
        &[],
        &sessions,
    );
    session_demand_ratio_from_usage(request_count, total_tokens)
}

fn provider_per_request_cost_signal(
    st: &GatewayState,
    pricing_map: &std::collections::BTreeMap<String, crate::orchestrator::secrets::ProviderPricingConfig>,
    provider: &str,
    now_ms: u64,
) -> Option<f64> {
    let api_key_ref = st.secrets.get_provider_key(provider).map(|key| {
        let chars: Vec<char> = key.trim().chars().collect();
        if chars.len() < 10 {
            return "set".to_string();
        }
        let start_len = std::cmp::min(6, chars.len().saturating_sub(4));
        let start: String = chars.iter().take(start_len).collect();
        let end: String = chars
            .iter()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        format!("{start}******{end}")
    });
    let pricing = crate::orchestrator::secrets::resolve_provider_pricing_config(
        pricing_map,
        provider,
        api_key_ref.as_deref(),
        now_ms,
    )?;
    if let Some(amount) =
        crate::orchestrator::secrets::pricing_per_request_amount_at(Some(pricing), now_ms)
    {
        return Some(amount);
    }
    if pricing
        .gap_fill_mode
        .as_deref()
        .is_some_and(|gap_mode| gap_mode.trim().eq_ignore_ascii_case("per_request"))
    {
        return pricing
            .gap_fill_amount_usd
            .filter(|value| value.is_finite() && *value > 0.0);
    }
    None
}

fn dense_rank_u64(values: &[u64]) -> HashMap<u64, u64> {
    let mut unique = values.to_vec();
    unique.sort_unstable();
    unique.dedup();
    unique
        .into_iter()
        .enumerate()
        .map(|(index, value)| (value, index as u64))
        .collect()
}

fn provider_is_balanced_candidate(
    st: &GatewayState,
    cfg: &AppConfig,
    quota_snapshots: &Value,
    preferred: &str,
    suppress_preferred: bool,
    provider: &str,
    clear_usage_confirmation_requirement: bool,
) -> bool {
    if suppress_preferred && provider == preferred {
        return false;
    }
    provider_is_routable_for_selection(
        st,
        cfg,
        quota_snapshots,
        provider,
        clear_usage_confirmation_requirement,
    )
}

fn provider_is_unhealthy_or_cooldown(
    router_snapshot: &HashMap<String, crate::orchestrator::router::ProviderHealthSnapshot>,
    provider: &str,
) -> bool {
    router_snapshot.get(provider).is_some_and(|snapshot| {
        snapshot.status == "unhealthy" || snapshot.status == "cooldown"
    })
}

fn provider_is_due_for_unhealthy_retry(
    router_snapshot: &HashMap<String, crate::orchestrator::router::ProviderHealthSnapshot>,
    provider: &str,
    now_ms: u64,
    retry_delay_ms: u64,
) -> bool {
    router_snapshot.get(provider).is_some_and(|snapshot| {
        snapshot.status == "unhealthy"
            && snapshot.last_fail_at_unix_ms > 0
            && now_ms.saturating_sub(snapshot.last_fail_at_unix_ms) >= retry_delay_ms
    })
}

fn load_balanced_assignment_counts(
    st: &GatewayState,
    cfg: &AppConfig,
    now_ms: u64,
    allow_cleanup: bool,
) -> BalancedAssignmentCounts {
    static LAST_BALANCED_ASSIGNMENT_CLEANUP_UNIX_MS: std::sync::atomic::AtomicU64 =
        std::sync::atomic::AtomicU64::new(0);

    let cutoff_unix_ms = balanced_assignment_window_start(now_ms);
    let last_cleanup = LAST_BALANCED_ASSIGNMENT_CLEANUP_UNIX_MS.load(std::sync::atomic::Ordering::Relaxed);
    if allow_cleanup
        && now_ms.saturating_sub(last_cleanup) >= BALANCED_ASSIGNMENT_CLEANUP_INTERVAL_MS
        && LAST_BALANCED_ASSIGNMENT_CLEANUP_UNIX_MS
            .compare_exchange(
                last_cleanup,
                now_ms,
                std::sync::atomic::Ordering::Relaxed,
                std::sync::atomic::Ordering::Relaxed,
            )
            .is_ok()
    {
        let _ = st
            .store
            .delete_session_route_assignments_before(cutoff_unix_ms);
    }

    let mut counts = BalancedAssignmentCounts::default();
    for row in st
        .store
        .list_session_route_assignments_since(cutoff_unix_ms)
    {
        if row.session_id.starts_with("peer:") {
            continue;
        }
        if cfg
            .routing
            .session_preferred_providers
            .contains_key(&row.session_id)
        {
            continue;
        }
        if !cfg
            .providers
            .get(&row.provider)
            .is_some_and(|provider_cfg| !provider_cfg.disabled)
        {
            continue;
        }
        *counts.provider_loads.entry(row.provider.clone()).or_insert(0) += 1;
        let bucket = provider_balance_bucket(st, &row.provider);
        *counts.bucket_loads.entry(bucket).or_insert(0) += 1;
    }
    counts
}

#[allow(clippy::too_many_arguments)]
fn pick_balanced_provider(
    st: &GatewayState,
    cfg: &AppConfig,
    quota_snapshots: &Value,
    router_snapshot: &HashMap<String, crate::orchestrator::router::ProviderHealthSnapshot>,
    assignment_counts: &BalancedAssignmentCounts,
    session_key: &str,
    preferred: &str,
    suppress_preferred: bool,
    clear_usage_confirmation_requirement: bool,
) -> Option<(String, usize, usize)> {
    let now_ms = unix_ms();
    let candidates = provider_iteration_order(cfg)
        .into_iter()
        .filter(|name| {
            provider_is_balanced_candidate(
                st,
                cfg,
                quota_snapshots,
                preferred,
                suppress_preferred,
                name,
                clear_usage_confirmation_requirement,
            )
        })
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return None;
    }

    let mut provider_capacity_units = HashMap::new();
    let mut provider_daily_budget_pressure = HashMap::new();
    for provider in candidates.iter() {
        let hard_cap = st.secrets.get_provider_quota_hard_cap(provider);
        let units =
            provider_capacity_units_for_balancing(quota_snapshots, provider, &hard_cap).max(1.0);
        provider_capacity_units.insert(provider.clone(), units);
        let daily_pressure =
            provider_daily_budget_pressure_for_balancing(quota_snapshots, provider, &hard_cap);
        provider_daily_budget_pressure.insert(provider.clone(), daily_pressure);
    }
    let max_provider_capacity_units = provider_capacity_units
        .values()
        .copied()
        .fold(1.0_f64, f64::max);
    let session_demand_ratio = session_demand_ratio_for_balancing(st, session_key, now_ms);
    let session_cost_sensitivity = 0.5 + session_demand_ratio;
    let provider_pricing = st.secrets.list_provider_pricing();
    let mut provider_costs: HashMap<String, f64> = HashMap::new();
    for provider in candidates.iter() {
        if let Some(cost) = provider_per_request_cost_signal(st, &provider_pricing, provider, now_ms) {
            provider_costs.insert(provider.clone(), cost);
        }
    }
    let min_provider_cost = provider_costs.values().copied().fold(f64::INFINITY, f64::min);
    let has_cost_signal = min_provider_cost.is_finite() && min_provider_cost > 0.0;
    let scored = candidates
        .into_iter()
        .map(|provider| {
            let provider_load = assignment_counts
                .provider_loads
                .get(&provider)
                .copied()
                .unwrap_or(0);
            let bucket = provider_balance_bucket(st, &provider);
            let bucket_load = assignment_counts
                .bucket_loads
                .get(&bucket)
                .copied()
                .unwrap_or(0);
            let provider_capacity_ratio = provider_capacity_units
                .get(&provider)
                .copied()
                .unwrap_or(1.0)
                / max_provider_capacity_units;
            let provider_capacity_ratio =
                provider_capacity_ratio.max(BALANCED_CAPACITY_FLOOR_RATIO);
            let capacity_fit_rank = ((provider_capacity_ratio - session_demand_ratio).abs()
                * BALANCED_CAPACITY_FIT_RANK_SCALE)
                .round() as u64;
            let cost_pressure_rank = if has_cost_signal {
                let provider_cost = provider_costs
                    .get(&provider)
                    .copied()
                    .unwrap_or(min_provider_cost);
                let cost_ratio = (provider_cost / min_provider_cost).max(1.0);
                (cost_ratio.powf(session_cost_sensitivity) * 1000.0).round() as u64
            } else {
                1000_u64
            };
            let unhealthy_penalty = if provider_is_unhealthy_or_cooldown(router_snapshot, &provider)
            {
                BALANCED_UNHEALTHY_LOAD_PENALTY
            } else {
                0_u64
            };
            let daily_budget_pressure_rank = provider_daily_budget_pressure
                .get(&provider)
                .copied()
                .unwrap_or(0);
            // Prefer healthy providers by default, but allow unhealthy retry when load skew is
            // large enough to offset this fixed penalty.
            let provider_pressure_rank = provider_load as u64 + unhealthy_penalty;
            let bucket_pressure_rank = bucket_load as u64 + unhealthy_penalty;
            let preferred_rank = if provider == preferred { 0_u8 } else { 1_u8 };
            let hash_rank = balanced_session_provider_score(session_key, &provider);
            (
                provider,
                bucket_pressure_rank,
                provider_pressure_rank,
                daily_budget_pressure_rank,
                capacity_fit_rank,
                cost_pressure_rank,
                preferred_rank,
                hash_rank,
                provider_load,
                bucket_load,
            )
        })
        .collect::<Vec<_>>();

    let bucket_ranks = dense_rank_u64(
        &scored
            .iter()
            .map(|(_, bucket, _, _, _, _, _, _, _, _)| *bucket)
            .collect::<Vec<_>>(),
    );
    let provider_ranks = dense_rank_u64(
        &scored
            .iter()
            .map(|(_, _, provider, _, _, _, _, _, _, _)| *provider)
            .collect::<Vec<_>>(),
    );
    let daily_ranks = dense_rank_u64(
        &scored
            .iter()
            .map(|(_, _, _, daily, _, _, _, _, _, _)| *daily)
            .collect::<Vec<_>>(),
    );
    let capacity_ranks = dense_rank_u64(
        &scored
            .iter()
            .map(|(_, _, _, _, capacity, _, _, _, _, _)| *capacity)
            .collect::<Vec<_>>(),
    );
    let cost_ranks = dense_rank_u64(
        &scored
            .iter()
            .map(|(_, _, _, _, _, cost, _, _, _, _)| *cost)
            .collect::<Vec<_>>(),
    );

    scored
        .into_iter()
        .min_by_key(
            |(
                _provider,
                bucket_pressure_rank,
                provider_pressure_rank,
                daily_budget_pressure_rank,
                capacity_fit_rank,
                cost_pressure_rank,
                preferred_rank,
                hash_rank,
                _provider_load,
                _bucket_load,
            )| {
                let combined_rank = bucket_ranks
                    .get(bucket_pressure_rank)
                    .copied()
                    .unwrap_or(0)
                    + provider_ranks
                        .get(provider_pressure_rank)
                        .copied()
                        .unwrap_or(0)
                    + daily_ranks
                        .get(daily_budget_pressure_rank)
                        .copied()
                        .unwrap_or(0)
                    + capacity_ranks.get(capacity_fit_rank).copied().unwrap_or(0)
                    + cost_ranks.get(cost_pressure_rank).copied().unwrap_or(0);
                (combined_rank, *preferred_rank, *hash_rank)
            },
        )
        .map(
            |(provider, _, _, _, _, _, _, _, provider_load, bucket_load)| {
                (provider, provider_load, bucket_load)
            },
        )
}

#[allow(clippy::too_many_arguments)]
fn pick_balanced_provider_for_verified_main_session(
    st: &GatewayState,
    cfg: &AppConfig,
    quota_snapshots: &Value,
    router_snapshot: &HashMap<String, crate::orchestrator::router::ProviderHealthSnapshot>,
    session_key: &str,
    preferred: &str,
    suppress_preferred: bool,
    persist_mode: BalancedAssignmentPersistMode,
) -> Option<String> {
    let now_ms = unix_ms();
    let mut assignment = st.store.get_session_route_assignment(session_key);
    let clears_usage_confirmation = persist_mode.clears_usage_confirmation_requirement();
    let persist_assignments = persist_mode.persists_assignments();
    let rewrite_existing_assignment = persist_mode.rewrites_existing_assignment();
    let assignment_counts = load_balanced_assignment_counts(
        st,
        cfg,
        now_ms,
        persist_mode.allows_assignment_cleanup(),
    );
    if assignment.as_ref().is_some_and(|row| {
        !cfg.providers
            .get(&row.provider)
            .is_some_and(|provider_cfg| !provider_cfg.disabled)
    }) {
        if rewrite_existing_assignment {
            st.store.delete_session_route_assignment(session_key);
        }
        assignment = None;
    }

    let assignment_is_fresh = assignment
        .as_ref()
        .is_some_and(|row| assignment_is_fresh_for_current_window(row.assigned_at_unix_ms, now_ms));
    let assignment_is_unhealthy = assignment
        .as_ref()
        .is_some_and(|row| provider_is_unhealthy_or_cooldown(router_snapshot, &row.provider));
    let assignment_retry_due = assignment.as_ref().is_some_and(|row| {
        provider_is_due_for_unhealthy_retry(
            router_snapshot,
            &row.provider,
            now_ms,
            unhealthy_retry_delay_ms(cfg),
        )
    });

    if let Some(row) = assignment.as_ref() {
        let assignment_provider_usable = provider_is_balanced_candidate(
            st,
            cfg,
            quota_snapshots,
            preferred,
            suppress_preferred,
            &row.provider,
            clears_usage_confirmation,
        );
        if assignment_is_fresh {
            if !assignment_is_unhealthy && assignment_provider_usable {
                return Some(row.provider.clone());
            }
            if assignment_is_unhealthy && assignment_retry_due && assignment_provider_usable {
                return Some(row.provider.clone());
            }
        }
    }

    let best = pick_balanced_provider(
        st,
        cfg,
        quota_snapshots,
        router_snapshot,
        &assignment_counts,
        session_key,
        preferred,
        suppress_preferred,
        clears_usage_confirmation,
    );
    if let Some(row) = assignment.as_ref() {
        let current_usable = !assignment_is_unhealthy
            && provider_is_balanced_candidate(
                st,
                cfg,
                quota_snapshots,
                preferred,
                suppress_preferred,
                &row.provider,
                clears_usage_confirmation,
            );
        if current_usable {
            if let Some((best_provider, _, best_bucket_load)) = best.as_ref() {
                if best_provider == &row.provider || providers_share_api_key(st, &row.provider, best_provider)
                {
                    if !assignment_is_fresh && rewrite_existing_assignment {
                        st.store
                            .put_session_route_assignment(session_key, &row.provider, now_ms);
                    }
                    return Some(row.provider.clone());
                }
                let current_bucket_load = assignment_counts
                    .bucket_loads
                    .get(&provider_balance_bucket(st, &row.provider))
                    .copied()
                    .unwrap_or(0);
                if current_bucket_load
                    <= (*best_bucket_load).saturating_add(BALANCED_REBALANCE_MARGIN)
                {
                    if !assignment_is_fresh && rewrite_existing_assignment {
                        st.store
                            .put_session_route_assignment(session_key, &row.provider, now_ms);
                    }
                    return Some(row.provider.clone());
                }
            } else {
                if !assignment_is_fresh && rewrite_existing_assignment {
                    st.store
                        .put_session_route_assignment(session_key, &row.provider, now_ms);
                }
                return Some(row.provider.clone());
            }
        }
    }

    let (best_provider, _, _) = best?;
    let should_persist_selected = match assignment.as_ref() {
        None => true,
        Some(row) => {
            if assignment_is_fresh && assignment_is_unhealthy && row.provider != best_provider {
                false
            } else {
                rewrite_existing_assignment || row.provider != best_provider
            }
        }
    };
    if persist_assignments && should_persist_selected {
        st.store
            .put_session_route_assignment(session_key, &best_provider, now_ms);
    }
    Some(best_provider)
}

#[allow(clippy::too_many_arguments)]
fn pick_balanced_provider_for_verified_session(
    st: &GatewayState,
    cfg: &AppConfig,
    quota_snapshots: &Value,
    router_snapshot: &HashMap<String, crate::orchestrator::router::ProviderHealthSnapshot>,
    session_key: &str,
    preferred: &str,
    suppress_preferred: bool,
    persist_mode: BalancedAssignmentPersistMode,
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
            suppress_preferred,
            persist_mode,
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
        suppress_preferred,
        persist_mode,
    )
}

fn decide_provider_with_balanced_mode(
    st: &GatewayState,
    cfg: &AppConfig,
    preferred: &str,
    session_key: &str,
    balanced_persist_mode: BalancedAssignmentPersistMode,
) -> (String, &'static str) {
    let quota_snapshots = st.store.list_quota_snapshots();
    let now_ms = unix_ms();
    let clear_usage_confirmation_requirement =
        balanced_persist_mode.clears_usage_confirmation_requirement();
    if cfg.routing.route_mode == crate::orchestrator::config::RouteMode::BalancedAuto
        && clear_usage_confirmation_requirement
    {
        let router_snapshot_for_recovery = st.router.snapshot(now_ms);
        let mut quota_closed_states: HashMap<String, bool> = HashMap::new();
        for provider_name in cfg.providers.keys() {
            let hard_cap = st.secrets.get_provider_quota_hard_cap(provider_name);
            let is_closed = !provider_has_remaining_quota_with_hard_cap(
                cfg,
                &quota_snapshots,
                provider_name,
                &hard_cap,
            );
            quota_closed_states.insert(provider_name.clone(), is_closed);
        }
        let reopened_providers = st.router.record_quota_closed_states(&quota_closed_states);

        let mut unhealthy_states: HashMap<String, bool> = HashMap::new();
        for provider_name in cfg.providers.keys() {
            let is_unhealthy =
                provider_is_unhealthy_or_cooldown(&router_snapshot_for_recovery, provider_name);
            unhealthy_states.insert(provider_name.clone(), is_unhealthy);
        }
        let recovered_unhealthy_providers = st.router.record_unhealthy_states(&unhealthy_states);
        if !reopened_providers.is_empty() || !recovered_unhealthy_providers.is_empty() {
            let cleared_assignments = st.store.delete_all_session_route_assignments();
            if cleared_assignments > 0 {
                if !reopened_providers.is_empty() {
                    st.store.events().emit(
                        "gateway",
                        crate::orchestrator::store::EventCode::ROUTING_BALANCED_REASSIGN_ON_REOPEN,
                        "cleared balanced assignments after closed provider reopened",
                        json!({
                            "reopened_providers": reopened_providers,
                            "cleared_session_route_assignments": cleared_assignments
                        }),
                    );
                }
                if !recovered_unhealthy_providers.is_empty() {
                    st.store.events().emit(
                        "gateway",
                        crate::orchestrator::store::EventCode::ROUTING_BALANCED_REASSIGN_ON_HEALTH_RECOVERY,
                        "cleared balanced assignments after unhealthy provider recovered",
                        json!({
                            "recovered_providers": recovered_unhealthy_providers,
                            "cleared_session_route_assignments": cleared_assignments
                        }),
                    );
                }
            }
        }
    }
    // Manual override wins only when the target is still routable under current
    // config/quota constraints; otherwise we fail over.
    if let Some(manual) = st.router.manual_override.read().clone() {
        if provider_is_routable_for_selection(
            st,
            cfg,
            &quota_snapshots,
            &manual,
            clear_usage_confirmation_requirement,
        ) {
            return (manual, "manual_override");
        }
        return (
            fallback_with_quota(
                st,
                cfg,
                preferred,
                &quota_snapshots,
                clear_usage_confirmation_requirement,
            ),
            "manual_override_unhealthy",
        );
    }

    let session_has_explicit_preferred = cfg
        .routing
        .session_preferred_providers
        .contains_key(session_key);
    let last_provider = st
        .last_used_by_session
        .read()
        .get(session_key)
        .map(|v| v.provider.clone());
    let suppress_preferred_in_balanced = last_provider
        .as_deref()
        .is_some_and(|p| p != preferred)
        && st
            .router
            .should_suppress_preferred(preferred, cfg, now_ms);
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
            suppress_preferred_in_balanced,
            balanced_persist_mode,
            0,
        ) {
            return (provider, "balanced_auto");
        }
    }

    if cfg.routing.auto_return_to_preferred {
        // If we recently failed over away from preferred, keep using the last successful
        // fallback for a short stabilization window to avoid flapping.
        if last_provider.as_deref().is_some_and(|p| p != preferred)
            && st
                .router
                .should_suppress_preferred(preferred, cfg, now_ms)
        {
            if let Some(p) = last_provider {
                if provider_is_routable_for_selection(
                    st,
                    cfg,
                    &quota_snapshots,
                    &p,
                    clear_usage_confirmation_requirement,
                ) {
                    return (p, "preferred_stabilizing");
                }
            }
            return (
                fallback_with_quota(
                    st,
                    cfg,
                    preferred,
                    &quota_snapshots,
                    clear_usage_confirmation_requirement,
                ),
                "preferred_stabilizing",
            );
        }
    }

    if provider_is_routable_for_selection(
        st,
        cfg,
        &quota_snapshots,
        preferred,
        clear_usage_confirmation_requirement,
    ) {
        return (preferred.to_string(), "preferred_healthy");
    }
    (
        fallback_with_quota(
            st,
            cfg,
            preferred,
            &quota_snapshots,
            clear_usage_confirmation_requirement,
        ),
        "preferred_unhealthy",
    )
}

pub(crate) fn decide_provider(
    st: &GatewayState,
    cfg: &AppConfig,
    preferred: &str,
    session_key: &str,
) -> (String, &'static str) {
    decide_provider_with_balanced_mode(
        st,
        cfg,
        preferred,
        session_key,
        BalancedAssignmentPersistMode::Full,
    )
}

pub(crate) fn decide_provider_for_display(
    st: &GatewayState,
    cfg: &AppConfig,
    preferred: &str,
    session_key: &str,
) -> (String, &'static str) {
    // Display path may bootstrap an initial balanced assignment so idle session cards stay
    // stable, but it must not clear runtime usage-confirmation gates.
    decide_provider_with_balanced_mode(
        st,
        cfg,
        preferred,
        session_key,
        BalancedAssignmentPersistMode::Bootstrap,
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
    let lan_sync = crate::lan_sync::gateway_status_snapshot(cfg.listen.port, &cfg, &st.secrets);
    let windows_firewall = crate::platform::windows_firewall::status_snapshot();

    let recent_events = st
        .store
        .list_recent_error_events(crate::constants::STATUS_RECENT_ERROR_PREVIEW_LIMIT);
    let metrics = st.store.get_metrics();
    let quota = st.store.list_quota_snapshots();
    for (provider_name, snapshot) in providers.iter_mut() {
        let hard_cap = st.secrets.get_provider_quota_hard_cap(provider_name);
        if !provider_has_remaining_quota_with_hard_cap(&cfg, &quota, provider_name, &hard_cap) {
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
        "last_activity_unix_ms": last_activity,
        "lan_sync": lan_sync,
        "windows_firewall": windows_firewall
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
    let cfg = st.cfg.read().clone();

    // Respect per-session preferred providers (keyed by Codex session id). Fall back to the global
    // preferred provider.
    let session_key = codex_session_id_from_request(&headers, &Value::Null)
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
            // requests (/v1/responses) to keep "back to preferred" semantics stable. It also
            // must not update last activity / last_ok, otherwise startup model probes would look
            // like real Codex usage and trigger quota refresh scheduling.
            (StatusCode::OK, Json(j)).into_response()
        }
        _ => (StatusCode::OK, Json(json!({"object":"list","data":[]}))).into_response(),
    }
}

#[cfg(test)]
mod routing_and_status_tests {
    use super::*;

    #[test]
    fn session_demand_ratio_defaults_and_is_bounded() {
        let fresh = session_demand_ratio_from_usage(0, 0);
        assert_eq!(fresh, 0.25);

        let heavy = session_demand_ratio_from_usage(10_000, 1_000_000_000);
        assert!(
            (0.25..=1.0).contains(&heavy),
            "ratio should stay in [0.25, 1.0], got {heavy}"
        );
        assert_eq!(heavy, 1.0, "extremely heavy sessions should saturate at 1.0");
    }

    #[test]
    fn session_demand_ratio_increases_with_usage_weight() {
        let light = session_demand_ratio_from_usage(1, 1_000);
        let medium = session_demand_ratio_from_usage(8, 80_000);
        let heavy = session_demand_ratio_from_usage(15, 200_000);
        assert!(
            light < medium && medium < heavy,
            "expected monotonic demand: light={light}, medium={medium}, heavy={heavy}"
        );
        assert!(
            heavy < 1.0,
            "heavy test sample should stay below saturation for sensitivity; got {heavy}"
        );
    }

    #[test]
    fn session_demand_ratio_with_requests_and_zero_tokens_stays_above_fresh_floor() {
        let fresh = session_demand_ratio_from_usage(0, 0);
        let request_only = session_demand_ratio_from_usage(5, 0);

        assert!(request_only > fresh, "request_only={request_only}, fresh={fresh}");
        assert!(
            request_only < 1.0,
            "request-only usage should remain below saturation, got {request_only}"
        );
    }

    #[test]
    fn provider_capacity_units_returns_floor_for_empty_quota_snapshots() {
        let hard_cap = crate::orchestrator::secrets::ProviderQuotaHardCapConfig::default();
        let units = provider_capacity_units_for_balancing(&json!({}), "p1", &hard_cap);
        assert_eq!(units, 1.0);
    }

    #[test]
    fn provider_capacity_units_returns_floor_when_provider_snapshot_lacks_quota_fields() {
        let hard_cap = crate::orchestrator::secrets::ProviderQuotaHardCapConfig::default();
        // Defaults enable daily/weekly/monthly hard-cap checks, but with no budget fields in the
        // snapshot the budget branch has no usable inputs and we should still fall back to floor.
        let units = provider_capacity_units_for_balancing(
            &json!({
                "p1": { "kind": "token_stats" }
            }),
            "p1",
            &hard_cap,
        );
        assert_eq!(units, 1.0);
    }

    #[test]
    fn provider_daily_budget_pressure_increases_as_daily_budget_is_consumed() {
        let hard_cap = crate::orchestrator::secrets::ProviderQuotaHardCapConfig::default();
        let low = provider_daily_budget_pressure_for_balancing(
            &json!({
                "p1": {
                    "daily_spent_usd": 10.0,
                    "daily_budget_usd": 100.0
                }
            }),
            "p1",
            &hard_cap,
        );
        let high = provider_daily_budget_pressure_for_balancing(
            &json!({
                "p1": {
                    "daily_spent_usd": 96.0,
                    "daily_budget_usd": 100.0
                }
            }),
            "p1",
            &hard_cap,
        );
        assert!(high > low, "high={high}, low={low}");
    }

    #[test]
    fn provider_daily_budget_pressure_defaults_to_zero_without_daily_budget_fields() {
        let hard_cap = crate::orchestrator::secrets::ProviderQuotaHardCapConfig::default();
        let pressure = provider_daily_budget_pressure_for_balancing(
            &json!({
                "p1": {
                    "kind": "token_stats"
                }
            }),
            "p1",
            &hard_cap,
        );
        assert_eq!(pressure, 0);
    }

    #[test]
    fn provider_daily_budget_pressure_is_soft_signal_even_without_hard_daily_cap() {
        let hard_cap = crate::orchestrator::secrets::ProviderQuotaHardCapConfig {
            daily: false,
            ..Default::default()
        };
        let pressure = provider_daily_budget_pressure_for_balancing(
            &json!({
                "p1": {
                    "daily_spent_usd": 50.0,
                    "daily_budget_usd": 100.0
                }
            }),
            "p1",
            &hard_cap,
        );
        assert!(pressure > 0, "pressure should stay as a soft signal; got {pressure}");
    }

    #[test]
    fn provider_daily_budget_pressure_distinguishes_lower_spend_levels() {
        let hard_cap = crate::orchestrator::secrets::ProviderQuotaHardCapConfig::default();
        let very_low = provider_daily_budget_pressure_for_balancing(
            &json!({
                "p1": {
                    "daily_spent_usd": 5.0,
                    "daily_budget_usd": 100.0
                }
            }),
            "p1",
            &hard_cap,
        );
        let medium = provider_daily_budget_pressure_for_balancing(
            &json!({
                "p1": {
                    "daily_spent_usd": 30.0,
                    "daily_budget_usd": 100.0
                }
            }),
            "p1",
            &hard_cap,
        );
        assert!(
            medium > very_low,
            "expected medium spend pressure to exceed very low spend: medium={medium}, very_low={very_low}"
        );
    }

    #[test]
    fn provider_daily_budget_pressure_hard_cap_boosts_near_limit() {
        let hard_cap = crate::orchestrator::secrets::ProviderQuotaHardCapConfig::default();
        let pressure = provider_daily_budget_pressure_for_balancing(
            &json!({
                "p1": {
                    "daily_spent_usd": 98.0,
                    "daily_budget_usd": 100.0
                }
            }),
            "p1",
            &hard_cap,
        );
        assert!(
            pressure >= BALANCED_DAILY_BUDGET_PRESSURE_CRITICAL_FLOOR,
            "expected near-cap pressure floor, got {pressure}"
        );
    }

    #[test]
    fn provider_stays_open_when_budget_fields_show_remaining_capacity_and_token_remaining_is_absent() {
        let cfg = AppConfig::default_config();
        let hard_cap = crate::orchestrator::secrets::ProviderQuotaHardCapConfig::default();
        let available = provider_has_remaining_quota_with_hard_cap(
            &cfg,
            &json!({
                "aigateway2": {
                    "daily_spent_usd": 0.0,
                    "daily_budget_usd": 300.0
                }
            }),
            "aigateway2",
            &hard_cap,
        );
        assert!(
            available,
            "budget-backed providers should stay open when daily spend is below the daily limit"
        );
    }

    #[test]
    fn aigateway_budget_snapshot_ignores_stale_remaining_zero_when_daily_spend_is_below_limit() {
        let mut cfg = AppConfig::default_config();
        cfg.providers.insert(
            "aigateway2".to_string(),
            crate::orchestrator::config::ProviderConfig {
                display_name: "AI Gateway 2".to_string(),
                base_url: "https://aigateway.chat/v1".to_string(),
                usage_adapter: String::new(),
                usage_base_url: None,
                supports_websockets: false,
                group: None,
                disabled: false,
                api_key: String::new(),
            },
        );
        let hard_cap = crate::orchestrator::secrets::ProviderQuotaHardCapConfig::default();
        let available = provider_has_remaining_quota_with_hard_cap(
            &cfg,
            &json!({
                "aigateway2": {
                    "remaining": 0.0,
                    "daily_spent_usd": 0.0,
                    "daily_budget_usd": 300.0
                }
            }),
            "aigateway2",
            &hard_cap,
        );
        assert!(
            available,
            "aigateway should stay open when actual daily spend is below the daily limit even if stale remaining is zero"
        );
    }

    #[test]
    fn dense_rank_u64_assigns_same_rank_to_equal_values() {
        let ranks = dense_rank_u64(&[5, 1, 5, 9, 1]);
        assert_eq!(ranks.get(&1), Some(&0));
        assert_eq!(ranks.get(&5), Some(&1));
        assert_eq!(ranks.get(&9), Some(&2));
    }

    #[test]
    fn assignment_is_fresh_within_same_global_window() {
        let window_ms = BALANCED_ASSIGNMENT_STICKY_MS;
        let assigned_at = window_ms + 1_000;
        let now = window_ms + (30 * 60 * 1000);
        assert!(assignment_is_fresh_for_current_window(assigned_at, now));
    }

    #[test]
    fn assignment_expires_when_global_window_changes() {
        let window_ms = BALANCED_ASSIGNMENT_STICKY_MS;
        let assigned_at = window_ms.saturating_sub(1);
        let now = window_ms + 1;
        assert!(!assignment_is_fresh_for_current_window(assigned_at, now));
    }

    #[test]
    fn assignment_window_start_aligns_to_current_global_window() {
        let window_ms = BALANCED_ASSIGNMENT_STICKY_MS;
        assert_eq!(balanced_assignment_window_start(window_ms.saturating_sub(1)), 0);
        assert_eq!(balanced_assignment_window_start(window_ms + 1234), window_ms);
    }

    #[test]
    fn provider_per_request_cost_signal_handles_primary_and_gap_fill_modes() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = crate::orchestrator::gateway::open_store_dir(tmp.path().join("data"))
            .expect("store");
        let secrets = crate::orchestrator::secrets::SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("primary", "sk-primary-1234").expect("key primary");
        secrets.set_provider_key("renamed", "sk-primary-1234").expect("key renamed");
        secrets.set_provider_key("gap_fill", "sk-gapfill-1234").expect("key gap_fill");
        let now = crate::orchestrator::store::unix_ms();
        let cfg = crate::orchestrator::config::AppConfig::default_config();
        let state = crate::orchestrator::gateway::GatewayState {
            cfg: std::sync::Arc::new(parking_lot::RwLock::new(cfg.clone())),
            router: std::sync::Arc::new(crate::orchestrator::router::RouterState::new(&cfg, now)),
            store,
            upstream: crate::orchestrator::upstream::UpstreamClient::new(),
            secrets: secrets.clone(),
            last_activity_unix_ms: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
            last_used_by_session: std::sync::Arc::new(parking_lot::RwLock::new(HashMap::new())),
            usage_base_speed_cache: std::sync::Arc::new(parking_lot::RwLock::new(HashMap::new())),
            prev_id_support_cache: std::sync::Arc::new(parking_lot::RwLock::new(HashMap::new())),
            client_sessions: std::sync::Arc::new(parking_lot::RwLock::new(HashMap::new())),
        };
        let mut pricing = std::collections::BTreeMap::new();
        pricing.insert(
            "primary".to_string(),
            crate::orchestrator::secrets::ProviderPricingConfig {
                mode: "per_request".to_string(),
                amount_usd: 0.02,
                periods: Vec::new(),
                gap_fill_mode: None,
                gap_fill_amount_usd: None,
            },
        );
        pricing.insert(
            "codex-for.me".to_string(),
            crate::orchestrator::secrets::ProviderPricingConfig {
                mode: "per_request".to_string(),
                amount_usd: 0.0,
                periods: vec![crate::orchestrator::secrets::ProviderPricingPeriod {
                    id: "period-1".to_string(),
                    mode: "per_request".to_string(),
                    amount_usd: 0.017,
                    api_key_ref: "sk-pri******1234".to_string(),
                    started_at_unix_ms: now.saturating_sub(10_000),
                    ended_at_unix_ms: Some(now.saturating_add(10_000)),
                }],
                gap_fill_mode: None,
                gap_fill_amount_usd: None,
            },
        );
        pricing.insert(
            "gap_fill".to_string(),
            crate::orchestrator::secrets::ProviderPricingConfig {
                mode: "per_token".to_string(),
                amount_usd: 0.0,
                periods: Vec::new(),
                gap_fill_mode: Some("per_request".to_string()),
                gap_fill_amount_usd: Some(0.03),
            },
        );
        pricing.insert(
            "none".to_string(),
            crate::orchestrator::secrets::ProviderPricingConfig {
                mode: "per_token".to_string(),
                amount_usd: 0.0,
                periods: Vec::new(),
                gap_fill_mode: Some("per_request".to_string()),
                gap_fill_amount_usd: None,
            },
        );
        pricing.insert(
            "gap_fill_zero".to_string(),
            crate::orchestrator::secrets::ProviderPricingConfig {
                mode: "per_token".to_string(),
                amount_usd: 0.0,
                periods: Vec::new(),
                gap_fill_mode: Some("per_request".to_string()),
                gap_fill_amount_usd: Some(0.0),
            },
        );

        assert_eq!(
            provider_per_request_cost_signal(&state, &pricing, "primary", now),
            Some(0.02)
        );
        assert_eq!(
            provider_per_request_cost_signal(&state, &pricing, "renamed", now),
            Some(0.017)
        );
        assert_eq!(
            provider_per_request_cost_signal(&state, &pricing, "gap_fill", now),
            Some(0.03)
        );
        assert_eq!(provider_per_request_cost_signal(&state, &pricing, "none", now), None);
        assert_eq!(
            provider_per_request_cost_signal(&state, &pricing, "gap_fill_zero", now),
            None
        );
        assert_eq!(provider_per_request_cost_signal(&state, &pricing, "missing", now), None);
    }
}
