use super::*;
use crate::orchestrator::gateway::web_codex_auth::{
    api_error, api_error_detail, require_codex_auth,
};
use serde::{Deserialize, Serialize};

fn is_all_candidate_rpc_methods_unsupported(error: &str) -> bool {
    error
        .trim()
        .eq_ignore_ascii_case("all candidate rpc methods are marked unsupported")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliConfigSnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<String>,
}

fn extract_model_and_effort_from_toml(txt: &str) -> CliConfigSnapshot {
    let parsed =
        toml::from_str::<toml::Value>(txt).unwrap_or(toml::Value::Table(Default::default()));
    let model = parsed
        .get("model")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let reasoning_effort = parsed
        .get("model_reasoning_effort")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    CliConfigSnapshot {
        model,
        reasoning_effort,
    }
}

fn read_windows_cli_config_snapshot() -> CliConfigSnapshot {
    crate::orchestrator::gateway::web_codex_home::default_windows_codex_dir()
        .map(|p| p.join("config.toml"))
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|txt| extract_model_and_effort_from_toml(&txt))
        .unwrap_or(CliConfigSnapshot {
            model: None,
            reasoning_effort: None,
        })
}

fn resolve_codex_file_path(raw: &str) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    let wsl_distro = Some(
        crate::orchestrator::gateway::web_codex_home::resolve_wsl_identity()
            .map(|(distro, _)| distro)?,
    );
    #[cfg(not(target_os = "windows"))]
    let wsl_distro: Option<String> = None;
    resolve_codex_file_path_with_wsl_distro(raw, wsl_distro.as_deref())
}

fn resolve_codex_file_path_with_wsl_distro(
    raw: &str,
    wsl_distro: Option<&str>,
) -> Result<PathBuf, String> {
    #[cfg(not(target_os = "windows"))]
    let _ = wsl_distro;
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        return Ok(path);
    }
    #[cfg(target_os = "windows")]
    if raw.starts_with('/') {
        if let Some(host_path) = resolve_windows_host_path_from_wsl_mount(raw) {
            return Ok(host_path);
        }
        let distro = wsl_distro
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "failed to resolve WSL distro".to_string())?;
        return Ok(crate::orchestrator::gateway::web_codex_home::linux_path_to_unc(raw, distro));
    }
    Err("path must be absolute".to_string())
}

#[cfg(target_os = "windows")]
fn resolve_windows_host_path_from_wsl_mount(raw: &str) -> Option<PathBuf> {
    let normalized = crate::orchestrator::gateway::web_codex_home::normalize_wsl_linux_path(raw)?;
    let suffix = normalized.strip_prefix("/mnt/")?;
    let mut parts = suffix.split('/').filter(|part| !part.is_empty());
    let drive = parts.next()?;
    if drive.len() != 1 || !drive.as_bytes()[0].is_ascii_alphabetic() {
        return None;
    }
    let drive_letter = drive.chars().next()?.to_ascii_uppercase();
    let mut path = PathBuf::from(format!("{drive_letter}:\\"));
    for part in parts {
        path.push(part);
    }
    Some(path)
}

pub(super) async fn codex_cli_config(
    State(st): State<GatewayState>,
    headers: HeaderMap,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }

    let windows_cfg = read_windows_cli_config_snapshot();

    Json(json!({
        "windows": windows_cfg,
        "wsl2": Value::Null
    }))
    .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CodexProviderSwitchQuery {
    #[serde(default)]
    cli_homes: Vec<String>,
    #[serde(default)]
    scope: Option<String>,
}

fn normalize_provider_switch_scope(scope: Option<&str>) -> &'static str {
    match scope.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "wsl2" => "wsl2",
        "windows" => "windows",
        _ => "windows",
    }
}

