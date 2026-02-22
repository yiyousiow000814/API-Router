#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn list_events_reads_latest_without_full_scan() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();

        {
            let conn = store.events_db.lock();
            conn.execute(
                "INSERT INTO events(id, unix_ms, provider, level, code, message, fields_json)
                 VALUES ('a', 1000, 'p1', 'info', 'test_event', 'hello', '{}')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO events(id, unix_ms, provider, level, code, message, fields_json)
                 VALUES ('c', 3000, 'p1', 'info', 'test_event', 'hello', '{}')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO events(id, unix_ms, provider, level, code, message, fields_json)
                 VALUES ('b', 2000, 'p1', 'info', 'test_event', 'hello', '{}')",
                [],
            )
            .unwrap();
        }

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

    #[test]
    fn model_for_usage_prefers_non_empty_override() {
        let response = serde_json::json!({
            "model": "gpt-5.3-codex"
        });
        assert_eq!(
            Store::model_for_usage(&response, Some("gpt-5.2-2025-12-11")),
            "gpt-5.2-2025-12-11"
        );
        assert_eq!(
            Store::model_for_usage(&response, Some("   ")),
            "gpt-5.3-codex"
        );
    }

    #[test]
    fn add_event_updates_daily_materialized_index() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();

        store.add_event("p1", "warning", "test_event", "hello", serde_json::json!({}));
        let rows = store.list_event_daily_counts_range(None, None);
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.get("total").and_then(|v| v.as_u64()), Some(1));
        assert_eq!(row.get("infos").and_then(|v| v.as_u64()), Some(0));
        assert_eq!(row.get("warnings").and_then(|v| v.as_u64()), Some(1));
        assert_eq!(row.get("errors").and_then(|v| v.as_u64()), Some(0));
    }

    #[test]
    fn reopening_store_backfills_daily_index_from_events() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();

        let day1 = chrono::Local
            .with_ymd_and_hms(2025, 6, 1, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis() as u64;
        let day2 = chrono::Local
            .with_ymd_and_hms(2025, 6, 2, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis() as u64;
        let mk = |ts: u64, id: &str| format!("event:{ts}:{id}");
        let payload = |ts: u64, level: &str| {
            serde_json::json!({
                "provider": "p1",
                "level": level,
                "unix_ms": ts,
                "code": "test_event",
                "message": "hello",
                "fields": serde_json::json!({}),
            })
        };

        let _ = store.db.insert(
            mk(day1, "a").as_bytes(),
            serde_json::to_vec(&payload(day1, "info")).unwrap(),
        );
        let _ = store.db.insert(
            mk(day1 + 1, "b").as_bytes(),
            serde_json::to_vec(&payload(day1 + 1, "error")).unwrap(),
        );
        let _ = store.db.insert(
            mk(day2, "c").as_bytes(),
            serde_json::to_vec(&payload(day2, "warning")).unwrap(),
        );
        {
            let conn = store.events_db.lock();
            conn.execute(
                "UPDATE event_meta SET value='0' WHERE key=?1",
                [Store::EVENTS_SQLITE_MIGRATED_FROM_SLED_KEY],
            )
            .unwrap();
        }
        store.db.flush().unwrap();
        drop(store);

        let store = Store::open(tmp.path()).unwrap();
        let rows = store.list_event_daily_counts_range(None, None);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].get("total").and_then(|v| v.as_u64()), Some(2));
        assert_eq!(rows[0].get("infos").and_then(|v| v.as_u64()), Some(1));
        assert_eq!(rows[0].get("errors").and_then(|v| v.as_u64()), Some(1));
        assert_eq!(rows[1].get("warnings").and_then(|v| v.as_u64()), Some(1));
    }

    #[test]
    fn legacy_sqlite_merge_runs_once_even_if_legacy_file_remains() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let sled_dir = root.join("sled");
        std::fs::create_dir_all(&sled_dir).unwrap();

        let canonical_sqlite = root.join("events.sqlite3");
        let legacy_sqlite = sled_dir.join("events.sqlite3");

        {
            let conn = rusqlite::Connection::open(&canonical_sqlite).unwrap();
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
                CREATE TABLE IF NOT EXISTS event_day_counts(
                  day_key TEXT PRIMARY KEY,
                  day_start_unix_ms INTEGER NOT NULL,
                  total INTEGER NOT NULL,
                  infos INTEGER NOT NULL,
                  warnings INTEGER NOT NULL,
                  errors INTEGER NOT NULL
                );
                ",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO event_meta(key, value) VALUES('schema_version', ?1)",
                [Store::EVENTS_SQLITE_SCHEMA_VERSION],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO event_meta(key, value) VALUES(?1, '0')",
                [Store::EVENTS_SQLITE_MERGED_LEGACY_SQLITE_KEY],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO events(id, unix_ms, provider, level, code, message, fields_json)
                 VALUES ('canonical-a', 1000, 'p1', 'info', 'test_event', 'canonical', '{}')",
                [],
            )
            .unwrap();
        }

        {
            let conn = rusqlite::Connection::open(&legacy_sqlite).unwrap();
            conn.execute_batch(
                "
                CREATE TABLE IF NOT EXISTS events(
                  id TEXT PRIMARY KEY,
                  unix_ms INTEGER NOT NULL,
                  provider TEXT NOT NULL,
                  level TEXT NOT NULL,
                  code TEXT NOT NULL,
                  message TEXT NOT NULL,
                  fields_json TEXT NOT NULL
                );
                ",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO events(id, unix_ms, provider, level, code, message, fields_json)
                 VALUES ('legacy-a', 2000, 'p1', 'warning', 'test_event', 'legacy-a', '{}')",
                [],
            )
            .unwrap();
        }

        let store = Store::open(&sled_dir).unwrap();
        assert_eq!(store.list_events_range(None, None, Some(10)).len(), 2);
        drop(store);

        {
            let conn = rusqlite::Connection::open(&legacy_sqlite).unwrap();
            conn.execute(
                "INSERT INTO events(id, unix_ms, provider, level, code, message, fields_json)
                 VALUES ('legacy-b', 3000, 'p1', 'error', 'test_event', 'legacy-b', '{}')",
                [],
            )
            .unwrap();
        }

        let store = Store::open(&sled_dir).unwrap();
        let events = store.list_events_range(None, None, Some(10));
        assert_eq!(events.len(), 2);
        assert!(events
            .iter()
            .any(|event| event.get("message").and_then(|v| v.as_str()) == Some("legacy-a")));
        assert!(!events
            .iter()
            .any(|event| event.get("message").and_then(|v| v.as_str()) == Some("legacy-b")));
    }

    #[test]
    fn list_usage_requests_page_is_stable_on_same_timestamp() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();
        let ts = chrono::Local
            .with_ymd_and_hms(2026, 2, 21, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis();

        {
            let conn = store.events_db.lock();
            conn.execute(
                "INSERT INTO usage_requests(
                    id, unix_ms, provider, api_key_ref, model, origin, session_id,
                    input_tokens, output_tokens, total_tokens, cache_creation_input_tokens, cache_read_input_tokens
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, 100, 10, 110, 0, 0)",
                rusqlite::params![
                    "00000000-0000-0000-0000-000000000001",
                    ts,
                    "provider_a",
                    "-",
                    "gpt-5.2-codex",
                    "windows",
                    "session_a"
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO usage_requests(
                    id, unix_ms, provider, api_key_ref, model, origin, session_id,
                    input_tokens, output_tokens, total_tokens, cache_creation_input_tokens, cache_read_input_tokens
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, 200, 20, 220, 0, 0)",
                rusqlite::params![
                    "00000000-0000-0000-0000-000000000002",
                    ts,
                    "provider_b",
                    "-",
                    "gpt-5.2-codex",
                    "windows",
                    "session_b"
                ],
            )
            .unwrap();
        }

        let (page1, has_more1) =
            store.list_usage_requests_page(0, None, None, &[], &[], &[], &[], 1, 0);
        let (page2, has_more2) =
            store.list_usage_requests_page(0, None, None, &[], &[], &[], &[], 1, 1);
        assert_eq!(page1.len(), 1);
        assert_eq!(page2.len(), 1);
        assert!(has_more1);
        assert!(!has_more2);

        let provider1 = page1[0]
            .get("provider")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let provider2 = page2[0]
            .get("provider")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        assert_eq!(provider1, "provider_b");
        assert_eq!(provider2, "provider_a");
    }

    #[test]
    fn list_usage_request_daily_totals_aggregates_and_limits_days() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();
        let day1 = chrono::Local
            .with_ymd_and_hms(2026, 2, 19, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis();
        let day2 = chrono::Local
            .with_ymd_and_hms(2026, 2, 20, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis();
        let day3 = chrono::Local
            .with_ymd_and_hms(2026, 2, 21, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis();

        {
            let conn = store.events_db.lock();
            let insert = |id: &str, ts: i64, provider: &str, total: i64| {
                conn.execute(
                    "INSERT INTO usage_requests(
                        id, unix_ms, provider, api_key_ref, model, origin, session_id,
                        input_tokens, output_tokens, total_tokens, cache_creation_input_tokens, cache_read_input_tokens
                     ) VALUES(?1, ?2, ?3, '-', 'gpt-5.2-codex', 'windows', 's', ?4, 0, ?4, 0, 0)",
                    rusqlite::params![id, ts, provider, total],
                )
                .unwrap();
            };
            insert("id-1", day1, "official", 100);
            insert("id-2", day1 + 1_000, "provider_1", 200);
            insert("id-3", day2, "official", 300);
            insert("id-4", day3, "provider_1", 400);
            insert("id-5", day3 + 1_000, "provider_2", 500);
        }

        let out = store.list_usage_request_daily_totals(2);
        assert!(!out.is_empty());
        let day_keys: Vec<String> = out
            .iter()
            .map(|(day, _, _, _, _, _)| day.clone())
            .collect();
        assert!(day_keys.iter().all(|k| k.as_str() >= "2026-02-20"));
        assert!(day_keys.iter().all(|k| k.as_str() <= "2026-02-21"));
        assert!(!day_keys.iter().any(|k| k == "2026-02-19"));

        let sum_2026_02_21: u64 = out
            .iter()
            .filter(|(day, _, _, _, _, _)| day == "2026-02-21")
            .map(|(_, _, total, _, _, _)| *total)
            .sum();
        let sum_2026_02_20: u64 = out
            .iter()
            .filter(|(day, _, _, _, _, _)| day == "2026-02-20")
            .map(|(_, _, total, _, _, _)| *total)
            .sum();
        assert_eq!(sum_2026_02_21, 900);
        assert_eq!(sum_2026_02_20, 300);

        let req_2026_02_21: u64 = out
            .iter()
            .filter(|(day, _, _, _, _, _)| day == "2026-02-21")
            .map(|(_, _, _, request_count, _, _)| *request_count)
            .sum();
        assert_eq!(req_2026_02_21, 2);
    }

    #[test]
    fn list_usage_requests_page_supports_day_range() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();
        let day1 = chrono::Local
            .with_ymd_and_hms(2026, 2, 19, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis();
        let day2 = chrono::Local
            .with_ymd_and_hms(2026, 2, 20, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis();

        {
            let conn = store.events_db.lock();
            let insert = |id: &str, ts: i64| {
                conn.execute(
                    "INSERT INTO usage_requests(
                        id, unix_ms, provider, api_key_ref, model, origin, session_id,
                        input_tokens, output_tokens, total_tokens, cache_creation_input_tokens, cache_read_input_tokens
                     ) VALUES(?1, ?2, 'official', '-', 'gpt-5.2-codex', 'windows', 's', 10, 1, 11, 0, 0)",
                    rusqlite::params![id, ts],
                )
                .unwrap();
            };
            insert("id-a", day1);
            insert("id-b", day2);
        }

        let day1_start = chrono::Local
            .with_ymd_and_hms(2026, 2, 19, 0, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis() as u64;
        let day1_end = chrono::Local
            .with_ymd_and_hms(2026, 2, 20, 0, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis() as u64;

        let (rows, has_more) = store.list_usage_requests_page(
            // Simulate a narrow "recent hours" window that would exclude day1 unless
            // from/to date range takes precedence.
            day2 as u64,
            Some(day1_start),
            Some(day1_end),
            &[],
            &[],
            &[],
            &[],
            50,
            0,
        );
        assert!(!has_more);
        assert_eq!(rows.len(), 1);
        let unix_ms = rows[0].get("unix_ms").and_then(|v| v.as_u64()).unwrap_or(0);
        assert!(unix_ms >= day1_start && unix_ms < day1_end);
    }

    #[test]
    fn summarize_usage_requests_is_not_limited_by_page_size() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();
        let day = chrono::Local
            .with_ymd_and_hms(2026, 2, 22, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis();
        let day_start = chrono::Local
            .with_ymd_and_hms(2026, 2, 22, 0, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis() as u64;
        let day_end = chrono::Local
            .with_ymd_and_hms(2026, 2, 23, 0, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis() as u64;

        {
            let conn = store.events_db.lock();
            for i in 0..3 {
                conn.execute(
                    "INSERT INTO usage_requests(
                        id, unix_ms, provider, api_key_ref, model, origin, session_id,
                        input_tokens, output_tokens, total_tokens, cache_creation_input_tokens, cache_read_input_tokens
                    ) VALUES(?1, ?2, 'official', '-', 'gpt-5.2-codex', 'wsl2', 's1', 100, 10, 110, 0, 0)",
                    rusqlite::params![format!("id-{i}"), day + i * 1000],
                )
                .unwrap();
            }
        }

        let (requests, input, output, total, cache_create, cache_read) = store
            .summarize_usage_requests(
                0,
                Some(day_start),
                Some(day_end),
                &[],
                &[],
                &[],
                &[],
            );
        assert_eq!(requests, 3);
        assert_eq!(input, 300);
        assert_eq!(output, 30);
        assert_eq!(total, 330);
        assert_eq!(cache_create, 0);
        assert_eq!(cache_read, 0);
    }
}
