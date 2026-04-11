use super::*;
use rusqlite::params;

fn merge_json_source_fields(row: &mut Value, source_node_id: &str, source_node_name: &str) {
    let Some(map) = row.as_object_mut() else {
        return;
    };
    if map
        .get("producer_node_id")
        .and_then(Value::as_str)
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
    {
        map.insert(
            "producer_node_id".to_string(),
            Value::String(source_node_id.to_string()),
        );
    }
    if map
        .get("producer_node_name")
        .and_then(Value::as_str)
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
    {
        map.insert(
            "producer_node_name".to_string(),
            Value::String(source_node_name.to_string()),
        );
    }
}

fn list_json_rows_from_conn(
    conn: &rusqlite::Connection,
    query: &str,
    provider: &str,
) -> Vec<Value> {
    if let Ok(mut stmt) = conn.prepare(query) {
        if let Ok(rows) = stmt.query_map([provider], |row| row.get::<_, String>(0)) {
            return rows
                .flatten()
                .filter_map(|row_json| serde_json::from_str::<Value>(&row_json).ok())
                .collect();
        }
    }
    Vec::new()
}

fn parse_lan_edit_event_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<super::LanEditSyncEvent> {
    let payload_json = row.get::<_, String>(8)?;
    Ok(super::LanEditSyncEvent {
        event_id: row.get::<_, String>(0)?,
        node_id: row.get::<_, String>(1)?,
        node_name: row.get::<_, String>(2)?,
        created_at_unix_ms: u64::try_from(row.get::<_, i64>(3)?).unwrap_or(0),
        lamport_ts: u64::try_from(row.get::<_, i64>(4)?).unwrap_or(0),
        entity_type: row.get::<_, String>(5)?,
        entity_id: row.get::<_, String>(6)?,
        op: row.get::<_, String>(7)?,
        payload: serde_json::from_str(&payload_json).unwrap_or(Value::Null),
    })
}

impl Store {
    pub fn list_usage_request_stats_rows_window(
        &self,
        since_unix_ms: u64,
    ) -> Vec<UsageRequestStatsRow> {
        let Ok(since_i64) = i64::try_from(since_unix_ms) else {
            return Vec::new();
        };
        self.with_events_read_conn(|conn| {
            let mut out = Vec::new();
            let Ok(mut stmt) = conn.prepare(
                "SELECT
                   provider,
                   api_key_ref,
                   model,
                   origin,
                   node_name,
                   unix_ms,
                   input_tokens,
                   output_tokens,
                   total_tokens,
                   cache_creation_input_tokens,
                   cache_read_input_tokens
                 FROM usage_requests
                 WHERE unix_ms >= ?1
                 ORDER BY unix_ms DESC, id DESC",
            ) else {
                return out;
            };
            let Ok(rows) = stmt.query_map(params![since_i64], |row| {
                Ok(UsageRequestStatsRow {
                    provider: row.get::<_, String>(0)?,
                    api_key_ref: row.get::<_, String>(1)?,
                    model: row.get::<_, String>(2)?,
                    origin: row.get::<_, String>(3)?,
                    node_name: row.get::<_, String>(4)?,
                    unix_ms: u64::try_from(row.get::<_, i64>(5)?).unwrap_or(0),
                    input_tokens: u64::try_from(row.get::<_, i64>(6)?).unwrap_or(0),
                    output_tokens: u64::try_from(row.get::<_, i64>(7)?).unwrap_or(0),
                    total_tokens: u64::try_from(row.get::<_, i64>(8)?).unwrap_or(0),
                    cache_creation_input_tokens: u64::try_from(row.get::<_, i64>(9)?).unwrap_or(0),
                    cache_read_input_tokens: u64::try_from(row.get::<_, i64>(10)?).unwrap_or(0),
                })
            }) else {
                return out;
            };
            out.extend(rows.flatten());
            out
        })
    }

