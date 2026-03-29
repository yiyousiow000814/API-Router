use reqwest::Url;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::time::Duration;

use parking_lot::RwLock;

use super::config::AppConfig;

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProviderHealthSnapshot {
    pub status: String,
    pub consecutive_failures: u32,
    pub cooldown_until_unix_ms: u64,
    pub last_error: String,
    pub last_ok_at_unix_ms: u64,
    pub last_fail_at_unix_ms: u64,
}

#[derive(Debug, Clone)]
struct ProviderHealth {
    state: HealthState,
    consecutive_failures: u32,
    cooldown_until_unix_ms: u64,
    cooldown_from_transient_warnings: bool,
    usage_confirmation_required: bool,
    transient_warning_timestamps_unix_ms: Vec<u64>,
    last_error: String,
    last_ok_at_unix_ms: u64,
    last_fail_at_unix_ms: u64,
}

#[derive(Debug, Clone, Copy)]
enum HealthState {
    Unknown,
    Healthy,
    Unhealthy,
}

impl ProviderHealth {
    fn new(_now_ms: u64) -> Self {
        Self {
            state: HealthState::Unknown,
            consecutive_failures: 0,
            cooldown_until_unix_ms: 0,
            cooldown_from_transient_warnings: false,
            usage_confirmation_required: false,
            transient_warning_timestamps_unix_ms: Vec::new(),
            last_error: String::new(),
            last_ok_at_unix_ms: 0,
            last_fail_at_unix_ms: 0,
        }
    }

    fn in_cooldown(&self) -> bool {
        self.in_cooldown_at(unix_ms())
    }

    fn in_cooldown_at(&self, now_ms: u64) -> bool {
        self.cooldown_until_unix_ms != 0 && now_ms < self.cooldown_until_unix_ms
    }
}

pub struct RouterState {
    pub manual_override: RwLock<Option<String>>,
    health: RwLock<HashMap<String, ProviderHealth>>,
    quota_closed_by_provider: RwLock<HashMap<String, bool>>,
    unhealthy_by_provider: RwLock<HashMap<String, bool>>,
    balanced_main_session_ids: RwLock<Option<BTreeSet<String>>>,
}

fn provider_is_enabled(cfg: &AppConfig, name: &str) -> bool {
    cfg.providers
        .get(name)
        .is_some_and(|provider| !provider.disabled)
}

pub(crate) fn provider_iteration_order(cfg: &AppConfig) -> Vec<String> {
    let mut ordered: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for name in &cfg.provider_order {
        if provider_is_enabled(cfg, name) && seen.insert(name.clone()) {
            ordered.push(name.clone());
        }
    }

    for name in cfg.providers.keys() {
        if provider_is_enabled(cfg, name) && seen.insert(name.clone()) {
            ordered.push(name.clone());
        }
    }

    ordered
}

pub(crate) fn select_fallback_provider<F>(
    cfg: &AppConfig,
    preferred: &str,
    mut is_routable: F,
) -> String
where
    F: FnMut(&str) -> bool,
{
    let preferred_group = provider_group(cfg, preferred);
    let ordered_names = provider_iteration_order(cfg);

    for name in &ordered_names {
        if name == preferred {
            continue;
        }
        if preferred_group.is_some() && provider_group(cfg, name) == preferred_group {
            continue;
        }
        if is_routable(name) {
            return name.clone();
        }
    }

    for name in &ordered_names {
        if name == preferred {
            continue;
        }
        if is_routable(name) {
            return name.clone();
        }
    }

    preferred.to_string()
}

impl RouterState {
    pub fn new(cfg: &AppConfig, now_ms: u64) -> Self {
        let mut health = HashMap::new();
        for name in cfg.providers.keys() {
            health.insert(name.clone(), ProviderHealth::new(now_ms));
        }
        let mut quota_closed_by_provider = HashMap::new();
        let mut unhealthy_by_provider = HashMap::new();
        for name in cfg.providers.keys() {
            quota_closed_by_provider.insert(name.clone(), false);
            unhealthy_by_provider.insert(name.clone(), false);
        }
        Self {
            manual_override: RwLock::new(None),
            health: RwLock::new(health),
            quota_closed_by_provider: RwLock::new(quota_closed_by_provider),
            unhealthy_by_provider: RwLock::new(unhealthy_by_provider),
            balanced_main_session_ids: RwLock::new(None),
        }
    }

    pub fn set_manual_override(&self, provider: Option<String>) {
        *self.manual_override.write() = provider;
    }

