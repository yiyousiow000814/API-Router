import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { UsageBaseModal } from './UsageBaseModal'

const noop = vi.fn()

describe('UsageBaseModal', () => {
  it('renders usage url editor content', () => {
    const html = renderToStaticMarkup(
      <UsageBaseModal
        open
        provider="packycode"
        value=""
        effectiveValue=""
        onChange={noop}
        onCancel={noop}
        onClear={noop}
        onSave={noop}
      />,
    )

    expect(html).toContain('Usage URL')
    expect(html).toContain('Usage endpoint URL')
  })

  it('shows derived endpoint when available', () => {
    const html = renderToStaticMarkup(
      <UsageBaseModal
        open
        provider="other"
        value=""
        effectiveValue="https://codex.packycode.com"
        onChange={noop}
        onCancel={noop}
        onClear={noop}
        onSave={noop}
      />,
    )

    expect(html).toContain('Current derived endpoint')
    expect(html).toContain('https://codex.packycode.com')
  })

  it('disables clear when input is empty', () => {
    const html = renderToStaticMarkup(
      <UsageBaseModal
        open
        provider="packycode"
        value=""
        effectiveValue=""
        onChange={noop}
        onCancel={noop}
        onClear={noop}
        onSave={noop}
      />,
    )

    expect(html).toContain('disabled=""')
  })

  it('renders packycode auth action inside usage url modal', () => {
    const html = renderToStaticMarkup(
      <UsageBaseModal
        open
        provider="packycode"
        value=""
        effectiveValue=""
        showPackycodeLogin
        hasUsageLogin
        onChange={noop}
        onCancel={noop}
        onClear={noop}
        onSave={noop}
        onAuthAction={noop}
      />,
    )

    expect(html).toContain('Usage URL sets the endpoint. Packycode Login is a fallback when the endpoint alone cannot return usage.')
    expect(html).toContain('Logout')
  })
})
