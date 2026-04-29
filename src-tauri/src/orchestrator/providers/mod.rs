mod generic;
mod mapping;

use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};
use std::time::SystemTime;

use serde::Deserialize;

use super::config::ProviderConfig;
use super::quota::UsageKind;

pub(crate) use generic::derive_origin;
pub(crate) use mapping::{
    map_canonical_usage, CanonicalUsageContext, CanonicalUsageMapping, NumericFieldSpec,
    NumericTransform, StringFieldSpec, UnixMsAggregate, UnixMsFieldSpec, UnixMsRule,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PackageExpiryStrategy {
    None,
    BackendUsersInfo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RefreshFlow {
    Auto,
    LoginThenSummary,
    NewApiSubscriptionLogin,
    ProviderKeyCardLoginThenSummary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BudgetInfoAuthSource {
    UsageToken,
    ProviderKey,
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderQuotaProfile {
    pub refresh_flow: RefreshFlow,
    pub budget_info_auth_source: BudgetInfoAuthSource,
    pub usage_kind: UsageKind,
    pub ignore_remaining_when_budget_present: bool,
    pub candidate_bases: Vec<String>,
    pub speed_probe_bases: Vec<String>,
    pub explicit_usage_endpoint: Option<String>,
    pub explicit_usage_mapping: Option<&'static CanonicalUsageMapping>,
    pub budget_info_mapping: Option<&'static CanonicalUsageMapping>,
    pub summary_mapping: Option<&'static CanonicalUsageMapping>,
    pub package_expiry_strategy: PackageExpiryStrategy,
}

impl ProviderQuotaProfile {
    pub fn uses_login_summary_refresh(&self) -> bool {
        self.refresh_flow == RefreshFlow::LoginThenSummary
    }

    pub fn uses_new_api_subscription_login_refresh(&self) -> bool {
        self.refresh_flow == RefreshFlow::NewApiSubscriptionLogin
    }

    pub fn uses_provider_key_card_login_refresh(&self) -> bool {
        self.refresh_flow == RefreshFlow::ProviderKeyCardLoginThenSummary
    }

    pub fn uses_backend_users_info_expiry(&self) -> bool {
        self.package_expiry_strategy == PackageExpiryStrategy::BackendUsersInfo
    }
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub(crate) struct CanonicalProviderUsage {
    pub usage_kind: UsageKind,
    pub plan_name: Option<String>,
    pub mode: Option<String>,
    pub currency_unit: Option<String>,
    pub remaining: Option<f64>,
    pub today_used: Option<f64>,
    pub today_added: Option<f64>,
    pub daily_used: Option<f64>,
    pub daily_limit: Option<f64>,
    pub weekly_used: Option<f64>,
    pub weekly_limit: Option<f64>,
    pub monthly_used: Option<f64>,
    pub monthly_limit: Option<f64>,
    pub expires_at_unix_ms: Option<u64>,
    pub effective_usage_base: Option<String>,
    pub effective_usage_source: Option<String>,
    pub updated_at_unix_ms: u64,
}

#[derive(Debug, Clone)]
struct ProviderDefinition {
    id: String,
    matcher: ProviderMatcher,
    refresh_flow: RefreshFlow,
    budget_info_auth_source: BudgetInfoAuthSource,
    usage_kind: Option<UsageKind>,
    ignore_remaining_when_budget_present: bool,
    candidate_base_sources: Vec<CandidateBaseSource>,
    fixed_candidate_bases: Vec<String>,
    speed_probe_bases: Vec<String>,
    explicit_endpoint_mode: ExplicitEndpointMode,
    explicit_endpoint_url: Option<String>,
    explicit_usage_mapping: Option<&'static CanonicalUsageMapping>,
    budget_info_mapping: Option<&'static CanonicalUsageMapping>,
    summary_mapping: Option<&'static CanonicalUsageMapping>,
    package_expiry_strategy: PackageExpiryStrategy,
    request_prefers_simple_input_list: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProviderDefinitionFileFingerprint {
    path: PathBuf,
    modified_at_unix_ms: u128,
    len: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProviderRegistrySnapshot {
    files: Vec<ProviderDefinitionFileFingerprint>,
}

#[derive(Debug, Clone)]
struct ProviderRegistryState {
    registry: Vec<ProviderDefinition>,
    snapshot: ProviderRegistrySnapshot,
    last_checked_unix_ms: u64,
}

#[derive(Debug, Clone, Default)]
struct ProviderMatcher {
    base_url_hosts: Vec<String>,
    base_url_host_suffixes: Vec<String>,
    base_url_host_contains: Vec<String>,
    base_url_prefixes: Vec<String>,
    usage_base_url_suffixes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CandidateBaseSource {
    ExplicitUsageBaseUrl,
    OriginFromBaseUrl,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExplicitEndpointMode {
    None,
    Fixed,
    ExplicitUsageBaseUrlIfDirectPath,
}

#[derive(Debug, Deserialize)]
struct ProviderDefinitionFile {
    id: String,
    #[serde(rename = "match", default)]
    matcher: ProviderMatcherFile,
    #[serde(default)]
    usage: ProviderUsageFile,
    #[serde(default)]
    package_expiry: PackageExpiryFile,
}

#[derive(Debug, Default, Deserialize)]
struct ProviderMatcherFile {
    #[serde(default)]
    base_url_hosts: Vec<String>,
    #[serde(default)]
    base_url_host_suffixes: Vec<String>,
    #[serde(default)]
    base_url_host_contains: Vec<String>,
    #[serde(default)]
    base_url_prefixes: Vec<String>,
    #[serde(default)]
    usage_base_url_suffixes: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct ProviderUsageFile {
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    refresh_flow: Option<String>,
    #[serde(default)]
    budget_info_auth_source: Option<String>,
    #[serde(default)]
    ignore_remaining_when_budget_present: Option<bool>,
    #[serde(default)]
    candidate_base_sources: Vec<String>,
    #[serde(default)]
    fixed_candidate_bases: Vec<String>,
    #[serde(default)]
    speed_probe_bases: Vec<String>,
    #[serde(default)]
    explicit_endpoint_mode: Option<String>,
    #[serde(default)]
    explicit_endpoint_url: Option<String>,
    #[serde(default)]
    explicit_mapping: Option<CanonicalUsageMappingFile>,
    #[serde(default)]
    budget_info_mapping: Option<CanonicalUsageMappingFile>,
    #[serde(default)]
    summary_mapping: Option<CanonicalUsageMappingFile>,
    #[serde(default)]
    request_prefers_simple_input_list: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct PackageExpiryFile {
    #[serde(default)]
    strategy: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct CanonicalUsageMappingFile {
    #[serde(default)]
    usage_kind: Option<String>,
    #[serde(default)]
    plan_name: Option<StringFieldSpecFile>,
    #[serde(default)]
    mode: Option<StringFieldSpecFile>,
    #[serde(default)]
    currency_unit: Option<StringFieldSpecFile>,
    #[serde(default)]
    remaining: Option<NumericFieldSpecFile>,
    #[serde(default)]
    today_used: Option<NumericFieldSpecFile>,
    #[serde(default)]
    today_added: Option<NumericFieldSpecFile>,
    #[serde(default)]
    daily_used: Option<NumericFieldSpecFile>,
    #[serde(default)]
    daily_limit: Option<NumericFieldSpecFile>,
    #[serde(default)]
    weekly_used: Option<NumericFieldSpecFile>,
    #[serde(default)]
    weekly_limit: Option<NumericFieldSpecFile>,
    #[serde(default)]
    monthly_used: Option<NumericFieldSpecFile>,
    #[serde(default)]
    monthly_limit: Option<NumericFieldSpecFile>,
    #[serde(default)]
    expires_at_unix_ms: Option<UnixMsFieldSpecFile>,
    #[serde(default)]
    requires_any: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct NumericFieldSpecFile {
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    transform: Option<String>,
    #[serde(default)]
    treat_zero_as_missing: Option<bool>,
    #[serde(default)]
    default_value: Option<f64>,
    #[serde(default)]
    requires_any: Vec<String>,
    #[serde(default)]
    skip_if_any: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct StringFieldSpecFile {
    #[serde(default)]
    aliases: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct UnixMsFieldSpecFile {
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    rules: Vec<UnixMsRuleFile>,
}

#[derive(Debug, Default, Deserialize)]
struct UnixMsRuleFile {
    #[serde(default)]
    pointer: Option<String>,
    #[serde(default)]
    item_pointer: Option<String>,
    #[serde(default)]
    aggregate: Option<String>,
    #[serde(default)]
    filter_pointer: Option<String>,
    #[serde(default)]
    filter_eq: Option<String>,
    #[serde(default)]
    filter_in: Vec<String>,
}

const DEFAULT_DIRECT_USAGE_MAPPING: CanonicalUsageMapping = CanonicalUsageMapping {
    usage_kind: UsageKind::BudgetInfo,
    plan_name: None,
    mode: None,
    currency_unit: None,
    remaining: Some(NumericFieldSpec {
        aliases: &[
            "/remaining",
            "/remaining_quota",
            "/balance",
            "/quota/daily_remaining",
        ],
        transform: NumericTransform::None,
        treat_zero_as_missing: false,
        default_value: None,
        requires_any: &[],
        skip_if_any: &[],
    }),
    today_used: None,
    today_added: None,
    daily_used: Some(NumericFieldSpec {
        aliases: &[
            "/usage/today/actual_cost",
            "/usage/today/cost",
            "/quota/daily_spent",
            "/quota/daily_total_spent",
            "/usage/daily_spent",
            "/usage/daily_total_spent",
            "/daily_spent_usd",
            "/daily_usage_usd",
            "/subscription/daily_usage_usd",
        ],
        transform: NumericTransform::None,
        treat_zero_as_missing: false,
        default_value: None,
        requires_any: &[],
        skip_if_any: &[],
    }),
    daily_limit: Some(NumericFieldSpec {
        aliases: &[
            "/quota/daily_quota",
            "/daily_quota",
            "/daily_budget_usd",
            "/daily_limit_usd",
            "/subscription/daily_limit_usd",
        ],
        transform: NumericTransform::None,
        treat_zero_as_missing: false,
        default_value: None,
        requires_any: &[],
        skip_if_any: &[],
    }),
    weekly_used: None,
    weekly_limit: None,
    monthly_used: None,
    monthly_limit: None,
    expires_at_unix_ms: Some(UnixMsFieldSpec {
        aliases: &[
            "/timestamps/expires_at",
            "/expires_at",
            "/subscription/expires_at",
        ],
        rules: &[],
    }),
    requires_any: &[
        "/quota/daily_quota",
        "/daily_quota",
        "/daily_budget_usd",
        "/daily_limit_usd",
        "/quota/daily_spent",
        "/daily_spent_usd",
        "/remaining",
        "/balance",
        "/timestamps/expires_at",
    ],
};

const DEFAULT_BACKEND_BUDGET_MAPPING: CanonicalUsageMapping = CanonicalUsageMapping {
    usage_kind: UsageKind::BudgetInfo,
    plan_name: None,
    mode: None,
    currency_unit: None,
    remaining: Some(NumericFieldSpec {
        aliases: &["/remaining_quota"],
        transform: NumericTransform::None,
        treat_zero_as_missing: false,
        default_value: None,
        requires_any: &[],
        skip_if_any: &[],
    }),
    today_used: None,
    today_added: None,
    daily_used: Some(NumericFieldSpec {
        aliases: &["/daily_spent_usd"],
        transform: NumericTransform::None,
        treat_zero_as_missing: false,
        default_value: None,
        requires_any: &[],
        skip_if_any: &[],
    }),
    daily_limit: Some(NumericFieldSpec {
        aliases: &["/daily_budget_usd"],
        transform: NumericTransform::None,
        treat_zero_as_missing: false,
        default_value: None,
        requires_any: &[],
        skip_if_any: &[],
    }),
    weekly_used: Some(NumericFieldSpec {
        aliases: &["/weekly_spent_usd", "/weekly_spent"],
        transform: NumericTransform::None,
        treat_zero_as_missing: false,
        default_value: None,
        requires_any: &[],
        skip_if_any: &[],
    }),
    weekly_limit: Some(NumericFieldSpec {
        aliases: &["/weekly_budget_usd", "/weekly_budget"],
        transform: NumericTransform::None,
        treat_zero_as_missing: false,
        default_value: None,
        requires_any: &[],
        skip_if_any: &[],
    }),
    monthly_used: Some(NumericFieldSpec {
        aliases: &["/monthly_spent_usd"],
        transform: NumericTransform::None,
        treat_zero_as_missing: false,
        default_value: None,
        requires_any: &[],
        skip_if_any: &[],
    }),
    monthly_limit: Some(NumericFieldSpec {
        aliases: &["/monthly_budget_usd"],
        transform: NumericTransform::None,
        treat_zero_as_missing: false,
        default_value: None,
        requires_any: &[],
        skip_if_any: &[],
    }),
    expires_at_unix_ms: None,
    requires_any: &[
        "/daily_spent_usd",
        "/monthly_spent_usd",
        "/weekly_spent_usd",
        "/weekly_spent",
    ],
};

const PROVIDER_REGISTRY_REFRESH_DEBOUNCE_MS: u64 = 1_000;

fn provider_registry_state() -> &'static RwLock<ProviderRegistryState> {
    static REGISTRY: OnceLock<RwLock<ProviderRegistryState>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        let dirs = candidate_provider_definition_dirs();
        let snapshot = snapshot_provider_definition_dirs(&dirs);
        let registry = load_provider_registry_from_dirs(&dirs);
        RwLock::new(ProviderRegistryState {
            registry,
            snapshot,
            last_checked_unix_ms: crate::orchestrator::store::unix_ms(),
        })
    })
}

fn load_provider_registry_from_dirs(dirs: &[PathBuf]) -> Vec<ProviderDefinition> {
    let mut out = Vec::new();
    for dir in dirs {
        let mut paths = provider_definition_paths_in_dir(dir);
        paths.sort();
        for path in paths {
            match load_provider_definition_from_path(&path) {
                Ok(definition) => out.push(definition),
                Err(err) => eprintln!(
                    "failed to load provider definition {}: {err}",
                    path.display()
                ),
            }
        }
        if !out.is_empty() {
            break;
        }
    }
    out
}

fn candidate_provider_definition_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        dirs.push(cwd.join("providers"));
    }
    dirs.push(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap_or_else(|| std::path::Path::new(env!("CARGO_MANIFEST_DIR")))
            .join("providers"),
    );
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.join("providers"));
        }
    }
    let mut deduped = Vec::new();
    for dir in dirs {
        if !deduped
            .iter()
            .any(|existing: &std::path::PathBuf| existing == &dir)
        {
            deduped.push(dir);
        }
    }
    deduped
}

fn provider_definition_paths_in_dir(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("toml"))
        })
        .collect()
}

fn system_time_to_unix_ms(value: SystemTime) -> u128 {
    value
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn snapshot_provider_definition_dirs(dirs: &[PathBuf]) -> ProviderRegistrySnapshot {
    let mut files = Vec::new();
    for dir in dirs {
        for path in provider_definition_paths_in_dir(dir) {
            let Ok(metadata) = std::fs::metadata(&path) else {
                continue;
            };
            let modified_at_unix_ms = metadata.modified().map(system_time_to_unix_ms).unwrap_or(0);
            files.push(ProviderDefinitionFileFingerprint {
                path,
                modified_at_unix_ms,
                len: metadata.len(),
            });
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    ProviderRegistrySnapshot { files }
}

fn refresh_provider_registry_if_needed() {
    let now = crate::orchestrator::store::unix_ms();
    let state = provider_registry_state();
    {
        let current = state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if now.saturating_sub(current.last_checked_unix_ms) < PROVIDER_REGISTRY_REFRESH_DEBOUNCE_MS
        {
            return;
        }
    }

    let dirs = candidate_provider_definition_dirs();
    let snapshot = snapshot_provider_definition_dirs(&dirs);

    let mut current = state
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if now.saturating_sub(current.last_checked_unix_ms) < PROVIDER_REGISTRY_REFRESH_DEBOUNCE_MS {
        return;
    }
    refresh_provider_registry_state_for_dirs(&mut current, &dirs, now, Some(snapshot));
}

fn refresh_provider_registry_state_for_dirs(
    state: &mut ProviderRegistryState,
    dirs: &[PathBuf],
    now_unix_ms: u64,
    snapshot_override: Option<ProviderRegistrySnapshot>,
) {
    state.last_checked_unix_ms = now_unix_ms;
    let snapshot = snapshot_override.unwrap_or_else(|| snapshot_provider_definition_dirs(dirs));
    if state.snapshot == snapshot {
        return;
    }
    state.registry = load_provider_registry_from_dirs(dirs);
    state.snapshot = snapshot;
}

fn load_provider_definition_from_path(
    path: &std::path::Path,
) -> Result<ProviderDefinition, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|err| format!("failed to read {}: {err}", path.display()))?;
    let raw = toml::from_str::<ProviderDefinitionFile>(&text)
        .map_err(|err| format!("failed to parse {}: {err}", path.display()))?;
    ProviderDefinition::try_from(raw)
}

impl TryFrom<ProviderDefinitionFile> for ProviderDefinition {
    type Error = String;

    fn try_from(value: ProviderDefinitionFile) -> Result<Self, Self::Error> {
        let usage_kind = value
            .usage
            .kind
            .as_deref()
            .map(parse_usage_kind)
            .transpose()?;
        let refresh_flow =
            parse_refresh_flow(value.usage.refresh_flow.as_deref().unwrap_or("auto"))?;
        let budget_info_auth_source = parse_budget_info_auth_source(
            value
                .usage
                .budget_info_auth_source
                .as_deref()
                .unwrap_or("usage_token"),
        )?;
        let candidate_base_sources = value
            .usage
            .candidate_base_sources
            .iter()
            .map(|rule| parse_candidate_base_source(rule))
            .collect::<Result<Vec<_>, _>>()?;
        let explicit_endpoint_mode = parse_explicit_endpoint_mode(
            value
                .usage
                .explicit_endpoint_mode
                .as_deref()
                .unwrap_or("none"),
        )?;
        let package_expiry_strategy = parse_package_expiry_strategy(
            value.package_expiry.strategy.as_deref().unwrap_or("none"),
        )?;

        if value.id.trim().is_empty() {
            return Err("provider definition id cannot be empty".to_string());
        }

        if value.matcher.base_url_hosts.is_empty()
            && value.matcher.base_url_host_suffixes.is_empty()
            && value.matcher.base_url_host_contains.is_empty()
            && value.matcher.base_url_prefixes.is_empty()
            && value.matcher.usage_base_url_suffixes.is_empty()
        {
            return Err(format!(
                "provider definition {} must declare at least one matcher",
                value.id.trim()
            ));
        }

        Ok(Self {
            id: value.id.trim().to_string(),
            matcher: ProviderMatcher {
                base_url_hosts: normalize_match_values(value.matcher.base_url_hosts),
                base_url_host_suffixes: normalize_match_values(
                    value.matcher.base_url_host_suffixes,
                ),
                base_url_host_contains: normalize_match_values(
                    value.matcher.base_url_host_contains,
                ),
                base_url_prefixes: normalize_match_values(value.matcher.base_url_prefixes),
                usage_base_url_suffixes: normalize_match_values(
                    value.matcher.usage_base_url_suffixes,
                ),
            },
            refresh_flow,
            budget_info_auth_source,
            usage_kind,
            ignore_remaining_when_budget_present: value
                .usage
                .ignore_remaining_when_budget_present
                .unwrap_or(false),
            candidate_base_sources,
            fixed_candidate_bases: normalize_url_values(value.usage.fixed_candidate_bases),
            speed_probe_bases: normalize_url_values(value.usage.speed_probe_bases),
            explicit_endpoint_mode,
            explicit_endpoint_url: value
                .usage
                .explicit_endpoint_url
                .map(|value| value.trim().trim_end_matches('/').to_string())
                .filter(|value| !value.is_empty()),
            explicit_usage_mapping: value
                .usage
                .explicit_mapping
                .map(build_dynamic_mapping)
                .transpose()?,
            budget_info_mapping: value
                .usage
                .budget_info_mapping
                .map(build_dynamic_mapping)
                .transpose()?,
            summary_mapping: value
                .usage
                .summary_mapping
                .map(build_dynamic_mapping)
                .transpose()?,
            package_expiry_strategy,
            request_prefers_simple_input_list: value
                .usage
                .request_prefers_simple_input_list
                .unwrap_or(false),
        })
    }
}

fn normalize_match_values(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .map(|value| value.trim().trim_end_matches('/').to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .collect()
}

fn normalize_url_values(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

fn parse_refresh_flow(value: &str) -> Result<RefreshFlow, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "auto" => Ok(RefreshFlow::Auto),
        "login_then_summary" => Ok(RefreshFlow::LoginThenSummary),
        "new_api_subscription_login" => Ok(RefreshFlow::NewApiSubscriptionLogin),
        "provider_key_card_login_then_summary" => Ok(RefreshFlow::ProviderKeyCardLoginThenSummary),
        other => Err(format!("unknown refresh flow: {other}")),
    }
}

fn parse_budget_info_auth_source(value: &str) -> Result<BudgetInfoAuthSource, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "usage_token" => Ok(BudgetInfoAuthSource::UsageToken),
        "provider_key" => Ok(BudgetInfoAuthSource::ProviderKey),
        other => Err(format!("unknown budget info auth source: {other}")),
    }
}

fn parse_package_expiry_strategy(value: &str) -> Result<PackageExpiryStrategy, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "none" => Ok(PackageExpiryStrategy::None),
        "backend_users_info" => Ok(PackageExpiryStrategy::BackendUsersInfo),
        other => Err(format!("unknown package expiry strategy: {other}")),
    }
}

fn parse_usage_kind(value: &str) -> Result<UsageKind, String> {
    let kind = UsageKind::from_str(value);
    if kind == UsageKind::None && !value.trim().eq_ignore_ascii_case("none") {
        Err(format!("unknown usage kind: {}", value.trim()))
    } else {
        Ok(kind)
    }
}

fn parse_candidate_base_source(value: &str) -> Result<CandidateBaseSource, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "explicit_usage_base_url" => Ok(CandidateBaseSource::ExplicitUsageBaseUrl),
        "origin_from_base_url" => Ok(CandidateBaseSource::OriginFromBaseUrl),
        other => Err(format!("unknown candidate base source: {other}")),
    }
}

