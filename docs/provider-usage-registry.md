# Provider Usage Registry

This document explains how API Router decides whether a provider has first-class usage/quota support, what the generic fallback does, and how to add a new registered provider.

## Overview

API Router separates two concerns:

1. Request routing compatibility
2. Usage/quota introspection compatibility

Routing compatibility is broad: any provider with a working OpenAI-compatible `base_url` can be routed.

Usage/quota compatibility is narrower: the app needs to know where to fetch usage data from and how to map the returned JSON into the canonical internal quota shape.

## Registered Providers

Registered providers live in [`providers/`](C:/Users/yiyou/API-Router/providers).

Each `*.toml` file can declare:

- matching rules for `base_url` and `usage_base_url`
- refresh/auth strategy
- fixed or inferred usage endpoint rules
- canonical JSON field mappings
- provider-specific quota semantics

Current example:
- [`providers/aigateway.toml`](C:/Users/yiyou/API-Router/providers/aigateway.toml)

The provider definition is loaded by the registry in [`mod.rs`](C:/Users/yiyou/API-Router/src-tauri/src/orchestrator/providers/mod.rs).

## Canonical Usage Shape

Regardless of upstream payload differences, usage data is normalized into one canonical internal shape:

- `remaining`
- `today_used`
- `today_added`
- `daily_used`
- `daily_limit`
- `weekly_used`
- `weekly_limit`
- `monthly_used`
- `monthly_limit`
- `expires_at_unix_ms`

The mapping implementation lives in:

- [`mapping.rs`](C:/Users/yiyou/API-Router/src-tauri/src/orchestrator/providers/mapping.rs)
- [`quota.rs`](C:/Users/yiyou/API-Router/src-tauri/src/orchestrator/quota.rs)

## Generic Providers

If a provider does not match any registered definition, API Router falls back to generic behavior.

Generic behavior today:

- Candidate usage base is derived from the provider `base_url` origin.
- Explicit usage endpoint inference is minimal and conservative.
- Mapping uses the built-in generic aliases only.
- No provider-specific quota semantics are applied.

This fallback is intentionally best-effort. It keeps unknown providers usable for routing without pretending that usage/quota parsing is guaranteed.

## What Happens For Unregistered Providers

If a provider is unregistered:

- `POST /v1/responses` can still work if the upstream API is compatible.
- `GET /v1/models` can still work if the upstream API is compatible.
- Usage may be empty, partial, or wrong if the usage endpoint or payload shape is non-standard.
- The dashboard can still show health and request failures even when quota data is unavailable.

That is the compatibility contract: routing first, quota second.

## When To Register A Provider

Add a provider definition when any of these is true:

- usage endpoint is on a different host or path
- usage auth source differs from the request auth source
- upstream payload field names do not match the generic aliases
- quota semantics need provider-specific handling
- package expiry needs custom extraction

If none of those is true, generic fallback may already be enough.

## Adding A New Provider

1. Add a file under [`providers/`](C:/Users/yiyou/API-Router/providers), for example `my-provider.toml`.
2. Define the matching rules in `[match]`.
3. Define usage fetching and mapping in `[usage]`.
4. Add tests for endpoint inference and payload normalization in [`tests.rs`](C:/Users/yiyou/API-Router/src-tauri/src/orchestrator/quota/tests.rs).
5. If quota semantics differ from the default remaining/budget logic, express them through provider profile configuration and add routing tests in [`routing_and_status.rs`](C:/Users/yiyou/API-Router/src-tauri/src/orchestrator/gateway/routing_and_status.rs).

## Example: AI Gateway

`aigateway` is registered because its usage endpoint and quota semantics are provider-specific:

- fixed explicit usage endpoint: `https://aigateway.chat/v1/usage`
- canonical daily budget comes from `subscription.daily_limit_usd`
- canonical daily spend prefers `usage.today.actual_cost`
- stale `remaining` must not override budget fields when budget fields are present

That behavior is encoded in:

- [`providers/aigateway.toml`](C:/Users/yiyou/API-Router/providers/aigateway.toml)
- [`mod.rs`](C:/Users/yiyou/API-Router/src-tauri/src/orchestrator/providers/mod.rs)
- [`routing_and_status.rs`](C:/Users/yiyou/API-Router/src-tauri/src/orchestrator/gateway/routing_and_status.rs)
