impl Store {
fn allowed_key_prefixes() -> [&'static [u8]; 9] {
    [
        b"event:",
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

fn allowed_exact_keys() -> [&'static [u8]; 3] {
    [
        b"codex_account:snapshot",
        b"official_web:snapshot",
        Self::EVENTS_SCHEMA_KEY,
    ]
}

pub fn open(path: &std::path::Path) -> Result<Self, sled::Error> {
    let db = sled::open(path)?;
    let store = Self {
        db,
        usage_prune_seq: Arc::new(AtomicU64::new(0)),
    };
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

fn is_valid_usage_request(j: &Value) -> bool {
    j.get("provider").and_then(|v| v.as_str()).is_some()
        && j.get("model").and_then(|v| v.as_str()).is_some()
        && j.get("unix_ms").and_then(|v| v.as_u64()).is_some()
        && j.get("input_tokens").and_then(|v| v.as_u64()).is_some()
        && j.get("output_tokens").and_then(|v| v.as_u64()).is_some()
        && j.get("total_tokens").and_then(|v| v.as_u64()).is_some()
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
    self.prune_events();
    let _ = self.db.flush();
}

pub fn record_success(&self, provider: &str, response_obj: &Value) {
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
        &Self::extract_model(response_obj),
        increments,
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

}
