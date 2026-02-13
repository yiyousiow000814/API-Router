#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::constants::GATEWAY_MODEL_PROVIDER_ID;
    use std::collections::BTreeMap;
    use std::io::Write;
    use std::path::PathBuf;
    use std::time::Duration;

    #[test]
    fn parse_rollout_session_meta_extracts_fields() {
        let line = format!(
            r#"{{"timestamp":"2026-02-01T17:54:58.654Z","type":"session_meta","payload":{{"id":"00000000-0000-0000-0000-000000000000","cwd":"C:\\work\\example-project","model_provider":"{provider}"}}}}"#,
            provider = GATEWAY_MODEL_PROVIDER_ID
        );
        let m = parse_rollout_session_meta(&line).expect("parse");
        assert_eq!(m.id, "00000000-0000-0000-0000-000000000000");
        assert_eq!(m.cwd, "C:\\work\\example-project");
        assert_eq!(m.model_provider.as_deref(), Some(GATEWAY_MODEL_PROVIDER_ID));
        assert!(m.base_url.is_none());
        assert!(!m.is_agent);
        assert!(!m.is_review);
    }

    #[test]
    fn parse_rollout_session_meta_detects_subagent_source() {
        let line = format!(
            r#"{{"type":"session_meta","payload":{{"id":"x","cwd":"C:\\x","model_provider":"{provider}","source":{{"subagent":{{"thread_spawn":{{"parent_thread_id":"p","depth":1}}}}}}}}}}"#,
            provider = GATEWAY_MODEL_PROVIDER_ID
        );
        let m = parse_rollout_session_meta(&line).expect("parse");
        assert!(m.is_agent);
        assert!(!m.is_review);
    }

    #[test]
    fn parse_rollout_session_meta_detects_review_subagent() {
        let line = format!(
            r#"{{"type":"session_meta","payload":{{"id":"x","cwd":"C:\\x","model_provider":"{provider}","source":{{"subagent":"review"}}}}}}"#,
            provider = GATEWAY_MODEL_PROVIDER_ID
        );
        let m = parse_rollout_session_meta(&line).expect("parse");
        assert!(m.is_agent);
        assert!(m.is_review);
    }

    #[test]
    fn parse_rollout_session_meta_string_review_implies_agent() {
        let line = format!(
            r#"{{"type":"session_meta","payload":{{"id":"x","cwd":"C:\\x","model_provider":"{provider}","source":"review"}}}}"#,
            provider = GATEWAY_MODEL_PROVIDER_ID
        );
        let m = parse_rollout_session_meta(&line).expect("parse");
        assert!(m.is_agent);
        assert!(m.is_review);
    }

    #[test]
    fn rollout_base_url_matches_router_prefers_base_url_when_present() {
        let line = format!(
            r#"{{"type":"session_meta","payload":{{"id":"x","cwd":"C:\\x","model_provider":"{provider}","base_url":"https://example.com/v1"}}}}"#,
            provider = GATEWAY_MODEL_PROVIDER_ID
        );
        let m = parse_rollout_session_meta(&line).expect("parse");
        assert_eq!(rollout_base_url_matches_router(&m, 4000), Some(false));
    }

    #[test]
    fn rollout_base_url_matches_router_is_none_when_base_url_missing() {
        let good = format!(
            r#"{{"type":"session_meta","payload":{{"id":"x","cwd":"C:\\x","model_provider":"{provider}"}}}}"#,
            provider = GATEWAY_MODEL_PROVIDER_ID
        );
        let mg = parse_rollout_session_meta(&good).expect("parse");
        assert_eq!(rollout_base_url_matches_router(&mg, 4000), None);
    }

    #[test]
    fn norm_cwd_for_match_trims_trailing_slashes() {
        assert_eq!(norm_cwd_for_match("C:\\Work\\Proj\\"), "c:/work/proj");
        assert_eq!(norm_cwd_for_match("C:/Work/Proj"), "c:/work/proj");
    }

    #[test]
    fn infer_session_id_skips_unparseable_newest_rollout() {
        let tmp = tempfile::tempdir().expect("tmpdir");
        let codex_home = tmp.path().join(".codex");
        let sessions_dir = codex_home
            .join("sessions")
            .join("2026")
            .join("02")
            .join("02");
        std::fs::create_dir_all(&sessions_dir).expect("mkdir");

        // Create a valid rollout first (older).
        let good_id = "00000000-0000-0000-0000-000000000000";
        let good = sessions_dir.join(format!("rollout-good-{good_id}.jsonl"));
        {
            let mut f = std::fs::File::create(&good).expect("create good");
            writeln!(
                f,
                r#"{{"type":"session_meta","payload":{{"id":"{good_id}","cwd":"C:\\work\\proj\\","model_provider":"{provider}"}}}}"#,
                provider = GATEWAY_MODEL_PROVIDER_ID
            )
            .unwrap();
        }

        // Create a malformed rollout after (newer) that would previously abort inference.
        let bad = sessions_dir.join("rollout-bad.jsonl");
        {
            let mut f = std::fs::File::create(&bad).expect("create bad");
            writeln!(f, "not json").unwrap();
        }

        let cwd = std::path::PathBuf::from("C:\\work\\proj");
        let got = infer_codex_session_id_from_rollouts_dir(&codex_home, &cwd, 4000, None);
        assert_eq!(got.as_deref(), Some(good_id));
    }

    #[test]
    fn infer_session_id_does_not_guess_when_start_time_far() {
        let tmp = tempfile::tempdir().expect("tmpdir");
        let codex_home = tmp.path().join(".codex");
        let sessions_dir = codex_home
            .join("sessions")
            .join("2026")
            .join("02")
            .join("02");
        std::fs::create_dir_all(&sessions_dir).expect("mkdir");

        let id = "00000000-0000-0000-0000-000000000000";
        let good = sessions_dir.join(format!("rollout-good-{id}.jsonl"));
        {
            let mut f = std::fs::File::create(&good).expect("create");
            writeln!(
                f,
                r#"{{"type":"session_meta","payload":{{"id":"{id}","cwd":"C:\\work\\proj\\","model_provider":"{provider}"}}}}"#,
                provider = GATEWAY_MODEL_PROVIDER_ID
            )
            .unwrap();
        }

        let cwd = std::path::PathBuf::from("C:\\work\\proj");
        let start = std::time::SystemTime::now() + Duration::from_secs(3600);
        let got = infer_codex_session_id_from_rollouts_dir(&codex_home, &cwd, 4000, Some(start));
        assert!(got.is_none());
    }

    #[test]
    fn infer_session_id_prefers_cli_over_subagent_when_both_exist() {
        let tmp = tempfile::tempdir().expect("tmpdir");
        let codex_home = tmp.path().join(".codex");
        let sessions_dir = codex_home
            .join("sessions")
            .join("2026")
            .join("02")
            .join("13");
        std::fs::create_dir_all(&sessions_dir).expect("mkdir");

        let cli_id = "019c572b-d089-7750-b15e-9f52851852e6";
        let agent_id = "019c572b-ea60-7251-b36b-e4fd30695ddb";

        let cli = sessions_dir.join(format!("rollout-cli-{cli_id}.jsonl"));
        {
            let mut f = std::fs::File::create(&cli).expect("create cli");
            writeln!(
                f,
                r#"{{"type":"session_meta","payload":{{"id":"{cli_id}","cwd":"C:\\work\\proj\\","source":"cli","model_provider":"{provider}"}}}}"#,
                provider = GATEWAY_MODEL_PROVIDER_ID
            )
            .unwrap();
        }

        std::thread::sleep(Duration::from_millis(20));

        let agent = sessions_dir.join(format!("rollout-agent-{agent_id}.jsonl"));
        {
            let mut f = std::fs::File::create(&agent).expect("create agent");
            writeln!(
                f,
                r#"{{"type":"session_meta","payload":{{"id":"{agent_id}","cwd":"C:\\work\\proj\\","source":{{"subagent":"review"}},"model_provider":"{provider}"}}}}"#,
                provider = GATEWAY_MODEL_PROVIDER_ID
            )
            .unwrap();
        }

        let cwd = std::path::PathBuf::from("C:\\work\\proj");
        let start = std::fs::metadata(&agent)
            .and_then(|m| m.created().or_else(|_| m.modified()))
            .unwrap();
        let got = infer_codex_session_id_from_rollouts_dir(&codex_home, &cwd, 4000, Some(start));
        assert_eq!(got.as_deref(), Some(cli_id));
    }

    #[test]
    fn parse_tui_log_session_line_extracts_timestamp_and_thread_id() {
        let line = "2026-02-13T15:05:34.191451Z  INFO session_loop{thread_id=019c5789-2ee7-72a3-9fd7-69a2f10aa7bc}: codex_core::codex: new";
        let (ts, id) = parse_tui_log_session_line(line).expect("parse");
        assert_eq!(id, "019c5789-2ee7-72a3-9fd7-69a2f10aa7bc");
        assert!(ts.duration_since(std::time::SystemTime::UNIX_EPOCH).is_ok());
    }

    #[test]
    fn infer_session_id_from_tui_log_prefers_closest_to_start_time() {
        let tmp = tempfile::tempdir().expect("tmpdir");
        let codex_home = tmp.path().join(".codex");
        let log_dir = codex_home.join("log");
        std::fs::create_dir_all(&log_dir).expect("mkdir");
        let log_path = log_dir.join("codex-tui.log");
        let mut f = std::fs::File::create(&log_path).expect("create");
        writeln!(
            f,
            "2026-02-13T15:05:32.100000Z  INFO session_loop{{thread_id=019c5789-2ee7-72a3-9fd7-69a2f10aa7bc}}: codex_core::codex: new"
        )
        .unwrap();
        writeln!(
            f,
            "2026-02-13T15:05:34.100000Z  INFO session_loop{{thread_id=019c57aa-2ee7-72a3-9fd7-69a2f10aa7bc}}: codex_core::codex: new"
        )
        .unwrap();
        let start_ms = u64::try_from(
            chrono::DateTime::parse_from_rfc3339("2026-02-13T15:05:34Z")
                .unwrap()
                .timestamp_millis(),
        )
        .unwrap();
        let start = std::time::UNIX_EPOCH + Duration::from_millis(start_ms);
        let got = infer_codex_session_id_from_tui_log(&codex_home, start);
        assert_eq!(got.as_deref(), Some("019c57aa-2ee7-72a3-9fd7-69a2f10aa7bc"));
    }

    #[test]
    fn infer_session_id_from_tui_log_respects_time_window() {
        let tmp = tempfile::tempdir().expect("tmpdir");
        let codex_home = tmp.path().join(".codex");
        let log_dir = codex_home.join("log");
        std::fs::create_dir_all(&log_dir).expect("mkdir");
        let log_path = log_dir.join("codex-tui.log");
        let mut f = std::fs::File::create(&log_path).expect("create");
        writeln!(
            f,
            "2026-02-13T15:05:00.000000Z  INFO session_loop{{thread_id=019c5789-2ee7-72a3-9fd7-69a2f10aa7bc}}: codex_core::codex: new"
        )
        .unwrap();
        let start_ms = u64::try_from(
            chrono::DateTime::parse_from_rfc3339("2026-02-13T15:05:34Z")
                .unwrap()
                .timestamp_millis(),
        )
        .unwrap();
        let start = std::time::UNIX_EPOCH + Duration::from_millis(start_ms);
        let got = infer_codex_session_id_from_tui_log(&codex_home, start);
        assert!(got.is_none());
    }

    #[test]
    #[ignore]
    fn manual_print_discovery() {
        fn find_repo_root_from_cwd() -> Option<PathBuf> {
            let mut cur = std::env::current_dir().ok()?;
            for _ in 0..6 {
                if cur.join("user-data").join("config.toml").exists() {
                    return Some(cur);
                }
                cur = cur.parent()?.to_path_buf();
            }
            None
        }

        let Some(root) = find_repo_root_from_cwd() else {
            eprintln!(
                "manual_print_discovery: failed to locate repo root (user-data/config.toml)."
            );
            return;
        };

        let cfg_path = root.join("user-data").join("config.toml");
        let cfg_txt = std::fs::read_to_string(&cfg_path).unwrap_or_default();
        let cfg_val: toml::Value =
            toml::from_str(&cfg_txt).unwrap_or(toml::Value::Table(Default::default()));
        let port = cfg_val
            .get("listen")
            .and_then(|v| v.get("port"))
            .and_then(|v| v.as_integer())
            .unwrap_or(4000) as u16;

        let secrets_path = root.join("user-data").join("secrets.json");
        let secrets_txt = std::fs::read_to_string(&secrets_path).unwrap_or_default();
        let secrets_json: serde_json::Value =
            serde_json::from_str(&secrets_txt).unwrap_or(serde_json::Value::Null);
        let token = secrets_json
            .get("providers")
            .and_then(|v| v.get("__gateway_token__"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        eprintln!("manual_print_discovery: router_port={port}");
        eprintln!(
            "manual_print_discovery: expected_gateway_token={}",
            token.as_deref().unwrap_or("<none>")
        );

        let items = discover_sessions_using_router(port, token.as_deref());
        eprintln!("manual_print_discovery: discovered_count={}", items.len());

        let mut by_id: BTreeMap<String, usize> = BTreeMap::new();
        for s in &items {
            if let Some(id) = s.codex_session_id.as_deref() {
                *by_id.entry(id.to_string()).or_default() += 1;
            }
        }

        for s in items {
            eprintln!("---");
            eprintln!(
                "codex_session_id={}",
                s.codex_session_id.as_deref().unwrap_or("<none>")
            );
            eprintln!("wt_session={}", s.wt_session.trim());
            eprintln!("pid={}", s.pid);
            eprintln!("router_confirmed={}", s.router_confirmed);
            eprintln!("is_agent={}", s.is_agent);
            eprintln!(
                "reported_model_provider={}",
                s.reported_model_provider.as_deref().unwrap_or("<none>")
            );
            eprintln!(
                "reported_base_url={}",
                s.reported_base_url.as_deref().unwrap_or("<none>")
            );
        }

        let dups: Vec<(String, usize)> = by_id.into_iter().filter(|(_k, v)| *v > 1).collect();
        if !dups.is_empty() {
            eprintln!("---");
            eprintln!("duplicate_codex_session_ids:");
            for (k, v) in dups {
                eprintln!("{k} x{v}");
            }
        }
    }
}
