import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

const gatewayProxyTarget = process.env.VITE_GATEWAY_PROXY_TARGET || 'http://127.0.0.1:4000'

function resolveGatewayTokenFromSecrets(): string {
  try {
    const secretsPath = path.resolve(process.cwd(), 'user-data', 'secrets.json')
    if (!fs.existsSync(secretsPath)) return ''
    const raw = fs.readFileSync(secretsPath, 'utf-8')
    const parsed = JSON.parse(raw) as { providers?: Record<string, unknown> }
    const token = String(parsed?.providers?.['__gateway_token__'] ?? '').trim()
    return token
  } catch {
    return ''
  }
}

async function resolveEmbeddedTokenLiteral(): Promise<string> {
  try {
    const target = `${gatewayProxyTarget.replace(/\/+$/, '')}/codex-web`
    const res = await fetch(target)
    if (!res.ok) {
      const fallbackToken = resolveGatewayTokenFromSecrets()
      return JSON.stringify(fallbackToken)
    }
    const html = await res.text()
    const match = html.match(/window\.__WEB_CODEX_EMBEDDED_TOKEN__\s*=\s*(".*?");/)
    if (match?.[1]) return match[1]
    const fallbackToken = resolveGatewayTokenFromSecrets()
    return JSON.stringify(fallbackToken)
  } catch {
    const fallbackToken = resolveGatewayTokenFromSecrets()
    return JSON.stringify(fallbackToken)
  }
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'codex-web-dev-route',
      configureServer(server) {
        const htmlPath = path.resolve(process.cwd(), 'codex-web.html')
        server.middlewares.use((req, _res, next) => {
          const url = req.url || ''
          const isCodexWeb = url === '/codex-web' || url.startsWith('/codex-web?')
          const isSandboxWeb = url === '/sandbox/codex-web' || url.startsWith('/sandbox/codex-web?')
          if (!isCodexWeb && !isSandboxWeb) {
            next()
            return
          }
          void (async () => {
            let html = fs.readFileSync(htmlPath, 'utf-8')
            const tokenLiteral = await resolveEmbeddedTokenLiteral()
            html = html.replace('"__WEB_CODEX_EMBEDDED_TOKEN__"', tokenLiteral)
            if (isSandboxWeb) {
              html = html.replace(
                '<script type="module" src="/src/ui/codex-web-dev.js"></script>',
                '<script>window.__WEB_CODEX_SANDBOX__=true;</script><script type="module" src="/src/ui/codex-web-dev.js"></script>',
              )
            }
            const transformed = await server.transformIndexHtml(req.url || '/codex-web', html)
            _res.statusCode = 200
            _res.setHeader('Content-Type', 'text/html; charset=utf-8')
            _res.end(transformed)
          })()
          return
        })
      },
    },
  ],
  server: {
    proxy: {
      '/codex': {
        target: gatewayProxyTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