    pub fn sync_with_config(&self, cfg: &AppConfig, now_ms: u64) {
        let mut health = self.health.write();
        for name in cfg.providers.keys() {
            health
                .entry(name.clone())
                .or_insert_with(|| ProviderHealth::new(now_ms));
        }
        health.retain(|name, _| cfg.providers.contains_key(name));
        drop(health);

        let mut quota_closed = self.quota_closed_by_provider.write();
        for name in cfg.providers.keys() {
            quota_closed.entry(name.clone()).or_insert(false);
        }
        quota_closed.retain(|name, _| cfg.providers.contains_key(name));

        let mut unhealthy = self.unhealthy_by_provider.write();
        for name in cfg.providers.keys() {
            unhealthy.entry(name.clone()).or_insert(false);
        }
        unhealthy.retain(|name, _| cfg.providers.contains_key(name));
    }

    pub fn record_quota_closed_states(&self, states: &HashMap<String, bool>) -> Vec<String> {
        let mut quota_closed = self.quota_closed_by_provider.write();
        let mut reopened = Vec::new();
        for (provider, is_closed) in states {
            let was_closed = quota_closed
                .insert(provider.clone(), *is_closed)
                .unwrap_or(false);
            if was_closed && !*is_closed {
                reopened.push(provider.clone());
            }
        }
        quota_closed.retain(|provider, _| states.contains_key(provider));
        reopened
    }

    pub fn record_unhealthy_states(&self, states: &HashMap<String, bool>) -> Vec<String> {
        let mut unhealthy = self.unhealthy_by_provider.write();
        let mut recovered = Vec::new();
        for (provider, is_unhealthy) in states {
            let was_unhealthy = unhealthy
                .insert(provider.clone(), *is_unhealthy)
                .unwrap_or(false);
            if was_unhealthy && !*is_unhealthy {
                recovered.push(provider.clone());
            }
        }
        unhealthy.retain(|provider, _| states.contains_key(provider));
        recovered
    }

    pub fn record_balanced_main_sessions(&self, session_ids: &BTreeSet<String>) -> bool {
        let mut last = self.balanced_main_session_ids.write();
        let changed = match last.as_ref() {
            None => false,
            Some(prev) => prev != session_ids,
        };
        *last = Some(session_ids.clone());
        changed
    }

    pub fn mark_success(&self, provider: &str, now_ms: u64) {
        let mut health = self.health.write();
        if let Some(h) = health.get_mut(provider) {
            if h.in_cooldown_at(now_ms) && h.cooldown_from_transient_warnings {
                h.last_ok_at_unix_ms = now_ms;
                return;
            }
            h.state = HealthState::Healthy;
            h.consecutive_failures = 0;
            h.cooldown_until_unix_ms = 0;
            h.cooldown_from_transient_warnings = false;
            h.usage_confirmation_required = false;
            h.last_ok_at_unix_ms = now_ms;
        }
    }

    pub fn mark_failure(&self, provider: &str, cfg: &AppConfig, err: &str, now_ms: u64) {
        self.apply_failure(provider, err, now_ms, cfg.routing.failure_threshold, cfg);
    }

    pub fn mark_transient_warning(&self, provider: &str, cfg: &AppConfig, err: &str, now_ms: u64) {
        let mut health = self.health.write();
        if let Some(h) = health.get_mut(provider) {
            const TRANSIENT_WARNING_THRESHOLD: usize = 3;
            let warning_window_ms = cfg
                .routing
                .effective_cooldown_seconds()
                .saturating_mul(1000);
            let threshold_ms = now_ms.saturating_sub(warning_window_ms);
            h.transient_warning_timestamps_unix_ms
                .retain(|ts| *ts >= threshold_ms);
            h.transient_warning_timestamps_unix_ms.push(now_ms);
            if h.transient_warning_timestamps_unix_ms.len() >= TRANSIENT_WARNING_THRESHOLD {
                h.transient_warning_timestamps_unix_ms.clear();
                h.consecutive_failures = 0;
                h.state = HealthState::Unhealthy;
                h.cooldown_from_transient_warnings = true;
                h.last_error = err.to_string();
                h.last_fail_at_unix_ms = now_ms;
                h.cooldown_until_unix_ms = now_ms
                    + cfg
                        .routing
                        .effective_cooldown_seconds()
                        .saturating_mul(1000);
            }
        }
    }

    fn apply_failure(
        &self,
        provider: &str,
        err: &str,
        now_ms: u64,
        threshold: u32,
        cfg: &AppConfig,
    ) {
        let mut health = self.health.write();
        if let Some(h) = health.get_mut(provider) {
            h.transient_warning_timestamps_unix_ms.clear();
            h.state = HealthState::Unhealthy;
            h.consecutive_failures = h.consecutive_failures.saturating_add(1);
            h.last_error = err.to_string();
            h.last_fail_at_unix_ms = now_ms;

            if h.consecutive_failures >= threshold {
                h.cooldown_from_transient_warnings = false;
                h.cooldown_until_unix_ms = now_ms
                    + cfg
                        .routing
                        .effective_cooldown_seconds()
                        .saturating_mul(1000);
            }
        }
    }

