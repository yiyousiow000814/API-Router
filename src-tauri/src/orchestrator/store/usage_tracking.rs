use super::*;

impl Store {
    pub fn list_usage_days(&self, provider: &str) -> Vec<Value> {
        let prefix = format!("usage_day:{provider}:");
        self.db
            .scan_prefix(prefix.as_bytes())
            .filter_map(|res| res.ok())
            .filter_map(|(_, v)| serde_json::from_slice::<Value>(&v).ok())
            .collect()
    }

    pub fn get_spend_state(&self, provider: &str) -> Option<Value> {
        let key = format!("spend_state:{provider}");
        self.db
            .get(key.as_bytes())
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_slice::<Value>(&v).ok())
    }

    pub fn put_spend_state(&self, provider: &str, state: &Value) {
        let key = format!("spend_state:{provider}");
        let _ = self.db.insert(
            key.as_bytes(),
            serde_json::to_vec(state).unwrap_or_default(),
        );
        let _ = self.db.flush();
    }

    pub fn get_spend_day(&self, provider: &str, day_started_at_unix_ms: u64) -> Option<Value> {
        let key = format!("spend_day:{provider}:{day_started_at_unix_ms:013}");
        self.db
            .get(key.as_bytes())
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_slice::<Value>(&v).ok())
    }

    pub fn put_spend_day(&self, provider: &str, day_started_at_unix_ms: u64, day: &Value) {
        let key = format!("spend_day:{provider}:{day_started_at_unix_ms:013}");
        let _ = self
            .db
            .insert(key.as_bytes(), serde_json::to_vec(day).unwrap_or_default());
        let _ = self.db.flush();
    }

    pub fn list_spend_days(&self, provider: &str) -> Vec<Value> {
        let prefix = format!("spend_day:{provider}:");
        self.db
            .scan_prefix(prefix.as_bytes())
            .filter_map(|res| res.ok())
            .filter_map(|(_, v)| serde_json::from_slice::<Value>(&v).ok())
            .collect()
    }

    pub fn put_spend_manual_day(&self, provider: &str, day_key: &str, day: &Value) {
        let key = format!("spend_manual_day:{provider}:{day_key}");
        let _ = self
            .db
            .insert(key.as_bytes(), serde_json::to_vec(day).unwrap_or_default());
        let _ = self.db.flush();
    }

    pub fn remove_spend_manual_day(&self, provider: &str, day_key: &str) {
        let key = format!("spend_manual_day:{provider}:{day_key}");
        let _ = self.db.remove(key.as_bytes());
        let _ = self.db.flush();
    }

    pub fn list_spend_manual_days(&self, provider: &str) -> Vec<Value> {
        let prefix = format!("spend_manual_day:{provider}:");
        self.db
            .scan_prefix(prefix.as_bytes())
            .filter_map(|res| res.ok())
            .filter_map(|(_, v)| serde_json::from_slice::<Value>(&v).ok())
            .collect()
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

    pub(super) fn extract_usage_tokens(response_obj: &Value) -> (u64, u64, u64, u64, u64) {
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
        let cache_creation_input_tokens = usage
            .get("cache_creation_input_tokens")
            .and_then(|v| v.as_u64())
            .or_else(|| {
                response_obj
                    .pointer("/usage/cache_creation_input_tokens")
                    .and_then(|v| v.as_u64())
            })
            .unwrap_or(0);
        let cache_read_input_tokens = usage
            .get("cache_read_input_tokens")
            .and_then(|v| v.as_u64())
            .or_else(|| {
                usage
                    .pointer("/input_tokens_details/cached_tokens")
                    .and_then(|v| v.as_u64())
            })
            .or_else(|| {
                response_obj
                    .pointer("/usage/cache_read_input_tokens")
                    .and_then(|v| v.as_u64())
            })
            .or_else(|| {
                response_obj
                    .pointer("/usage/input_tokens_details/cached_tokens")
                    .and_then(|v| v.as_u64())
            })
            .unwrap_or(0);
        (
            input_tokens,
            output_tokens,
            total_tokens,
            cache_creation_input_tokens,
            cache_read_input_tokens,
        )
    }

    fn extract_model(response_obj: &Value) -> String {
        extract_response_model_option(response_obj).unwrap_or_else(|| "unknown".to_string())
    }

    pub(super) fn model_for_usage(response_obj: &Value, model_override: Option<&str>) -> String {
        if let Some(model) = model_override.map(str::trim).filter(|s| !s.is_empty()) {
            return model.to_string();
        }
        Self::extract_model(response_obj)
    }

    pub(super) fn add_usage_request(
        &self,
        provider: &str,
        model: &str,
        increments: UsageTokenIncrements,
        api_key_ref: Option<&str>,
        origin: &str,
        flush: bool,
    ) {
        let origin = match origin.trim().to_ascii_lowercase().as_str() {
            crate::constants::USAGE_ORIGIN_WINDOWS => crate::constants::USAGE_ORIGIN_WINDOWS,
            crate::constants::USAGE_ORIGIN_WSL2 => crate::constants::USAGE_ORIGIN_WSL2,
            _ => crate::constants::USAGE_ORIGIN_UNKNOWN,
        };
        let ts = unix_ms();
        let id = uuid::Uuid::new_v4().to_string();
        let key = format!("usage_req:{ts}:{id}");
        let v = serde_json::json!({
            "provider": provider,
            "api_key_ref": api_key_ref.unwrap_or("-"),
            "model": model,
            "origin": origin,
            "unix_ms": ts,
            "input_tokens": increments.input_tokens,
            "output_tokens": increments.output_tokens,
            "total_tokens": increments.total_tokens,
            "cache_creation_input_tokens": increments.cache_creation_input_tokens,
            "cache_read_input_tokens": increments.cache_read_input_tokens,
        });
        let _ = self
            .db
            .insert(key.as_bytes(), serde_json::to_vec(&v).unwrap_or_default());
        self.bump_usage_day(provider, ts, increments);
        // Avoid full usage_req scan on every request; keep storage bounded with periodic pruning.
        let seq = self.usage_prune_seq.fetch_add(1, Ordering::Relaxed) + 1;
        if seq % Self::USAGE_PRUNE_EVERY == 0 {
            self.prune_usage_requests();
        }
        if flush {
            let _ = self.db.flush();
        }
    }

    fn local_day_key(ts_unix_ms: u64) -> String {
        let ts = ts_unix_ms as i64;
        if let Some(dt) = Local.timestamp_millis_opt(ts).single() {
            dt.format("%Y-%m-%d").to_string()
        } else {
            "1970-01-01".to_string()
        }
    }

    fn bump_usage_day(&self, provider: &str, ts_unix_ms: u64, increments: UsageTokenIncrements) {
        let day_key = Self::local_day_key(ts_unix_ms);
        let key = format!("usage_day:{provider}:{day_key}");
        let cur = self
            .db
            .get(key.as_bytes())
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_slice::<Value>(&v).ok())
            .unwrap_or_else(|| {
                serde_json::json!({
                    "provider": provider,
                    "day_key": day_key,
                    "req_count": 0u64,
                    "input_tokens": 0u64,
                    "output_tokens": 0u64,
                    "total_tokens": 0u64,
                    "cache_creation_input_tokens": 0u64,
                    "cache_read_input_tokens": 0u64,
                    "updated_at_unix_ms": 0u64
                })
            });

        let next = serde_json::json!({
            "provider": provider,
            "day_key": day_key,
            "req_count": cur.get("req_count").and_then(|v| v.as_u64()).unwrap_or(0).saturating_add(1),
            "input_tokens": cur.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0).saturating_add(increments.input_tokens),
            "output_tokens": cur.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0).saturating_add(increments.output_tokens),
            "total_tokens": cur.get("total_tokens").and_then(|v| v.as_u64()).unwrap_or(0).saturating_add(increments.total_tokens),
            "cache_creation_input_tokens": cur
                .get("cache_creation_input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0)
                .saturating_add(increments.cache_creation_input_tokens),
            "cache_read_input_tokens": cur
                .get("cache_read_input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0)
                .saturating_add(increments.cache_read_input_tokens),
            "updated_at_unix_ms": ts_unix_ms
        });
        let _ = self.db.insert(
            key.as_bytes(),
            serde_json::to_vec(&next).unwrap_or_default(),
        );
    }
}
