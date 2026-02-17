import { describe, expect, it } from 'vitest'
import { buildGatewayBaseUrl } from './gatewayUrl'

describe('buildGatewayBaseUrl', () => {
  it('uses runtime listen port', () => {
    expect(buildGatewayBaseUrl('127.0.0.1', 4312)).toBe('http://127.0.0.1:4312/v1')
  })

  it('falls back to 4000 for invalid port', () => {
    expect(buildGatewayBaseUrl('127.0.0.1', 0)).toBe('http://127.0.0.1:4000/v1')
  })
})
