import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CodexSwapModal } from './CodexSwapModal'

describe('CodexSwapModal', () => {
  it('does not render legacy WSL gateway access controls', () => {
    const html = renderToStaticMarkup(
      <CodexSwapModal
        open
        windowsDir={'C:\\Users\\a\\.codex'}
        wslDir={'\\\\wsl.localhost\\Ubuntu\\home\\a\\.codex'}
        useWindows={false}
        useWsl
        onChangeWindowsDir={() => {}}
        onChangeWslDir={() => {}}
        onChangeUseWindows={() => {}}
        onChangeUseWsl={() => {}}
        onCancel={() => {}}
        onApply={() => {}}
        flashToast={() => {}}
        isDevPreview={false}
        listenPort={4000}
      />,
    )

    expect(html).not.toContain('WSL2 gateway access')
    expect(html).not.toContain('Authorize (Admin)')
    expect(html).not.toContain('Revoke')
  })
})
