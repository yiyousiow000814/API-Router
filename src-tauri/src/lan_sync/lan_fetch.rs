use axum::extract::{Json, State};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::diagnostics::current_diagnostics_dir;
use crate::diagnostics::WATCHDOG_DUMP_PREFIXES;
use crate::lan_sync::authorize_lan_sync_http_request;

const WATCHDOG_ACTIVITY_WINDOW_MINUTES: u64 = 12 * 60;
const WATCHDOG_ACTIVITY_BUCKET_MINUTES: u64 = 5;
const WATCHDOG_ACTIVITY_WINDOW_MS: u64 = WATCHDOG_ACTIVITY_WINDOW_MINUTES * 60_000;
const WATCHDOG_ACTIVITY_BUCKET_MS: u64 = WATCHDOG_ACTIVITY_BUCKET_MINUTES * 60_000;
const WATCHDOG_ACTIVITY_BUCKETS: usize =
    (WATCHDOG_ACTIVITY_WINDOW_MS / WATCHDOG_ACTIVITY_BUCKET_MS) as usize;

#[derive(Debug, Serialize, Deserialize)]
pub struct LanDiagnosticsRequestPacket {
    pub version: u8,
    pub node_id: String,
    pub domains: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LanDiagnosticsResponsePacket {
    pub version: u8,
    pub node_id: String,
    pub node_name: String,
    pub sent_at_unix_ms: u64,
    pub domains: serde_json::Value,
}

pub(crate) fn local_diagnostics_snapshot(
    listen_port: u16,
    requested_domains: &[String],
) -> serde_json::Value {
    let all_domains =
        requested_domains.is_empty() || requested_domains.iter().any(|domain| domain == "all");
    let requested = |domain: &str| {
        all_domains
            || requested_domains
                .iter()
                .any(|requested| requested == domain)
    };

    let mut domains = serde_json::Map::new();

    if requested("watchdog") {
        domains.insert(
            "watchdog".to_string(),
            serde_json::to_value(watchdog_summary()).unwrap_or(serde_json::Value::Null),
        );
    }

    if requested("webtransport") {
        let snapshot = crate::diagnostics::codex_web_transport::current_web_transport_snapshot();
        domains.insert(
            "webtransport".to_string(),
            serde_json::to_value(snapshot).unwrap_or(serde_json::Value::Null),
        );
    }

    if requested("tailscale") {
        let snapshot =
            crate::tailscale_diagnostics::current_tailscale_diagnostic_snapshot(listen_port);
        domains.insert(
            "tailscale".to_string(),
            serde_json::to_value(snapshot).unwrap_or(serde_json::Value::Null),
        );
    }

    serde_json::Value::Object(domains)
}

pub async fn lan_sync_diagnostics_http(
    State(gateway): State<crate::orchestrator::gateway::GatewayState>,
    headers: HeaderMap,
    Json(packet): Json<LanDiagnosticsRequestPacket>,
) -> impl IntoResponse {
    if let Err(err) = authorize_lan_sync_http_request(&gateway, &headers, &packet.node_id) {
        return err.into_response();
    }
    let listen_port = gateway.cfg.read().listen.port;
    let node = gateway.secrets.get_lan_node_identity().unwrap_or_else(|| {
        crate::lan_sync::LanNodeIdentity {
            node_id: String::new(),
            node_name: String::new(),
        }
    });
    let domains = packet.domains.clone();
    let domains_snapshot = tauri::async_runtime::spawn_blocking(move || {
        local_diagnostics_snapshot(listen_port, &domains)
    })
    .await
    .unwrap_or_else(|err| {
        log::warn!("lan_sync_diagnostics_http failed to build snapshot: {err}");
        serde_json::json!({})
    });
    Json(LanDiagnosticsResponsePacket {
        version: 1,
        node_id: node.node_id,
        node_name: node.node_name,
        sent_at_unix_ms: crate::orchestrator::store::unix_ms(),
        domains: domains_snapshot,
    })
    .into_response()
}

/// Reads watchdog-related dump files from the diagnostics directory and returns a
/// normalized summary.
pub fn watchdog_summary() -> serde_json::Value {
    let now_ms = crate::orchestrator::store::unix_ms();
    let empty_buckets = build_watchdog_activity_buckets(now_ms, &[]);
    let Some(diag_dir) = current_diagnostics_dir() else {
        return empty_watchdog_summary(empty_buckets);
    };

    let entries = match std::fs::read_dir(&diag_dir) {
        Ok(entries) => entries,
        Err(_) => {
            return empty_watchdog_summary(empty_buckets);
        }
    };

    let mut watchdog_files: Vec<(u64, String, String, String)> = Vec::new();
    for entry in entries.filter_map(|e| e.ok()) {
        let file_name = entry.file_name();
        let file_name_str = file_name.to_string_lossy();
        if let Some(prefix) = WATCHDOG_DUMP_PREFIXES
            .iter()
            .find(|p| file_name_str.starts_with(*p))
        {
            // Extract timestamp from filename: prefix{timestamp}-trigger.json
            // e.g. "ui-freeze-1700000000000-heartbeat-stall.json"
            let after_prefix = &file_name_str[(*prefix).len()..];
            if let Some(dash_pos) = after_prefix.find('-') {
                if let Ok(ts) = after_prefix[..dash_pos].parse::<u64>() {
                    // Only accept files that explicitly end with ".json"
                    if file_name_str.ends_with(".json") {
                        let trigger_end = file_name_str.len() - 5; // strip ".json"
                        let trigger = &file_name_str[(*prefix).len() + dash_pos + 1..trigger_end];
                        watchdog_files.push((
                            ts,
                            trigger.to_string(),
                            prefix.trim_end_matches('-').to_string(),
                            file_name_str.to_string(),
                        ));
                    }
                }
            }
        }
    }

    if watchdog_files.is_empty() {
        return empty_watchdog_summary(empty_buckets);
    }

    watchdog_files.sort_by_key(|(ts, _, _, _)| *ts);
    let activity_cutoff = now_ms.saturating_sub(WATCHDOG_ACTIVITY_WINDOW_MS);
    let activity_watchdog_files: Vec<(u64, String, String, String)> = watchdog_files
        .iter()
        .filter(|(ts, _, _, _)| *ts >= activity_cutoff)
        .cloned()
        .collect();
    let activity_buckets = build_watchdog_activity_buckets(now_ms, &activity_watchdog_files);
    let latest_bucket_count = activity_buckets
        .last()
        .and_then(|bucket| bucket.get("count"))
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    let is_healthy = latest_bucket_count == 0;

    if activity_watchdog_files.is_empty() {
        return empty_watchdog_summary(activity_buckets);
    }

    let (last_ts, last_trigger, last_prefix, last_file) = activity_watchdog_files
        .last()
        .cloned()
        .unwrap_or_else(|| (0, String::new(), String::new(), String::new()));
    let incident_count = activity_watchdog_files.len() as u32;
    let recent_incidents: Vec<serde_json::Value> = activity_watchdog_files
        .iter()
        .rev()
        .take(5)
        .map(|(ts, trigger, prefix, file_name)| {
            let detail = read_watchdog_incident_detail(&diag_dir.join(file_name), prefix, trigger);
            serde_json::json!({
                "unix_ms": ts,
                "kind": trigger,
                "file": file_name,
                "detail": detail,
            })
        })
        .collect();

    let last_incident_detail =
        read_watchdog_incident_detail(&diag_dir.join(&last_file), &last_prefix, &last_trigger);

    serde_json::json!({
        "healthy": is_healthy,
        "last_incident_kind": last_trigger,
        "last_incident_unix_ms": last_ts,
        "last_incident_file": last_file,
        "last_incident_detail": last_incident_detail,
        "incident_count": incident_count,
        "recent_incidents": recent_incidents,
        "health_window_minutes": WATCHDOG_ACTIVITY_BUCKET_MINUTES,
        "activity_window_minutes": WATCHDOG_ACTIVITY_WINDOW_MINUTES,
        "activity_bucket_minutes": WATCHDOG_ACTIVITY_BUCKET_MINUTES,
        "activity_buckets": activity_buckets,
    })
}

fn empty_watchdog_summary(activity_buckets: Vec<serde_json::Value>) -> serde_json::Value {
    serde_json::json!({
        "healthy": true,
        "last_incident_kind": serde_json::Value::Null,
        "last_incident_unix_ms": serde_json::Value::Null,
        "last_incident_file": serde_json::Value::Null,
        "last_incident_detail": serde_json::Value::Null,
        "incident_count": 0,
        "recent_incidents": [],
        "health_window_minutes": WATCHDOG_ACTIVITY_BUCKET_MINUTES,
        "activity_window_minutes": WATCHDOG_ACTIVITY_WINDOW_MINUTES,
        "activity_bucket_minutes": WATCHDOG_ACTIVITY_BUCKET_MINUTES,
        "activity_buckets": activity_buckets,
    })
}

fn build_watchdog_activity_buckets(
    now_ms: u64,
    incidents: &[(u64, String, String, String)],
) -> Vec<serde_json::Value> {
    let window_start = now_ms.saturating_sub(WATCHDOG_ACTIVITY_WINDOW_MS);
    let bucket_count = WATCHDOG_ACTIVITY_BUCKETS;
    let mut counts = vec![0u64; bucket_count];

    for (incident_ts, _, _, _) in incidents {
        if *incident_ts < window_start {
            continue;
        }
        let bucket_index = ((*incident_ts - window_start) / WATCHDOG_ACTIVITY_BUCKET_MS) as usize;
        let clamped_index = bucket_index.min(bucket_count.saturating_sub(1));
        counts[clamped_index] += 1;
    }

    counts
        .into_iter()
        .enumerate()
        .map(|(index, count)| {
            let bucket_start = window_start + (index as u64 * WATCHDOG_ACTIVITY_BUCKET_MS);
            serde_json::json!({
                "bucket_start_unix_ms": bucket_start,
                "bucket_end_unix_ms": bucket_start + WATCHDOG_ACTIVITY_BUCKET_MS,
                "count": count,
            })
        })
        .collect()
}

fn read_watchdog_incident_detail(
    path: &std::path::Path,
    prefix: &str,
    trigger: &str,
) -> Option<String> {
    let payload = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())?;
    describe_watchdog_incident(prefix, trigger, &payload)
}

