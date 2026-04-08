# Provider Modularization Plan

## Goal

Turn provider onboarding into a file-driven workflow so that adding a new provider is, by default, a `providers/*.toml` change instead of a Rust code change.

The target end state is:

- shared quota and usage logic lives in one canonical engine
- provider-specific behavior is declared in provider definition files
- new providers auto-register at startup by being placed in the provider folder
- Rust adapters remain only for flows that cannot be represented declaratively

## What This Plan Is Optimizing For

This plan is not just about moving logic out of `quota.rs`.

It is specifically about making the provider system:

- declarative
- runtime-loadable
- schema-driven
- stable enough that future providers can be added without touching core code

The desired developer experience is:

1. add `providers/<provider-id>.toml`
2. restart the app
3. provider quota support is active

## Current Problem

The current quota pipeline already has a solid canonical output model:

- `remaining`
- `daily_spent_usd`
- `daily_budget_usd`
- `weekly_spent_usd`
- `weekly_budget_usd`
- `monthly_spent_usd`
- `monthly_budget_usd`
- `package_expires_at_unix_ms`

But provider behavior is still partly encoded in Rust:

- host detection
- usage endpoint inference
- auth-source selection
- field alias handling
- unit conversion
- provider-specific fetch flows

That means the code is more modular than before, but onboarding a provider still requires source edits and a rebuild.

This is better than the old quota-core sprawl, but it is not yet the intended end state.

## Design Direction

Keep one canonical internal schema and move provider-specific behavior into declarative provider definition files.

The main quota engine should not know provider field names such as:

- `daily_usage_usd`
- `daily_limit_usd`
- `daily_usage`
- `daily_limit`
- `subscription.expires_at`

It should only know canonical semantics such as:

- `daily_used`
- `daily_limit`
- `weekly_used`
- `weekly_limit`
- `monthly_used`
- `monthly_limit`
- `remaining`
- `expires_at`

It should also not branch on provider names or hosts once provider definitions are loaded.

## Target Architecture

### 1. Canonical Provider Usage Schema

Introduce a single canonical provider usage schema used by all provider integrations before conversion into `QuotaSnapshot`.

Suggested canonical fields:

- `plan_name`
- `mode`
- `currency_unit`
- `remaining`
- `today_used`
- `today_added`
- `daily_used`
- `daily_limit`
- `weekly_used`
- `weekly_limit`
- `monthly_used`
- `monthly_limit`
- `expires_at`

This schema becomes the only input accepted by the shared quota-to-UI pipeline.

### 2. File-Driven Provider Registry

Create one provider definition file per supported provider.

Examples:

- `providers/aigateway.toml`
- `providers/packycode.toml`
- `providers/ppchat.toml`
- `providers/yunyi-user-me.toml`

The application should scan the provider folder at startup, parse all valid files, and register them automatically.

Suggested responsibilities of a provider definition:

- how to match a provider
- how to resolve its usage endpoint
- which auth source to use
- how to map upstream fields into canonical fields
- which numeric or timestamp transforms to apply
- whether package expiry or shared-usage rules need special strategy names
- whether the provider requires a named adapter

### 3. Declarative Matching and Resolution

Provider files should be able to describe matching and endpoint behavior without code changes.

Examples of declarative matching:

- base URL host equals `aigateway.chat`
- base URL host suffix equals `.packycode.com`
- explicit `usage_base_url` path ends with `/user/api/v1/me`
- origin host contains `codex-for`

Examples of declarative endpoint resolution:

- use explicit `usage_base_url`
- use provider origin
- use canonical shared base
- append fixed suffix to resolved origin

### 4. Declarative Mapping Engine

Add a shared mapping engine that can:

- fetch provider usage payloads
- read values from configured JSON paths
- normalize values into canonical semantics
- convert canonical semantics into `QuotaSnapshot`

This engine should support aliases such as:

- `subscription.daily_usage_usd` -> `daily_used`
- `subscription.daily_limit_usd` -> `daily_limit`
- `expires_at` -> `expires_at`
- `subscription.expires_at` -> `expires_at`

It also needs data-driven transforms such as:

- divide by `100`
- parse RFC3339 timestamps
- parse unix seconds into unix milliseconds
- strip commas or percent suffixes from numeric strings

### 5. Runtime Data Model

Rust should consume one runtime definition model regardless of whether a provider is built-in or loaded from file.

Suggested shape:

