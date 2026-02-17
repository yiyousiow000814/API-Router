const DEFAULT_GATEWAY_PORT = 4000

export function normalizeGatewayPort(port: number | null | undefined): number {
  if (!Number.isFinite(port)) return DEFAULT_GATEWAY_PORT
  const n = Math.trunc(Number(port))
  if (n <= 0 || n > 65535) return DEFAULT_GATEWAY_PORT
  return n
}

export function buildGatewayBaseUrl(host: string, port: number | null | undefined): string {
  return `http://${host}:${normalizeGatewayPort(port)}/v1`
}
