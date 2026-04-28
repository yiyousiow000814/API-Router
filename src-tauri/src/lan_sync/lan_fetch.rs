use axum::extract::{Json, State};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use super::watchdog_incidents::{
    classify_watchdog_incident, default_watchdog_incident_classification,
    describe_watchdog_incident, WatchdogIncidentSeverity,
};
use crate::diagnostics::current_diagnostics_dir;
use crate::diagnostics::WATCHDOG_DUMP_PREFIXES;
use crate::lan_sync::authorize_lan_sync_http_request;

const WATCHDOG_ACTIVITY_WINDOW_MINUTES: u64 = 12 * 60;
const WATCHDOG_ACTIVITY_BUCKET_MINUTES: u64 = 5;
const WATCHDOG_ACTIVITY_WINDOW_MS: u64 = WATCHDOG_ACTIVITY_WINDOW_MINUTES * 60_000;
const WATCHDOG_ACTIVITY_BUCKET_MS: u64 = WATCHDOG_ACTIVITY_BUCKET_MINUTES * 60_000;
const WATCHDOG_ACTIVITY_BUCKETS: usize =
    (WATCHDOG_ACTIVITY_WINDOW_MS / WATCHDOG_ACTIVITY_BUCKET_MS) as usize;

#[derive(Debug, Clone)]
struct WatchdogFileEntry {
    ts: u64,
    trigger: String,
    prefix: String,
    file_name: String,
}

#[derive(Debug, Clone)]
struct WatchdogIncidentRecord {
    ts: u64,
    trigger: String,
    file_name: String,
    detail: Option<String>,
    severity: WatchdogIncidentSeverity,
    impact: &'static str,
    actionable: bool,
}

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

fn merge_live_watchdog_state(
    snapshot: &mut serde_json::Value,
    live_watchdog: &crate::app_state::UiWatchdogLiveSnapshot,
) {
    let Some(domains) = snapshot.as_object_mut() else {
        return;
    };
    let Some(watchdog) = domains
        .get_mut("watchdog")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };
    watchdog.insert(
        "live_frontend".to_string(),
        serde_json::to_value(&live_watchdog.frontend).unwrap_or(serde_json::Value::Null),
    );
    watchdog.insert(
        "live_backend_status".to_string(),
        serde_json::to_value(&live_watchdog.backend_status).unwrap_or(serde_json::Value::Null),
    );
}

