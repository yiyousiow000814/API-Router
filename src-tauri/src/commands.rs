use crate::app_state;
use crate::codex_app_server;
use crate::orchestrator::store::unix_ms;
use chrono::{Local, LocalResult, NaiveDate, TimeZone, Timelike};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;

fn tracked_spend_day_key(day: &Value) -> Option<String> {
    let started_at_unix_ms = day
        .get("started_at_unix_ms")
        .and_then(Value::as_u64)
        .or_else(|| {
            day.get("ended_at_unix_ms")
                .and_then(Value::as_u64)
                .map(|value| value.saturating_sub(1))
        })
        .or_else(|| day.get("updated_at_unix_ms").and_then(Value::as_u64))?;
    local_day_key_from_unix_ms(started_at_unix_ms)
}

fn tracked_spend_days_with_remote_fallback(
    store: &crate::orchestrator::store::Store,
    provider: &str,
) -> Vec<Value> {
    let local_days = store.list_local_spend_days(provider);
    let mut day_keys_with_positive_local = BTreeSet::new();
    for day in &local_days {
        let tracked = day
            .get("tracked_spend_usd")
            .and_then(|value| {
                value
                    .as_f64()
                    .or_else(|| value.as_i64().map(|n| n as f64))
                    .or_else(|| value.as_u64().map(|n| n as f64))
            })
            .filter(|value| value.is_finite() && *value > 0.0);
        if let (Some(day_key), Some(_)) = (tracked_spend_day_key(day), tracked) {
            day_keys_with_positive_local.insert(day_key);
        }
    }

    let mut merged = local_days;
    for day in store.list_remote_spend_days(provider) {
        let Some(day_key) = tracked_spend_day_key(&day) else {
            continue;
        };
        if day_keys_with_positive_local.contains(&day_key) {
            continue;
        }
        merged.push(day);
    }
    merged
}

include!("commands/status_snapshot.rs");
include!("commands/usage_metrics.rs");
include!("commands/provider_timeline.rs");
include!("commands/spend_history.rs");
include!("commands/provider_management.rs");
include!("commands/quota_ops.rs");
include!("commands/account_switchboard.rs");
include!("commands/tailscale.rs");
include!("commands/external_links.rs");
