import { describe, expect, it } from 'vitest'
import {
  arrangeSessionRowsByMainParent,
  compareSessionRowsByOriginThenLastSeen,
  isWslSessionRow,
} from './SessionsTable'

describe('isWslSessionRow', () => {
  it('prefers wsl wt_session marker even when base_url is localhost', () => {
    expect(
      isWslSessionRow({
        wt_session: 'wsl:abc',
        reported_base_url: 'http://127.0.0.1:4000/v1',
      }),
    ).toBe(true)
  })

  it('detects wsl from reported base_url', () => {
    expect(
      isWslSessionRow({
        wt_session: 'abc',
        reported_base_url: 'http://172.26.144.1:4000/v1',
      }),
    ).toBe(true)
  })

  it('treats localhost as windows when no wsl marker exists', () => {
    expect(
      isWslSessionRow({
        wt_session: 'abc',
        reported_base_url: 'http://localhost:4000/v1',
      }),
    ).toBe(false)
  })

  it('does not treat arbitrary ipv4 host as wsl2', () => {
    expect(
      isWslSessionRow({
        wt_session: 'abc',
        reported_base_url: 'http://192.168.1.8:4000/v1',
      }),
    ).toBe(false)
  })
})

describe('compareSessionRowsByOriginThenLastSeen', () => {
  it('sorts windows rows before wsl2 rows', () => {
    const rows = [
      { id: 'wsl', wt_session: 'wsl:abc', reported_base_url: null, last_seen_unix_ms: 500 },
      { id: 'win', wt_session: 'abc', reported_base_url: 'http://127.0.0.1:4000/v1', last_seen_unix_ms: 100 },
    ]

    const sorted = [...rows].sort(compareSessionRowsByOriginThenLastSeen)
    expect(sorted.map((row) => row.id)).toEqual(['win', 'wsl'])
  })

  it('keeps newer session first within same origin group', () => {
    const rows = [
      { id: 'older', wt_session: 'abc', reported_base_url: 'http://127.0.0.1:4000/v1', last_seen_unix_ms: 100 },
      { id: 'newer', wt_session: 'def', reported_base_url: 'http://127.0.0.1:4000/v1', last_seen_unix_ms: 200 },
    ]

    const sorted = [...rows].sort(compareSessionRowsByOriginThenLastSeen)
    expect(sorted.map((row) => row.id)).toEqual(['newer', 'older'])
  })
})

describe('arrangeSessionRowsByMainParent', () => {
  it('places agent and review rows right below their main session', () => {
    const rows = [
      {
        id: 'agent-1',
        codex_session_id: 'agent-1',
        agent_parent_session_id: 'main-1',
        wt_session: 'abc',
        reported_base_url: 'http://127.0.0.1:4000/v1',
        reported_model_provider: 'api_router',
        reported_model: null,
        last_seen_unix_ms: 100,
        active: false,
        current_provider: 'provider_1',
        verified: true,
        is_agent: true,
        is_review: false,
      },
      {
        id: 'main-1',
        codex_session_id: 'main-1',
        agent_parent_session_id: null,
        wt_session: 'abc',
        reported_base_url: 'http://127.0.0.1:4000/v1',
        reported_model_provider: 'api_router',
        reported_model: null,
        last_seen_unix_ms: 200,
        active: true,
        current_provider: 'provider_1',
        verified: true,
        is_agent: false,
        is_review: false,
      },
      {
        id: 'review-1',
        codex_session_id: 'review-1',
        agent_parent_session_id: 'main-1',
        wt_session: 'abc',
        reported_base_url: 'http://127.0.0.1:4000/v1',
        reported_model_provider: 'api_router',
        reported_model: null,
        last_seen_unix_ms: 90,
        active: false,
        current_provider: 'provider_1',
        verified: true,
        is_agent: true,
        is_review: true,
      },
    ]

    const arranged = arrangeSessionRowsByMainParent(rows)
    expect(arranged.map((entry) => entry.row.id)).toEqual(['main-1', 'agent-1', 'review-1'])
    expect(arranged[1].parentMainSessionId).toBe('main-1')
    expect(arranged[2].parentMainSessionId).toBe('main-1')
  })

  it('hides orphan agent rows before matching main session appears', () => {
    const rows = [
      {
        id: 'orphan-agent',
        codex_session_id: 'orphan-agent',
        agent_parent_session_id: 'missing-main',
        wt_session: 'abc',
        reported_base_url: 'http://127.0.0.1:4000/v1',
        reported_model_provider: 'api_router',
        reported_model: null,
        last_seen_unix_ms: 300,
        active: false,
        current_provider: 'provider_1',
        verified: true,
        is_agent: true,
        is_review: false,
      },
      {
        id: 'main-1',
        codex_session_id: 'main-1',
        agent_parent_session_id: null,
        wt_session: 'abc',
        reported_base_url: 'http://127.0.0.1:4000/v1',
        reported_model_provider: 'api_router',
        reported_model: null,
        last_seen_unix_ms: 200,
        active: true,
        current_provider: 'provider_1',
        verified: true,
        is_agent: false,
        is_review: false,
      },
    ]

    const arranged = arrangeSessionRowsByMainParent(rows)
    expect(arranged.map((entry) => entry.row.id)).toEqual(['main-1'])
  })

  it('hides child rows until main session has assigned provider', () => {
    const rows = [
      {
        id: 'child-review',
        codex_session_id: 'child-review',
        agent_parent_session_id: 'main-1',
        wt_session: 'abc',
        reported_base_url: 'http://127.0.0.1:4000/v1',
        reported_model_provider: 'api_router',
        reported_model: null,
        last_seen_unix_ms: 300,
        active: true,
        current_provider: 'provider_2',
        verified: true,
        is_agent: true,
        is_review: true,
      },
      {
        id: 'main-1',
        codex_session_id: 'main-1',
        agent_parent_session_id: null,
        wt_session: 'abc',
        reported_base_url: 'http://127.0.0.1:4000/v1',
        reported_model_provider: 'api_router',
        reported_model: null,
        last_seen_unix_ms: 200,
        active: true,
        current_provider: null,
        verified: true,
        is_agent: false,
        is_review: false,
      },
    ]

    const arranged = arrangeSessionRowsByMainParent(rows)
    expect(arranged.map((entry) => entry.row.id)).toEqual(['main-1'])
  })
})
