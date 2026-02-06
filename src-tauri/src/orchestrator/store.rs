use serde_json::Value;
use std::path::Path;

#[derive(Clone)]
pub struct Store {
    db: sled::Db,
}

const LEDGER_DEFAULT: &str = r#"{"since_last_quota_refresh_input_tokens":0,"since_last_quota_refresh_output_tokens":0,"since_last_quota_refresh_total_tokens":0,"last_reset_unix_ms":0}"#;

impl Store {
    const MAX_EVENTS: usize = 200;
    const MAX_DB_BYTES: u64 = 64 * 1024 * 1024; // 64 MiB, best-effort cap via compaction

    // Breaking-change friendly: bump this to invalidate old persisted event shapes.
    const EVENTS_SCHEMA_VERSION: &'static [u8] = b"1";
    const EVENTS_SCHEMA_KEY: &'static [u8] = b"events:schema_version";

    fn allowed_key_prefixes() -> [&'static [u8]; 4] {
        [b"event:", b"metrics:", b"quota:", b"ledger:"]
    }

    fn allowed_exact_keys() -> [&'static [u8]; 3] {
        [
            b"codex_account:snapshot",
            b"official_web:snapshot",
            Self::EVENTS_SCHEMA_KEY,
        ]
    }

    pub fn open(path: &std::path::Path) -> Result<Self, sled::Error> {
        let db = sled::open(path)?;
        let store = Self { db };
        store.ensure_events_schema();
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

    fn clear_events(&self) {
        let mut batch: Vec<sled::IVec> = Vec::with_capacity(2048);
        for res in self.db.scan_prefix(b"event:") {
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
        let _ = self.db.flush();
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

    fn prune_events(&self) {
        // Keep only the newest MAX_EVENTS event keys.
        // Keys are `event:{unix_ms}:{uuid}` and are lexicographically ordered by time.
        let boundary = self.db.scan_prefix(b"event:").rev().nth(Self::MAX_EVENTS);

        let Some(Ok((end_key, _))) = boundary else {
            return;
        };

        let start = b"event:".to_vec();
        let end = end_key.to_vec();

        // Delete in chunks to avoid building a huge Vec if the DB grew large.
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

    fn prune_events_db(db: &sled::Db) {
        let boundary = db.scan_prefix(b"event:").rev().nth(Self::MAX_EVENTS);
        let Some(Ok((end_key, _))) = boundary else {
            return;
        };

        let start = b"event:".to_vec();
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
        self.prune_events();
        let _ = self.db.flush();
    }

    pub fn record_success(&self, provider: &str, response_obj: &Value) {
        let usage = response_obj.get("usage").cloned().unwrap_or(Value::Null);
        let input_tokens = usage
            .get("input_tokens")
            .and_then(|v| v.as_u64())
            .or_else(|| {
                response_obj
                    .pointer("/usage/input_tokens")
                    .and_then(|v| v.as_u64())
            })
            .unwrap_or(0);
        let output_tokens = usage
            .get("output_tokens")
            .and_then(|v| v.as_u64())
            .or_else(|| {
                response_obj
                    .pointer("/usage/output_tokens")
                    .and_then(|v| v.as_u64())
            })
            .unwrap_or(0);
        let total_tokens = usage
            .get("total_tokens")
            .and_then(|v| v.as_u64())
            .or_else(|| {
                response_obj
                    .pointer("/usage/total_tokens")
                    .and_then(|v| v.as_u64())
            })
            .unwrap_or(input_tokens + output_tokens);

        self.bump_metrics(provider, 1, 0, total_tokens);
        self.bump_ledger(provider, input_tokens, output_tokens, total_tokens);
    }

    pub fn record_failure(&self, provider: &str) {
        self.bump_metrics(provider, 0, 1, 0);
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

    fn bump_metrics(&self, provider: &str, ok_inc: u64, err_inc: u64, tokens_inc: u64) {
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
        let _ = self.db.flush();
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
        for prefix in ["metrics:", "quota:", "ledger:"] {
            let old_key = format!("{prefix}{old}");
            if let Ok(Some(v)) = self.db.get(old_key.as_bytes()) {
                let new_key = format!("{prefix}{new}");
                let _ = self.db.insert(new_key.as_bytes(), v);
                let _ = self.db.remove(old_key.as_bytes());
            }
        }
        let _ = self.db.flush();
    }

    fn bump_ledger(&self, provider: &str, input_inc: u64, output_inc: u64, total_inc: u64) {
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
        let _ = self.db.flush();
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
            .take(limit)
            .filter_map(|res| res.ok())
            .filter_map(|(_, v)| serde_json::from_slice::<Value>(&v).ok())
            .filter(|j| Self::is_valid_event(j))
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

    pub fn put_codex_account_snapshot(&self, snapshot: &Value) {
        let _ = self.db.insert(
            b"codex_account:snapshot",
            serde_json::to_vec(snapshot).unwrap_or_default(),
        );
        let _ = self.db.flush();
    }

    pub fn get_codex_account_snapshot(&self) -> Option<Value> {
        if let Ok(Some(v)) = self.db.get(b"codex_account:snapshot") {
            return serde_json::from_slice(&v).ok();
        }
        let v = self.db.get(b"official_web:snapshot").ok()??;
        serde_json::from_slice(&v).ok()
    }
}

pub fn unix_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn dir_size_bytes(path: &Path) -> u64 {
    fn walk(p: &Path, sum: &mut u64) {
        let Ok(rd) = std::fs::read_dir(p) else {
            return;
        };
        for entry in rd.flatten() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                walk(&entry.path(), sum);
            } else {
                *sum = sum.saturating_add(meta.len());
            }
        }
    }

    let mut sum = 0u64;
    walk(path, &mut sum);
    sum
}

fn is_allowed_key(key: &[u8]) -> bool {
    Store::allowed_key_prefixes()
        .iter()
        .any(|p| key.starts_with(p))
        || Store::allowed_exact_keys().contains(&key)
}

/// Best-effort maintenance to keep the on-disk DB bounded:
/// - remove unexpected keys (e.g. large cached payloads) from this store
/// - prune events to MAX_EVENTS
/// - if the directory is still huge, rebuild a compacted DB with only allowed keys
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

        Store::prune_events_db(&db);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_events_reads_latest_without_full_scan() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();

        // Insert out-of-order timestamps; iteration should return newest-first by key order.
        let mk = |ts: u64, id: &str| format!("event:{ts}:{id}");
        let v = |ts: u64| {
            serde_json::json!({
                "provider": "p1",
                "level": "info",
                "unix_ms": ts,
                "code": "test_event",
                "message": "hello",
                "fields": serde_json::json!({}),
            })
        };

        let _ = store.db.insert(
            mk(1000, "a").as_bytes(),
            serde_json::to_vec(&v(1000)).unwrap(),
        );
        let _ = store.db.insert(
            mk(3000, "c").as_bytes(),
            serde_json::to_vec(&v(3000)).unwrap(),
        );
        let _ = store.db.insert(
            mk(2000, "b").as_bytes(),
            serde_json::to_vec(&v(2000)).unwrap(),
        );

        let out = store.list_events(2);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].get("unix_ms").and_then(|v| v.as_u64()), Some(3000));
        assert_eq!(out[1].get("unix_ms").and_then(|v| v.as_u64()), Some(2000));
    }

    #[test]
    fn maintain_store_dir_removes_unexpected_prefixes() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();

        // Create a DB with both expected and unexpected keys.
        {
            let db = sled::open(&dir).unwrap();
            // Make the store look like a modern one (schema marker + valid event payload).
            let _ = db.insert(Store::EVENTS_SCHEMA_KEY, Store::EVENTS_SCHEMA_VERSION);
            let _ = db.insert(
                b"event:1:a",
                &br#"{"provider":"p1","level":"info","unix_ms":1,"code":"test_event","message":"hello","fields":{}}"#[..],
            );
            let _ = db.insert(b"metrics:p1", b"{\"ok_requests\":1}");
            let _ = db.insert(b"resp:resp_test", b"big payload");
            db.flush().unwrap();
        }

        maintain_store_dir(&dir).unwrap();

        let db = sled::open(&dir).unwrap();
        assert!(db.get(b"event:1:a").unwrap().is_some());
        assert!(db.get(b"metrics:p1").unwrap().is_some());
        assert!(db.get(b"resp:resp_test").unwrap().is_none());
    }
}
