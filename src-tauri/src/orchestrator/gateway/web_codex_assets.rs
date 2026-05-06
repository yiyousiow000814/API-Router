use super::*;
use crate::orchestrator::gateway::web_codex_auth::api_error;
use axum::extract::Path as AxumPath;
use std::path::{Path, PathBuf};

const WEB_CODEX_UPSTREAM_WEBVIEW_ROOT: &str = "third_party/codex-web/scratch/asar/webview";
const MOBILE_HEADER_LAYOUT_OVERRIDE_STYLE: &str = concat!(
    r#"<style data-api-router-mobile-header-fix>"#,
    r#"@media (max-width: 900px) {"#,
    r#"header[data-app-shell-header-edge-scroll] > [aria-hidden="true"] + div {"#,
    r#"margin-inline-start: 0.25rem !important;"#,
    r#"}"#,
    r#"}"#,
    r#"</style>"#
);

fn resolve_repo_root_for_web_assets() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("API_ROUTER_REPO_ROOT") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            if path.join("package.json").is_file() {
                return Some(path);
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let path = parent.to_path_buf();
            if path.join("package.json").is_file() {
                return Some(path);
            }
        }
    }
    let manifest_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_root.parent()?.to_path_buf();
    if repo_root.join("package.json").is_file() {
        Some(repo_root)
    } else {
        None
    }
}

fn resolve_web_codex_asset_path(relative_path: &str) -> Option<PathBuf> {
    let clean = relative_path.trim().replace('\\', "/");
    if clean.is_empty() || clean.contains("..") {
        return None;
    }
    Some(resolve_repo_root_for_web_assets()?.join(clean))
}

fn resolve_web_codex_index_path() -> Option<PathBuf> {
    resolve_web_codex_asset_path(&format!("{WEB_CODEX_UPSTREAM_WEBVIEW_ROOT}/index.html"))
}

fn resolve_web_codex_static_path(request_path: &str) -> Option<PathBuf> {
    let path = request_path.trim().replace('\\', "/");
    let path = path.trim_start_matches('/');
    if path.is_empty() || path.contains("..") {
        return None;
    }
    resolve_web_codex_asset_path(&format!("{WEB_CODEX_UPSTREAM_WEBVIEW_ROOT}/{path}"))
}

fn resolve_web_codex_root_asset_path(request_path: &str) -> Option<PathBuf> {
    let path = request_path.trim().replace('\\', "/");
    let path = path.trim_start_matches('/');
    if path.is_empty() || path.contains("..") {
        return None;
    }
    resolve_web_codex_asset_path(&format!("{WEB_CODEX_UPSTREAM_WEBVIEW_ROOT}/assets/{path}"))
}

fn read_text_asset(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

fn strip_upstream_csp_meta(body: &str) -> String {
    let needle = "<meta\n      http-equiv=\"Content-Security-Policy\"";
    if let Some(start) = body.find(needle) {
        if let Some(end_rel) = body[start..].find("/>") {
            let end = start + end_rel + 2;
            let mut result = String::with_capacity(body.len());
            result.push_str(&body[..start]);
            result.push_str(&body[end..]);
            return result;
        }
    }
    body.to_string()
}

fn read_binary_asset(path: &Path) -> Option<Vec<u8>> {
    std::fs::read(path).ok()
}

fn text_response(
    body: String,
    content_type: &'static str,
    cache_control: &'static str,
) -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, cache_control),
        ],
        body,
    )
        .into_response()
}

fn binary_response(
    body: Vec<u8>,
    content_type: &'static str,
    cache_control: &'static str,
) -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, cache_control),
        ],
        body,
    )
        .into_response()
}

fn web_codex_content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml; charset=utf-8",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn web_codex_cache_control(path: &str) -> &'static str {
    if path == "assets/electronBridge-compat.js" {
        return "no-store";
    }
    if path.starts_with("assets/") || path.starts_with("apps/") {
        return "public, max-age=31536000, immutable";
    }
    "no-store"
}

