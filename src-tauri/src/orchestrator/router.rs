use reqwest::Url;
use std::collections::{HashMap, HashSet};
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
            last_error: String::new(),
            last_ok_at_unix_ms: 0,
            last_fail_at_unix_ms: 0,
        }
    }

    fn in_cooldown(&self) -> bool {
        self.cooldown_until_unix_ms != 0 && unix_ms() < self.cooldown_until_unix_ms
    }
}

pub struct RouterState {
    pub manual_override: RwLock<Option<String>>,
    health: RwLock<HashMap<String, ProviderHealth>>,
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
        Self {
            manual_override: RwLock::new(None),
            health: RwLock::new(health),
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
    }

    pub fn mark_success(&self, provider: &str, now_ms: u64) {
        let mut health = self.health.write();
        if let Some(h) = health.get_mut(provider) {
            h.state = HealthState::Healthy;
            h.consecutive_failures = 0;
            h.cooldown_until_unix_ms = 0;
            h.last_error.clear();
            h.last_ok_at_unix_ms = now_ms;
        }
    }

    pub fn mark_failure(&self, provider: &str, cfg: &AppConfig, err: &str, now_ms: u64) {
        let mut health = self.health.write();
        if let Some(h) = health.get_mut(provider) {
            h.state = HealthState::Unhealthy;
            h.consecutive_failures = h.consecutive_failures.saturating_add(1);
            h.last_error = err.chars().take(500).collect();
            h.last_fail_at_unix_ms = now_ms;

            if h.consecutive_failures >= cfg.routing.failure_threshold {
                h.cooldown_until_unix_ms = now_ms + (cfg.routing.cooldown_seconds * 1000);
            }
        }
    }

    pub fn snapshot(&self, _now_ms: u64) -> HashMap<String, ProviderHealthSnapshot> {
        let health = self.health.read();
        health
            .iter()
            .map(|(k, v)| {
                let status = if v.in_cooldown() {
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
        !h.in_cooldown()
    }

    pub fn is_provider_routable(&self, provider: &str) -> bool {
        self.is_routable(provider)
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
