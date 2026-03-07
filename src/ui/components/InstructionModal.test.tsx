import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { InstructionModal } from './InstructionModal'

describe('InstructionModal', () => {
  it('does not render legacy WSL gateway access step', () => {
    const html = renderToStaticMarkup(
      <InstructionModal
        open
        onClose={() => {}}
        onOpenConfigureDirs={() => {}}
        onOpenRawConfig={() => {}}
        codeText={'model_provider = "api_router"'}
        listenPort={4000}
        flashToast={() => {}}
        isDevPreview={false}
      />,
    )

    expect(html).not.toContain('WSL2 gateway access')
    expect(html).not.toContain('Authorize (Admin)')
    expect(html).not.toContain('Revoke')
  })
})
