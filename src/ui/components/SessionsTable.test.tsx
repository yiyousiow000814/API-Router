import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SessionsTable, sessionPreferredPlaceholderLabel } from './SessionsTable'

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
  })
})
