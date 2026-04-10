use axum::extract::{Json, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use chrono::TimeZone;
use serde_json::Value;

fn tracked_spend_usd_value(day: &Value) -> Option<f64> {
    day.get("tracked_spend_usd")
        .and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_i64().map(|n| n as f64))
                .or_else(|| value.as_u64().map(|n| n as f64))
        })
        .filter(|value| value.is_finite() && *value > 0.0)
}

fn projection_provider_name(
    gateway: &crate::orchestrator::gateway::GatewayState,
    shared_provider_id: &str,
    provider_name_hint: &str,
) -> Result<String, String> {
    super::resolve_provider_name_for_shared_provider_id(
        gateway,
        shared_provider_id,
        provider_name_hint,
    )
    .or_else(|err| {
        let fallback = provider_name_hint.trim();
        if fallback.is_empty() {
            Err(err)
        } else {
            Ok(fallback.to_string())
        }
    })
}

fn tracked_spend_projection_day_key(
    row: &Value,
    fallback_started_at_unix_ms: u64,
) -> Result<String, String> {
    tracked_spend_history_day_key_for_debug(row)
        .or_else(|| {
            crate::orchestrator::store::Store::local_day_key_from_unix_ms(
                fallback_started_at_unix_ms,
            )
        })
        .ok_or_else(|| "tracked spend day payload is missing a valid day".to_string())
}

fn rebuild_shared_projection_day_from_sources(
    gateway: &crate::orchestrator::gateway::GatewayState,
    provider_name: &str,
    shared_provider_id: &str,
    day_key: &str,
) -> Result<(), String> {
    let source_rows = gateway
        .store
        .list_shared_tracked_spend_day_sources(shared_provider_id, day_key);
    let mut total_tracked_spend_usd = 0.0_f64;
    let mut updated_at_unix_ms = 0_u64;
    let mut latest_row: Option<&Value> = None;
    let mut source_nodes = Vec::new();

    for (_source_node_id, _source_node_name, source_updated_at_unix_ms, row) in &source_rows {
        let Some(tracked_spend_usd) = tracked_spend_usd_value(row) else {
            continue;
        };
        total_tracked_spend_usd += tracked_spend_usd;
        let row_updated_at = row
            .get("updated_at_unix_ms")
            .and_then(Value::as_u64)
            .or_else(|| row.get("ended_at_unix_ms").and_then(Value::as_u64))
            .or_else(|| row.get("started_at_unix_ms").and_then(Value::as_u64))
            .unwrap_or(*source_updated_at_unix_ms);
        updated_at_unix_ms = updated_at_unix_ms.max(row_updated_at);
        let replace_latest = latest_row
            .map(|current| {
                let current_updated_at = current
                    .get("updated_at_unix_ms")
                    .and_then(Value::as_u64)
                    .or_else(|| current.get("ended_at_unix_ms").and_then(Value::as_u64))
                    .or_else(|| current.get("started_at_unix_ms").and_then(Value::as_u64))
                    .unwrap_or(0);
                let current_started_at = current
                    .get("started_at_unix_ms")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let row_started_at = row
                    .get("started_at_unix_ms")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                (row_updated_at, row_started_at) >= (current_updated_at, current_started_at)
            })
            .unwrap_or(true);
        if replace_latest {
            latest_row = Some(row);
        }
        if let Some(node_id) = row
            .get("producer_node_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            source_nodes.push(serde_json::json!({
                "node_id": node_id,
                "node_name": row
                    .get("producer_node_name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
            }));
        }
    }

    if total_tracked_spend_usd <= 0.0 || !total_tracked_spend_usd.is_finite() {
        gateway
            .store
            .remove_shared_tracked_spend_day(shared_provider_id, day_key);
        return Ok(());
    }

    let row = serde_json::json!({
        "provider": provider_name,
        "shared_provider_id": shared_provider_id,
        "day_key": day_key,
        "tracked_spend_usd": total_tracked_spend_usd,
        "updated_at_unix_ms": updated_at_unix_ms,
        "api_key_ref": latest_row
            .and_then(|value| value.get("api_key_ref"))
            .and_then(Value::as_str)
            .unwrap_or("-"),
        "producer_node_id": latest_row
            .and_then(|value| value.get("producer_node_id"))
            .and_then(Value::as_str),
        "producer_node_name": latest_row
            .and_then(|value| value.get("producer_node_name"))
            .and_then(Value::as_str),
        "applied_from_node_id": latest_row
            .and_then(|value| value.get("applied_from_node_id"))
            .and_then(Value::as_str),
        "applied_from_node_name": latest_row
            .and_then(|value| value.get("applied_from_node_name"))
            .and_then(Value::as_str),
        "applied_at_unix_ms": latest_row
            .and_then(|value| value.get("applied_at_unix_ms"))
            .and_then(Value::as_u64),
        "tracked_source_nodes": source_nodes
    });
    gateway.store.put_shared_tracked_spend_day(
        provider_name,
        shared_provider_id,
        day_key,
        &row,
        updated_at_unix_ms,
    );
    Ok(())
}

