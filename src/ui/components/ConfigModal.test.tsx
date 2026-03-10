import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConfigModal } from './ConfigModal'
import type { Config } from '../types'

function buildConfig(): Config {
  return {
    listen: { host: '127.0.0.1', port: 4000 },
    routing: {
      preferred_provider: 'p1',
      auto_return_to_preferred: true,
      preferred_stable_seconds: 30,
      failure_threshold: 3,
      cooldown_seconds: 20,
      request_timeout_seconds: 60,
    },
    providers: {
      p1: {
        display_name: 'Provider 1',
        base_url: 'https://example.com/v1',
        has_key: false,
      },
    },
    provider_order: ['p1'],
  }
}

describe('ConfigModal', () => {
  it('renders provider name, base url, and key inputs for add provider', () => {
    const html = renderToStaticMarkup(
      <ConfigModal
        open
        config={buildConfig()}
        newProviderName=""
        newProviderBaseUrl=""
        newProviderKey=""
        nextProviderPlaceholder="provider1"
        setNewProviderName={() => undefined}
        setNewProviderBaseUrl={() => undefined}
        setNewProviderKey={() => undefined}
        onAddProvider={() => undefined}
        onOpenGroupManager={() => undefined}
        onClose={() => undefined}
        providerListRef={{ current: null }}
        orderedConfigProviders={['p1']}
        dragPreviewOrder={null}
        draggingProvider={null}
        dragCardHeight={0}
        renderProviderCard={() => null}
      />,
    )

    expect(html).toContain('provider1')
    expect(html).toContain('Base URL (e.g. https://api.openai.com/v1)')
    expect(html).toContain('placeholder="Key"')
  })
})
