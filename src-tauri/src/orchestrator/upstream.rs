use reqwest::header::ACCEPT;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde_json::Value;

use super::config::ProviderConfig;

#[derive(Clone)]
pub struct UpstreamClient {
    client: reqwest::Client,
}

fn build_upstream_url(base_url: &str, path: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let mut rel = path.trim_start_matches('/');
    if base.ends_with("/v1") && rel.starts_with("v1/") {
        rel = rel.trim_start_matches("v1/");
    }
    format!("{}/{}", base, rel)
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

        if let Some(k) = api_key {
            let hv = HeaderValue::from_str(&format!("Bearer {}", k)).unwrap();
            headers.insert(AUTHORIZATION, hv);
        } else if let Some(auth) = client_auth {
            if let Ok(hv) = HeaderValue::from_str(auth) {
                headers.insert(AUTHORIZATION, hv);
            }
        }

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

        if let Some(k) = api_key {
            let hv = HeaderValue::from_str(&format!("Bearer {}", k)).unwrap();
            headers.insert(AUTHORIZATION, hv);
        } else if let Some(auth) = client_auth {
            if let Ok(hv) = HeaderValue::from_str(auth) {
                headers.insert(AUTHORIZATION, hv);
            }
        }

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
        if let Some(k) = api_key {
            let hv = HeaderValue::from_str(&format!("Bearer {}", k)).unwrap();
            headers.insert(AUTHORIZATION, hv);
        } else if let Some(auth) = client_auth {
            if let Ok(hv) = HeaderValue::from_str(auth) {
                headers.insert(AUTHORIZATION, hv);
            }
        }

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
}
