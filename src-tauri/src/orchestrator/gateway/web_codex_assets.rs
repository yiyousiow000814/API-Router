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
const WEB_CODEX_IMAGE_VIEWER_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/imageViewer.js");
const WEB_CODEX_LIVE_NOTIFICATIONS_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/liveNotifications.js");
const WEB_CODEX_MESSAGE_RENDER_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/messageRender.js");
const WEB_CODEX_MESSAGE_DATA_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/messageData.js");
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
const WEB_CODEX_RUNTIME_PLAN_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/runtimePlan.js");
const WEB_CODEX_SLASH_COMMANDS_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/slashCommands.js");
const WEB_CODEX_THREAD_LIST_REFRESH_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/threadListRefresh.js");
const WEB_CODEX_THREAD_LIVE_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/threadLive.js");
const WEB_CODEX_THREAD_META_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/threadMeta.js");
const WEB_CODEX_THREAD_LIST_VIEW_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/threadListView.js");
const WEB_CODEX_TRANSPORT_MODE_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/transportMode.js");
const WEB_CODEX_TURN_ACTIONS_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/turnActions.js");
const WEB_CODEX_UI_HELPERS_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/uiHelpers.js");
const WEB_CODEX_WORKSPACE_UI_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/workspaceUi.js");
const WEB_CODEX_WS_CLIENT_JS: &str =
    include_str!("../../../../src/ui/modules/codex-web/wsClient.js");
const WEB_CODEX_ICON_SVG: &str = include_str!("../../../../src/ui/assets/codex-color.svg");
const AO_ICON_PNG: &[u8] = include_bytes!("../../../../public/ao-icon.png");

fn resolve_web_codex_module_body(module_path: &str) -> Option<&'static str> {
    match module_path {
        "codex-web/actionBindings.js" => Some(WEB_CODEX_ACTION_BINDINGS_JS),
        "codex-web/appPersistence.js" => Some(WEB_CODEX_APP_PERSISTENCE_JS),
        "codex-web/appState.js" => Some(WEB_CODEX_APP_STATE_JS),
        "codex-web/bootstrapApp.js" => Some(WEB_CODEX_BOOTSTRAP_APP_JS),
        "codex-web/chatTimeline.js" => Some(WEB_CODEX_CHAT_TIMELINE_JS),
        "codex-web/chatViewport.js" => Some(WEB_CODEX_CHAT_VIEWPORT_JS),
        "codex-web/composerUi.js" => Some(WEB_CODEX_COMPOSER_UI_JS),
        "codex-web/composition.js" => Some(WEB_CODEX_COMPOSITION_JS),
        "codex-web/connectionFlows.js" => Some(WEB_CODEX_CONNECTION_FLOWS_JS),
        "codex-web/contextLeft.js" => Some(WEB_CODEX_CONTEXT_LEFT_JS),
        "codex-web/debugTools.js" => Some(WEB_CODEX_DEBUG_TOOLS_JS),
        "codex-web/folderPicker.js" => Some(WEB_CODEX_FOLDER_PICKER_JS),
        "codex-web/headerUi.js" => Some(WEB_CODEX_HEADER_UI_JS),
        "codex-web/historyLoader.js" => Some(WEB_CODEX_HISTORY_LOADER_JS),
        "codex-web/imageViewer.js" => Some(WEB_CODEX_IMAGE_VIEWER_JS),
        "codex-web/liveNotifications.js" => Some(WEB_CODEX_LIVE_NOTIFICATIONS_JS),
        "codex-web/messageData.js" => Some(WEB_CODEX_MESSAGE_DATA_JS),
        "codex-web/mockTransport.js" => Some(WEB_CODEX_MOCK_TRANSPORT_JS),
        "codex-web/messageRender.js" => Some(WEB_CODEX_MESSAGE_RENDER_JS),
        "codex-web/mobileShell.js" => Some(WEB_CODEX_MOBILE_SHELL_JS),
        "codex-web/modelPicker.js" => Some(WEB_CODEX_MODEL_PICKER_JS),
        "codex-web/notificationRouting.js" => Some(WEB_CODEX_NOTIFICATION_ROUTING_JS),
        "codex-web/pendingThreadResume.js" => Some(WEB_CODEX_PENDING_THREAD_RESUME_JS),
        "codex-web/promptState.js" => Some(WEB_CODEX_PROMPT_STATE_JS),
        "codex-web/runtimePlan.js" => Some(WEB_CODEX_RUNTIME_PLAN_JS),
        "codex-web/slashCommands.js" => Some(WEB_CODEX_SLASH_COMMANDS_JS),
        "codex-web/threadListRefresh.js" => Some(WEB_CODEX_THREAD_LIST_REFRESH_JS),
        "codex-web/threadLive.js" => Some(WEB_CODEX_THREAD_LIVE_JS),
        "codex-web/threadMeta.js" => Some(WEB_CODEX_THREAD_META_JS),
        "codex-web/threadListView.js" => Some(WEB_CODEX_THREAD_LIST_VIEW_JS),
        "codex-web/transportMode.js" => Some(WEB_CODEX_TRANSPORT_MODE_JS),
        "codex-web/turnActions.js" => Some(WEB_CODEX_TURN_ACTIONS_JS),
        "codex-web/uiHelpers.js" => Some(WEB_CODEX_UI_HELPERS_JS),
        "codex-web/workspaceUi.js" => Some(WEB_CODEX_WORKSPACE_UI_JS),
        "codex-web/wsClient.js" => Some(WEB_CODEX_WS_CLIENT_JS),
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
        [(
            header::CONTENT_TYPE,
            "application/javascript; charset=utf-8",
        )],
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
        [(
            header::CONTENT_TYPE,
            "application/javascript; charset=utf-8",
        )],
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
        assert!(resolve_web_codex_module_body("codex-web/chatTimeline.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/chatViewport.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/composerUi.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/composition.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/connectionFlows.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/debugTools.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/folderPicker.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/headerUi.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/historyLoader.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/imageViewer.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/liveNotifications.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/messageData.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/mockTransport.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/modelPicker.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/mobileShell.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/notificationRouting.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/runtimePlan.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/threadListRefresh.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/threadLive.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/threadMeta.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/threadListView.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/transportMode.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/turnActions.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/uiHelpers.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/workspaceUi.js").is_some());
        assert!(resolve_web_codex_module_body("codex-web/wsClient.js").is_some());
    }

    #[test]
    fn rejects_unknown_web_codex_modules() {
        assert!(resolve_web_codex_module_body("codex-web/unknown.js").is_none());
    }
}