    pub fn list_usage_request_day_counts_for_provider(
        &self,
        provider: &str,
    ) -> std::collections::BTreeMap<String, u64> {
        self.with_events_read_conn(|conn| {
            let mut out = std::collections::BTreeMap::new();
            let Ok(mut stmt) = conn.prepare(
                "SELECT day_key, request_count
                 FROM usage_request_day_provider_totals
                 WHERE lower(provider) = lower(?1)
                 ORDER BY day_key ASC",
            ) else {
                return out;
            };
            let Ok(rows) = stmt.query_map(params![provider], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    u64::try_from(row.get::<_, i64>(1)?).unwrap_or(0),
                ))
            }) else {
                return out;
            };
            for (day_key, request_count) in rows.flatten() {
                out.insert(day_key, request_count);
            }
            out
        })
    }

    pub fn list_usage_request_day_rollups_for_provider(
        &self,
        provider: &str,
        since_unix_ms: u64,
    ) -> Vec<(String, String, u64, u64, u64)> {
        let Ok(since_i64) = i64::try_from(since_unix_ms) else {
            return Vec::new();
        };
        self.with_events_read_conn(|conn| {
            let mut out = Vec::new();
            let Ok(mut stmt) = conn.prepare(
                "SELECT
                   strftime('%Y-%m-%d', unix_ms / 1000, 'unixepoch', 'localtime') AS day_key,
                   COALESCE(NULLIF(trim(api_key_ref), ''), '-') AS api_key_ref,
                   COUNT(*) AS request_count,
                   SUM(total_tokens) AS total_tokens,
                   MAX(unix_ms) AS updated_at_unix_ms
                 FROM usage_requests
                 WHERE lower(provider) = lower(?1)
                   AND unix_ms >= ?2
                 GROUP BY day_key, api_key_ref
                 ORDER BY day_key ASC, api_key_ref ASC",
            ) else {
                return out;
            };
            let Ok(rows) = stmt.query_map(params![provider, since_i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    u64::try_from(row.get::<_, i64>(2)?).unwrap_or(0),
                    u64::try_from(row.get::<_, i64>(3)?).unwrap_or(0),
                    u64::try_from(row.get::<_, i64>(4)?).unwrap_or(0),
                ))
            }) else {
                return out;
            };
            for row in rows.flatten() {
                out.push(row);
            }
            out
        })
    }

    pub fn list_spend_history_provider_names(&self) -> Vec<String> {
        let mut ordered = Vec::new();
        let mut seen = std::collections::BTreeSet::new();

        for res in self.db.scan_prefix(b"usage_day:") {
            let Ok((key, _value)) = res else {
                continue;
            };
            let Ok(key_text) = std::str::from_utf8(key.as_ref()) else {
                continue;
            };
            let mut parts = key_text.splitn(3, ':');
            let (_prefix, Some(provider), Some(_rest)) = (parts.next(), parts.next(), parts.next())
            else {
                continue;
            };
            if seen.insert(provider.to_string()) {
                ordered.push(provider.to_string());
            }
        }

        self.with_events_read_conn(|conn| {
            let queries = [
                "SELECT DISTINCT provider FROM usage_requests ORDER BY provider ASC",
                "SELECT DISTINCT provider FROM spend_days ORDER BY provider ASC",
                "SELECT DISTINCT provider FROM spend_manual_days ORDER BY provider ASC",
                "SELECT DISTINCT provider FROM spend_days_remote ORDER BY provider ASC",
                "SELECT DISTINCT provider FROM spend_manual_days_remote ORDER BY provider ASC",
                "SELECT DISTINCT provider FROM provider_pricing_configs_remote ORDER BY provider ASC",
            ];
            for query in queries {
                let Ok(mut stmt) = conn.prepare(query) else {
                    continue;
                };
                let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) else {
                    continue;
                };
                for provider in rows.flatten() {
                    if seen.insert(provider.clone()) {
                        ordered.push(provider);
                    }
                }
            }
        });

        ordered
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

    pub fn remove_spend_state(&self, provider: &str) {
        let key = format!("spend_state:{provider}");
        let _ = self.db.remove(key.as_bytes());
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
        None
    }

    pub fn list_local_spend_days(&self, provider: &str) -> Vec<Value> {
        self.with_events_read_conn(|conn| {
            list_json_rows_from_conn(
                conn,
                "SELECT row_json
                 FROM spend_days
                 WHERE provider = ?1
                 ORDER BY day_started_at_unix_ms ASC",
                provider,
            )
        })
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
    }

    pub fn remove_spend_day(&self, provider: &str, day_started_at_unix_ms: u64) {
        let Ok(day_started_at_i64) = i64::try_from(day_started_at_unix_ms) else {
            return;
        };
        let conn = self.events_db.lock();
        let _ = conn.execute(
            "DELETE FROM spend_days WHERE provider = ?1 AND day_started_at_unix_ms = ?2",
            params![provider, day_started_at_i64],
        );
    }

    pub fn put_remote_spend_day(
        &self,
        provider: &str,
        source_node_id: &str,
        source_node_name: &str,
        day_started_at_unix_ms: u64,
        day: &Value,
    ) {
        let Ok(day_started_at_i64) = i64::try_from(day_started_at_unix_ms) else {
            return;
        };
        let mut row = day.clone();
        merge_json_source_fields(&mut row, source_node_id, source_node_name);
        let conn = self.events_db.lock();
        let _ = conn.execute(
            "INSERT INTO spend_days_remote(
                provider, source_node_id, source_node_name, day_started_at_unix_ms, row_json
             ) VALUES(?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(provider, source_node_id, day_started_at_unix_ms) DO UPDATE SET
                source_node_name = excluded.source_node_name,
                row_json = excluded.row_json",
            params![
                provider,
                source_node_id,
                source_node_name,
                day_started_at_i64,
                serde_json::to_string(&row).unwrap_or_else(|_| "{}".to_string())
            ],
        );
    }

    pub fn remove_remote_spend_day(
        &self,
        provider: &str,
        source_node_id: &str,
        day_started_at_unix_ms: u64,
    ) {
        let Ok(day_started_at_i64) = i64::try_from(day_started_at_unix_ms) else {
            return;
        };
        let conn = self.events_db.lock();
        let _ = conn.execute(
            "DELETE FROM spend_days_remote
             WHERE provider = ?1 AND source_node_id = ?2 AND day_started_at_unix_ms = ?3",
            params![provider, source_node_id, day_started_at_i64],
        );
    }

    pub fn list_remote_spend_days(&self, provider: &str) -> Vec<Value> {
        self.with_events_read_conn(|conn| {
            let mut parsed = Vec::new();
            if let Ok(mut stmt) = conn.prepare(
                "SELECT source_node_id, source_node_name, row_json
                 FROM spend_days_remote
                 WHERE provider = ?1
                 ORDER BY day_started_at_unix_ms ASC, source_node_id ASC",
            ) {
                if let Ok(rows) = stmt.query_map([provider], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                }) {
                    for (source_node_id, source_node_name, row_json) in rows.flatten() {
                        if let Ok(mut value) = serde_json::from_str::<Value>(&row_json) {
                            merge_json_source_fields(
                                &mut value,
                                &source_node_id,
                                &source_node_name,
                            );
                            parsed.push(value);
                        }
                    }
                }
            }
            parsed
        })
    }

    pub fn list_spend_days(&self, provider: &str) -> Vec<Value> {
        self.with_events_read_conn(|conn| {
            let mut parsed = list_json_rows_from_conn(
                conn,
                "SELECT row_json
                 FROM spend_days
                 WHERE provider = ?1
                 ORDER BY day_started_at_unix_ms ASC",
                provider,
            );
            if let Ok(mut stmt) = conn.prepare(
                "SELECT source_node_id, source_node_name, row_json
                 FROM spend_days_remote
                 WHERE provider = ?1
                 ORDER BY day_started_at_unix_ms ASC, source_node_id ASC",
            ) {
                if let Ok(rows) = stmt.query_map([provider], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                }) {
                    for (source_node_id, source_node_name, row_json) in rows.flatten() {
                        if let Ok(mut value) = serde_json::from_str::<Value>(&row_json) {
                            merge_json_source_fields(
                                &mut value,
                                &source_node_id,
                                &source_node_name,
                            );
                            parsed.push(value);
                        }
                    }
                }
            }
            parsed
        })
    }

    pub fn put_shared_tracked_spend_day(
        &self,
        provider: &str,
        shared_provider_id: &str,
        day_key: &str,
        row: &Value,
        updated_at_unix_ms: u64,
    ) {
        let conn = self.events_db.lock();
        let _ = conn.execute(
            "INSERT INTO tracked_spend_days_shared(
                provider, shared_provider_id, day_key, row_json, updated_at_unix_ms
             ) VALUES(?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(shared_provider_id, day_key) DO UPDATE SET
                provider = excluded.provider,
                row_json = excluded.row_json,
                updated_at_unix_ms = excluded.updated_at_unix_ms",
            params![
                provider,
                shared_provider_id,
                day_key,
                serde_json::to_string(row).unwrap_or_else(|_| "{}".to_string()),
                i64::try_from(updated_at_unix_ms).unwrap_or(i64::MAX),
            ],
        );
    }

    pub fn remove_shared_tracked_spend_day(&self, shared_provider_id: &str, day_key: &str) {
        let conn = self.events_db.lock();
        let _ = conn.execute(
            "DELETE FROM tracked_spend_days_shared
             WHERE shared_provider_id = ?1 AND day_key = ?2",
            params![shared_provider_id, day_key],
        );
    }

    pub fn clear_shared_tracked_spend_days(&self) {
        let conn = self.events_db.lock();
        let _ = conn.execute("DELETE FROM tracked_spend_days_shared", []);
    }

    pub fn put_shared_tracked_spend_day_source(
        &self,
        source: &super::SharedTrackedSpendDaySourceRow,
    ) {
        let conn = self.events_db.lock();
        let _ = conn.execute(
            "INSERT INTO tracked_spend_days_shared_sources(
                provider, shared_provider_id, day_key, source_node_id, source_node_name, row_json, updated_at_unix_ms
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(shared_provider_id, day_key, source_node_id) DO UPDATE SET
                provider = excluded.provider,
                source_node_name = excluded.source_node_name,
                row_json = excluded.row_json,
                updated_at_unix_ms = excluded.updated_at_unix_ms",
            params![
                source.provider,
                source.shared_provider_id,
                source.day_key,
                source.source_node_id,
                source.source_node_name,
                serde_json::to_string(&source.row).unwrap_or_else(|_| "{}".to_string()),
                i64::try_from(source.updated_at_unix_ms).unwrap_or(i64::MAX),
            ],
        );
    }

    pub fn remove_shared_tracked_spend_day_source(
        &self,
        shared_provider_id: &str,
        day_key: &str,
        source_node_id: &str,
    ) {
        let conn = self.events_db.lock();
        let _ = conn.execute(
            "DELETE FROM tracked_spend_days_shared_sources
             WHERE shared_provider_id = ?1 AND day_key = ?2 AND source_node_id = ?3",
            params![shared_provider_id, day_key, source_node_id],
        );
    }

    pub fn remove_shared_tracked_spend_day_sources(&self, shared_provider_id: &str, day_key: &str) {
        let conn = self.events_db.lock();
        let _ = conn.execute(
            "DELETE FROM tracked_spend_days_shared_sources
             WHERE shared_provider_id = ?1 AND day_key = ?2",
            params![shared_provider_id, day_key],
        );
    }

    pub fn clear_shared_tracked_spend_day_sources(&self) {
        let conn = self.events_db.lock();
        let _ = conn.execute("DELETE FROM tracked_spend_days_shared_sources", []);
    }

    pub fn list_shared_tracked_spend_day_sources(
        &self,
        shared_provider_id: &str,
        day_key: &str,
    ) -> Vec<(String, String, u64, Value)> {
        self.with_events_read_conn(|conn| {
            let mut out = Vec::new();
            let Ok(mut stmt) = conn.prepare(
                "SELECT source_node_id, source_node_name, updated_at_unix_ms, row_json
                 FROM tracked_spend_days_shared_sources
                 WHERE shared_provider_id = ?1 AND day_key = ?2
                 ORDER BY source_node_id ASC",
            ) else {
                return out;
            };
            let Ok(rows) = stmt.query_map(params![shared_provider_id, day_key], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    u64::try_from(row.get::<_, i64>(2)?).unwrap_or(0),
                    row.get::<_, String>(3)?,
                ))
            }) else {
                return out;
            };
            for (source_node_id, source_node_name, updated_at_unix_ms, row_json) in rows.flatten() {
                let Ok(value) = serde_json::from_str::<Value>(&row_json) else {
                    continue;
                };
                out.push((source_node_id, source_node_name, updated_at_unix_ms, value));
            }
            out
        })
    }

    pub fn list_shared_tracked_spend_days(&self, provider: &str) -> Vec<Value> {
        self.with_events_read_conn(|conn| {
            list_json_rows_from_conn(
                conn,
                "SELECT row_json
                 FROM tracked_spend_days_shared
                 WHERE provider = ?1
                 ORDER BY day_key ASC",
                provider,
            )
        })
    }

    pub fn list_tracked_spend_history_projection_events(&self) -> Vec<super::LanEditSyncEvent> {
        self.with_events_read_conn(|conn| {
            let Ok(mut stmt) = conn.prepare(
                "SELECT
                    event_id,
                    node_id,
                    node_name,
                    created_at_unix_ms,
                    lamport_ts,
                    entity_type,
                    entity_id,
                    op,
                    payload_json
                 FROM lan_edit_events
                 WHERE entity_type IN ('tracked_spend_day', 'tracked_spend_day_history_delete')
                 ORDER BY lamport_ts ASC, event_id ASC",
            ) else {
                return Vec::new();
            };
            let Ok(rows) = stmt.query_map([], parse_lan_edit_event_row) else {
                return Vec::new();
            };
            rows.flatten().collect()
        })
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
    }

    pub fn put_remote_spend_manual_day(
        &self,
        provider: &str,
        source_node_id: &str,
        source_node_name: &str,
        day_key: &str,
        day: &Value,
    ) {
        let mut row = day.clone();
        merge_json_source_fields(&mut row, source_node_id, source_node_name);
        let conn = self.events_db.lock();
        let _ = conn.execute(
            "INSERT INTO spend_manual_days_remote(
                provider, source_node_id, source_node_name, day_key, row_json
             ) VALUES(?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(provider, source_node_id, day_key) DO UPDATE SET
                source_node_name = excluded.source_node_name,
                row_json = excluded.row_json",
            params![
                provider,
                source_node_id,
                source_node_name,
                day_key,
                serde_json::to_string(&row).unwrap_or_else(|_| "{}".to_string())
            ],
        );
    }

    pub fn remove_spend_manual_day(&self, provider: &str, day_key: &str) {
        let conn = self.events_db.lock();
        let _ = conn.execute(
            "DELETE FROM spend_manual_days WHERE provider = ?1 AND day_key = ?2",
            params![provider, day_key],
        );
    }

    pub fn remove_remote_spend_manual_day(
        &self,
        provider: &str,
        source_node_id: &str,
        day_key: &str,
    ) {
        let conn = self.events_db.lock();
        let _ = conn.execute(
            "DELETE FROM spend_manual_days_remote
             WHERE provider = ?1 AND source_node_id = ?2 AND day_key = ?3",
            params![provider, source_node_id, day_key],
        );
    }

    pub fn list_local_spend_manual_days(&self, provider: &str) -> Vec<Value> {
        self.with_events_read_conn(|conn| {
            list_json_rows_from_conn(
                conn,
                "SELECT row_json
                 FROM spend_manual_days
                 WHERE provider = ?1
                 ORDER BY day_key ASC",
                provider,
            )
        })
    }

    pub fn list_spend_manual_days(&self, provider: &str) -> Vec<Value> {
        self.with_events_read_conn(|conn| {
            let mut parsed = list_json_rows_from_conn(
                conn,
                "SELECT row_json
                 FROM spend_manual_days
                 WHERE provider = ?1
                 ORDER BY day_key ASC",
                provider,
            );
            if let Ok(mut stmt) = conn.prepare(
                "SELECT source_node_id, source_node_name, row_json
                 FROM spend_manual_days_remote
                 WHERE provider = ?1
                 ORDER BY day_key ASC, source_node_id ASC",
            ) {
                if let Ok(rows) = stmt.query_map([provider], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                }) {
                    for (source_node_id, source_node_name, row_json) in rows.flatten() {
                        if let Ok(mut value) = serde_json::from_str::<Value>(&row_json) {
                            merge_json_source_fields(
                                &mut value,
                                &source_node_id,
                                &source_node_name,
                            );
                            parsed.push(value);
                        }
                    }
                }
            }
            parsed
        })
    }

    pub fn list_provider_pricing_configs(
        &self,
    ) -> std::collections::BTreeMap<String, crate::orchestrator::secrets::ProviderPricingConfig>
    {
        self.with_events_read_conn(|conn| {
            let mut out = std::collections::BTreeMap::new();
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
            let Ok(mut remote_stmt) = conn.prepare(
                "SELECT provider, pricing_json, updated_at_unix_ms
                 FROM provider_pricing_configs_remote
                 ORDER BY provider ASC, updated_at_unix_ms DESC, source_node_id ASC",
            ) else {
                return out;
            };
            let Ok(remote_rows) = remote_stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    u64::try_from(row.get::<_, i64>(2)?).unwrap_or(0),
                ))
            }) else {
                return out;
            };
            for (provider, pricing_json, _updated_at_unix_ms) in remote_rows.flatten() {
                if out.contains_key(&provider) {
                    continue;
                }
                if let Ok(pricing) = serde_json::from_str::<
                    crate::orchestrator::secrets::ProviderPricingConfig,
                >(&pricing_json)
                {
                    out.insert(provider, pricing);
                }
            }
            out
        })
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
        let _ = tx.execute("DELETE FROM provider_pricing_configs", []);
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

    pub fn put_remote_provider_pricing_config(
        &self,
        provider: &str,
        source_node_id: &str,
        source_node_name: &str,
        pricing: Option<&crate::orchestrator::secrets::ProviderPricingConfig>,
    ) {
        let conn = self.events_db.lock();
        let tx = match conn.unchecked_transaction() {
            Ok(tx) => tx,
            Err(_) => return,
        };
        if let Some(config) = pricing {
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
            let Ok(updated_at_i64) = i64::try_from(updated_at_unix_ms) else {
                let _ = tx.rollback();
                return;
            };
            let Ok(pricing_json) = serde_json::to_string(config) else {
                let _ = tx.rollback();
                return;
            };
            let _ = tx.execute(
                "INSERT INTO provider_pricing_configs_remote(
                    provider, source_node_id, source_node_name, pricing_json, updated_at_unix_ms
                 ) VALUES(?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(provider, source_node_id) DO UPDATE SET
                    source_node_name = excluded.source_node_name,
                    pricing_json = excluded.pricing_json,
                    updated_at_unix_ms = excluded.updated_at_unix_ms",
                params![
                    provider,
                    source_node_id,
                    source_node_name,
                    pricing_json,
                    updated_at_i64
                ],
            );
        } else {
            let _ = tx.execute(
                "DELETE FROM provider_pricing_configs_remote
                 WHERE provider = ?1 AND source_node_id = ?2",
                params![provider, source_node_id],
            );
        }
        let _ = tx.commit();
    }

    pub fn migrate_legacy_remote_usage_sources_if_needed(
        &self,
        local_node_id: &str,
    ) -> anyhow::Result<(usize, usize)> {
        const LEGACY_REMOTE_SOURCES_MIGRATION_KEY: &str = "legacy_remote_usage_sources_migrated_v1";
        if self
            .get_event_meta(LEGACY_REMOTE_SOURCES_MIGRATION_KEY)?
            .as_deref()
            == Some("1")
        {
            return Ok((0, 0));
        }

        let normalized_local_node_id = local_node_id.trim();
        if normalized_local_node_id.is_empty() {
            return Ok((0, 0));
        }

        let conn = self.events_db.lock();
        let tx = conn.unchecked_transaction()?;
        let mut migrated_spend_days = 0_usize;
        let mut migrated_manual_days = 0_usize;

        {
            let mut stmt = tx.prepare(
                "SELECT provider, day_started_at_unix_ms, row_json
                 FROM spend_days
                 ORDER BY provider ASC, day_started_at_unix_ms ASC",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            let spend_rows: Vec<_> = rows.flatten().collect();
            drop(stmt);
            for (provider, day_started_at_i64, row_json) in spend_rows {
                let Ok(mut row) = serde_json::from_str::<Value>(&row_json) else {
                    continue;
                };
                let source_node_id = row
                    .get("applied_from_node_id")
                    .and_then(Value::as_str)
                    .or_else(|| row.get("producer_node_id").and_then(Value::as_str))
                    .map(str::trim)
                    .filter(|value| !value.is_empty() && *value != normalized_local_node_id)
                    .map(ToString::to_string);
                let Some(source_node_id) = source_node_id else {
                    continue;
                };
                let source_node_name = row
                    .get("applied_from_node_name")
                    .and_then(Value::as_str)
                    .or_else(|| row.get("producer_node_name").and_then(Value::as_str))
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(source_node_id.as_str())
                    .to_string();
                merge_json_source_fields(&mut row, &source_node_id, &source_node_name);
                tx.execute(
                    "INSERT INTO spend_days_remote(
                        provider, source_node_id, source_node_name, day_started_at_unix_ms, row_json
                     ) VALUES(?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(provider, source_node_id, day_started_at_unix_ms) DO UPDATE SET
                        source_node_name = excluded.source_node_name,
                        row_json = excluded.row_json",
                    params![
                        provider,
                        source_node_id,
                        source_node_name,
                        day_started_at_i64,
                        serde_json::to_string(&row).unwrap_or_else(|_| "{}".to_string()),
                    ],
                )?;
                tx.execute(
                    "DELETE FROM spend_days
                     WHERE provider = ?1 AND day_started_at_unix_ms = ?2",
                    params![provider, day_started_at_i64],
                )?;
                migrated_spend_days = migrated_spend_days.saturating_add(1);
            }
        }

        {
            let mut stmt = tx.prepare(
                "SELECT provider, day_key, row_json
                 FROM spend_manual_days
                 ORDER BY provider ASC, day_key ASC",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            let manual_rows: Vec<_> = rows.flatten().collect();
            drop(stmt);
            for (provider, day_key, row_json) in manual_rows {
                let Ok(mut row) = serde_json::from_str::<Value>(&row_json) else {
                    continue;
                };
                let source_node_id = row
                    .get("applied_from_node_id")
                    .and_then(Value::as_str)
                    .or_else(|| row.get("producer_node_id").and_then(Value::as_str))
                    .map(str::trim)
                    .filter(|value| !value.is_empty() && *value != normalized_local_node_id)
                    .map(ToString::to_string);
                let Some(source_node_id) = source_node_id else {
                    continue;
                };
                let source_node_name = row
                    .get("applied_from_node_name")
                    .and_then(Value::as_str)
                    .or_else(|| row.get("producer_node_name").and_then(Value::as_str))
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(source_node_id.as_str())
                    .to_string();
                merge_json_source_fields(&mut row, &source_node_id, &source_node_name);
                tx.execute(
                    "INSERT INTO spend_manual_days_remote(
                        provider, source_node_id, source_node_name, day_key, row_json
                     ) VALUES(?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(provider, source_node_id, day_key) DO UPDATE SET
                        source_node_name = excluded.source_node_name,
                        row_json = excluded.row_json",
                    params![
                        provider,
                        source_node_id,
                        source_node_name,
                        day_key,
                        serde_json::to_string(&row).unwrap_or_else(|_| "{}".to_string()),
                    ],
                )?;
                tx.execute(
                    "DELETE FROM spend_manual_days
                     WHERE provider = ?1 AND day_key = ?2",
                    params![provider, day_key],
                )?;
                migrated_manual_days = migrated_manual_days.saturating_add(1);
            }
        }

        tx.execute(
            "INSERT INTO event_meta(key, value) VALUES(?1, '1')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [LEGACY_REMOTE_SOURCES_MIGRATION_KEY],
        )?;
        tx.commit()?;
        Ok((migrated_spend_days, migrated_manual_days))
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
        let mut migrated_sled_keys = Vec::new();
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
            migrated_sled_keys.push(key.to_vec());
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
            migrated_sled_keys.push(key.to_vec());
        }
        tx.commit()?;
        drop(conn);
        for key in migrated_sled_keys {
            self.db.remove(key)?;
        }
        self.db.flush()?;
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
        let transport = match context.transport.trim().to_ascii_lowercase().as_str() {
            "ws" => "ws",
            "sse" => "sse",
            _ => "http",
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
                    id, unix_ms, ingested_at_unix_ms, provider, api_key_ref, model, origin, transport, session_id, node_id, node_name,
                    input_tokens, output_tokens, total_tokens,
                    cache_creation_input_tokens, cache_read_input_tokens
                 ) VALUES(?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                params![
                    id,
                    ts_i64,
                    provider,
                    context.api_key_ref.unwrap_or("-"),
                    model,
                    origin,
                    transport,
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
    fn sync_provider_pricing_configs_prunes_only_local_rows_missing_from_latest_snapshot() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = open_store_dir(tmp.path().join("data")).expect("store");

        let first = std::collections::BTreeMap::from([
            (
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
                    gap_fill_mode: None,
                    gap_fill_amount_usd: None,
                },
            ),
            (
                "stale-provider".to_string(),
                ProviderPricingConfig {
                    mode: "package_total".to_string(),
                    amount_usd: 12.0,
                    periods: vec![ProviderPricingPeriod {
                        id: "period-2".to_string(),
                        mode: "package_total".to_string(),
                        amount_usd: 12.0,
                        api_key_ref: "sk-stale".to_string(),
                        started_at_unix_ms: 1_700_000_000_000,
                        ended_at_unix_ms: None,
                    }],
                    gap_fill_mode: None,
                    gap_fill_amount_usd: None,
                },
            ),
        ]);
        let second = std::collections::BTreeMap::from([(
            "packycode".to_string(),
            first.get("packycode").expect("packycode config").clone(),
        )]);

        store.sync_provider_pricing_configs(&first);
        store.put_remote_provider_pricing_config(
            "remote-provider",
            "node-remote",
            "Remote Node",
            first.get("packycode"),
        );
        store.sync_provider_pricing_configs(&second);

        let loaded = store.list_provider_pricing_configs();
        assert_eq!(loaded.get("packycode"), second.get("packycode"));
        assert!(!loaded.contains_key("stale-provider"));
        assert!(loaded.contains_key("remote-provider"));
    }

    #[test]
    fn list_spend_days_includes_remote_rows_without_overwriting_local_rows() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = open_store_dir(tmp.path().join("data")).expect("store");

        store.put_spend_day(
            "provider_1",
            1_700_000_000_000,
            &serde_json::json!({
                "provider": "provider_1",
                "started_at_unix_ms": 1_700_000_000_000u64,
                "tracked_spend_usd": 3.0,
                "producer_node_id": "node-local",
                "producer_node_name": "Local Node"
            }),
        );
        store.put_remote_spend_day(
            "provider_1",
            "node-remote",
            "Remote Node",
            1_700_000_000_000,
            &serde_json::json!({
                "provider": "provider_1",
                "started_at_unix_ms": 1_700_000_000_000u64,
                "tracked_spend_usd": 7.0
            }),
        );

        let spend_days = store.list_spend_days("provider_1");
        assert_eq!(spend_days.len(), 2);
        assert_eq!(
            spend_days
                .iter()
                .filter_map(|row| row.get("tracked_spend_usd").and_then(Value::as_f64))
                .sum::<f64>(),
            10.0
        );
        assert!(spend_days.iter().any(|row| {
            row.get("producer_node_id").and_then(Value::as_str) == Some("node-local")
        }));
        assert!(spend_days.iter().any(|row| {
            row.get("producer_node_id").and_then(Value::as_str) == Some("node-remote")
        }));
    }

    #[test]
    fn list_spend_manual_days_includes_remote_rows_without_deleting_local_rows() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = open_store_dir(tmp.path().join("data")).expect("store");

        store.put_spend_manual_day(
            "provider_1",
            "2026-04-03",
            &serde_json::json!({
                "provider": "provider_1",
                "day_key": "2026-04-03",
                "manual_total_usd": 2.5
            }),
        );
        store.put_remote_spend_manual_day(
            "provider_1",
            "node-remote",
            "Remote Node",
            "2026-04-03",
            &serde_json::json!({
                "provider": "provider_1",
                "day_key": "2026-04-03",
                "manual_total_usd": 1.5
            }),
        );

        let manual_days = store.list_spend_manual_days("provider_1");
        assert_eq!(manual_days.len(), 2);
        assert_eq!(
            manual_days
                .iter()
                .filter_map(|row| row.get("manual_total_usd").and_then(Value::as_f64))
                .sum::<f64>(),
            4.0
        );
    }

    #[test]
    fn migrate_legacy_remote_usage_sources_moves_remote_rows_out_of_local_tables() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = open_store_dir(tmp.path().join("data")).expect("store");

        store.put_spend_day(
            "provider_1",
            1_700_000_000_000,
            &serde_json::json!({
                "provider": "provider_1",
                "started_at_unix_ms": 1_700_000_000_000u64,
                "tracked_spend_usd": 3.0,
                "producer_node_id": "node-local",
                "producer_node_name": "Local Node",
                "applied_from_node_id": "node-local",
                "applied_from_node_name": "Local Node"
            }),
        );
        store.put_spend_day(
            "provider_1",
            1_700_000_000_001,
            &serde_json::json!({
                "provider": "provider_1",
                "started_at_unix_ms": 1_700_000_000_001u64,
                "tracked_spend_usd": 7.0,
                "producer_node_id": "node-remote",
                "producer_node_name": "Remote Node",
                "applied_from_node_id": "node-remote",
                "applied_from_node_name": "Remote Node"
            }),
        );
        store.put_spend_manual_day(
            "provider_1",
            "2026-04-03",
            &serde_json::json!({
                "provider": "provider_1",
                "day_key": "2026-04-03",
                "manual_total_usd": 2.5,
                "producer_node_id": "node-remote",
                "producer_node_name": "Remote Node",
                "applied_from_node_id": "node-remote",
                "applied_from_node_name": "Remote Node"
            }),
        );

        let (migrated_spend_days, migrated_manual_days) = store
            .migrate_legacy_remote_usage_sources_if_needed("node-local")
            .expect("migrate legacy remote usage");

        assert_eq!(migrated_spend_days, 1);
        assert_eq!(migrated_manual_days, 1);
        let spend_days = store.list_spend_days("provider_1");
        assert_eq!(spend_days.len(), 2);
        assert_eq!(
            spend_days
                .iter()
                .filter_map(|row| row.get("producer_node_id").and_then(Value::as_str))
                .collect::<std::collections::BTreeSet<_>>(),
            std::collections::BTreeSet::from(["node-local", "node-remote"])
        );
        assert_eq!(
            store.list_local_spend_days("provider_1").len(),
            1,
            "remote-attributed spend rows should be removed from the local table"
        );
        assert_eq!(
            store.list_spend_manual_days("provider_1").len(),
            1,
            "remote-attributed manual rows should remain available via the merged reader"
        );
        let second = store
            .migrate_legacy_remote_usage_sources_if_needed("node-local")
            .expect("idempotent migration");
        assert_eq!(second, (0, 0));
    }

    #[test]
    fn migrate_legacy_remote_usage_sources_keeps_multiple_remote_rows_from_same_provider() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = open_store_dir(tmp.path().join("data")).expect("store");

        store.put_spend_day(
            "provider_1",
            1_700_000_000_001,
            &serde_json::json!({
                "provider": "provider_1",
                "started_at_unix_ms": 1_700_000_000_001u64,
                "tracked_spend_usd": 4.0,
                "producer_node_id": "node-remote-a",
                "producer_node_name": "Remote Node A",
                "applied_from_node_id": "node-remote-a",
                "applied_from_node_name": "Remote Node A"
            }),
        );
        store.put_spend_day(
            "provider_1",
            1_700_000_000_002,
            &serde_json::json!({
                "provider": "provider_1",
                "started_at_unix_ms": 1_700_000_000_002u64,
                "tracked_spend_usd": 6.0,
                "producer_node_id": "node-remote-b",
                "producer_node_name": "Remote Node B",
                "applied_from_node_id": "node-remote-b",
                "applied_from_node_name": "Remote Node B"
            }),
        );
        store.put_spend_manual_day(
            "provider_1",
            "2026-04-03",
            &serde_json::json!({
                "provider": "provider_1",
                "day_key": "2026-04-03",
                "manual_total_usd": 2.5,
                "producer_node_id": "node-remote-a",
                "producer_node_name": "Remote Node A",
                "applied_from_node_id": "node-remote-a",
                "applied_from_node_name": "Remote Node A"
            }),
        );
        store.put_spend_manual_day(
            "provider_1",
            "2026-04-04",
            &serde_json::json!({
                "provider": "provider_1",
                "day_key": "2026-04-04",
                "manual_total_usd": 3.5,
                "producer_node_id": "node-remote-b",
                "producer_node_name": "Remote Node B",
                "applied_from_node_id": "node-remote-b",
                "applied_from_node_name": "Remote Node B"
            }),
        );

        let migrated = store
            .migrate_legacy_remote_usage_sources_if_needed("node-local")
            .expect("migrate legacy remote usage");

        assert_eq!(migrated, (2, 2));
        assert!(store.list_local_spend_days("provider_1").is_empty());
        assert!(store.list_local_spend_manual_days("provider_1").is_empty());
        assert_eq!(store.list_remote_spend_days("provider_1").len(), 2);
        assert_eq!(store.list_spend_manual_days("provider_1").len(), 2);
        assert_eq!(
            store
                .list_remote_spend_days("provider_1")
                .iter()
                .filter_map(|row| row.get("producer_node_id").and_then(Value::as_str))
                .collect::<std::collections::BTreeSet<_>>(),
            std::collections::BTreeSet::from(["node-remote-a", "node-remote-b"])
        );
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
        assert!(store
            .db
            .get(b"spend_day:legacy-provider:1700000000000")
            .expect("read migrated legacy spend day")
            .is_none());
        assert!(store
            .db
            .get(b"spend_manual_day:legacy-provider:2026-03-31")
            .expect("read migrated legacy manual day")
            .is_none());
    }

    #[test]
    fn spend_history_runtime_reads_do_not_fallback_to_sled_after_sqlite_migration() {
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
            .set_event_meta(Store::SPEND_HISTORY_SQLITE_MIGRATED_FROM_SLED_KEY, "1")
            .expect("mark migration done");

        {
            let conn = store.events_db.lock();
            conn.execute("DELETE FROM spend_days", [])
                .expect("clear spend_days");
            conn.execute("DELETE FROM spend_manual_days", [])
                .expect("clear spend_manual_days");
        }

        assert!(store.list_spend_days("legacy-provider").is_empty());
        assert!(store.list_spend_manual_days("legacy-provider").is_empty());
        assert!(store
            .get_spend_day("legacy-provider", 1_700_000_000_000u64)
            .is_none());
    }

    #[test]
    fn list_spend_history_provider_names_includes_historical_providers() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = open_store_dir(tmp.path().join("data")).expect("store");

        store.put_spend_day(
            "removed-provider",
            1_700_000_000_000,
            &serde_json::json!({"day":"2026-03-31"}),
        );
        {
            let conn = store.events_db.lock();
            conn.execute(
                "INSERT INTO usage_requests(
                    id, unix_ms, ingested_at_unix_ms, provider, api_key_ref, model, origin, session_id, node_id, node_name,
                    input_tokens, output_tokens, total_tokens, cache_creation_input_tokens, cache_read_input_tokens
                ) VALUES(?1, ?2, ?3, ?4, '-', '', 'windows', '', '', '', 0, 0, 0, 0, 0)",
                params![
                    "req-1",
                    1_700_000_000_000i64,
                    1_700_000_000_000i64,
                    "usage-only-provider",
                ],
            )
            .expect("insert usage request");
        }
        store
            .db
            .insert(
                b"usage_day:legacy-provider:2026-03-30",
                serde_json::to_vec(&serde_json::json!({"req_count":1})).expect("sled json"),
            )
            .expect("insert usage_day");

        let providers = store.list_spend_history_provider_names();
        assert!(providers.contains(&"removed-provider".to_string()));
        assert!(providers.contains(&"usage-only-provider".to_string()));
        assert!(providers.contains(&"legacy-provider".to_string()));
    }
}