pub(crate) fn local_diagnostics_snapshot(
    listen_port: u16,
    requested_domains: &[String],
    store: Option<&crate::orchestrator::store::Store>,
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

    if requested("events") {
        let snapshot = store
            .map(|store| {
                store.event_spam_diagnostics_snapshot(
                    crate::orchestrator::store::unix_ms(),
                    6 * 60 * 60_000,
                )
            })
            .unwrap_or_else(|| serde_json::json!({ "available": false }));
        domains.insert("events".to_string(), snapshot);
    }

    let mut snapshot = serde_json::Value::Object(domains);
    if let Some(live_watchdog) = crate::lan_sync::current_ui_watchdog_live_snapshot(
        listen_port,
        crate::orchestrator::store::unix_ms(),
    ) {
        merge_live_watchdog_state(&mut snapshot, &live_watchdog);
    }
    snapshot
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
    let store = gateway.store.clone();
    let domains_snapshot = tauri::async_runtime::spawn_blocking(move || {
        local_diagnostics_snapshot(listen_port, &domains, Some(&store))
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

    let mut watchdog_files: Vec<WatchdogFileEntry> = Vec::new();
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
                        watchdog_files.push(WatchdogFileEntry {
                            ts,
                            trigger: trigger.to_string(),
                            prefix: prefix.trim_end_matches('-').to_string(),
                            file_name: file_name_str.to_string(),
                        });
                    }
                }
            }
        }
    }

    if watchdog_files.is_empty() {
        return empty_watchdog_summary(empty_buckets);
    }

    watchdog_files.sort_by_key(|entry| entry.ts);
    let activity_cutoff = now_ms.saturating_sub(WATCHDOG_ACTIVITY_WINDOW_MS);
    let activity_watchdog_files: Vec<WatchdogFileEntry> = watchdog_files
        .iter()
        .filter(|entry| entry.ts >= activity_cutoff)
        .cloned()
        .collect();
    let activity_records: Vec<WatchdogIncidentRecord> = activity_watchdog_files
        .iter()
        .map(|entry| read_watchdog_incident_record(&diag_dir, entry))
        .collect();
    let activity_buckets = build_watchdog_activity_buckets(now_ms, &activity_records);
    let latest_bucket_count = activity_buckets
        .last()
        .and_then(|bucket| bucket.get("count"))
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    let is_healthy = latest_bucket_count == 0;

    if activity_records.is_empty() {
        return empty_watchdog_summary(activity_buckets);
    }

    let actionable_records: Vec<&WatchdogIncidentRecord> = activity_records
        .iter()
        .filter(|record| record.actionable)
        .collect();
    let last_actionable = actionable_records.last().copied();
    let last_signal = activity_records.last();
    let incident_count = actionable_records.len() as u32;
    let signal_count = activity_records.len() as u32;
    let background_signal_count = activity_records
        .iter()
        .filter(|record| record.severity == WatchdogIncidentSeverity::Info)
        .count() as u32;
    let warning_count = activity_records
        .iter()
        .filter(|record| record.severity == WatchdogIncidentSeverity::Warning)
        .count() as u32;
    let error_count = activity_records
        .iter()
        .filter(|record| record.severity == WatchdogIncidentSeverity::Error)
        .count() as u32;
    let critical_count = activity_records
        .iter()
        .filter(|record| record.severity == WatchdogIncidentSeverity::Critical)
        .count() as u32;
    let recent_incidents: Vec<serde_json::Value> = actionable_records
        .iter()
        .rev()
        .take(5)
        .map(|record| watchdog_incident_json(record))
        .collect();
    let recent_signals: Vec<serde_json::Value> = activity_records
        .iter()
        .rev()
        .take(5)
        .map(watchdog_incident_json)
        .collect();

    serde_json::json!({
        "healthy": is_healthy,
        "last_incident_kind": last_actionable.map(|record| record.trigger.as_str()),
        "last_incident_unix_ms": last_actionable.map(|record| record.ts),
        "last_incident_file": last_actionable.map(|record| record.file_name.as_str()),
        "last_incident_detail": last_actionable.and_then(|record| record.detail.as_deref()),
        "last_incident_severity": last_actionable.map(|record| record.severity.as_str()),
        "last_incident_impact": last_actionable.map(|record| record.impact),
        "last_signal_kind": last_signal.map(|record| record.trigger.as_str()),
        "last_signal_unix_ms": last_signal.map(|record| record.ts),
        "last_signal_file": last_signal.map(|record| record.file_name.as_str()),
        "last_signal_detail": last_signal.and_then(|record| record.detail.as_deref()),
        "last_signal_severity": last_signal.map(|record| record.severity.as_str()),
        "last_signal_impact": last_signal.map(|record| record.impact),
        "incident_count": incident_count,
        "signal_count": signal_count,
        "background_signal_count": background_signal_count,
        "warning_count": warning_count,
        "error_count": error_count,
        "critical_count": critical_count,
        "recent_incidents": recent_incidents,
        "recent_signals": recent_signals,
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
        "last_incident_severity": serde_json::Value::Null,
        "last_incident_impact": serde_json::Value::Null,
        "last_signal_kind": serde_json::Value::Null,
        "last_signal_unix_ms": serde_json::Value::Null,
        "last_signal_file": serde_json::Value::Null,
        "last_signal_detail": serde_json::Value::Null,
        "last_signal_severity": serde_json::Value::Null,
        "last_signal_impact": serde_json::Value::Null,
        "incident_count": 0,
        "signal_count": 0,
        "background_signal_count": 0,
        "warning_count": 0,
        "error_count": 0,
        "critical_count": 0,
        "recent_incidents": [],
        "recent_signals": [],
        "health_window_minutes": WATCHDOG_ACTIVITY_BUCKET_MINUTES,
        "activity_window_minutes": WATCHDOG_ACTIVITY_WINDOW_MINUTES,
        "activity_bucket_minutes": WATCHDOG_ACTIVITY_BUCKET_MINUTES,
        "activity_buckets": activity_buckets,
    })
}