fn describe_watchdog_incident(prefix: &str, trigger: &str, payload: &Value) -> Option<String> {
    let recent_traces = payload.get("recent_traces")?.as_array()?;
    match trigger {
        "slow-refresh" | "status" | "config" | "provider_switch" => {
            let refresh_source = recent_traces.iter().rev().find_map(|trace| {
                if trace.get("kind").and_then(|v| v.as_str()) == Some("status_refresh_requested") {
                    return trace
                        .get("fields")
                        .and_then(|fields| fields.get("fields"))
                        .and_then(|fields| fields.get("source"))
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(ToString::to_string);
                }
                None
            });
            let source_label = refresh_source
                .as_deref()
                .map(humanize_watchdog_source)
                .unwrap_or_else(|| humanize_watchdog_trigger(prefix, trigger));
            Some(format!("{source_label} refresh too slow"))
        }
        "slow-invoke" => {
            let command = recent_traces.iter().rev().find_map(|trace| {
                if trace.get("kind").and_then(|v| v.as_str()) == Some("invoke") {
                    return trace
                        .get("fields")
                        .and_then(|fields| fields.get("command"))
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(ToString::to_string);
                }
                None
            });
            let label = command
                .as_deref()
                .map(humanize_watchdog_command)
                .unwrap_or_else(|| humanize_watchdog_trigger(prefix, trigger));
            Some(format!("{label} request too slow"))
        }
        "invoke-error" => {
            let command = recent_traces.iter().rev().find_map(|trace| {
                if trace.get("kind").and_then(|v| v.as_str()) == Some("invoke") {
                    return trace
                        .get("fields")
                        .and_then(|fields| fields.get("command"))
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(ToString::to_string);
                }
                None
            });
            let label = command
                .as_deref()
                .map(humanize_watchdog_command)
                .unwrap_or_else(|| humanize_watchdog_trigger(prefix, trigger));
            Some(format!("{label} request failed"))
        }
        "frame-stall" => {
            let monitor_kind = recent_traces.iter().rev().find_map(|trace| {
                if trace.get("kind").and_then(|v| v.as_str()) == Some("frame_stall") {
                    return trace
                        .get("fields")
                        .and_then(|fields| fields.get("monitor_kind"))
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(ToString::to_string);
                }
                None
            });
            let label = monitor_kind
                .as_deref()
                .map(humanize_watchdog_source)
                .unwrap_or_else(|| "UI frame".to_string());
            Some(format!("{label} stalled"))
        }
        "heartbeat-stall" => {
            let snapshot = payload.get("snapshot");
            let mut detail = String::from("UI heartbeat stalled");
            if snapshot
                .and_then(|value| value.get("status_in_flight"))
                .and_then(|value| value.as_bool())
                == Some(true)
            {
                detail.push_str(" while status refresh was active");
            } else if snapshot
                .and_then(|value| value.get("config_in_flight"))
                .and_then(|value| value.as_bool())
                == Some(true)
            {
                detail.push_str(" while config refresh was active");
            } else if snapshot
                .and_then(|value| value.get("provider_switch_in_flight"))
                .and_then(|value| value.as_bool())
                == Some(true)
            {
                detail.push_str(" while provider switch was active");
            }
            Some(detail)
        }
        _ => None,
    }
}

