import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { OfficialAccountQuotaSummary } from './OfficialAccountQuotaSummary'
import type { OfficialAccountProfileSummary } from '../types'

describe('OfficialAccountQuotaSummary', () => {
  it('renders cached usage bars when usage exists', () => {
    const profile: OfficialAccountProfileSummary = {
      id: 'official_1',
      label: 'Official account 1',
      updated_at_unix_ms: Date.now(),
      active: true,
      limit_5h_remaining: '64%',
      limit_weekly_remaining: '41%',
    }

    const html = renderToStaticMarkup(<OfficialAccountQuotaSummary profile={profile} />)

    expect(html).toContain('5-hour')
    expect(html).toContain('Weekly')
    expect(html).toContain('64%')
    expect(html).toContain('41%')
    expect(html).toContain('aoAccountsUsageBar')
  })

  it('renders the no-cache fallback when usage is absent', () => {
    const profile: OfficialAccountProfileSummary = {
      id: 'official_1',
      label: 'Official account 1',
      updated_at_unix_ms: Date.now(),
      active: true,
    }

    const html = renderToStaticMarkup(<OfficialAccountQuotaSummary profile={profile} />)

    expect(html).toContain('No cached limits yet')
  })

  it('renders the expired fallback when re-auth is required', () => {
    const profile: OfficialAccountProfileSummary = {
      id: 'official_1',
      label: 'Official account 1',
      updated_at_unix_ms: Date.now(),
      active: true,
      needs_reauth: true,
    }

    const html = renderToStaticMarkup(<OfficialAccountQuotaSummary profile={profile} />)

    expect(html).toContain('Session expired')
    expect(html).toContain('aoAccountsQuotaExpired')
  })
})
