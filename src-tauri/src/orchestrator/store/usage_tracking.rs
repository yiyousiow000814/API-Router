use super::*;
use rusqlite::params;
use std::collections::BTreeSet;

impl Store {
    pub fn list_usage_history_providers(&self) -> BTreeSet<String> {
        fn provider_from_prefixed_key(key: &[u8], prefix: &str) -> Option<String> {
            let text = std::str::from_utf8(key).ok()?;
            let rest = text.strip_prefix(prefix)?;
            let provider = rest.split(':').next()?.trim();
            if provider.is_empty() {
                None
            } else {
                Some(provider.to_string())
            }
        }

        let mut providers = BTreeSet::new();
        for prefix in ["usage_day:", "spend_day:", "spend_manual_day:"] {
            for res in self.db.scan_prefix(prefix.as_bytes()) {
                let Ok((key, _)) = res else {
                    continue;
                };
                if let Some(provider) = provider_from_prefixed_key(key.as_ref(), prefix) {
                    providers.insert(provider);
                }
            }
        }
        let conn = self.events_db.lock();
        let sqlite_provider_queries = [
            "SELECT DISTINCT provider FROM usage_requests",
            "SELECT DISTINCT provider FROM spend_days",
            "SELECT DISTINCT provider FROM spend_manual_days",
            "SELECT DISTINCT provider FROM provider_pricing_configs",
        ];
        for sql in sqlite_provider_queries {
            let Ok(mut stmt) = conn.prepare(sql) else {
                continue;
            };
            let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) else {
                continue;
            };
            for provider in rows.flatten() {
                let trimmed = provider.trim();
                if !trimmed.is_empty() {
                    providers.insert(trimmed.to_string());
                }
            }
        }
        providers
    }

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
        if let Ok(day_started_at_i64) = i64::try_from(day_started_at_unix_ms) {
            let conn = self.events_db.lock();
            if let Ok(Some(row_json)) = conn
                .query_row(
                    "SELECT row_json FROM spend_days WHERE provider = ?1 AND day_started_at_unix_ms = ?2",
                    params![provider, day_started_at_i64],
                    |row| row.get::<_, String>(0),
                )
                .optional()
            {
                if let Ok(value) = serde_json::from_str::<Value>(&row_json) {
                    return Some(value);
                }
            }
        }
        let key = format!("spend_day:{provider}:{day_started_at_unix_ms:013}");
        self.db
            .get(key.as_bytes())
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_slice::<Value>(&v).ok())
    }

    pub fn put_spend_day(&self, provider: &str, day_started_at_unix_ms: u64, day: &Value) {
        if let Ok(day_started_at_i64) = i64::try_from(day_started_at_unix_ms) {
            let conn = self.events_db.lock();
            let _ = conn.execute(
                "INSERT INTO spend_days(provider, day_started_at_unix_ms, row_json)
                 VALUES(?1, ?2, ?3)
                 ON CONFLICT(provider, day_started_at_unix_ms) DO UPDATE SET row_json = excluded.row_json",
                params![
                    provider,
                    day_started_at_i64,
                    serde_json::to_string(day).unwrap_or_else(|_| "{}".to_string())
                ],
            );
        }
        let key = format!("spend_day:{provider}:{day_started_at_unix_ms:013}");
        let _ = self
            .db
            .insert(key.as_bytes(), serde_json::to_vec(day).unwrap_or_default());
        let _ = self.db.flush();
    }

    pub fn list_spend_days(&self, provider: &str) -> Vec<Value> {
        let conn = self.events_db.lock();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT row_json
             FROM spend_days
             WHERE provider = ?1
             ORDER BY day_started_at_unix_ms ASC",
        ) {
            if let Ok(rows) = stmt.query_map([provider], |row| row.get::<_, String>(0)) {
                let parsed = rows
                    .flatten()
                    .filter_map(|row_json| serde_json::from_str::<Value>(&row_json).ok())
                    .collect::<Vec<_>>();
                if !parsed.is_empty() {
                    return parsed;
                }
            }
        }
        let prefix = format!("spend_day:{provider}:");
        self.db
            .scan_prefix(prefix.as_bytes())
            .filter_map(|res| res.ok())
            .filter_map(|(_, v)| serde_json::from_slice::<Value>(&v).ok())
            .collect()
    }

    pub fn put_spend_manual_day(&self, provider: &str, day_key: &str, day: &Value) {
        let conn = self.events_db.lock();
        let _ = conn.execute(
            "INSERT INTO spend_manual_days(provider, day_key, row_json)
             VALUES(?1, ?2, ?3)
             ON CONFLICT(provider, day_key) DO UPDATE SET row_json = excluded.row_json",
            params![
                provider,
                day_key,
                serde_json::to_string(day).unwrap_or_else(|_| "{}".to_string())
            ],
        );
        let key = format!("spend_manual_day:{provider}:{day_key}");
        let _ = self
            .db
            .insert(key.as_bytes(), serde_json::to_vec(day).unwrap_or_default());
        let _ = self.db.flush();
    }

    pub fn remove_spend_manual_day(&self, provider: &str, day_key: &str) {
        let conn = self.events_db.lock();
        let _ = conn.execute(
            "DELETE FROM spend_manual_days WHERE provider = ?1 AND day_key = ?2",
            params![provider, day_key],
        );
        let key = format!("spend_manual_day:{provider}:{day_key}");
        let _ = self.db.remove(key.as_bytes());
        let _ = self.db.flush();
    }

    pub fn list_spend_manual_days(&self, provider: &str) -> Vec<Value> {
        let conn = self.events_db.lock();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT row_json
             FROM spend_manual_days
             WHERE provider = ?1
             ORDER BY day_key ASC",
        ) {
            if let Ok(rows) = stmt.query_map([provider], |row| row.get::<_, String>(0)) {
                let parsed = rows
                    .flatten()
                    .filter_map(|row_json| serde_json::from_str::<Value>(&row_json).ok())
                    .collect::<Vec<_>>();
                if !parsed.is_empty() {
                    return parsed;
                }
            }
        }
        let prefix = format!("spend_manual_day:{provider}:");
        self.db
            .scan_prefix(prefix.as_bytes())
            .filter_map(|res| res.ok())
            .filter_map(|(_, v)| serde_json::from_slice::<Value>(&v).ok())
            .collect()
    }

    pub fn list_provider_pricing_configs(
        &self,
    ) -> std::collections::BTreeMap<String, crate::orchestrator::secrets::ProviderPricingConfig>
    {
        let mut out = std::collections::BTreeMap::new();
        let conn = self.events_db.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT provider, pricing_json
             FROM provider_pricing_configs
             ORDER BY provider ASC",
        ) else {
            return out;
        };
        let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) else {
            return out;
        };
        for (provider, pricing_json) in rows.flatten() {
            if let Ok(pricing) = serde_json::from_str::<
                crate::orchestrator::secrets::ProviderPricingConfig,
            >(&pricing_json)
            {
                out.insert(provider, pricing);
            }
        }
        out
    }

    pub fn sync_provider_pricing_configs(
        &self,
        pricing: &std::collections::BTreeMap<
            String,
            crate::orchestrator::secrets::ProviderPricingConfig,
        >,
    ) {
        let conn = self.events_db.lock();
        let tx = match conn.unchecked_transaction() {
            Ok(tx) => tx,
            Err(_) => return,
        };
        for (provider, config) in pricing {
            let updated_at_unix_ms = config
                .periods
                .iter()
                .map(|period| {
                    period
                        .started_at_unix_ms
                        .max(period.ended_at_unix_ms.unwrap_or(0))
                })
                .max()
                .unwrap_or_else(unix_ms);
            let updated_at_i64 = match i64::try_from(updated_at_unix_ms) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let pricing_json = match serde_json::to_string(config) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let _ = tx.execute(
                "INSERT INTO provider_pricing_configs(provider, pricing_json, updated_at_unix_ms)
                 VALUES(?1, ?2, ?3)
                 ON CONFLICT(provider) DO UPDATE SET
                   pricing_json = excluded.pricing_json,
                   updated_at_unix_ms = excluded.updated_at_unix_ms",
                params![provider, pricing_json, updated_at_i64],
            );
        }
        let _ = tx.commit();
    }

    pub fn migrate_spend_history_from_sled_if_needed(&self) -> anyhow::Result<()> {
        let done = self.get_event_meta(Self::SPEND_HISTORY_SQLITE_MIGRATED_FROM_SLED_KEY)?;
        if done.as_deref() == Some("1") {
            return Ok(());
        }
        let mut should_mark_done = false;
        {
            let conn = self.events_db.lock();
            let has_spend_day: Option<i64> = conn
                .query_row("SELECT 1 FROM spend_days LIMIT 1", [], |row| row.get(0))
                .optional()?;
            let has_manual_day: Option<i64> = conn
                .query_row("SELECT 1 FROM spend_manual_days LIMIT 1", [], |row| {
                    row.get(0)
                })
                .optional()?;
            if has_spend_day.is_some() || has_manual_day.is_some() {
                should_mark_done = true;
            }
        }
        if should_mark_done {
            self.set_event_meta(Self::SPEND_HISTORY_SQLITE_MIGRATED_FROM_SLED_KEY, "1")?;
            return Ok(());
        }

        let conn = self.events_db.lock();
        let tx = conn.unchecked_transaction()?;
        for res in self.db.scan_prefix(b"spend_day:") {
            let Ok((key, value)) = res else {
                continue;
            };
            let Ok(key_text) = std::str::from_utf8(key.as_ref()) else {
                continue;
            };
            let mut parts = key_text.splitn(3, ':');
            let (_prefix, Some(provider), Some(day_started)) =
                (parts.next(), parts.next(), parts.next())
            else {
                continue;
            };
            let Ok(day_started_at_unix_ms) = day_started.parse::<i64>() else {
                continue;
            };
            let Ok(row_json) = std::str::from_utf8(value.as_ref()) else {
                continue;
            };
            let _ = tx.execute(
                "INSERT INTO spend_days(provider, day_started_at_unix_ms, row_json)
                 VALUES(?1, ?2, ?3)
                 ON CONFLICT(provider, day_started_at_unix_ms) DO UPDATE SET row_json = excluded.row_json",
                params![provider, day_started_at_unix_ms, row_json],
            );
        }
        for res in self.db.scan_prefix(b"spend_manual_day:") {
            let Ok((key, value)) = res else {
                continue;
            };
            let Ok(key_text) = std::str::from_utf8(key.as_ref()) else {
                continue;
            };
            let mut parts = key_text.splitn(3, ':');
            let (_prefix, Some(provider), Some(day_key)) =
                (parts.next(), parts.next(), parts.next())
            else {
                continue;
            };
            let Ok(row_json) = std::str::from_utf8(value.as_ref()) else {
                continue;
            };
            let _ = tx.execute(
                "INSERT INTO spend_manual_days(provider, day_key, row_json)
                 VALUES(?1, ?2, ?3)
                 ON CONFLICT(provider, day_key) DO UPDATE SET row_json = excluded.row_json",
                params![provider, day_key, row_json],
            );
        }
        tx.commit()?;
        drop(conn);
        self.set_event_meta(Self::SPEND_HISTORY_SQLITE_MIGRATED_FROM_SLED_KEY, "1")?;
        Ok(())
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
        context: UsageRequestContext<'_>,
    ) {
        let origin = match context.origin.trim().to_ascii_lowercase().as_str() {
            crate::constants::USAGE_ORIGIN_WINDOWS => crate::constants::USAGE_ORIGIN_WINDOWS,
            crate::constants::USAGE_ORIGIN_WSL2 => crate::constants::USAGE_ORIGIN_WSL2,
            _ => crate::constants::USAGE_ORIGIN_UNKNOWN,
        };
        let ts = unix_ms();
        let id = uuid::Uuid::new_v4().to_string();
        let session_id = context
            .session_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("-");
        let node_id = context
            .node_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("");
        let node_name = context
            .node_name
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("");
        if let Ok(ts_i64) = i64::try_from(ts) {
            let conn = self.events_db.lock();
            let _ = conn.execute(
                "INSERT INTO usage_requests(
                    id, unix_ms, ingested_at_unix_ms, provider, api_key_ref, model, origin, session_id, node_id, node_name,
                    input_tokens, output_tokens, total_tokens,
                    cache_creation_input_tokens, cache_read_input_tokens
                 ) VALUES(?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    id,
                    ts_i64,
                    provider,
                    context.api_key_ref.unwrap_or("-"),
                    model,
                    origin,
                    session_id,
                    node_id,
                    node_name,
                    i64::try_from(increments.input_tokens).unwrap_or(i64::MAX),
                    i64::try_from(increments.output_tokens).unwrap_or(i64::MAX),
                    i64::try_from(increments.total_tokens).unwrap_or(i64::MAX),
                    i64::try_from(increments.cache_creation_input_tokens).unwrap_or(i64::MAX),
                    i64::try_from(increments.cache_read_input_tokens).unwrap_or(i64::MAX),
                ],
            );
        }
        self.bump_usage_day(provider, ts, increments);
        let _ = self.db.flush();
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::gateway::open_store_dir;
    use crate::orchestrator::secrets::{ProviderPricingConfig, ProviderPricingPeriod};

    #[test]
    fn list_usage_history_providers_includes_sled_and_sql_sources() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = open_store_dir(tmp.path().join("data")).expect("store");
        store.put_spend_day(
            "archived-packycode",
            1_700_000_000_000,
            &serde_json::json!({
                "started_at_unix_ms": 1_700_000_000_000u64,
                "tracked_spend_usd": 12.3
            }),
        );
        store.put_spend_manual_day(
            "manual-only-provider",
            "2026-02-18",
            &serde_json::json!({
                "day_key": "2026-02-18",
                "manual_total_usd": 5.0
            }),
        );
        store.add_usage_request(
            "sql-only-provider",
            "gpt-5",
            UsageTokenIncrements {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            },
            UsageRequestContext {
                api_key_ref: Some("key-1"),
                origin: crate::constants::USAGE_ORIGIN_WINDOWS,
                session_id: Some("session-1"),
                node_id: Some("node-a"),
                node_name: Some("Desk A"),
            },
        );

        let providers = store.list_usage_history_providers();

        assert!(providers.contains("archived-packycode"));
        assert!(providers.contains("manual-only-provider"));
        assert!(providers.contains("sql-only-provider"));
    }

    #[test]
    fn provider_pricing_configs_roundtrip_via_sqlite() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = open_store_dir(tmp.path().join("data")).expect("store");
        let pricing = std::collections::BTreeMap::from([(
            "packycode".to_string(),
            ProviderPricingConfig {
                mode: "per_request".to_string(),
                amount_usd: 0.035,
                periods: vec![ProviderPricingPeriod {
                    id: "period-1".to_string(),
                    mode: "per_request".to_string(),
                    amount_usd: 0.035,
                    api_key_ref: "sk-test".to_string(),
                    started_at_unix_ms: 1_700_000_000_000,
                    ended_at_unix_ms: None,
                }],
                gap_fill_mode: Some("per_request".to_string()),
                gap_fill_amount_usd: Some(0.04),
            },
        )]);

        store.sync_provider_pricing_configs(&pricing);
        let loaded = store.list_provider_pricing_configs();

        assert_eq!(loaded, pricing);
    }

    #[test]
    fn migrate_spend_history_from_sled_copies_legacy_rows_to_sqlite() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = open_store_dir(tmp.path().join("data")).expect("store");

        let legacy_spend_day = serde_json::json!({
            "provider": "legacy-provider",
            "started_at_unix_ms": 1_700_000_000_000u64,
            "tracked_spend_usd": 12.3
        });
        let legacy_manual_day = serde_json::json!({
            "provider": "legacy-provider",
            "day_key": "2026-03-31",
            "manual_total_usd": 5.0
        });
        store
            .db
            .insert(
                b"spend_day:legacy-provider:1700000000000",
                serde_json::to_vec(&legacy_spend_day).expect("legacy spend day json"),
            )
            .expect("insert legacy spend day");
        store
            .db
            .insert(
                b"spend_manual_day:legacy-provider:2026-03-31",
                serde_json::to_vec(&legacy_manual_day).expect("legacy manual day json"),
            )
            .expect("insert legacy manual day");
        store
            .set_event_meta(Store::SPEND_HISTORY_SQLITE_MIGRATED_FROM_SLED_KEY, "0")
            .expect("reset migration marker");

        {
            let conn = store.events_db.lock();
            conn.execute("DELETE FROM spend_days", [])
                .expect("clear spend_days");
            conn.execute("DELETE FROM spend_manual_days", [])
                .expect("clear spend_manual_days");
        }

        store
            .migrate_spend_history_from_sled_if_needed()
            .expect("migrate spend history");

        let spend_days = store.list_spend_days("legacy-provider");
        let manual_days = store.list_spend_manual_days("legacy-provider");

        assert_eq!(spend_days.len(), 1);
        assert_eq!(
            spend_days[0]
                .get("tracked_spend_usd")
                .and_then(|v| v.as_f64()),
            Some(12.3)
        );
        assert_eq!(manual_days.len(), 1);
        assert_eq!(
            manual_days[0]
                .get("manual_total_usd")
                .and_then(|v| v.as_f64()),
            Some(5.0)
        );
    }
}
