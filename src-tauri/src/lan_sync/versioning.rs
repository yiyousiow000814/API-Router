use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LanVersionKind {
    Capability,
    SyncContract,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LanVersionRule {
    name: &'static str,
    version: u32,
    kind: LanVersionKind,
    // Versioning policy:
    // 1. Bump the version whenever mixed-version peers could disagree on meaning, source of truth,
    //    replay behavior, or request/response payload semantics for this feature.
    // 2. Bump the version whenever a peer would need feature-specific branching to stay correct.
    // 3. If unsure, bump the version. Temporary mixed-version pauses are safer than silent divergence.
    bump_rule: &'static str,
}

pub(crate) const SYNC_DOMAIN_USAGE_REQUESTS: &str = "usage_requests";
pub(crate) const SYNC_DOMAIN_USAGE_HISTORY: &str = "usage_history";
pub(crate) const SYNC_DOMAIN_PROVIDER_DEFINITIONS: &str = "provider_definitions";
pub(crate) const SYNC_DOMAIN_SHARED_HEALTH: &str = "shared_health";
pub(crate) const SYNC_DOMAIN_SHARED_QUOTA: &str = "shared_quota";
pub(crate) const SYNC_DOMAIN_OFFICIAL_ACCOUNTS: &str = "official_accounts";

const LAN_VERSION_RULES: &[LanVersionRule] = &[
    LanVersionRule {
        name: "heartbeat",
        version: 1,
        kind: LanVersionKind::Capability,
        bump_rule: "Bump when heartbeat packet semantics or peer discovery expectations change.",
    },
    LanVersionRule {
        name: "status",
        version: 1,
        kind: LanVersionKind::Capability,
        bump_rule: "Bump when LAN status snapshot semantics or required fields change.",
    },
    LanVersionRule {
        name: "usage_sync",
        version: 2,
        kind: LanVersionKind::Capability,
        bump_rule:
            "Bump when usage HTTP sync route behavior or request/response expectations change.",
    },
    LanVersionRule {
        name: "edit_sync",
        version: 1,
        kind: LanVersionKind::Capability,
        bump_rule: "Bump when edit-event sync transport behavior or hint semantics change.",
    },
    LanVersionRule {
        name: "provider_definitions",
        version: 1,
        kind: LanVersionKind::Capability,
        bump_rule: "Bump when provider-definition follow/sync route behavior changes.",
    },
    LanVersionRule {
        name: SYNC_DOMAIN_OFFICIAL_ACCOUNTS,
        version: 1,
        kind: LanVersionKind::Capability,
        bump_rule: "Bump when official-account follow/sync route behavior changes.",
    },
    LanVersionRule {
        name: "config_source",
        version: 1,
        kind: LanVersionKind::Capability,
        bump_rule: "Bump when config-source follow/copy semantics exposed to peers change.",
    },
    LanVersionRule {
        name: "quota_refresh",
        version: 1,
        kind: LanVersionKind::Capability,
        bump_rule: "Bump when quota refresh packet behavior or expectations change.",
    },
    LanVersionRule {
        name: "sync_contract",
        version: 2,
        kind: LanVersionKind::Capability,
        bump_rule: "Bump when heartbeat-advertised sync contract negotiation itself changes.",
    },
    LanVersionRule {
        name: "remote_update",
        version: 2,
        kind: LanVersionKind::Capability,
        bump_rule:
            "Bump when remote update request/debug flow, updater ownership, or rollback semantics change incompatibly.",
    },
    LanVersionRule {
        name: "lan_debug",
        version: 2,
        kind: LanVersionKind::Capability,
        bump_rule: "Bump when LAN diagnostics/debug endpoints change incompatibly.",
    },
    LanVersionRule {
        name: SYNC_DOMAIN_USAGE_REQUESTS,
        version: 2,
        kind: LanVersionKind::SyncContract,
        bump_rule:
            "Bump when usage request sync rows change shape or mixed-version semantics diverge.",
    },
    LanVersionRule {
        name: SYNC_DOMAIN_USAGE_HISTORY,
        version: 4,
        kind: LanVersionKind::SyncContract,
        bump_rule:
            "Bump when usage history truth, projection, replay, or payload semantics change.",
    },
    LanVersionRule {
        name: SYNC_DOMAIN_PROVIDER_DEFINITIONS,
        version: 1,
        kind: LanVersionKind::SyncContract,
        bump_rule: "Bump when provider-definition sync payloads or merge semantics change.",
    },
    LanVersionRule {
        name: SYNC_DOMAIN_OFFICIAL_ACCOUNTS,
        version: 1,
        kind: LanVersionKind::SyncContract,
        bump_rule: "Bump when official-account sync payloads or import semantics change.",
    },
    LanVersionRule {
        name: SYNC_DOMAIN_SHARED_HEALTH,
        version: 2,
        kind: LanVersionKind::SyncContract,
        bump_rule: "Bump when shared health payloads or selection semantics change.",
    },
    LanVersionRule {
        name: SYNC_DOMAIN_SHARED_QUOTA,
        version: 2,
        kind: LanVersionKind::SyncContract,
        bump_rule:
            "Bump when shared quota owner selection, quota snapshot payloads, or canonical quota semantics change.",
    },
];

fn version_label(name: &str, version: u32) -> String {
    format!("{name}_v{version}")
}

pub(crate) fn lan_heartbeat_capabilities() -> Vec<String> {
    LAN_VERSION_RULES
        .iter()
        .filter(|rule| rule.kind == LanVersionKind::Capability)
        .map(|rule| version_label(rule.name, rule.version))
        .collect()
}

pub(crate) fn local_sync_contracts() -> BTreeMap<String, u32> {
    LAN_VERSION_RULES
        .iter()
        .filter(|rule| rule.kind == LanVersionKind::SyncContract)
        .map(|rule| (rule.name.to_string(), rule.version))
        .collect()
}

pub(crate) fn merge_version_inventory(
    capabilities: &[String],
    sync_contracts: &BTreeMap<String, u32>,
) -> Vec<String> {
    let mut values = capabilities
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let mut contracts = sync_contracts
        .iter()
        .map(|(domain, version)| version_label(domain, *version))
        .collect::<Vec<_>>();
    contracts.sort();
    values.extend(contracts);
    values.sort();
    values.dedup();
    values
}

pub(crate) fn local_version_inventory() -> Vec<String> {
    merge_version_inventory(&lan_heartbeat_capabilities(), &local_sync_contracts())
}

#[cfg(test)]
pub(crate) fn version_bump_rules() -> Vec<(String, u32, &'static str)> {
    LAN_VERSION_RULES
        .iter()
        .map(|rule| (rule.name.to_string(), rule.version, rule.bump_rule))
        .collect()
}
