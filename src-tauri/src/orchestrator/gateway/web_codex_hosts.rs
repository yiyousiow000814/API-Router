use super::*;
use crate::orchestrator::gateway::web_codex_storage::{
    read_hosts_file, write_hosts_file, WebCodexHost,
};
use axum::extract::Path as AxumPath;
use serde::Deserialize;

#[derive(Deserialize)]
pub(super) struct HostCreateRequest {
    name: String,
    base_url: String,
    #[serde(default)]
    token_hint: String,
}

#[derive(Deserialize)]
pub(super) struct HostUpdateRequest {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    token_hint: Option<String>,
}

fn validate_host_create(name: &str, base_url: &str) -> Result<(), &'static str> {
    if name.trim().is_empty() || base_url.trim().is_empty() {
        Err("name and baseUrl are required")
    } else {
        Ok(())
    }
}

fn apply_host_update(item: &mut WebCodexHost, req: HostUpdateRequest) -> Result<(), &'static str> {
    if let Some(value) = req.name {
        let next = value.trim();
        if next.is_empty() {
            return Err("name cannot be empty");
        }
        item.name = next.to_string();
    }
    if let Some(value) = req.base_url {
        let next = value.trim();
        if next.is_empty() {
            return Err("baseUrl cannot be empty");
        }
        item.base_url = next.to_string();
    }
    if let Some(value) = req.token_hint {
        item.token_hint = value.trim().to_string();
    }
    Ok(())
}

pub(super) async fn codex_hosts_list(
    State(st): State<GatewayState>,
    headers: HeaderMap,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    match read_hosts_file() {
        Ok(data) => Json(json!({ "items": data.items })).into_response(),
        Err(error) => api_error_detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to read hosts",
            error,
        ),
    }
}

pub(super) async fn codex_hosts_create(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    LoggedJson(req): LoggedJson<HostCreateRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let name = req.name.trim();
    let base_url = req.base_url.trim();
    if let Err(message) = validate_host_create(name, base_url) {
        return api_error(StatusCode::BAD_REQUEST, message);
    }
    let mut file = match read_hosts_file() {
        Ok(value) => value,
        Err(error) => {
            return api_error_detail(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to read hosts",
                error,
            );
        }
    };
    let host = WebCodexHost {
        id: format!("h_{}", uuid::Uuid::new_v4().simple()),
        name: name.to_string(),
        base_url: base_url.to_string(),
        token_hint: req.token_hint.trim().to_string(),
    };
    file.items.push(host.clone());
    if let Err(error) = write_hosts_file(&file) {
        return api_error_detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to write hosts",
            error,
        );
    }
    Json(json!({ "item": host })).into_response()
}

pub(super) async fn codex_hosts_update(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    LoggedJson(req): LoggedJson<HostUpdateRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let mut file = match read_hosts_file() {
        Ok(value) => value,
        Err(error) => {
            return api_error_detail(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to read hosts",
                error,
            );
        }
    };
    let Some(idx) = file.items.iter().position(|host| host.id == id) else {
        return api_error(StatusCode::NOT_FOUND, "host not found");
    };
    if let Err(message) = apply_host_update(&mut file.items[idx], req) {
        return api_error(StatusCode::BAD_REQUEST, message);
    }
    if let Err(error) = write_hosts_file(&file) {
        return api_error_detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to write hosts",
            error,
        );
    }
    let updated = file.items[idx].clone();
    Json(json!({ "item": updated })).into_response()
}

pub(super) async fn codex_hosts_delete(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let mut file = match read_hosts_file() {
        Ok(value) => value,
        Err(error) => {
            return api_error_detail(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to read hosts",
                error,
            );
        }
    };
    let before = file.items.len();
    file.items.retain(|host| host.id != id);
    if before == file.items.len() {
        return api_error(StatusCode::NOT_FOUND, "host not found");
    }
    if let Err(error) = write_hosts_file(&file) {
        return api_error_detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to write hosts",
            error,
        );
    }
    Json(json!({ "ok": true })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_host_create_rejects_missing_required_fields() {
        assert_eq!(
            validate_host_create("", "http://127.0.0.1:4000"),
            Err("name and baseUrl are required")
        );
        assert_eq!(
            validate_host_create("Local", "   "),
            Err("name and baseUrl are required")
        );
    }

    #[test]
    fn apply_host_update_trims_and_validates_fields() {
        let mut host = WebCodexHost {
            id: "h_1".to_string(),
            name: "Before".to_string(),
            base_url: "http://before".to_string(),
            token_hint: "old".to_string(),
        };
        apply_host_update(
            &mut host,
            HostUpdateRequest {
                name: Some("  After  ".to_string()),
                base_url: Some(" http://after ".to_string()),
                token_hint: Some("  hint  ".to_string()),
            },
        )
        .expect("update");
        assert_eq!(host.name, "After");
        assert_eq!(host.base_url, "http://after");
        assert_eq!(host.token_hint, "hint");
    }

    #[test]
    fn apply_host_update_rejects_empty_name() {
        let mut host = WebCodexHost {
            id: "h_1".to_string(),
            name: "Before".to_string(),
            base_url: "http://before".to_string(),
            token_hint: String::new(),
        };
        let result = apply_host_update(
            &mut host,
            HostUpdateRequest {
                name: Some("   ".to_string()),
                base_url: None,
                token_hint: None,
            },
        );
        assert_eq!(result, Err("name cannot be empty"));
    }
}
