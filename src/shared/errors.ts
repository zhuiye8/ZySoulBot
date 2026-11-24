// 统一错误分类：领域核心只看错误类别，不看底层 HTTP/供应商细节。
export type ErrorKind = 'timeout' | 'unavailable' | 'ratelimit' | 'auth' | 'content_filter' | 'protocol'

export const ERROR_KINDS: readonly ErrorKind[] = Object.freeze([
  'timeout', 'unavailable', 'ratelimit', 'auth', 'content_filter', 'protocol',
])

export class SoulError extends Error {
  kind: ErrorKind
  retryAfterMs?: number

  constructor(kind: ErrorKind, message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'SoulError'
    this.kind = kind
    this.retryAfterMs = retryAfterMs
  }
}

export function classifyHttp(status: number, body = ''): ErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'ratelimit'
  if (status === 408 || status === 504) return 'timeout'
  if (status === 400 && /content[_\s-]?filter|inappropriate|safety|sensitive/i.test(body)) return 'content_filter'
  if (status >= 500) return 'unavailable'
  return 'protocol'
}

export function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get('retry-after')
  if (!raw) return undefined
  const sec = Number(raw)
  if (Number.isFinite(sec) && sec > 0) return Math.min(60_000, Math.round(sec * 1000))
  const at = Date.parse(raw)
  if (Number.isFinite(at)) {
    const ms = at - Date.now()
    if (ms > 0) return Math.min(60_000, ms)
  }
  return undefined
}
