import { describe, expect, it } from 'vitest'
import { expandVisibleCountForFocusedEvent, resolveFocusedEvent } from './EventLogPanel'
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

  it('returns null when the exact event id is unavailable', () => {
    const exact = buildEvent({
      id: 'evt-exact',
      unix_ms: 1_717_171_709_000,
    })

    const focused = resolveFocusedEvent([exact], buildFocus({ eventId: 'evt-not-loaded' }))

    expect(focused).toBeNull()
  })

  it('returns null when no event id is provided', () => {
    const exact = buildEvent({
      id: 'evt-exact',
      unix_ms: 1_717_171_709_000,
    })

    const focused = resolveFocusedEvent([exact], buildFocus({ eventId: null }))

    expect(focused).toBeNull()
  })
})

describe('expandVisibleCountForFocusedEvent', () => {
  it('keeps the current count when the focused event is already rendered', () => {
    const rows = Array.from({ length: 250 }, (_, index) =>
      buildEvent({
        id: `evt-${index}`,
        unix_ms: 1_717_171_709_000 - index,
      }),
    )

    const nextCount = expandVisibleCountForFocusedEvent(200, rows, rows[50] ?? null)

    expect(nextCount).toBe(200)
  })

  it('expands to the next page that includes the focused event', () => {
    const rows = Array.from({ length: 450 }, (_, index) =>
      buildEvent({
        id: `evt-${index}`,
        unix_ms: 1_717_171_709_000 - index,
      }),
    )

    const nextCount = expandVisibleCountForFocusedEvent(200, rows, rows[425] ?? null)

    expect(nextCount).toBe(600)
  })

  it('keeps the current count when the focused event is absent from the filtered rows', () => {
    const rows = Array.from({ length: 100 }, (_, index) =>
      buildEvent({
        id: `evt-${index}`,
        unix_ms: 1_717_171_709_000 - index,
      }),
    )
    const missing = buildEvent({ id: 'evt-missing', unix_ms: 1_700_000_000_000 })

    const nextCount = expandVisibleCountForFocusedEvent(200, rows, missing)

    expect(nextCount).toBe(200)
  })
})