fn humanize_watchdog_source(source: &str) -> String {
    match source {
        "status_poll_interval" => "Status poll interval".to_string(),
        "manual_refresh" => "Manual refresh".to_string(),
        "status" => "Status snapshot".to_string(),
        "config" => "Config".to_string(),
        "provider_switch" => "Provider switch".to_string(),
        other => humanize_watchdog_trigger("", other),
    }
}

fn humanize_watchdog_command(command: &str) -> String {
    match command {
        "get_status" => "Status snapshot".to_string(),
        "get_local_diagnostics" => "Local diagnostics".to_string(),
        "get_remote_peer_diagnostics" => "Remote peer diagnostics".to_string(),
        other => humanize_watchdog_trigger("", other),
    }
}

fn humanize_watchdog_trigger(prefix: &str, trigger: &str) -> String {
    let raw = if prefix.is_empty() {
        trigger
    } else if trigger.is_empty() {
        prefix
    } else {
        trigger
    };
    raw.replace(['-', '_'], " ")
        .split_whitespace()
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::local_diagnostics_snapshot;
    use super::watchdog_summary;
    use crate::orchestrator::store::unix_ms;
    use std::sync::{Mutex, OnceLock};

    fn write_watchdog_dump(
        diag_dir: &std::path::Path,
        ts: u64,
        prefix: &str,
        trigger: &str,
        payload: serde_json::Value,
    ) {
        let file_name = format!("{prefix}{ts}-{trigger}.json");
        std::fs::write(
            diag_dir.join(file_name),
            serde_json::to_vec(&payload).expect("encode payload"),
        )
        .expect("write watchdog dump");
    }

    fn watchdog_summary_for_user_data_dir(user_data_dir: &std::path::Path) -> serde_json::Value {
        static WATCHDOG_TEST_GUARD: OnceLock<Mutex<()>> = OnceLock::new();
        let _guard = WATCHDOG_TEST_GUARD
            .get_or_init(|| Mutex::new(()))
            .lock()
            .expect("watchdog test mutex poisoned");
        let previous = crate::diagnostics::set_test_user_data_dir_override(Some(user_data_dir));
        let result = watchdog_summary();
        crate::diagnostics::set_test_user_data_dir_override(previous.as_deref());
        result
    }

    #[test]
    fn watchdog_summary_no_dir_returns_healthy() {
        // Set an invalid path so current_diagnostics_dir returns None
        let result = watchdog_summary_for_user_data_dir(std::path::Path::new("/nonexistent/path"));

        assert!(result
            .get("healthy")
            .and_then(|v| v.as_bool())
            .unwrap_or(false));
        assert!(result.get("last_incident_kind").unwrap().is_null());
        assert!(result.get("last_incident_unix_ms").unwrap().is_null());
        assert!(result.get("last_incident_file").unwrap().is_null());
        assert_eq!(
            result
                .get("incident_count")
                .and_then(|v| v.as_u64())
                .unwrap_or(1),
            0
        );
        assert_eq!(
            result
                .get("recent_incidents")
                .and_then(|v| v.as_array())
                .map(|v| v.len())
                .unwrap_or(1),
            0
        );
        assert_eq!(
            result
                .get("activity_buckets")
                .and_then(|v| v.as_array())
                .map(|v| v.len())
                .unwrap_or(0),
            144
        );
    }

    #[test]
    fn watchdog_summary_no_watchdog_files_returns_healthy() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let diag_dir = tmp.path().join("diagnostics");
        std::fs::create_dir_all(&diag_dir).expect("create diag dir");

        // Create a non-watchdog file
        std::fs::write(diag_dir.join("some-other-file.json"), "{}").expect("write file");

        let result = watchdog_summary_for_user_data_dir(tmp.path());

        assert!(result
            .get("healthy")
            .and_then(|v| v.as_bool())
            .unwrap_or(false));
        assert!(result.get("last_incident_kind").unwrap().is_null());
        assert!(result.get("last_incident_unix_ms").unwrap().is_null());
        assert!(result.get("last_incident_file").unwrap().is_null());
        assert_eq!(
            result
                .get("incident_count")
                .and_then(|v| v.as_u64())
                .unwrap_or(1),
            0
        );
        assert_eq!(
            result
                .get("recent_incidents")
                .and_then(|v| v.as_array())
                .map(|v| v.len())
                .unwrap_or(1),
            0
        );
        assert_eq!(
            result
                .get("activity_buckets")
                .and_then(|v| v.as_array())
                .map(|v| v.len())
                .unwrap_or(0),
            144
        );
    }

    #[test]
    fn watchdog_summary_with_files_returns_parsed_values() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let diag_dir = tmp.path().join("diagnostics");
        std::fs::create_dir_all(&diag_dir).expect("create diag dir");
        let now = unix_ms();

        std::fs::write(
            diag_dir.join(format!(
                "ui-freeze-{}-heartbeat-stall.json",
                now.saturating_sub(3 * 60_000)
            )),
            "{}",
        )
        .expect("write file 1");
        std::fs::write(
            diag_dir.join(format!(
                "frame-stall-{}-some-trigger.json",
                now.saturating_sub(2 * 60_000)
            )),
            "{}",
        )
        .expect("write file 2");
        std::fs::write(
            diag_dir.join(format!(
                "slow-refresh-{}-status.json",
                now.saturating_sub(60_000)
            )),
            "{}",
        )
        .expect("write file 3");

        let result = watchdog_summary_for_user_data_dir(tmp.path());

        assert!(!result
            .get("healthy")
            .and_then(|v| v.as_bool())
            .unwrap_or(true));
        // Last one is "status" (from slow-refresh-1700000002000-status.json)
        assert_eq!(
            result.get("last_incident_kind").and_then(|v| v.as_str()),
            Some("status")
        );
        assert_eq!(
            result
                .get("incident_count")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
            3
        );
        assert_eq!(
            result.get("last_incident_unix_ms").and_then(|v| v.as_u64()),
            Some(now.saturating_sub(60_000))
        );
        let expected_last_file = format!("slow-refresh-{}-status.json", now.saturating_sub(60_000));
        assert_eq!(
            result.get("last_incident_file").and_then(|v| v.as_str()),
            Some(expected_last_file.as_str())
        );
        let recent = result
            .get("recent_incidents")
            .and_then(|v| v.as_array())
            .expect("recent incidents");
        assert_eq!(recent.len(), 3);
        assert_eq!(
            recent[0].get("kind").and_then(|v| v.as_str()),
            Some("status")
        );
        let expected_recent_file =
            format!("slow-refresh-{}-status.json", now.saturating_sub(60_000));
        assert_eq!(
            recent[0].get("file").and_then(|v| v.as_str()),
            Some(expected_recent_file.as_str())
        );
        let activity_buckets = result
            .get("activity_buckets")
            .and_then(|v| v.as_array())
            .expect("activity buckets");
        assert_eq!(activity_buckets.len(), 144);
        assert_eq!(
            activity_buckets
                .iter()
                .map(|bucket| bucket
                    .get("count")
                    .and_then(|value| value.as_u64())
                    .unwrap_or(0))
                .sum::<u64>(),
            3
        );
    }

    #[test]
    fn watchdog_summary_derives_specific_operation_details() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let diag_dir = tmp.path().join("diagnostics");
        std::fs::create_dir_all(&diag_dir).expect("create diag dir");
        let now = unix_ms();

        write_watchdog_dump(
            &diag_dir,
            now.saturating_sub(10 * 60_000),
            "ui-freeze-",
            "slow-refresh",
            serde_json::json!({
                "recent_traces": [
                    {
                        "kind": "status_refresh_requested",
                        "fields": {
                            "active_page": "monitor",
                            "fields": {
                                "detail_level": "full",
                                "interactive": false,
                                "refresh_swap_status": false,
                                "source": "status_poll_interval"
                            },
                            "visible": true
                        },
                        "unix_ms": 1_700_000_001_000u64
                    }
                ],
                "snapshot": {
                    "active_page": "monitor",
                    "config_in_flight": false,
                    "last_heartbeat_unix_ms": 1_700_000_001_000u64,
                    "provider_switch_in_flight": false,
                    "status_in_flight": true,
                    "unresponsive_logged": false,
                    "unresponsive_since_unix_ms": 0,
                    "visible": true
                }
            }),
        );
        write_watchdog_dump(
            &diag_dir,
            now.saturating_sub(5 * 60_000),
            "ui-freeze-",
            "slow-invoke",
            serde_json::json!({
                "recent_traces": [
                    {
                        "kind": "invoke",
                        "fields": {
                            "active_page": "monitor",
                            "command": "get_status",
                            "elapsed_ms": 3199,
                            "error": null,
                            "ok": true,
                            "visible": true
                        },
                        "unix_ms": 1_700_000_002_000u64
                    }
                ],
                "snapshot": {
                    "active_page": "monitor",
                    "config_in_flight": false,
                    "last_heartbeat_unix_ms": 1_700_000_002_000u64,
                    "provider_switch_in_flight": false,
                    "status_in_flight": true,
                    "unresponsive_logged": false,
                    "unresponsive_since_unix_ms": 0,
                    "visible": true
                }
            }),
        );

        let result = watchdog_summary_for_user_data_dir(tmp.path());

        assert_eq!(
            result.get("last_incident_detail").and_then(|v| v.as_str()),
            Some("Status snapshot request too slow")
        );
        let recent = result
            .get("recent_incidents")
            .and_then(|v| v.as_array())
            .expect("recent incidents");
        assert_eq!(
            recent[0].get("detail").and_then(|v| v.as_str()),
            Some("Status snapshot request too slow")
        );
        assert_eq!(
            recent[1].get("detail").and_then(|v| v.as_str()),
            Some("Status poll interval refresh too slow")
        );
    }

    #[test]
    fn watchdog_summary_skips_files_without_json_extension() {
        // BUG-0003: files matching watchdog prefix but without .json extension
        // must not cause a panic (range-reversed slice or wrong trigger)
        let tmp = tempfile::tempdir().expect("tempdir");
        let diag_dir = tmp.path().join("diagnostics");
        std::fs::create_dir_all(&diag_dir).expect("create diag dir");
        let now = unix_ms();

        // These files match prefixes but are NOT valid watchdog dumps
        std::fs::write(
            diag_dir.join(format!("ui-freeze-{}-a", now.saturating_sub(2 * 60_000))),
            "panic content",
        )
        .expect("write file"); // too short, no .json
        std::fs::write(
            diag_dir.join(format!(
                "slow-refresh-{}-trigger",
                now.saturating_sub(60_000)
            )),
            "no json",
        )
        .expect("write file"); // no .json
        std::fs::write(
            diag_dir.join(format!(
                "ui-freeze-{}-heartbeat-stall.json",
                now.saturating_sub(30_000)
            )),
            "{}",
        )
        .expect("write file"); // valid

        let result = watchdog_summary_for_user_data_dir(tmp.path());

        // Only the valid .json file should be counted
        assert_eq!(
            result
                .get("incident_count")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
            1
        );
        assert_eq!(
            result.get("last_incident_kind").and_then(|v| v.as_str()),
            Some("heartbeat-stall")
        );
    }

    #[test]
    fn watchdog_summary_ignores_incidents_outside_activity_window() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let diag_dir = tmp.path().join("diagnostics");
        std::fs::create_dir_all(&diag_dir).expect("create diag dir");
        let now = unix_ms();

        std::fs::write(
            diag_dir.join(format!(
                "ui-freeze-{}-heartbeat-stall.json",
                now.saturating_sub(13 * 60 * 60_000)
            )),
            "{}",
        )
        .expect("write file");

        let result = watchdog_summary_for_user_data_dir(tmp.path());

        assert!(result
            .get("healthy")
            .and_then(|v| v.as_bool())
            .unwrap_or(false));
        assert_eq!(
            result
                .get("incident_count")
                .and_then(|v| v.as_u64())
                .unwrap_or(1),
            0
        );
        assert!(result
            .get("last_incident_kind")
            .and_then(|v| v.as_str())
            .is_none());
        assert_eq!(
            result
                .get("recent_incidents")
                .and_then(|v| v.as_array())
                .map(|v| v.len())
                .unwrap_or(1),
            0
        );
        assert_eq!(
            result
                .get("activity_buckets")
                .and_then(|v| v.as_array())
                .map(|v| {
                    v.iter()
                        .map(|bucket| {
                            bucket
                                .get("count")
                                .and_then(|value| value.as_u64())
                                .unwrap_or(0)
                        })
                        .sum::<u64>()
                })
                .unwrap_or(1),
            0
        );
    }

    #[test]
    fn watchdog_summary_marks_recent_history_healthy_when_latest_bucket_is_clear() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let diag_dir = tmp.path().join("diagnostics");
        std::fs::create_dir_all(&diag_dir).expect("create diag dir");
        let now = unix_ms();

        std::fs::write(
            diag_dir.join(format!(
                "ui-freeze-{}-heartbeat-stall.json",
                now.saturating_sub(7 * 60_000)
            )),
            "{}",
        )
        .expect("write file 1");
        std::fs::write(
            diag_dir.join(format!(
                "slow-refresh-{}-status.json",
                now.saturating_sub(6 * 60_000)
            )),
            "{}",
        )
        .expect("write file 2");

        let result = watchdog_summary_for_user_data_dir(tmp.path());

        assert_eq!(result.get("healthy").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            result
                .get("incident_count")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
            2
        );
        assert_eq!(
            result
                .get("activity_buckets")
                .and_then(|v| v.as_array())
                .and_then(|buckets| buckets.last())
                .and_then(|bucket| bucket.get("count"))
                .and_then(|count| count.as_u64()),
            Some(0)
        );
    }

    #[test]
    fn local_diagnostics_snapshot_includes_requested_domains() {
        let snapshot = local_diagnostics_snapshot(
            4000,
            &[
                "watchdog".to_string(),
                "webtransport".to_string(),
                "tailscale".to_string(),
            ],
        );

        let domains = snapshot.as_object().expect("snapshot object");
        assert!(domains.contains_key("watchdog"));
        assert!(domains.contains_key("webtransport"));
        assert!(domains.contains_key("tailscale"));
    }
}
