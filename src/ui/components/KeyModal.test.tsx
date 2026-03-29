import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { KeyModal } from './KeyModal'

describe('KeyModal', () => {
  it('disables save while existing key is loading', () => {
    const html = renderToStaticMarkup(
      <KeyModal
        open
        provider="provider_1"
        value=""
        storage="auth_json"
        loading
        loadFailed={false}
        onChange={() => {}}
        onChangeStorage={() => {}}
        onCancel={() => {}}
        onSave={() => {}}
      />,
    )
    expect(html).toContain('aoBtn aoBtnPrimary')
    expect(html).toContain('aoBtn aoBtnPrimary" disabled')
    expect(html).toContain('placeholder="Paste API key..."')
    expect(html).toContain('disabled')
  })
})
