use crate::diagnostics::{current_diagnostics_dir, ensure_parent_dir};
use crate::orchestrator::store::unix_ms;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;

const PIPELINE_EVENTS_FILE: &str = "codex_web_pipeline.ndjson";
const PIPELINE_MAX_BYTES: usize = 2 * 1024 * 1024;

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
    append_ndjson_line_capped(&path, &line, PIPELINE_MAX_BYTES);
    let _ =
        crate::orchestrator::gateway::web_codex_storage::append_codex_live_trace_entry(&json!({
            "source": "codex.pipeline",
            "entry": Value::Object(payload),
        }));
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
        let text = std::fs::read_to_string(path).expect("pipeline log");
        assert!(text.contains(r#""route":"/codex/threads""#));
        assert!(text.contains(r#""workspace":"windows""#));
        assert!(text.contains(r#""cacheHit":true"#));
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
        let text = std::fs::read_to_string(path).expect("pipeline log");
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
