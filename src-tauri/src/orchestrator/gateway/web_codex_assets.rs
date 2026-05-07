use super::*;
use crate::orchestrator::gateway::web_codex_auth::api_error;
use axum::extract::Path as AxumPath;

const WEB_CODEX_INDEX_HTML: &str = include_str!("../../../../codex-web.html");
const WEB_CODEX_APP_JS: &str = include_str!("../../../../src/ui/codex-web-dev.js");
const WEB_CODEX_ACTION_BINDINGS_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/actionBindings.js");
const WEB_CODEX_APP_PERSISTENCE_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/appPersistence.js");
const WEB_CODEX_APP_STATE_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/appState.js");
const WEB_CODEX_BOOTSTRAP_APP_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/bootstrapApp.js");
const WEB_CODEX_BRANCH_OPTIONS_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/branchOptions.js");
const WEB_CODEX_BRANCH_PICKER_STATE_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/branchPickerState.js");
const WEB_CODEX_PENDING_THREAD_RESUME_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/pendingThreadResume.js");
const WEB_CODEX_CONTEXT_LEFT_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/contextLeft.js");
const WEB_CODEX_CONNECTION_FLOWS_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/connectionFlows.js");
const WEB_CODEX_COMPOSER_UI_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/composerUi.js");
const WEB_CODEX_COMPOSITION_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/composition.js");
const WEB_CODEX_CHAT_TIMELINE_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/chatTimeline.js");
const WEB_CODEX_CHAT_VIEWPORT_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/chatViewport.js");
const WEB_CODEX_DEBUG_TOOLS_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/debugTools.js");
const WEB_CODEX_FOLDER_PICKER_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/folderPicker.js");
const WEB_CODEX_HEADER_UI_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/headerUi.js");
const WEB_CODEX_HISTORY_LOADER_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/historyLoader.js");
const WEB_CODEX_HISTORY_COMMENTARY_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/historyCommentary.js");
const WEB_CODEX_HISTORY_PREPARATION_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/historyPreparation.js");
const WEB_CODEX_HISTORY_PAGE_STATE_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/historyPageState.js");
const WEB_CODEX_HISTORY_APPLY_STATE_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/historyApplyState.js");
const WEB_CODEX_HISTORY_APPLY_FLOW_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/historyApplyFlow.js");
const WEB_CODEX_HISTORY_LOAD_FLOW_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/historyLoadFlow.js");
const WEB_CODEX_HISTORY_LIVE_COMMENTARY_STATE_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/historyLiveCommentaryState.js");
const WEB_CODEX_HISTORY_MESSAGE_MAPPING_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/historyMessageMapping.js");
const WEB_CODEX_HISTORY_RENDER_APPLY_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/historyRenderApply.js");
const WEB_CODEX_HISTORY_RENDER_STRATEGY_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/historyRenderStrategy.js");
const WEB_CODEX_HISTORY_OLDER_CHUNK_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/historyOlderChunk.js");
const WEB_CODEX_HISTORY_WINDOW_CONTROL_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/historyWindowControl.js");
const WEB_CODEX_IMAGE_VIEWER_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/imageViewer.js");
const WEB_CODEX_LIVE_NOTIFICATIONS_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/liveNotifications.js");
const WEB_CODEX_MESSAGE_RENDER_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/messageRender.js");
const WEB_CODEX_MESSAGE_DATA_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/messageData.js");
const WEB_CODEX_MOBILE_VIEWPORT_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/mobileViewport.js");
const WEB_CODEX_MOBILE_SHELL_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/mobileShell.js");
const WEB_CODEX_MOCK_TRANSPORT_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/mockTransport.js");
const WEB_CODEX_MODEL_PICKER_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/modelPicker.js");
const WEB_CODEX_NOTIFICATION_ROUTING_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/notificationRouting.js");
const WEB_CODEX_PROMPT_STATE_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/promptState.js");
const WEB_CODEX_PROPOSED_PLAN_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/proposedPlan.js");
const WEB_CODEX_RUNTIME_STATE_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/runtimeState.js");
const WEB_CODEX_RUNTIME_PLAN_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/runtimePlan.js");
const WEB_CODEX_RUNTIME_USER_INPUT_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/runtimeUserInput.js");
const WEB_CODEX_SLASH_COMMANDS_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/slashCommands.js");
const WEB_CODEX_THREAD_LIST_REFRESH_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/threadListRefresh.js");
const WEB_CODEX_THREAD_LIVE_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/threadLive.js");
const WEB_CODEX_THREAD_META_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/threadMeta.js");
const WEB_CODEX_THREAD_GIT_META_STATE_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/threadGitMetaState.js");
const WEB_CODEX_THREAD_LIST_VIEW_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/threadListView.js");
const WEB_CODEX_THREAD_OPEN_STATE_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/threadOpenState.js");
const WEB_CODEX_TRANSPORT_MODE_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/transportMode.js");
const WEB_CODEX_TURN_ACTIONS_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/turnActions.js");
const WEB_CODEX_UI_HELPERS_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/uiHelpers.js");
const WEB_CODEX_WEB_DIAGNOSTICS_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/webDiagnostics.js");
const WEB_CODEX_WORKSPACE_UI_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/workspaceUi.js");
const WEB_CODEX_WS_CLIENT_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/wsClient.js");
const WEB_CODEX_PDFJS_MIN_MJS: &str =
    include_str!("../../../../node_modules/pdfjs-dist/legacy/build/pdf.min.mjs");
