use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::orchestrator::config::{AppConfig, ProviderConfig};
use crate::orchestrator::gateway::GatewayState;
use crate::orchestrator::secrets::{ProviderStateBundle, UsageLoginSecret};
use crate::orchestrator::store::unix_ms;

use super::{
    non_empty_raw, non_empty_trimmed, persist_gateway_config, ProviderDefinitionSnapshotPayload,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalProviderStateSnapshot {
    pub providers: BTreeMap<String, ProviderConfig>,
    pub provider_order: Vec<String>,
    pub preferred_provider: String,
    pub session_preferred_providers: BTreeMap<String, String>,
    pub provider_state: ProviderStateBundle,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LocalProviderCopyStateSnapshot {
    #[serde(default)]
    pub copied_shared_provider_ids: BTreeSet<String>,
}

fn followed_local_snapshot_meta_key() -> &'static str {
    "lan_follow_local_provider_snapshot"
}

fn followed_local_copy_state_meta_key() -> &'static str {
    "lan_follow_local_provider_copy_state"
}

pub fn save_local_provider_state_snapshot(
    state: &crate::app_state::AppState,
) -> Result<(), String> {
    let cfg = state.gateway.cfg.read().clone();
    let snapshot = LocalProviderStateSnapshot {
        providers: cfg.providers.clone(),
        provider_order: cfg.provider_order.clone(),
        preferred_provider: cfg.routing.preferred_provider.clone(),
        session_preferred_providers: cfg.routing.session_preferred_providers.clone(),
        provider_state: state.secrets.export_provider_state_bundle(),
    };
    write_local_provider_state_snapshot(state, &snapshot)
}

pub fn write_local_provider_state_snapshot(
    state: &crate::app_state::AppState,
    snapshot: &LocalProviderStateSnapshot,
) -> Result<(), String> {
    let payload = serde_json::to_string(snapshot).map_err(|err| err.to_string())?;
    state
        .gateway
        .store
        .set_event_meta(followed_local_snapshot_meta_key(), &payload)
        .map_err(|err| err.to_string())
}

pub fn load_local_provider_state_snapshot(
    state: &crate::app_state::AppState,
) -> Result<Option<LocalProviderStateSnapshot>, String> {
    let raw = state
        .gateway
        .store
        .get_event_meta(followed_local_snapshot_meta_key())
        .map_err(|err| err.to_string())?;
    raw.map(|value| serde_json::from_str(&value).map_err(|err| err.to_string()))
        .transpose()
}

pub fn clear_local_provider_state_snapshot(
    state: &crate::app_state::AppState,
) -> Result<(), String> {
    state
        .gateway
        .store
        .delete_event_meta(followed_local_snapshot_meta_key())
        .map_err(|err| err.to_string())
}

pub fn write_local_provider_copy_state(
    state: &crate::app_state::AppState,
    snapshot: &LocalProviderCopyStateSnapshot,
) -> Result<(), String> {
    let payload = serde_json::to_string(snapshot).map_err(|err| err.to_string())?;
    state
        .gateway
        .store
        .set_event_meta(followed_local_copy_state_meta_key(), &payload)
        .map_err(|err| err.to_string())
}

pub fn load_local_provider_copy_state(
    state: &crate::app_state::AppState,
) -> Result<LocalProviderCopyStateSnapshot, String> {
    let raw = state
        .gateway
        .store
        .get_event_meta(followed_local_copy_state_meta_key())
        .map_err(|err| err.to_string())?;
    raw.map(|value| serde_json::from_str(&value).map_err(|err| err.to_string()))
        .transpose()
        .map(|value| value.unwrap_or_default())
}

pub fn clear_local_provider_copy_state(state: &crate::app_state::AppState) -> Result<(), String> {
    state
        .gateway
        .store
        .delete_event_meta(followed_local_copy_state_meta_key())
        .map_err(|err| err.to_string())
}

fn normalize_followed_provider_name(
    used_names: &mut BTreeSet<String>,
    requested_name: &str,
    shared_provider_id: &str,
) -> String {
    let base_name = requested_name
        .trim()
        .to_string()
        .chars()
        .take(64)
        .collect::<String>();
    let base_name = if base_name.trim().is_empty() {
        let suffix: String = shared_provider_id.chars().take(8).collect();
        format!("shared_{suffix}")
    } else {
        base_name
    };
    let mut candidate = base_name.clone();
    let mut index = 2usize;
    while used_names.contains(&candidate) {
        candidate = format!("{base_name} [{index}]");
        index = index.saturating_add(1);
    }
    used_names.insert(candidate.clone());
    candidate
}

