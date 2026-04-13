#[tauri::command]
pub(crate) async fn get_remote_peer_diagnostics(
    state: tauri::State<'_, app_state::AppState>,
    peer_node_id: String,
    domains: Vec<String>,
) -> Result<crate::lan_sync::LanDiagnosticsResponsePacket, String> {
    state
        .lan_sync
        .fetch_peer_diagnostics(&state.gateway, &peer_node_id, domains)
        .await
}
