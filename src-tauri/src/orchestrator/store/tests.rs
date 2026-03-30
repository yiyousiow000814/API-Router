#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn list_events_range_reads_latest_without_full_scan() {
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

        let out = store.list_events_range(None, None, Some(2));
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].get("unix_ms").and_then(|v| v.as_u64()), Some(3000));
        assert_eq!(out[1].get("unix_ms").and_then(|v| v.as_u64()), Some(2000));
    }

    #[test]
    fn list_recent_error_events_is_not_limited_by_latest_all_events_window() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();

        {
            let conn = store.events_db.lock();
            conn.execute(
                "INSERT INTO events(id, unix_ms, provider, level, code, message, fields_json)
                 VALUES ('err-old-a', 10, 'p1', 'error', 'test_event', 'old-a', '{}')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO events(id, unix_ms, provider, level, code, message, fields_json)
                 VALUES ('err-old-b', 20, 'p1', 'error', 'test_event', 'old-b', '{}')",
                [],
            )
            .unwrap();
            for i in 0..300 {
                let id = format!("info-{i}");
                conn.execute(
                    "INSERT INTO events(id, unix_ms, provider, level, code, message, fields_json)
                     VALUES (?1, ?2, 'p1', 'info', 'test_event', 'noise', '{}')",
                    rusqlite::params![id, 1_000_i64 + i],
                )
                .unwrap();
            }
        }

        let out = store.list_recent_error_events(2);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].get("message").and_then(|v| v.as_str()), Some("old-b"));
        assert_eq!(out[1].get("message").and_then(|v| v.as_str()), Some("old-a"));
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
    fn model_mismatch_versioned_variants_do_not_pollute_daily_counts() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();

        // Insert raw events (simulating legacy polluted history).
        {
            let conn = store.events_db.lock();
            conn.execute(
                "INSERT INTO events(id, unix_ms, provider, level, code, message, fields_json)
                 VALUES ('m1', 1_700_000_000_000, 'p1', 'warning', 'routing.model_mismatch', 'x', ?1)",
                [r#"{"requested_model":"gpt-5.2","response_model":"gpt-5.2-2025-12-11"}"#],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO events(id, unix_ms, provider, level, code, message, fields_json)
                 VALUES ('m2', 1_700_000_000_100, 'p1', 'warning', 'routing.model_mismatch', 'y', ?1)",
                [r#"{"requested_model":"gpt-5.2","response_model":"gpt-5.3-codex"}"#],
            )
            .unwrap();
            // Duplicate spam of the same mismatch should only count once per day after rebuild.
            conn.execute(
                "INSERT INTO events(id, unix_ms, provider, level, code, message, fields_json)
                 VALUES ('m3', 1_700_000_000_200, 'p1', 'warning', 'routing.model_mismatch', 'x2', ?1)",
                [r#"{"requested_model":"gpt-5.2","response_model":"gpt-5.2-2025-12-11"}"#],
            )
            .unwrap();
            // Force rebuild even if Store::open already ran it.
            conn.execute(
                "INSERT INTO event_meta(key, value) VALUES(?1, '0')
                 ON CONFLICT(key) DO UPDATE SET value='0'",
                [Store::EVENT_DAY_COUNTS_INDEX_VERSION_KEY],
            )
            .unwrap();
        }

        store.rebuild_event_day_counts_index_if_needed().unwrap();
        let rows = store.list_event_daily_counts_range(None, None);
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        // Dedupe duplicates: (gpt-5.2 -> gpt-5.2-2025-12-11) counts once, and the real mismatch counts once.
        assert_eq!(row.get("total").and_then(|v| v.as_u64()), Some(2));
        assert_eq!(row.get("warnings").and_then(|v| v.as_u64()), Some(2));
    }

    #[test]
    fn list_session_route_assignments_since_filters_old_rows() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();

        store.put_session_route_assignment("s-old", "p1", 1_000);
        store.put_session_route_assignment("s-new", "p2", 2_000);

        let rows = store.list_session_route_assignments_since(1_500);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "s-new");
        assert_eq!(rows[0].provider, "p2");
    }

    #[test]
    fn delete_session_route_assignments_before_removes_old_rows() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();

        store.put_session_route_assignment("s1", "p1", 1_000);
        store.put_session_route_assignment("s2", "p1", 2_000);
        store.put_session_route_assignment("s3", "p2", 3_000);

        let deleted = store.delete_session_route_assignments_before(2_500);
        assert_eq!(deleted, 2);

        let rows = store.list_session_route_assignments_since(0);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "s3");
    }

    #[test]
    fn delete_all_session_route_assignments_removes_every_row() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();

        store.put_session_route_assignment("s1", "p1", 1_000);
        store.put_session_route_assignment("s2", "p2", 2_000);

        let deleted = store.delete_all_session_route_assignments();
        assert_eq!(deleted, 2);
        assert!(store.list_session_route_assignments_since(0).is_empty());
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
            store.list_usage_requests_page(0, None, None, &[], &[], &[], &[], &[], 1, 0);
        let (page2, has_more2) =
            store.list_usage_requests_page(0, None, None, &[], &[], &[], &[], &[], 1, 1);
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
    fn rename_provider_keeps_daily_totals_index_in_sync() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();
        let day = chrono::Local
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
                 ) VALUES(?1, ?2, 'provider_old', '-', 'gpt-5.2-codex', 'windows', 's1', 100, 10, 110, 0, 0)",
                rusqlite::params!["rename-id-1", day],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO usage_requests(
                    id, unix_ms, provider, api_key_ref, model, origin, session_id,
                    input_tokens, output_tokens, total_tokens, cache_creation_input_tokens, cache_read_input_tokens
                 ) VALUES(?1, ?2, 'provider_new', '-', 'gpt-5.2-codex', 'wsl2', 's2', 200, 20, 220, 0, 0)",
                rusqlite::params!["rename-id-2", day + 1_000],
            )
            .unwrap();
        }

        store.rename_provider("provider_old", "provider_new");
        let out = store.list_usage_request_daily_totals(5);

        assert!(
            !out.iter()
                .any(|(_, provider, _, _, _, _)| provider == "provider_old")
        );

        let merged = out
            .iter()
            .find(|(day_key, provider, _, _, _, _)| day_key == "2026-02-21" && provider == "provider_new")
            .cloned()
            .unwrap();
        assert_eq!(merged.2, 330);
        assert_eq!(merged.3, 2);
        assert_eq!(merged.4, 1);
        assert_eq!(merged.5, 1);
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
                &[],
            );
        assert_eq!(requests, 3);
        assert_eq!(input, 300);
        assert_eq!(output, 30);
        assert_eq!(total, 330);
        assert_eq!(cache_create, 0);
        assert_eq!(cache_read, 0);
    }

    #[test]
    fn since_window_applies_when_date_range_is_unbounded() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();
        let older = chrono::Local
            .with_ymd_and_hms(2026, 2, 10, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis();
        let newer = chrono::Local
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
                 ) VALUES(?1, ?2, 'official', '-', 'gpt-5.2-codex', 'windows', 's-older', 10, 1, 11, 0, 0)",
                rusqlite::params!["older-row", older],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO usage_requests(
                    id, unix_ms, provider, api_key_ref, model, origin, session_id,
                    input_tokens, output_tokens, total_tokens, cache_creation_input_tokens, cache_read_input_tokens
                 ) VALUES(?1, ?2, 'official', '-', 'gpt-5.2-codex', 'windows', 's-newer', 20, 2, 22, 0, 0)",
                rusqlite::params!["newer-row", newer],
            )
            .unwrap();
        }

        let since = (newer - 3_600_000) as u64;
        let (rows, has_more) =
            store.list_usage_requests_page(since, None, None, &[], &[], &[], &[], &[], 50, 0);
        assert!(!has_more);
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0]
                .get("session_id")
                .and_then(|v| v.as_str())
                .unwrap_or_default(),
            "s-newer"
        );

        let (requests, input, output, total, cache_create, cache_read) = store
            .summarize_usage_requests(since, None, None, &[], &[], &[], &[], &[]);
        assert_eq!(requests, 1);
        assert_eq!(input, 20);
        assert_eq!(output, 2);
        assert_eq!(total, 22);
        assert_eq!(cache_create, 0);
        assert_eq!(cache_read, 0);
    }

    #[test]
    fn usage_request_sync_batch_uses_ingested_cursor_for_late_backfill() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();

        {
            let conn = store.events_db.lock();
            conn.execute(
                "INSERT INTO usage_requests(
                    id, unix_ms, ingested_at_unix_ms, provider, api_key_ref, model, origin, session_id, node_id, node_name,
                    input_tokens, output_tokens, total_tokens, cache_creation_input_tokens, cache_read_input_tokens
                 ) VALUES(?1, ?2, ?3, 'official', '-', 'gpt-5.2-codex', 'windows', 's-old', 'node-a', 'Desk A', 10, 1, 11, 0, 0)",
                rusqlite::params!["row-old", 1_000_i64, 1_000_i64],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO usage_requests(
                    id, unix_ms, ingested_at_unix_ms, provider, api_key_ref, model, origin, session_id, node_id, node_name,
                    input_tokens, output_tokens, total_tokens, cache_creation_input_tokens, cache_read_input_tokens
                 ) VALUES(?1, ?2, ?3, 'official', '-', 'gpt-5.2-codex', 'windows', 's-late', 'node-b', 'Desk B', 20, 2, 22, 0, 0)",
                rusqlite::params!["row-late", 500_i64, 2_000_i64],
            )
            .unwrap();
        }

        let (rows, has_more) = store.list_usage_request_sync_batch(1_000, Some("row-old"), 10);
        assert!(!has_more);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "row-late");
        assert_eq!(rows[0].unix_ms, 500);
    }

    #[test]
    fn usage_request_sync_upsert_converges_union_without_duplicates() {
        let tmp_a = tempfile::tempdir().unwrap();
        let store_a = Store::open(tmp_a.path()).unwrap();
        let tmp_b = tempfile::tempdir().unwrap();
        let store_b = Store::open(tmp_b.path()).unwrap();

        let mut rows = Vec::new();
        for i in 0..300u64 {
            rows.push(UsageRequestSyncRow {
                id: format!("row-{i:03}"),
                unix_ms: 10_000 + i,
                ingested_at_unix_ms: 20_000 + i,
                provider: "official".to_string(),
                api_key_ref: "-".to_string(),
                model: "gpt-5.2-codex".to_string(),
                origin: if i % 2 == 0 { "windows" } else { "wsl2" }.to_string(),
                session_id: format!("session-{i:03}"),
                node_id: if i % 2 == 0 { "node-a" } else { "node-b" }.to_string(),
                node_name: if i % 2 == 0 { "Desk A" } else { "Desk B" }.to_string(),
                input_tokens: 100 + i,
                output_tokens: 10,
                total_tokens: 110 + i,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            });
        }

        assert_eq!(store_a.upsert_usage_request_sync_rows(&rows), 300);
        assert_eq!(store_b.upsert_usage_request_sync_rows(&rows[..200]), 200);

        let (missing_rows, has_more) = store_a.list_usage_request_sync_batch(20_199, Some("row-199"), 200);
        assert!(!has_more);
        assert_eq!(missing_rows.len(), 100);
        assert_eq!(store_b.upsert_usage_request_sync_rows(&missing_rows), 100);
        assert_eq!(store_b.upsert_usage_request_sync_rows(&missing_rows), 0);

        let rows_b = store_b.list_usage_requests(400);
        assert_eq!(rows_b.len(), 300);
        assert!(rows_b.iter().any(|row| row.get("node_name").and_then(|v| v.as_str()) == Some("Desk A")));
        assert!(rows_b.iter().any(|row| row.get("node_name").and_then(|v| v.as_str()) == Some("Desk B")));
    }

    #[test]
    fn usage_request_queries_support_node_filter() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();

        let rows = [
            ("node-a-1", "Desk A", "session-a", 110_i64),
            ("node-a-2", "Desk A", "session-b", 220_i64),
            ("node-b-1", "Desk B", "session-c", 330_i64),
        ];
        {
            let conn = store.events_db.lock();
            for (idx, (node_id, node_name, session_id, total_tokens)) in rows.iter().enumerate() {
                conn.execute(
                    "INSERT INTO usage_requests(
                        id, unix_ms, ingested_at_unix_ms, provider, api_key_ref, model, origin, session_id, node_id, node_name,
                        input_tokens, output_tokens, total_tokens, cache_creation_input_tokens, cache_read_input_tokens
                     ) VALUES(?1, ?2, ?2, 'official', '-', 'gpt-5.2-codex', 'windows', ?3, ?4, ?5, ?6, 0, ?6, 0, 0)",
                    rusqlite::params![
                        format!("row-{idx}"),
                        50_000_i64 + idx as i64,
                        session_id,
                        node_id,
                        node_name,
                        total_tokens,
                    ],
                )
                .unwrap();
            }
        }

        let (desk_a_rows, has_more) = store.list_usage_requests_page(
            0,
            None,
            None,
            &["Desk A".to_string()],
            &[],
            &[],
            &[],
            &[],
            50,
            0,
        );
        assert!(!has_more);
        assert_eq!(desk_a_rows.len(), 2);
        assert!(desk_a_rows
            .iter()
            .all(|row| row.get("node_name").and_then(|v| v.as_str()) == Some("Desk A")));

        let (requests, input, output, total, cache_create, cache_read) = store
            .summarize_usage_requests(
                0,
                None,
                None,
                &["Desk B".to_string()],
                &[],
                &[],
                &[],
                &[],
            );
        assert_eq!(requests, 1);
        assert_eq!(input, 330);
        assert_eq!(output, 0);
        assert_eq!(total, 330);
        assert_eq!(cache_create, 0);
        assert_eq!(cache_read, 0);
    }
}
