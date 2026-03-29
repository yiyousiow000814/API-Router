use serde_json::{Map, Value};

pub(super) fn build_thread_resume_params(
    thread_id: &str,
    service_tier: Option<Option<String>>,
    approval_policy: Option<String>,
    sandbox: Option<String>,
) -> Value {
    let mut params =
        Map::from_iter([("threadId".to_string(), Value::String(thread_id.to_string()))]);
    match service_tier {
        Some(Some(value)) => {
            params.insert(
                "serviceTier".to_string(),
                Value::String(value.trim().to_ascii_lowercase()),
            );
        }
        Some(None) => {
            params.insert("serviceTier".to_string(), Value::Null);
        }
        None => {}
    }
    if let Some(approval_policy) = approval_policy
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        params.insert("approvalPolicy".to_string(), Value::String(approval_policy));
    }
    if let Some(sandbox) = sandbox
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        params.insert("sandbox".to_string(), Value::String(sandbox));
    }
    Value::Object(params)
}

#[cfg(test)]
mod tests {
    use super::build_thread_resume_params;
    use serde_json::json;

    #[test]
    fn build_thread_resume_params_preserves_explicit_null_service_tier_override() {
        let params = build_thread_resume_params(
            "thread-1",
            Some(None),
            Some("never".to_string()),
            Some("dangerFullAccess".to_string()),
        );
        assert_eq!(
            params,
            json!({
                "threadId": "thread-1",
                "serviceTier": null,
                "approvalPolicy": "never",
                "sandbox": "dangerFullAccess"
            })
        );
    }
}