fn build_watchdog_activity_buckets(
    now_ms: u64,
    incidents: &[WatchdogIncidentRecord],
) -> Vec<serde_json::Value> {
    let window_start = now_ms.saturating_sub(WATCHDOG_ACTIVITY_WINDOW_MS);
    let bucket_count = WATCHDOG_ACTIVITY_BUCKETS;
    let mut incident_counts = vec![0u64; bucket_count];
    let mut signal_counts = vec![0u64; bucket_count];
    let mut background_counts = vec![0u64; bucket_count];
    let mut warning_counts = vec![0u64; bucket_count];
    let mut error_counts = vec![0u64; bucket_count];
    let mut critical_counts = vec![0u64; bucket_count];

    for incident in incidents {
        if incident.ts < window_start {
            continue;
        }
        let bucket_index = ((incident.ts - window_start) / WATCHDOG_ACTIVITY_BUCKET_MS) as usize;
        let clamped_index = bucket_index.min(bucket_count.saturating_sub(1));
        signal_counts[clamped_index] += 1;
        if incident.actionable {
            incident_counts[clamped_index] += 1;
        } else {
            background_counts[clamped_index] += 1;
        }
        match incident.severity {
            WatchdogIncidentSeverity::Info => {}
            WatchdogIncidentSeverity::Warning => warning_counts[clamped_index] += 1,
            WatchdogIncidentSeverity::Error => error_counts[clamped_index] += 1,
            WatchdogIncidentSeverity::Critical => critical_counts[clamped_index] += 1,
        }
    }

    incident_counts
        .iter()
        .enumerate()
        .map(|(index, count)| {
            let bucket_start = window_start + (index as u64 * WATCHDOG_ACTIVITY_BUCKET_MS);
            serde_json::json!({
                "bucket_start_unix_ms": bucket_start,
                "bucket_end_unix_ms": bucket_start + WATCHDOG_ACTIVITY_BUCKET_MS,
                "count": *count,
                "signal_count": signal_counts[index],
                "background_signal_count": background_counts[index],
                "warning_count": warning_counts[index],
                "error_count": error_counts[index],
                "critical_count": critical_counts[index],
            })
        })
        .collect()
}

fn read_watchdog_incident_record(
    diag_dir: &std::path::Path,
    entry: &WatchdogFileEntry,
) -> WatchdogIncidentRecord {
    let path = diag_dir.join(&entry.file_name);
    let cache_key = path.to_string_lossy().to_string();
    {
        let cache = match watchdog_record_cache().lock() {
            Ok(guard) => guard,
            Err(err) => err.into_inner(),
        };
        if let Some(record) = cache.get(&cache_key) {
            return record.clone();
        }
    }

    let payload = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let detail = payload
        .as_ref()
        .and_then(|payload| describe_watchdog_incident(&entry.prefix, &entry.trigger, payload));
    let classification = payload
        .as_ref()
        .map(|payload| classify_watchdog_incident(&entry.trigger, payload))
        .unwrap_or_else(|| default_watchdog_incident_classification(&entry.trigger));
    let record = WatchdogIncidentRecord {
        ts: entry.ts,
        trigger: entry.trigger.clone(),
        file_name: entry.file_name.clone(),
        detail,
        severity: classification.severity,
        impact: classification.impact,
        actionable: classification.severity.is_actionable(),
    };
    let mut cache = match watchdog_record_cache().lock() {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    };
    cache.insert(cache_key, record.clone());
    record
}

fn watchdog_record_cache() -> &'static Mutex<HashMap<String, WatchdogIncidentRecord>> {
    static CACHE: OnceLock<Mutex<HashMap<String, WatchdogIncidentRecord>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn watchdog_incident_json(record: &WatchdogIncidentRecord) -> serde_json::Value {
    serde_json::json!({
        "unix_ms": record.ts,
        "kind": record.trigger.as_str(),
        "file": record.file_name.as_str(),
        "detail": record.detail.as_deref(),
        "severity": record.severity.as_str(),
        "impact": record.impact,
        "actionable": record.actionable,
    })
}

#[cfg(test)]
mod tests {
    use super::local_diagnostics_snapshot;
    use super::watchdog_summary;
    use crate::app_state::UiWatchdogState;
    use crate::lan_sync::watchdog_incidents::describe_watchdog_incident;
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
    fn describe_watchdog_incident_distinguishes_backend_status_stall() {
        let payload = serde_json::json!({
            "snapshot": {
                "status_in_flight": true,
                "backend_status": {
                    "in_flight": true,
                    "stalled": true,
                    "phase": "client_sessions"
                }
            },
            "recent_traces": []
        });

        let detail = describe_watchdog_incident("ui-freeze", "heartbeat-stall", &payload);

        assert_eq!(
            detail.as_deref(),
            Some("UI heartbeat stalled after backend status refresh stopped making progress at Client Sessions")
        );
    }

