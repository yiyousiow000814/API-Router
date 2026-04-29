import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { UsageAuthModal } from './UsageAuthModal'

const noop = vi.fn()

describe('UsageAuthModal', () => {
  it('renders account login fields when opened', () => {
    const html = renderToStaticMarkup(
      <UsageAuthModal
        open
        provider="codex"
        baseUrl="https://api-vip.codex-for.vip/v1"
        token=""
        username=""
        password=""
        loading={false}
        loadFailed={false}
        onChangeUsername={noop}
        onChangePassword={noop}
        onCancel={noop}
        onClear={noop}
        onSave={noop}
      />,
    )

    expect(html).toContain('Usage auth')
    expect(html).toContain('Username')
    expect(html).toContain('Password')
    expect(html).toContain('padding:0 12px')
  })

  it('does not render loading copy while auth is loading', () => {
    const html = renderToStaticMarkup(
      <UsageAuthModal
        open
        provider="codex"
        baseUrl="https://api-vip.codex-for.vip/v1"
        token=""
        username=""
        password=""
        loading
        loadFailed={false}
        onChangeUsername={noop}
        onChangePassword={noop}
        onCancel={noop}
        onClear={noop}
        onSave={noop}
      />,
    )

    expect(html).not.toContain('Loading...')
  })

  it('does not render when closed', () => {
    const html = renderToStaticMarkup(
      <UsageAuthModal
        open={false}
        provider="packy"
        baseUrl="https://codex.packycode.com"
        token=""
        username=""
        password=""
        loading={false}
        loadFailed={false}
        onChangeUsername={noop}
        onChangePassword={noop}
        onCancel={noop}
        onClear={noop}
        onSave={noop}
      />,
    )

    expect(html).toBe('')
  })
})
