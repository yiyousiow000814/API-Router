use chrono::{Datelike, Local, TimeZone};
use parking_lot::Mutex;
use rusqlite::{params, params_from_iter, OptionalExtension};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;

mod usage_tracking;

#[derive(Clone)]
pub struct Store {
    db: sled::Db,
    events_db: Arc<Mutex<rusqlite::Connection>>,
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

type UsageRequestSqlRow = (
    String,
    i64,
    String,
    String,
    String,
    String,
    String,
    i64,
    i64,
    i64,
    i64,
    i64,
);

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
    const MAX_DB_BYTES: u64 = 64 * 1024 * 1024; // 64 MiB, best-effort cap via compaction
    const EVENTS_SQLITE_SCHEMA_VERSION: &'static str = "1";
    const EVENTS_SQLITE_MIGRATED_FROM_SLED_KEY: &'static str = "migrated_from_sled_v1";
    const EVENTS_SQLITE_MERGED_LEGACY_SQLITE_KEY: &'static str = "merged_legacy_sqlite_v1";
    const USAGE_REQUESTS_SQLITE_MIGRATED_FROM_SLED_KEY: &'static str =
        "usage_requests_migrated_from_sled_v1";

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

    fn allowed_exact_keys() -> [&'static [u8]; 2] {
        [b"codex_account:snapshot", b"official_web:snapshot"]
    }

    pub fn open(path: &std::path::Path) -> Result<Self, sled::Error> {
        let db = sled::open(path)?;
        // Keep the event SQLite file outside the sled directory. Sled maintenance/recovery
        // may swap or recreate the whole sled dir, which would otherwise drop events.sqlite3.
        let is_sled_dir = path.file_name().and_then(|n| n.to_str()) == Some("sled");
        let events_db_path = if is_sled_dir {
            path.parent().unwrap_or(path).join("events.sqlite3")
        } else {
            path.join("events.sqlite3")
        };
        let mut legacy_events_db_path = if is_sled_dir {
            let p = path.join("events.sqlite3");
            if p != events_db_path && p.exists() {
                Some(p)
            } else {
                None
            }
        } else {
            None
        };
        // One-time migration path: older builds stored sqlite under `<data>/sled/events.sqlite3`.
        // If we moved to `<data>/events.sqlite3` and the new file does not exist yet, copy it.
        if is_sled_dir {
            let legacy_path = path.join("events.sqlite3");
            if !events_db_path.exists() && legacy_path.exists() {
                let moved = if std::fs::rename(&legacy_path, &events_db_path).is_ok() {
                    true
                } else {
                    // Best effort: fold WAL pages into the main DB before fallback copy so we
                    // don't silently drop recent legacy events.
                    Self::checkpoint_sqlite_wal(&legacy_path);
                    std::fs::copy(&legacy_path, &events_db_path).is_ok()
                        && Self::copy_file_if_exists(
                            &Self::sqlite_sidecar_path(&legacy_path, "-wal"),
                            &Self::sqlite_sidecar_path(&events_db_path, "-wal"),
                        )
                        && Self::copy_file_if_exists(
                            &Self::sqlite_sidecar_path(&legacy_path, "-shm"),
                            &Self::sqlite_sidecar_path(&events_db_path, "-shm"),
                        )
                };
                if moved {
                    // Data is already in the canonical sqlite path; skip legacy merge.
                    legacy_events_db_path = None;
                }
            }
        }
        let events_db = rusqlite::Connection::open(events_db_path)
            .map_err(|e| sled::Error::Unsupported(format!("open events sqlite failed: {e}")))?;
        let store = Self {
            db,
            events_db: Arc::new(Mutex::new(events_db)),
        };
        store
            .ensure_event_sqlite_schema()
            .map_err(|e| sled::Error::Unsupported(format!("init events sqlite failed: {e}")))?;
        if let Some(legacy_path) = legacy_events_db_path {
            let already_merged = store.legacy_sqlite_merge_done().map_err(|e| {
                sled::Error::Unsupported(format!("check legacy sqlite merge state failed: {e}"))
            })?;
            if !already_merged {
                store
                    .merge_legacy_events_sqlite(&legacy_path)
                    .and_then(|_| store.mark_legacy_sqlite_merge_done())
                    .map_err(|e| {
                        sled::Error::Unsupported(format!("merge legacy events sqlite failed: {e}"))
                    })?;
            }
        }
        Ok(store)
    }

