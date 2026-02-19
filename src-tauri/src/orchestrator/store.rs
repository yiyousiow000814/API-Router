use chrono::{Datelike, Local, TimeZone};
use serde_json::Value;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

mod usage_tracking;

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

pub(crate) fn extract_response_model_option(response_obj: &Value) -> Option<String> {
    response_obj
        .get("model")
        .and_then(|v| v.as_str())
        .or_else(|| {
            response_obj
                .pointer("/response/model")
                .and_then(|v| v.as_str())
        })
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

impl Store {
    const MAX_USAGE_REQUESTS: usize = 500_000;
    const USAGE_PRUNE_EVERY: u64 = 128;
    const MAX_DB_BYTES: u64 = 64 * 1024 * 1024; // 64 MiB, best-effort cap via compaction

    // Breaking-change friendly: bump this to invalidate old persisted event shapes.
    const EVENTS_SCHEMA_VERSION: &'static [u8] = b"1";
    const EVENTS_SCHEMA_KEY: &'static [u8] = b"events:schema_version";
    const EVENT_DAY_INDEX_VERSION: &'static [u8] = b"1";
    const EVENT_DAY_INDEX_VERSION_KEY: &'static [u8] = b"events:day_index_version";

    fn allowed_key_prefixes() -> [&'static [u8]; 10] {
        [
            b"event:",
            b"event_day:",
            b"metrics:",
            b"quota:",
            b"ledger:",
            b"usage_req:",
            b"usage_day:",
            b"spend_day:",
            b"spend_state:",
            b"spend_manual_day:",
        ]
    }

    fn allowed_exact_keys() -> [&'static [u8]; 4] {
        [
            b"codex_account:snapshot",
            b"official_web:snapshot",
            Self::EVENTS_SCHEMA_KEY,
            Self::EVENT_DAY_INDEX_VERSION_KEY,
        ]
    }

    pub fn open(path: &std::path::Path) -> Result<Self, sled::Error> {
        let db = sled::open(path)?;
        let store = Self {
            db,
            usage_prune_seq: Arc::new(AtomicU64::new(0)),
        };
        store.ensure_events_schema();
        store.ensure_event_day_index();
        Ok(store)
    }

    fn ensure_events_schema(&self) {
        let cur = self
            .db
            .get(Self::EVENTS_SCHEMA_KEY)
            .ok()
            .flatten()
            .unwrap_or_default();
        if cur.as_ref() != Self::EVENTS_SCHEMA_VERSION {
            // Do not parse or migrate legacy events; drop them.
            self.clear_events();
            let _ = self
                .db
                .insert(Self::EVENTS_SCHEMA_KEY, Self::EVENTS_SCHEMA_VERSION);
            let _ = self.db.flush();
        }
    }

    fn ensure_event_day_index(&self) {
        let cur = self
            .db
            .get(Self::EVENT_DAY_INDEX_VERSION_KEY)
            .ok()
            .flatten()
            .unwrap_or_default();
        if cur.as_ref() == Self::EVENT_DAY_INDEX_VERSION {
            return;
        }
        self.rebuild_event_day_index();
        let _ = self.db.insert(
            Self::EVENT_DAY_INDEX_VERSION_KEY,
            Self::EVENT_DAY_INDEX_VERSION,
        );
        let _ = self.db.flush();
    }

    fn clear_events(&self) {
        self.clear_prefix(b"event:");
        self.clear_prefix(b"event_day:");
        let _ = self.db.remove(Self::EVENT_DAY_INDEX_VERSION_KEY);
        let _ = self.db.flush();
    }

    fn clear_prefix(&self, prefix: &[u8]) {
        let mut batch: Vec<sled::IVec> = Vec::with_capacity(2048);
        for res in self.db.scan_prefix(prefix) {
            let Ok((k, _)) = res else {
                continue;
            };
            batch.push(k);
            if batch.len() >= 2048 {
                for key in batch.drain(..) {
                    let _ = self.db.remove(key);
                }
            }
        }
        for key in batch.drain(..) {
            let _ = self.db.remove(key);
        }
    }

    fn local_day_key_from_unix_ms(ts_unix_ms: u64) -> Option<String> {
        let ts = i64::try_from(ts_unix_ms).ok()?;
        let dt = Local.timestamp_millis_opt(ts).single()?;
        Some(dt.format("%Y-%m-%d").to_string())
    }

    fn parse_day_key_from_daily_key(key: &[u8]) -> Option<&str> {
        let body = key.strip_prefix(b"event_day:")?;
        std::str::from_utf8(body).ok()
    }

    fn day_start_unix_ms_from_day_key(day_key: &str) -> Option<u64> {
        let date = chrono::NaiveDate::parse_from_str(day_key, "%Y-%m-%d").ok()?;
        let dt = Local
            .with_ymd_and_hms(date.year(), date.month(), date.day(), 0, 0, 0)
            .single()?;
        u64::try_from(dt.timestamp_millis()).ok()
    }

    fn event_day_counts_from_value(v: &[u8]) -> Option<(u64, u64, u64, u64)> {
        let row = serde_json::from_slice::<Value>(v).ok()?;
        let total = row.get("total").and_then(|x| x.as_u64()).unwrap_or(0);
        let infos = row.get("infos").and_then(|x| x.as_u64()).unwrap_or(0);
        let warnings = row.get("warnings").and_then(|x| x.as_u64()).unwrap_or(0);
        let errors = row.get("errors").and_then(|x| x.as_u64()).unwrap_or(0);
        Some((total, infos, warnings, errors))
    }

    fn put_event_day_counts(
        &self,
        day_key: &str,
        total: u64,
        infos: u64,
        warnings: u64,
        errors: u64,
    ) {
        let key = format!("event_day:{day_key}");
        let row = serde_json::json!({
            "day": day_key,
            "total": total,
            "infos": infos,
            "warnings": warnings,
            "errors": errors,
        });
        let _ = self
            .db
            .insert(key.as_bytes(), serde_json::to_vec(&row).unwrap_or_default());
    }

    fn update_event_day_index(&self, unix_ms: u64, level: &str) {
        let Some(day_key) = Self::local_day_key_from_unix_ms(unix_ms) else {
            return;
        };
        let key = format!("event_day:{day_key}");
        let (mut total, mut infos, mut warnings, mut errors) = self
            .db
            .get(key.as_bytes())
            .ok()
            .flatten()
            .and_then(|v| Self::event_day_counts_from_value(&v))
            .unwrap_or((0, 0, 0, 0));
        total = total.saturating_add(1);
        match level {
            "error" => errors = errors.saturating_add(1),
            "warning" => warnings = warnings.saturating_add(1),
            _ => infos = infos.saturating_add(1),
        }
        self.put_event_day_counts(&day_key, total, infos, warnings, errors);
    }

    fn rebuild_event_day_index(&self) {
        self.clear_prefix(b"event_day:");
        let mut day_map: std::collections::BTreeMap<String, (u64, u64, u64, u64)> =
            std::collections::BTreeMap::new();
        for res in self.db.scan_prefix(b"event:") {
            let Ok((_, v)) = res else {
                continue;
            };
            let Ok(j) = serde_json::from_slice::<Value>(&v) else {
                continue;
            };
            if !Self::is_valid_event(&j) {
                continue;
            }
            let Some(unix_ms) = j.get("unix_ms").and_then(|x| x.as_u64()) else {
                continue;
            };
            let Some(day_key) = Self::local_day_key_from_unix_ms(unix_ms) else {
                continue;
            };
            let level = j.get("level").and_then(|x| x.as_str()).unwrap_or("info");
            let row = day_map.entry(day_key).or_insert((0, 0, 0, 0));
            row.0 = row.0.saturating_add(1);
            match level {
                "error" => row.3 = row.3.saturating_add(1),
                "warning" => row.2 = row.2.saturating_add(1),
                _ => row.1 = row.1.saturating_add(1),
            }
        }
        for (day_key, (total, infos, warnings, errors)) in day_map {
            self.put_event_day_counts(&day_key, total, infos, warnings, errors);
        }
    }

    fn is_valid_event(j: &Value) -> bool {
        j.get("provider").and_then(|v| v.as_str()).is_some()
            && j.get("level").and_then(|v| v.as_str()).is_some()
            && j.get("unix_ms").and_then(|v| v.as_u64()).is_some()
            && j.get("code").and_then(|v| v.as_str()).is_some()
            && j.get("message").and_then(|v| v.as_str()).is_some()
            && j.get("fields")
                .map(|v| matches!(v, Value::Object(_) | Value::Null))
                .unwrap_or(false)
    }

    fn is_valid_usage_request(j: &Value) -> bool {
        j.get("provider").and_then(|v| v.as_str()).is_some()
            && j.get("model").and_then(|v| v.as_str()).is_some()
            && j.get("unix_ms").and_then(|v| v.as_u64()).is_some()
            && j.get("input_tokens").and_then(|v| v.as_u64()).is_some()
            && j.get("output_tokens").and_then(|v| v.as_u64()).is_some()
            && j.get("total_tokens").and_then(|v| v.as_u64()).is_some()
    }

    fn prune_usage_requests(&self) {
        let boundary = self
            .db
            .scan_prefix(b"usage_req:")
            .rev()
            .nth(Self::MAX_USAGE_REQUESTS);

        let Some(Ok((end_key, _))) = boundary else {
            return;
        };

        let start = b"usage_req:".to_vec();
        let end = end_key.to_vec();

        let mut batch: Vec<sled::IVec> = Vec::with_capacity(1024);
        for res in self.db.range(start..=end) {
            let Ok((k, _)) = res else {
                continue;
            };
            batch.push(k);
            if batch.len() >= 1024 {
                for key in batch.drain(..) {
                    let _ = self.db.remove(key);
                }
            }
        }
        for key in batch.drain(..) {
            let _ = self.db.remove(key);
        }
    }

    fn prune_usage_requests_db(db: &sled::Db) {
        let boundary = db
            .scan_prefix(b"usage_req:")
            .rev()
            .nth(Self::MAX_USAGE_REQUESTS);
        let Some(Ok((end_key, _))) = boundary else {
            return;
        };

        let start = b"usage_req:".to_vec();
        let end = end_key.to_vec();

        let mut batch: Vec<sled::IVec> = Vec::with_capacity(1024);
        for res in db.range(start..=end) {
            let Ok((k, _)) = res else {
                continue;
            };
            batch.push(k);
            if batch.len() >= 1024 {
                for key in batch.drain(..) {
                    let _ = db.remove(key);
                }
            }
        }
        for key in batch.drain(..) {
            let _ = db.remove(key);
        }
    }

    pub fn add_event(&self, provider: &str, level: &str, code: &str, message: &str, fields: Value) {
        let ts = unix_ms();
        let id = uuid::Uuid::new_v4().to_string();
        let key = format!("event:{ts}:{id}");
        let fields = match fields {
            Value::Object(_) => fields,
            Value::Null => Value::Null,
            other => serde_json::json!({ "value": other }),
        };
        let v = serde_json::json!({
            "provider": provider,
            "level": level,
            "unix_ms": ts,
            "code": code,
            "message": message,
            "fields": fields,
        });
        let _ = self
            .db
            .insert(key.as_bytes(), serde_json::to_vec(&v).unwrap_or_default());
        self.update_event_day_index(ts, level);
        let _ = self.db.flush();
    }

    pub fn record_success(
        &self,
        provider: &str,
        response_obj: &Value,
        api_key_ref: Option<&str>,
        origin: &str,
    ) {
        self.record_success_with_model(provider, response_obj, api_key_ref, None, origin);
    }

    pub fn record_success_with_model(
        &self,
        provider: &str,
        response_obj: &Value,
        api_key_ref: Option<&str>,
        model_override: Option<&str>,
        origin: &str,
    ) {
        let (
            input_tokens,
            output_tokens,
            total_tokens,
            cache_creation_input_tokens,
            cache_read_input_tokens,
        ) = Self::extract_usage_tokens(response_obj);
        let increments = UsageTokenIncrements {
            input_tokens,
            output_tokens,
            total_tokens,
            cache_creation_input_tokens,
            cache_read_input_tokens,
        };

        // Fast path: flush once at the end in add_usage_request.
        self.bump_metrics(provider, 1, 0, total_tokens, false);
        self.bump_ledger(provider, input_tokens, output_tokens, total_tokens, false);
        self.add_usage_request(
            provider,
            &Self::model_for_usage(response_obj, model_override),
            increments,
            api_key_ref,
            origin,
            true,
        );
    }

    pub fn record_failure(&self, provider: &str) {
        self.bump_metrics(provider, 0, 1, 0, true);
    }

    pub fn get_metrics(&self) -> serde_json::Value {
        let mut out = serde_json::Map::new();
        for (k, v) in self.db.scan_prefix(b"metrics:").flatten() {
            let key = String::from_utf8_lossy(&k).to_string();
            let name = key.trim_start_matches("metrics:").to_string();
            if let Ok(j) = serde_json::from_slice::<Value>(&v) {
                out.insert(name, j);
            }
        }
        Value::Object(out)
    }

    fn bump_metrics(
        &self,
        provider: &str,
        ok_inc: u64,
        err_inc: u64,
        tokens_inc: u64,
        flush: bool,
    ) {
        let key = format!("metrics:{provider}");
        let cur = self
            .db
            .get(key.as_bytes())
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_slice::<Value>(&v).ok())
            .unwrap_or(serde_json::json!({
                "ok_requests": 0,
                "error_requests": 0,
                "total_tokens": 0
            }));

        let ok = cur.get("ok_requests").and_then(|v| v.as_u64()).unwrap_or(0) + ok_inc;
        let err = cur
            .get("error_requests")
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
            + err_inc;
        let tok = cur
            .get("total_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
            + tokens_inc;

        let next = serde_json::json!({
            "ok_requests": ok,
            "error_requests": err,
            "total_tokens": tok
        });

        let _ = self.db.insert(
            key.as_bytes(),
            serde_json::to_vec(&next).unwrap_or_default(),
        );
        if flush {
            let _ = self.db.flush();
        }
    }

    pub fn put_quota_snapshot(&self, provider: &str, snapshot: &Value) -> Result<(), sled::Error> {
        let key = format!("quota:{provider}");
        self.db.insert(
            key.as_bytes(),
            serde_json::to_vec(snapshot).unwrap_or_default(),
        )?;
        let _ = self.db.flush();
        Ok(())
    }

    pub fn list_quota_snapshots(&self) -> serde_json::Value {
        let mut out = serde_json::Map::new();
        for (k, v) in self.db.scan_prefix(b"quota:").flatten() {
            let key = String::from_utf8_lossy(&k).to_string();
            let name = key.trim_start_matches("quota:").to_string();
            if let Ok(j) = serde_json::from_slice::<Value>(&v) {
                out.insert(name, j);
            }
        }
        Value::Object(out)
    }

    pub fn get_ledger(&self, provider: &str) -> Value {
        let key = format!("ledger:{provider}");
        self.db
            .get(key.as_bytes())
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_slice::<Value>(&v).ok())
            .unwrap_or_else(|| serde_json::from_str::<Value>(LEDGER_DEFAULT).unwrap_or(Value::Null))
    }

    pub fn list_ledgers(&self) -> Value {
        let mut out = serde_json::Map::new();
        for (k, v) in self.db.scan_prefix(b"ledger:").flatten() {
            let key = String::from_utf8_lossy(&k).to_string();
            let name = key.trim_start_matches("ledger:").to_string();
            if let Ok(j) = serde_json::from_slice::<Value>(&v) {
                out.insert(name, j);
            }
        }
        Value::Object(out)
    }

    pub fn reset_ledger(&self, provider: &str) {
        let key = format!("ledger:{provider}");
        let v = serde_json::json!({
            "since_last_quota_refresh_input_tokens": 0u64,
            "since_last_quota_refresh_output_tokens": 0u64,
            "since_last_quota_refresh_total_tokens": 0u64,
            "last_reset_unix_ms": unix_ms(),
        });
        let _ = self
            .db
            .insert(key.as_bytes(), serde_json::to_vec(&v).unwrap_or_default());
        let _ = self.db.flush();
    }

    pub fn rename_provider(&self, old: &str, new: &str) {
        if old == new {
            return;
        }

        let new_provider = new.to_string();
        for prefix in ["metrics:", "quota:", "ledger:", "spend_state:"] {
            let old_key = format!("{prefix}{old}");
            if let Ok(Some(v)) = self.db.get(old_key.as_bytes()) {
                let new_key = format!("{prefix}{new}");
                let _ = self.db.insert(new_key.as_bytes(), v);
                let _ = self.db.remove(old_key.as_bytes());
            }
        }

        let mut usage_req_updates: Vec<(sled::IVec, Vec<u8>)> = Vec::new();
        for res in self.db.scan_prefix(b"usage_req:") {
            let Ok((key, value)) = res else {
                continue;
            };
            let Ok(mut request) = serde_json::from_slice::<Value>(&value) else {
                continue;
            };
            let Some(object) = request.as_object_mut() else {
                continue;
            };
            let provider = object
                .get("provider")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if provider != old {
                continue;
            }
            object.insert("provider".to_string(), Value::String(new_provider.clone()));
            if let Ok(encoded) = serde_json::to_vec(&request) {
                usage_req_updates.push((key, encoded));
            }
        }
        for (key, encoded) in usage_req_updates {
            let _ = self.db.insert(key, encoded);
        }

        for prefix in ["usage_day:", "spend_day:", "spend_manual_day:"] {
            let old_prefix = format!("{prefix}{old}:");
            let new_prefix = format!("{prefix}{new}:");
            let old_prefix_bytes = old_prefix.as_bytes();
            let mut to_rename: Vec<(sled::IVec, Vec<u8>, sled::IVec)> = Vec::new();

            for res in self.db.scan_prefix(old_prefix_bytes) {
                let Ok((k, v)) = res else {
                    continue;
                };
                if !k.as_ref().starts_with(old_prefix_bytes) {
                    continue;
                }
                let suffix = &k.as_ref()[old_prefix_bytes.len()..];
                let mut new_key = new_prefix.as_bytes().to_vec();
                new_key.extend_from_slice(suffix);
                to_rename.push((k, new_key, v));
            }

            for (old_key, new_key, value) in to_rename {
                let _ = self.db.insert(new_key, value);
                let _ = self.db.remove(old_key);
            }
        }

        let _ = self.db.flush();
    }

    fn bump_ledger(
        &self,
        provider: &str,
        input_inc: u64,
        output_inc: u64,
        total_inc: u64,
        flush: bool,
    ) {
        let key = format!("ledger:{provider}");
        let cur = self.get_ledger(provider);
        let next = serde_json::json!({
            "since_last_quota_refresh_input_tokens": cur.get("since_last_quota_refresh_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0) + input_inc,
            "since_last_quota_refresh_output_tokens": cur.get("since_last_quota_refresh_output_tokens").and_then(|v| v.as_u64()).unwrap_or(0) + output_inc,
            "since_last_quota_refresh_total_tokens": cur.get("since_last_quota_refresh_total_tokens").and_then(|v| v.as_u64()).unwrap_or(0) + total_inc,
            "last_reset_unix_ms": cur.get("last_reset_unix_ms").and_then(|v| v.as_u64()).unwrap_or(0),
        });
        let _ = self.db.insert(
            key.as_bytes(),
            serde_json::to_vec(&next).unwrap_or_default(),
        );
        if flush {
            let _ = self.db.flush();
        }
    }

    #[allow(dead_code)]
    pub fn list_events(&self, limit: usize) -> Vec<Value> {
        // Hot path: UI polls status frequently (e.g. every ~1.5s). Do not scan + sort the full
        // event log each time; it becomes O(n log n) as the DB grows and causes visible stutter.
        //
        // Keys are `event:{unix_ms}:{uuid}`. `unix_ms` is 13 digits (until year 2286), so sled's
        // lexicographic key order matches chronological order. We can iterate from the end and
        // only deserialize up to `limit` items.
        self.db
            .scan_prefix(b"event:")
            .rev()
            .filter_map(|res| res.ok())
            .filter_map(|(_, v)| serde_json::from_slice::<Value>(&v).ok())
            .filter(Self::is_valid_event)
            .take(limit)
            .collect()
    }

    pub fn list_events_split(&self, max_error: usize, max_other: usize) -> Vec<Value> {
        // UI wants errors to stay visible even when info is noisy. Return up to
        // `max_error` error events and `max_other` non-error events, newest-first.
        let mut out: Vec<Value> = Vec::with_capacity(max_error + max_other);
        let mut seen_error = 0usize;
        let mut seen_other = 0usize;

        for res in self.db.scan_prefix(b"event:").rev() {
            let Ok((_, v)) = res else {
                continue;
            };
            let Ok(j) = serde_json::from_slice::<Value>(&v) else {
                continue;
            };
            if !Self::is_valid_event(&j) {
                continue;
            }
            let level = j.get("level").and_then(|v| v.as_str()).unwrap_or("info");
            if level == "error" {
                if seen_error >= max_error {
                    continue;
                }
                seen_error += 1;
                out.push(j);
            } else {
                if seen_other >= max_other {
                    continue;
                }
                seen_other += 1;
                out.push(j);
            }

            if seen_error >= max_error && seen_other >= max_other {
                break;
            }
        }

        out
    }

    pub fn list_event_years(&self) -> std::collections::BTreeSet<i32> {
        let mut years = std::collections::BTreeSet::<i32>::new();
        for res in self.db.scan_prefix(b"event_day:") {
            let Ok((k, _)) = res else {
                continue;
            };
            let Some(day_key) = Self::parse_day_key_from_daily_key(k.as_ref()) else {
                continue;
            };
            let Some(year_str) = day_key.get(..4) else {
                continue;
            };
            let Ok(year) = year_str.parse::<i32>() else {
                continue;
            };
            years.insert(year);
        }
        years
    }

    pub fn list_event_daily_counts_range(
        &self,
        from_unix_ms: Option<u64>,
        to_unix_ms: Option<u64>,
    ) -> Vec<Value> {
        let from_day_start = from_unix_ms
            .and_then(Self::local_day_key_from_unix_ms)
            .and_then(|day_key| Self::day_start_unix_ms_from_day_key(&day_key));
        let to_day_start = to_unix_ms
            .and_then(Self::local_day_key_from_unix_ms)
            .and_then(|day_key| Self::day_start_unix_ms_from_day_key(&day_key));
        let mut out: Vec<Value> = Vec::new();
        for res in self.db.scan_prefix(b"event_day:") {
            let Ok((k, v)) = res else {
                continue;
            };
            let Some(day_key) = Self::parse_day_key_from_daily_key(k.as_ref()) else {
                continue;
            };
            let Some(day_start_unix_ms) = Self::day_start_unix_ms_from_day_key(day_key) else {
                continue;
            };
            if let Some(from) = from_day_start {
                if day_start_unix_ms < from {
                    continue;
                }
            }
            if let Some(to) = to_day_start {
                if day_start_unix_ms > to {
                    continue;
                }
            }
            let Some((total, infos, warnings, errors)) = Self::event_day_counts_from_value(&v)
            else {
                continue;
            };
            out.push(serde_json::json!({
                "day": day_key,
                "day_start_unix_ms": day_start_unix_ms,
                "total": total,
                "infos": infos,
                "warnings": warnings,
                "errors": errors,
            }));
        }
        out.sort_by_key(|row| {
            row.get("day_start_unix_ms")
                .and_then(|x| x.as_u64())
                .unwrap_or(0)
        });
        out
    }

    pub fn list_events_range(
        &self,
        from_unix_ms: Option<u64>,
        to_unix_ms: Option<u64>,
        limit: Option<usize>,
    ) -> Vec<Value> {
        let cap = limit.unwrap_or(usize::MAX).max(1);
        let mut out: Vec<Value> = Vec::with_capacity(cap.min(1024));
        for res in self.db.scan_prefix(b"event:").rev() {
            let Ok((_, v)) = res else {
                continue;
            };
            let Ok(j) = serde_json::from_slice::<Value>(&v) else {
                continue;
            };
            if !Self::is_valid_event(&j) {
                continue;
            }
            let Some(unix_ms) = j.get("unix_ms").and_then(|v| v.as_u64()) else {
                continue;
            };
            if let Some(from) = from_unix_ms {
                if unix_ms < from {
                    // Keys are event:{unix_ms}:{uuid}, and add_event writes the same unix_ms
                    // into both key and payload. Once we pass `from`, the remaining entries
                    // in this reverse scan are older and can be skipped.
                    break;
                }
            }
            if let Some(to) = to_unix_ms {
                if unix_ms > to {
                    continue;
                }
            }
            out.push(j);
            if out.len() >= cap {
                break;
            }
        }
        out
    }

    pub fn list_usage_requests(&self, limit: usize) -> Vec<Value> {
        self.db
            .scan_prefix(b"usage_req:")
            .rev()
            .filter_map(|res| res.ok())
            .filter_map(|(_, v)| serde_json::from_slice::<Value>(&v).ok())
            .filter(Self::is_valid_usage_request)
            .take(limit)
            .collect()
    }

    pub fn backfill_api_key_ref_fields(
        &self,
        provider_api_key_ref: &std::collections::BTreeMap<String, String>,
    ) -> usize {
        fn has_key_ref(day: &Value) -> bool {
            day.get("api_key_ref")
                .and_then(|v| v.as_str())
                .map(|s| {
                    let t = s.trim();
                    !t.is_empty() && t != "-"
                })
                .unwrap_or(false)
        }

        let mut updated = 0usize;

        for res in self.db.scan_prefix(b"usage_req:") {
            let Ok((k, v)) = res else {
                continue;
            };
            let Ok(mut row) = serde_json::from_slice::<Value>(&v) else {
                continue;
            };
            if has_key_ref(&row) {
                continue;
            }
            let provider = row
                .get("provider")
                .and_then(|v| v.as_str())
                .map(|s| s.trim())
                .filter(|s| !s.is_empty());
            let Some(provider) = provider else {
                continue;
            };
            let key_ref = provider_api_key_ref
                .get(provider)
                .cloned()
                .unwrap_or_else(|| "-".to_string());
            row["api_key_ref"] = serde_json::json!(key_ref);
            let _ = self
                .db
                .insert(k, serde_json::to_vec(&row).unwrap_or_default());
            updated = updated.saturating_add(1);
        }

        for res in self.db.scan_prefix(b"spend_day:") {
            let Ok((k, v)) = res else {
                continue;
            };
            let Ok(mut row) = serde_json::from_slice::<Value>(&v) else {
                continue;
            };
            if has_key_ref(&row) {
                continue;
            }
            let provider = row
                .get("provider")
                .and_then(|v| v.as_str())
                .map(|s| s.trim())
                .filter(|s| !s.is_empty());
            let Some(provider) = provider else {
                continue;
            };
            let key_ref = provider_api_key_ref
                .get(provider)
                .cloned()
                .unwrap_or_else(|| "-".to_string());
            row["api_key_ref"] = serde_json::json!(key_ref);
            let _ = self
                .db
                .insert(k, serde_json::to_vec(&row).unwrap_or_default());
            updated = updated.saturating_add(1);
        }

        if updated > 0 {
            let _ = self.db.flush();
        }
        updated
    }
}
include!("store/time_and_fs.rs");
pub fn maintain_store_dir(path: &Path) -> anyhow::Result<()> {
    if !path.exists() {
        return Ok(());
    }

    // If there's no DB yet, nothing to do.
    if !path.join("db").exists() {
        return Ok(());
    }

    // 1) Remove unexpected keys + prune events.
    {
        let db = sled::open(path)?;

        let mut batch: Vec<sled::IVec> = Vec::with_capacity(2048);
        for res in db.iter() {
            let (k, _v) = res?;
            if !is_allowed_key(&k) {
                batch.push(k);
                if batch.len() >= 2048 {
                    for key in batch.drain(..) {
                        let _ = db.remove(key);
                    }
                }
            }
        }
        for key in batch.drain(..) {
            let _ = db.remove(key);
        }

        Store::prune_usage_requests_db(&db);
        db.flush()?;
    } // drop DB handle (important for Windows rename)

    // 2) If still too large, rebuild in a new directory and swap.
    let size = dir_size_bytes(path);
    if size <= Store::MAX_DB_BYTES {
        return Ok(());
    }

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let tmp_dir = parent.join("sled.compact.tmp");
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir)?;

    {
        let src = sled::open(path)?;
        let dst = sled::open(&tmp_dir)?;
        for res in src.iter() {
            let (k, v) = res?;
            if is_allowed_key(&k) {
                let _ = dst.insert(k, v);
            }
        }
        dst.flush()?;
        src.flush()?;
    }

    // Swap directories. If installing the compacted DB fails, attempt to restore from backup.
    let backup = parent.join(format!("sled.bak.{}", unix_ms()));
    if backup.exists() {
        let _ = std::fs::remove_dir_all(&backup);
    }
    if let Err(e) = std::fs::rename(path, &backup) {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err(e.into());
    }
    if let Err(e2) = std::fs::rename(&tmp_dir, path) {
        // Best-effort rollback: restore the original DB directory if possible.
        let rollback = std::fs::rename(&backup, path);
        let _ = std::fs::remove_dir_all(&tmp_dir);
        match rollback {
            Ok(_) => {
                return Err(anyhow::anyhow!(
                    "failed to install compacted store: {e2} (restored from backup)"
                ));
            }
            Err(e3) => {
                return Err(anyhow::anyhow!(
                    "failed to install compacted store: {e2}; rollback failed: {e3} (backup at {})",
                    backup.display()
                ));
            }
        }
    }
    let _ = std::fs::remove_dir_all(&backup);

    Ok(())
}

include!("store/tests.rs");
