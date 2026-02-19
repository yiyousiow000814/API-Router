import { describe, expect, it } from 'vitest'
import { isEventMessageOverflow } from './EventsTable'

describe('isEventMessageOverflow', () => {
  it('returns true when content overflows vertically', () => {
    expect(
      isEventMessageOverflow({
        scrollHeight: 64,
        clientHeight: 40,
        scrollWidth: 200,
        clientWidth: 200,
      }),
    ).toBe(true)
  })

  it('returns true when content overflows horizontally', () => {
    expect(
      isEventMessageOverflow({
        scrollHeight: 40,
        clientHeight: 40,
        scrollWidth: 240,
        clientWidth: 200,
      }),
    ).toBe(true)
  })

  it('returns false when content fits in both directions', () => {
    expect(
      isEventMessageOverflow({
        scrollHeight: 40,
        clientHeight: 40,
        scrollWidth: 200,
        clientWidth: 200,
      }),
    ).toBe(false)
  })
})