fn sanitize_active_routing_refs(cfg: &mut AppConfig) {
    if !cfg.providers.contains_key(&cfg.routing.preferred_provider)
        || cfg
            .providers
            .get(&cfg.routing.preferred_provider)
            .is_some_and(|provider| provider.disabled)
    {
        cfg.routing.preferred_provider = cfg
            .provider_order
            .iter()
            .find(|name| {
                cfg.providers
                    .get(*name)
                    .is_some_and(|provider| !provider.disabled)
            })
            .cloned()
            .or_else(|| {
                cfg.providers
                    .iter()
                    .find_map(|(name, provider)| (!provider.disabled).then(|| name.clone()))
            })
            .unwrap_or_default();
    }
    cfg.routing
        .session_preferred_providers
        .retain(|_, provider| cfg.providers.contains_key(provider));
}

fn build_followed_provider_state(
    gateway: &GatewayState,
    source_node_id: &str,
) -> Result<(AppConfig, ProviderStateBundle), String> {
    let mut snapshot_rows = gateway
        .store
        .list_lan_provider_definition_snapshots(source_node_id);
    if snapshot_rows.is_empty() {
        return Err(format!(
            "no synced provider definitions available yet for source: {source_node_id}"
        ));
    }
    snapshot_rows.sort_by(|left, right| {
        let left_order = left
            .snapshot
            .get("order_index")
            .and_then(|value| value.as_u64())
            .unwrap_or(u64::MAX);
        let right_order = right
            .snapshot
            .get("order_index")
            .and_then(|value| value.as_u64())
            .unwrap_or(u64::MAX);
        left_order
            .cmp(&right_order)
            .then_with(|| {
                left.provider_name
                    .to_ascii_lowercase()
                    .cmp(&right.provider_name.to_ascii_lowercase())
            })
            .then_with(|| left.shared_provider_id.cmp(&right.shared_provider_id))
    });
    let mut next_cfg = gateway.cfg.read().clone();
    let mut next_bundle = ProviderStateBundle::default();
    let current_bundle = gateway.secrets.export_provider_state_bundle();
    let mut next_providers = BTreeMap::new();
    let mut next_order = Vec::new();
    let mut used_names = BTreeSet::new();

    for row in snapshot_rows {
        let payload: ProviderDefinitionSnapshotPayload =
            serde_json::from_value(row.snapshot.clone()).map_err(|err| err.to_string())?;
        let provider_name = normalize_followed_provider_name(
            &mut used_names,
            &payload.name,
            &row.shared_provider_id,
        );
        next_order.push(provider_name.clone());
        next_providers.insert(
            provider_name.clone(),
            ProviderConfig {
                display_name: if payload.display_name.trim().is_empty() {
                    provider_name.clone()
                } else {
                    payload.display_name.clone()
                },
                base_url: payload.base_url.clone(),
                group: payload.group.clone(),
                disabled: payload.disabled,
                supports_websockets: payload.supports_websockets,
                usage_adapter: payload.usage_adapter.clone(),
                usage_base_url: payload.usage_base_url.clone(),
                api_key: String::new(),
            },
        );
        if let Some(key) = non_empty_trimmed(payload.key) {
            next_bundle.providers.insert(provider_name.clone(), key);
        }
        if let Some(storage) = non_empty_trimmed(payload.key_storage) {
            next_bundle
                .provider_key_storage_modes
                .insert(provider_name.clone(), storage);
        }
        if let Some(email) = non_empty_trimmed(payload.account_email) {
            next_bundle
                .provider_account_emails
                .insert(provider_name.clone(), email);
        }
        if let Some(token) = non_empty_trimmed(payload.usage_token) {
            next_bundle
                .usage_tokens
                .insert(provider_name.clone(), token);
        }
        if let (Some(username), Some(password)) = (
            non_empty_trimmed(payload.usage_login_username),
            non_empty_raw(payload.usage_login_password),
        ) {
            next_bundle.usage_logins.insert(
                provider_name.clone(),
                UsageLoginSecret { username, password },
            );
        }
        next_bundle
            .provider_shared_ids
            .insert(provider_name.clone(), row.shared_provider_id.clone());
        if let Some(existing_name) =
            current_bundle.find_provider_name_by_shared_id(&row.shared_provider_id)
        {
            if let Some(pricing) = current_bundle.provider_pricing.get(&existing_name) {
                next_bundle
                    .provider_pricing
                    .insert(provider_name.clone(), pricing.clone());
            }
            if let Some(hard_cap) = current_bundle.provider_quota_hard_cap.get(&existing_name) {
                next_bundle
                    .provider_quota_hard_cap
                    .insert(provider_name.clone(), *hard_cap);
            }
            if let Some(proxy_pool) = current_bundle.usage_proxy_pools.get(&existing_name) {
                next_bundle
                    .usage_proxy_pools
                    .insert(provider_name.clone(), proxy_pool.clone());
            }
        }
    }

    next_cfg.providers = next_providers;
    next_cfg.provider_order = next_order;
    crate::app_state::normalize_provider_order(&mut next_cfg);
    sanitize_active_routing_refs(&mut next_cfg);
    Ok((next_cfg, next_bundle))
}