fn provider_switchboard_default_homes(scope: Option<&str>) -> Vec<String> {
    let scope = normalize_provider_switch_scope(scope);
    let mut homes = Vec::new();
    let mut push_if_ready = |home: Option<PathBuf>| {
        let Some(home) = home else {
            return;
        };
        if !home.join("auth.json").exists() || !home.join("config.toml").exists() {
            return;
        }
        let raw = home.to_string_lossy().to_string();
        if !homes.iter().any(|existing| existing == &raw) {
            homes.push(raw);
        }
    };

    if scope == "windows" {
        push_if_ready(web_codex_switchboard_home(WorkspaceTarget::Windows));
    }
    if scope == "wsl2" {
        push_if_ready(web_codex_switchboard_home(WorkspaceTarget::Wsl2));
    }
    if homes.is_empty() && scope == "wsl2" {
        if let Some(home) = web_codex_switchboard_home(WorkspaceTarget::Wsl2) {
            homes.push(home.to_string_lossy().to_string());
        } else {
            homes.push("__missing_web_codex_wsl2_home__".to_string());
        }
    }
    if homes.is_empty() && scope == "windows" {
        if let Some(home) = web_codex_switchboard_home(WorkspaceTarget::Windows) {
            homes.push(home.to_string_lossy().to_string());
        }
    }
    homes
}

fn provider_switchboard_homes_for_request(
    cli_homes: Vec<String>,
    scope: Option<&str>,
) -> Vec<String> {
    let requested = cli_homes
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if requested.is_empty() {
        provider_switchboard_default_homes(scope)
    } else {
        requested
    }
}