    #[test]
    fn describe_watchdog_incident_includes_backend_pipeline_event() {
        let payload = serde_json::json!({
            "pipeline_event": {
                "route": "/codex/version-info",
                "workspace": "wsl2",
                "stage": "runtime_detect",
                "elapsedMs": 1273
            },
            "recent_traces": []
        });

        let detail = describe_watchdog_incident("ui-freeze", "backend-pipeline", &payload);

        assert_eq!(
            detail.as_deref(),
            Some("WSL2 runtime_detect took 1273ms in /codex/version-info")
        );
    }

    #[test]
    fn describe_watchdog_incident_uses_backend_pipeline_rebuild_time() {
        let payload = serde_json::json!({
            "pipeline_event": {
                "route": "/codex/threads",
                "workspace": "wsl2",
                "stage": "gateway_handler",
                "elapsedMs": 0,
                "rebuildMs": 1283
            },
            "recent_traces": []
        });

        let detail = describe_watchdog_incident("ui-freeze", "backend-pipeline", &payload);

        assert_eq!(
            detail.as_deref(),
            Some("WSL2 gateway_handler rebuild took 1283ms in /codex/threads")
        );
    }

    #[test]
    fn watchdog_summary_classifies_background_pipeline_signals_as_info() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let diag_dir = tmp.path().join("diagnostics");
        std::fs::create_dir_all(&diag_dir).expect("create diag dir");
        let now = unix_ms();

        write_watchdog_dump(
            &diag_dir,
            now.saturating_sub(60_000),
            "ui-freeze-",
            "backend-pipeline",
            serde_json::json!({
                "pipeline_event": {
                    "route": "/codex/version-info",
                    "workspace": "wsl2",
                    "stage": "runtime_detect",
                    "source": "codex-version-command",
                    "elapsedMs": 1147,
                    "ok": true
                },
                "recent_traces": []
            }),
        );
        write_watchdog_dump(
            &diag_dir,
            now.saturating_sub(30_000),
            "ui-freeze-",
            "backend-pipeline",
            serde_json::json!({
                "pipeline_event": {
                    "route": "codex-app-server-rpc",
                    "workspace": "windows",
                    "stage": "app_server_rpc",
                    "method": "account/rateLimits/read",
                    "elapsedMs": 1099,
                    "ok": true
                },
                "recent_traces": []
            }),
        );

        let result = watchdog_summary_for_user_data_dir(tmp.path());