    fn sqlite_sidecar_path(path: &Path, suffix: &str) -> PathBuf {
        let mut out = path.as_os_str().to_os_string();
        out.push(suffix);
        PathBuf::from(out)
    }

    fn checkpoint_sqlite_wal(path: &Path) {
        let Ok(conn) = rusqlite::Connection::open(path) else {
            return;
        };
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }

    fn copy_file_if_exists(src: &Path, dst: &Path) -> bool {
        if !src.exists() {
            return true;
        }
        std::fs::copy(src, dst).is_ok()
    }

    fn ensure_event_sqlite_schema(&self) -> anyhow::Result<()> {
        let conn = self.events_db.lock();
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS event_meta(
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS events(
              id TEXT PRIMARY KEY,
              unix_ms INTEGER NOT NULL,
              provider TEXT NOT NULL,
              level TEXT NOT NULL,
              code TEXT NOT NULL,
              message TEXT NOT NULL,
              fields_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_events_unix_ms ON events(unix_ms DESC);
            CREATE TABLE IF NOT EXISTS event_day_counts(
              day_key TEXT PRIMARY KEY,
              day_start_unix_ms INTEGER NOT NULL,
              total INTEGER NOT NULL,
              infos INTEGER NOT NULL,
              warnings INTEGER NOT NULL,
              errors INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_event_day_start ON event_day_counts(day_start_unix_ms ASC);
            CREATE TABLE IF NOT EXISTS usage_requests(
              id TEXT PRIMARY KEY,
              unix_ms INTEGER NOT NULL,
              provider TEXT NOT NULL,
              api_key_ref TEXT NOT NULL,
              model TEXT NOT NULL,
              origin TEXT NOT NULL,
              session_id TEXT NOT NULL,
              input_tokens INTEGER NOT NULL,
              output_tokens INTEGER NOT NULL,
              total_tokens INTEGER NOT NULL,
              cache_creation_input_tokens INTEGER NOT NULL,
              cache_read_input_tokens INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_usage_requests_unix_ms ON usage_requests(unix_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_requests_provider ON usage_requests(provider);
            CREATE INDEX IF NOT EXISTS idx_usage_requests_model ON usage_requests(model);
            CREATE INDEX IF NOT EXISTS idx_usage_requests_origin ON usage_requests(origin);
            CREATE INDEX IF NOT EXISTS idx_usage_requests_provider_lc ON usage_requests(lower(provider));
            CREATE INDEX IF NOT EXISTS idx_usage_requests_model_lc ON usage_requests(lower(model));
            CREATE INDEX IF NOT EXISTS idx_usage_requests_origin_lc ON usage_requests(lower(origin));
            ",
        )?;
        let current_schema: Option<String> = conn
            .query_row(
                "SELECT value FROM event_meta WHERE key='schema_version'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if current_schema.as_deref() != Some(Self::EVENTS_SQLITE_SCHEMA_VERSION) {
            conn.execute("DELETE FROM events", [])?;
            conn.execute("DELETE FROM event_day_counts", [])?;
            conn.execute(
                "INSERT INTO event_meta(key, value) VALUES('schema_version', ?1)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [Self::EVENTS_SQLITE_SCHEMA_VERSION],
            )?;
            conn.execute(
                "INSERT INTO event_meta(key, value) VALUES(?1, '0')
                 ON CONFLICT(key) DO UPDATE SET value='0'",
                [Self::EVENTS_SQLITE_MIGRATED_FROM_SLED_KEY],
            )?;
            conn.execute(
                "INSERT INTO event_meta(key, value) VALUES(?1, '0')
                 ON CONFLICT(key) DO UPDATE SET value='0'",
                [Self::EVENTS_SQLITE_MERGED_LEGACY_SQLITE_KEY],
            )?;
            conn.execute(
                "INSERT INTO event_meta(key, value) VALUES(?1, '0')
                 ON CONFLICT(key) DO UPDATE SET value='0'",
                [Self::USAGE_REQUESTS_SQLITE_MIGRATED_FROM_SLED_KEY],
            )?;
        }
        conn.execute(
            "INSERT INTO event_meta(key, value) VALUES(?1, '0')
             ON CONFLICT(key) DO NOTHING",
            [Self::EVENTS_SQLITE_MERGED_LEGACY_SQLITE_KEY],
        )?;
        conn.execute(
            "INSERT INTO event_meta(key, value) VALUES(?1, '0')
             ON CONFLICT(key) DO NOTHING",
            [Self::USAGE_REQUESTS_SQLITE_MIGRATED_FROM_SLED_KEY],
        )?;
        drop(conn);
        self.migrate_legacy_events_from_sled_if_needed()?;
        self.migrate_usage_requests_from_sled_if_needed()?;
        Ok(())
    }

    fn legacy_sqlite_merge_done(&self) -> anyhow::Result<bool> {
        let conn = self.events_db.lock();
        let value: Option<String> = conn
            .query_row(
                "SELECT value FROM event_meta WHERE key=?1",
                [Self::EVENTS_SQLITE_MERGED_LEGACY_SQLITE_KEY],
                |row| row.get(0),
            )
            .optional()?;
        Ok(value.as_deref() == Some("1"))
    }

    fn mark_legacy_sqlite_merge_done(&self) -> anyhow::Result<()> {
        let conn = self.events_db.lock();
        conn.execute(
            "INSERT INTO event_meta(key, value) VALUES(?1, '1')
             ON CONFLICT(key) DO UPDATE SET value='1'",
            [Self::EVENTS_SQLITE_MERGED_LEGACY_SQLITE_KEY],
        )?;
        Ok(())
    }

    fn merge_legacy_events_sqlite(&self, legacy_path: &Path) -> anyhow::Result<()> {
        let legacy_conn = rusqlite::Connection::open(legacy_path)?;
        let mut stmt = legacy_conn.prepare(
            "SELECT id, unix_ms, provider, level, code, message, fields_json FROM events",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?;

        let mut conn = self.events_db.lock();
        let tx = conn.transaction()?;
        for (id, unix_ms, provider, level, code, message, fields_json) in rows.flatten() {
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO events(id, unix_ms, provider, level, code, message, fields_json)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, unix_ms, provider, level, code, message, fields_json],
            )?;
            if inserted == 0 {
                continue;
            }
            let Ok(unix_ms_u64) = u64::try_from(unix_ms) else {
                continue;
            };
            let Some(day_key) = Self::local_day_key_from_unix_ms(unix_ms_u64) else {
                continue;
            };
            let Some(day_start_unix_ms) =
                Self::day_start_unix_ms_from_day_key(&day_key).and_then(|x| i64::try_from(x).ok())
            else {
                continue;
            };
            Self::upsert_event_day_counts(&tx, &day_key, day_start_unix_ms, &level)?;
        }
        tx.commit()?;
        Ok(())
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

    fn day_start_unix_ms_from_day_key(day_key: &str) -> Option<u64> {
        let date = chrono::NaiveDate::parse_from_str(day_key, "%Y-%m-%d").ok()?;
        let dt = Local
            .with_ymd_and_hms(date.year(), date.month(), date.day(), 0, 0, 0)
            .single()?;
        u64::try_from(dt.timestamp_millis()).ok()
    }

    fn parse_event_key_id(key: &[u8]) -> Option<String> {
        let body = key.strip_prefix(b"event:")?;
        let split_at = body.iter().position(|b| *b == b':')?;
        let id_bytes = body.get(split_at + 1..)?;
        std::str::from_utf8(id_bytes).ok().map(str::to_string)
    }

    fn upsert_event_day_counts(
        tx: &rusqlite::Transaction<'_>,
        day_key: &str,
        day_start_unix_ms: i64,
        level: &str,
    ) -> rusqlite::Result<()> {
        tx.execute(
            "INSERT INTO event_day_counts(day_key, day_start_unix_ms, total, infos, warnings, errors)
             VALUES (?1, ?2, 1,
               CASE WHEN ?3='error' OR ?3='warning' THEN 0 ELSE 1 END,
               CASE WHEN ?3='warning' THEN 1 ELSE 0 END,
               CASE WHEN ?3='error' THEN 1 ELSE 0 END
             )
             ON CONFLICT(day_key) DO UPDATE SET
               total=total+1,
               infos=infos + CASE WHEN excluded.errors=0 AND excluded.warnings=0 THEN 1 ELSE 0 END,
               warnings=warnings + excluded.warnings,
               errors=errors + excluded.errors",
            params![day_key, day_start_unix_ms, level],
        )?;
        Ok(())
    }

    fn event_from_sql_row(
        unix_ms: i64,
        provider: String,
        level: String,
        code: String,
        message: String,
        fields_json: String,
    ) -> Option<Value> {
        let unix_ms = u64::try_from(unix_ms).ok()?;
        let fields = match serde_json::from_str::<Value>(&fields_json).ok() {
            Some(Value::Object(obj)) => Value::Object(obj),
            Some(Value::Null) => Value::Null,
            Some(other) => serde_json::json!({ "value": other }),
            None => Value::Null,
        };
        Some(serde_json::json!({
            "provider": provider,
            "level": level,
            "unix_ms": unix_ms,
            "code": code,
            "message": message,
            "fields": fields,
        }))
    }

    fn migrate_legacy_events_from_sled_if_needed(&self) -> anyhow::Result<()> {
        let already_migrated = {
            let conn = self.events_db.lock();
            conn.query_row(
                "SELECT value FROM event_meta WHERE key=?1",
                [Self::EVENTS_SQLITE_MIGRATED_FROM_SLED_KEY],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .as_deref()
                == Some("1")
        };
        if already_migrated {
            return Ok(());
        }

        let mut staged: Vec<(String, i64, String, String, String, String, String)> = Vec::new();
        for res in self.db.scan_prefix(b"event:") {
            let Ok((k, v)) = res else {
                continue;
            };
            let Some(id) = Self::parse_event_key_id(k.as_ref()) else {
                continue;
            };
            let Ok(j) = serde_json::from_slice::<Value>(&v) else {
                continue;
            };
            if !Self::is_valid_event(&j) {
                continue;
            }
            let Some(unix_ms_u64) = j.get("unix_ms").and_then(|x| x.as_u64()) else {
                continue;
            };
            let Ok(unix_ms) = i64::try_from(unix_ms_u64) else {
                continue;
            };
            let provider = j
                .get("provider")
                .and_then(|x| x.as_str())
                .unwrap_or("gateway")
                .to_string();
            let level = j
                .get("level")
                .and_then(|x| x.as_str())
                .unwrap_or("info")
                .to_string();
            let code = j
                .get("code")
                .and_then(|x| x.as_str())
                .unwrap_or("unknown")
                .to_string();
            let message = j
                .get("message")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let fields = j.get("fields").cloned().unwrap_or(Value::Null);
            let fields_json = serde_json::to_string(&fields).unwrap_or_else(|_| "null".to_string());
            staged.push((id, unix_ms, provider, level, code, message, fields_json));
            if staged.len() >= 2048 {
                self.flush_staged_legacy_events(&staged)?;
                staged.clear();
            }
        }
        if !staged.is_empty() {
            self.flush_staged_legacy_events(&staged)?;
        }
        {
            let conn = self.events_db.lock();
            conn.execute(
                "INSERT INTO event_meta(key, value) VALUES(?1, '1')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [Self::EVENTS_SQLITE_MIGRATED_FROM_SLED_KEY],
            )?;
        }
        // Drop legacy sled event keys after migration to keep hot store compact.
        self.clear_prefix(b"event:");
        self.clear_prefix(b"event_day:");
        let _ = self.db.flush();
        Ok(())
    }

    fn flush_staged_legacy_events(
        &self,
        staged: &[(String, i64, String, String, String, String, String)],
    ) -> anyhow::Result<()> {
        let mut conn = self.events_db.lock();
        let tx = conn.transaction()?;
        for (id, unix_ms, provider, level, code, message, fields_json) in staged {
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO events(id, unix_ms, provider, level, code, message, fields_json)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, unix_ms, provider, level, code, message, fields_json],
            )?;
            if inserted == 0 {
                continue;
            }
            let Ok(unix_ms_u64) = u64::try_from(*unix_ms) else {
                continue;
            };
            let Some(day_key) = Self::local_day_key_from_unix_ms(unix_ms_u64) else {
                continue;
            };
            let Some(day_start_unix_ms) =
                Self::day_start_unix_ms_from_day_key(&day_key).and_then(|x| i64::try_from(x).ok())
            else {
                continue;
            };
            Self::upsert_event_day_counts(&tx, &day_key, day_start_unix_ms, level)?;
        }
        tx.commit()?;
        Ok(())
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

    fn parse_usage_request_key_id(key: &[u8]) -> Option<String> {
        let body = key.strip_prefix(b"usage_req:")?;
        let split_at = body.iter().position(|b| *b == b':')?;
        let id_bytes = body.get(split_at + 1..)?;
        std::str::from_utf8(id_bytes).ok().map(str::to_string)
    }

    fn migrate_usage_requests_from_sled_if_needed(&self) -> anyhow::Result<()> {
        let already_migrated = {
            let conn = self.events_db.lock();
            conn.query_row(
                "SELECT value FROM event_meta WHERE key=?1",
                [Self::USAGE_REQUESTS_SQLITE_MIGRATED_FROM_SLED_KEY],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .as_deref()
                == Some("1")
        };
        if already_migrated {
            return Ok(());
        }

        let mut staged: Vec<UsageRequestSqlRow> = Vec::new();
        for res in self.db.scan_prefix(b"usage_req:") {
            let Ok((k, v)) = res else {
                continue;
            };
            let Some(id) = Self::parse_usage_request_key_id(k.as_ref()) else {
                continue;
            };
            let Ok(j) = serde_json::from_slice::<Value>(&v) else {
                continue;
            };
            if !Self::is_valid_usage_request(&j) {
                continue;
            }
            let Some(unix_ms_u64) = j.get("unix_ms").and_then(|x| x.as_u64()) else {
                continue;
            };
            let Ok(unix_ms) = i64::try_from(unix_ms_u64) else {
                continue;
            };
            let provider = j
                .get("provider")
                .and_then(|x| x.as_str())
                .unwrap_or("unknown")
                .to_string();
            let api_key_ref = j
                .get("api_key_ref")
                .and_then(|x| x.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("-")
                .to_string();
            let model = j
                .get("model")
                .and_then(|x| x.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("unknown")
                .to_string();
            let origin = j
                .get("origin")
                .and_then(|x| x.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(crate::constants::USAGE_ORIGIN_UNKNOWN)
                .to_ascii_lowercase();
            let session_id = j
                .get("session_id")
                .and_then(|x| x.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("-")
                .to_string();
            let Ok(input_tokens) =
                i64::try_from(j.get("input_tokens").and_then(|x| x.as_u64()).unwrap_or(0))
            else {
                continue;
            };
            let Ok(output_tokens) =
                i64::try_from(j.get("output_tokens").and_then(|x| x.as_u64()).unwrap_or(0))
            else {
                continue;
            };
            let Ok(total_tokens) =
                i64::try_from(j.get("total_tokens").and_then(|x| x.as_u64()).unwrap_or(0))
            else {
                continue;
            };
            let Ok(cache_creation_input_tokens) = i64::try_from(
                j.get("cache_creation_input_tokens")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0),
            ) else {
                continue;
            };
            let Ok(cache_read_input_tokens) = i64::try_from(
                j.get("cache_read_input_tokens")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0),
            ) else {
                continue;
            };
            staged.push((
                id,
                unix_ms,
                provider,
                api_key_ref,
                model,
                origin,
                session_id,
                input_tokens,
                output_tokens,
                total_tokens,
                cache_creation_input_tokens,
                cache_read_input_tokens,
            ));
            if staged.len() >= 2048 {
                self.flush_staged_usage_requests(&staged)?;
                staged.clear();
            }
        }
        if !staged.is_empty() {
            self.flush_staged_usage_requests(&staged)?;
        }

        {
            let conn = self.events_db.lock();
            conn.execute(
                "INSERT INTO event_meta(key, value) VALUES(?1, '1')
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [Self::USAGE_REQUESTS_SQLITE_MIGRATED_FROM_SLED_KEY],
            )?;
        }
        self.clear_prefix(b"usage_req:");
        let _ = self.db.flush();
        Ok(())
    }

    fn flush_staged_usage_requests(&self, staged: &[UsageRequestSqlRow]) -> anyhow::Result<()> {
        let mut conn = self.events_db.lock();
        let tx = conn.transaction()?;
        for (
            id,
            unix_ms,
            provider,
            api_key_ref,
            model,
            origin,
            session_id,
            input_tokens,
            output_tokens,
            total_tokens,
            cache_creation_input_tokens,
            cache_read_input_tokens,
        ) in staged
        {
            tx.execute(
                "INSERT OR IGNORE INTO usage_requests(
                    id, unix_ms, provider, api_key_ref, model, origin, session_id,
                    input_tokens, output_tokens, total_tokens,
                    cache_creation_input_tokens, cache_read_input_tokens
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    id,
                    unix_ms,
                    provider,
                    api_key_ref,
                    model,
                    origin,
                    session_id,
                    input_tokens,
                    output_tokens,
                    total_tokens,
                    cache_creation_input_tokens,
                    cache_read_input_tokens,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn add_event(&self, provider: &str, level: &str, code: &str, message: &str, fields: Value) {
        let ts = unix_ms();
        let id = uuid::Uuid::new_v4().to_string();
        let fields = match fields {
            Value::Object(_) => fields,
            Value::Null => Value::Null,
            other => serde_json::json!({ "value": other }),
        };
        let fields_json = serde_json::to_string(&fields).unwrap_or_else(|_| "null".to_string());
        let Ok(ts_i64) = i64::try_from(ts) else {
            return;
        };
        let Some(day_key) = Self::local_day_key_from_unix_ms(ts) else {
            return;
        };
        let Some(day_start_unix_ms) =
            Self::day_start_unix_ms_from_day_key(&day_key).and_then(|x| i64::try_from(x).ok())
        else {
            return;
        };
        let mut conn = self.events_db.lock();
        let Ok(tx) = conn.transaction() else {
            return;
        };
        let inserted = tx.execute(
            "INSERT OR REPLACE INTO events(id, unix_ms, provider, level, code, message, fields_json)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, ts_i64, provider, level, code, message, fields_json],
        );
        if inserted.is_err() {
            let _ = tx.rollback();
            return;
        }
        if Self::upsert_event_day_counts(&tx, &day_key, day_start_unix_ms, level).is_err() {
            let _ = tx.rollback();
            return;
        }
        let _ = tx.commit();
    }

    pub fn record_success(
        &self,
        provider: &str,
        response_obj: &Value,
        api_key_ref: Option<&str>,
        origin: &str,
        session_id: Option<&str>,
    ) {
        self.record_success_with_model(
            provider,
            response_obj,
            api_key_ref,
            None,
            origin,
            session_id,
        );
    }

    pub fn record_success_with_model(
        &self,
        provider: &str,
        response_obj: &Value,
        api_key_ref: Option<&str>,
        model_override: Option<&str>,
        origin: &str,
        session_id: Option<&str>,
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
            session_id,
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
        {
            let conn = self.events_db.lock();
            let _ = conn.execute(
                "UPDATE usage_requests SET provider=?1 WHERE provider=?2",
                params![new, old],
            );
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
        let cap = limit.max(1);
        let conn = self.events_db.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT unix_ms, provider, level, code, message, fields_json
             FROM events
             ORDER BY unix_ms DESC
             LIMIT ?1",
        ) else {
            return Vec::new();
        };
        let Ok(rows) = stmt.query_map([cap as i64], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        }) else {
            return Vec::new();
        };
        rows.flatten()
            .filter_map(|(unix_ms, provider, level, code, message, fields_json)| {
                Self::event_from_sql_row(unix_ms, provider, level, code, message, fields_json)
            })
            .collect()
    }

    pub fn list_events_split(&self, max_error: usize, max_other: usize) -> Vec<Value> {
        let mut out: Vec<Value> = Vec::with_capacity(max_error + max_other);
        let conn = self.events_db.lock();
        let query_with_level = |where_clause: &str, cap: usize| -> Vec<Value> {
            if cap == 0 {
                return Vec::new();
            }
            let sql = format!(
                "SELECT unix_ms, provider, level, code, message, fields_json
                 FROM events
                 WHERE {where_clause}
                 ORDER BY unix_ms DESC
                 LIMIT ?1"
            );
            let Ok(mut stmt) = conn.prepare(&sql) else {
                return Vec::new();
            };
            let Ok(rows) = stmt.query_map([cap as i64], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            }) else {
                return Vec::new();
            };
            rows.flatten()
                .filter_map(|(unix_ms, provider, level, code, message, fields_json)| {
                    Self::event_from_sql_row(unix_ms, provider, level, code, message, fields_json)
                })
                .collect()
        };
        out.extend(query_with_level("level = 'error'", max_error));
        out.extend(query_with_level("level <> 'error'", max_other));
        out.sort_by(|a, b| {
            let a_ts = a.get("unix_ms").and_then(|v| v.as_u64()).unwrap_or(0);
            let b_ts = b.get("unix_ms").and_then(|v| v.as_u64()).unwrap_or(0);
            b_ts.cmp(&a_ts)
        });
        out
    }

    pub fn list_event_years(&self) -> std::collections::BTreeSet<i32> {
        let mut years = std::collections::BTreeSet::<i32>::new();
        let conn = self.events_db.lock();
        let Ok(mut stmt) = conn
            .prepare("SELECT DISTINCT substr(day_key, 1, 4) AS y FROM event_day_counts ORDER BY y")
        else {
            return years;
        };
        let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) else {
            return years;
        };
        for y in rows.flatten() {
            if let Ok(v) = y.parse::<i32>() {
                let _ = years.insert(v);
            }
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
        let from_i64 = from_day_start.and_then(|x| i64::try_from(x).ok());
        let to_i64 = to_day_start.and_then(|x| i64::try_from(x).ok());
        let conn = self.events_db.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT day_key, day_start_unix_ms, total, infos, warnings, errors
             FROM event_day_counts
             WHERE (?1 IS NULL OR day_start_unix_ms >= ?1)
               AND (?2 IS NULL OR day_start_unix_ms <= ?2)
             ORDER BY day_start_unix_ms ASC",
        ) else {
            return out;
        };
        let Ok(rows) = stmt.query_map(params![from_i64, to_i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
            ))
        }) else {
            return out;
        };
        for (day_key, day_start_unix_ms, total, infos, warnings, errors) in rows.flatten() {
            let Ok(day_start_u64) = u64::try_from(day_start_unix_ms) else {
                continue;
            };
            let Ok(total_u64) = u64::try_from(total) else {
                continue;
            };
            let Ok(infos_u64) = u64::try_from(infos) else {
                continue;
            };
            let Ok(warnings_u64) = u64::try_from(warnings) else {
                continue;
            };
            let Ok(errors_u64) = u64::try_from(errors) else {
                continue;
            };
            out.push(serde_json::json!({
                "day": day_key,
                "day_start_unix_ms": day_start_u64,
                "total": total_u64,
                "infos": infos_u64,
                "warnings": warnings_u64,
                "errors": errors_u64,
            }));
        }
        out
    }

    pub fn list_events_range(
        &self,
        from_unix_ms: Option<u64>,
        to_unix_ms: Option<u64>,
        limit: Option<usize>,
    ) -> Vec<Value> {
        let cap = limit.unwrap_or(usize::MAX).max(1);
        let from_i64 = from_unix_ms.and_then(|x| i64::try_from(x).ok());
        let to_i64 = to_unix_ms.and_then(|x| i64::try_from(x).ok());
        let mut out: Vec<Value> = Vec::with_capacity(cap.min(1024));
        let conn = self.events_db.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT unix_ms, provider, level, code, message, fields_json
             FROM events
             WHERE (?1 IS NULL OR unix_ms >= ?1)
               AND (?2 IS NULL OR unix_ms <= ?2)
             ORDER BY unix_ms DESC
             LIMIT ?3",
        ) else {
            return out;
        };
        let Ok(rows) = stmt.query_map(params![from_i64, to_i64, cap as i64], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        }) else {
            return out;
        };
        for (unix_ms, provider, level, code, message, fields_json) in rows.flatten() {
            if let Some(v) =
                Self::event_from_sql_row(unix_ms, provider, level, code, message, fields_json)
            {
                out.push(v);
            }
        }
        out
    }

    #[allow(dead_code)]
    pub fn list_usage_requests(&self, limit: usize) -> Vec<Value> {
        let mut out: Vec<Value> = Vec::with_capacity(limit.min(1024));
        let conn = self.events_db.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT provider, api_key_ref, model, origin, session_id, unix_ms,
                    input_tokens, output_tokens, total_tokens,
                    cache_creation_input_tokens, cache_read_input_tokens
             FROM usage_requests
             ORDER BY unix_ms DESC
             LIMIT ?1",
        ) else {
            return out;
        };
        let Ok(rows) = stmt.query_map([limit as i64], |row| {
            Ok(serde_json::json!({
                "provider": row.get::<_, String>(0)?,
                "api_key_ref": row.get::<_, String>(1)?,
                "model": row.get::<_, String>(2)?,
                "origin": row.get::<_, String>(3)?,
                "session_id": row.get::<_, String>(4)?,
                "unix_ms": u64::try_from(row.get::<_, i64>(5)?).unwrap_or(0),
                "input_tokens": u64::try_from(row.get::<_, i64>(6)?).unwrap_or(0),
                "output_tokens": u64::try_from(row.get::<_, i64>(7)?).unwrap_or(0),
                "total_tokens": u64::try_from(row.get::<_, i64>(8)?).unwrap_or(0),
                "cache_creation_input_tokens": u64::try_from(row.get::<_, i64>(9)?).unwrap_or(0),
                "cache_read_input_tokens": u64::try_from(row.get::<_, i64>(10)?).unwrap_or(0),
            }))
        }) else {
            return out;
        };
        for row in rows.flatten() {
            out.push(row);
        }
        out
    }

    pub fn list_usage_requests_page(
        &self,
        since_unix_ms: u64,
        providers: &[String],
        models: &[String],
        origins: &[String],
        limit: usize,
        offset: usize,
    ) -> (Vec<Value>, bool) {
        let mut sql = String::from(
            "SELECT provider, api_key_ref, model, origin, session_id, unix_ms,
                    input_tokens, output_tokens, total_tokens,
                    cache_creation_input_tokens, cache_read_input_tokens
             FROM usage_requests
             WHERE unix_ms >= ?",
        );
        let mut params: Vec<rusqlite::types::Value> = vec![rusqlite::types::Value::Integer(
            i64::try_from(since_unix_ms).unwrap_or(i64::MAX),
        )];

        if !providers.is_empty() {
            let placeholders = vec!["?"; providers.len()].join(", ");
            sql.push_str(&format!(" AND lower(provider) IN ({placeholders})"));
            for provider in providers {
                params.push(rusqlite::types::Value::Text(
                    provider.trim().to_ascii_lowercase(),
                ));
            }
        }
        if !models.is_empty() {
            let placeholders = vec!["?"; models.len()].join(", ");
            sql.push_str(&format!(" AND lower(model) IN ({placeholders})"));
            for model in models {
                params.push(rusqlite::types::Value::Text(
                    model.trim().to_ascii_lowercase(),
                ));
            }
        }
        if !origins.is_empty() {
            let placeholders = vec!["?"; origins.len()].join(", ");
            sql.push_str(&format!(" AND lower(origin) IN ({placeholders})"));
            for origin in origins {
                params.push(rusqlite::types::Value::Text(
                    origin.trim().to_ascii_lowercase(),
                ));
            }
        }
        sql.push_str(" ORDER BY unix_ms DESC LIMIT ? OFFSET ?");
        params.push(rusqlite::types::Value::Integer(
            i64::try_from(limit.saturating_add(1)).unwrap_or(i64::MAX),
        ));
        params.push(rusqlite::types::Value::Integer(
            i64::try_from(offset).unwrap_or(i64::MAX),
        ));

        let mut out: Vec<Value> = Vec::with_capacity(limit.min(1024));
        let conn = self.events_db.lock();
        let Ok(mut stmt) = conn.prepare(&sql) else {
            return (out, false);
        };
        let Ok(rows) = stmt.query_map(params_from_iter(params.iter()), |row| {
            Ok(serde_json::json!({
                "provider": row.get::<_, String>(0)?,
                "api_key_ref": row.get::<_, String>(1)?,
                "model": row.get::<_, String>(2)?,
                "origin": row.get::<_, String>(3)?,
                "session_id": row.get::<_, String>(4)?,
                "unix_ms": u64::try_from(row.get::<_, i64>(5)?).unwrap_or(0),
                "input_tokens": u64::try_from(row.get::<_, i64>(6)?).unwrap_or(0),
                "output_tokens": u64::try_from(row.get::<_, i64>(7)?).unwrap_or(0),
                "total_tokens": u64::try_from(row.get::<_, i64>(8)?).unwrap_or(0),
                "cache_creation_input_tokens": u64::try_from(row.get::<_, i64>(9)?).unwrap_or(0),
                "cache_read_input_tokens": u64::try_from(row.get::<_, i64>(10)?).unwrap_or(0),
            }))
        }) else {
            return (out, false);
        };
        for row in rows.flatten() {
            out.push(row);
        }
        let has_more = out.len() > limit;
        if has_more {
            out.truncate(limit);
        }
        (out, has_more)
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

        {
            let mut conn = self.events_db.lock();
            let Ok(tx) = conn.transaction() else {
                return updated;
            };
            {
                let Ok(mut stmt) =
                    tx.prepare("SELECT id, provider, api_key_ref FROM usage_requests")
                else {
                    return updated;
                };
                let Ok(rows) = stmt.query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                }) else {
                    return updated;
                };
                for (id, provider, existing_ref) in rows.flatten() {
                    let existing_ref = existing_ref.trim();
                    if !existing_ref.is_empty() && existing_ref != "-" {
                        continue;
                    }
                    let key_ref = provider_api_key_ref
                        .get(provider.trim())
                        .cloned()
                        .unwrap_or_else(|| "-".to_string());
                    let _ = tx.execute(
                        "UPDATE usage_requests SET api_key_ref=?1 WHERE id=?2",
                        params![key_ref, id],
                    );
                    updated = updated.saturating_add(1);
                }
            }
            let _ = tx.commit();
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
