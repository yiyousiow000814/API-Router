use reqwest::header::ACCEPT;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde_json::Map;
use serde_json::Value;
use std::pin::Pin;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

use super::config::ProviderConfig;

const WEBSOCKET_CONNECT_TIMEOUT_SECONDS: u64 = 10;

pub struct WebSocketResponseResult {
    pub response: Value,
}

pub struct WebSocketSseStreamResult {
    pub stream: Pin<Box<dyn futures_util::Stream<Item = Result<bytes::Bytes, String>> + Send>>,
}

#[derive(Clone)]
pub struct UpstreamClient {
    client: reqwest::Client,
}

fn build_upstream_url(base_url: &str, path: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let rel = path.trim_start_matches('/');
    format!("{}/{}", base, rel)
}

fn apply_auth_headers(headers: &mut HeaderMap, api_key: Option<&str>, client_auth: Option<&str>) {
    if let Some(k) = api_key {
        let hv = HeaderValue::from_str(&format!("Bearer {}", k)).unwrap();
        headers.insert(AUTHORIZATION, hv);
    } else if let Some(auth) = client_auth {
        if let Ok(hv) = HeaderValue::from_str(auth) {
            headers.insert(AUTHORIZATION, hv);
        }
    }
}

fn build_realtime_ws_url(payload: &Value, provider: &ProviderConfig) -> Result<String, String> {
    let http_url = build_upstream_url(&provider.base_url, "/realtime");
    let mut url = reqwest::Url::parse(&http_url).map_err(|e| e.to_string())?;
    match url.scheme() {
        "https" => {
            let _ = url.set_scheme("wss");
        }
        "http" => {
            let _ = url.set_scheme("ws");
        }
        other => return Err(format!("unsupported websocket base scheme: {other}")),
    }
    if let Some(model) = payload
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        url.query_pairs_mut().append_pair("model", model);
    }
    Ok(url.to_string())
}

fn build_realtime_response_create_event(payload: &Value) -> Value {
    let mut response = Map::new();
    if let Some(obj) = payload.as_object() {
        for key in [
            "input",
            "instructions",
            "tools",
            "tool_choice",
            "temperature",
            "max_output_tokens",
            "metadata",
            "modalities",
            "audio",
            "reasoning",
        ] {
            if let Some(value) = obj.get(key) {
                response.insert(key.to_string(), value.clone());
            }
        }
    }
    serde_json::json!({
        "type": "response.create",
        "response": Value::Object(response)
    })
}

fn websocket_message_text(message: WsMessage) -> Result<Option<String>, String> {
    match message {
        WsMessage::Text(text) => Ok(Some(text.to_string())),
        WsMessage::Binary(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|e| e.to_string()),
        WsMessage::Ping(_) | WsMessage::Pong(_) => Ok(None),
        WsMessage::Close(frame) => Err(format!("websocket closed before response.done: {frame:?}")),
        other => Err(format!("unsupported websocket message: {other:?}")),
    }
}

fn websocket_response_failure(response: &Value) -> Option<String> {
    let status = response.get("status").and_then(Value::as_str)?.trim();
    if status.eq_ignore_ascii_case("completed") {
        return None;
    }

    let detail = response
        .get("error")
        .and_then(Value::as_object)
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|message| !message.is_empty());

    Some(match detail {
        Some(message) => format!("websocket response ended with status {status}: {message}"),
        None => format!("websocket response ended with status {status}"),
    })
}

