use chrono::{Local, TimeZone};
use serde_json::Value;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

#[derive(Clone)]
pub struct Store {
    db: sled::Db,
    usage_prune_seq: Arc<AtomicU64>,
}

const LEDGER_DEFAULT: &str = r#"{"since_last_quota_refresh_input_tokens":0,"since_last_quota_refresh_output_tokens":0,"since_last_quota_refresh_total_tokens":0,"last_reset_unix_ms":0}"#;

#[derive(Clone, Copy)]
struct UsageTokenIncrements {
    input_tokens: u64,
    output_tokens: u64,
    total_tokens: u64,
    cache_creation_input_tokens: u64,
    cache_read_input_tokens: u64,
}

impl Store {
    const MAX_EVENTS: usize = 200;
    const MAX_USAGE_REQUESTS: usize = 500_000;
    const USAGE_PRUNE_EVERY: u64 = 128;
    const MAX_DB_BYTES: u64 = 64 * 1024 * 1024; // 64 MiB, best-effort cap via compaction

    // Breaking-change friendly: bump this to invalidate old persisted event shapes.
    const EVENTS_SCHEMA_VERSION: &'static [u8] = b"1";
    const EVENTS_SCHEMA_KEY: &'static [u8] = b"events:schema_version";
}

include!("store_parts/methods_a.rs");

include!("store_parts/methods_b.rs");

include!("store_parts/maintenance.rs");

include!("store_parts/tests.rs");
