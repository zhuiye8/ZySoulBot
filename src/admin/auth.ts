// 管理后台安全认证：scrypt 密码哈希 + HMAC-SHA256 会话 Cookie + CSRF Token + 登录防爆破限流。
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

interface StoredAuth {
  salt: string
  hash: string
  secret: string
  updatedAt: string
}

export interface SessionPayload {
  iat: number
  exp: number
  csrf: string
}

const SESSION_TTL_MS = 12 * 3600 * 1000
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_MAX_FAILS = 10

function hashPassword(password: string, salt: string, keylen = 32): string {
  return scryptSync(password, salt, keylen).toString('hex')
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export class AdminAuthManager {
  readonly filePath: string
  private state: StoredAuth
  private loginFails = new Map<string, number[]>()
  readonly generatedPassword: string | null

  constructor(filePath: string, initialPassword?: string) {
    this.filePath = filePath
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as StoredAuth
      if (parsed.salt && parsed.hash && parsed.secret) {
        this.state = parsed
        this.generatedPassword = null
        return
      }
    }
    const pwd = initialPassword?.trim() || randomBytes(12).toString('base64url')
    this.generatedPassword = initialPassword ? null : pwd
    const salt = randomBytes(16).toString('hex')
    this.state = {
      salt,
      hash: hashPassword(pwd, salt),
      secret: randomBytes(32).toString('hex'),
      updatedAt: new Date().toISOString(),
    }
    this.persist()
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.filePath)
    try {
      chmodSync(this.filePath, 0o600)
    } catch {
      // Windows 忽略 chmod
    }
  }

  isRateLimited(ip: string, nowMs = Date.now()): boolean {
    const arr = (this.loginFails.get(ip) ?? []).filter((t) => nowMs - t < LOGIN_WINDOW_MS)
    this.loginFails.set(ip, arr)
    return arr.length >= LOGIN_MAX_FAILS
  }

  recordLoginFail(ip: string, nowMs = Date.now()): void {
    const arr = (this.loginFails.get(ip) ?? []).filter((t) => nowMs - t < LOGIN_WINDOW_MS)
    arr.push(nowMs)
    this.loginFails.set(ip, arr)
  }

  clearLoginFails(ip: string): void {
    this.loginFails.delete(ip)
  }

  verifyPassword(password: string): boolean {
    if (!password) return false
    const keylen = this.state.hash.length === 128 ? 64 : 32
    const cand = hashPassword(password, this.state.salt, keylen)
    return safeEqualHex(cand, this.state.hash)
  }

  changePassword(currentPassword: string, nextPassword: string): { ok: boolean; error?: string } {
    if (!this.verifyPassword(currentPassword)) return { ok: false, error: '当前密码不正确' }
    if (nextPassword.length < 8) return { ok: false, error: '新密码至少 8 位' }
    const salt = randomBytes(16).toString('hex')
    this.state = {
      salt,
      hash: hashPassword(nextPassword, salt),
      secret: randomBytes(32).toString('hex'),
      updatedAt: new Date().toISOString(),
    }
    this.persist()
    return { ok: true }
  }

  issueSession(nowMs = Date.now()): { token: string; payload: SessionPayload } {
    const payload: SessionPayload = {
      iat: nowMs,
      exp: nowMs + SESSION_TTL_MS,
      csrf: randomBytes(16).toString('hex'),
    }
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    const sig = createHmac('sha256', this.state.secret).update(body).digest('base64url')
    return { token: `${body}.${sig}`, payload }
  }

  verifySession(token: string | undefined, nowMs = Date.now()): SessionPayload | null {
    if (!token || !token.includes('.')) return null
    const [body, sig] = token.split('.')
    if (!body || !sig) return null
    const expected = createHmac('sha256', this.state.secret).update(body).digest('base64url')
    if (!safeEqualHex(sig, expected)) return null
    try {
      const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload
      if (typeof parsed.exp !== 'number' || parsed.exp <= nowMs || typeof parsed.csrf !== 'string') {
        return null
      }
      return parsed
    } catch {
      return null
    }
  }
}

export const SESSION_COOKIE_NAME = 'zysoul_session'

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim())
  }
  return undefined
}
