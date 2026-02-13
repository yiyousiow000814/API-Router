#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_events_reads_latest_without_full_scan() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();

        // Insert out-of-order timestamps; iteration should return newest-first by key order.
        let mk = |ts: u64, id: &str| format!("event:{ts}:{id}");
        let v = |ts: u64| {
            serde_json::json!({
                "provider": "p1",
                "level": "info",
                "unix_ms": ts,
                "code": "test_event",
                "message": "hello",
                "fields": serde_json::json!({}),
            })
        };

        let _ = store.db.insert(
            mk(1000, "a").as_bytes(),
            serde_json::to_vec(&v(1000)).unwrap(),
        );
        let _ = store.db.insert(
            mk(3000, "c").as_bytes(),
            serde_json::to_vec(&v(3000)).unwrap(),
        );
        let _ = store.db.insert(
            mk(2000, "b").as_bytes(),
            serde_json::to_vec(&v(2000)).unwrap(),
        );

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
            // Make the store look like a modern one (schema marker + valid event payload).
            let _ = db.insert(Store::EVENTS_SCHEMA_KEY, Store::EVENTS_SCHEMA_VERSION);
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
}
