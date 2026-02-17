import { describe, expect, it } from 'vitest'
import { isWslSessionRow } from './SessionsTable'

describe('isWslSessionRow', () => {
  it('prefers wsl wt_session marker even when base_url is localhost', () => {
    expect(
      isWslSessionRow({
        wt_session: 'wsl:abc',
        reported_base_url: 'http://127.0.0.1:4000/v1',
      }),
    ).toBe(true)
  })

  it('detects wsl from reported base_url', () => {
    expect(
      isWslSessionRow({
        wt_session: 'abc',
        reported_base_url: 'http://172.26.144.1:4000/v1',
      }),
    ).toBe(true)
  })

  it('treats localhost as windows when no wsl marker exists', () => {
    expect(
      isWslSessionRow({
        wt_session: 'abc',
        reported_base_url: 'http://localhost:4000/v1',
      }),
    ).toBe(false)
  })
})