pub(super) fn refresh_shared_tracked_spend_projection_for_event(
    gateway: &crate::orchestrator::gateway::GatewayState,
    event: &crate::orchestrator::store::LanEditSyncEvent,
) -> Result<(), String> {
    match event.entity_type.as_str() {
        super::LAN_EDIT_ENTITY_TRACKED_SPEND_DAY => {
            let payload: super::TrackedSpendDaySyncPayload =
                serde_json::from_value(event.payload.clone()).map_err(|err| err.to_string())?;
            let (shared_provider_id, _day_scope, source_node_id) =
                super::parse_day_scoped_entity_id(&event.entity_id, &event.node_id)?;
            let provider_name =
                projection_provider_name(gateway, shared_provider_id, &payload.provider_name)?;
            let day_key =
                tracked_spend_projection_day_key(&payload.row, payload.day_started_at_unix_ms)?;
            if event.op == "delete" {
                gateway.store.remove_shared_tracked_spend_day_source(
                    shared_provider_id,
                    &day_key,
                    source_node_id,
                );
                return rebuild_shared_projection_day_from_sources(
                    gateway,
                    &provider_name,
                    shared_provider_id,
                    &day_key,
                );
            }

            let mut row = payload.row.clone();
            let (producer_node_id, producer_node_name) =
                super::tracked_spend_day_source_identity(&row, source_node_id, &event.node_name)
                    .ok_or_else(|| {
                        "tracked spend day row is missing a source node id".to_string()
                    })?;
            let applied_at_unix_ms = if event.created_at_unix_ms > 0 {
                event.created_at_unix_ms
            } else {
                crate::orchestrator::store::unix_ms()
            };
            if let Some(map) = row.as_object_mut() {
                map.insert(
                    "producer_node_id".to_string(),
                    Value::String(producer_node_id.clone()),
                );
                map.insert(
                    "producer_node_name".to_string(),
                    Value::String(producer_node_name.clone()),
                );
                map.insert(
                    "applied_from_node_id".to_string(),
                    Value::String(event.node_id.clone()),
                );
                map.insert(
                    "applied_from_node_name".to_string(),
                    Value::String(event.node_name.clone()),
                );
                map.insert(
                    "applied_at_unix_ms".to_string(),
                    serde_json::json!(applied_at_unix_ms),
                );
            }
            let row_updated_at = row
                .get("updated_at_unix_ms")
                .and_then(Value::as_u64)
                .or_else(|| row.get("ended_at_unix_ms").and_then(Value::as_u64))
                .or_else(|| row.get("started_at_unix_ms").and_then(Value::as_u64))
                .unwrap_or(applied_at_unix_ms);
            gateway.store.put_shared_tracked_spend_day_source(
                &crate::orchestrator::store::SharedTrackedSpendDaySourceRow {
                    provider: provider_name.clone(),
                    shared_provider_id: shared_provider_id.to_string(),
                    day_key: day_key.clone(),
                    source_node_id: source_node_id.to_string(),
                    source_node_name: producer_node_name.clone(),
                    row,
                    updated_at_unix_ms: row_updated_at,
                },
            );
            rebuild_shared_projection_day_from_sources(
                gateway,
                &provider_name,
                shared_provider_id,
                &day_key,
            )
        }
        super::LAN_EDIT_ENTITY_TRACKED_SPEND_DAY_HISTORY_DELETE => {
            let payload: super::TrackedSpendHistoryDayDeleteSyncPayload =
                serde_json::from_value(event.payload.clone()).map_err(|err| err.to_string())?;
            let (shared_provider_id, day_key) =
                super::parse_provider_day_entity_id(&event.entity_id)?;
            let provider_name =
                projection_provider_name(gateway, shared_provider_id, &payload.provider_name)?;
            gateway
                .store
                .remove_shared_tracked_spend_day_sources(shared_provider_id, day_key);
            gateway
                .store
                .remove_shared_tracked_spend_day(shared_provider_id, day_key);
            rebuild_shared_projection_day_from_sources(
                gateway,
                &provider_name,
                shared_provider_id,
                day_key,
            )
        }
        _ => Ok(()),
    }
}

