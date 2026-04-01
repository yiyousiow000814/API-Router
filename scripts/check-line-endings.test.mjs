import { describe, expect, it } from 'vitest'

import { collectChangedFiles, resolveBaseRef } from './check-line-endings.mjs'

describe('check-line-endings', () => {
  it('falls back to a reachable default base ref when the configured base ref does not exist', () => {
    expect(['origin/main', 'origin/HEAD', 'main']).toContain(
      resolveBaseRef({ LINE_ENDINGS_BASE: 'refs/does-not-exist' }),
    )
  })

  it('falls back to the last commit diff when no base ref or working tree changes are available', () => {
    const result = collectChangedFiles(
      { LINE_ENDINGS_BASE: 'refs/does-not-exist' },
      {
        resolveBaseRef: () => null,
        gitLines: (args) => {
          if (args[0] === 'show') return ['scripts/check-line-endings.mjs']
          return []
        },
      },
    )
    expect(result.source).toBe('last-commit-fallback')
    expect(result.files).toEqual(['scripts/check-line-endings.mjs'])
  })
})
