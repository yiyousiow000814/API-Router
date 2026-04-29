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
        username=""
        password=""
        onChange={noop}
        onChangeUsername={noop}
        onChangePassword={noop}
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
        username=""
        password=""
        onChange={noop}
        onChangeUsername={noop}
        onChangePassword={noop}
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
        username=""
        password=""
        onChange={noop}
        onChangeUsername={noop}
        onChangePassword={noop}
        onCancel={noop}
        onClear={noop}
        onSave={noop}
      />,
    )

    expect(html).toContain('disabled=""')
  })

  it('renders login fields inside usage url for supported providers', () => {
    const html = renderToStaticMarkup(
      <UsageBaseModal
        open
        provider="yangfangyu"
        value="https://yfy.zhouyang168.top"
        effectiveValue=""
        username="alice"
        password="secret"
        showAuthFields
        onChange={noop}
        onChangeUsername={noop}
        onChangePassword={noop}
        onCancel={noop}
        onClear={noop}
        onSave={noop}
      />,
    )

    expect(html).toContain('Usage URL')
    expect(html).toContain('Username')
    expect(html).toContain('Password')
    expect(html).toContain('alice')
  })
})