impl UpstreamClient {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .user_agent("api-router/0.1")
            // Avoid hanging forever on broken upstream TCP handshakes.
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("reqwest client");
        Self { client }
    }

    pub async fn post_json(
        &self,
        provider: &ProviderConfig,
        path: &str,
        payload: &Value,
        api_key: Option<&str>,
        client_auth: Option<&str>,
        timeout_seconds: u64,
    ) -> Result<(u16, Value), reqwest::Error> {
        let url = build_upstream_url(&provider.base_url, path);
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        apply_auth_headers(&mut headers, api_key, client_auth);

        let r = self
            .client
            .post(url)
            .headers(headers)
            .timeout(std::time::Duration::from_secs(timeout_seconds))
            .json(payload)
            .send()
            .await?;

        let status = r.status().as_u16();
        let j = r.json::<Value>().await.unwrap_or(Value::Null);
        Ok((status, j))
    }

    pub async fn post_sse(
        &self,
        provider: &ProviderConfig,
        path: &str,
        payload: &Value,
        api_key: Option<&str>,
        client_auth: Option<&str>,
        timeout_seconds: u64,
    ) -> Result<reqwest::Response, reqwest::Error> {
        let url = build_upstream_url(&provider.base_url, path);
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
        apply_auth_headers(&mut headers, api_key, client_auth);

        let _ = timeout_seconds;
        // Do NOT set a total request timeout for streaming; it would abort long-running streams
        // even when data is flowing. The gateway applies an idle timeout while relaying chunks.
        self.client
            .post(url)
            .headers(headers)
            .json(payload)
            .send()
            .await
    }

    pub async fn get_json(
        &self,
        provider: &ProviderConfig,
        path: &str,
        api_key: Option<&str>,
        client_auth: Option<&str>,
        timeout_seconds: u64,
    ) -> Result<(u16, Value), reqwest::Error> {
        let url = build_upstream_url(&provider.base_url, path);
        let mut headers = HeaderMap::new();
        apply_auth_headers(&mut headers, api_key, client_auth);

        let r = self
            .client
            .get(url)
            .headers(headers)
            .timeout(std::time::Duration::from_secs(timeout_seconds))
            .send()
            .await?;
        let status = r.status().as_u16();
        let j = r.json::<Value>().await.unwrap_or(Value::Null);
        Ok((status, j))
    }

    pub async fn post_json_via_websocket(
        &self,
        provider: &ProviderConfig,
        payload: &Value,
        api_key: Option<&str>,
        client_auth: Option<&str>,
        timeout_seconds: u64,
    ) -> Result<WebSocketResponseResult, String> {
        let ws_url = build_realtime_ws_url(payload, provider)?;
        let mut request = ws_url
            .into_client_request()
            .map_err(|e| format!("build websocket request failed: {e}"))?;
        let headers = request.headers_mut();
        headers.insert("OpenAI-Beta", HeaderValue::from_static("realtime=v1"));
        apply_auth_headers(headers, api_key, client_auth);

        let (mut socket, _) = tokio::time::timeout(
            std::time::Duration::from_secs(WEBSOCKET_CONNECT_TIMEOUT_SECONDS),
            tokio_tungstenite::connect_async(request),
        )
        .await
        .map_err(|_| "websocket connect timeout".to_string())?
        .map_err(|e| format!("websocket connect failed: {e}"))?;

        let event = build_realtime_response_create_event(payload);
        futures_util::SinkExt::send(&mut socket, WsMessage::Text(event.to_string()))
            .await
            .map_err(|e| format!("websocket send failed: {e}"))?;

        loop {
            let next = tokio::time::timeout(
                std::time::Duration::from_secs(timeout_seconds),
                futures_util::StreamExt::next(&mut socket),
            )
            .await
            .map_err(|_| "websocket response timeout".to_string())?;
            let Some(message) = next else {
                return Err("websocket ended before response.done".to_string());
            };
            let message = message.map_err(|e| format!("websocket read failed: {e}"))?;
            let Some(text) = websocket_message_text(message)? else {
                continue;
            };
            let value: Value =
                serde_json::from_str(&text).map_err(|e| format!("invalid websocket JSON: {e}"))?;
            match value
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
            {
                "error" => {
                    let detail = value
                        .get("error")
                        .and_then(Value::as_object)
                        .and_then(|error| error.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("upstream websocket error");
                    return Err(detail.to_string());
                }
                "response.done" | "response.completed" => {
                    let response = value.get("response").cloned().unwrap_or(Value::Null);
                    let _ = futures_util::SinkExt::send(&mut socket, WsMessage::Close(None)).await;
                    if let Some(error) = websocket_response_failure(&response) {
                        return Err(error);
                    }
                    return Ok(WebSocketResponseResult { response });
                }
                _ => {}
            }
        }
    }

    pub async fn post_sse_via_websocket(
        &self,
        provider: &ProviderConfig,
        payload: &Value,
        api_key: Option<&str>,
        client_auth: Option<&str>,
        timeout_seconds: u64,
    ) -> Result<WebSocketSseStreamResult, String> {
        let ws_url = build_realtime_ws_url(payload, provider)?;
        let mut request = ws_url
            .into_client_request()
            .map_err(|e| format!("build websocket request failed: {e}"))?;
        let headers = request.headers_mut();
        headers.insert("OpenAI-Beta", HeaderValue::from_static("realtime=v1"));
        apply_auth_headers(headers, api_key, client_auth);

        let (mut socket, _) = tokio::time::timeout(
            std::time::Duration::from_secs(WEBSOCKET_CONNECT_TIMEOUT_SECONDS),
            tokio_tungstenite::connect_async(request),
        )
        .await
        .map_err(|_| "websocket connect timeout".to_string())?
        .map_err(|e| format!("websocket connect failed: {e}"))?;

        let event = build_realtime_response_create_event(payload);
        futures_util::SinkExt::send(&mut socket, WsMessage::Text(event.to_string()))
            .await
            .map_err(|e| format!("websocket send failed: {e}"))?;

        let stream = async_stream::stream! {
            loop {
                let next = tokio::time::timeout(
                    std::time::Duration::from_secs(timeout_seconds),
                    futures_util::StreamExt::next(&mut socket),
                )
                .await;
                let next = match next {
                    Ok(next) => next,
                    Err(_) => {
                        yield Err("websocket response timeout".to_string());
                        break;
                    }
                };
                let Some(message) = next else {
                    yield Err("websocket ended before completion".to_string());
                    break;
                };
                let message = match message {
                    Ok(message) => message,
                    Err(e) => {
                        yield Err(format!("websocket read failed: {e}"));
                        break;
                    }
                };
                let text = match websocket_message_text(message) {
                    Ok(Some(text)) => text,
                    Ok(None) => continue,
                    Err(e) => {
                        yield Err(e);
                        break;
                    }
                };
                let value: Value = match serde_json::from_str(&text) {
                    Ok(value) => value,
                    Err(e) => {
                        yield Err(format!("invalid websocket JSON: {e}"));
                        break;
                    }
                };
                match value
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                {
                    "error" => {
                        let detail = value
                            .get("error")
                            .and_then(Value::as_object)
                            .and_then(|error| error.get("message"))
                            .and_then(Value::as_str)
                            .unwrap_or("upstream websocket error");
                        yield Err(detail.to_string());
                        break;
                    }
                    "response.done" | "response.completed" => {
                        let response = value.get("response").cloned().unwrap_or(Value::Null);
                        if let Some(error) = websocket_response_failure(&response) {
                            yield Err(error);
                            break;
                        }
                        yield Ok(bytes::Bytes::from(format!("data: {text}\n\n")));
                        yield Ok(bytes::Bytes::from_static(b"data: [DONE]\n\n"));
                        let _ = futures_util::SinkExt::send(&mut socket, WsMessage::Close(None)).await;
                        break;
                    }
                    _ => {
                        yield Ok(bytes::Bytes::from(format!("data: {text}\n\n")));
                    }
                }
            }
        };

        Ok(WebSocketSseStreamResult {
            stream: Box::pin(stream),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::ws::{Message, WebSocketUpgrade};
    use axum::response::IntoResponse;
    use axum::routing::get;
    use axum::Router;
    use futures_util::StreamExt;
    use serde_json::json;

    async fn ws_done_handler(ws: WebSocketUpgrade) -> impl IntoResponse {
        ws.on_upgrade(|mut socket| async move {
            while let Some(Ok(message)) = socket.next().await {
                let Message::Text(text) = message else {
                    continue;
                };
                let payload: Value = serde_json::from_str(&text).expect("valid request payload");
                assert_eq!(
                    payload.get("type").and_then(Value::as_str),
                    Some("response.create")
                );
                socket
                    .send(Message::Text(
                        json!({
                            "type": "response.done",
                            "response": {
                                "id": "resp_ws_ok",
                                "model": "gpt-5.4",
                                "output": []
                            }
                        })
                        .to_string(),
                    ))
                    .await
                    .expect("send response.done");
                break;
            }
        })
    }

    #[tokio::test]
    async fn post_json_via_websocket_returns_response_done_payload() {
        let app = Router::new().route("/realtime", get(ws_done_handler));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let addr = listener.local_addr().expect("listener addr");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve axum");
        });

        let client = UpstreamClient::new();
        let provider = ProviderConfig {
            display_name: "WS Provider".to_string(),
            base_url: format!("http://{addr}"),
            group: None,
            disabled: false,
            supports_websockets: true,
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        };
        let result = client
            .post_json_via_websocket(
                &provider,
                &json!({
                    "model": "gpt-5.4",
                    "input": [],
                    "stream": false
                }),
                Some("sk-test"),
                None,
                5,
            )
            .await
            .expect("websocket response");
        assert_eq!(
            result.response.get("id").and_then(Value::as_str),
            Some("resp_ws_ok")
        );

        server.abort();
    }

    #[test]
    fn build_realtime_response_create_event_omits_http_only_fields() {
        let event = build_realtime_response_create_event(&json!({
            "model": "gpt-5.4",
            "input": [{"role": "user", "content": [{"type": "input_text", "text": "hello"}]}],
            "instructions": "be concise",
            "stream": false,
            "previous_response_id": "resp_prev"
        }));

        let response = event
            .get("response")
            .and_then(Value::as_object)
            .expect("response object");
        assert_eq!(
            response.get("instructions").and_then(Value::as_str),
            Some("be concise")
        );
        assert!(response.get("stream").is_none());
        assert!(response.get("previous_response_id").is_none());
    }

    #[test]
    fn websocket_response_failure_detects_non_completed_status() {
        assert_eq!(
            websocket_response_failure(&json!({
                "id": "resp_ws_failed",
                "status": "failed",
                "error": { "message": "upstream failed" }
            })),
            Some("websocket response ended with status failed: upstream failed".to_string())
        );
        assert_eq!(
            websocket_response_failure(&json!({
                "id": "resp_ws_ok",
                "status": "completed"
            })),
            None
        );
        assert_eq!(
            websocket_response_failure(&json!({
                "id": "resp_ws_ok"
            })),
            None
        );
    }

    #[test]
    fn build_upstream_url_appends_responses_to_openai_proxy_prefix() {
        assert_eq!(
            build_upstream_url("https://capi.quan2go.com/openai", "/responses"),
            "https://capi.quan2go.com/openai/responses"
        );
    }

    #[test]
    fn build_upstream_url_appends_responses_to_non_v1_base_url() {
        assert_eq!(
            build_upstream_url("https://yunyi.rdzhvip.com/codex", "/responses"),
            "https://yunyi.rdzhvip.com/codex/responses"
        );
    }

    #[test]
    fn build_upstream_url_preserves_base_url_owned_v1_segment() {
        assert_eq!(
            build_upstream_url("https://api-vip.codex-for.me/v1", "/responses"),
            "https://api-vip.codex-for.me/v1/responses"
        );
    }

    #[test]
    fn build_upstream_url_preserves_base_url_owned_v1_for_official_models() {
        assert_eq!(
            build_upstream_url("https://api.openai.com/v1", "/models"),
            "https://api.openai.com/v1/models"
        );
    }
}