```rust
struct ProviderDefinition {
    id: String,
    matcher: ProviderMatcher,
    usage: ProviderUsageDefinition,
    package_expiry_strategy: PackageExpiryStrategy,
    shared_usage: SharedUsageDefinition,
    adapter: Option<String>,
}
```

The quota engine should work only with this runtime model.

### 6. Minimal Adapter Escape Hatch

Some providers will not fit a pure mapping file.

Examples:

- browser-session based usage collection
- login flows that mint temporary usage tokens
- multiple endpoint aggregation
- special package-expiry lookup that requires secondary requests

For those cases, keep a very small adapter interface.

Suggested shape:

```rust
trait ProviderUsageAdapter {
    fn id(&self) -> &'static str;
    async fn fetch(&self, ctx: &UsageContext) -> Result<CanonicalProviderUsage, String>;
}
```

Provider files should reference adapters by name, for example:

- `adapter = "codex_for_me_login"`
- `adapter = "packycode_browser_session"`

The default path must stay declarative. Adapters are the exception, not the norm.

## Example Provider File

Example shape only. Field names may evolve as the schema is finalized.

```toml
id = "yunyi-user-me"

[match]
base_url_prefixes = ["https://yunyi.rdzhvip.com/codex"]
usage_base_url_suffixes = ["/user/api/v1/me"]

[usage]
kind = "budget_info"
endpoint_mode = "explicit_usage_base_url"
auth_mode = "provider_key_or_usage_token"

[usage.mapping.remaining]
aliases = ["/quota/daily_remaining", "/remaining", "/balance"]
transform = "divide_by_100"

[usage.mapping.daily_used]
aliases = ["/quota/daily_spent", "/usage/today/actual_cost"]
transform = "divide_by_100"

[usage.mapping.daily_limit]
aliases = ["/quota/daily_quota", "/daily_limit_usd"]
transform = "divide_by_100"

[usage.mapping.expires_at_unix_ms]
aliases = ["/timestamps/expires_at", "/subscription/expires_at"]
transform = "parse_timestamp"

[shared_usage]
source = "explicit_usage_base_url"

[package_expiry]
strategy = "none"
```

## Migration Strategy

### Phase 1. Freeze Canonical Semantics

- finalize the canonical provider usage schema
- document exact meaning for each canonical field
- make `QuotaSnapshot` consume only canonical semantics from provider definitions or adapters

### Phase 2. Build the Runtime Registry

- define `ProviderDefinition`
- add file loading for `providers/*.toml`
- validate files at startup
- make the engine consume runtime definitions instead of hardcoded provider branches

### Phase 3. Move Current Rust Definitions Into Schema

Start with providers that already fit the declarative model well:

- `aigateway`
- `yunyi / user/api/v1/me`
- `packycode`
- `ppchat`
- `pumpkinai`

These should become the first real `.toml` provider definitions.

### Phase 4. Keep Only Necessary Adapters

For providers that still need custom code:

- `codex-for.me` login-token flow
- any browser-session based usage flow
- any multi-endpoint aggregation flow

Move the rest fully into schema.

### Phase 5. Enforce File-First Onboarding

Once the loader and schema are stable:

- all new provider onboarding must start with `providers/*.toml`
- any new Rust provider logic must justify why schema cannot express it
- core quota code must not add provider-name or host-specific branches

## Proposed Rules

To keep the system coherent, apply these rules:

- Do not add new provider-specific field aliases directly inside shared quota code.
- Do not add new host checks directly inside the quota engine once the registry exists.
- New provider support must default to provider definition files first, adapters second.
- UI components must only consume canonical fields and must not branch on provider names.
- Provider file loading errors must be explicit and actionable at startup.
- Avoid turning the schema into a second programming language; prefer a small, composable set of transforms and strategies.

## Expected Benefits

- adding a provider becomes predictable
- most provider onboarding becomes a file change instead of a code change
- provider logic becomes isolated from the core engine
- field alias churn no longer pollutes shared engine code
- testing becomes easier per provider definition
- future contributors can extend support without touching quota internals

## Risks

- a partial migration may temporarily duplicate logic
- poorly designed canonical semantics may still leak provider-specific assumptions
- an overly powerful schema could become hard to validate and debug
- some providers may need adapters longer than expected

## Recommendation

Treat the current Rust modularization as an intermediate step, not the final architecture.

The next milestone should be:

1. define the provider file schema
2. load provider definitions from disk
3. migrate simple built-in providers onto real `.toml` files

The system is only "done" when the default answer to "how do I add a provider?" becomes:

Add a provider file, not a Rust module.