const WEB_CODEX_PDFJS_WORKER_MIN_MJS: &str =
    include_str!("../../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs");
const WEB_CODEX_ICON_SVG: &str = include_str!("../../../../src/ui/assets/codex-color.svg");
const WEB_CODEX_ICON_PNG: &[u8] = include_bytes!("../../../../public/codex-web-icon.png");
const AO_ICON_PNG: &[u8] = include_bytes!("../../../../public/ao-icon.png");
const WEB_CODEX_MANIFEST: &str = r##"{
  "name": "Web Codex",
  "short_name": "Codex",
  "start_url": "/codex-web",
  "scope": "/codex-web",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#ffffff",
  "icons": [
    {
      "src": "/codex-web/apple-touch-icon.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any maskable"
    }
  ]
}"##;

fn resolve_web_codex_module_body(module_path: &str) -> Option<&'static str> {
    match module_path {
        "codex-web/actionBindings.js" => Some(WEB_CODEX_ACTION_BINDINGS_JS),
        "codex-web/appPersistence.js" => Some(WEB_CODEX_APP_PERSISTENCE_JS),
        "codex-web/appState.js" => Some(WEB_CODEX_APP_STATE_JS),
        "codex-web/bootstrapApp.js" => Some(WEB_CODEX_BOOTSTRAP_APP_JS),
        "codex-web/branchOptions.js" => Some(WEB_CODEX_BRANCH_OPTIONS_JS),
        "codex-web/branchPickerState.js" => Some(WEB_CODEX_BRANCH_PICKER_STATE_JS),
        "codex-web/chatTimeline.js" => Some(WEB_CODEX_CHAT_TIMELINE_JS),
        "codex-web/chatViewport.js" => Some(WEB_CODEX_CHAT_VIEWPORT_JS),
        "codex-web/composerUi.js" => Some(WEB_CODEX_COMPOSER_UI_JS),
        "codex-web/composition.js" => Some(WEB_CODEX_COMPOSITION_JS),
        "codex-web/connectionFlows.js" => Some(WEB_CODEX_CONNECTION_FLOWS_JS),
        "codex-web/contextLeft.js" => Some(WEB_CODEX_CONTEXT_LEFT_JS),
        "codex-web/debugTools.js" => Some(WEB_CODEX_DEBUG_TOOLS_JS),
        "codex-web/folderPicker.js" => Some(WEB_CODEX_FOLDER_PICKER_JS),
        "codex-web/headerUi.js" => Some(WEB_CODEX_HEADER_UI_JS),
        "codex-web/historyApplyFlow.js" => Some(WEB_CODEX_HISTORY_APPLY_FLOW_JS),
        "codex-web/historyApplyState.js" => Some(WEB_CODEX_HISTORY_APPLY_STATE_JS),
        "codex-web/historyCommentary.js" => Some(WEB_CODEX_HISTORY_COMMENTARY_JS),
        "codex-web/historyLiveCommentaryState.js" => {
            Some(WEB_CODEX_HISTORY_LIVE_COMMENTARY_STATE_JS)
        }
        "codex-web/historyLoadFlow.js" => Some(WEB_CODEX_HISTORY_LOAD_FLOW_JS),
        "codex-web/historyLoader.js" => Some(WEB_CODEX_HISTORY_LOADER_JS),
        "codex-web/historyMessageMapping.js" => Some(WEB_CODEX_HISTORY_MESSAGE_MAPPING_JS),
        "codex-web/historyOlderChunk.js" => Some(WEB_CODEX_HISTORY_OLDER_CHUNK_JS),
        "codex-web/historyPageState.js" => Some(WEB_CODEX_HISTORY_PAGE_STATE_JS),
        "codex-web/historyPreparation.js" => Some(WEB_CODEX_HISTORY_PREPARATION_JS),
        "codex-web/historyRenderApply.js" => Some(WEB_CODEX_HISTORY_RENDER_APPLY_JS),
        "codex-web/historyRenderStrategy.js" => Some(WEB_CODEX_HISTORY_RENDER_STRATEGY_JS),
        "codex-web/historyWindowControl.js" => Some(WEB_CODEX_HISTORY_WINDOW_CONTROL_JS),
        "codex-web/imageViewer.js" => Some(WEB_CODEX_IMAGE_VIEWER_JS),
        "codex-web/liveNotifications.js" => Some(WEB_CODEX_LIVE_NOTIFICATIONS_JS),
        "codex-web/messageData.js" => Some(WEB_CODEX_MESSAGE_DATA_JS),
        "codex-web/mockTransport.js" => Some(WEB_CODEX_MOCK_TRANSPORT_JS),
        "codex-web/messageRender.js" => Some(WEB_CODEX_MESSAGE_RENDER_JS),
        "codex-web/mobileViewport.js" => Some(WEB_CODEX_MOBILE_VIEWPORT_JS),
        "codex-web/mobileShell.js" => Some(WEB_CODEX_MOBILE_SHELL_JS),
        "codex-web/modelPicker.js" => Some(WEB_CODEX_MODEL_PICKER_JS),
        "codex-web/notificationRouting.js" => Some(WEB_CODEX_NOTIFICATION_ROUTING_JS),
        "codex-web/pendingThreadResume.js" => Some(WEB_CODEX_PENDING_THREAD_RESUME_JS),
        "codex-web/promptState.js" => Some(WEB_CODEX_PROMPT_STATE_JS),
        "codex-web/proposedPlan.js" => Some(WEB_CODEX_PROPOSED_PLAN_JS),
        "codex-web/runtimeState.js" => Some(WEB_CODEX_RUNTIME_STATE_JS),
        "codex-web/runtimePlan.js" => Some(WEB_CODEX_RUNTIME_PLAN_JS),
        "codex-web/runtimeUserInput.js" => Some(WEB_CODEX_RUNTIME_USER_INPUT_JS),
        "codex-web/slashCommands.js" => Some(WEB_CODEX_SLASH_COMMANDS_JS),
        "codex-web/threadListRefresh.js" => Some(WEB_CODEX_THREAD_LIST_REFRESH_JS),
        "codex-web/threadLive.js" => Some(WEB_CODEX_THREAD_LIVE_JS),
        "codex-web/threadMeta.js" => Some(WEB_CODEX_THREAD_META_JS),
        "codex-web/threadGitMetaState.js" => Some(WEB_CODEX_THREAD_GIT_META_STATE_JS),
        "codex-web/threadListView.js" => Some(WEB_CODEX_THREAD_LIST_VIEW_JS),
        "codex-web/threadOpenState.js" => Some(WEB_CODEX_THREAD_OPEN_STATE_JS),
        "codex-web/transportMode.js" => Some(WEB_CODEX_TRANSPORT_MODE_JS),
        "codex-web/turnActions.js" => Some(WEB_CODEX_TURN_ACTIONS_JS),
        "codex-web/uiHelpers.js" => Some(WEB_CODEX_UI_HELPERS_JS),
        "codex-web/webDiagnostics.js" => Some(WEB_CODEX_WEB_DIAGNOSTICS_JS),
        "codex-web/workspaceUi.js" => Some(WEB_CODEX_WORKSPACE_UI_JS),
        "codex-web/wsClient.js" => Some(WEB_CODEX_WS_CLIENT_JS),
        "pdfjs/pdf.min.mjs" => Some(WEB_CODEX_PDFJS_MIN_MJS),
        "pdfjs/pdf.worker.min.mjs" => Some(WEB_CODEX_PDFJS_WORKER_MIN_MJS),
        _ => None,
    }
}