fn provider_switchboard_details(st: &GatewayState) -> Vec<Value> {
    let cfg = st.cfg.read().clone();
    let quota = st.store.list_quota_snapshots();
    let mut names = cfg
        .provider_order
        .iter()
        .filter(|name| name.as_str() != "official")
        .filter(|name| cfg.providers.contains_key(name.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    for name in cfg.providers.keys() {
        if name == "official" || names.iter().any(|existing| existing == name) {
            continue;
        }
        if cfg.providers.contains_key(name) {
            names.push(name.clone());
        }
    }

    names
        .into_iter()
        .filter_map(|name| {
            let provider = cfg.providers.get(&name)?;
            let quota_value = quota.get(&name).cloned().unwrap_or(Value::Null);
            let has_key = st
                .secrets
                .get_provider_key(&name)
                .is_some_and(|key| !key.trim().is_empty());
            Some(json!({
                "name": name,
                "display_name": &provider.display_name,
                "base_url": &provider.base_url,
                "has_key": has_key,
                "disabled": provider.disabled,
                "supports_websockets": provider.supports_websockets,
                "usage_adapter": &provider.usage_adapter,
                "quota": quota_value,
            }))
        })
        .collect()
}

fn augment_provider_switchboard_status(
    st: &GatewayState,
    mut value: Value,
    scope: Option<&str>,
) -> Value {
    let scope = normalize_provider_switch_scope(scope);
    if let Some(obj) = value.as_object_mut() {
        obj.insert("scope".to_string(), json!(scope));
        obj.insert(
            "provider_details".to_string(),
            Value::Array(provider_switchboard_details(st)),
        );
        obj.insert(
            "official_profiles".to_string(),
            json!(st.secrets.list_official_account_profiles()),
        );
    }
    value
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CodexProviderEnabledRequest {
    provider: String,
    enabled: bool,
}

pub(super) async fn codex_provider_switchboard_provider_enabled(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Json(req): Json<CodexProviderEnabledRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let provider = req.provider.trim().to_string();
    if provider.is_empty() || provider == "official" {
        return api_error(StatusCode::BAD_REQUEST, "invalid provider");
    }
    let config_path = web_codex_config_path();
    {
        let mut cfg = st.cfg.write();
        let Some(provider_cfg) = cfg.providers.get_mut(&provider) else {
            return api_error(StatusCode::NOT_FOUND, "unknown provider");
        };
        provider_cfg.disabled = !req.enabled;
        crate::app_state::normalize_provider_order(&mut cfg);
        let config_text = match toml::to_string_pretty(&*cfg) {
            Ok(value) => value,
            Err(error) => {
                return api_error_detail(
                    StatusCode::BAD_GATEWAY,
                    "failed to serialize provider state",
                    error.to_string(),
                )
            }
        };
        if let Err(error) = std::fs::write(&config_path, config_text) {
            return api_error_detail(
                StatusCode::BAD_GATEWAY,
                "failed to persist provider state",
                error.to_string(),
            );
        }
    }
    match crate::provider_switchboard::get_status_for_gateway(
        &st,
        provider_switchboard_default_homes(None),
    ) {
        Ok(value) => Json(augment_provider_switchboard_status(&st, value, None)).into_response(),
        Err(error) => Json(augment_provider_switchboard_status(
            &st,
            json!({
                "ok": false,
                "mode": "unavailable",
                "model_provider": Value::Null,
                "dirs": [],
                "provider_options": [],
                "status_error": error,
            }),
            None,
        ))
        .into_response(),
    }
}

pub(super) async fn codex_provider_switchboard_status(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<CodexProviderSwitchQuery>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let scope = query.scope.clone();
    let homes = provider_switchboard_homes_for_request(query.cli_homes, scope.as_deref());
    match crate::provider_switchboard::get_status_for_gateway(&st, homes) {
        Ok(value) => Json(augment_provider_switchboard_status(
            &st,
            value,
            scope.as_deref(),
        ))
        .into_response(),
        Err(error) => Json(augment_provider_switchboard_status(
            &st,
            json!({
                "ok": false,
                "mode": "unavailable",
                "model_provider": Value::Null,
                "dirs": [],
                "provider_options": [],
                "status_error": error,
            }),
            scope.as_deref(),
        ))
        .into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CodexProviderSwitchSetRequest {
    #[serde(default)]
    cli_homes: Vec<String>,
    #[serde(default)]
    scope: Option<String>,
    target: String,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    official_profile_id: Option<String>,
}

fn web_codex_config_path() -> PathBuf {
    std::env::var_os("API_ROUTER_USER_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("user-data"))
        .join("config.toml")
}

fn web_codex_home() -> PathBuf {
    if let Some(home) = crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override()
    {
        return PathBuf::from(home);
    }
    web_codex_config_path()
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("user-data"))
        .join("codex-home")
}

fn web_codex_workspace_home(target: WorkspaceTarget) -> Option<PathBuf> {
    crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override_for_target(Some(
        target,
    ))
    .map(PathBuf::from)
    .or_else(|| match target {
        WorkspaceTarget::Windows => Some(web_codex_home()),
        WorkspaceTarget::Wsl2 => None,
    })
}

fn web_codex_switchboard_home(target: WorkspaceTarget) -> Option<PathBuf> {
    let home = web_codex_workspace_home(target)?;
    if target != WorkspaceTarget::Wsl2 {
        return Some(home);
    }
    let raw = home.to_string_lossy();
    if raw.starts_with('/') {
        #[cfg(target_os = "windows")]
        {
            let (distro, _) =
                crate::orchestrator::gateway::web_codex_home::resolve_wsl_identity().ok()?;
            return Some(
                crate::orchestrator::gateway::web_codex_home::linux_path_to_unc(&raw, &distro),
            );
        }
    }
    Some(home)
}

pub(super) async fn codex_provider_switchboard_set(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Json(req): Json<CodexProviderSwitchSetRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let config_path = web_codex_config_path();
    let runtime = crate::provider_switchboard::ProviderSwitchboardRuntime {
        config_path: &config_path,
        gateway: &st,
        secrets: &st.secrets,
    };
    let scope = req.scope.clone();
    let homes = provider_switchboard_homes_for_request(req.cli_homes, scope.as_deref());
    let target = req.target.trim().to_ascii_lowercase();
    let official_auth = if target == "official" {
        let profile_id = req
            .official_profile_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let Some(profile_id) = profile_id else {
            return api_error(StatusCode::BAD_REQUEST, "officialProfileId is required");
        };
        match st.secrets.official_account_profile_auth_json(profile_id) {
            Ok(auth) => Some(auth),
            Err(error) => {
                return api_error_detail(
                    StatusCode::BAD_REQUEST,
                    "failed to read official account profile",
                    error,
                );
            }
        }
    } else {
        None
    };
    match crate::provider_switchboard::set_target_for_runtime_with_official_auth(
        &runtime,
        homes,
        target,
        req.provider,
        official_auth,
    ) {
        Ok(value) => Json(augment_provider_switchboard_status(
            &st,
            value,
            scope.as_deref(),
        ))
        .into_response(),
        Err(error) => api_error_detail(
            StatusCode::BAD_REQUEST,
            "failed to update provider switchboard",
            error,
        ),
    }
}

#[derive(Deserialize)]
pub(super) struct CodexFileQuery {
    path: String,
}

pub(super) async fn codex_file(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Query(q): Query<CodexFileQuery>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let raw = q.path.trim();
    if raw.is_empty() || raw.len() > 4096 {
        return api_error(StatusCode::BAD_REQUEST, "missing file path");
    }
    let path = match resolve_codex_file_path(raw) {
        Ok(path) => path,
        Err(err) if err == "path must be absolute" => {
            return api_error(StatusCode::BAD_REQUEST, "path must be absolute")
        }
        Err(err) => {
            return api_error_detail(StatusCode::BAD_GATEWAY, "failed to resolve file path", err)
        }
    };
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let content_type = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml; charset=utf-8",
        _ => return api_error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported file type"),
    };

    let meta = match tokio::fs::metadata(&path).await {
        Ok(m) => m,
        Err(e) => return api_error_detail(StatusCode::NOT_FOUND, "file not found", e.to_string()),
    };
    if meta.len() as usize > super::MAX_ATTACHMENT_BYTES {
        return api_error(StatusCode::PAYLOAD_TOO_LARGE, "file too large");
    }
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(e) => {
            return api_error_detail(
                StatusCode::BAD_GATEWAY,
                "failed to read file",
                e.to_string(),
            )
        }
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "private, max-age=600"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response()
}

pub(super) async fn codex_health(State(st): State<GatewayState>, headers: HeaderMap) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    Json(json!({ "ok": true, "service": "web-codex" })).into_response()
}

#[derive(Deserialize)]
pub(super) struct PendingEventsQuery {
    #[serde(default)]
    workspace: Option<String>,
}

fn pending_events_home_override(query: &PendingEventsQuery) -> Option<String> {
    query
        .workspace
        .as_deref()
        .and_then(super::parse_workspace_target)
        .and_then(|target| {
            crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override_for_target(
                Some(target),
            )
        })
}

pub(super) async fn codex_pending_approvals(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<PendingEventsQuery>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let home = pending_events_home_override(&query);
    match super::codex_try_request_with_fallback_in_home(
        home.as_deref(),
        &["bridge/approvals/list", "approvals/list"],
        Value::Null,
    )
    .await
    {
        Ok(v) => Json(json!({ "items": v.get("items").cloned().unwrap_or(v) })).into_response(),
        Err(e) if is_all_candidate_rpc_methods_unsupported(&e) => {
            Json(json!({ "items": [] })).into_response()
        }
        Err(e) => api_error_detail(
            StatusCode::BAD_GATEWAY,
            "failed to list pending approvals",
            e,
        ),
    }
}

pub(super) async fn codex_pending_user_inputs(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<PendingEventsQuery>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let home = pending_events_home_override(&query);
    match super::codex_try_request_with_fallback_in_home(
        home.as_deref(),
        &[
            "bridge/userInput/list",
            "userInput/list",
            "request_user_input/list",
        ],
        Value::Null,
    )
    .await
    {
        Ok(v) => Json(json!({ "items": v.get("items").cloned().unwrap_or(v) })).into_response(),
        Err(e) if is_all_candidate_rpc_methods_unsupported(&e) => {
            Json(json!({ "items": [] })).into_response()
        }
        Err(e) => api_error_detail(
            StatusCode::BAD_GATEWAY,
            "failed to list pending user inputs",
            e,
        ),
    }
}

#[derive(Deserialize)]
pub(super) struct CodexFoldersQuery {
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    path: Option<String>,
}

pub(super) async fn codex_folders_list(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<CodexFoldersQuery>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let requested_workspace = query.workspace.unwrap_or_else(|| "windows".to_string());
    let Some(target) =
        crate::orchestrator::gateway::web_codex_home::parse_workspace_target(&requested_workspace)
    else {
        return api_error(StatusCode::BAD_REQUEST, "workspace must be windows or wsl2");
    };

    match target {
        WorkspaceTarget::Windows => {
            let requested_path = query
                .path
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty());
            if requested_path.is_none() {
                let items = crate::orchestrator::gateway::web_codex_home::windows_root_folders();
                return Json(json!({
                    "workspace": "windows",
                    "currentPath": Value::Null,
                    "parentPath": Value::Null,
                    "items": items,
                }))
                .into_response();
            }
            let path_raw = requested_path.unwrap_or_default();
            let path = PathBuf::from(path_raw);
            if !path.is_absolute() {
                return api_error(
                    StatusCode::BAD_REQUEST,
                    "path must be an absolute folder path",
                );
            }
            if !path.is_dir() {
                return api_error(StatusCode::BAD_REQUEST, "path is not a directory");
            }
            let current_path = path.to_string_lossy().to_string();
            let parent_path = path.parent().map(|p| p.to_string_lossy().to_string());
            match crate::orchestrator::gateway::web_codex_home::list_local_subdirectories(&path) {
                Ok(items) => Json(json!({
                    "workspace": "windows",
                    "currentPath": current_path,
                    "parentPath": parent_path,
                    "items": items,
                }))
                .into_response(),
                Err(e) => api_error_detail(StatusCode::BAD_GATEWAY, "failed to list folders", e),
            }
        }
        WorkspaceTarget::Wsl2 => {
            match crate::orchestrator::gateway::web_codex_home::list_wsl_subdirectories(
                query.path.as_deref(),
            ) {
                Ok((current_path, parent_path, items)) => Json(json!({
                    "workspace": "wsl2",
                    "currentPath": current_path,
                    "parentPath": parent_path,
                    "items": items,
                }))
                .into_response(),
                Err(e) => api_error_detail(StatusCode::BAD_GATEWAY, "failed to list folders", e),
            }
        }
    }
}

#[derive(Deserialize, Default)]
pub(super) struct CodexModelsQuery {
    #[serde(default)]
    refresh: Option<String>,
}

impl CodexModelsQuery {
    fn refresh_requested(&self) -> bool {
        self.refresh.as_deref().map(str::trim).is_some_and(|value| {
            matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes")
        })
    }
}

pub(super) async fn codex_models(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<CodexModelsQuery>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    if query.refresh_requested() {
        if let Err(err) = crate::codex_app_server::refresh_server_in_home(None).await {
            return api_error_detail(
                StatusCode::BAD_GATEWAY,
                "failed to refresh codex app-server",
                err,
            );
        }
    }
    match super::codex_rpc_call("model/list", Value::Null).await {
        Ok(v) => Json(json!({ "items": v.get("items").cloned().unwrap_or(v) })).into_response(),
        Err(resp) => resp,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        extract_model_and_effort_from_toml, resolve_codex_file_path_with_wsl_distro,
        CodexModelsQuery,
    };
    #[cfg(target_os = "windows")]
    use std::path::PathBuf;

    #[test]
    fn parses_model_and_effort() {
        let txt = r#"
model = "gpt-5.2"
model_reasoning_effort = "medium"
"#;
        let snap = extract_model_and_effort_from_toml(txt);
        assert_eq!(snap.model.as_deref(), Some("gpt-5.2"));
        assert_eq!(snap.reasoning_effort.as_deref(), Some("medium"));
    }

    #[test]
    fn codex_models_query_parses_refresh_flag() {
        assert!(CodexModelsQuery {
            refresh: Some("1".to_string()),
        }
        .refresh_requested());
        assert!(CodexModelsQuery {
            refresh: Some("true".to_string()),
        }
        .refresh_requested());
        assert!(!CodexModelsQuery {
            refresh: Some("0".to_string()),
        }
        .refresh_requested());
        assert!(!CodexModelsQuery { refresh: None }.refresh_requested());
    }

    #[test]
    fn ignores_empty_values() {
        let txt = r#"
model = ""
model_reasoning_effort = "   "
"#;
        let snap = extract_model_and_effort_from_toml(txt);
        assert_eq!(snap.model.as_deref(), None);
        assert_eq!(snap.reasoning_effort.as_deref(), None);
    }

    #[test]
    fn rejects_relative_codex_file_paths() {
        let err = resolve_codex_file_path_with_wsl_distro("tmp/image.png", Some("Ubuntu"))
            .expect_err("relative paths must be rejected");
        assert_eq!(err, "path must be absolute");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn resolves_wsl_mnt_codex_file_paths_to_windows_host_paths() {
        let path = resolve_codex_file_path_with_wsl_distro(
            "/mnt/c/Users/yiyou/AppData/Local/Temp/tmpE2DA.png",
            Some("Ubuntu"),
        )
        .expect("WSL linux paths should resolve");
        assert_eq!(
            path,
            PathBuf::from(r"C:\Users\yiyou\AppData\Local\Temp\tmpE2DA.png")
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn resolves_non_mount_wsl_linux_codex_file_paths_to_unc() {
        let path = resolve_codex_file_path_with_wsl_distro(
            "/home/test/.codex/tmp/image.png",
            Some("Ubuntu"),
        )
        .expect("WSL linux paths should resolve");
        assert_eq!(
            path,
            PathBuf::from(r"\\wsl.localhost\Ubuntu\home\test\.codex\tmp\image.png")
        );
    }
}
