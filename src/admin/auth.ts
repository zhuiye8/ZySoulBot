// 管理后台安全认证：异步 scrypt 密码哈希 + HMAC-SHA256 会话 Cookie + CSRF Token + 登录防爆破限流（单 IP + 全局 + 并发保护）。
import { createHmac, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
const LOGIN_MAX_FAILS_PER_IP = 10
const LOGIN_MAX_FAILS_GLOBAL = 60
const MAX_TRACKED_IPS = 512
const MAX_CONCURRENT_VERIFY = 4

function hashPasswordSync(password: string, salt: string, keylen = 32): string {
  return scryptSync(password, salt, keylen).toString('hex')
}

function hashPasswordAsync(password: string, salt: string, keylen = 32): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    scrypt(password, salt, keylen, (err, derivedKey) => {
      if (err) rejectHash(err)
      else resolveHash(derivedKey.toString('hex'))
    })
  })
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

function tightenPermissions(filePath: string): void {
  try {
    chmodSync(filePath, 0o600)
  } catch {
    // Windows 忽略 chmod
  }
}

function writeAtomicSecure(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  tightenPermissions(tmp)
  renameSync(tmp, filePath)
  tightenPermissions(filePath)
}

export class AdminAuthManager {
  readonly filePath: string
  readonly initialPasswordFilePath: string | null
  private state: StoredAuth
  private loginFails = new Map<string, number[]>()
  private globalFails: number[] = []
  private activeVerifies = 0
  readonly generatedPassword: string | null

  constructor(filePath: string, initialPassword?: string) {
    this.filePath = filePath
    const initPwdFile = join(dirname(filePath), 'admin-initial-password.txt')
    if (existsSync(filePath)) {
      tightenPermissions(filePath)
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as StoredAuth
      if (parsed.salt && parsed.hash && parsed.secret) {
        this.state = parsed
        this.generatedPassword = null
        this.initialPasswordFilePath = existsSync(initPwdFile) ? initPwdFile : null
        return
      }
    }
    const pwd = initialPassword?.trim() || randomBytes(12).toString('base64url')
    this.generatedPassword = initialPassword ? null : pwd
    const salt = randomBytes(16).toString('hex')
    this.state = {
      salt,
      hash: hashPasswordSync(pwd, salt),
      secret: randomBytes(32).toString('hex'),
      updatedAt: new Date().toISOString(),
    }
    this.persist()
    if (this.generatedPassword) {
      // P2-INIT-01：将首次随机密码落盘到独立 0600 提示文件（改密后自动销毁），不打印进共享日志
      writeAtomicSecure(
        initPwdFile,
        `# ZySoulBot 首次随机生成的后台管理员口令（登录并修改密码后将自动删除）\n${this.generatedPassword}\n`,
      )
      this.initialPasswordFilePath = initPwdFile
    } else {
      this.initialPasswordFilePath = null
    }
  }

  private persist(): void {
    writeAtomicSecure(this.filePath, JSON.stringify(this.state, null, 2))
  }

  private pruneBuckets(nowMs: number): void {
    this.globalFails = this.globalFails.filter((t) => nowMs - t < LOGIN_WINDOW_MS)
    if (this.loginFails.size <= MAX_TRACKED_IPS) return
    for (const [k, arr] of this.loginFails) {
      const kept = arr.filter((t) => nowMs - t < LOGIN_WINDOW_MS)
      if (kept.length === 0) this.loginFails.delete(k)
      else this.loginFails.set(k, kept)
    }
    while (this.loginFails.size > MAX_TRACKED_IPS) {
      const firstKey = this.loginFails.keys().next().value
      if (!firstKey) break
      this.loginFails.delete(firstKey)
    }
  }

  isRateLimited(ip: string, nowMs = Date.now()): boolean {
    this.pruneBuckets(nowMs)
    if (this.globalFails.length >= LOGIN_MAX_FAILS_GLOBAL) return true
    const arr = (this.loginFails.get(ip) ?? []).filter((t) => nowMs - t < LOGIN_WINDOW_MS)
    if (arr.length === 0) this.loginFails.delete(ip)
    else this.loginFails.set(ip, arr)
    return arr.length >= LOGIN_MAX_FAILS_PER_IP
  }

  recordLoginFail(ip: string, nowMs = Date.now()): void {
    this.pruneBuckets(nowMs)
    this.globalFails.push(nowMs)
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
    const cand = hashPasswordSync(password, this.state.salt, keylen)
    return safeEqualHex(cand, this.state.hash)
  }

  async verifyPasswordAsync(password: string): Promise<{ ok: boolean; busy?: boolean }> {
    if (!password) return { ok: false }
    if (this.activeVerifies >= MAX_CONCURRENT_VERIFY) return { ok: false, busy: true }
    this.activeVerifies++
    try {
      const keylen = this.state.hash.length === 128 ? 64 : 32
      const cand = await hashPasswordAsync(password, this.state.salt, keylen)
      return { ok: safeEqualHex(cand, this.state.hash) }
    } finally {
      this.activeVerifies--
    }
  }

  changePassword(currentPassword: string, nextPassword: string): { ok: boolean; error?: string } {
    if (!this.verifyPassword(currentPassword)) return { ok: false, error: '当前密码不正确' }
    if (nextPassword.length < 8) return { ok: false, error: '新密码至少 8 位' }
    const salt = randomBytes(16).toString('hex')
    this.state = {
      salt,
      hash: hashPasswordSync(nextPassword, salt),
      secret: randomBytes(32).toString('hex'),
      updatedAt: new Date().toISOString(),
    }
    this.persist()
    const initPwdFile = join(dirname(this.filePath), 'admin-initial-password.txt')
    if (existsSync(initPwdFile)) {
      try { rmSync(initPwdFile, { force: true }) } catch { /* ignore */ }
    }
    return { ok: true }
  }

  async changePasswordAsync(currentPassword: string, nextPassword: string): Promise<{ ok: boolean; error?: string }> {
    const check = await this.verifyPasswordAsync(currentPassword)
    if (check.busy) return { ok: false, error: '系统繁忙，请稍后再试' }
    if (!check.ok) return { ok: false, error: '当前密码不正确' }
    if (nextPassword.length < 8) return { ok: false, error: '新密码至少 8 位' }
    const salt = randomBytes(16).toString('hex')
    const hash = await hashPasswordAsync(nextPassword, salt)
    this.state = {
      salt,
      hash,
      secret: randomBytes(32).toString('hex'),
      updatedAt: new Date().toISOString(),
    }
    this.persist()
    const initPwdFile = join(dirname(this.filePath), 'admin-initial-password.txt')
    if (existsSync(initPwdFile)) {
      try { rmSync(initPwdFile, { force: true }) } catch { /* ignore */ }
    }
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

// P2-AUTH-01：统一安全 Cookie 构造，确保登录 / 改密 / 登出共享一致的 Secure / HttpOnly / SameSite 属性
export function buildSessionCookie(token: string, isSecure: boolean): string {
  const secure = isSecure ? '; Secure' : ''
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}`
}

export function buildClearSessionCookie(isSecure: boolean): string {
  const secure = isSecure ? '; Secure' : ''
  return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`
}

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim())
  }
  return undefined
}
