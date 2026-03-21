# Web Codex Session Manager Plan

## Goal

Build a canonical Session Manager for Web Codex so that:

- `Windows` and `WSL2` both use a single app-server-first runtime model.
- `new chat` and `existing chat` both feel seamless.
- Web Codex no longer depends on `attach` as the primary product concept.
- terminal and Web Codex become two surfaces over the same canonical thread/runtime state.

## Product Rules

### Canonical rules

- `codex app-server` is the single source of truth for runtime state.
- `thread/history/runtime` must be derived from one canonical workspace runtime.
- `attach` is an implementation detail only, not a user-facing mental model.
- `new chat` must work without a terminal already being open.
- `existing chat` must not force a blind resume when history/runtime are already sufficient.

### User-facing semantics

- `Connected` means the current chat is connected to the workspace Session Manager/runtime.
- Terminal presence is optional metadata, not a prerequisite for sending turns.
- If a terminal is also participating in the same thread, treat that as an enhancement layer, not the primary control path.

## Current Problems

- Web Codex still mixes three concepts:
  - app-server runtime connectivity
  - history persistence
  - live terminal mirroring
- Opening an existing chat can still over-rely on `resume`-style behavior.
- Terminal sync is treated too much like the primary truth instead of a secondary surface.
- Runtime data comes from multiple sources, but the merge policy is still spread across several components.

## Target Architecture

## 1. Per-workspace Session Manager

Create one canonical manager per workspace:

- `windows`
- `wsl2`

Each manager owns:

- one canonical `CODEX_HOME`
- one canonical `codex app-server`
- one thread runtime registry
- one event replay buffer
- one rollout live-tail pipeline

## 2. Canonical Thread Runtime Registry

Each thread should have a normalized runtime record:

- `thread_id`
- `workspace`
- `cwd`
- `rollout_path`
- `status`
- `last_event_id`
- `last_turn_id`
- `history_freshness`
- `has_live_terminal_surface`
- `active_surface_kinds`

This registry becomes the only backend state that the Web UI reads for live status decisions.

## 3. Unified Event Bus

Normalize all live sources into one stream:

- app-server stdout notifications
- replay notifications
- rollout live-tail notifications
- loaded-thread runtime overlays
- persisted history refresh checkpoints

The Web UI should subscribe to this normalized event bus instead of reasoning separately about:

- websocket notifications
- history polling
- terminal attach state

## 4. App-server-first New Chat Flow

For `new chat`:

1. user picks workspace/folder
2. Web keeps a local draft state
3. first send creates the canonical thread through app-server
4. Session Manager registers the thread immediately
5. history, runtime, and future terminal participation all derive from the same thread id

No pre-existing terminal should be required.

## 5. Safe Existing Chat Flow

For `existing chat`:

- first load history from canonical history/runtime sources
- subscribe to Session Manager live state
- only resume/escalate runtime when the thread is actually active or incomplete
- never blindly resume just because the chat was opened

## 6. Terminal as a Surface, Not the Source of Truth

Terminal support should be split into two modes:

### Managed terminal mode

A future managed terminal surface should connect directly to the same Session Manager/runtime.

This is the path to true seamless multi-surface behavior.

### Legacy terminal adoption

For ordinary pre-existing terminal sessions:

- discover them
- map them to canonical thread/runtime records
- adopt them as participating surfaces when possible

This remains a compatibility layer, not the primary architecture.

## Delivery Phases

## Current Status

- `Phase 1`: mostly complete
- `Phase 2`: mostly complete
- `Phase 3`: mostly complete
- `Phase 4`: mostly complete
- `Phase 5`: mostly complete
  - backend managed terminal route exists
  - Web UI/runtime entry now exists via the active chat workspace badge
- `Phase 6`: in progress
  - ordinary terminal discovery/adoption is partially working
  - fully seamless Web <-> ordinary terminal sync is not finished yet
- `Phase 7`: defined
  - runtime hardening after legacy terminal adoption
  - focus on removing refresh-only gaps and orphan runtime rows

## Current Focus

- Finish `Phase 6` legacy terminal adoption.
- Eliminate the remaining gap where a normal pre-existing terminal turn is only visible in Web after refresh.
- Keep `5173` and `4000` behavior aligned by using the same canonical runtime/history path.
- Move `Phase 7` onto runtime hardening once `Phase 6` refresh gaps are closed.

## Phase 1 - Semantics cleanup

- remove `attach` as the primary UI concept
- make header/status reflect manager connectivity first
- keep terminal participation as optional metadata

Acceptance:

- Web no longer implies that missing terminal mirroring equals failure
- `new chat` and `existing chat` are both usable without terminal preconditions

## Phase 2 - Backend state consolidation

- introduce a Session Manager module
- centralize thread runtime state
- centralize event normalization and replay

Acceptance:

- one backend state model drives Web live state
- fewer ad-hoc merges in history/thread/runtime routes

## Phase 3 - Existing chat safety

- stop blind resume on open
- resume only when runtime evidence says it is necessary
- keep history loading side-effect free

Acceptance:

- opening older chats does not create spurious runtime side effects
- stale history/runtime mismatches converge cleanly

## Phase 4 - New chat canonicalization

- make first send create and register canonical threads consistently
- ensure later terminal participation can resume the same thread cleanly

Acceptance:

- a chat started on Web can always be resumed later from terminal using the same canonical thread

## Phase 5 - Managed terminal path

- add a manager-owned terminal surface path
- let terminal and Web both consume the same event bus

Acceptance:

- terminal and Web are truly two surfaces over one runtime, not two loosely synchronized clients

## Phase 6 - Legacy terminal adoption

- improve discovery and adoption of ordinary terminal sessions
- map them onto canonical thread records without making them the primary source of truth

Acceptance:

- ordinary terminals can participate more often
- failures here do not degrade Web correctness

## Phase 7 - Runtime Hardening

- remove remaining refresh-required live gaps for opened chats
- guarantee agent/review rows resolve back to a stable main-session parent when runtime evidence exists
- keep runtime/status/sidebar grouping consistent between `5173` and `4000`

Acceptance:

- an opened chat can receive a new ordinary-terminal turn without manual refresh
- agent rows no longer appear orphaned when a matching main session is already known
- runtime grouping and live state remain stable after turn completion and follow-up turns

## Immediate Next Steps

1. Finish UI semantics cleanup.
2. Introduce a dedicated Session Manager backend module.
3. Move thread live-status decisions onto canonical manager state.
4. Refactor existing chat open flow to avoid blind resume.
5. Define the managed terminal entry path.

## Non-goals

- Do not keep `attach` as the main product abstraction.
- Do not make terminal presence mandatory for `new chat`.
- Do not treat ordinary terminal discovery as the source of truth.
- Do not solve stale state by adding masking retries or arbitrary guards.

## Verification Strategy

Each phase should include:

1. a minimal repro
2. backend evidence/logging
3. a regression test
4. a manual runtime check on `5173` and `4000`

## Success Criteria

The work is complete when:

- Web Codex uses one canonical Session Manager model per workspace
- `new chat`, `existing chat`, terminal, and Web all operate over the same canonical thread/runtime state
- terminal participation becomes a surface-level enhancement, not a prerequisite for correctness