pub(super) async fn codex_web_index(State(st): State<GatewayState>) -> Response {
    let embedded_token = st.secrets.get_gateway_token().unwrap_or_default();
    let cookie = format!(
        "api_router_gateway_token={}; Path=/codex; HttpOnly; SameSite=Strict",
        embedded_token.trim()
    );
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::SET_COOKIE, cookie.as_str()),
        ],
        WEB_CODEX_INDEX_HTML,
    )
        .into_response()
}

pub(super) async fn codex_web_app_js() -> Response {
    (
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                "application/javascript; charset=utf-8",
            ),
            (header::CACHE_CONTROL, "no-store"),
        ],
        WEB_CODEX_APP_JS,
    )
        .into_response()
}

pub(super) async fn codex_web_module_js(AxumPath(module_path): AxumPath<String>) -> Response {
    let Some(body) = resolve_web_codex_module_body(module_path.as_str()) else {
        return api_error(StatusCode::NOT_FOUND, "codex web module not found");
    };
    (
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                "application/javascript; charset=utf-8",
            ),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

pub(super) async fn codex_web_icon_svg() -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "image/svg+xml; charset=utf-8")],
        WEB_CODEX_ICON_SVG,
    )
        .into_response()
}

pub(super) async fn codex_web_favicon() -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "image/svg+xml; charset=utf-8"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        WEB_CODEX_ICON_SVG,
    )
        .into_response()
}