fn parse_explicit_endpoint_mode(value: &str) -> Result<ExplicitEndpointMode, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "none" => Ok(ExplicitEndpointMode::None),
        "fixed" => Ok(ExplicitEndpointMode::Fixed),
        "explicit_usage_base_url_if_direct_path" => {
            Ok(ExplicitEndpointMode::ExplicitUsageBaseUrlIfDirectPath)
        }
        other => Err(format!("unknown explicit endpoint mode: {other}")),
    }
}

fn build_dynamic_mapping(
    raw: CanonicalUsageMappingFile,
) -> Result<&'static CanonicalUsageMapping, String> {
    let mapping = CanonicalUsageMapping {
        usage_kind: parse_usage_kind(raw.usage_kind.as_deref().unwrap_or("none"))?,
        plan_name: raw.plan_name.map(build_string_field_spec).transpose()?,
        mode: raw.mode.map(build_string_field_spec).transpose()?,
        currency_unit: raw.currency_unit.map(build_string_field_spec).transpose()?,
        remaining: raw.remaining.map(build_numeric_field_spec).transpose()?,
        today_used: raw.today_used.map(build_numeric_field_spec).transpose()?,
        today_added: raw.today_added.map(build_numeric_field_spec).transpose()?,
        daily_used: raw.daily_used.map(build_numeric_field_spec).transpose()?,
        daily_limit: raw.daily_limit.map(build_numeric_field_spec).transpose()?,
        weekly_used: raw.weekly_used.map(build_numeric_field_spec).transpose()?,
        weekly_limit: raw.weekly_limit.map(build_numeric_field_spec).transpose()?,
        monthly_used: raw.monthly_used.map(build_numeric_field_spec).transpose()?,
        monthly_limit: raw
            .monthly_limit
            .map(build_numeric_field_spec)
            .transpose()?,
        expires_at_unix_ms: raw
            .expires_at_unix_ms
            .map(build_unix_ms_field_spec)
            .transpose()?,
        requires_any: leak_aliases(raw.requires_any)?,
    };
    Ok(Box::leak(Box::new(mapping)))
}

