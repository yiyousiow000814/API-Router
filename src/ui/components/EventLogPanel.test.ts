import { describe, expect, it } from 'vitest'
import { resolveFocusedEvent, shouldFallbackToFocusWindow } from './EventLogPanel'
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

describe('shouldFallbackToFocusWindow', () => {
  it('falls back when exact lookup returns null', () => {
    expect(shouldFallbackToFocusWindow(null)).toBe(true)
  })

  it('falls back when the returned event has no usable timestamp', () => {
    expect(shouldFallbackToFocusWindow(buildEvent({ unix_ms: Number.NaN }))).toBe(true)
  })

  it('keeps exact lookup results when the returned event is valid', () => {
    expect(shouldFallbackToFocusWindow(buildEvent({ id: 'evt-exact' }))).toBe(false)
  })
})
