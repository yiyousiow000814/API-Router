# Repo Maintainability Refactor Blueprint

## Goal

Make the repository easier for new contributors to understand and safer to evolve by:

1. Reducing high-churn test duplication around `ProviderConfig` and related setup.
2. Splitting oversized source files by responsibility, starting with `lan_sync.rs`.
3. Keeping refactors incremental so behavior remains stable and reviewable.

This plan is intentionally scoped as a blueprint for future PRs. It does not change runtime behavior by itself.

## What We Observed

### 1. `ProviderConfig` construction is repeated at repo scale

`ProviderConfig { ... }` is directly constructed in many places across Rust code and tests. That means every new field addition creates repo-wide mechanical edits.

Observed hotspots include:

- `src-tauri/src/orchestrator/gateway_tests/basic_and_routing.rs`
- `src-tauri/src/orchestrator/gateway_tests/retry_and_session.rs`
- `src-tauri/src/orchestrator/quota/tests.rs`
- `src-tauri/src/commands/status_snapshot.rs`
- `src-tauri/src/commands/usage_metrics.rs`
- `src-tauri/src/commands/spend_history.rs`

This was visible again in the websocket support work: much of the apparent repetition came from tests adding the new `supports_websockets` field rather than from duplicated feature logic.

### 2. `lan_sync.rs` is too large and mixes multiple subsystems

`src-tauri/src/lan_sync.rs` is currently very large and contains:

- build identity and readiness logic
- remote update logic
- packet and wire protocol definitions
- encryption/compression helpers
- HTTP handlers
- pairing and trust flow
- edit-sync and versioning logic
- provider-definition sync logic
- runtime listener/sender loops
- diagnostics/debug endpoints
- a large inline `mod tests`

The file is no longer organized around a single responsibility. It is difficult to scan, difficult to test in isolation, and difficult for a new contributor to navigate confidently.

### 3. Large-file pressure exists beyond `lan_sync.rs`

Other large files also suggest future modularization targets:

- `src-tauri/src/commands/status_snapshot.rs`
- `src-tauri/src/orchestrator/gateway_tests/basic_and_routing.rs`
- `src-tauri/src/commands/provider_management.rs`
- `src-tauri/src/orchestrator/store.rs`
- `src-tauri/src/orchestrator/quota/tests.rs`

This plan starts with the highest-value targets first rather than trying to normalize the whole repository in one pass.

## Refactor Principles

1. Prefer responsibility-based modules over arbitrary line-count splitting.
2. Reduce mechanical duplication first, especially in tests.
3. Keep one canonical construction path for common test objects.
4. Avoid broad abstraction that hides intent.
5. Keep each PR reviewable and behaviorally narrow.
6. Preserve external behavior while improving internal ownership boundaries.

## Recommended Workstreams

## Workstream A: Test Fixture and Builder Consolidation

### Why

This is the lowest-risk, highest-leverage maintainability improvement. It reduces future churn when config fields change and makes tests easier to read.

### Target Outcome

Common test setup should read like intent, not like repeated struct boilerplate.

Examples of the desired direction:

- a local provider fixture factory for gateway tests
- a quota-focused provider fixture helper for quota tests
- shared sample providers for command-layer tests
- optional small builders for config-heavy test setup where defaults are stable

### Scope

Start with the places showing the most repeated `ProviderConfig` setup:

1. `src-tauri/src/orchestrator/gateway_tests/basic_and_routing.rs`
2. `src-tauri/src/orchestrator/gateway_tests/retry_and_session.rs`
3. `src-tauri/src/orchestrator/quota/tests.rs`
4. `src-tauri/src/commands/status_snapshot.rs`
5. `src-tauri/src/commands/usage_metrics.rs`
6. `src-tauri/src/commands/spend_history.rs`

### Recommended Structure

Phase A1:

- Add narrow, local test helpers close to each test family.
- Do not force a repo-wide helper layer immediately.
- Optimize for readability inside the current domain first.

Phase A2:

- After patterns stabilize, extract shared fixture helpers where duplication is truly cross-domain.
- Keep helpers explicit and domain-named, not generic utility dumps.

Phase A3:

- Standardize a small set of canonical test object constructors for config-heavy scenarios.
- Make new fields default in one place instead of many.

### Good Candidates for Canonical Fixtures

- `ProviderConfig`
- provider lists used in routing tests
- pricing/quota sample providers
- command test app/config seeds
- secret/config seed helpers where setup is repeated across files

### Things Not To Over-Abstract

- feature-specific assertions
- one-off scenario setup that expresses the point of a single test
- business logic branching hidden behind generic fixture macros

## Workstream B: `lan_sync` Modularization

### Why

`lan_sync.rs` is large because it contains multiple real subsystems, not because it has one complex algorithm. That is a strong signal to split by responsibility.

### Target Outcome

A contributor should be able to answer:

