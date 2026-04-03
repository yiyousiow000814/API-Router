import type { Config, Status } from '../types'

type WaitForLanConfigSourceTrustOptions = {
  nodeId: string
  loadStatus: () => Promise<Status>
  loadConfig: () => Promise<Config>
  applyStatus: (status: Status) => void
  applyConfig: (config: Config) => void
  wait?: (ms: number) => Promise<void>
  intervalMs?: number
  maxAttempts?: number
}

export function isLanConfigSourceTrusted(config: Config, nodeId: string): boolean {
  return Boolean(
    config.config_source?.sources.find((source) => source.node_id === nodeId)?.trusted,
  )
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export async function waitForLanConfigSourceTrust({
  nodeId,
  loadStatus,
  loadConfig,
  applyStatus,
  applyConfig,
  wait = defaultWait,
  intervalMs = 250,
  maxAttempts = 12,
}: WaitForLanConfigSourceTrustOptions): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const [status, config] = await Promise.all([loadStatus(), loadConfig()])
    applyStatus(status)
    applyConfig(config)
    if (isLanConfigSourceTrusted(config, nodeId)) {
      return true
    }
    if (attempt + 1 < maxAttempts) {
      await wait(intervalMs)
    }
  }
  return false
}

export async function ensureLanConfigSourceTrust(
  options: WaitForLanConfigSourceTrustOptions,
): Promise<void> {
  const trusted = await waitForLanConfigSourceTrust(options)
  if (!trusted) {
    throw new Error('Pairing PIN was not accepted.')
  }
}
