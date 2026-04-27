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
    pub method: Option<String>,
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
            method: None,
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
}
