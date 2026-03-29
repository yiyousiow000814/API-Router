import { describe, expect, it } from 'vitest'

import {
  MOBILE_PROMPT_MAX_HEIGHT_PX,
  MOBILE_PROMPT_MIN_HEIGHT_PX,
  clearPromptInput,
  readPromptValue,
  resolveMobilePromptLayout,
  resolveMobilePromptMaxHeight,
} from './promptState.js'

describe('promptState', () => {
  it('clamps prompt max height by viewport', () => {
    expect(resolveMobilePromptMaxHeight(Number.NaN)).toBe(MOBILE_PROMPT_MAX_HEIGHT_PX)
    expect(resolveMobilePromptMaxHeight(200)).toBe(132)
    expect(resolveMobilePromptMaxHeight(1200)).toBe(MOBILE_PROMPT_MAX_HEIGHT_PX)
  })

  it('computes prompt layout height and overflow', () => {
    expect(resolveMobilePromptLayout(12, 800)).toEqual({
      heightPx: MOBILE_PROMPT_MIN_HEIGHT_PX,
      overflowY: 'hidden',
    })
    expect(resolveMobilePromptLayout(999, 500)).toEqual({
      heightPx: resolveMobilePromptMaxHeight(500),
      overflowY: 'auto',
    })
  })

  it('reads and clears prompt values', () => {
    const input = { value: '  hello codex  ' }
    expect(readPromptValue(input)).toBe('hello codex')

    clearPromptInput(input)
    expect(input.value).toBe('')
    expect(readPromptValue(input)).toBe('')
  })

  it('preserves internal blank lines while trimming outer whitespace', () => {
    const input = { value: '  line one\n\nline two  ' }
    expect(readPromptValue(input)).toBe('line one\n\nline two')
  })
})
