import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { UsageAuthModal } from './UsageAuthModal'

const noop = vi.fn()

describe('UsageAuthModal', () => {
  it('renders codex-for host account login fields', () => {
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
  })

  it('does not render for unsupported hosts', () => {
    const html = renderToStaticMarkup(
      <UsageAuthModal
        open
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
