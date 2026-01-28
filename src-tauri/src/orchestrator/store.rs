use serde_json::Value;

#[derive(Clone)]
pub struct Store {
    db: sled::Db,
}

const LEDGER_DEFAULT: &str = r#"{"since_last_quota_refresh_input_tokens":0,"since_last_quota_refresh_output_tokens":0,"since_last_quota_refresh_total_tokens":0,"last_reset_unix_ms":0}"#;

impl Store {
    pub fn open(path: &std::path::Path) -> Result<Self, sled::Error> {
        let db = sled::open(path)?;
        Ok(Self { db })
    }

    pub fn put_exchange(
        &self,
        response_id: &str,
        parent_id: Option<&str>,
        request: &Value,
        response: &Value,
    ) -> Result<(), sled::Error> {
        let key = format!("resp:{response_id}");
        let mut obj = serde_json::Map::new();
        obj.insert(
            "parent_id".to_string(),
            parent_id
                .map(|s| Value::String(s.to_string()))
                .unwrap_or(Value::Null),
        );
        obj.insert("request".to_string(), request.clone());
        obj.insert("response".to_string(), response.clone());
        let bytes = serde_json::to_vec(&Value::Object(obj)).unwrap_or_default();
        self.db.insert(key.as_bytes(), bytes)?;
        Ok(())
    }

    pub fn get_exchange(&self, response_id: &str) -> Option<Value> {
        let key = format!("resp:{response_id}");
        let v = self.db.get(key.as_bytes()).ok()??;
        serde_json::from_slice(&v).ok()
    }

    pub fn get_parent(&self, response_id: &str) -> Option<String> {
        let ex = self.get_exchange(response_id)?;
        ex.get("parent_id")?.as_str().map(|s| s.to_string())
    }

    pub fn add_event(&self, provider: &str, level: &str, message: &str) {
        let ts = unix_ms();
        let id = uuid::Uuid::new_v4().to_string();
        let key = format!("event:{ts}:{id}");
        let v = serde_json::json!({
            "provider": provider,
            "level": level,
            "unix_ms": ts,
            "message": message
        });
        let _ = self
            .db
            .insert(key.as_bytes(), serde_json::to_vec(&v).unwrap_or_default());
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

    pub fn list_events(&self, limit: usize) -> Vec<Value> {
        let mut out = Vec::new();
        for (_, v) in self.db.scan_prefix(b"event:").flatten() {
            if let Ok(j) = serde_json::from_slice::<Value>(&v) {
                out.push(j);
            }
        }
        // Keep most-recent-last semantics by sorting on unix_ms then slicing.
        out.sort_by_key(|v| v.get("unix_ms").and_then(|x| x.as_u64()).unwrap_or(0));
        out.into_iter().rev().take(limit).collect()
    }
}

pub fn unix_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
