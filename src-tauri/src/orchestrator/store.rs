use chrono::{Datelike, Local, TimeZone};
use parking_lot::Mutex;
use rusqlite::{params, params_from_iter, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;

mod usage_tracking;

#[derive(Clone)]
pub struct Store {
    db: sled::Db,
    events_db_path: PathBuf,
    events_db: Arc<Mutex<rusqlite::Connection>>,
}

const LEDGER_DEFAULT: &str = r#"{"since_last_quota_refresh_requests":0,"since_last_quota_refresh_input_tokens":0,"since_last_quota_refresh_output_tokens":0,"since_last_quota_refresh_total_tokens":0,"last_reset_unix_ms":0}"#;

#[derive(Clone, Copy)]
struct UsageTokenIncrements {
    input_tokens: u64,
    output_tokens: u64,
    total_tokens: u64,
    cache_creation_input_tokens: u64,
    cache_read_input_tokens: u64,
}

#[derive(Clone, Copy)]
pub struct UsageRequestContext<'a> {
    pub api_key_ref: Option<&'a str>,
    pub origin: &'a str,
    pub session_id: Option<&'a str>,
    pub node_id: Option<&'a str>,
    pub node_name: Option<&'a str>,
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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct UsageRequestSyncRow {
    pub id: String,
    pub unix_ms: u64,
    pub ingested_at_unix_ms: u64,
    pub provider: String,
    pub api_key_ref: String,
    pub model: String,
    pub origin: String,
    pub session_id: String,
    pub node_id: String,
    pub node_name: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsageRequestStatsRow {
    pub provider: String,
    pub api_key_ref: String,
    pub model: String,
    pub origin: String,
    pub node_name: String,
    pub unix_ms: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct LanEditSyncEvent {
    pub event_id: String,
    pub node_id: String,
    pub node_name: String,
    pub created_at_unix_ms: u64,
    pub lamport_ts: u64,
    pub entity_type: String,
    pub entity_id: String,
    pub op: String,
    pub payload: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct LanProviderDefinitionSnapshotRecord {
    pub source_node_id: String,
    pub source_node_name: String,
    pub shared_provider_id: String,
    pub provider_name: String,
    pub deleted: bool,
    pub snapshot: Value,
    pub updated_at_unix_ms: u64,
    pub lamport_ts: u64,
    pub revision_event_id: String,
}

#[derive(Clone, Debug)]
pub struct SessionRouteAssignment {
    pub session_id: String,
    pub provider: String,
    pub assigned_at_unix_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EventDailyCountBucketKind {
    ProviderCodePerMinute,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EventRawDedupScope {
    ExactRow,
    ProviderAndCode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EventDisplayBucketKind {
    EditSyncAppliedPerMinuteAndSourceNode,
    SharedUsageAppliedPerMinuteAndSourceNode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct EventPolicy {
    raw_dedup_window_ms: Option<u64>,
    raw_dedup_scope: EventRawDedupScope,
    daily_count_bucket: Option<EventDailyCountBucketKind>,
    display_bucket: Option<EventDisplayBucketKind>,
}

impl Default for EventPolicy {
    fn default() -> Self {
        Self {
            raw_dedup_window_ms: None,
            raw_dedup_scope: EventRawDedupScope::ExactRow,
            daily_count_bucket: None,
            display_bucket: None,
        }
    }
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
    const MAX_DB_BYTES: u64 = 64 * 1024 * 1024; // 64 MiB, best-effort cap via compaction
    const EVENTS_SQLITE_SCHEMA_VERSION: &'static str = "1";
    const EVENTS_SQLITE_MIGRATED_FROM_SLED_KEY: &'static str = "migrated_from_sled_v1";
    const EVENTS_SQLITE_MERGED_LEGACY_SQLITE_KEY: &'static str = "merged_legacy_sqlite_v1";
    // Day-count index rebuild marker. Bump this when the rules for event inclusion change.
    const EVENT_DAY_COUNTS_INDEX_VERSION_KEY: &'static str = "event_day_counts_index_version";
    const EVENT_DAY_COUNTS_INDEX_VERSION: &'static str = "4";
    const USAGE_REQUESTS_SQLITE_MIGRATED_FROM_SLED_KEY: &'static str =
        "usage_requests_migrated_from_sled_v1";
    const SPEND_HISTORY_SQLITE_MIGRATED_FROM_SLED_KEY: &'static str =
        "spend_history_sqlite_migrated_from_sled_v1";

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
        let events_db = rusqlite::Connection::open(&events_db_path)
            .map_err(|e| sled::Error::Unsupported(format!("open events sqlite failed: {e}")))?;
        let store = Self {
            db,
            events_db_path,
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
            CREATE INDEX IF NOT EXISTS idx_events_level_unix_ms ON events(level, unix_ms DESC);
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
              ingested_at_unix_ms INTEGER NOT NULL DEFAULT 0,
              provider TEXT NOT NULL,
              api_key_ref TEXT NOT NULL,
              model TEXT NOT NULL,
              origin TEXT NOT NULL,
              session_id TEXT NOT NULL,
              node_id TEXT NOT NULL DEFAULT '',
              node_name TEXT NOT NULL DEFAULT '',
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
            CREATE INDEX IF NOT EXISTS idx_usage_requests_session_lc ON usage_requests(lower(session_id));
            CREATE INDEX IF NOT EXISTS idx_usage_requests_provider_lc_unix_ms_id
              ON usage_requests(lower(provider), unix_ms DESC, id DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_requests_origin_lc_unix_ms_id
              ON usage_requests(lower(origin), unix_ms DESC, id DESC);
            CREATE TABLE IF NOT EXISTS lan_edit_events(
              event_id TEXT PRIMARY KEY,
              node_id TEXT NOT NULL,
              node_name TEXT NOT NULL,
              created_at_unix_ms INTEGER NOT NULL,
              lamport_ts INTEGER NOT NULL,
              entity_type TEXT NOT NULL,
              entity_id TEXT NOT NULL,
              op TEXT NOT NULL,
              payload_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_lan_edit_events_lamport_event
              ON lan_edit_events(lamport_ts ASC, event_id ASC);
            CREATE TABLE IF NOT EXISTS lan_provider_definition_snapshots(
              source_node_id TEXT NOT NULL,
              source_node_name TEXT NOT NULL,
              shared_provider_id TEXT NOT NULL,
              provider_name TEXT NOT NULL,
              deleted INTEGER NOT NULL,
              snapshot_json TEXT NOT NULL,
              updated_at_unix_ms INTEGER NOT NULL,
              lamport_ts INTEGER NOT NULL,
              revision_event_id TEXT NOT NULL,
              PRIMARY KEY(source_node_id, shared_provider_id)
            );
            CREATE INDEX IF NOT EXISTS idx_lan_provider_definition_snapshots_source
              ON lan_provider_definition_snapshots(source_node_id, deleted, provider_name);
            CREATE TABLE IF NOT EXISTS usage_request_day_provider_totals(
              day_key TEXT NOT NULL,
              provider TEXT NOT NULL,
              total_tokens INTEGER NOT NULL,
              request_count INTEGER NOT NULL,
              windows_request_count INTEGER NOT NULL,
              wsl_request_count INTEGER NOT NULL,
              PRIMARY KEY(day_key, provider)
            );
            CREATE TABLE IF NOT EXISTS spend_days(
              provider TEXT NOT NULL,
              day_started_at_unix_ms INTEGER NOT NULL,
              row_json TEXT NOT NULL,
              PRIMARY KEY(provider, day_started_at_unix_ms)
            );
            CREATE INDEX IF NOT EXISTS idx_spend_days_provider_started_at
              ON spend_days(provider, day_started_at_unix_ms ASC);
            CREATE TABLE IF NOT EXISTS spend_days_remote(
              provider TEXT NOT NULL,
              source_node_id TEXT NOT NULL,
              source_node_name TEXT NOT NULL,
              day_started_at_unix_ms INTEGER NOT NULL,
              row_json TEXT NOT NULL,
              PRIMARY KEY(provider, source_node_id, day_started_at_unix_ms)
            );
            CREATE INDEX IF NOT EXISTS idx_spend_days_remote_provider_started_at
              ON spend_days_remote(provider, day_started_at_unix_ms ASC, source_node_id ASC);
            CREATE TABLE IF NOT EXISTS spend_manual_days(
              provider TEXT NOT NULL,
              day_key TEXT NOT NULL,
              row_json TEXT NOT NULL,
              PRIMARY KEY(provider, day_key)
            );
            CREATE INDEX IF NOT EXISTS idx_spend_manual_days_provider_day
              ON spend_manual_days(provider, day_key ASC);
            CREATE TABLE IF NOT EXISTS spend_manual_days_remote(
              provider TEXT NOT NULL,
              source_node_id TEXT NOT NULL,
              source_node_name TEXT NOT NULL,
              day_key TEXT NOT NULL,
              row_json TEXT NOT NULL,
              PRIMARY KEY(provider, source_node_id, day_key)
            );
            CREATE INDEX IF NOT EXISTS idx_spend_manual_days_remote_provider_day
              ON spend_manual_days_remote(provider, day_key ASC, source_node_id ASC);
            CREATE TABLE IF NOT EXISTS provider_pricing_configs(
              provider TEXT PRIMARY KEY,
              pricing_json TEXT NOT NULL,
              updated_at_unix_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS provider_pricing_configs_remote(
              provider TEXT NOT NULL,
              source_node_id TEXT NOT NULL,
              source_node_name TEXT NOT NULL,
              pricing_json TEXT NOT NULL,
              updated_at_unix_ms INTEGER NOT NULL,
              PRIMARY KEY(provider, source_node_id)
            );
            CREATE INDEX IF NOT EXISTS idx_usage_request_day_provider_day_key
              ON usage_request_day_provider_totals(day_key ASC);
            CREATE TRIGGER IF NOT EXISTS trg_usage_requests_daily_index_after_insert
            AFTER INSERT ON usage_requests
            BEGIN
              INSERT INTO usage_request_day_provider_totals(
                day_key,
                provider,
                total_tokens,
                request_count,
                windows_request_count,
                wsl_request_count
              )
              VALUES(
                strftime('%Y-%m-%d', NEW.unix_ms / 1000, 'unixepoch', 'localtime'),
                NEW.provider,
                NEW.total_tokens,
                1,
                CASE WHEN lower(NEW.origin) = 'windows' THEN 1 ELSE 0 END,
                CASE WHEN lower(NEW.origin) = 'wsl2' THEN 1 ELSE 0 END
              )
              ON CONFLICT(day_key, provider) DO UPDATE SET
                total_tokens = usage_request_day_provider_totals.total_tokens + excluded.total_tokens,
                request_count = usage_request_day_provider_totals.request_count + excluded.request_count,
                windows_request_count = usage_request_day_provider_totals.windows_request_count + excluded.windows_request_count,
                wsl_request_count = usage_request_day_provider_totals.wsl_request_count + excluded.wsl_request_count;
            END;
            CREATE TRIGGER IF NOT EXISTS trg_usage_requests_daily_index_after_update
            AFTER UPDATE OF unix_ms, provider, total_tokens, origin ON usage_requests
            BEGIN
              UPDATE usage_request_day_provider_totals
              SET
                total_tokens = total_tokens - OLD.total_tokens,
                request_count = request_count - 1,
                windows_request_count = windows_request_count - CASE WHEN lower(OLD.origin) = 'windows' THEN 1 ELSE 0 END,
                wsl_request_count = wsl_request_count - CASE WHEN lower(OLD.origin) = 'wsl2' THEN 1 ELSE 0 END
              WHERE
                day_key = strftime('%Y-%m-%d', OLD.unix_ms / 1000, 'unixepoch', 'localtime')
                AND provider = OLD.provider;
              DELETE FROM usage_request_day_provider_totals
              WHERE
                day_key = strftime('%Y-%m-%d', OLD.unix_ms / 1000, 'unixepoch', 'localtime')
                AND provider = OLD.provider
                AND request_count <= 0;
              INSERT INTO usage_request_day_provider_totals(
                day_key,
                provider,
                total_tokens,
                request_count,
                windows_request_count,
                wsl_request_count
              )
              VALUES(
                strftime('%Y-%m-%d', NEW.unix_ms / 1000, 'unixepoch', 'localtime'),
                NEW.provider,
                NEW.total_tokens,
                1,
                CASE WHEN lower(NEW.origin) = 'windows' THEN 1 ELSE 0 END,
                CASE WHEN lower(NEW.origin) = 'wsl2' THEN 1 ELSE 0 END
              )
              ON CONFLICT(day_key, provider) DO UPDATE SET
                total_tokens = usage_request_day_provider_totals.total_tokens + excluded.total_tokens,
                request_count = usage_request_day_provider_totals.request_count + excluded.request_count,
                windows_request_count = usage_request_day_provider_totals.windows_request_count + excluded.windows_request_count,
                wsl_request_count = usage_request_day_provider_totals.wsl_request_count + excluded.wsl_request_count;
            END;
            CREATE TRIGGER IF NOT EXISTS trg_usage_requests_daily_index_after_delete
            AFTER DELETE ON usage_requests
            BEGIN
              UPDATE usage_request_day_provider_totals
              SET
                total_tokens = total_tokens - OLD.total_tokens,
                request_count = request_count - 1,
                windows_request_count = windows_request_count - CASE WHEN lower(OLD.origin) = 'windows' THEN 1 ELSE 0 END,
                wsl_request_count = wsl_request_count - CASE WHEN lower(OLD.origin) = 'wsl2' THEN 1 ELSE 0 END
              WHERE
                day_key = strftime('%Y-%m-%d', OLD.unix_ms / 1000, 'unixepoch', 'localtime')
                AND provider = OLD.provider;
              DELETE FROM usage_request_day_provider_totals
              WHERE
                day_key = strftime('%Y-%m-%d', OLD.unix_ms / 1000, 'unixepoch', 'localtime')
                AND provider = OLD.provider
                AND request_count <= 0;
            END;
            CREATE TABLE IF NOT EXISTS session_route_assignments(
              session_id TEXT PRIMARY KEY,
              provider TEXT NOT NULL,
              assigned_at_unix_ms INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_session_route_assignments_provider
              ON session_route_assignments(provider);
            CREATE INDEX IF NOT EXISTS idx_session_route_assignments_assigned_at
              ON session_route_assignments(assigned_at_unix_ms DESC);
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
            conn.execute(
                "INSERT INTO event_meta(key, value) VALUES(?1, '0')
                 ON CONFLICT(key) DO UPDATE SET value='0'",
                [Self::SPEND_HISTORY_SQLITE_MIGRATED_FROM_SLED_KEY],
            )?;
            conn.execute(
                "INSERT INTO event_meta(key, value) VALUES('lan_edit_lamport_clock', '0')
                 ON CONFLICT(key) DO UPDATE SET value='0'",
                [],
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
        conn.execute(
            "INSERT INTO event_meta(key, value) VALUES(?1, '0')
             ON CONFLICT(key) DO NOTHING",
            [Self::SPEND_HISTORY_SQLITE_MIGRATED_FROM_SLED_KEY],
        )?;
        conn.execute(
            "INSERT INTO event_meta(key, value) VALUES('lan_edit_lamport_clock', '0')
             ON CONFLICT(key) DO NOTHING",
            [],
        )?;
        Self::ensure_usage_request_columns(&conn)?;
        drop(conn);
        self.migrate_legacy_events_from_sled_if_needed()?;
        self.migrate_usage_requests_from_sled_if_needed()?;
        self.migrate_spend_history_from_sled_if_needed()?;
        self.backfill_usage_request_daily_index_if_needed()?;
        self.rebuild_event_day_counts_index_if_needed()?;
        Ok(())
    }

    fn open_events_read_connection(&self) -> rusqlite::Result<rusqlite::Connection> {
        let conn = rusqlite::Connection::open_with_flags(
            &self.events_db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let _ = conn.busy_timeout(std::time::Duration::from_millis(250));
        Ok(conn)
    }

    fn with_events_read_conn<T>(&self, f: impl FnOnce(&rusqlite::Connection) -> T) -> T {
        match self.open_events_read_connection() {
            Ok(conn) => f(&conn),
            Err(_) => {
                let conn = self.events_db.lock();
                f(&conn)
            }
        }
    }

    fn ensure_usage_request_columns(conn: &rusqlite::Connection) -> anyhow::Result<()> {
        let mut columns = std::collections::BTreeSet::new();
        let mut stmt = conn.prepare("PRAGMA table_info(usage_requests)")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        for column in rows.flatten() {
            columns.insert(column);
        }
        if !columns.contains("ingested_at_unix_ms") {
            conn.execute(
                "ALTER TABLE usage_requests ADD COLUMN ingested_at_unix_ms INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
            conn.execute(
                "UPDATE usage_requests SET ingested_at_unix_ms = unix_ms WHERE ingested_at_unix_ms = 0",
                [],
            )?;
        }
        if !columns.contains("node_id") {
            conn.execute(
                "ALTER TABLE usage_requests ADD COLUMN node_id TEXT NOT NULL DEFAULT ''",
                [],
            )?;
        }
        if !columns.contains("node_name") {
            conn.execute(
                "ALTER TABLE usage_requests ADD COLUMN node_name TEXT NOT NULL DEFAULT ''",
                [],
            )?;
        }
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_usage_requests_ingested_at_id
             ON usage_requests(ingested_at_unix_ms ASC, id ASC)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_usage_requests_node_name_lc
             ON usage_requests(lower(node_name))",
            [],
        )?;
        Ok(())
    }

    fn backfill_usage_request_daily_index_if_needed(&self) -> anyhow::Result<()> {
        let conn = self.events_db.lock();
        let has_rows: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM usage_request_day_provider_totals LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if has_rows.is_some() {
            return Ok(());
        }
        conn.execute_batch(
            "
            INSERT INTO usage_request_day_provider_totals(
              day_key,
              provider,
              total_tokens,
              request_count,
              windows_request_count,
              wsl_request_count
            )
            SELECT
              strftime('%Y-%m-%d', unix_ms / 1000, 'unixepoch', 'localtime') AS day_key,
              provider,
              SUM(total_tokens) AS total_tokens,
              COUNT(*) AS request_count,
              SUM(CASE WHEN lower(origin) = 'windows' THEN 1 ELSE 0 END) AS windows_request_count,
              SUM(CASE WHEN lower(origin) = 'wsl2' THEN 1 ELSE 0 END) AS wsl_request_count
            FROM usage_requests
            GROUP BY day_key, provider;
            ",
        )?;
        Ok(())
    }

    fn legacy_sqlite_merge_done(&self) -> anyhow::Result<bool> {
        let value = self.get_event_meta(Self::EVENTS_SQLITE_MERGED_LEGACY_SQLITE_KEY)?;
        Ok(value.as_deref() == Some("1"))
    }

    fn mark_legacy_sqlite_merge_done(&self) -> anyhow::Result<()> {
        self.set_event_meta(Self::EVENTS_SQLITE_MERGED_LEGACY_SQLITE_KEY, "1")
    }

    pub fn get_event_meta(&self, key: &str) -> anyhow::Result<Option<String>> {
        let conn = self.events_db.lock();
        conn.query_row("SELECT value FROM event_meta WHERE key=?1", [key], |row| {
            row.get(0)
        })
        .optional()
        .map_err(Into::into)
    }

    pub fn set_event_meta(&self, key: &str, value: &str) -> anyhow::Result<()> {
        let conn = self.events_db.lock();
        conn.execute(
            "INSERT INTO event_meta(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn delete_event_meta(&self, key: &str) -> anyhow::Result<()> {
        let conn = self.events_db.lock();
        conn.execute("DELETE FROM event_meta WHERE key = ?1", [key])?;
        Ok(())
    }

    pub fn next_lan_edit_lamport_ts(&self, observed_remote: Option<u64>) -> u64 {
        let conn = self.events_db.lock();
        let current = conn
            .query_row(
                "SELECT value FROM event_meta WHERE key='lan_edit_lamport_clock'",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let next = current.max(observed_remote.unwrap_or(0)).saturating_add(1);
        let _ = conn.execute(
            "INSERT INTO event_meta(key, value) VALUES('lan_edit_lamport_clock', ?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [next.to_string()],
        );
        next
    }

    pub fn note_lan_edit_lamport_ts(&self, observed_remote: u64) {
        let conn = self.events_db.lock();
        let current = conn
            .query_row(
                "SELECT value FROM event_meta WHERE key='lan_edit_lamport_clock'",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        if observed_remote <= current {
            return;
        }
        let _ = conn.execute(
            "INSERT INTO event_meta(key, value) VALUES('lan_edit_lamport_clock', ?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [observed_remote.to_string()],
        );
    }

    pub fn insert_lan_edit_event(&self, event: &LanEditSyncEvent) -> bool {
        let payload_json =
            serde_json::to_string(&event.payload).unwrap_or_else(|_| "null".to_string());
        let conn = self.events_db.lock();
        conn.execute(
            "INSERT OR IGNORE INTO lan_edit_events(
                event_id, node_id, node_name, created_at_unix_ms, lamport_ts,
                entity_type, entity_id, op, payload_json
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                event.event_id,
                event.node_id,
                event.node_name,
                i64::try_from(event.created_at_unix_ms).unwrap_or(i64::MAX),
                i64::try_from(event.lamport_ts).unwrap_or(i64::MAX),
                event.entity_type,
                event.entity_id,
                event.op,
                payload_json,
            ],
        )
        .unwrap_or(0)
            > 0
    }

    pub fn list_lan_edit_events_batch(
        &self,
        after_lamport_ts: u64,
        after_event_id: Option<&str>,
        limit: usize,
    ) -> (Vec<LanEditSyncEvent>, bool) {
        let mut out = Vec::with_capacity(limit.min(128));
        let after_lamport_i64 = i64::try_from(after_lamport_ts).unwrap_or(i64::MAX);
        let after_event_id = after_event_id.unwrap_or_default().trim();
        let fetch_limit = limit.saturating_add(1);
        let conn = self.events_db.lock();
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
             WHERE lamport_ts > ?1
                OR (lamport_ts = ?1 AND event_id > ?2)
             ORDER BY lamport_ts ASC, event_id ASC
             LIMIT ?3",
        ) else {
            return (out, false);
        };
        let Ok(rows) = stmt.query_map(
            params![
                after_lamport_i64,
                after_event_id,
                i64::try_from(fetch_limit).unwrap_or(i64::MAX)
            ],
            |row| {
                let payload_json = row.get::<_, String>(8)?;
                Ok(LanEditSyncEvent {
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
            },
        ) else {
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

    pub fn get_lan_provider_definition_snapshot(
        &self,
        source_node_id: &str,
        shared_provider_id: &str,
    ) -> Option<LanProviderDefinitionSnapshotRecord> {
        let conn = self.events_db.lock();
        conn.query_row(
            "SELECT
                source_node_id,
                source_node_name,
                shared_provider_id,
                provider_name,
                deleted,
                snapshot_json,
                updated_at_unix_ms,
                lamport_ts,
                revision_event_id
             FROM lan_provider_definition_snapshots
             WHERE source_node_id = ?1 AND shared_provider_id = ?2",
            params![source_node_id.trim(), shared_provider_id.trim()],
            |row| {
                let snapshot_json = row.get::<_, String>(5)?;
                Ok(LanProviderDefinitionSnapshotRecord {
                    source_node_id: row.get::<_, String>(0)?,
                    source_node_name: row.get::<_, String>(1)?,
                    shared_provider_id: row.get::<_, String>(2)?,
                    provider_name: row.get::<_, String>(3)?,
                    deleted: row.get::<_, i64>(4)? != 0,
                    snapshot: serde_json::from_str(&snapshot_json).unwrap_or(Value::Null),
                    updated_at_unix_ms: u64::try_from(row.get::<_, i64>(6)?).unwrap_or(0),
                    lamport_ts: u64::try_from(row.get::<_, i64>(7)?).unwrap_or(0),
                    revision_event_id: row.get::<_, String>(8)?,
                })
            },
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn upsert_lan_provider_definition_snapshot(
        &self,
        record: &LanProviderDefinitionSnapshotRecord,
    ) -> Result<(), String> {
        let snapshot_json =
            serde_json::to_string(&record.snapshot).unwrap_or_else(|_| "null".to_string());
        let conn = self.events_db.lock();
        conn.execute(
            "INSERT INTO lan_provider_definition_snapshots(
                source_node_id,
                source_node_name,
                shared_provider_id,
                provider_name,
                deleted,
                snapshot_json,
                updated_at_unix_ms,
                lamport_ts,
                revision_event_id
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(source_node_id, shared_provider_id) DO UPDATE SET
                source_node_name = excluded.source_node_name,
                provider_name = excluded.provider_name,
                deleted = excluded.deleted,
                snapshot_json = excluded.snapshot_json,
                updated_at_unix_ms = excluded.updated_at_unix_ms,
                lamport_ts = excluded.lamport_ts,
                revision_event_id = excluded.revision_event_id",
            params![
                record.source_node_id,
                record.source_node_name,
                record.shared_provider_id,
                record.provider_name,
                if record.deleted { 1_i64 } else { 0_i64 },
                snapshot_json,
                i64::try_from(record.updated_at_unix_ms).unwrap_or(i64::MAX),
                i64::try_from(record.lamport_ts).unwrap_or(i64::MAX),
                record.revision_event_id,
            ],
        )
        .map_err(|err| err.to_string())?;
        Ok(())
    }

    pub fn list_lan_provider_definition_snapshots(
        &self,
        source_node_id: &str,
    ) -> Vec<LanProviderDefinitionSnapshotRecord> {
        let conn = self.events_db.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT
                source_node_id,
                source_node_name,
                shared_provider_id,
                provider_name,
                deleted,
                snapshot_json,
                updated_at_unix_ms,
                lamport_ts,
                revision_event_id
             FROM lan_provider_definition_snapshots
             WHERE source_node_id = ?1 AND deleted = 0
             ORDER BY lower(provider_name) ASC, shared_provider_id ASC",
        ) else {
            return Vec::new();
        };
        let Ok(rows) = stmt.query_map([source_node_id.trim()], |row| {
            let snapshot_json = row.get::<_, String>(5)?;
            Ok(LanProviderDefinitionSnapshotRecord {
                source_node_id: row.get::<_, String>(0)?,
                source_node_name: row.get::<_, String>(1)?,
                shared_provider_id: row.get::<_, String>(2)?,
                provider_name: row.get::<_, String>(3)?,
                deleted: row.get::<_, i64>(4)? != 0,
                snapshot: serde_json::from_str(&snapshot_json).unwrap_or(Value::Null),
                updated_at_unix_ms: u64::try_from(row.get::<_, i64>(6)?).unwrap_or(0),
                lamport_ts: u64::try_from(row.get::<_, i64>(7)?).unwrap_or(0),
                revision_event_id: row.get::<_, String>(8)?,
            })
        }) else {
            return Vec::new();
        };
        rows.flatten().collect()
    }

    pub fn list_all_lan_provider_definition_snapshots(
        &self,
        source_node_id: &str,
    ) -> Vec<LanProviderDefinitionSnapshotRecord> {
        let conn = self.events_db.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT
                source_node_id,
                source_node_name,
                shared_provider_id,
                provider_name,
                deleted,
                snapshot_json,
                updated_at_unix_ms,
                lamport_ts,
                revision_event_id
             FROM lan_provider_definition_snapshots
             WHERE source_node_id = ?1
             ORDER BY lower(provider_name) ASC, shared_provider_id ASC",
        ) else {
            return Vec::new();
        };
        let Ok(rows) = stmt.query_map([source_node_id.trim()], |row| {
            let snapshot_json = row.get::<_, String>(5)?;
            Ok(LanProviderDefinitionSnapshotRecord {
                source_node_id: row.get::<_, String>(0)?,
                source_node_name: row.get::<_, String>(1)?,
                shared_provider_id: row.get::<_, String>(2)?,
                provider_name: row.get::<_, String>(3)?,
                deleted: row.get::<_, i64>(4)? != 0,
                snapshot: serde_json::from_str(&snapshot_json).unwrap_or(Value::Null),
                updated_at_unix_ms: u64::try_from(row.get::<_, i64>(6)?).unwrap_or(0),
                lamport_ts: u64::try_from(row.get::<_, i64>(7)?).unwrap_or(0),
                revision_event_id: row.get::<_, String>(8)?,
            })
        }) else {
            return Vec::new();
        };
        rows.flatten().collect()
    }

    pub fn remove_lan_provider_definition_snapshot(
        &self,
        source_node_id: &str,
        shared_provider_id: &str,
    ) -> Result<(), String> {
        let conn = self.events_db.lock();
        conn.execute(
            "DELETE FROM lan_provider_definition_snapshots
             WHERE source_node_id = ?1 AND shared_provider_id = ?2",
            params![source_node_id.trim(), shared_provider_id.trim()],
        )
        .map_err(|err| err.to_string())?;
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

    pub(crate) fn local_day_key_from_unix_ms(ts_unix_ms: u64) -> Option<String> {
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

    fn event_policy(level: &str, code: &str) -> EventPolicy {
        let level = level.trim();
        let code = code.trim();

        let (raw_dedup_window_ms, raw_dedup_scope) = if level.eq_ignore_ascii_case("warning") {
            match code {
                "lan.edit_sync_http_failed"
                | "lan.usage_sync_http_failed"
                | "lan.provider_definitions_sync_failed"
                | "lan.shared_recovery_probe_failed" => {
                    (Some(30_000), EventRawDedupScope::ExactRow)
                }
                "app.ui_frame_stall" => (Some(10_000), EventRawDedupScope::ProviderAndCode),
                "app.ui_frontend_error" | "app.ui_invoke_error" => {
                    (Some(60_000), EventRawDedupScope::ProviderAndCode)
                }
                _ => (None, EventRawDedupScope::ExactRow),
            }
        } else {
            (None, EventRawDedupScope::ExactRow)
        };

        let daily_count_bucket = match code {
            "lan.shared_health_applied"
            | "lan.usage_sync_applied"
            | "lan.edit_sync_applied"
            | "routing.balanced_reassign_on_session_topology_change" => {
                Some(EventDailyCountBucketKind::ProviderCodePerMinute)
            }
            _ => None,
        };

        let display_bucket = match code {
            "lan.edit_sync_applied" => {
                Some(EventDisplayBucketKind::EditSyncAppliedPerMinuteAndSourceNode)
            }
            "usage.refresh_shared_applied" => {
                Some(EventDisplayBucketKind::SharedUsageAppliedPerMinuteAndSourceNode)
            }
            _ => None,
        };

        EventPolicy {
            raw_dedup_window_ms,
            raw_dedup_scope,
            daily_count_bucket,
            display_bucket,
        }
    }

    fn has_recent_duplicate_event(
        tx: &rusqlite::Transaction<'_>,
        provider: &str,
        level: &str,
        code: &str,
        message: &str,
        fields_json: &str,
        ts_i64: i64,
    ) -> rusqlite::Result<bool> {
        let policy = Self::event_policy(level, code);
        let Some(window_ms) = policy.raw_dedup_window_ms else {
            return Ok(false);
        };
        let cutoff = ts_i64.saturating_sub(i64::try_from(window_ms).unwrap_or(i64::MAX));
        let row = match policy.raw_dedup_scope {
            EventRawDedupScope::ExactRow => tx.query_row(
                "SELECT 1
                 FROM events
                 WHERE provider = ?1
                   AND level = ?2
                   AND code = ?3
                   AND message = ?4
                   AND fields_json = ?5
                   AND unix_ms >= ?6
                 LIMIT 1",
                params![provider, level, code, message, fields_json, cutoff],
                |_| Ok(()),
            ),
            EventRawDedupScope::ProviderAndCode => tx.query_row(
                "SELECT 1
                 FROM events
                 WHERE provider = ?1
                   AND level = ?2
                   AND code = ?3
                   AND unix_ms >= ?4
                 LIMIT 1",
                params![provider, level, code, cutoff],
                |_| Ok(()),
            ),
        };
        row.optional().map(|row| row.is_some())
    }

    fn compressed_daily_event_bucket_key(
        provider: &str,
        code: &str,
        unix_ms_i64: i64,
    ) -> Option<String> {
        let bucket_kind = Self::event_policy("", code).daily_count_bucket?;
        let unix_ms = u64::try_from(unix_ms_i64).ok()?;
        let minute_bucket = unix_ms / 60_000;
        match bucket_kind {
            EventDailyCountBucketKind::ProviderCodePerMinute => Some(format!(
                "{}|{}|{}",
                provider.trim().to_ascii_lowercase(),
                code.trim(),
                minute_bucket
            )),
        }
    }

    fn display_event_compression_bucket(event: &Value) -> Option<String> {
        let unix_ms = event.get("unix_ms")?.as_u64()?;
        let code = event.get("code")?.as_str()?.trim();
        let minute_bucket = unix_ms / 60_000;
        let fields = event.get("fields").and_then(Value::as_object);
        match Self::event_policy(
            event
                .get("level")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            code,
        )
        .display_bucket
        {
            Some(EventDisplayBucketKind::EditSyncAppliedPerMinuteAndSourceNode) => {
                let source_node_id = fields
                    .and_then(|map| map.get("source_node_id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_ascii_lowercase();
                Some(format!("{code}|{minute_bucket}|{source_node_id}"))
            }
            Some(EventDisplayBucketKind::SharedUsageAppliedPerMinuteAndSourceNode) => {
                let applied_from_node_id = fields
                    .and_then(|map| map.get("applied_from_node_id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_ascii_lowercase();
                Some(format!("{code}|{minute_bucket}|{applied_from_node_id}"))
            }
            None => None,
        }
    }

    pub(crate) fn compress_events_for_display(events: Vec<Value>) -> Vec<Value> {
        let mut passthrough = Vec::new();
        let mut buckets: std::collections::HashMap<String, Vec<Value>> =
            std::collections::HashMap::new();

        for event in events {
            if let Some(bucket) = Self::display_event_compression_bucket(&event) {
                buckets.entry(bucket).or_default().push(event);
            } else {
                passthrough.push(event);
            }
        }

        for mut bucket_events in buckets.into_values() {
            if bucket_events.len() == 1 {
                if let Some(event) = bucket_events.pop() {
                    passthrough.push(event);
                }
                continue;
            }
            bucket_events
                .sort_by_key(|event| event.get("unix_ms").and_then(Value::as_u64).unwrap_or(0));
            let Some(latest) = bucket_events.last().cloned() else {
                continue;
            };
            let code = latest
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();

            let compressed = match Self::event_policy(
                latest
                    .get("level")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                &code,
            )
            .display_bucket
            {
                Some(EventDisplayBucketKind::EditSyncAppliedPerMinuteAndSourceNode) => {
                    let mut applied_total = 0_u64;
                    let mut received_total = 0_u64;
                    let mut source_node_name = String::new();
                    for event in &bucket_events {
                        let fields = event.get("fields").and_then(Value::as_object);
                        applied_total = applied_total.saturating_add(
                            fields
                                .and_then(|map| map.get("applied_events"))
                                .and_then(Value::as_u64)
                                .unwrap_or(0),
                        );
                        received_total = received_total.saturating_add(
                            fields
                                .and_then(|map| map.get("received_events"))
                                .and_then(Value::as_u64)
                                .unwrap_or(0),
                        );
                        if source_node_name.is_empty() {
                            source_node_name = fields
                                .and_then(|map| map.get("source_node_name"))
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .trim()
                                .to_string();
                        }
                    }
                    let mut fields = latest.get("fields").cloned().unwrap_or(Value::Null);
                    if let Some(map) = fields.as_object_mut() {
                        map.insert(
                            "applied_events".to_string(),
                            serde_json::json!(applied_total),
                        );
                        map.insert(
                            "received_events".to_string(),
                            serde_json::json!(received_total),
                        );
                        map.insert(
                            "batch_count".to_string(),
                            serde_json::json!(bucket_events.len()),
                        );
                        map.insert("compressed".to_string(), serde_json::json!(true));
                    }
                    let source_suffix = if source_node_name.is_empty() {
                        String::new()
                    } else {
                        format!(" from {source_node_name}")
                    };
                    serde_json::json!({
                        "unix_ms": latest.get("unix_ms").and_then(Value::as_u64).unwrap_or(0),
                        "provider": latest.get("provider").and_then(Value::as_str).unwrap_or("gateway"),
                        "level": latest.get("level").and_then(Value::as_str).unwrap_or("info"),
                        "code": code,
                        "message": format!(
                            "Applied {applied_total} synced editable event(s) across {} batch(es){source_suffix}",
                            bucket_events.len()
                        ),
                        "fields": fields,
                    })
                }
                Some(EventDisplayBucketKind::SharedUsageAppliedPerMinuteAndSourceNode) => {
                    let mut applied_from_node_name = String::new();
                    let mut providers = std::collections::BTreeSet::new();
                    for event in &bucket_events {
                        if let Some(provider) = event.get("provider").and_then(Value::as_str) {
                            let trimmed = provider.trim();
                            if !trimmed.is_empty() {
                                let _ = providers.insert(trimmed.to_string());
                            }
                        }
                        let fields = event.get("fields").and_then(Value::as_object);
                        if applied_from_node_name.is_empty() {
                            applied_from_node_name = fields
                                .and_then(|map| map.get("applied_from_node_name"))
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .trim()
                                .to_string();
                        }
                    }
                    let provider_count = providers.len();
                    let mut fields = latest.get("fields").cloned().unwrap_or(Value::Null);
                    if let Some(map) = fields.as_object_mut() {
                        map.insert(
                            "provider_count".to_string(),
                            serde_json::json!(provider_count),
                        );
                        map.insert(
                            "providers".to_string(),
                            serde_json::json!(providers.clone()),
                        );
                        map.insert(
                            "event_count".to_string(),
                            serde_json::json!(bucket_events.len()),
                        );
                        map.insert("compressed".to_string(), serde_json::json!(true));
                    }
                    let provider_name = if provider_count == 1 {
                        providers
                            .into_iter()
                            .next()
                            .unwrap_or_else(|| "gateway".to_string())
                    } else {
                        "gateway".to_string()
                    };
                    let source_label = if applied_from_node_name.is_empty() {
                        "remote peer".to_string()
                    } else {
                        applied_from_node_name
                    };
                    serde_json::json!({
                        "unix_ms": latest.get("unix_ms").and_then(Value::as_u64).unwrap_or(0),
                        "provider": provider_name,
                        "level": latest.get("level").and_then(Value::as_str).unwrap_or("info"),
                        "code": code,
                        "message": format!(
                            "Applied shared usage update from {source_label} to {} provider(s)",
                            provider_count
                        ),
                        "fields": fields,
                    })
                }
                None => latest,
            };
            passthrough.push(compressed);
        }

        passthrough.sort_by(|a, b| {
            let a_ts = a.get("unix_ms").and_then(Value::as_u64).unwrap_or(0);
            let b_ts = b.get("unix_ms").and_then(Value::as_u64).unwrap_or(0);
            b_ts.cmp(&a_ts)
        });
        passthrough
    }

    fn rebuild_event_day_counts_index_if_needed(&self) -> anyhow::Result<()> {
        let mut conn = self.events_db.lock();
        let current: Option<String> = conn
            .query_row(
                "SELECT value FROM event_meta WHERE key=?1",
                [Self::EVENT_DAY_COUNTS_INDEX_VERSION_KEY],
                |row| row.get(0),
            )
            .optional()?;
        if current.as_deref() == Some(Self::EVENT_DAY_COUNTS_INDEX_VERSION) {
            return Ok(());
        }

        let tx = conn.transaction()?;
        tx.execute("DELETE FROM event_day_counts", [])?;

        let mut raw_rows: Vec<(i64, String, String, String, String)> = Vec::new();
        {
            let mut stmt =
                tx.prepare("SELECT unix_ms, provider, level, code, fields_json FROM events")?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })?;
            for row in rows.flatten() {
                raw_rows.push(row);
            }
        }

        #[derive(Default, Clone, Copy)]
        struct Counts {
            day_start_unix_ms: i64,
            total: i64,
            infos: i64,
            warnings: i64,
            errors: i64,
        }

        let mut by_day: std::collections::HashMap<String, Counts> =
            std::collections::HashMap::new();
        let mut mismatch_seen_by_day: std::collections::HashMap<
            String,
            std::collections::HashSet<String>,
        > = std::collections::HashMap::new();
        let mut compressed_seen_by_day: std::collections::HashMap<
            String,
            std::collections::HashSet<String>,
        > = std::collections::HashMap::new();
        for row in raw_rows {
            let (unix_ms_i64, provider, level, code, fields_json) = row;
            let Ok(unix_ms_u64) = u64::try_from(unix_ms_i64) else {
                continue;
            };
            let Some(day_key) = Self::local_day_key_from_unix_ms(unix_ms_u64) else {
                continue;
            };
            let fields = serde_json::from_str::<Value>(&fields_json).unwrap_or(Value::Null);
            if code.trim() == "routing.model_mismatch" {
                // Historical spam: upstream can keep returning the same "other" model for many requests.
                // We keep the warning, but only count it once per (provider, session, req, resp) per day.
                let obj = fields.as_object();
                let req = obj
                    .and_then(|o| o.get("requested_model"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .trim()
                    .to_ascii_lowercase();
                let resp = obj
                    .and_then(|o| o.get("response_model"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .trim()
                    .to_ascii_lowercase();
                let session = obj
                    .and_then(|o| o.get("session"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .trim()
                    .to_ascii_lowercase();
                let sig = format!(
                    "{}|{}|{}|{}",
                    provider.trim().to_ascii_lowercase(),
                    session,
                    req,
                    resp
                );
                let set = mismatch_seen_by_day.entry(day_key.clone()).or_default();
                if !set.insert(sig) {
                    continue;
                }
            }
            if let Some(bucket_key) =
                Self::compressed_daily_event_bucket_key(&provider, &code, unix_ms_i64)
            {
                let set = compressed_seen_by_day.entry(day_key.clone()).or_default();
                if !set.insert(bucket_key) {
                    continue;
                }
            }
            let Some(day_start_u64) = Self::day_start_unix_ms_from_day_key(&day_key) else {
                continue;
            };
            let Ok(day_start_i64) = i64::try_from(day_start_u64) else {
                continue;
            };
            let entry = by_day.entry(day_key).or_insert_with(|| Counts {
                day_start_unix_ms: day_start_i64,
                total: 0,
                infos: 0,
                warnings: 0,
                errors: 0,
            });
            entry.day_start_unix_ms = day_start_i64;
            entry.total = entry.total.saturating_add(1);
            match level.as_str() {
                "error" => entry.errors = entry.errors.saturating_add(1),
                "warning" => entry.warnings = entry.warnings.saturating_add(1),
                _ => entry.infos = entry.infos.saturating_add(1),
            }
        }

        let mut days: Vec<(String, Counts)> = by_day.into_iter().collect();
        days.sort_by(|a, b| a.0.cmp(&b.0));
        for (day_key, c) in days {
            tx.execute(
                "INSERT INTO event_day_counts(day_key, day_start_unix_ms, total, infos, warnings, errors)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
                params![day_key, c.day_start_unix_ms, c.total, c.infos, c.warnings, c.errors],
            )?;
        }

        tx.execute(
            "INSERT INTO event_meta(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [
                Self::EVENT_DAY_COUNTS_INDEX_VERSION_KEY,
                Self::EVENT_DAY_COUNTS_INDEX_VERSION,
            ],
        )?;
        tx.commit()?;
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
                    id, unix_ms, ingested_at_unix_ms, provider, api_key_ref, model, origin, session_id, node_id, node_name,
                    input_tokens, output_tokens, total_tokens,
                    cache_creation_input_tokens, cache_read_input_tokens
                 ) VALUES(?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, '', '', ?8, ?9, ?10, ?11, ?12)",
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

    pub(crate) fn add_event_at_unix_ms(
        &self,
        provider: &str,
        level: &str,
        code: &str,
        message: &str,
        fields: Value,
        ts: u64,
    ) {
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
        if matches!(
            Self::has_recent_duplicate_event(
                &tx,
                provider,
                level,
                code,
                message,
                &fields_json,
                ts_i64
            ),
            Ok(true)
        ) {
            let _ = tx.rollback();
            return;
        }
        let inserted = tx.execute(
            "INSERT OR REPLACE INTO events(id, unix_ms, provider, level, code, message, fields_json)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, ts_i64, provider, level, code, message, fields_json],
        );
        if inserted.is_err() {
            let _ = tx.rollback();
            return;
        }
        if Self::compressed_daily_event_bucket_key(provider, code, ts_i64).is_some() {
            let exists = tx
                .query_row(
                    "SELECT 1
                     FROM events
                     WHERE id != ?1
                       AND provider = ?2
                       AND code = ?3
                       AND unix_ms >= ?4
                       AND unix_ms < ?5
                     LIMIT 1",
                    params![
                        id,
                        provider,
                        code,
                        (ts_i64 / 60_000) * 60_000,
                        ((ts_i64 / 60_000) + 1) * 60_000
                    ],
                    |_| Ok(()),
                )
                .optional();
            if matches!(exists, Ok(Some(()))) {
                let _ = tx.commit();
                return;
            }
        }
        if Self::upsert_event_day_counts(&tx, &day_key, day_start_unix_ms, level).is_err() {
            let _ = tx.rollback();
            return;
        }
        let _ = tx.commit();
    }

    pub fn add_event(&self, provider: &str, level: &str, code: &str, message: &str, fields: Value) {
        self.add_event_at_unix_ms(provider, level, code, message, fields, unix_ms());
    }

    pub fn record_success(
        &self,
        provider: &str,
        response_obj: &Value,
        context: UsageRequestContext<'_>,
    ) {
        self.record_success_with_model(provider, response_obj, context, None);
    }

    pub fn record_success_with_model(
        &self,
        provider: &str,
        response_obj: &Value,
        context: UsageRequestContext<'_>,
        model_override: Option<&str>,
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
        self.bump_ledger(
            provider,
            1,
            input_tokens,
            output_tokens,
            total_tokens,
            false,
        );
        self.add_usage_request(
            provider,
            &Self::model_for_usage(response_obj, model_override),
            increments,
            context,
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

    pub fn get_quota_snapshot(&self, provider: &str) -> Option<Value> {
        let key = format!("quota:{provider}");
        let raw = self.db.get(key.as_bytes()).ok()??;
        serde_json::from_slice::<Value>(&raw).ok()
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

    pub fn get_session_route_assignment(&self, session_id: &str) -> Option<SessionRouteAssignment> {
        let sid = session_id.trim();
        if sid.is_empty() {
            return None;
        }
        let conn = self.events_db.lock();
        let mut stmt = conn
            .prepare(
                "SELECT session_id, provider, assigned_at_unix_ms
                 FROM session_route_assignments
                 WHERE session_id=?1",
            )
            .ok()?;
        let row = stmt
            .query_row(params![sid], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .optional()
            .ok()
            .flatten()?;
        Some(SessionRouteAssignment {
            session_id: row.0,
            provider: row.1,
            assigned_at_unix_ms: u64::try_from(row.2).unwrap_or(0),
        })
    }

    pub fn list_session_route_assignments_since(
        &self,
        min_assigned_at_unix_ms: u64,
    ) -> Vec<SessionRouteAssignment> {
        let Ok(min_assigned_at_i64) = i64::try_from(min_assigned_at_unix_ms) else {
            return Vec::new();
        };
        let conn = self.events_db.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT session_id, provider, assigned_at_unix_ms
             FROM session_route_assignments
             WHERE assigned_at_unix_ms >= ?1",
        ) else {
            return Vec::new();
        };
        let Ok(rows) = stmt.query_map([min_assigned_at_i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        }) else {
            return Vec::new();
        };
        rows.flatten()
            .map(
                |(session_id, provider, assigned_at_unix_ms)| SessionRouteAssignment {
                    session_id,
                    provider,
                    assigned_at_unix_ms: u64::try_from(assigned_at_unix_ms).unwrap_or(0),
                },
            )
            .collect()
    }

    pub fn put_session_route_assignment(
        &self,
        session_id: &str,
        provider: &str,
        assigned_at_unix_ms: u64,
    ) {
        let sid = session_id.trim();
        let p = provider.trim();
        if sid.is_empty() || p.is_empty() {
            return;
        }
        let Ok(assigned_at_i64) = i64::try_from(assigned_at_unix_ms) else {
            return;
        };
        let conn = self.events_db.lock();
        let _ = conn.execute(
            "INSERT INTO session_route_assignments(session_id, provider, assigned_at_unix_ms)
             VALUES(?1, ?2, ?3)
             ON CONFLICT(session_id) DO UPDATE SET
               provider=excluded.provider,
               assigned_at_unix_ms=excluded.assigned_at_unix_ms",
            params![sid, p, assigned_at_i64],
        );
    }

    pub fn delete_session_route_assignment(&self, session_id: &str) {
        let sid = session_id.trim();
        if sid.is_empty() {
            return;
        }
        let conn = self.events_db.lock();
        let _ = conn.execute(
            "DELETE FROM session_route_assignments WHERE session_id=?1",
            params![sid],
        );
    }

    pub fn delete_session_route_assignments_before(&self, cutoff_unix_ms: u64) -> usize {
        let Ok(cutoff_i64) = i64::try_from(cutoff_unix_ms) else {
            return 0;
        };
        let conn = self.events_db.lock();
        conn.execute(
            "DELETE FROM session_route_assignments WHERE assigned_at_unix_ms < ?1",
            [cutoff_i64],
        )
        .unwrap_or(0)
    }

    pub fn delete_all_session_route_assignments(&self) -> usize {
        let conn = self.events_db.lock();
        conn.execute("DELETE FROM session_route_assignments", [])
            .unwrap_or(0)
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
            "since_last_quota_refresh_requests": 0u64,
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
            let _ = conn.execute(
                "UPDATE spend_days SET provider=?1 WHERE provider=?2",
                params![new, old],
            );
            let _ = conn.execute(
                "UPDATE spend_manual_days SET provider=?1 WHERE provider=?2",
                params![new, old],
            );
        }

        for prefix in ["usage_day:"] {
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
        request_inc: u64,
        input_inc: u64,
        output_inc: u64,
        total_inc: u64,
        flush: bool,
    ) {
        let key = format!("ledger:{provider}");
        let cur = self.get_ledger(provider);
        let next = serde_json::json!({
            "since_last_quota_refresh_requests": cur.get("since_last_quota_refresh_requests").and_then(|v| v.as_u64()).unwrap_or(0) + request_inc,
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

    pub fn list_recent_error_events(&self, max_errors: usize) -> Vec<Value> {
        let error_cap = max_errors.max(1);
        let mut out: Vec<Value> = Vec::with_capacity(error_cap.min(128));
        let conn = self.events_db.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT unix_ms, provider, level, code, message, fields_json
             FROM events
             WHERE level = 'error'
             ORDER BY unix_ms DESC
             LIMIT ?1",
        ) else {
            return out;
        };
        let Ok(rows) = stmt.query_map([error_cap as i64], |row| {
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

    pub fn backfill_usage_request_node_identity(&self, node_id: &str, node_name: &str) -> usize {
        let trimmed_node_id = node_id.trim();
        let trimmed_node_name = node_name.trim();
        if trimmed_node_id.is_empty() || trimmed_node_name.is_empty() {
            return 0;
        }
        let conn = self.events_db.lock();
        conn.execute(
            "UPDATE usage_requests
             SET node_id = ?1, node_name = ?2
             WHERE trim(node_id) = '' OR trim(node_name) = ''",
            params![trimmed_node_id, trimmed_node_name],
        )
        .unwrap_or(0)
    }

    #[cfg(test)]
    pub fn list_usage_requests(&self, limit: usize) -> Vec<Value> {
        let mut out: Vec<Value> = Vec::with_capacity(limit.min(1024));
        let conn = self.events_db.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT id, provider, api_key_ref, model, origin, session_id, unix_ms, node_id, node_name,
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
                "id": row.get::<_, String>(0)?,
                "provider": row.get::<_, String>(1)?,
                "api_key_ref": row.get::<_, String>(2)?,
                "model": row.get::<_, String>(3)?,
                "origin": row.get::<_, String>(4)?,
                "session_id": row.get::<_, String>(5)?,
                "unix_ms": u64::try_from(row.get::<_, i64>(6)?).unwrap_or(0),
                "node_id": row.get::<_, String>(7)?,
                "node_name": row.get::<_, String>(8)?,
                "input_tokens": u64::try_from(row.get::<_, i64>(9)?).unwrap_or(0),
                "output_tokens": u64::try_from(row.get::<_, i64>(10)?).unwrap_or(0),
                "total_tokens": u64::try_from(row.get::<_, i64>(11)?).unwrap_or(0),
                "cache_creation_input_tokens": u64::try_from(row.get::<_, i64>(12)?).unwrap_or(0),
                "cache_read_input_tokens": u64::try_from(row.get::<_, i64>(13)?).unwrap_or(0),
            }))
        }) else {
            return out;
        };
        for row in rows.flatten() {
            out.push(row);
        }
        out
    }

    pub fn list_usage_request_sync_batch(
        &self,
        after_ingested_at_unix_ms: u64,
        after_id: Option<&str>,
        limit: usize,
    ) -> (Vec<UsageRequestSyncRow>, bool) {
        let mut out = Vec::with_capacity(limit.min(128));
        let after_ingested_i64 = i64::try_from(after_ingested_at_unix_ms).unwrap_or(i64::MAX);
        let after_id = after_id.unwrap_or_default().trim();
        let conn = self.events_db.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT
                id,
                unix_ms,
                ingested_at_unix_ms,
                provider,
                api_key_ref,
                model,
                origin,
                session_id,
                node_id,
                node_name,
                input_tokens,
                output_tokens,
                total_tokens,
                cache_creation_input_tokens,
                cache_read_input_tokens
             FROM usage_requests
             WHERE ingested_at_unix_ms > ?1
                OR (ingested_at_unix_ms = ?1 AND id > ?2)
             ORDER BY ingested_at_unix_ms ASC, id ASC
             LIMIT ?3",
        ) else {
            return (out, false);
        };
        let fetch_limit = limit.saturating_add(1);
        let Ok(rows) = stmt.query_map(
            params![
                after_ingested_i64,
                after_id,
                i64::try_from(fetch_limit).unwrap_or(i64::MAX)
            ],
            |row| {
                Ok(UsageRequestSyncRow {
                    id: row.get::<_, String>(0)?,
                    unix_ms: u64::try_from(row.get::<_, i64>(1)?).unwrap_or(0),
                    ingested_at_unix_ms: u64::try_from(row.get::<_, i64>(2)?).unwrap_or(0),
                    provider: row.get::<_, String>(3)?,
                    api_key_ref: row.get::<_, String>(4)?,
                    model: row.get::<_, String>(5)?,
                    origin: row.get::<_, String>(6)?,
                    session_id: row.get::<_, String>(7)?,
                    node_id: row.get::<_, String>(8)?,
                    node_name: row.get::<_, String>(9)?,
                    input_tokens: u64::try_from(row.get::<_, i64>(10)?).unwrap_or(0),
                    output_tokens: u64::try_from(row.get::<_, i64>(11)?).unwrap_or(0),
                    total_tokens: u64::try_from(row.get::<_, i64>(12)?).unwrap_or(0),
                    cache_creation_input_tokens: u64::try_from(row.get::<_, i64>(13)?).unwrap_or(0),
                    cache_read_input_tokens: u64::try_from(row.get::<_, i64>(14)?).unwrap_or(0),
                })
            },
        ) else {
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

    pub fn upsert_usage_request_sync_rows(&self, rows: &[UsageRequestSyncRow]) -> usize {
        if rows.is_empty() {
            return 0;
        }
        let mut conn = self.events_db.lock();
        let Ok(tx) = conn.transaction() else {
            return 0;
        };
        let mut inserted = 0usize;
        for row in rows {
            let Ok(changed) = tx.execute(
                "INSERT OR IGNORE INTO usage_requests(
                    id, unix_ms, ingested_at_unix_ms, provider, api_key_ref, model, origin, session_id,
                    node_id, node_name, input_tokens, output_tokens, total_tokens,
                    cache_creation_input_tokens, cache_read_input_tokens
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                params![
                    row.id,
                    i64::try_from(row.unix_ms).unwrap_or(i64::MAX),
                    i64::try_from(row.ingested_at_unix_ms).unwrap_or(i64::MAX),
                    row.provider,
                    row.api_key_ref,
                    row.model,
                    row.origin,
                    row.session_id,
                    row.node_id,
                    row.node_name,
                    i64::try_from(row.input_tokens).unwrap_or(i64::MAX),
                    i64::try_from(row.output_tokens).unwrap_or(i64::MAX),
                    i64::try_from(row.total_tokens).unwrap_or(i64::MAX),
                    i64::try_from(row.cache_creation_input_tokens).unwrap_or(i64::MAX),
                    i64::try_from(row.cache_read_input_tokens).unwrap_or(i64::MAX),
                ],
            ) else {
                let _ = tx.rollback();
                return inserted;
            };
            inserted = inserted.saturating_add(changed);
        }
        if tx.commit().is_err() {
            return 0;
        }
        inserted
    }

    #[allow(clippy::too_many_arguments)]
    pub fn list_usage_requests_page(
        &self,
        since_unix_ms: u64,
        from_unix_ms: Option<u64>,
        to_unix_ms: Option<u64>,
        nodes: &[String],
        providers: &[String],
        models: &[String],
        origins: &[String],
        sessions: &[String],
        limit: usize,
        offset: usize,
    ) -> (Vec<Value>, bool) {
        let mut sql = String::from(
            "SELECT id, provider, api_key_ref, model, origin, session_id, unix_ms, node_id, node_name,
                    input_tokens, output_tokens, total_tokens,
                    cache_creation_input_tokens, cache_read_input_tokens
             FROM usage_requests
             WHERE unix_ms >= COALESCE(?, ?)
               AND (? IS NULL OR unix_ms < ?)",
        );
        let from_i64 = from_unix_ms.and_then(|x| i64::try_from(x).ok());
        let to_i64 = to_unix_ms.and_then(|x| i64::try_from(x).ok());
        let mut params: Vec<rusqlite::types::Value> = vec![
            from_i64
                .map(rusqlite::types::Value::Integer)
                .unwrap_or(rusqlite::types::Value::Null),
            rusqlite::types::Value::Integer(i64::try_from(since_unix_ms).unwrap_or(i64::MAX)),
            to_i64
                .map(rusqlite::types::Value::Integer)
                .unwrap_or(rusqlite::types::Value::Null),
            to_i64
                .map(rusqlite::types::Value::Integer)
                .unwrap_or(rusqlite::types::Value::Null),
        ];

        if !providers.is_empty() {
            let placeholders = vec!["?"; providers.len()].join(", ");
            sql.push_str(&format!(" AND lower(provider) IN ({placeholders})"));
            for provider in providers {
                params.push(rusqlite::types::Value::Text(
                    provider.trim().to_ascii_lowercase(),
                ));
            }
        }
        if !nodes.is_empty() {
            let placeholders = vec!["?"; nodes.len()].join(", ");
            sql.push_str(&format!(" AND lower(CASE WHEN trim(node_name) = '' THEN 'Local' ELSE node_name END) IN ({placeholders})"));
            for node in nodes {
                params.push(rusqlite::types::Value::Text(
                    node.trim().to_ascii_lowercase(),
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
        if !sessions.is_empty() {
            let placeholders = vec!["?"; sessions.len()].join(", ");
            sql.push_str(&format!(" AND lower(session_id) IN ({placeholders})"));
            for session in sessions {
                params.push(rusqlite::types::Value::Text(
                    session.trim().to_ascii_lowercase(),
                ));
            }
        }
        sql.push_str(" ORDER BY unix_ms DESC, id DESC LIMIT ? OFFSET ?");
        params.push(rusqlite::types::Value::Integer(
            i64::try_from(limit.saturating_add(1)).unwrap_or(i64::MAX),
        ));
        params.push(rusqlite::types::Value::Integer(
            i64::try_from(offset).unwrap_or(i64::MAX),
        ));

        self.with_events_read_conn(|conn| {
            let mut out: Vec<Value> = Vec::with_capacity(limit.min(1024));
            let Ok(mut stmt) = conn.prepare(&sql) else {
                return (out, false);
            };
            let Ok(rows) = stmt.query_map(params_from_iter(params.iter()), |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "provider": row.get::<_, String>(1)?,
                    "api_key_ref": row.get::<_, String>(2)?,
                    "model": row.get::<_, String>(3)?,
                    "origin": row.get::<_, String>(4)?,
                    "session_id": row.get::<_, String>(5)?,
                    "unix_ms": u64::try_from(row.get::<_, i64>(6)?).unwrap_or(0),
                    "node_id": row.get::<_, String>(7)?,
                    "node_name": row.get::<_, String>(8)?,
                    "input_tokens": u64::try_from(row.get::<_, i64>(9)?).unwrap_or(0),
                    "output_tokens": u64::try_from(row.get::<_, i64>(10)?).unwrap_or(0),
                    "total_tokens": u64::try_from(row.get::<_, i64>(11)?).unwrap_or(0),
                    "cache_creation_input_tokens": u64::try_from(row.get::<_, i64>(12)?).unwrap_or(0),
                    "cache_read_input_tokens": u64::try_from(row.get::<_, i64>(13)?).unwrap_or(0),
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
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn summarize_usage_requests(
        &self,
        since_unix_ms: u64,
        from_unix_ms: Option<u64>,
        to_unix_ms: Option<u64>,
        nodes: &[String],
        providers: &[String],
        models: &[String],
        origins: &[String],
        sessions: &[String],
    ) -> (u64, u64, u64, u64, u64, u64) {
        let mut sql = String::from(
            "SELECT
                COUNT(*),
                COALESCE(SUM(input_tokens), 0),
                COALESCE(SUM(output_tokens), 0),
                COALESCE(SUM(total_tokens), 0),
                COALESCE(SUM(cache_creation_input_tokens), 0),
                COALESCE(SUM(cache_read_input_tokens), 0)
             FROM usage_requests
             WHERE unix_ms >= COALESCE(?, ?)
               AND (? IS NULL OR unix_ms < ?)",
        );
        let from_i64 = from_unix_ms.and_then(|x| i64::try_from(x).ok());
        let to_i64 = to_unix_ms.and_then(|x| i64::try_from(x).ok());
        let mut params: Vec<rusqlite::types::Value> = vec![
            from_i64
                .map(rusqlite::types::Value::Integer)
                .unwrap_or(rusqlite::types::Value::Null),
            rusqlite::types::Value::Integer(i64::try_from(since_unix_ms).unwrap_or(i64::MAX)),
            to_i64
                .map(rusqlite::types::Value::Integer)
                .unwrap_or(rusqlite::types::Value::Null),
            to_i64
                .map(rusqlite::types::Value::Integer)
                .unwrap_or(rusqlite::types::Value::Null),
        ];
        if !providers.is_empty() {
            let placeholders = vec!["?"; providers.len()].join(", ");
            sql.push_str(&format!(" AND lower(provider) IN ({placeholders})"));
            for provider in providers {
                params.push(rusqlite::types::Value::Text(
                    provider.trim().to_ascii_lowercase(),
                ));
            }
        }
        if !nodes.is_empty() {
            let placeholders = vec!["?"; nodes.len()].join(", ");
            sql.push_str(&format!(" AND lower(CASE WHEN trim(node_name) = '' THEN 'Local' ELSE node_name END) IN ({placeholders})"));
            for node in nodes {
                params.push(rusqlite::types::Value::Text(
                    node.trim().to_ascii_lowercase(),
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
        if !sessions.is_empty() {
            let placeholders = vec!["?"; sessions.len()].join(", ");
            sql.push_str(&format!(" AND lower(session_id) IN ({placeholders})"));
            for session in sessions {
                params.push(rusqlite::types::Value::Text(
                    session.trim().to_ascii_lowercase(),
                ));
            }
        }
        self.with_events_read_conn(|conn| {
            let Ok(mut stmt) = conn.prepare(&sql) else {
                return (0, 0, 0, 0, 0, 0);
            };
            let Ok(row) = stmt.query_row(params_from_iter(params.iter()), |row| {
                Ok((
                    u64::try_from(row.get::<_, i64>(0)?).unwrap_or(0),
                    u64::try_from(row.get::<_, i64>(1)?).unwrap_or(0),
                    u64::try_from(row.get::<_, i64>(2)?).unwrap_or(0),
                    u64::try_from(row.get::<_, i64>(3)?).unwrap_or(0),
                    u64::try_from(row.get::<_, i64>(4)?).unwrap_or(0),
                    u64::try_from(row.get::<_, i64>(5)?).unwrap_or(0),
                ))
            }) else {
                return (0, 0, 0, 0, 0, 0);
            };
            row
        })
    }

    pub fn summarize_usage_requests_since_by_provider(
        &self,
        provider: &str,
        since_unix_ms: u64,
    ) -> (u64, u64) {
        let provider = provider.trim().to_ascii_lowercase();
        if provider.is_empty() {
            return (0, 0);
        }
        let Some(since_dt) = Local.timestamp_millis_opt(since_unix_ms as i64).single() else {
            return (0, 0);
        };
        let since_day_key = since_dt.format("%Y-%m-%d").to_string();
        let since_i64 = i64::try_from(since_unix_ms).unwrap_or(i64::MAX);
        self.with_events_read_conn(|conn| {
            let aggregate = conn
                .query_row(
                    "SELECT
                        COALESCE(SUM(request_count), 0),
                        COALESCE(SUM(total_tokens), 0)
                     FROM usage_request_day_provider_totals
                     WHERE lower(provider) = ?1
                       AND day_key > ?2",
                    params![provider, since_day_key],
                    |row| {
                        Ok((
                            u64::try_from(row.get::<_, i64>(0)?).unwrap_or(0),
                            u64::try_from(row.get::<_, i64>(1)?).unwrap_or(0),
                        ))
                    },
                )
                .unwrap_or((0, 0));
            let partial = conn
                .query_row(
                    "SELECT
                        COUNT(*),
                        COALESCE(SUM(total_tokens), 0)
                     FROM usage_requests
                     WHERE lower(provider) = ?1
                       AND unix_ms >= ?2
                       AND strftime('%Y-%m-%d', unix_ms / 1000, 'unixepoch', 'localtime') = ?3",
                    params![provider, since_i64, since_day_key],
                    |row| {
                        Ok((
                            u64::try_from(row.get::<_, i64>(0)?).unwrap_or(0),
                            u64::try_from(row.get::<_, i64>(1)?).unwrap_or(0),
                        ))
                    },
                )
                .unwrap_or((0, 0));
            (
                aggregate.0.saturating_add(partial.0),
                aggregate.1.saturating_add(partial.1),
            )
        })
    }

    pub fn list_usage_request_daily_totals(
        &self,
        day_limit: usize,
    ) -> Vec<(String, String, u64, u64, u64, u64)> {
        self.with_events_read_conn(|conn| {
            let mut out: Vec<(String, String, u64, u64, u64, u64)> = Vec::new();
            let limit = day_limit.clamp(1, 180);
            let Ok(mut stmt) = conn.prepare(
                "WITH latest_days AS (
                    SELECT day_key
                    FROM usage_request_day_provider_totals
                    GROUP BY day_key
                    ORDER BY day_key DESC
                    LIMIT ?1
                 )
                 SELECT
                   u.day_key,
                   u.provider,
                   u.total_tokens,
                   u.request_count,
                   u.windows_request_count,
                   u.wsl_request_count
                 FROM usage_request_day_provider_totals u
                 JOIN latest_days d ON d.day_key = u.day_key
                 ORDER BY u.day_key ASC, u.total_tokens DESC",
            ) else {
                return out;
            };
            let Ok(rows) = stmt.query_map([i64::try_from(limit).unwrap_or(45)], |row| {
                let day_key = row.get::<_, String>(0)?;
                let provider = row.get::<_, String>(1)?;
                let total_tokens = u64::try_from(row.get::<_, i64>(2)?).unwrap_or(0);
                let request_count = u64::try_from(row.get::<_, i64>(3)?).unwrap_or(0);
                let windows_request_count = u64::try_from(row.get::<_, i64>(4)?).unwrap_or(0);
                let wsl_request_count = u64::try_from(row.get::<_, i64>(5)?).unwrap_or(0);
                Ok((
                    day_key,
                    provider,
                    total_tokens,
                    request_count,
                    windows_request_count,
                    wsl_request_count,
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

        {
            let mut conn = self.events_db.lock();
            let Ok(tx) = conn.transaction() else {
                return updated;
            };
            let mut spend_days: Vec<(String, i64, String)> = Vec::new();
            {
                let Ok(mut stmt) = tx.prepare(
                    "SELECT provider, day_started_at_unix_ms, row_json
                     FROM spend_days",
                ) else {
                    return updated;
                };
                let Ok(rows) = stmt.query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                }) else {
                    return updated;
                };
                for row in rows.flatten() {
                    spend_days.push(row);
                }
            }
            for (provider, day_started_at_unix_ms, row_json) in spend_days {
                let Ok(mut row) = serde_json::from_str::<Value>(&row_json) else {
                    continue;
                };
                if has_key_ref(&row) {
                    continue;
                }
                let key_ref = provider_api_key_ref
                    .get(provider.trim())
                    .cloned()
                    .unwrap_or_else(|| "-".to_string());
                row["api_key_ref"] = serde_json::json!(key_ref);
                let Ok(next_row_json) = serde_json::to_string(&row) else {
                    continue;
                };
                let _ = tx.execute(
                    "UPDATE spend_days
                     SET row_json=?1
                     WHERE provider=?2 AND day_started_at_unix_ms=?3",
                    params![next_row_json, provider, day_started_at_unix_ms],
                );
                updated = updated.saturating_add(1);
            }
            let _ = tx.commit();
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
