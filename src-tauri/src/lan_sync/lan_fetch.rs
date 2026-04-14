use axum::extract::{Json, State};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::diagnostics::current_diagnostics_dir;
use crate::diagnostics::WATCHDOG_DUMP_PREFIXES;
use crate::lan_sync::authorize_lan_sync_http_request;

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
    Json(LanDiagnosticsResponsePacket {
        version: 1,
        node_id: node.node_id,
        node_name: node.node_name,
        sent_at_unix_ms: crate::orchestrator::store::unix_ms(),
        domains: local_diagnostics_snapshot(listen_port, &packet.domains),
    })
    .into_response()
}

/// Reads watchdog-related dump files from the diagnostics directory and returns a
/// normalized summary.
pub fn watchdog_summary() -> serde_json::Value {
    let Some(diag_dir) = current_diagnostics_dir() else {
        return serde_json::json!({
            "healthy": true,
            "last_incident_kind": serde_json::Value::Null,
            "last_incident_unix_ms": serde_json::Value::Null,
            "last_incident_file": serde_json::Value::Null,
            "incident_count": 0,
            "recent_incidents": [],
        });
    };

    let entries = match std::fs::read_dir(&diag_dir) {
        Ok(entries) => entries,
        Err(_) => {
            return serde_json::json!({
                "healthy": true,
                "last_incident_kind": serde_json::Value::Null,
                "last_incident_unix_ms": serde_json::Value::Null,
                "last_incident_file": serde_json::Value::Null,
                "incident_count": 0,
                "recent_incidents": [],
            });
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
        return serde_json::json!({
            "healthy": true,
            "last_incident_kind": serde_json::Value::Null,
            "last_incident_unix_ms": serde_json::Value::Null,
            "last_incident_file": serde_json::Value::Null,
            "incident_count": 0,
            "recent_incidents": [],
        });
    }

    watchdog_files.sort_by_key(|(ts, _, _, _)| *ts);
    let (last_ts, last_trigger, last_prefix, last_file) = watchdog_files
        .last()
        .cloned()
        .unwrap_or_else(|| (0, String::new(), String::new(), String::new()));
    let incident_count = watchdog_files.len() as u32;
    let recent_incidents: Vec<serde_json::Value> = watchdog_files
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
        "healthy": false,
        "last_incident_kind": last_trigger,
        "last_incident_unix_ms": last_ts,
        "last_incident_file": last_file,
        "last_incident_detail": last_incident_detail,
        "incident_count": incident_count,
        "recent_incidents": recent_incidents,
    })
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

    #[test]
    fn watchdog_summary_no_dir_returns_healthy() {
        // Set an invalid path so current_diagnostics_dir returns None
        std::env::set_var("API_ROUTER_USER_DATA_DIR", "/nonexistent/path");
        let result = watchdog_summary();
        std::env::remove_var("API_ROUTER_USER_DATA_DIR");

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
    }

    #[test]
    fn watchdog_summary_no_watchdog_files_returns_healthy() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let diag_dir = tmp.path().join("diagnostics");
        std::fs::create_dir_all(&diag_dir).expect("create diag dir");

        // Create a non-watchdog file
        std::fs::write(diag_dir.join("some-other-file.json"), "{}").expect("write file");

        std::env::set_var("API_ROUTER_USER_DATA_DIR", tmp.path());
        let result = watchdog_summary();
        std::env::remove_var("API_ROUTER_USER_DATA_DIR");

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
    }

    #[test]
    fn watchdog_summary_with_files_returns_parsed_values() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let diag_dir = tmp.path().join("diagnostics");
        std::fs::create_dir_all(&diag_dir).expect("create diag dir");

        std::fs::write(
            diag_dir.join("ui-freeze-1700000000000-heartbeat-stall.json"),
            "{}",
        )
        .expect("write file 1");
        std::fs::write(
            diag_dir.join("frame-stall-1700000001000-some-trigger.json"),
            "{}",
        )
        .expect("write file 2");
        std::fs::write(
            diag_dir.join("slow-refresh-1700000002000-status.json"),
            "{}",
        )
        .expect("write file 3");

        std::env::set_var("API_ROUTER_USER_DATA_DIR", tmp.path());
        let result = watchdog_summary();
        std::env::remove_var("API_ROUTER_USER_DATA_DIR");

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
            Some(1_700_000_002_000u64)
        );
        assert_eq!(
            result.get("last_incident_file").and_then(|v| v.as_str()),
            Some("slow-refresh-1700000002000-status.json")
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
        assert_eq!(
            recent[0].get("file").and_then(|v| v.as_str()),
            Some("slow-refresh-1700000002000-status.json")
        );
    }

    #[test]
    fn watchdog_summary_derives_specific_operation_details() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let diag_dir = tmp.path().join("diagnostics");
        std::fs::create_dir_all(&diag_dir).expect("create diag dir");

        std::fs::write(
            diag_dir.join("ui-freeze-1700000001000-slow-refresh.json"),
            serde_json::to_vec(&serde_json::json!({
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
            }))
            .expect("encode payload"),
        )
        .expect("write file 1");
        std::fs::write(
            diag_dir.join("ui-freeze-1700000002000-slow-invoke.json"),
            serde_json::to_vec(&serde_json::json!({
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
            }))
            .expect("encode payload"),
        )
        .expect("write file 2");

        std::env::set_var("API_ROUTER_USER_DATA_DIR", tmp.path());
        let result = watchdog_summary();
        std::env::remove_var("API_ROUTER_USER_DATA_DIR");

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

        // These files match prefixes but are NOT valid watchdog dumps
        std::fs::write(diag_dir.join("ui-freeze-1700000000000-a"), "panic content")
            .expect("write file"); // too short, no .json
        std::fs::write(
            diag_dir.join("slow-refresh-1700000001000-trigger"),
            "no json",
        )
        .expect("write file"); // no .json
        std::fs::write(
            diag_dir.join("ui-freeze-1700000002000-heartbeat-stall.json"),
            "{}",
        )
        .expect("write file"); // valid

        std::env::set_var("API_ROUTER_USER_DATA_DIR", tmp.path());
        let result = watchdog_summary();
        std::env::remove_var("API_ROUTER_USER_DATA_DIR");

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
