// 认证路由：/api/login, /api/logout, /api/me, /api/password
import { Hono } from 'hono'
import { z } from 'zod'
import { parseCookie, SESSION_COOKIE_NAME } from '../auth.ts'
import type { AdminAuthManager } from '../auth.ts'

const LoginSchema = z.object({
  password: z.string().min(1),
})

const ChangePwdSchema = z.object({
  currentPassword: z.string().min(1),
  nextPassword: z.string().min(8),
})

export function registerAuthRoutes(app: Hono, auth: AdminAuthManager): void {
  app.get('/api/me', (c) => {
    const token = parseCookie(c.req.header('cookie'), SESSION_COOKIE_NAME)
    const session = auth.verifySession(token)
    if (!session) return c.json({ authenticated: false })
    return c.json({ authenticated: true, csrf: session.csrf })
  })

  app.post('/api/login', async (c) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local'
    if (auth.isRateLimited(ip)) {
      return c.json({ error: '登录失败次数过多，请 15 分钟后再试' }, 429)
    }
    const body = LoginSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: '请输入密码' }, 400)

    if (!auth.verifyPassword(body.data.password)) {
      auth.recordLoginFail(ip)
      return c.json({ error: '密码不正确' }, 401)
    }
    auth.clearLoginFails(ip)
    const { token, payload } = auth.issueSession()
    const secure = c.req.url.startsWith('https://') ? '; Secure' : ''
    c.header(
      'Set-Cookie',
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}`,
    )
    return c.json({ ok: true, csrf: payload.csrf })
  })

  app.post('/api/logout', (c) => {
    c.header('Set-Cookie', `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`)
    return c.json({ ok: true })
  })

  app.post('/api/password', async (c) => {
    const body = ChangePwdSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: '密码格式无效（新密码至少 8 位）' }, 400)
    const res = auth.changePassword(body.data.currentPassword, body.data.nextPassword)
    if (!res.ok) return c.json({ error: res.error }, 400)
    const { token, payload } = auth.issueSession()
    c.header('Set-Cookie', `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`)
    return c.json({ ok: true, csrf: payload.csrf })
  })
}