fn build_numeric_field_spec(raw: NumericFieldSpecFile) -> Result<NumericFieldSpec, String> {
    Ok(NumericFieldSpec {
        aliases: leak_aliases(raw.aliases)?,
        transform: match raw
            .transform
            .unwrap_or_else(|| "none".to_string())
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "none" => NumericTransform::None,
            "divide_by_100" => NumericTransform::DivideBy(100.0),
            other => return Err(format!("unknown numeric transform: {other}")),
        },
        treat_zero_as_missing: raw.treat_zero_as_missing.unwrap_or(false),
        default_value: raw.default_value,
        requires_any: leak_aliases(raw.requires_any)?,
        skip_if_any: leak_aliases(raw.skip_if_any)?,
    })
}

fn build_string_field_spec(raw: StringFieldSpecFile) -> Result<StringFieldSpec, String> {
    Ok(StringFieldSpec {
        aliases: leak_aliases(raw.aliases)?,
    })
}

fn build_unix_ms_field_spec(raw: UnixMsFieldSpecFile) -> Result<UnixMsFieldSpec, String> {
    Ok(UnixMsFieldSpec {
        aliases: leak_aliases(raw.aliases)?,
        rules: leak_unix_ms_rules(
            raw.rules
                .into_iter()
                .map(build_unix_ms_rule)
                .collect::<Result<Vec<_>, _>>()?,
        ),
    })
}