        assert_eq!(
            result
                .get("incident_count")
                .and_then(|value| value.as_u64())
                .unwrap_or(99),
            0
        );
        assert_eq!(
            result
                .get("signal_count")
                .and_then(|value| value.as_u64())
                .unwrap_or(0),
            2
        );
        assert_eq!(
            result
                .get("background_signal_count")
                .and_then(|value| value.as_u64())
                .unwrap_or(0),
            2
        );
        assert!(result.get("last_incident_kind").unwrap().is_null());
        assert_eq!(
            result
                .get("recent_incidents")
                .and_then(|value| value.as_array())
                .map(Vec::len)
                .unwrap_or(99),
            0
        );
        let recent_signals = result
            .get("recent_signals")
            .and_then(|value| value.as_array())
            .expect("recent signals");
        assert_eq!(recent_signals.len(), 2);
        assert_eq!(
            recent_signals[0]
                .get("severity")
                .and_then(|value| value.as_str()),
            Some("info")
        );
        assert_eq!(
            recent_signals[0]
                .get("impact")
                .and_then(|value| value.as_str()),
            Some("background")
        );
    }

    #[test]
    fn watchdog_summary_keeps_visible_thread_fetch_delay_as_warning() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let diag_dir = tmp.path().join("diagnostics");
        std::fs::create_dir_all(&diag_dir).expect("create diag dir");
        let now = unix_ms();

        write_watchdog_dump(
            &diag_dir,
            now.saturating_sub(30_000),
            "ui-freeze-",
            "local-task",
            serde_json::json!({
                "recent_traces": [
                    {
                        "kind": "local_task",
                        "fields": {
                            "active_page": "codex-web",
                            "command": "thread refresh fetch",
                            "elapsed_ms": 1732,
                            "visible": true,
                            "fields": {
                                "workspace": "windows",
                                "headersMs": 1730,
                                "bodyReadMs": 1,
                                "parseMs": 1
                            }
                        },
                        "unix_ms": now.saturating_sub(30_000)
                    }
                ],
                "snapshot": {
                    "active_page": "codex-web",
                    "visible": true
                }
            }),
        );

        let result = watchdog_summary_for_user_data_dir(tmp.path());

        assert_eq!(
            result
                .get("incident_count")
                .and_then(|value| value.as_u64())
                .unwrap_or(0),
            1
        );
        let recent = result
            .get("recent_incidents")
            .and_then(|value| value.as_array())
            .expect("recent incidents");
        assert_eq!(
            recent[0].get("severity").and_then(|value| value.as_str()),
            Some("warning")
        );
        assert_eq!(
            recent[0].get("impact").and_then(|value| value.as_str()),
            Some("transport")
        );
        assert_eq!(
            recent[0]
                .get("detail")
                .and_then(|value| value.as_str())
                .map(|value| value.contains("waited 1730ms for Windows headers")),
            Some(true)
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
        crate::lan_sync::register_ui_watchdog_state(4000, UiWatchdogState::default());
        let store_dir = tempfile::tempdir().expect("tempdir");
        let store = crate::orchestrator::store::Store::open(store_dir.path()).expect("store");
        let snapshot = local_diagnostics_snapshot(
            4000,
            &[
                "watchdog".to_string(),
                "webtransport".to_string(),
                "tailscale".to_string(),
                "events".to_string(),
            ],
            Some(&store),
        );

        let domains = snapshot.as_object().expect("snapshot object");
        assert!(domains.contains_key("watchdog"));
        assert!(domains.contains_key("webtransport"));
        assert!(domains.contains_key("tailscale"));
        assert!(domains.contains_key("events"));
    }

    #[test]
    fn local_diagnostics_snapshot_merges_live_watchdog_state() {
        let watchdog = UiWatchdogState::default();
        watchdog.record_heartbeat("dashboard", true, true, false, false, 1_000);
        watchdog.record_backend_status_started("dashboard", 1_100);
        watchdog.record_backend_status_progress("client_sessions", 1_200);
        crate::lan_sync::register_ui_watchdog_state(4000, watchdog);

        let snapshot = local_diagnostics_snapshot(4000, &["watchdog".to_string()], None);

        let watchdog = snapshot
            .get("watchdog")
            .and_then(serde_json::Value::as_object)
            .expect("watchdog object");
        assert_eq!(
            watchdog
                .get("live_frontend")
                .and_then(|value| value.get("active_page"))
                .and_then(serde_json::Value::as_str),
            Some("dashboard")
        );
        assert_eq!(
            watchdog
                .get("live_backend_status")
                .and_then(|value| value.get("phase"))
                .and_then(serde_json::Value::as_str),
            Some("client_sessions")
        );
    }

    #[test]
    fn local_diagnostics_snapshot_uses_watchdog_for_requested_listen_port() {
        let watchdog_4000 = UiWatchdogState::default();
        watchdog_4000.record_heartbeat("dashboard", true, true, false, false, 1_000);
        crate::lan_sync::register_ui_watchdog_state(4000, watchdog_4000);

        let watchdog_5000 = UiWatchdogState::default();
        watchdog_5000.record_heartbeat("requests", true, false, false, false, 2_000);
        crate::lan_sync::register_ui_watchdog_state(5000, watchdog_5000);

        let snapshot_4000 = local_diagnostics_snapshot(4000, &["watchdog".to_string()], None);
        let snapshot_5000 = local_diagnostics_snapshot(5000, &["watchdog".to_string()], None);

        let watchdog_4000 = snapshot_4000
            .get("watchdog")
            .and_then(serde_json::Value::as_object)
            .expect("watchdog 4000 object");
        let watchdog_5000 = snapshot_5000
            .get("watchdog")
            .and_then(serde_json::Value::as_object)
            .expect("watchdog 5000 object");

        assert_eq!(
            watchdog_4000
                .get("live_frontend")
                .and_then(|value| value.get("active_page"))
                .and_then(serde_json::Value::as_str),
            Some("dashboard")
        );
        assert_eq!(
            watchdog_5000
                .get("live_frontend")
                .and_then(|value| value.get("active_page"))
                .and_then(serde_json::Value::as_str),
            Some("requests")
        );
    }

    #[test]
    fn describe_watchdog_incident_reports_backend_status_stall_trigger() {
        let payload = serde_json::json!({
            "snapshot": {
                "backend_status": {
                    "phase": "router_snapshot"
                }
            },
            "recent_traces": []
        });

        let detail = describe_watchdog_incident("ui-freeze", "backend-status-stall", &payload);

        assert_eq!(
            detail.as_deref(),
            Some("Backend status refresh stalled at Router Snapshot")
        );
    }
}
