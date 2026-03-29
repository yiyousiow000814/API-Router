import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 4000
const REQUEST_TIMEOUT_MS = 8000

function resolveListenFromConfig() {
  const configPath = path.resolve(process.cwd(), 'user-data', 'config.toml')
  if (!fs.existsSync(configPath)) {
    return { host: DEFAULT_HOST, port: DEFAULT_PORT }
  }
  const raw = fs.readFileSync(configPath, 'utf8')
  const listenMatch = raw.match(/\[listen\]([\s\S]*?)(\n\[|$)/m)
  if (!listenMatch) {
    return { host: DEFAULT_HOST, port: DEFAULT_PORT }
  }
  const section = listenMatch[1] || ''
  const hostMatch = section.match(/^\s*host\s*=\s*"([^"]+)"/m)
  const portMatch = section.match(/^\s*port\s*=\s*(\d+)/m)
  const hostRaw = String(hostMatch?.[1] || DEFAULT_HOST).trim()
  const host = hostRaw === '0.0.0.0' || hostRaw === '::' ? DEFAULT_HOST : hostRaw
  const portNum = Number.parseInt(String(portMatch?.[1] || DEFAULT_PORT), 10)
  const port = Number.isFinite(portNum) && portNum > 0 ? portNum : DEFAULT_PORT
  return { host, port }
}

function resolveBaseUrl() {
  const fromEnv = String(process.env.API_ROUTER_GATEWAY_BASE_URL || '').trim()
  if (fromEnv) return fromEnv.replace(/\/+$/, '')
  const listen = resolveListenFromConfig()
  return `http://${listen.host}:${listen.port}`
}

function resolveGatewayToken() {
  const envToken = String(process.env.API_ROUTER_GATEWAY_TOKEN || '').trim()
  if (envToken) return envToken
  const secretsPath = path.resolve(process.cwd(), 'user-data', 'secrets.json')
  if (!fs.existsSync(secretsPath)) return ''
  try {
    const raw = fs.readFileSync(secretsPath, 'utf8')
    const parsed = JSON.parse(raw)
    return String(parsed?.providers?.__gateway_token__ || '').trim()
  } catch {
    return ''
  }
}

async function requestJson(baseUrl, token, endpoint, method, body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const headers = {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    return { ok: true, status: Number(res.status || 0) }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  } finally {
    clearTimeout(timer)
  }
}

function assertNot5xx(name, result) {
  if (!result.ok) {
    throw new Error(`${name} network error: ${result.error}`)
  }
  if (result.status >= 500) {
    throw new Error(`${name} returned ${result.status}`)
  }
}

function warnIfUnhealthy(name, result) {
  if (!result.ok) {
    console.warn(`[check:codex-gateway] WARN ${name} network error: ${result.error}`)
    return 'warn'
  }
  if (result.status >= 500) {
    console.warn(`[check:codex-gateway] WARN ${name} returned ${result.status}`)
    return 'warn'
  }
  return String(result.status)
}

async function main() {
  const baseUrl = resolveBaseUrl()
  const token = resolveGatewayToken()
  const verify = await requestJson(baseUrl, token, '/codex/auth/verify', 'POST', {})
  const threadsWindows = await requestJson(
    baseUrl,
    token,
    '/codex/threads?workspace=windows',
    'GET',
    undefined,
  )
  const threadsWsl2 = await requestJson(
    baseUrl,
    token,
    '/codex/threads?workspace=wsl2',
    'GET',
    undefined,
  )

  assertNot5xx('POST /codex/auth/verify', verify)
  assertNot5xx('GET /codex/threads?workspace=windows', threadsWindows)
  const wsl2Status = warnIfUnhealthy('GET /codex/threads?workspace=wsl2', threadsWsl2)

  const summary = [
    ['verify', verify.status],
    ['threads-windows', threadsWindows.status],
    ['threads-wsl2', wsl2Status],
  ]
    .map(([name, status]) => `${name}=${status}`)
    .join(' ')
  console.log(`[check:codex-gateway] PASS base=${baseUrl} ${summary}`)
}

main().catch((error) => {
  const baseUrl = resolveBaseUrl()
  console.error(`[check:codex-gateway] FAIL ${String(error?.message || error)} (base=${baseUrl})`)
  console.error(
    '[check:codex-gateway] Hint: start repo-root `API Router.exe` and ensure `user-data/config.toml` listen host/port is reachable.',
  )
  process.exit(1)
})
