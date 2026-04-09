#[tauri::command]
pub(crate) fn open_external_url(url: String) -> Result<(), String> {
    codex_app_server::open_external_url(&url)
}