fn build_unix_ms_rule(raw: UnixMsRuleFile) -> Result<UnixMsRule, String> {
    let pointer = raw
        .pointer
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "unix ms rule pointer cannot be empty".to_string())?;
    if let Some(item_pointer) = raw
        .item_pointer
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        let aggregate = match raw
            .aggregate
            .unwrap_or_else(|| "first".to_string())
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "first" => UnixMsAggregate::First,
            "max" => UnixMsAggregate::Max,
            other => return Err(format!("unknown unix ms aggregate: {other}")),
        };
        let filter_pointer = raw
            .filter_pointer
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let filter_eq = raw
            .filter_eq
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let filter_in = raw
            .filter_in
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        return Ok(UnixMsRule::Array {
            pointer: Box::leak(pointer.into_boxed_str()),
            item_pointer: Box::leak(item_pointer.into_boxed_str()),
            aggregate,
            filter_pointer: filter_pointer
                .map(|value| Box::leak(value.into_boxed_str()) as &'static str),
            filter_eq: filter_eq.map(|value| Box::leak(value.into_boxed_str()) as &'static str),
            filter_in: leak_aliases(filter_in)?,
        });
    }

    Ok(UnixMsRule::Pointer(Box::leak(pointer.into_boxed_str())))
}

fn leak_aliases(values: Vec<String>) -> Result<&'static [&'static str], String> {
    let normalized = values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if normalized.is_empty() {
        return Ok(&[]);
    }
    let leaked = normalized
        .into_iter()
        .map(|value| Box::leak(value.into_boxed_str()) as &'static str)
        .collect::<Vec<_>>();
    Ok(Box::leak(leaked.into_boxed_slice()))
}

fn leak_unix_ms_rules(values: Vec<UnixMsRule>) -> &'static [UnixMsRule] {
    if values.is_empty() {
        return &[];
    }
    Box::leak(values.into_boxed_slice())
}

