use crate::diagnostics::{current_diagnostics_dir, ensure_parent_dir};
use crate::orchestrator::store::unix_ms;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::{mpsc, Mutex, OnceLock};

const PIPELINE_EVENTS_FILE: &str = "codex_web_pipeline.ndjson";
const PIPELINE_MAX_BYTES: usize = 2 * 1024 * 1024;
const PIPELINE_WATCHDOG_SLOW_AFTER_MS: u64 = 750;
const PIPELINE_WATCHDOG_COOLDOWN_MS: u64 = 30_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexWebPipelineEvent {
    pub route: String,
    pub workspace: String,
    pub stage: String,
    pub elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_code: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub referer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_addr: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_hit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refreshing: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rebuild_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl CodexWebPipelineEvent {
    pub(crate) fn new(route: &str, workspace: &str, stage: &str, elapsed_ms: u64) -> Self {
        Self {
            route: route.to_string(),
            workspace: workspace.to_string(),
            stage: stage.to_string(),
            elapsed_ms,
            request_id: current_request_id(),
            direction: None,
            method: None,
            path: None,
            status_code: None,
            request_bytes: None,
            response_bytes: None,
            client_type: None,
            user_agent: None,
            origin: None,
            referer: None,
            remote_addr: None,
            source: None,
            transport: None,
            cache_hit: None,
            refreshing: None,
            force: None,
            item_count: None,
            rebuild_ms: None,
            ok: None,
            detail: None,
        }
    }
}

tokio::task_local! {
    static CODEX_WEB_REQUEST_ID: String;
}

#[derive(Debug)]
struct PipelineWriteJob {
    path: PathBuf,
    line: String,
}

pub(crate) fn current_request_id() -> Option<String> {
    CODEX_WEB_REQUEST_ID.try_with(Clone::clone).ok()
}

pub(crate) async fn scope_request_id<F, T>(request_id: String, future: F) -> T
where
    F: std::future::Future<Output = T>,
{
    CODEX_WEB_REQUEST_ID.scope(request_id, future).await
}

pub(crate) fn elapsed_ms_u64(started: std::time::Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

pub(crate) fn append_pipeline_event(event: CodexWebPipelineEvent) {
    let Some(dir) = current_diagnostics_dir() else {
        return;
    };
    let path = dir.join(PIPELINE_EVENTS_FILE);
    let mut payload = match serde_json::to_value(&event) {
        Ok(Value::Object(obj)) => obj,
        _ => return,
    };
    payload.insert("at".to_string(), json!(unix_ms()));
    let line = match serde_json::to_string(&Value::Object(payload.clone())) {
        Ok(line) => line,
        Err(_) => return,
    };
    enqueue_pipeline_line(path, line.clone());
    maybe_write_pipeline_watchdog_dump(&payload);
    let _ =
        crate::orchestrator::gateway::web_codex_storage::append_codex_live_trace_entry(&json!({
            "source": "codex.pipeline",
            "entry": Value::Object(payload),
        }));
}

fn pipeline_writer_sender() -> &'static Mutex<Option<mpsc::Sender<PipelineWriteJob>>> {
    static SENDER: OnceLock<Mutex<Option<mpsc::Sender<PipelineWriteJob>>>> = OnceLock::new();
    SENDER.get_or_init(|| Mutex::new(None))
}

fn run_pipeline_writer(rx: mpsc::Receiver<PipelineWriteJob>) {
    for job in rx {
        append_ndjson_line_capped(&job.path, &job.line, PIPELINE_MAX_BYTES);
    }
}

fn pipeline_writer() -> Option<mpsc::Sender<PipelineWriteJob>> {
    let sender_cell = pipeline_writer_sender();
    let mut sender_guard = match sender_cell.lock() {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    };
    if let Some(sender) = sender_guard.as_ref() {
        return Some(sender.clone());
    }

    let (tx, rx) = mpsc::channel();
    if std::thread::Builder::new()
        .name("codex-pipeline-writer".to_string())
        .spawn(move || run_pipeline_writer(rx))
        .is_err()
    {
        return None;
    }
    *sender_guard = Some(tx.clone());
    Some(tx)
}

fn enqueue_pipeline_line(path: PathBuf, line: String) {
    let Some(sender) = pipeline_writer() else {
        append_ndjson_line_capped(&path, &line, PIPELINE_MAX_BYTES);
        return;
    };
    if let Err(err) = sender.send(PipelineWriteJob { path, line }) {
        let sender_cell = pipeline_writer_sender();
        let mut sender_guard = match sender_cell.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        *sender_guard = None;
        let job = err.0;
        append_ndjson_line_capped(&job.path, &job.line, PIPELINE_MAX_BYTES);
    }
}

fn pipeline_watchdog_log_times() -> &'static Mutex<HashMap<String, u64>> {
    static TIMES: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    TIMES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pipeline_watchdog_event_key(payload: &serde_json::Map<String, Value>) -> String {
    let route = payload
        .get("route")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let stage = payload
        .get("stage")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let workspace = payload
        .get("workspace")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let method = payload
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    format!("{stage}|{route}|{workspace}|{method}")
}

fn pipeline_stage_is_watchdog_relevant(stage: &str) -> bool {
    matches!(
        stage,
        "runtime_detect"
            | "app_server_resolve"
            | "app_server_rpc"
            | "session_index_rebuild"
            | "gateway_handler"
            | "gateway_response_out"
            | "git_command"
            | "gh_command"
            | "git_meta_snapshot"
    )
}

fn pipeline_event_elapsed_ms(payload: &serde_json::Map<String, Value>) -> u64 {
    payload
        .get("elapsedMs")
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn should_write_pipeline_watchdog_dump(
    payload: &serde_json::Map<String, Value>,
    now_ms: u64,
) -> bool {
    if pipeline_event_elapsed_ms(payload) < PIPELINE_WATCHDOG_SLOW_AFTER_MS {
        return false;
    }
    let stage = payload
        .get("stage")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !pipeline_stage_is_watchdog_relevant(stage) {
        return false;
    }
    let key = pipeline_watchdog_event_key(payload);
    let mut times = match pipeline_watchdog_log_times().lock() {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    };
    let previous = times.get(&key).copied().unwrap_or(0);
    if previous > 0 && now_ms.saturating_sub(previous) < PIPELINE_WATCHDOG_COOLDOWN_MS {
        return false;
    }
    times.insert(key, now_ms);
    true
}

fn maybe_write_pipeline_watchdog_dump(payload: &serde_json::Map<String, Value>) {
    let now_ms = payload
        .get("at")
        .and_then(Value::as_u64)
        .unwrap_or_else(unix_ms);
    if !should_write_pipeline_watchdog_dump(payload, now_ms) {
        return;
    }
    let Some(dir) = current_diagnostics_dir() else {
        return;
    };
    let path = dir.join(format!("ui-freeze-{now_ms}-backend-pipeline.json"));
    let pipeline_event = Value::Object(payload.clone());
    let dump = json!({
        "trigger": "backend-pipeline",
        "captured_at_unix_ms": now_ms,
        "window_ms": 60_000,
        "pipeline_event": pipeline_event,
        "recent_traces": [
            {
                "at": now_ms,
                "kind": "backend_pipeline",
                "fields": Value::Object(payload.clone()),
            }
        ],
    });
    std::thread::spawn(move || {
        let _ = crate::diagnostics::write_pretty_json(&path, &dump);
    });
}

fn append_ndjson_line_capped(path: &Path, line: &str, max_bytes: usize) {
    if let Err(err) = ensure_parent_dir(path) {
        log::warn!("failed to create pipeline diagnostics parent dir: {err}");
        return;
    }
    let mut bytes = std::fs::read(path).unwrap_or_default();
    bytes.extend_from_slice(line.as_bytes());
    bytes.push(b'\n');
    if bytes.len() > max_bytes {
        let start = bytes.len().saturating_sub(max_bytes);
        bytes = bytes.split_off(start);
        if let Some(pos) = bytes.iter().position(|byte| *byte == b'\n') {
            bytes = bytes.split_off(pos + 1);
        }
    }
    if let Err(err) = std::fs::write(path, bytes) {
        log::warn!("failed to write pipeline diagnostics: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::{append_pipeline_event, CodexWebPipelineEvent};
    use crate::diagnostics::{current_diagnostics_dir, set_test_user_data_dir_override};
    use serde_json::json;
    use std::time::{Duration, Instant};

    fn wait_for_text(path: &std::path::Path, needle: &str) -> String {
        let started = Instant::now();
        loop {
            if let Ok(text) = std::fs::read_to_string(path) {
                if text.contains(needle) {
                    return text;
                }
            }
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "timed out waiting for {needle} in {}",
                path.display()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn wait_for_watchdog_file(dir: &std::path::Path) -> String {
        let started = Instant::now();
        loop {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.filter_map(|entry| entry.ok()) {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.ends_with("-backend-pipeline.json") {
                        return std::fs::read_to_string(entry.path()).expect("read watchdog dump");
                    }
                }
            }
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "timed out waiting for backend pipeline watchdog dump in {}",
                dir.display()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn append_pipeline_event_writes_ndjson() {
        let temp = tempfile::tempdir().expect("temp dir");
        let prev = set_test_user_data_dir_override(Some(temp.path()));
        let mut event =
            CodexWebPipelineEvent::new("/codex/threads", "windows", "gateway_handler", 42);
        event.cache_hit = Some(true);
        append_pipeline_event(event);

        let path = current_diagnostics_dir()
            .expect("diagnostics dir")
            .join("codex_web_pipeline.ndjson");
        let text = wait_for_text(&path, r#""route":"/codex/threads""#);
        assert!(text.contains(r#""route":"/codex/threads""#));
        assert!(text.contains(r#""workspace":"windows""#));
        assert!(text.contains(r#""cacheHit":true"#));
        set_test_user_data_dir_override(prev.as_deref());
    }

    #[test]
    fn append_pipeline_event_returns_before_large_file_rewrite_finishes() {
        let temp = tempfile::tempdir().expect("temp dir");
        let prev = set_test_user_data_dir_override(Some(temp.path()));
        let path = current_diagnostics_dir()
            .expect("diagnostics dir")
            .join("codex_web_pipeline.ndjson");
        std::fs::create_dir_all(path.parent().expect("parent")).expect("diagnostics dir");
        let seed_line = format!("{{\"seed\":\"{}\"}}\n", "x".repeat(256));
        let repeats = (super::PIPELINE_MAX_BYTES / seed_line.len()).saturating_add(128);
        std::fs::write(&path, seed_line.repeat(repeats)).expect("seed pipeline log");

        let event = CodexWebPipelineEvent::new("/codex/threads", "wsl2", "gateway_handler", 7);
        let started = Instant::now();
        append_pipeline_event(event);
        assert!(
            started.elapsed() < Duration::from_millis(50),
            "pipeline append should enqueue instead of rewriting the capped log inline"
        );

        let text = wait_for_text(&path, r#""workspace":"wsl2""#);
        assert!(text.len() <= super::PIPELINE_MAX_BYTES);
        set_test_user_data_dir_override(prev.as_deref());
    }

    #[test]
    fn slow_pipeline_event_writes_watchdog_dump() {
        let temp = tempfile::tempdir().expect("temp dir");
        let prev = set_test_user_data_dir_override(Some(temp.path()));
        let mut event =
            CodexWebPipelineEvent::new("/codex/version-info", "wsl2", "runtime_detect", 901);
        event.source = Some("codex-version-command".to_string());
        append_pipeline_event(event);

        let dir = current_diagnostics_dir().expect("diagnostics dir");
        let text = wait_for_watchdog_file(&dir);
        assert!(text.contains(r#""trigger": "backend-pipeline""#));
        assert!(text.contains(r#""route": "/codex/version-info""#));
        assert!(text.contains(r#""workspace": "wsl2""#));
        assert!(text.contains(r#""stage": "runtime_detect""#));
        set_test_user_data_dir_override(prev.as_deref());
    }

    #[test]
    fn historical_thread_rebuild_metric_does_not_write_watchdog_dump_for_fast_response() {
        let mut payload = serde_json::Map::new();
        payload.insert("route".to_string(), json!("/codex/threads"));
        payload.insert("workspace".to_string(), json!("wsl2"));
        payload.insert("stage".to_string(), json!("gateway_handler"));
        payload.insert("elapsedMs".to_string(), json!(0));
        payload.insert("rebuildMs".to_string(), json!(1_050));

        assert!(!super::should_write_pipeline_watchdog_dump(
            &payload,
            1_777_000_000_000
        ));
    }

    #[test]
    fn slow_session_index_rebuild_writes_watchdog_dump() {
        let temp = tempfile::tempdir().expect("temp dir");
        let prev = set_test_user_data_dir_override(Some(temp.path()));
        let event =
            CodexWebPipelineEvent::new("/codex/threads", "wsl2", "session_index_rebuild", 1_050);
        append_pipeline_event(event);

        let dir = current_diagnostics_dir().expect("diagnostics dir");
        let text = wait_for_watchdog_file(&dir);
        assert!(text.contains(r#""route": "/codex/threads""#));
        assert!(text.contains(r#""elapsedMs": 1050"#));
        set_test_user_data_dir_override(prev.as_deref());
    }

    #[tokio::test]
    async fn request_scope_adds_request_id_to_pipeline_events() {
        let temp = tempfile::tempdir().expect("temp dir");
        let prev = set_test_user_data_dir_override(Some(temp.path()));
        super::scope_request_id("req-test-1".to_string(), async {
            let mut event =
                CodexWebPipelineEvent::new("/codex/threads", "wsl2", "gateway_response_out", 7);
            event.status_code = Some(200);
            event.request_bytes = Some(12);
            event.response_bytes = Some(34);
            event.client_type = Some("mobile-browser".to_string());
            event.user_agent = Some("Mozilla/5.0 Mobile Safari".to_string());
            event.origin = Some("http://phone.local".to_string());
            event.remote_addr = Some("192.168.1.10:51234".to_string());
            append_pipeline_event(event);
        })
        .await;

        let path = current_diagnostics_dir()
            .expect("diagnostics dir")
            .join("codex_web_pipeline.ndjson");
        let text = wait_for_text(&path, r#""requestId":"req-test-1""#);
        assert!(text.contains(r#""requestId":"req-test-1""#));
        assert!(text.contains(r#""statusCode":200"#));
        assert!(text.contains(r#""requestBytes":12"#));
        assert!(text.contains(r#""responseBytes":34"#));
        assert!(text.contains(r#""clientType":"mobile-browser""#));
        assert!(text.contains(r#""userAgent":"Mozilla/5.0 Mobile Safari""#));
        assert!(text.contains(r#""origin":"http://phone.local""#));
        assert!(text.contains(r#""remoteAddr":"192.168.1.10:51234""#));
        set_test_user_data_dir_override(prev.as_deref());
    }
}