pub fn apply_followed_provider_state(
    gateway: &GatewayState,
    config_path: &Path,
    source_node_id: &str,
) -> Result<(), String> {
    let (next_cfg, next_bundle) = build_followed_provider_state(gateway, source_node_id)?;
    let previous_cfg = gateway.cfg.read().clone();
    let previous_bundle = gateway.secrets.export_provider_state_bundle();
    gateway.secrets.replace_provider_state_bundle(next_bundle)?;
    gateway
        .store
        .sync_provider_pricing_configs(&gateway.secrets.list_provider_pricing());
    {
        let mut cfg = gateway.cfg.write();
        *cfg = next_cfg.clone();
    }
    if let Err(err) = persist_gateway_config(gateway, config_path) {
        gateway
            .secrets
            .replace_provider_state_bundle(previous_bundle)
            .map_err(|rollback_err| {
                format!(
                    "{err}; rollback failed while restoring provider state bundle: {rollback_err}"
                )
            })?;
        gateway
            .store
            .sync_provider_pricing_configs(&gateway.secrets.list_provider_pricing());
        {
            let mut cfg = gateway.cfg.write();
            *cfg = previous_cfg.clone();
        }
        gateway.router.sync_with_config(&previous_cfg, unix_ms());
        return Err(err);
    }
    gateway.router.sync_with_config(&next_cfg, unix_ms());
    Ok(())
}

pub fn restore_local_provider_state(state: &crate::app_state::AppState) -> Result<(), String> {
    let Some(snapshot) = load_local_provider_state_snapshot(state)? else {
        return Err("missing local provider snapshot for followed config source".to_string());
    };
    let previous_cfg = state.gateway.cfg.read().clone();
    let previous_bundle = state.secrets.export_provider_state_bundle();
    state
        .secrets
        .replace_provider_state_bundle(snapshot.provider_state.clone())?;
    state
        .gateway
        .store
        .sync_provider_pricing_configs(&state.secrets.list_provider_pricing());
    {
        let mut cfg = state.gateway.cfg.write();
        cfg.providers = snapshot.providers.clone();
        cfg.provider_order = snapshot.provider_order.clone();
        cfg.routing.preferred_provider = snapshot.preferred_provider.clone();
        cfg.routing.session_preferred_providers = snapshot.session_preferred_providers.clone();
        crate::app_state::normalize_provider_order(&mut cfg);
        sanitize_active_routing_refs(&mut cfg);
    }
    let next_cfg = state.gateway.cfg.read().clone();
    if let Err(err) = persist_gateway_config(&state.gateway, &state.config_path) {
        state
            .secrets
            .replace_provider_state_bundle(previous_bundle)
            .map_err(|rollback_err| {
                format!(
                    "{err}; rollback failed while restoring local provider state bundle: {rollback_err}"
                )
            })?;
        state
            .gateway
            .store
            .sync_provider_pricing_configs(&state.secrets.list_provider_pricing());
        {
            let mut cfg = state.gateway.cfg.write();
            *cfg = previous_cfg.clone();
        }
        state
            .gateway
            .router
            .sync_with_config(&previous_cfg, unix_ms());
        return Err(err);
    }
    state.gateway.router.sync_with_config(&next_cfg, unix_ms());
    clear_local_provider_state_snapshot(state)?;
    clear_local_provider_copy_state(state)?;
    Ok(())
}