- where the wire format lives
- where pairing logic lives
- where edit sync is applied
- where runtime loops live
- where HTTP entry points live

without scanning thousands of lines in one file.

### Recommended Module Layout

Suggested target shape:

- `src-tauri/src/lan_sync/mod.rs`
- `src-tauri/src/lan_sync/local_state.rs`
- `src-tauri/src/lan_sync/build_identity.rs`
- `src-tauri/src/lan_sync/remote_update.rs`
- `src-tauri/src/lan_sync/protocol.rs`
- `src-tauri/src/lan_sync/crypto.rs`
- `src-tauri/src/lan_sync/http_handlers.rs`
- `src-tauri/src/lan_sync/pairing.rs`
- `src-tauri/src/lan_sync/provider_definitions.rs`
- `src-tauri/src/lan_sync/edit_sync.rs`
- `src-tauri/src/lan_sync/runtime_loops.rs`
- `src-tauri/src/lan_sync/network.rs`
- `src-tauri/src/lan_sync/diagnostics.rs`
- `src-tauri/src/lan_sync/tests/`

### Responsibility Boundaries

`mod.rs`

- public exports
- top-level orchestration entry points
- minimal wiring only

`protocol.rs`

- packet structs
- wire envelope types
- serialization shape

`crypto.rs`

- encryption/decryption
- compression/decompression
- packet protection helpers

`build_identity.rs`

- local build identity snapshot
- version/readiness derivation

`remote_update.rs`

- remote update status
- self-update worker command construction
- update readiness blocking reasons

`http_handlers.rs`

- request/response entry points for LAN sync HTTP routes
- thin orchestration only

`pairing.rs`

- pair request flow
- approval/pin/trust bundle handling
- pair state helpers

`provider_definitions.rs`

- provider definition snapshot payloads
- merge/replace/follow refresh logic

`edit_sync.rs`

- event recording
- version ordering checks
- event application and batch apply logic

`runtime_loops.rs`

- listener/sender/background sync loops

`network.rs`

- socket send/broadcast helpers

`diagnostics.rs`

- debug routes
- diagnostics payloads
- non-core debugging helpers

`tests/`

- topic-based test files instead of one inline block

### Recommended Extraction Order

1. Extract pure or low-coupling modules first:
   - `protocol.rs`
   - `crypto.rs`
   - `build_identity.rs`
2. Then extract thin orchestration layers:
   - `network.rs`
   - `http_handlers.rs`
3. Then split business subsystems:
   - `pairing.rs`
   - `provider_definitions.rs`
   - `edit_sync.rs`
   - `remote_update.rs`
4. Finally split runtime loops and tests:
   - `runtime_loops.rs`
   - `tests/`

This order minimizes churn while building clearer internal seams.

## Workstream C: Secondary Large-File Cleanup

After Workstreams A and B, review these next:

1. `src-tauri/src/commands/status_snapshot.rs`
2. `src-tauri/src/orchestrator/quota/tests.rs`
3. `src-tauri/src/orchestrator/gateway_tests/basic_and_routing.rs`
4. `src-tauri/src/commands/provider_management.rs`
5. `src-tauri/src/orchestrator/store.rs`

These should be split only when the split improves ownership clarity, not just to reduce line counts.

## Suggested PR Sequence

Keep this effort incremental. A good sequence would be:

### PR 1: Gateway test fixtures

- introduce local `ProviderConfig` test fixture helpers for gateway tests
- refactor only gateway test setup to use them

### PR 2: Quota test fixtures

- add quota-specific fixture helpers
- reduce repeated provider/quota sample construction

### PR 3: Command test fixtures

- unify sample providers/config seeds used by command tests

### PR 4: `lan_sync` pure module extraction

- move protocol/crypto/build-identity code into dedicated files
- keep public behavior unchanged

### PR 5: `lan_sync` business module extraction

- move pairing/provider-definition/edit-sync/update logic into modules

### PR 6: `lan_sync` tests extraction

- move inline tests into topic-based files

### PR 7: Follow-up cleanup

- identify the next most painful large files
- apply the same responsibility-based modularization pattern

## Review and Safety Rules For Future Refactor PRs

1. No behavior changes mixed into structural refactors unless necessary.
2. Keep module moves and semantic changes separate when possible.
3. Each refactor PR should document:
   - what moved
   - what stayed public
   - why the new boundary is clearer
4. Prefer tests that prove behavior did not change after extraction.
5. If a file is split, add short module-level comments only where the responsibility is not obvious from names alone.

## Definition of Success

This plan is successful when:

1. Adding a new `ProviderConfig` field does not require broad mechanical test edits.
2. A new contributor can navigate `lan_sync` by subsystem instead of by scrolling.
3. Large test files express intent through fixtures instead of repeated setup blocks.
4. The repository layout communicates ownership boundaries clearly.
5. Future refactors become smaller because the architecture already exposes cleaner seams.
