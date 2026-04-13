import { describe, expect, it } from 'vitest'
import { resolveFocusedEvent } from './EventLogPanel'
import type { EventLogEntry, EventLogFocusRequest } from './EventLogPanel'

function buildEvent(partial: Partial<EventLogEntry>): EventLogEntry {
  return {
    id: 'evt-default',
    provider: 'demo',
    level: 'error',
    unix_ms: 1_717_171_709_000,
    code: 'gateway.request_failed',
    message: 'http 503 from peer',
    fields: null,
    ...partial,
  }
}

function buildFocus(partial: Partial<EventLogFocusRequest>): EventLogFocusRequest {
  return {
    provider: 'demo',
    unixMs: 1_717_171_709_000,
    message: 'http 503 from peer',
    eventId: null,
    nonce: 1,
    ...partial,
  }
}

describe('resolveFocusedEvent', () => {
  it('prefers exact event id over fuzzy provider and message matching', () => {
    const older = buildEvent({
      id: 'evt-older',
      unix_ms: 1_717_171_700_000,
    })
    const exact = buildEvent({
      id: 'evt-exact',
      unix_ms: 1_717_171_800_000,
    })

    const focused = resolveFocusedEvent([older, exact], buildFocus({ eventId: 'evt-exact' }))

    expect(focused?.id).toBe('evt-exact')
  })

  it('falls back to provider and message search when event id is unavailable', () => {
    const older = buildEvent({
      id: 'evt-older',
      unix_ms: 1_717_171_700_000,
      message: 'http 503 from peer (attempt 1)',
    })
    const exact = buildEvent({
      id: 'evt-exact',
      unix_ms: 1_717_171_709_000,
      message: 'http 503 from peer (attempt 2)',
    })

    const focused = resolveFocusedEvent(
      [older, exact],
      buildFocus({ eventId: null, message: 'http 503 from peer (attempt 2)' }),
    )

    expect(focused?.id).toBe('evt-exact')
  })
})