fn matched_provider_definition(provider: &ProviderConfig) -> Option<ProviderDefinition> {
    refresh_provider_registry_if_needed();
    let state = provider_registry_state()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state
        .registry
        .iter()
        .find(|definition| definition.matches(provider))
        .cloned()
}

fn matched_definition_for_base_url(base_url: &str) -> Option<ProviderDefinition> {
    let provider = ProviderConfig {
        display_name: String::new(),
        base_url: base_url.to_string(),
        group: None,
        disabled: false,
        supports_websockets: false,
        usage_adapter: String::new(),
        usage_base_url: None,
        api_key: String::new(),
    };
    matched_provider_definition(&provider)
}

fn definition_for_endpoint_url(endpoint_url: &str) -> Option<ProviderDefinition> {
    let endpoint_url = endpoint_url
        .trim()
        .trim_end_matches('/')
        .to_ascii_lowercase();
    let endpoint_path = parsed_path(&endpoint_url);

    refresh_provider_registry_if_needed();
    let state = provider_registry_state()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state
        .registry
        .iter()
        .find(|definition| {
            let fixed_match = definition
                .explicit_endpoint_url
                .as_deref()
                .is_some_and(|expected| expected.eq_ignore_ascii_case(&endpoint_url));
            let suffix_match = endpoint_path.as_deref().is_some_and(|path| {
                matches!(
                    definition.explicit_endpoint_mode,
                    ExplicitEndpointMode::ExplicitUsageBaseUrlIfDirectPath
                ) && definition
                    .matcher
                    .usage_base_url_suffixes
                    .iter()
                    .any(|suffix| path.ends_with(suffix))
            });
            fixed_match || suffix_match
        })
        .cloned()
}

impl ProviderDefinition {
    fn matches(&self, provider: &ProviderConfig) -> bool {
        let base_url = provider
            .base_url
            .trim()
            .trim_end_matches('/')
            .to_ascii_lowercase();
        let usage_base_url = provider
            .usage_base_url
            .as_deref()
            .map(|value| value.trim().trim_end_matches('/').to_ascii_lowercase())
            .unwrap_or_default();
        let base_host = parsed_host(&base_url);
        let usage_path = parsed_path(&usage_base_url);

        if !self.matcher.base_url_hosts.is_empty()
            && !base_host.as_deref().is_some_and(|host| {
                self.matcher
                    .base_url_hosts
                    .iter()
                    .any(|candidate| host == candidate)
            })
        {
            return false;
        }
        if !self.matcher.base_url_host_suffixes.is_empty()
            && !base_host.as_deref().is_some_and(|host| {
                self.matcher
                    .base_url_host_suffixes
                    .iter()
                    .any(|suffix| host.ends_with(suffix))
            })
        {
            return false;
        }
        if !self.matcher.base_url_host_contains.is_empty()
            && !base_host.as_deref().is_some_and(|host| {
                self.matcher
                    .base_url_host_contains
                    .iter()
                    .any(|needle| host.contains(needle))
            })
        {
            return false;
        }
        if !self.matcher.base_url_prefixes.is_empty()
            && !self
                .matcher
                .base_url_prefixes
                .iter()
                .any(|prefix| base_url.starts_with(prefix))
        {
            return false;
        }
        if !self.matcher.usage_base_url_suffixes.is_empty()
            && !usage_path.as_deref().is_some_and(|path| {
                self.matcher
                    .usage_base_url_suffixes
                    .iter()
                    .any(|suffix| path.ends_with(suffix))
            })
        {
            return false;
        }
        true
    }
}

