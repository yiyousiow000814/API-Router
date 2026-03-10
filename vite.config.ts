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
    return String(parsed?.providers?.['__gateway_token__'] ?? '').trim()
  } catch {
    return ''
  }
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'codex-web-dev-route',
      configureServer(server) {
        const htmlPath = path.resolve(process.cwd(), 'codex-web.html')
        const iconPath = path.resolve(process.cwd(), 'src', 'ui', 'assets', 'codex-color.svg')
        server.middlewares.use((req, _res, next) => {
          const url = req.url || ''
          if (url === '/favicon.ico' || url.startsWith('/favicon.ico?')) {
            const svg = fs.readFileSync(iconPath, 'utf-8')
            _res.statusCode = 200
            _res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8')
            _res.end(svg)
            return
          }
          if (url === '/codex-web/codex-icon.svg' || url.startsWith('/codex-web/codex-icon.svg?')) {
            const svg = fs.readFileSync(iconPath, 'utf-8')
            _res.statusCode = 200
            _res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8')
            _res.end(svg)
            return
          }
          const isCodexWeb =
            url === '/codex-web' ||
            url === '/codex-web/' ||
            url.startsWith('/codex-web?') ||
            url.startsWith('/codex-web/?')
          const isSandboxWeb =
            url === '/sandbox/codex-web' ||
            url === '/sandbox/codex-web/' ||
            url.startsWith('/sandbox/codex-web?') ||
            url.startsWith('/sandbox/codex-web/?')
          if (!isCodexWeb && !isSandboxWeb) {
            next()
            return
          }
          void (async () => {
            let html = fs.readFileSync(htmlPath, 'utf-8')
            const gatewayToken = resolveGatewayTokenFromSecrets()
            html = html.replace(
              '<script type="module" src="/codex-web/app.js"></script>',
              '<script type="module" src="/src/ui/codex-web-dev.js"></script>',
            )
            if (isSandboxWeb) {
              html = html.replace(
                '<script type="module" src="/src/ui/codex-web-dev.js"></script>',
                '<script>window.__WEB_CODEX_SANDBOX__=true;</script><script type="module" src="/src/ui/codex-web-dev.js"></script>',
              )
            }
            const transformed = await server.transformIndexHtml(req.url || '/codex-web', html)
            _res.statusCode = 200
            _res.setHeader('Content-Type', 'text/html; charset=utf-8')
            if (gatewayToken) {
              _res.setHeader(
                'Set-Cookie',
                `api_router_gateway_token=${gatewayToken}; Path=/codex; HttpOnly; SameSite=Strict`,
              )
            }
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
