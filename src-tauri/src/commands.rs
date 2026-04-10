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
    day.get("day_key")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
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
        })
}

fn tracked_spend_days_with_remote_fallback(
    store: &crate::orchestrator::store::Store,
    provider: &str,
) -> Vec<Value> {
    store.list_shared_tracked_spend_days(provider)
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