fn parsed_host(raw: &str) -> Option<String> {
    reqwest::Url::parse(raw)
        .ok()
        .and_then(|url| url.host_str().map(|host| host.to_ascii_lowercase()))
}

fn parsed_path(raw: &str) -> Option<String> {
    reqwest::Url::parse(raw)
        .ok()
        .map(|url| url.path().trim_end_matches('/').to_ascii_lowercase())
}

pub(crate) fn detect_usage_kind(provider: &ProviderConfig) -> UsageKind {
    let explicit = UsageKind::from_str(&provider.usage_adapter);
    if explicit != UsageKind::None {
        return explicit;
    }
    matched_provider_definition(provider)
        .and_then(|definition| definition.usage_kind)
        .unwrap_or(UsageKind::None)
}

pub(crate) fn resolve_quota_profile(provider: &ProviderConfig) -> ProviderQuotaProfile {
    if let Some(definition) = matched_provider_definition(provider) {
        return ProviderQuotaProfile {
            refresh_flow: definition.refresh_flow,
            budget_info_auth_source: definition.budget_info_auth_source,
            usage_kind: detect_usage_kind(provider),
            ignore_remaining_when_budget_present: definition.ignore_remaining_when_budget_present,
            candidate_bases: candidate_quota_bases_from_definition(provider, &definition),
            speed_probe_bases: definition.speed_probe_bases.clone(),
            explicit_usage_endpoint: explicit_usage_endpoint_url_from_definition(
                provider,
                &definition,
            ),
            explicit_usage_mapping: definition.explicit_usage_mapping,
            budget_info_mapping: definition.budget_info_mapping,
            summary_mapping: definition.summary_mapping,
            package_expiry_strategy: definition.package_expiry_strategy,
        };
    }

    ProviderQuotaProfile {
        refresh_flow: RefreshFlow::Auto,
        budget_info_auth_source: BudgetInfoAuthSource::UsageToken,
        usage_kind: detect_usage_kind(provider),
        ignore_remaining_when_budget_present: false,
        candidate_bases: generic_candidate_quota_bases(provider),
        speed_probe_bases: Vec::new(),
        explicit_usage_endpoint: generic_explicit_usage_endpoint_url(provider),
        explicit_usage_mapping: None,
        budget_info_mapping: None,
        summary_mapping: None,
        package_expiry_strategy: PackageExpiryStrategy::None,
    }
}

pub(crate) fn explicit_usage_mapping(endpoint_url: &str) -> &'static CanonicalUsageMapping {
    explicit_usage_mapping_from_endpoint(Some(endpoint_url))
        .unwrap_or(&DEFAULT_DIRECT_USAGE_MAPPING)
}

pub(crate) fn default_budget_info_mapping() -> &'static CanonicalUsageMapping {
    &DEFAULT_BACKEND_BUDGET_MAPPING
}

fn explicit_usage_mapping_from_endpoint(
    endpoint_url: Option<&str>,
) -> Option<&'static CanonicalUsageMapping> {
    let endpoint_url = endpoint_url?.trim().trim_end_matches('/');
    if endpoint_url.is_empty() {
        return None;
    }
    definition_for_endpoint_url(endpoint_url)
        .and_then(|definition| definition.explicit_usage_mapping)
        .or(Some(&DEFAULT_DIRECT_USAGE_MAPPING))
}

#[cfg(test)]
pub(crate) fn explicit_usage_endpoint_url(provider: &ProviderConfig) -> Option<String> {
    matched_provider_definition(provider)
        .and_then(|definition| explicit_usage_endpoint_url_from_definition(provider, &definition))
        .or_else(|| generic_explicit_usage_endpoint_url(provider))
}

fn explicit_usage_endpoint_url_from_definition(
    provider: &ProviderConfig,
    definition: &ProviderDefinition,
) -> Option<String> {
    match definition.explicit_endpoint_mode {
        ExplicitEndpointMode::None => None,
        ExplicitEndpointMode::Fixed => definition.explicit_endpoint_url.clone(),
        ExplicitEndpointMode::ExplicitUsageBaseUrlIfDirectPath => provider
            .usage_base_url
            .as_deref()
            .and_then(explicit_usage_base_url_if_direct_path)
            .or_else(|| definition.explicit_endpoint_url.clone()),
    }
}

fn generic_explicit_usage_endpoint_url(provider: &ProviderConfig) -> Option<String> {
    provider
        .usage_base_url
        .as_deref()
        .and_then(explicit_usage_base_url_if_direct_path)
}

fn explicit_usage_base_url_if_direct_path(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let parsed = reqwest::Url::parse(raw).ok()?;
    let path = parsed.path().trim_end_matches('/');
    if path.is_empty() || path == "/" {
        return None;
    }
    let normalized = path.to_ascii_lowercase();
    if matches!(
        normalized.as_str(),
        "/v1" | "/api" | "/web/api/v1" | "/user/api/v1" | "/backend"
    ) {
        return None;
    }
    Some(raw.trim_end_matches('/').to_string())
}

