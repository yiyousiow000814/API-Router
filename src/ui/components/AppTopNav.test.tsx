import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('AppTopNav', () => {
  it('keeps the Getting Started trigger as a standalone button', () => {
    const source = fs.readFileSync(new URL('./AppTopNav.tsx', import.meta.url), 'utf8')

    expect(source).toContain('className="aoTinyBtn aoTopNavGettingStartedBtn"')
    expect(source).not.toContain('className="aoTopNavMenuBtn" aria-label="Getting Started"')
  })
})
