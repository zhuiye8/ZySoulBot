// Hono 管理后台组合入口：统一鉴权 + CSRF 防护 + 静态 SPA 托管（web/dist）。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { AdminAuthManager, parseCookie, SESSION_COOKIE_NAME } from './auth.ts'
import type { AdminContext } from './context.ts'
import { registerAuthRoutes } from './routes/auth.ts'
import { registerOverviewRoutes } from './routes/overview.ts'
import { registerLifeRoutes } from './routes/life.ts'
import { registerMemoryRoutes } from './routes/memory.ts'
import { registerWorksRoutes } from './routes/works.ts'
import { registerSoulRoutes } from './routes/soul.ts'

const PUBLIC_API_PATHS = new Set(['/api/login', '/api/logout', '/api/me'])
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

export interface AdminAppBundle {
  app: Hono
  auth: AdminAuthManager
}

export function createAdminApp(ctx: AdminContext): AdminAppBundle {
  const auth = new AdminAuthManager(ctx.authFilePath, ctx.initialPassword)
  const app = new Hono()

  app.onError((err, c) => {
    return c.json({ error: err.message || 'Internal Server Error' }, 500)
  })

  // 统一安全响应头 + API 认证与 CSRF 校验
  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('X-Frame-Options', 'DENY')
    c.header('Referrer-Policy', 'same-origin')

    const path = c.req.path
    if (path.startsWith('/api/') && !PUBLIC_API_PATHS.has(path)) {
      const token = parseCookie(c.req.header('cookie'), SESSION_COOKIE_NAME)
      const session = auth.verifySession(token)
      if (!session) return c.json({ error: '请先登录管理后台' }, 401)
      if (MUTATING_METHODS.has(c.req.method.toUpperCase())) {
        const csrf = c.req.header('x-csrf-token')
        if (!csrf || csrf !== session.csrf) {
          return c.json({ error: 'CSRF 校验失败，请刷新页面重试' }, 403)
        }
      }
    }
    await next()
  })

  registerAuthRoutes(app, auth)
  registerOverviewRoutes(app, ctx)
  registerLifeRoutes(app, ctx)
  registerMemoryRoutes(app, ctx)
  registerWorksRoutes(app, ctx)
  registerSoulRoutes(app, ctx)

  // 托管前端静态打包产物 web/dist（带 SPA 回落）
  const distDir = resolve(ctx.webDistDir ?? join(process.cwd(), 'web', 'dist'))
  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'Not Found' }, 404)
    if (!existsSync(distDir)) {
      return c.html(
        '<!doctype html><meta charset="utf-8"><title>zySoulbot Admin</title><body style="font-family:sans-serif;padding:40px"><h2>zySoulbot Admin</h2><p>前端尚未构建，请运行 <code>pnpm run build:web</code>。</p></body>',
        200,
      )
    }
    const reqRel = c.req.path === '/' ? 'index.html' : c.req.path.replace(/^\/+/, '')
    let filePath = resolve(distDir, reqRel)
    if (!filePath.startsWith(distDir) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
      filePath = join(distDir, 'index.html')
    }
    if (!existsSync(filePath)) return c.text('index.html missing', 404)
    const ext = extname(filePath).toLowerCase()
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'
    const isAsset = c.req.path.startsWith('/assets/')
    const bytes = readFileSync(filePath)
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      },
    })
  })

  return { app, auth }
}

export interface AdminServerHandle {
  close(): Promise<void>
}

export function startAdminServer(
  bundle: AdminAppBundle,
  opts: { host: string; port: number },
): AdminServerHandle {
  const server = serve({
    fetch: bundle.app.fetch,
    hostname: opts.host,
    port: opts.port,
  })
  return {
    close(): Promise<void> {
      return new Promise((resolveClose) => {
        server.close(() => resolveClose())
      })
    },
  }
}
