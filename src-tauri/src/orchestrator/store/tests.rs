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
}
