use axum::extract::{Json, State};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use serde::{Deserialize, Serialize};

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

pub async fn lan_sync_diagnostics_http(
    State(gateway): State<crate::orchestrator::gateway::GatewayState>,
    headers: HeaderMap,
    Json(packet): Json<LanDiagnosticsRequestPacket>,
) -> impl IntoResponse {
    if let Err(err) = authorize_lan_sync_http_request(&gateway, &headers, &packet.node_id) {
        return err.into_response();
    }
    let domains = get_local_diagnostics(&packet.domains);
    let node = gateway
        .secrets
        .get_lan_node_identity()
        .unwrap_or_else(|| crate::lan_sync::LanNodeIdentity {
            node_id: String::new(),
            node_name: String::new(),
        });
    Json(LanDiagnosticsResponsePacket {
        version: 1,
        node_id: node.node_id,
        node_name: node.node_name,
        sent_at_unix_ms: crate::orchestrator::store::unix_ms(),
        domains,
    })
    .into_response()
}

fn get_local_diagnostics(requested_domains: &[String]) -> serde_json::Value {
    let mut domains = serde_json::Map::new();

    let watchdog_summary = watchdog_summary();
    if requested_domains.is_empty() || requested_domains.iter().any(|d| d == "watchdog") {
        domains.insert(
            "watchdog".to_string(),
            serde_json::to_value(watchdog_summary).unwrap_or(serde_json::Value::Null),
        );
    }

    serde_json::Value::Object(domains)
}

/// Reads watchdog-related dump files from the diagnostics directory and returns a
/// normalized summary.
pub fn watchdog_summary() -> serde_json::Value {
    let Some(diag_dir) = current_diagnostics_dir() else {
        return serde_json::json!({
            "healthy": true,
            "last_incident_kind": serde_json::Value::Null,
            "incident_count": 0,
        });
    };

    let entries = match std::fs::read_dir(&diag_dir) {
        Ok(entries) => entries,
        Err(_) => {
            return serde_json::json!({
                "healthy": true,
                "last_incident_kind": serde_json::Value::Null,
                "incident_count": 0,
            });
        }
    };

    let mut watchdog_files: Vec<(u64, String, String)> = Vec::new();
    for entry in entries.filter_map(|e| e.ok()) {
        let file_name = entry.file_name();
        let file_name_str = file_name.to_string_lossy();
        if let Some(prefix) = WATCHDOG_DUMP_PREFIXES.iter().find(|p| file_name_str.starts_with(*p)) {
            // Extract timestamp from filename: prefix{timestamp}-trigger.json
            // e.g. "ui-freeze-1700000000000-heartbeat-stall.json"
            let after_prefix = &file_name_str[(*prefix).len()..];
            if let Some(dash_pos) = after_prefix.find('-') {
                if let Ok(ts) = after_prefix[..dash_pos].parse::<u64>() {
                    let trigger_end = file_name_str.len() - 5; // strip ".json"
                    let trigger = &file_name_str[(*prefix).len() + dash_pos + 1..trigger_end];
                    watchdog_files.push((ts, trigger.to_string(), file_name_str.to_string()));
                }
            }
        }
    }

    if watchdog_files.is_empty() {
        return serde_json::json!({
            "healthy": true,
            "last_incident_kind": serde_json::Value::Null,
            "incident_count": 0,
        });
    }

    watchdog_files.sort_by_key(|(ts, _, _)| *ts);
    let last = watchdog_files.last().map(|(_, t, _)| t.clone()).unwrap_or_default();
    let incident_count = watchdog_files.len() as u32;

    serde_json::json!({
        "healthy": false,
        "last_incident_kind": last,
        "incident_count": incident_count,
    })
}

#[cfg(test)]
mod tests {
    use super::watchdog_summary;

    #[test]
    fn watchdog_summary_no_dir_returns_healthy() {
        // Set an invalid path so current_diagnostics_dir returns None
        std::env::set_var("API_ROUTER_USER_DATA_DIR", "/nonexistent/path");
        let result = watchdog_summary();
        std::env::remove_var("API_ROUTER_USER_DATA_DIR");

        assert!(result.get("healthy").and_then(|v| v.as_bool()).unwrap_or(false));
        assert!(result.get("last_incident_kind").unwrap().is_null());
        assert_eq!(result.get("incident_count").and_then(|v| v.as_u64()).unwrap_or(1), 0);
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

        assert!(result.get("healthy").and_then(|v| v.as_bool()).unwrap_or(false));
        assert!(result.get("last_incident_kind").unwrap().is_null());
        assert_eq!(result.get("incident_count").and_then(|v| v.as_u64()).unwrap_or(1), 0);
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

        assert!(!result.get("healthy").and_then(|v| v.as_bool()).unwrap_or(true));
        // Last one is "status" (from slow-refresh-1700000002000-status.json)
        assert_eq!(
            result
                .get("last_incident_kind")
                .and_then(|v| v.as_str()),
            Some("status")
        );
        assert_eq!(
            result.get("incident_count").and_then(|v| v.as_u64()).unwrap_or(0),
            3
        );
    }
}