pub(super) async fn codex_web_apple_touch_icon_png() -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        WEB_CODEX_ICON_PNG,
    )
        .into_response()
}

pub(super) async fn codex_web_manifest() -> Response {
    (
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                "application/manifest+json; charset=utf-8",
            ),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        WEB_CODEX_MANIFEST,
    )
        .into_response()
}

pub(super) async fn codex_web_logo_png() -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "image/png")],
        AO_ICON_PNG,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_known_web_codex_modules() {
        let body = resolve_web_codex_module_body("codex-web/messageRender.js");
        assert!(body.is_some());
        assert!(body.unwrap().contains("renderInlineMessageText"));
        assert!(resolve_web_codex_module_body("codex-web/actionBindings.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/appPersistence.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/appState.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/bootstrapApp.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/branchOptions.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/branchPickerState.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/chatTimeline.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/chatViewport.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/composerUi.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/composition.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/connectionFlows.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/debugTools.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/folderPicker.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/headerUi.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/historyApplyFlow.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/historyApplyState.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/historyCommentary.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/historyLiveCommentaryState.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/historyLoadFlow.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/historyLoader.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/historyMessageMapping.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/historyOlderChunk.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/historyPageState.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/historyPreparation.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/historyRenderApply.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/historyRenderStrategy.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/historyWindowControl.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/imageViewer.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/liveNotifications.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/messageData.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/mockTransport.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/mobileViewport.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/modelPicker.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/mobileShell.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/notificationRouting.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/proposedPlan.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/runtimeState.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/runtimePlan.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/runtimeUserInput.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/threadListRefresh.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/threadLive.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/threadMeta.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/threadGitMetaState.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/threadListView.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/threadOpenState.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/transportMode.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/turnActions.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/uiHelpers.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/workspaceUi.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/wsClient.js").is_some());
        assert!(resolve_web_codex_module_body("pdfjs/pdf.min.mjs").is_some());
        assert!(resolve_web_codex_module_body("pdfjs/pdf.worker.min.mjs").is_some());
    }

    #[test]
    fn rejects_unknown_web_codex_modules() {
        assert!(resolve_web_codex_module_body("codex-web/unknown.js").is_none());
    }

    #[tokio::test]
    async fn serves_web_codex_javascript_without_browser_cache() {
        let app_js = codex_web_app_js().await;
        assert_eq!(
            app_js.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );

        let module_js = codex_web_module_js(AxumPath("codex-web/threadLive.js".to_string())).await;
        assert_eq!(
            module_js.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
    }

    #[test]
    fn exposes_web_codex_home_screen_assets() {
        assert!(WEB_CODEX_INDEX_HTML.contains(r#"rel="apple-touch-icon""#));
        assert!(WEB_CODEX_INDEX_HTML.contains("/codex-web/manifest.webmanifest"));
        assert!(WEB_CODEX_MANIFEST.contains("/codex-web/apple-touch-icon.png"));
        assert_eq!(&WEB_CODEX_ICON_PNG[..8], b"\x89PNG\r\n\x1a\n");
    }
}
