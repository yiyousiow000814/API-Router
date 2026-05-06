use super::*;
use crate::orchestrator::gateway::web_codex_auth::api_error;
use axum::extract::Path as AxumPath;
use std::path::{Path, PathBuf};

fn resolve_repo_root_for_app_assets() -> Option<PathBuf> {
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

fn resolve_app_asset_path(relative_path: &str) -> Option<PathBuf> {
    let clean = relative_path.trim().replace('\\', "/");
    if clean.is_empty() || clean.contains("..") {
        return None;
    }
    Some(resolve_repo_root_for_app_assets()?.join("dist").join(clean))
}

fn app_content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml; charset=utf-8",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn app_cache_control(path: &str) -> &'static str {
    if path.starts_with("assets/") {
        return "public, max-age=31536000, immutable";
    }
    "no-store"
}

pub(super) async fn app_web_index() -> Response {
    let Some(path) = resolve_app_asset_path("index.html") else {
        return api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "api router web root not available",
        );
    };
    let Ok(body) = std::fs::read_to_string(&path) else {
        return api_error(StatusCode::NOT_FOUND, "api router web index not found");
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, app_content_type(&path)),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

pub(super) async fn app_web_asset(AxumPath(asset_path): AxumPath<String>) -> Response {
    let normalized = format!("assets/{}", asset_path.trim_start_matches('/'));
    let Some(path) = resolve_app_asset_path(&normalized) else {
        return api_error(StatusCode::NOT_FOUND, "api router web asset not found");
    };
    let Ok(body) = std::fs::read(&path) else {
        return api_error(StatusCode::NOT_FOUND, "api router web asset not found");
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, app_content_type(&path)),
            (header::CACHE_CONTROL, app_cache_control(&normalized)),
        ],
        body,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_main_web_index_from_dist() {
        let path = resolve_app_asset_path("index.html").expect("index path");
        assert!(path.ends_with("dist/index.html"));
    }

    #[test]
    fn rejects_unsafe_main_web_asset_paths() {
        assert!(resolve_app_asset_path("../secrets.json").is_none());
        assert!(resolve_app_asset_path("assets/../index.html").is_none());
    }
}
