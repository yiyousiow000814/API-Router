# Provider Modularization Plan

## Goal

Reduce provider-specific complexity in the quota and usage pipeline so that adding a new provider is mostly a data-definition task, not a core-engine code change.

## Current Problem

The current design already has a good canonical output model:

- `remaining`
- `daily_spent_usd`
- `daily_budget_usd`
- `weekly_spent_usd`
- `weekly_budget_usd`
- `monthly_spent_usd`
- `monthly_budget_usd`
- `package_expires_at_unix_ms`

However, the mapping into that model is still spread across core quota code:

- host detection
- usage endpoint inference
- field alias handling
- provider-specific fetch flows

This makes the system harder to extend and harder to reason about as more providers are added.

## Design Direction

Keep one canonical internal schema, but move provider-specific behavior into isolated provider modules or provider definitions.

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

## Target Architecture

### 1. Canonical Provider Usage Schema

Introduce a single canonical provider usage schema used by all provider integrations before conversion into `QuotaSnapshot`.

Suggested canonical fields:

- `plan_name`
- `mode`
- `currency_unit`
- `remaining`
- `daily_used`
- `daily_limit`
- `weekly_used`
- `weekly_limit`
- `monthly_used`
- `monthly_limit`
- `expires_at`

This schema becomes the only input accepted by the shared quota-to-UI pipeline.

### 2. Provider Definition Layer

Create one provider definition per supported provider.

Examples:

- `src-tauri/src/orchestrator/providers/aigateway.rs`
- `src-tauri/src/orchestrator/providers/packycode.rs`
- `src-tauri/src/orchestrator/providers/ppchat.rs`

Alternative future option:

- `providers/aigateway.json`
- `providers/packycode.json`
- `providers/ppchat.json`

Each provider definition should describe:

- how to detect the provider
- how to resolve the usage endpoint
- which auth source to use
- how upstream fields map to canonical fields
- whether the provider needs a custom fetch flow

### 3. Generic Mapping Engine

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

### 4. Custom Provider Adapter Escape Hatch

Some providers will not fit a pure mapping file.

Examples:

- browser-session based usage collection
- login flows that mint temporary usage tokens
- multiple endpoint aggregation

For those cases, keep a small adapter interface.

Suggested shape:

```rust
trait ProviderUsageAdapter {
    fn matches(&self, provider: &ProviderConfig) -> bool;
    fn resolve_usage_endpoint(&self, provider: &ProviderConfig) -> Option<String>;
    async fn fetch(&self, ctx: &UsageContext) -> Result<CanonicalProviderUsage, String>;
}
```

The generic mapper should be the default. Custom adapters should be the exception.

## Migration Strategy

### Phase 1. Define Canonical Semantics

- finalize the canonical provider usage schema
- document exact meaning for each canonical field
- make `QuotaSnapshot` consume only canonical semantics from provider adapters

### Phase 2. Extract Provider Detection

- move host matching and endpoint inference out of core quota files
- create isolated provider modules for existing providers

Initial migration targets:

- `packycode`
- `ppchat`
- `pumpkinai`
- `codex-for-*`
- `aigateway`

### Phase 3. Introduce Generic Mapping

- add reusable JSON-path based field extraction
- move simple providers onto declarative field mappings
- keep only complex providers on custom Rust adapters

### Phase 4. Simplify Core Quota Engine

After provider logic is extracted, the shared engine should only do:

1. choose provider adapter
2. fetch payload
3. normalize to canonical usage
4. convert to `QuotaSnapshot`
5. persist and expose UI state

## Proposed Rules

To keep the system coherent, apply these rules:

- Do not add new provider-specific field aliases directly inside shared quota code.
- Do not add new host checks directly inside the quota engine once provider modules exist.
- New provider support should prefer provider definitions first, custom adapter second.
- UI components must only consume canonical fields and must not branch on provider names.

## Expected Benefits

- adding a provider becomes predictable
- provider logic becomes isolated
- field alias churn no longer pollutes shared engine code
- testing becomes easier per provider
- long-term maintenance cost drops

## Risks

- a partial migration may temporarily duplicate logic
- poorly designed canonical semantics may still leak provider-specific assumptions
- too much configurability too early could make debugging harder

## Recommendation

Do this as a refactor plan, not as opportunistic fixes during provider onboarding.

The next provider added after this refactor should be implemented through the new provider-definition path to validate the design.
