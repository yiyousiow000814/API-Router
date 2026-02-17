#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::constants::GATEWAY_MODEL_PROVIDER_ID;
    use std::collections::BTreeMap;
    use std::io::Write;
    use std::path::PathBuf;
    use std::process::{Child, Command, Stdio};
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
    fn wt_session_ids_equal_accepts_wsl_prefix() {
        assert!(wt_session_ids_equal(
            "7c757b99-7a1f-455a-b301-3e0271e7f615",
            "wsl:7c757b99-7a1f-455a-b301-3e0271e7f615"
        ));
        assert!(wt_session_ids_equal(
            "WSL:B11E1CBB-E347-4979-8C73-8D5FB903AC45",
            "b11e1cbb-e347-4979-8c73-8d5fb903ac45"
        ));
    }

    #[test]
    fn merge_wt_session_marker_preserves_wsl_origin_for_same_id() {
        assert_eq!(
            merge_wt_session_marker(
                Some("wsl:7c757b99-7a1f-455a-b301-3e0271e7f615"),
                "7c757b99-7a1f-455a-b301-3e0271e7f615"
            )
            .as_deref(),
            Some("wsl:7c757b99-7a1f-455a-b301-3e0271e7f615")
        );
        assert_eq!(
            merge_wt_session_marker(
                Some("7c757b99-7a1f-455a-b301-3e0271e7f615"),
                "wsl:7c757b99-7a1f-455a-b301-3e0271e7f615"
            )
            .as_deref(),
            Some("wsl:7c757b99-7a1f-455a-b301-3e0271e7f615")
        );
    }

    #[test]
    fn merge_wt_session_marker_keeps_latest_when_ids_differ() {
        assert_eq!(
            merge_wt_session_marker(
                Some("wsl:7c757b99-7a1f-455a-b301-3e0271e7f615"),
                "b11e1cbb-e347-4979-8c73-8d5fb903ac45"
            )
            .as_deref(),
            Some("b11e1cbb-e347-4979-8c73-8d5fb903ac45")
        );
    }

    #[test]
    fn is_wt_session_alive_accepts_wsl_prefixed_target() {
        use std::process::{Command, Stdio};

        let marker = format!("codex-test-{}", std::process::id());
        let mut child = match Command::new("wsl.exe")
            .args(["--exec", "sh", "-lc", "sleep 5"])
            .env("WT_SESSION", &marker)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(_) => {
                // Environment may not have WSL available in all Windows runners.
                return;
            }
        };

        std::thread::sleep(Duration::from_millis(300));
        if let Ok(Some(_status)) = child.try_wait() {
            // Default distro may be missing; skip in that environment.
            return;
        }

        let raw = is_wt_session_alive(&marker);
        let prefixed = is_wt_session_alive(&format!("wsl:{marker}"));

        let _ = child.kill();
        let _ = child.wait();

        assert!(raw, "expected WT_SESSION liveness for spawned wsl.exe process");
        assert!(
            prefixed,
            "expected wsl-prefixed WT_SESSION liveness for spawned wsl.exe process"
        );
    }

    fn parse_wsl_list_output(bytes: &[u8]) -> String {
        if bytes.len() >= 2
            && bytes.len() % 2 == 0
            && bytes.iter().skip(1).step_by(2).any(|b| *b == 0)
        {
            let utf16: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            return String::from_utf16_lossy(&utf16);
        }
        String::from_utf8_lossy(bytes).to_string()
    }

    fn first_wsl_distro() -> Option<String> {
        let out = Command::new("wsl.exe").args(["-l", "-q"]).output().ok()?;
        if !out.status.success() {
            return None;
        }
        parse_wsl_list_output(&out.stdout)
            .lines()
            .map(|s| s.replace('\0', ""))
            .map(|s| {
                s.trim()
                    .trim_start_matches('*')
                    .trim()
                    .trim_start_matches('\u{feff}')
                    .to_string()
            })
            .find(|s| !s.is_empty())
    }

    fn spawn_fake_wsl_codex_process(
        distro: &str,
        wt_session: &str,
        session_id: &str,
        with_resume_arg: bool,
    ) -> Option<Child> {
        let wt = wt_session.replace('"', "");
        let sid = session_id.replace('"', "");
        let root = format!("/tmp/api-router-wsl-e2e-{wt}");
        let home = format!("{root}/home");
        let codex_home = format!("{home}/.codex");
        let sess_dir = format!("{codex_home}/sessions/2026/02/17");
        let log_dir = format!("{codex_home}/log");
        let rollout = format!("{sess_dir}/rollout-2026-02-17T00-00-00-{sid}.jsonl");
        let log = format!("{log_dir}/codex-tui.log");
        let runner = "/tmp/codex";

        let prep = format!(
            r#"set -eu; mkdir -p "{sess_dir}" "{log_dir}"; printf '{{"type":"session_meta","payload":{{"id":"%s","cwd":"/tmp","model_provider":"api_router","base_url":"http://172.26.144.1:4000/v1"}}}}\n' "{sid}" > "{rollout}"; printf '%s\n' '#!/bin/sh' 'exec 3< "{rollout}"' 'exec 4>> "{log}"' 'printf '\''2026-02-17T00:00:00.000000Z  INFO session_loop{{thread_id=%s}}: codex\n'\'' "{sid}" >&4' 'sleep 180' > "{runner}"; chmod +x "{runner}""#
        );
        let prep_out = Command::new("wsl.exe")
            .args(["-d", distro, "--", "sh", "-c", &prep])
            .output()
            .ok()?;
        if !prep_out.status.success() {
            return None;
        }

        let home_env = format!("HOME=/tmp/api-router-wsl-e2e-{wt}/home");
        let wt_env = format!("WT_SESSION={wt}");
        let mut cmd = Command::new("wsl.exe");
        cmd.args(["-d", distro, "--", "env", &wt_env, &home_env, runner]);
        if with_resume_arg {
            cmd.arg("resume").arg(&sid);
        }
        let mut child = cmd
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .ok()?;
        std::thread::sleep(Duration::from_millis(300));
        if child.try_wait().ok().flatten().is_some() {
            return None;
        }
        Some(child)
    }

    fn discovered_wsl_sid_for_wt(port: u16, wt_session: &str) -> Option<String> {
        let target = format!("wsl:{wt_session}");
        discover_sessions_using_router_uncached(port, None)
            .into_iter()
            .find(|s| s.wt_session.eq_ignore_ascii_case(&target))
            .and_then(|s| s.codex_session_id)
    }

    fn wait_for_wsl_sid(port: u16, wt_session: &str, timeout_ms: u64) -> Option<String> {
        let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            if let Some(sid) = discovered_wsl_sid_for_wt(port, wt_session) {
                return Some(sid);
            }
            if std::time::Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    fn wait_for_wsl_absent(port: u16, wt_session: &str, timeout_ms: u64) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            if discovered_wsl_sid_for_wt(port, wt_session).is_none() {
                return true;
            }
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    fn debug_print_wsl_probe(distro: &str, wt_session: &str) {
        let ps = Command::new("wsl.exe")
            .args([
                "-d",
                distro,
                "--",
                "sh",
                "-lc",
                "ps -eo pid=,etimes=,args= | grep -E 'codex.js|@openai/codex|/codex( |$)' | grep -v grep || true",
            ])
            .output();
        if let Ok(out) = ps {
            eprintln!(
                "e2e_wsl_probe: ps={}",
                String::from_utf8_lossy(&out.stdout).trim()
            );
        }
        let codex_probe = Command::new("wsl.exe")
            .args([
                "-d",
                distro,
                "--",
                "sh",
                "-lc",
                "ps -eo pid=,args= | grep '/tmp/codex' | grep -v grep | while read pid rest; do echo PID=\\$pid; cat /proc/\\$pid/environ | tr '\\0' '\\n' | grep '^WT_SESSION=' || true; for f in /proc/\\$pid/fd/*; do readlink \"\\$f\" 2>/dev/null; done | grep -E 'rollout-.*\\.jsonl' || true; done",
            ])
            .output();
        if let Ok(out) = codex_probe {
            eprintln!(
                "e2e_wsl_probe: codex_probe={}",
                String::from_utf8_lossy(&out.stdout).trim()
            );
        }
        let target = format!("wsl:{wt_session}");
        let items = discover_sessions_using_router_uncached(4000, None);
        for s in items {
            if s.wt_session.eq_ignore_ascii_case(&target) {
                eprintln!(
                    "e2e_wsl_probe: matched wt={} sid={}",
                    s.wt_session,
                    s.codex_session_id.as_deref().unwrap_or("<none>")
                );
            }
        }
    }

    #[test]
    fn e2e_wsl_same_wt_new_and_resume_sessions_switch_sid() {
        let Some(distro) = first_wsl_distro() else {
            return;
        };
        let wt_session = format!("api-router-e2e-wt-{}", std::process::id());
        let sid1 = uuid::Uuid::new_v4().to_string();
        let sid2 = uuid::Uuid::new_v4().to_string();
        let port = 4000u16;

        let mut first =
            spawn_fake_wsl_codex_process(&distro, &wt_session, &sid1, false).expect("spawn first");
        let got1 = wait_for_wsl_sid(port, &wt_session, 8_000);
        if got1.is_none() {
            debug_print_wsl_probe(&distro, &wt_session);
        }
        let _ = first.kill();
        let _ = first.wait();
        assert_eq!(got1.as_deref(), Some(sid1.as_str()));
        assert!(wait_for_wsl_absent(port, &wt_session, 8_000));

        let mut second =
            spawn_fake_wsl_codex_process(&distro, &wt_session, &sid2, false).expect("spawn second");
        let got2 = wait_for_wsl_sid(port, &wt_session, 8_000);
        let _ = second.kill();
        let _ = second.wait();
        assert_eq!(got2.as_deref(), Some(sid2.as_str()));
        assert!(wait_for_wsl_absent(port, &wt_session, 8_000));

        let mut resumed =
            spawn_fake_wsl_codex_process(&distro, &wt_session, &sid1, true).expect("spawn resumed");
        let got3 = wait_for_wsl_sid(port, &wt_session, 8_000);
        let _ = resumed.kill();
        let _ = resumed.wait();
        assert_eq!(got3.as_deref(), Some(sid1.as_str()));
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

        let mut items = discover_sessions_using_router_uncached(port, token.as_deref());
        if items.is_empty() {
            // Keep a cache-path fallback for local diagnostics.
            items = discover_sessions_using_router(port, token.as_deref());
            if items.is_empty() {
                std::thread::sleep(Duration::from_millis(700));
                items = discover_sessions_using_router(port, token.as_deref());
            }
        }
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