pub(crate) fn rebuild_shared_tracked_spend_views(
    state: &crate::app_state::AppState,
) -> Result<(), String> {
    state.gateway.store.clear_shared_tracked_spend_days();
    state.gateway.store.clear_shared_tracked_spend_day_sources();
    let mut failures = Vec::new();
    for event in state
        .gateway
        .store
        .list_tracked_spend_history_projection_events()
    {
        if let Err(err) = refresh_shared_tracked_spend_projection_for_event(&state.gateway, &event)
        {
            failures.push(format!("{}:{}:{}", event.entity_type, event.entity_id, err));
        }
    }
    if !failures.is_empty() {
        super::append_lan_peer_diagnostics_log(&format!(
            "shared tracked spend rebuild skipped {} invalid event(s): {}",
            failures.len(),
            failures.join(" | ")
        ));
    }
    Ok(())
}

pub(crate) fn tracked_spend_history_day_key_for_debug(day: &Value) -> Option<String> {
    let started_at_unix_ms = day
        .get("started_at_unix_ms")
        .and_then(Value::as_u64)
        .or_else(|| {
            day.get("ended_at_unix_ms")
                .and_then(Value::as_u64)
                .map(|value| value.saturating_sub(1))
        })
        .or_else(|| day.get("updated_at_unix_ms").and_then(Value::as_u64))?;
    let local = chrono::Local
        .timestamp_millis_opt(started_at_unix_ms as i64)
        .single()?;
    Some(local.format("%Y-%m-%d").to_string())
}

fn tracked_spend_history_debug_row(
    day: &Value,
    local_node_id: &str,
) -> Option<super::LanTrackedSpendHistoryDiagnosticRow> {
    let day_key = tracked_spend_history_day_key_for_debug(day)?;
    let producer_node_id = day
        .get("producer_node_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(local_node_id)
        .to_string();
    let producer_node_name = day
        .get("producer_node_name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(producer_node_id.as_str())
        .to_string();
    Some(super::LanTrackedSpendHistoryDiagnosticRow {
        producer_node_id,
        producer_node_name,
        day_key,
        day_started_at_unix_ms: day.get("started_at_unix_ms").and_then(Value::as_u64),
        started_at_unix_ms: day.get("started_at_unix_ms").and_then(Value::as_u64),
        ended_at_unix_ms: day.get("ended_at_unix_ms").and_then(Value::as_u64),
        updated_at_unix_ms: day.get("updated_at_unix_ms").and_then(Value::as_u64),
        tracked_spend_usd: day.get("tracked_spend_usd").and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_i64().map(|value| value as f64))
                .or_else(|| value.as_u64().map(|value| value as f64))
        }),
        last_seen_daily_spent_usd: day.get("last_seen_daily_spent_usd").and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_i64().map(|value| value as f64))
                .or_else(|| value.as_u64().map(|value| value as f64))
        }),
        api_key_ref: day
            .get("api_key_ref")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        row: day.clone(),
    })
}

