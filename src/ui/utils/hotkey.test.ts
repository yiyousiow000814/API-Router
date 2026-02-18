import { describe, expect, it } from 'vitest'
import { isSaveHotkey, resolvePreferredTarget } from './hotkey'

describe('isSaveHotkey', () => {
  it('accepts Ctrl/Cmd + S', () => {
    expect(isSaveHotkey({ key: 's', ctrlKey: true })).toBe(true)
    expect(isSaveHotkey({ key: 'S', metaKey: true })).toBe(true)
  })

  it('rejects non-save combinations', () => {
    expect(isSaveHotkey({ key: 's', ctrlKey: true, shiftKey: true })).toBe(false)
    expect(isSaveHotkey({ key: 's', ctrlKey: true, altKey: true })).toBe(false)
    expect(isSaveHotkey({ key: 'k', ctrlKey: true })).toBe(false)
  })
})

describe('resolvePreferredTarget', () => {
  it('prefers focused target when usable', () => {
    const target = resolvePreferredTarget(['a', 'b'], 'b', (v) => v === 'b')
    expect(target).toBe('b')
  })

  it('falls back to first usable target', () => {
    const target = resolvePreferredTarget(['a', 'b'], 'b', (v) => v === 'a')
    expect(target).toBe('a')
  })

  it('returns null when no usable targets', () => {
    const target = resolvePreferredTarget(['a', 'b'], null, () => false)
    expect(target).toBeNull()
  })
})
