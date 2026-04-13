use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LanSharedErrorEventPacket {
    pub(crate) event_id: String,
    pub(crate) unix_ms: u64,
    pub(crate) level: String,
    pub(crate) code: String,
    pub(crate) message: String,
    #[serde(default)]
    pub(crate) fields: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LanSharedHealthPacket {
    pub(crate) version: u8,
    pub(crate) node_id: String,
    pub(crate) node_name: String,
    pub(crate) sent_at_unix_ms: u64,
    pub(crate) shared_provider_fingerprint: String,
    pub(crate) status: String,
    pub(crate) consecutive_failures: u32,
    pub(crate) cooldown_until_unix_ms: u64,
    pub(crate) last_error: String,
    pub(crate) last_ok_at_unix_ms: u64,
    pub(crate) last_fail_at_unix_ms: u64,
    pub(crate) shared_probe_required: bool,
    #[serde(default)]
    pub(crate) last_error_event: Option<LanSharedErrorEventPacket>,
}

fn broadcast_shared_health_packet(
    gateway: &crate::orchestrator::gateway::GatewayState,
    packet: &LanSharedHealthPacket,
) {
    let target = SocketAddr::from((Ipv4Addr::BROADCAST, LAN_DISCOVERY_PORT));
    let _ = send_packet_to_addr(
        gateway,
        target,
        &LanSyncPacket::SharedHealth(Box::new(packet.clone())),
    );
}

pub(crate) fn apply_shared_health_packet(
    runtime: &LanSyncRuntime,
    gateway: &crate::orchestrator::gateway::GatewayState,
    packet: LanSharedHealthPacket,
) {
    if packet.node_id.trim().is_empty() || packet.node_id == runtime.local_node.node_id {
        return;
    }
    if let Some(mut peer) = runtime.live_peer_by_node_id(&packet.node_id) {
        peer.trusted = gateway
            .secrets
            .trusted_lan_node_ids()
            .contains(&peer.node_id);
        if sync_contract_mismatch_detail(&peer, SYNC_DOMAIN_SHARED_HEALTH).is_some() {
            return;
        }
    }
    let cfg = gateway.cfg.read().clone();
    let shared = crate::orchestrator::router::SharedHealthSyncSnapshot {
        status: packet.status.clone(),
        consecutive_failures: packet.consecutive_failures,
        cooldown_until_unix_ms: packet.cooldown_until_unix_ms,
        last_error: packet.last_error.clone(),
        last_ok_at_unix_ms: packet.last_ok_at_unix_ms,
        last_fail_at_unix_ms: packet.last_fail_at_unix_ms,
        shared_probe_required: packet.shared_probe_required,
        updated_at_unix_ms: packet.sent_at_unix_ms,
        source_node_id: packet.node_id.clone(),
        source_is_local: false,
    };
    let mut applied = Vec::new();
    for provider_name in cfg.providers.keys() {
        let Some(fingerprint) = crate::orchestrator::quota::shared_provider_fingerprint(
            &cfg,
            &gateway.secrets,
            provider_name,
        ) else {
            continue;
        };
        if fingerprint != packet.shared_provider_fingerprint {
            continue;
        }
        if gateway
            .router
            .apply_shared_sync_snapshot(provider_name, &shared, false)
        {
            if let Some(event) = packet.last_error_event.as_ref() {
                record_shared_error_event(gateway, provider_name, &packet, event);
            }
            applied.push(provider_name.clone());
        }
    }
    let _ = applied;
}

fn record_shared_error_event(
    gateway: &crate::orchestrator::gateway::GatewayState,
    provider_name: &str,
    packet: &LanSharedHealthPacket,
    event: &LanSharedErrorEventPacket,
) {
    if !event.level.trim().eq_ignore_ascii_case("error") {
        return;
    }
    let local_event_id = format!(
        "shared:{}:{}:{}",
        packet.node_id.trim(),
        event.event_id.trim(),
        provider_name.trim()
    );
    let mut fields = match event.fields.clone() {
        Value::Object(map) => map,
        Value::Null => serde_json::Map::new(),
        other => serde_json::Map::from_iter([("value".to_string(), other)]),
    };
    fields.insert("origin".to_string(), Value::String("shared".to_string()));
    fields.insert(
        "source_node_id".to_string(),
        Value::String(packet.node_id.clone()),
    );
    fields.insert(
        "source_node_name".to_string(),
        Value::String(packet.node_name.clone()),
    );
    fields.insert(
        "shared_event_id".to_string(),
        Value::String(event.event_id.clone()),
    );
    fields.insert(
        "shared_provider_fingerprint".to_string(),
        Value::String(packet.shared_provider_fingerprint.clone()),
    );
    let _ = gateway
        .store
        .insert_event_row(crate::orchestrator::store::StoredEventRow {
            id: local_event_id,
            provider: provider_name.to_string(),
            level: "error".to_string(),
            code: event.code.clone(),
            message: event.message.clone(),
            fields: Value::Object(fields),
            unix_ms: event.unix_ms,
        });
}

fn build_shared_error_event_packet(
    gateway: &crate::orchestrator::gateway::GatewayState,
    provider_name: &str,
    shared: &crate::orchestrator::router::SharedHealthSyncSnapshot,
) -> Option<LanSharedErrorEventPacket> {
    if shared.last_error.trim().is_empty() || shared.last_fail_at_unix_ms == 0 {
        return None;
    }
    let event = gateway.store.find_recent_error_event_for_provider(
        provider_name,
        shared.last_fail_at_unix_ms,
        &shared.last_error,
    )?;
    Some(LanSharedErrorEventPacket {
        event_id: event.get("id")?.as_str()?.to_string(),
        unix_ms: event.get("unix_ms")?.as_u64()?,
        level: event.get("level")?.as_str()?.to_string(),
        code: event.get("code")?.as_str()?.to_string(),
        message: event.get("message")?.as_str()?.to_string(),
        fields: event.get("fields").cloned().unwrap_or(Value::Null),
    })
}

fn run_single_owner_recovery_probe(
    gateway: &crate::orchestrator::gateway::GatewayState,
    cfg: &AppConfig,
    provider_name: &str,
) {
    let Some(provider) = cfg.providers.get(provider_name).cloned() else {
        return;
    };
    let api_key = gateway.secrets.get_provider_key(provider_name);
    let now = unix_ms();
    let result = tauri::async_runtime::block_on(gateway.upstream.get_json(
        &provider,
        "/v1/models",
        api_key.as_deref(),
        None,
        cfg.routing.request_timeout_seconds,
    ));
    match result {
        Ok((status, _payload)) if (200..300).contains(&status) => {
            let _ = gateway.router.mark_success(provider_name, now);
            gateway.store.events().emit(
                provider_name,
                crate::orchestrator::store::EventCode::LAN_SHARED_RECOVERY_PROBE_OK,
                "shared cooldown recovery probe succeeded",
                serde_json::json!({ "owner_node": "local" }),
            );
        }
        Ok((status, _payload)) => {
            let detail = format!("shared recovery probe failed: http {status}");
            let _ = gateway
                .router
                .mark_failure(provider_name, cfg, &detail, now);
            gateway.store.events().emit(
                provider_name,
                crate::orchestrator::store::EventCode::LAN_SHARED_RECOVERY_PROBE_FAILED,
                &detail,
                serde_json::json!({
                    "owner_node": "local",
                    "http_status": status,
                }),
            );
        }
        Err(err) => {
            let detail = format!("shared recovery probe failed: {err}");
            let _ = gateway
                .router
                .mark_failure(provider_name, cfg, &detail, now);
            gateway.store.events().emit(
                provider_name,
                crate::orchestrator::store::EventCode::LAN_SHARED_RECOVERY_PROBE_FAILED,
                &detail,
                serde_json::json!({
                    "owner_node": "local",
                }),
            );
        }
    }
}

pub(crate) fn run_shared_health_loop(
    runtime: LanSyncRuntime,
    gateway: crate::orchestrator::gateway::GatewayState,
) {
    let mut last_broadcasted: HashMap<String, String> = HashMap::new();
    let mut last_probe_attempt_unix_ms: HashMap<String, u64> = HashMap::new();

    loop {
        let now = unix_ms();
        let cfg = gateway.cfg.read().clone();
        let mut by_fingerprint: HashMap<
            String,
            (
                String,
                crate::orchestrator::router::SharedHealthSyncSnapshot,
            ),
        > = HashMap::new();

        for provider_name in cfg.providers.keys() {
            let Some(fingerprint) = crate::orchestrator::quota::shared_provider_fingerprint(
                &cfg,
                &gateway.secrets,
                provider_name,
            ) else {
                continue;
            };
            let Some(shared) = gateway.router.shared_sync_snapshot(provider_name, now) else {
                continue;
            };
            if !shared.source_is_local {
                continue;
            }
            let replace = by_fingerprint
                .get(&fingerprint)
                .map(|(current_provider_name, current)| {
                    shared.updated_at_unix_ms > current.updated_at_unix_ms
                        || (shared.updated_at_unix_ms == current.updated_at_unix_ms
                            && provider_name < current_provider_name)
                })
                .unwrap_or(true);
            if replace {
                by_fingerprint.insert(fingerprint, (provider_name.clone(), shared));
            }
        }

        for (fingerprint, (provider_name, shared)) in by_fingerprint.iter() {
            for sibling_provider in cfg.providers.keys() {
                let Some(sibling_fingerprint) =
                    crate::orchestrator::quota::shared_provider_fingerprint(
                        &cfg,
                        &gateway.secrets,
                        sibling_provider,
                    )
                else {
                    continue;
                };
                if &sibling_fingerprint != fingerprint {
                    continue;
                }
                let _ = gateway
                    .router
                    .apply_shared_sync_snapshot(sibling_provider, shared, true);
            }

            let last_error_event = build_shared_error_event_packet(&gateway, provider_name, shared);
            let last_error_event_signature = last_error_event
                .as_ref()
                .map(|event| {
                    format!(
                        "{}|{}|{}|{}",
                        event.event_id, event.unix_ms, event.code, event.message
                    )
                })
                .unwrap_or_default();
            let signature = format!(
                "{}|{}|{}|{}|{}|{}",
                shared.updated_at_unix_ms,
                shared.status,
                shared.cooldown_until_unix_ms,
                shared.consecutive_failures,
                shared.last_ok_at_unix_ms,
                shared.last_fail_at_unix_ms,
            );
            let signature = format!("{signature}|{last_error_event_signature}");
            if last_broadcasted.get(fingerprint) == Some(&signature) {
                continue;
            }
            last_broadcasted.insert(fingerprint.clone(), signature);
            broadcast_shared_health_packet(
                &gateway,
                &LanSharedHealthPacket {
                    version: 1,
                    node_id: runtime.local_node.node_id.clone(),
                    node_name: runtime.local_node.node_name.clone(),
                    sent_at_unix_ms: shared.updated_at_unix_ms,
                    shared_provider_fingerprint: fingerprint.clone(),
                    status: shared.status.clone(),
                    consecutive_failures: shared.consecutive_failures,
                    cooldown_until_unix_ms: shared.cooldown_until_unix_ms,
                    last_error: shared.last_error.clone(),
                    last_ok_at_unix_ms: shared.last_ok_at_unix_ms,
                    last_fail_at_unix_ms: shared.last_fail_at_unix_ms,
                    shared_probe_required: shared.shared_probe_required,
                    last_error_event,
                },
            );
        }

        for provider_name in cfg.providers.keys() {
            let Some(fingerprint) = crate::orchestrator::quota::shared_provider_fingerprint(
                &cfg,
                &gateway.secrets,
                provider_name,
            ) else {
                continue;
            };
            let Some(shared) = gateway.router.shared_sync_snapshot(provider_name, now) else {
                continue;
            };
            if !shared.shared_probe_required
                || shared.cooldown_until_unix_ms == 0
                || now < shared.cooldown_until_unix_ms
            {
                continue;
            }
            if last_probe_attempt_unix_ms
                .get(&fingerprint)
                .is_some_and(|value| {
                    now.saturating_sub(*value) < LAN_SHARED_HEALTH_LOOP_INTERVAL_MS
                })
            {
                continue;
            }
            let trusted_node_ids = gateway.secrets.trusted_lan_node_ids();
            let Some(owner) = runtime.quota_owner_for_fingerprint(&fingerprint, &trusted_node_ids)
            else {
                continue;
            };
            if !owner.local_is_owner {
                continue;
            }
            last_probe_attempt_unix_ms.insert(fingerprint.clone(), now);
            run_single_owner_recovery_probe(&gateway, &cfg, provider_name);
        }

        std::thread::sleep(Duration::from_millis(LAN_SHARED_HEALTH_LOOP_INTERVAL_MS));
    }
}