fn tracked_spend_debug_event_matches_day(
    event: &crate::orchestrator::store::LanEditSyncEvent,
    shared_provider_id: &str,
    day_key: &str,
) -> bool {
    match event.entity_type.as_str() {
        super::LAN_EDIT_ENTITY_TRACKED_SPEND_DAY => {
            let Ok((event_shared_provider_id, day_scope, _source_node_id)) =
                super::parse_day_scoped_entity_id(&event.entity_id, &event.node_id)
            else {
                return false;
            };
            if event_shared_provider_id != shared_provider_id {
                return false;
            }
            if day_scope == day_key {
                return true;
            }
            day_scope
                .parse::<u64>()
                .ok()
                .and_then(crate::orchestrator::store::Store::local_day_key_from_unix_ms)
                .as_deref()
                == Some(day_key)
        }
        super::LAN_EDIT_ENTITY_TRACKED_SPEND_DAY_HISTORY_DELETE => {
            let Ok((event_shared_provider_id, event_day_key)) =
                super::parse_provider_day_entity_id(&event.entity_id)
            else {
                return false;
            };
            event_shared_provider_id == shared_provider_id && event_day_key == day_key
        }
        _ => false,
    }
}

pub(crate) async fn lan_sync_tracked_spend_history_debug_http(
    State(gateway): State<crate::orchestrator::gateway::GatewayState>,
    headers: HeaderMap,
    Json(packet): Json<super::LanTrackedSpendHistoryDebugRequestPacket>,
) -> impl IntoResponse {
    if let Err(err) = super::authorize_lan_sync_http_request(&gateway, &headers, &packet.node_id) {
        return err.into_response();
    }
    let provider = packet.provider.trim();
    let day_key = packet.day_key.trim();
    if provider.is_empty() || day_key.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "ok": false,
                "error": "provider and day_key are required",
            })),
        )
            .into_response();
    }
    let shared_provider_id =
        match super::shared_provider_id_for_provider(&gateway.secrets, provider) {
            Ok(value) => value,
            Err(err) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "ok": false,
                        "error": err,
                    })),
                )
                    .into_response();
            }
        };
    let local_node = gateway.secrets.get_lan_node_identity();
    let local_node_id = local_node
        .as_ref()
        .map(|value| value.node_id.as_str())
        .unwrap_or_default();
    let local_rows = gateway
        .store
        .list_local_spend_days(provider)
        .into_iter()
        .filter_map(|day| tracked_spend_history_debug_row(&day, local_node_id))
        .filter(|row| row.day_key == day_key)
        .collect::<Vec<_>>();
    let remote_rows = gateway
        .store
        .list_spend_days(provider)
        .into_iter()
        .filter_map(|day| tracked_spend_history_debug_row(&day, local_node_id))
        .filter(|row| row.day_key == day_key && row.producer_node_id != local_node_id)
        .collect::<Vec<_>>();
    let limit = packet.limit.clamp(1, super::LAN_DEBUG_BATCH_LIMIT);
    let (all_edit_events, _) = gateway.store.list_lan_edit_events_batch(0, None, 4096);
    let recent_edit_events = all_edit_events
        .into_iter()
        .filter(|event| tracked_spend_debug_event_matches_day(event, &shared_provider_id, day_key))
        .collect::<Vec<_>>();
    let recent_edit_events = if recent_edit_events.len() > limit {
        recent_edit_events[recent_edit_events.len().saturating_sub(limit)..].to_vec()
    } else {
        recent_edit_events
    };
    let recent_remove_events = gateway
        .store
        .list_events_range(None, None, Some(512))
        .into_iter()
        .filter(|event| {
            event.get("provider").and_then(Value::as_str) == Some(provider)
                && event.get("code").and_then(Value::as_str)
                    == Some("usage.tracked_spend_history_entries_removed")
                && event
                    .get("fields")
                    .and_then(Value::as_object)
                    .and_then(|fields| fields.get("day_key"))
                    .and_then(Value::as_str)
                    == Some(day_key)
        })
        .take(limit)
        .collect::<Vec<_>>();
    Json(super::LanTrackedSpendHistoryDebugResponsePacket {
        ok: true,
        version: 1,
        node_id: local_node
            .as_ref()
            .map(|value| value.node_id.clone())
            .unwrap_or_default(),
        node_name: local_node
            .as_ref()
            .map(|value| value.node_name.clone())
            .unwrap_or_default(),
        local_node_id: local_node_id.to_string(),
        shared_provider_id,
        provider: provider.to_string(),
        day_key: day_key.to_string(),
        local_rows,
        remote_rows,
        recent_edit_events,
        recent_remove_events,
    })
    .into_response()
}
