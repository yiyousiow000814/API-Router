#[tauri::command]
pub(crate) fn record_web_transport_event(
    event_type: String,
    detail: Option<String>,
) -> Result<(), String> {
    crate::diagnostics::codex_web_transport::record_web_transport_event(&event_type, detail);
    Ok(())
}