    pub fn mark_usage_refresh_success(&self, provider: &str, _now_ms: u64) {
        let mut health = self.health.write();
        if let Some(h) = health.get_mut(provider) {
            if matches!(h.state, HealthState::Unknown) {
                h.state = HealthState::Healthy;
            }
        }
    }

    pub fn require_usage_confirmation(&self, provider: &str) {
        let mut health = self.health.write();
        if let Some(h) = health.get_mut(provider) {
            h.usage_confirmation_required = true;
        }
    }

    pub fn clear_usage_confirmation_requirement(&self, provider: &str) {
        let mut health = self.health.write();
        if let Some(h) = health.get_mut(provider) {
            h.usage_confirmation_required = false;
        }
    }

    pub fn is_waiting_usage_confirmation(&self, provider: &str) -> bool {
        let health = self.health.read();
        health
            .get(provider)
            .is_some_and(|h| h.usage_confirmation_required)
    }

    pub fn snapshot(&self, now_ms: u64) -> HashMap<String, ProviderHealthSnapshot> {
        let health = self.health.read();
        health
            .iter()
            .map(|(k, v)| {
                let status = if v.in_cooldown_at(now_ms) {
                    "cooldown"
                } else {
                    match v.state {
                        HealthState::Unknown => "unknown",
                        HealthState::Healthy => "healthy",
                        HealthState::Unhealthy => "unhealthy",
                    }
                }
                .to_string();
                (
                    k.clone(),
                    ProviderHealthSnapshot {
                        status,
                        consecutive_failures: v.consecutive_failures,
                        cooldown_until_unix_ms: v.cooldown_until_unix_ms,
                        last_error: v.last_error.clone(),
                        last_ok_at_unix_ms: v.last_ok_at_unix_ms,
                        last_fail_at_unix_ms: v.last_fail_at_unix_ms,
                    },
                )
            })
            .collect()
    }

    fn is_routable(&self, provider: &str) -> bool {
        let health = self.health.read();
        let Some(h) = health.get(provider) else {
            return false;
        };
        !h.in_cooldown() && !h.usage_confirmation_required
    }

    pub fn is_provider_routable(&self, provider: &str) -> bool {
        self.is_routable(provider)
    }

    pub fn is_provider_in_cooldown(&self, provider: &str) -> bool {
        let health = self.health.read();
        let Some(h) = health.get(provider) else {
            return true;
        };
        h.in_cooldown()
    }

    pub fn should_suppress_preferred(&self, preferred: &str, cfg: &AppConfig, now_ms: u64) -> bool {
        if !cfg.routing.auto_return_to_preferred {
            return false;
        }
        let stable_seconds = cfg.routing.preferred_stable_seconds;
        if stable_seconds == 0 {
            return false;
        }

        let health = self.health.read();
        let Some(h) = health.get(preferred) else {
            return false;
        };
        if h.last_fail_at_unix_ms == 0 {
            return false;
        }
        let stable_ms = stable_seconds.saturating_mul(1000);
        now_ms < h.last_fail_at_unix_ms.saturating_add(stable_ms)
    }
}

pub(crate) fn provider_group(cfg: &AppConfig, name: &str) -> Option<String> {
    let p = cfg.providers.get(name)?;
    let host = Url::parse(&p.base_url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_string()))?;
    if host.ends_with("ppchat.vip") || host.ends_with("pumpkinai.vip") {
        return Some("ppchat_pumpkin".to_string());
    }
    None
}

