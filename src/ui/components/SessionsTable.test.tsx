import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  SessionsTable,
  arrangeSessionRowsByMainParent,
  sessionPreferredPlaceholderLabel,
} from './SessionsTable'

describe('SessionsTable', () => {
  it('shows balanced-mode placeholder when global routing is balanced', () => {
    expect(sessionPreferredPlaceholderLabel('codex-for.me', 'balanced_auto')).toBe(
      '(follow balanced mode)',
    )
  })

  it('keeps global preferred placeholder in follow-preferred mode', () => {
    expect(sessionPreferredPlaceholderLabel('codex-for.me', 'follow_preferred_auto')).toBe(
      '(follow global: codex-for.me)',
    )
  })

  it('renders session preferred selects with fixed-width class', () => {
    const html = renderToStaticMarkup(
      <SessionsTable
        sessions={[
          {
            id: 's1',
            codex_session_id: 's1',
            last_seen_unix_ms: 1,
            active: true,
            preferred_provider: null,
            current_provider: 'provider_1',
            verified: true,
          },
        ]}
        providers={['provider_1']}
        globalPreferred="provider_1"
        routeMode="balanced_auto"
        updating={{}}
        onSetPreferred={vi.fn()}
      />,
    )

    expect(html).toContain('aoSessionsPreferredSelect')
    expect(html).not.toContain('Open synced TUI')
  })

  it('keeps orphan agent rows visible when parent main session is missing', () => {
    const arranged = arrangeSessionRowsByMainParent([
      {
        id: 'agent-1',
        codex_session_id: 'agent-1',
        agent_parent_session_id: 'missing-main',
        is_agent: true,
        is_review: false,
        verified: true,
        current_provider: 'provider_1',
        last_seen_unix_ms: 1,
        active: true,
      },
    ])

    expect(arranged).toHaveLength(1)
    expect(arranged[0]?.row.id).toBe('agent-1')
    expect(arranged[0]?.parentMainSessionId).toBeUndefined()
  })

  it('renders orphan agent rows with an agent badge', () => {
    const html = renderToStaticMarkup(
      <SessionsTable
        sessions={[
          {
            id: 'agent-1',
            codex_session_id: 'agent-1',
            agent_parent_session_id: 'missing-main',
            reported_model_provider: 'api_router',
            reported_model: 'gpt-5.4',
            last_seen_unix_ms: 1,
            active: true,
            preferred_provider: null,
            current_provider: 'provider_1',
            verified: true,
            is_agent: true,
            is_review: false,
          },
        ]}
        providers={['provider_1']}
        globalPreferred="provider_1"
        routeMode="balanced_auto"
        updating={{}}
        onSetPreferred={vi.fn()}
      />,
    )

    expect(html).toContain('AGENT')
    expect(html).toContain('agent-1')
  })
})
