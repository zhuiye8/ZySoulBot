// 认证路由：/api/login, /api/logout, /api/me, /api/password
import type { Context } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  buildClearSessionCookie,
  buildSessionCookie,
  parseCookie,
  SESSION_COOKIE_NAME,
} from '../auth.ts'
import type { AdminAuthManager } from '../auth.ts'

const LoginSchema = z.object({
  password: z.string().min(1),
})

const ChangePwdSchema = z.object({
  currentPassword: z.string().min(1),
  nextPassword: z.string().min(8),
})

function isHttpsRequest(c: Context, trustProxy: boolean): boolean {
  if (c.req.url.startsWith('https://')) return true
  if (trustProxy && c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase() === 'https') {
    return true
  }
  return false
}

// P1-SEC-05：默认只认真实 Socket 对端地址，仅在显式配置 trustProxy 时读取 X-Forwarded-For
function resolveClientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    if (xff) return xff
  }
  const envObj = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
  return envObj?.incoming?.socket?.remoteAddress || 'direct'
}

export function registerAuthRoutes(
  app: Hono,
  auth: AdminAuthManager,
  opts: { trustProxy?: boolean } = {},
): void {
  const trustProxy = Boolean(opts.trustProxy)

  app.get('/api/me', (c) => {
    const token = parseCookie(c.req.header('cookie'), SESSION_COOKIE_NAME)
    const session = auth.verifySession(token)
    if (!session) return c.json({ authenticated: false })
    return c.json({ authenticated: true, csrf: session.csrf })
  })

  app.post('/api/login', async (c) => {
    const ip = resolveClientIp(c, trustProxy)
    if (auth.isRateLimited(ip)) {
      return c.json({ error: '登录失败次数过多，请 15 分钟后再试' }, 429)
    }
    const body = LoginSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: '请输入密码' }, 400)

    const verified = await auth.verifyPasswordAsync(body.data.password)
    if (verified.busy) {
      return c.json({ error: '登录请求繁忙，请稍后重试' }, 429)
    }
    if (!verified.ok) {
      auth.recordLoginFail(ip)
      return c.json({ error: '密码不正确' }, 401)
    }
    auth.clearLoginFails(ip)
    const { token, payload } = auth.issueSession()
    c.header('Set-Cookie', buildSessionCookie(token, isHttpsRequest(c, trustProxy)))
    return c.json({ ok: true, csrf: payload.csrf })
  })

  app.post('/api/logout', (c) => {
    c.header('Set-Cookie', buildClearSessionCookie(isHttpsRequest(c, trustProxy)))
    return c.json({ ok: true })
  })

  app.post('/api/password', async (c) => {
    const body = ChangePwdSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: '密码格式无效（新密码至少 8 位）' }, 400)
    const res = await auth.changePasswordAsync(body.data.currentPassword, body.data.nextPassword)
    if (!res.ok) return c.json({ error: res.error }, 400)
    const { token, payload } = auth.issueSession()
    c.header('Set-Cookie', buildSessionCookie(token, isHttpsRequest(c, trustProxy)))
    return c.json({ ok: true, csrf: payload.csrf })
  })
}