fn candidate_quota_bases_from_definition(
    provider: &ProviderConfig,
    definition: &ProviderDefinition,
) -> Vec<String> {
    let mut out = Vec::new();
    let mut saw_explicit_candidate = false;
    let mut push_unique = |value: String| {
        if value.is_empty() {
            return;
        }
        if !out.iter().any(|existing| existing == &value) {
            out.push(value);
        }
    };

    for rule in &definition.candidate_base_sources {
        match rule {
            CandidateBaseSource::ExplicitUsageBaseUrl => {
                if let Some(base) = provider
                    .usage_base_url
                    .as_deref()
                    .map(str::trim)
                    .map(|value| value.trim_end_matches('/'))
                    .filter(|value| !value.is_empty())
                {
                    let normalized = normalize_usage_base_url(&provider.base_url, base)
                        .unwrap_or_else(|| base.to_string());
                    saw_explicit_candidate = true;
                    push_unique(normalized);
                }
            }
            CandidateBaseSource::OriginFromBaseUrl => {
                if let Some(origin) = derive_origin(&provider.base_url) {
                    push_unique(origin);
                }
            }
        }
    }

    if !saw_explicit_candidate {
        for base in &definition.fixed_candidate_bases {
            push_unique(base.to_string());
        }
    }

    out
}

fn generic_candidate_quota_bases(provider: &ProviderConfig) -> Vec<String> {
    provider
        .usage_base_url
        .as_deref()
        .map(str::trim)
        .map(|value| value.trim_end_matches('/'))
        .filter(|value| !value.is_empty())
        .map(|value| vec![value.to_string()])
        .unwrap_or_default()
}

pub(crate) fn normalize_usage_base_url(
    provider_base_url: &str,
    usage_base_url: &str,
) -> Option<String> {
    let usage_base_url = usage_base_url.trim().trim_end_matches('/');
    if usage_base_url.is_empty() {
        return None;
    }

    let provider_definition = matched_definition_for_base_url(provider_base_url)?;
    let usage_definition = matched_definition_for_base_url(usage_base_url)?;
    if provider_definition.id != usage_definition.id {
        return None;
    }
    if provider_definition.fixed_candidate_bases.len() == 1 {
        return provider_definition.fixed_candidate_bases.first().cloned();
    }
    None
}