pub(super) async fn codex_web_index(State(st): State<GatewayState>) -> Response {
    let Some(path) = resolve_web_codex_index_path() else {
        return api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "codex web repo root not available",
        );
    };
    let Some(body) = read_text_asset(&path) else {
        return api_error(StatusCode::NOT_FOUND, "codex web index not found");
    };
    let embedded_token = st.secrets.get_gateway_token().unwrap_or_default();
    let cookie = format!(
        "api_router_gateway_token={}; Path=/; HttpOnly; SameSite=Strict",
        embedded_token.trim()
    );
    let head_injection = format!(
        concat!(
            r#"<base href="/codex-web/" />"#,
            r#"<meta name="api-router-gateway-token" content="{}" />"#,
            r#"<script type="module" src="./assets/electronBridge-compat.js?v=api-router-bridge-2"></script>"#,
            r#"{}"#
        ),
        embedded_token.trim(),
        MOBILE_HEADER_LAYOUT_OVERRIDE_STYLE
    );
    let csp = "default-src 'none'; img-src 'self' app: blob: data: https:; child-src 'self' blob: https://*.web-sandbox.oaiusercontent.com https://web-sandbox.oaiusercontent.com; frame-src 'self' blob: https://*.web-sandbox.oaiusercontent.com https://web-sandbox.oaiusercontent.com; worker-src 'self' blob:; script-src 'self' 'unsafe-eval' 'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk=' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self' app: blob: data:; connect-src 'self' https://ab.chatgpt.com https://cdn.openai.com sentry-ipc:;";
    let body = strip_upstream_csp_meta(&body)
        .replace("<!-- PROD_BASE_TAG_HERE -->", &head_injection)
        .replace(
            "<!-- PROD_CSP_TAG_HERE -->",
            &format!(
                r#"<meta http-equiv="Content-Security-Policy" content="{}" />"#,
                csp
            ),
        );
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, web_codex_content_type(&path)),
            (header::CACHE_CONTROL, "no-store"),
            (header::SET_COOKIE, cookie.as_str()),
        ],
        body,
    )
        .into_response()
}

pub(super) async fn codex_web_static_asset(AxumPath(asset_path): AxumPath<String>) -> Response {
    let Some(path) = resolve_web_codex_static_path(asset_path.as_str()) else {
        return api_error(StatusCode::NOT_FOUND, "codex web asset not found");
    };
    let Some(body) = read_binary_asset(&path) else {
        return api_error(StatusCode::NOT_FOUND, "codex web asset not found");
    };
    binary_response(
        body,
        web_codex_content_type(&path),
        web_codex_cache_control(asset_path.as_str()),
    )
}

pub(super) async fn codex_web_root_asset(AxumPath(asset_path): AxumPath<String>) -> Response {
    let Some(path) = resolve_web_codex_root_asset_path(asset_path.as_str()) else {
        return api_error(StatusCode::NOT_FOUND, "codex web asset not found");
    };
    let Some(body) = read_binary_asset(&path) else {
        return api_error(StatusCode::NOT_FOUND, "codex web asset not found");
    };
    let cache_path = format!("assets/{asset_path}");
    binary_response(
        body,
        web_codex_content_type(&path),
        web_codex_cache_control(&cache_path),
    )
}

pub(super) async fn codex_web_icon_svg() -> Response {
    let Some(path) = resolve_web_codex_static_path("favicon.svg") else {
        return api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "codex web repo root not available",
        );
    };
    let Some(body) = read_text_asset(&path) else {
        return api_error(StatusCode::NOT_FOUND, "codex web icon not found");
    };
    text_response(
        body,
        web_codex_content_type(&path),
        web_codex_cache_control("favicon.svg"),
    )
}

pub(super) async fn codex_web_favicon() -> Response {
    codex_web_icon_svg().await
}