fn unix_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_secs(0))
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mark_success_keeps_last_error_but_resets_failure_state() {
        let mut cfg = AppConfig::default_config();
        cfg.routing.failure_threshold = 1;
        cfg.routing.cooldown_seconds = 10 * 60;
        let provider = "official";
        let router = RouterState::new(&cfg, 0);

        router.mark_failure(provider, &cfg, "boom", 1_000);
        router.mark_success(provider, 2_000);
        let snapshot = router.snapshot(2_000);
        let health = snapshot.get(provider).expect("provider health snapshot");

        assert_eq!(health.status, "healthy");
        assert_eq!(health.consecutive_failures, 0);
        assert_eq!(health.cooldown_until_unix_ms, 0);
        assert_eq!(health.last_error, "boom");
        assert_eq!(health.last_ok_at_unix_ms, 2_000);
    }

    #[test]
    fn mark_failure_keeps_full_last_error_without_truncation() {
        let mut cfg = AppConfig::default_config();
        cfg.routing.failure_threshold = 10;
        let provider = "official";
        let router = RouterState::new(&cfg, 0);

        let long_error = "x".repeat(900);
        router.mark_failure(provider, &cfg, &long_error, 1_000);
        let snapshot = router.snapshot(1_000);
        let health = snapshot.get(provider).expect("provider health snapshot");

        assert_eq!(health.last_error.len(), 900);
        assert_eq!(health.last_error, long_error);
    }

    #[test]
    fn usage_refresh_success_promotes_unknown_only() {
        let mut cfg = AppConfig::default_config();
        cfg.routing.failure_threshold = 10;
        let provider = "official";
        let router = RouterState::new(&cfg, 0);

        router.mark_usage_refresh_success(provider, 1_000);
        let snapshot = router.snapshot(1_000);
        let health = snapshot.get(provider).expect("provider health snapshot");
        assert_eq!(health.status, "healthy");
        assert_eq!(health.last_ok_at_unix_ms, 0);

        router.mark_failure(provider, &cfg, "boom", 2_000);
        router.mark_usage_refresh_success(provider, 3_000);
        let snapshot = router.snapshot(3_000);
        let health = snapshot.get(provider).expect("provider health snapshot");
        assert_eq!(health.status, "unhealthy");
        assert_eq!(health.last_ok_at_unix_ms, 0);
    }

    #[test]
    fn unhealthy_state_recovery_tracks_transition() {
        let cfg = AppConfig::default_config();
        let router = RouterState::new(&cfg, 0);
        let provider = "official".to_string();

        let mut first = HashMap::new();
        first.insert(provider.clone(), true);
        assert!(router.record_unhealthy_states(&first).is_empty());

        let mut second = HashMap::new();
        second.insert(provider.clone(), false);
        assert_eq!(router.record_unhealthy_states(&second), vec![provider]);
    }

    #[test]
    fn transient_warnings_trigger_cooldown_after_three_hits() {
        let mut cfg = AppConfig::default_config();
        cfg.routing.failure_threshold = 10;
        cfg.routing.cooldown_seconds = 30;
        let provider = "official";
        let router = RouterState::new(&cfg, 0);

        router.mark_transient_warning(provider, &cfg, "warn-1", 1_000);
        router.mark_transient_warning(provider, &cfg, "warn-2", 2_000);
        let before_threshold = router.snapshot(2_000);
        assert_eq!(
            before_threshold
                .get(provider)
                .expect("provider health snapshot")
                .status,
            "unknown"
        );

        router.mark_transient_warning(provider, &cfg, "warn-3", 3_000);
        let after_threshold = router.snapshot(3_000);
        let health = after_threshold
            .get(provider)
            .expect("provider health snapshot");
        assert_eq!(health.status, "cooldown");
        assert_eq!(health.cooldown_until_unix_ms, 3_000 + 600_000);
        assert_eq!(health.last_error, "warn-3");
    }

    #[test]
    fn success_during_cooldown_does_not_clear_cooldown_state() {
        let mut cfg = AppConfig::default_config();
        cfg.routing.failure_threshold = 10;
        let provider = "official";
        let router = RouterState::new(&cfg, 0);

        router.mark_transient_warning(provider, &cfg, "warn-1", 1_000);
        router.mark_transient_warning(provider, &cfg, "warn-2", 2_000);
        router.mark_transient_warning(provider, &cfg, "warn-3", 3_000);
        router.mark_success(provider, 4_000);

        let snapshot = router.snapshot(4_000);
        let health = snapshot.get(provider).expect("provider health snapshot");
        assert_eq!(health.status, "cooldown");
        assert_eq!(health.cooldown_until_unix_ms, 3_000 + 600_000);
    }

    #[test]
    fn success_does_not_clear_transient_warning_streak_before_threshold() {
        let mut cfg = AppConfig::default_config();
        cfg.routing.failure_threshold = 10;
        let provider = "official";
        let router = RouterState::new(&cfg, 0);

        router.mark_transient_warning(provider, &cfg, "warn-1", 1_000);
        router.mark_transient_warning(provider, &cfg, "warn-2", 2_000);
        router.mark_success(provider, 3_000);
        router.mark_transient_warning(provider, &cfg, "warn-3", 4_000);

        let snapshot = router.snapshot(4_000);
        let health = snapshot.get(provider).expect("provider health snapshot");
        assert_eq!(health.status, "cooldown");
        assert_eq!(health.cooldown_until_unix_ms, 4_000 + 600_000);
    }
}