pub(crate) fn prefers_simple_input_list(base_url: &str) -> bool {
    matched_definition_for_base_url(base_url)
        .map(|definition| definition.request_prefers_simple_input_list)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::providers::{map_canonical_usage, CanonicalUsageContext};
    use std::fs;

    fn write_test_provider_definition(path: &Path, explicit_endpoint_url: &str) {
        let body = format!(
            r#"
id = "hot_reload_test"

[match]
base_url_hosts = ["reload.example.com"]

[usage]
kind = "budget_info"
refresh_flow = "auto"
explicit_endpoint_mode = "fixed"
explicit_endpoint_url = "{explicit_endpoint_url}"
"#
        );
        fs::write(path, body.trim_start()).expect("write provider definition");
    }

    #[test]
    fn file_registry_resolves_yunyi_user_me_provider() {
        let provider = ProviderConfig {
            display_name: "yunyi".to_string(),
            base_url: "https://yunyi.rdzhvip.com/codex".to_string(),
            supports_websockets: false,
            group: None,
            disabled: false,
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        };

        let profile = resolve_quota_profile(&provider);
        assert_eq!(profile.refresh_flow, RefreshFlow::Auto);
        assert_eq!(
            profile.budget_info_auth_source,
            BudgetInfoAuthSource::UsageToken
        );
        assert_eq!(
            profile.explicit_usage_endpoint.as_deref(),
            Some("https://yunyi.rdzhvip.com/user/api/v1/me")
        );
        assert!(profile.explicit_usage_mapping.is_some());
        assert_eq!(
            profile.candidate_bases,
            vec!["https://yunyi.rdzhvip.com/user/api/v1/me".to_string()]
        );
    }

    #[test]
    fn file_registry_resolves_packycode_provider() {
        let provider = ProviderConfig {
            display_name: "packy".to_string(),
            base_url: "https://codex-api.packycode.com/v1".to_string(),
            supports_websockets: false,
            group: None,
            disabled: false,
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        };

        let profile = resolve_quota_profile(&provider);
        assert_eq!(profile.refresh_flow, RefreshFlow::Auto);
        assert_eq!(
            profile.budget_info_auth_source,
            BudgetInfoAuthSource::ProviderKey
        );
        assert_eq!(
            profile.candidate_bases,
            vec!["https://codex.packycode.com".to_string()]
        );
        assert!(profile.budget_info_mapping.is_some());
        assert_eq!(
            profile.package_expiry_strategy,
            PackageExpiryStrategy::BackendUsersInfo
        );
    }

    #[test]
    fn file_registry_resolves_aigateway_subdomain_provider() {
        let provider = ProviderConfig {
            display_name: "aigateway-subdomain".to_string(),
            base_url: "https://edge.aigateway.chat/v1".to_string(),
            supports_websockets: false,
            group: None,
            disabled: false,
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        };

        let profile = resolve_quota_profile(&provider);
        assert_eq!(
            profile.explicit_usage_endpoint.as_deref(),
            Some("https://aigateway.chat/v1/usage")
        );
        assert_eq!(
            profile.candidate_bases,
            vec!["https://aigateway.chat".to_string()]
        );
        assert!(profile.explicit_usage_mapping.is_some());
    }

    #[test]
    fn file_registry_resolves_routeai_provider() {
        let provider = ProviderConfig {
            display_name: "routeai".to_string(),
            base_url: "https://api.routeai.cc".to_string(),
            supports_websockets: false,
            group: None,
            disabled: false,
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        };

        let profile = resolve_quota_profile(&provider);
        assert_eq!(profile.refresh_flow, RefreshFlow::Auto);
        assert_eq!(
            profile.explicit_usage_endpoint.as_deref(),
            Some("https://api.routeai.cc/v1/usage")
        );
        assert_eq!(
            profile.candidate_bases,
            vec!["https://api.routeai.cc".to_string()]
        );
        assert!(profile.explicit_usage_mapping.is_some());
    }

    #[test]
    fn file_registry_routeai_ignores_noncanonical_explicit_usage_base() {
        let provider = ProviderConfig {
            display_name: "routeai".to_string(),
            base_url: "https://api.routeai.cc".to_string(),
            supports_websockets: false,
            group: None,
            disabled: false,
            usage_adapter: String::new(),
            usage_base_url: Some("https://usage.routeai.cc/custom".to_string()),
            api_key: String::new(),
        };

        let profile = resolve_quota_profile(&provider);
        assert_eq!(
            profile.candidate_bases,
            vec!["https://api.routeai.cc".to_string()]
        );
        assert_eq!(
            profile.explicit_usage_endpoint.as_deref(),
            Some("https://api.routeai.cc/v1/usage")
        );
    }

    #[test]
    fn provider_registry_refresh_picks_up_toml_updates() {
        let temp = tempfile::tempdir().expect("tempdir");
        let provider_dir = temp.path().join("providers");
        fs::create_dir_all(&provider_dir).expect("create providers dir");
        let provider_path = provider_dir.join("reload.toml");

        write_test_provider_definition(&provider_path, "https://reload.example.com/v1/usage-a");

        let dirs = vec![provider_dir.clone()];
        let initial_snapshot = snapshot_provider_definition_dirs(&dirs);
        let initial_registry = load_provider_registry_from_dirs(&dirs);
        assert_eq!(initial_registry.len(), 1);
        assert_eq!(
            initial_registry[0].explicit_endpoint_url.as_deref(),
            Some("https://reload.example.com/v1/usage-a")
        );

        let mut state = ProviderRegistryState {
            registry: initial_registry,
            snapshot: initial_snapshot,
            last_checked_unix_ms: 0,
        };

        write_test_provider_definition(&provider_path, "https://reload.example.com/v1/usage-b");

        let updated_snapshot = snapshot_provider_definition_dirs(&dirs);
        refresh_provider_registry_state_for_dirs(
            &mut state,
            &dirs,
            PROVIDER_REGISTRY_REFRESH_DEBOUNCE_MS + 1,
            Some(updated_snapshot),
        );

        assert_eq!(state.registry.len(), 1);
        assert_eq!(
            state.registry[0].explicit_endpoint_url.as_deref(),
            Some("https://reload.example.com/v1/usage-b")
        );
    }

    #[test]
    fn provider_definition_requires_non_empty_matcher() {
        let err = ProviderDefinition::try_from(ProviderDefinitionFile {
            id: "invalid".to_string(),
            matcher: ProviderMatcherFile::default(),
            usage: ProviderUsageFile::default(),
            package_expiry: PackageExpiryFile::default(),
        })
        .expect_err("empty matcher should fail");

        assert!(err.contains("must declare at least one matcher"));
    }

    #[test]
    fn dynamic_numeric_mapping_treats_zero_as_missing_and_can_fallback() {
        let mapping = build_dynamic_mapping(CanonicalUsageMappingFile {
            usage_kind: Some("balance_info".to_string()),
            daily_limit: Some(NumericFieldSpecFile {
                aliases: vec!["/vip/day_score".to_string(), "/day_score".to_string()],
                transform: Some("none".to_string()),
                treat_zero_as_missing: Some(true),
                default_value: Some(90.0),
                ..NumericFieldSpecFile::default()
            }),
            requires_any: vec!["/id".to_string()],
            ..CanonicalUsageMappingFile::default()
        })
        .expect("dynamic mapping");

        let payload = serde_json::json!({
            "id": 81406,
            "day_score": 45,
            "vip": {
                "day_score": 0
            }
        });

        let usage = map_canonical_usage(
            &payload,
            mapping,
            CanonicalUsageContext {
                effective_usage_base: Some("https://usage.example".to_string()),
                effective_usage_source: Some("test".to_string()),
                updated_at_unix_ms: 123,
            },
        )
        .expect("mapped usage");

        assert_eq!(usage.daily_limit, Some(45.0));
    }

    #[test]
    fn dynamic_numeric_mapping_uses_default_when_all_candidates_are_zero() {
        let mapping = build_dynamic_mapping(CanonicalUsageMappingFile {
            usage_kind: Some("balance_info".to_string()),
            daily_limit: Some(NumericFieldSpecFile {
                aliases: vec!["/vip/day_score".to_string(), "/day_score".to_string()],
                transform: Some("none".to_string()),
                treat_zero_as_missing: Some(true),
                default_value: Some(90.0),
                ..NumericFieldSpecFile::default()
            }),
            requires_any: vec!["/id".to_string()],
            ..CanonicalUsageMappingFile::default()
        })
        .expect("dynamic mapping");

        let payload = serde_json::json!({
            "id": 81406,
            "day_score": 0,
            "vip": {
                "day_score": 0
            }
        });

        let usage = map_canonical_usage(
            &payload,
            mapping,
            CanonicalUsageContext {
                effective_usage_base: Some("https://usage.example".to_string()),
                effective_usage_source: Some("test".to_string()),
                updated_at_unix_ms: 123,
            },
        )
        .expect("mapped usage");

        assert_eq!(usage.daily_limit, Some(90.0));
    }

    #[test]
    fn dynamic_numeric_mapping_can_skip_field_when_another_budget_signal_exists() {
        let mapping = build_dynamic_mapping(CanonicalUsageMappingFile {
            usage_kind: Some("balance_info".to_string()),
            daily_limit: Some(NumericFieldSpecFile {
                aliases: vec!["/vip/day_score".to_string(), "/day_score".to_string()],
                transform: Some("none".to_string()),
                treat_zero_as_missing: Some(true),
                default_value: Some(90.0),
                skip_if_any: vec!["/vip/score".to_string(), "/score".to_string()],
                ..NumericFieldSpecFile::default()
            }),
            requires_any: vec!["/id".to_string()],
            ..CanonicalUsageMappingFile::default()
        })
        .expect("dynamic mapping");

        let payload = serde_json::json!({
            "id": 81406,
            "score": 300,
            "day_score": 0,
            "vip": {
                "score": 300,
                "day_score": 0
            }
        });

        let usage = map_canonical_usage(
            &payload,
            mapping,
            CanonicalUsageContext {
                effective_usage_base: Some("https://usage.example".to_string()),
                effective_usage_source: Some("test".to_string()),
                updated_at_unix_ms: 123,
            },
        );

        assert!(
            usage.is_none(),
            "field-level skip_if_any should prevent unrelated fallback budgets from appearing"
        );
    }
}