pub(super) async fn codex_web_apple_touch_icon_png() -> Response {
    codex_web_static_asset(AxumPath("assets/pwa-icon-512.png".to_string())).await
}

pub(super) async fn codex_web_manifest() -> Response {
    codex_web_static_asset(AxumPath("manifest.json".to_string())).await
}

pub(super) async fn codex_web_logo_png() -> Response {
    codex_web_apple_touch_icon_png().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_known_upstream_web_codex_paths() {
        let path = resolve_web_codex_asset_path(
            "third_party/codex-web/scratch/asar/webview/assets/index-BXNYCtJT.js",
        );
        assert!(path.is_some());
        assert!(path
            .unwrap()
            .ends_with("third_party/codex-web/scratch/asar/webview/assets/index-BXNYCtJT.js"));
    }

    #[test]
    fn rejects_unsafe_upstream_web_codex_paths() {
        assert!(resolve_web_codex_asset_path(
            "third_party/codex-web/scratch/asar/webview/assets/../secret"
        )
        .is_none());
        assert!(resolve_web_codex_asset_path(
            "../third_party/codex-web/scratch/asar/webview/index.html"
        )
        .is_none());
        assert!(resolve_web_codex_static_path("../secrets.txt").is_none());
    }

    #[tokio::test]
    async fn serves_upstream_web_codex_assets_with_cache_headers() {
        let app_js = codex_web_static_asset(AxumPath("assets/index-BXNYCtJT.js".to_string())).await;
        assert_eq!(
            app_js.headers().get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=31536000, immutable"
        );

        let manifest = codex_web_static_asset(AxumPath("manifest.json".to_string())).await;
        assert_eq!(
            manifest.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
    }

    #[tokio::test]
    async fn serves_root_assets_path_with_same_upstream_lookup() {
        let app_js = codex_web_root_asset(AxumPath("index-BXNYCtJT.js".to_string())).await;
        assert_eq!(app_js.status(), StatusCode::OK);
        assert_eq!(
            app_js.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/javascript; charset=utf-8"
        );
        assert_eq!(
            app_js.headers().get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=31536000, immutable"
        );
    }

    #[test]
    fn codex_web_index_template_keeps_injection_markers() {
        let path = resolve_web_codex_index_path().expect("index path");
        let body = read_text_asset(&path).expect("body");
        assert!(body.contains("<!-- PROD_BASE_TAG_HERE -->"));
        assert!(body.contains("<!-- PROD_CSP_TAG_HERE -->"));
    }

    #[test]
    fn codex_web_csp_allows_sentry_ipc() {
        let csp = "default-src 'none'; img-src 'self' app: blob: data: https:; child-src 'self' blob: https://*.web-sandbox.oaiusercontent.com https://web-sandbox.oaiusercontent.com; frame-src 'self' blob: https://*.web-sandbox.oaiusercontent.com https://web-sandbox.oaiusercontent.com; worker-src 'self' blob:; script-src 'self' 'unsafe-eval' 'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk=' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self' app: blob: data:; connect-src 'self' https://ab.chatgpt.com https://cdn.openai.com sentry-ipc:;";
        assert!(csp.contains("sentry-ipc:"));
    }

    #[test]
    fn electron_bridge_compat_is_not_immutable_cached() {
        assert_eq!(
            web_codex_cache_control("assets/electronBridge-compat.js"),
            "no-store"
        );
        assert_eq!(
            web_codex_cache_control("assets/index-BXNYCtJT.js"),
            "public, max-age=31536000, immutable"
        );
    }

    #[tokio::test]
    async fn root_asset_route_does_not_immutable_cache_electron_bridge_compat() {
        let response = codex_web_root_asset(AxumPath("electronBridge-compat.js".to_string())).await;
        assert_eq!(response.status(), StatusCode::OK);
        let cache_control = response
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|value| value.to_str().ok());
        assert_eq!(cache_control, Some("no-store"));
    }

    #[tokio::test]
    async fn root_asset_route_keeps_electron_window_type_for_mobile_layout() {
        let response = codex_web_root_asset(AxumPath("electronBridge-compat.js".to_string())).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let body = String::from_utf8(body.to_vec()).expect("javascript");
        assert!(body.contains(r#"function resolveCodexWindowType() {"#));
        assert!(body.contains(r#"return "electron";"#));
        assert!(!body.contains(r#"return "browser";"#));
        assert!(body.contains(r#"function isCompactTouchViewport() {"#));
        assert!(body.contains(r#"showApplicationMenu(menuId, x, y)"#));
    }

    #[test]
    fn strips_upstream_csp_meta_tag() {
        let input = "<head>\n<meta name=\"x\" content=\"1\" />\n<meta\n      http-equiv=\"Content-Security-Policy\"\n      content=\"old\"\n    />\n<title>x</title>\n</head>";
        let output = strip_upstream_csp_meta(input);
        assert!(!output.contains("http-equiv=\"Content-Security-Policy\""));
        assert!(output.contains("<title>x</title>"));
    }

    #[test]
    fn resolves_runtime_upstream_asset_paths_from_repo_root() {
        let index_path = resolve_web_codex_index_path().expect("index path");
        assert!(index_path.ends_with("third_party/codex-web/scratch/asar/webview/index.html"));

        let icon_path = resolve_web_codex_static_path("favicon.svg").expect("icon path");
        assert!(icon_path.ends_with("third_party/codex-web/scratch/asar/webview/favicon.svg"));

        let root_asset_path =
            resolve_web_codex_root_asset_path("index-BXNYCtJT.js").expect("root asset path");
        assert!(root_asset_path
            .ends_with("third_party/codex-web/scratch/asar/webview/assets/index-BXNYCtJT.js"));
    }

    #[test]
    fn upstream_web_codex_index_stays_relative_to_codex_web_root() {
        let index = read_text_asset(&resolve_web_codex_index_path().expect("index")).expect("body");
        assert!(index.contains("./assets/index-"));
    }

    #[tokio::test]
    async fn codex_web_index_injects_base_href_for_assets() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let store =
            crate::orchestrator::gateway::open_store_dir(tmp.path().join("data")).expect("store");
        let secrets =
            crate::orchestrator::secrets::SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_gateway_token("test-token").expect("token");
        let cfg = crate::orchestrator::config::AppConfig::default_config();
        let st = GatewayState {
            cfg: std::sync::Arc::new(parking_lot::RwLock::new(cfg.clone())),
            router: std::sync::Arc::new(crate::orchestrator::router::RouterState::new(
                &cfg,
                crate::orchestrator::store::unix_ms(),
            )),
            store,
            upstream: crate::orchestrator::upstream::UpstreamClient::new(),
            secrets,
            last_activity_unix_ms: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
            last_used_by_session: std::sync::Arc::new(parking_lot::RwLock::new(
                std::collections::HashMap::new(),
            )),
            usage_base_speed_cache: std::sync::Arc::new(parking_lot::RwLock::new(
                std::collections::HashMap::new(),
            )),
            prev_id_support_cache: std::sync::Arc::new(parking_lot::RwLock::new(
                std::collections::HashMap::new(),
            )),
            client_sessions: std::sync::Arc::new(parking_lot::RwLock::new(
                std::collections::HashMap::new(),
            )),
        };

        let response = codex_web_index(State(st)).await;
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let body = String::from_utf8(body.to_vec()).expect("html");
        assert!(body.contains(r#"<base href="/codex-web/" />"#));
        assert!(body.contains(r#"name="api-router-gateway-token" content="test-token""#));
        assert!(body.contains(r#"src="./assets/electronBridge-compat.js?v=api-router-bridge-2""#));
        assert!(body.contains(r#"data-api-router-mobile-header-fix"#));
    }
}
