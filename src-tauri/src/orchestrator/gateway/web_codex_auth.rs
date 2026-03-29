use super::*;
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
struct ApiErrorBody<'a> {
    error: ApiErrorMessage<'a>,
}

#[derive(Serialize)]
struct ApiErrorMessage<'a> {
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

pub(super) fn api_error(code: StatusCode, message: &str) -> Response {
    (
        code,
        Json(ApiErrorBody {
            error: ApiErrorMessage {
                message,
                detail: None,
            },
        }),
    )
        .into_response()
}

pub(super) fn api_error_detail(code: StatusCode, message: &str, detail: String) -> Response {
    (
        code,
        Json(ApiErrorBody {
            error: ApiErrorMessage {
                message,
                detail: Some(detail),
            },
        }),
    )
        .into_response()
}

pub(super) fn auth_bearer_token(headers: &HeaderMap) -> Option<&str> {
    let auth = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let auth = auth.trim();
    let prefix = "Bearer ";
    if auth.len() <= prefix.len() || !auth[..prefix.len()].eq_ignore_ascii_case(prefix) {
        return None;
    }
    Some(auth[prefix.len()..].trim())
}

pub(super) fn auth_cookie_token(headers: &HeaderMap) -> Option<&str> {
    let cookie_header = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in cookie_header.split(';') {
        let trimmed = part.trim();
        let (name, value) = trimmed.split_once('=')?;
        if name.trim() == "api_router_gateway_token" {
            let v = value.trim();
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

fn matches_expected_auth_token(
    expected: &str,
    headers: &HeaderMap,
    query_token: Option<&str>,
) -> bool {
    let expected = expected.trim();
    if expected.is_empty() {
        return true;
    }
    if let Some(tok) = auth_bearer_token(headers) {
        return tok == expected;
    }
    if let Some(tok) = auth_cookie_token(headers) {
        return tok == expected;
    }
    query_token.map(str::trim) == Some(expected)
}

pub(super) fn require_codex_auth(st: &GatewayState, headers: &HeaderMap) -> Option<Response> {
    let expected = st.secrets.get_gateway_token()?;
    let expected = expected.trim();
    if expected.is_empty() {
        return None;
    }
    let tok = auth_bearer_token(headers).or_else(|| auth_cookie_token(headers));
    let Some(tok) = tok else {
        return Some(api_error(
            StatusCode::UNAUTHORIZED,
            "missing or invalid Authorization header",
        ));
    };
    if tok != expected {
        return Some(api_error(StatusCode::UNAUTHORIZED, "invalid token"));
    }
    None
}

#[derive(Deserialize)]
pub(super) struct WsQuery {
    #[serde(default)]
    pub(super) token: Option<String>,
}

pub(super) fn is_codex_ws_authorized(
    st: &GatewayState,
    headers: &HeaderMap,
    query: &WsQuery,
) -> bool {
    let Some(expected) = st.secrets.get_gateway_token() else {
        return true;
    };
    matches_expected_auth_token(&expected, headers, query.token.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_token_parser_accepts_case_insensitive_prefix() {
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "bearer abc123".parse().unwrap());
        assert_eq!(auth_bearer_token(&headers), Some("abc123"));
    }

    #[test]
    fn cookie_token_parser_extracts_gateway_cookie() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            "foo=1; api_router_gateway_token = cookie-token ; bar=2"
                .parse()
                .unwrap(),
        );
        assert_eq!(auth_cookie_token(&headers), Some("cookie-token"));
    }

    #[test]
    fn expected_auth_match_accepts_header_cookie_and_query() {
        let mut bearer_headers = HeaderMap::new();
        bearer_headers.insert(header::AUTHORIZATION, "Bearer expected".parse().unwrap());
        assert!(matches_expected_auth_token(
            "expected",
            &bearer_headers,
            None
        ));

        let mut cookie_headers = HeaderMap::new();
        cookie_headers.insert(
            header::COOKIE,
            "api_router_gateway_token=expected".parse().unwrap(),
        );
        assert!(matches_expected_auth_token(
            "expected",
            &cookie_headers,
            None
        ));

        let empty_headers = HeaderMap::new();
        assert!(matches_expected_auth_token(
            "expected",
            &empty_headers,
            Some(" expected ")
        ));
        assert!(!matches_expected_auth_token(
            "expected",
            &empty_headers,
            Some("wrong")
        ));
    }
}
