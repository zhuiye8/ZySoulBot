// 探索类联网工具：web_search（支持 Responses API 内置搜索或 Streamable-HTTP MCP）与 SSRF 防护 web_fetch。
// 工具结果严格截断并附带 1 行 foldSummary，避免大段网页正文污染后续轮次 Token。
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { z } from 'zod'
import { resolveEnvValue } from '../shared/time.ts'
import type { InMemoryToolRegistry } from './registry.ts'

const MAX_WEB_FETCH_BYTES = 512 * 1024
const MAX_WEB_REDIRECTS = 3
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export type DnsLookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>

export interface WebSearchConfig {
  /** 优先使用 Streamable-HTTP MCP（如百炼 WebSearch / EnhancedSearch） */
  mcp?: {
    url: string
    apiKey?: string
    toolName?: string
  }
  /** 兜底走支持 web_search 工具的 Responses API 端点 */
  responses?: {
    baseUrl: string
    apiKey: string
    model: string
  }
  fetchImpl?: typeof fetch
  lookupImpl?: DnsLookupFn
  maxFetchBytes?: number
  timeoutMs?: number
}

const SearchArgsSchema = z.object({
  query: z.string().min(1).max(160),
})

const FetchArgsSchema = z.object({
  url: z.string().url().max(600),
})

function isPublicIpv4Parts(a: number, b: number, c: number, d: number): boolean {
  if ([a, b, c, d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false // CGNAT
  if (a === 169 && b === 254) return false // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
  if (a === 192 && b === 168) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  if (a >= 224) return false // multicast & reserved
  return true
}

function expandIpv6(raw: string): number[] | null {
  const ip = raw.toLowerCase().split('%')[0] ?? ''
  if (!ip) return null
  // 处理末尾内嵌 IPv4 形式，如 ::ffff:127.0.0.1
  let normalized = ip
  const lastColon = ip.lastIndexOf(':')
  if (lastColon >= 0 && ip.slice(lastColon + 1).includes('.')) {
    const v4 = ip.slice(lastColon + 1).split('.').map(Number)
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16)
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16)
    normalized = `${ip.slice(0, lastColon)}:${hi}:${lo}`
  }

  const halves = normalized.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : []
  if (halves.length === 1 && left.length !== 8) return null
  const missing = 8 - (left.length + right.length)
  if (missing < 0) return null
  const parts = halves.length === 2
    ? [...left, ...Array.from({ length: missing }, () => '0'), ...right]
    : left
  if (parts.length !== 8) return null
  const groups: number[] = []
  for (const p of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(p)) return null
    groups.push(Number.parseInt(p, 16))
  }
  return groups
}

export function isPublicIpAddress(rawIp: string): boolean {
  const clean = rawIp.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? ''
  const kind = isIP(clean)
  if (kind === 4) {
    const parts = clean.split('.').map(Number)
    return isPublicIpv4Parts(parts[0]!, parts[1]!, parts[2]!, parts[3]!)
  }
  if (kind === 6) {
    const g = expandIpv6(clean)
    if (!g) return false
    const allZero = g.every((x) => x === 0)
    if (allZero) return false // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false // ::1
    // IPv4-mapped (::ffff:0:0/96) 与 IPv4-compatible (::/96)
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
      const a = (g[6]! >> 8) & 0xff
      const b = g[6]! & 0xff
      const c = (g[7]! >> 8) & 0xff
      const d = g[7]! & 0xff
      return isPublicIpv4Parts(a, b, c, d)
    }
    // NAT64 well-known prefix 64:ff9b::/96
    if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
      return isPublicIpv4Parts((g[6]! >> 8) & 0xff, g[6]! & 0xff, (g[7]! >> 8) & 0xff, g[7]! & 0xff)
    }
    if ((g[0]! & 0xfe00) === 0xfc00) return false // fc00::/7 ULA
    if ((g[0]! & 0xffc0) === 0xfe80) return false // fe80::/10 link-local
    if ((g[0]! & 0xff00) === 0xff00) return false // ff00::/8 multicast
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false // 100::/64 discard
    if (g[0] === 0x2001 && g[1] === 0x0db8) return false // documentation
    return true
  }
  return false
}

// SSRF 防护（P0-SEC-02）：规范化末尾点，拦截本机/内网域名、IPv4、IPv6 及 IPv4-mapped IPv6
export function isSafePublicUrl(rawUrl: string): boolean {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  if (!host) return false
  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
  ) {
    return false
  }
  if (isIP(host)) return isPublicIpAddress(host)
  return true
}

async function readStreamBounded(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; overflowed: boolean }> {
  if (!res.body) {
    const txt = await res.text()
    const bytes = Buffer.byteLength(txt, 'utf8')
    if (bytes > maxBytes) {
      return { text: Buffer.from(txt, 'utf8').subarray(0, maxBytes).toString('utf8'), overflowed: true }
    }
    return { text: txt, overflowed: false }
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let overflowed = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      if (total + value.byteLength > maxBytes) {
        const remain = Math.max(0, maxBytes - total)
        if (remain > 0) chunks.push(value.subarray(0, remain))
        overflowed = true
        await reader.cancel().catch(() => {})
        break
      }
      chunks.push(value)
      total += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  return { text: Buffer.concat(chunks).toString('utf8'), overflowed }
}

async function resolveAndVerifyHost(
  hostname: string,
  lookupImpl: DnsLookupFn,
): Promise<{ address: string; family: number } | null> {
  const clean = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  const ipKind = isIP(clean)
  if (ipKind) {
    return isPublicIpAddress(clean) ? { address: clean, family: ipKind } : null
  }
  const records = await lookupImpl(clean)
  if (!records.length) return null
  for (const r of records) {
    if (!isPublicIpAddress(r.address)) return null
  }
  return records[0]!
}

// 绑定已验证 IP 发起单跳 HTTP/HTTPS 请求：阻断 DNS 重绑定、返回 location 由上层逐跳重验、强制流式字节预算
async function pinnedPublicHttpGet(
  rawUrl: string,
  pinned: { address: string; family: number },
  maxBytes: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ status: number; contentType: string; location: string | null; text: string; overflowed: boolean }> {
  const u = new URL(rawUrl)
  const isHttps = u.protocol === 'https:'
  const reqFn = isHttps ? httpsRequest : httpRequest
  const port = u.port ? Number(u.port) : (isHttps ? 443 : 80)

  return new Promise((resolveReq, rejectReq) => {
    const req = reqFn(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: {
          Host: u.host,
          'User-Agent': 'ZySoulBot/0.1 (companion reader)',
        },
        // 将实际 TCP 连接绑定到已校验通过的公网 IP，防止 TOCTOU DNS 重绑定
        lookup: (_host, _opts, cb) => {
          cb(null, pinned.address, pinned.family)
        },
        ...(isHttps ? { servername: u.hostname.replace(/^\[|\]$/g, '') } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0
        const contentType = String(res.headers['content-type'] ?? '')
        const location = typeof res.headers.location === 'string' ? res.headers.location : null
        if (REDIRECT_STATUSES.has(status)) {
          res.resume()
          resolveReq({ status, contentType, location, text: '', overflowed: false })
          return
        }
        const chunks: Buffer[] = []
        let total = 0
        let overflowed = false
        res.on('data', (chunk: Buffer) => {
          if (overflowed) return
          if (total + chunk.length > maxBytes) {
            const remain = Math.max(0, maxBytes - total)
            if (remain > 0) chunks.push(chunk.subarray(0, remain))
            overflowed = true
            res.destroy()
            resolveReq({
              status,
              contentType,
              location: null,
              text: Buffer.concat(chunks).toString('utf8'),
              overflowed: true,
            })
            return
          }
          chunks.push(chunk)
          total += chunk.length
        })
        res.on('end', () => {
          if (!overflowed) {
            resolveReq({
              status,
              contentType,
              location: null,
              text: Buffer.concat(chunks).toString('utf8'),
              overflowed: false,
            })
          }
        })
        res.on('error', (err) => {
          if (!overflowed) rejectReq(err)
        })
      },
    )

    const onAbort = (): void => {
      req.destroy(new Error('Request aborted'))
    }
    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Request timeout'))
    })
    req.on('error', (err) => rejectReq(err))
    req.end()
  })
}

export function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

// 极简 Streamable-HTTP MCP Client（零依赖）：一次 JSON-RPC tools/call 请求
async function callStreamableMcp(
  cfg: NonNullable<WebSearchConfig['mcp']>,
  query: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const key = cfg.apiKey ? resolveEnvValue(cfg.apiKey) : ''
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  const res = await fetchImpl(cfg.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: cfg.toolName || 'bailian_web_search',
        arguments: { query },
      },
    }),
    signal: combined,
  })
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}`)
  const raw = await res.text()
  // Streamable-HTTP 可能返回纯 JSON 或 SSE（data: {...}）
  const jsonLine = raw.trim().startsWith('{')
    ? raw.trim()
    : raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).find((l) => l.startsWith('{')) ?? ''
  if (!jsonLine) throw new Error('MCP empty response')
  const parsed = JSON.parse(jsonLine) as {
    result?: { content?: Array<{ type?: string; text?: string }> }
    error?: { message?: string }
  }
  if (parsed.error) throw new Error(parsed.error.message || 'MCP error')
  const texts = (parsed.result?.content ?? []).map((c) => c.text ?? '').filter(Boolean)
  return texts.join('\n').trim()
}

async function callResponsesSearch(
  cfg: NonNullable<WebSearchConfig['responses']>,
  query: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const base = cfg.baseUrl.replace(/\/+$/, '')
  const key = resolveEnvValue(cfg.apiKey)
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  const res = await fetchImpl(`${base}/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: cfg.model,
      instructions: '只用简洁中文总结搜索到的最新客观事实，不带客套话，控制在 400 字以内。',
      input: query,
      tools: [{ type: 'web_search' }],
      reasoning: { effort: 'low' },
    }),
    signal: combined,
  })
  if (!res.ok) throw new Error(`Responses search HTTP ${res.status}`)
  const data = (await res.json()) as {
    output?: Array<{ type?: string; content?: Array<{ text?: string }> }>
  }
  const parts: string[] = []
  for (const item of data.output ?? []) {
    if (item.type !== 'message') continue
    for (const c of item.content ?? []) {
      if (c.text) parts.push(c.text)
    }
  }
  return parts.join('\n').trim()
}

export function registerWebTools(registry: InMemoryToolRegistry, cfg: WebSearchConfig = {}): void {
  const fetchImpl = cfg.fetchImpl ?? globalThis.fetch
  const lookupImpl: DnsLookupFn = cfg.lookupImpl
    ?? (async (hostname: string) => {
      const res = await dnsLookup(hostname, { all: true, verbatim: true })
      return res.map((r) => ({ address: r.address, family: r.family }))
    })
  const maxFetchBytes = cfg.maxFetchBytes ?? MAX_WEB_FETCH_BYTES
  const timeoutMs = cfg.timeoutMs ?? 20_000

  if (cfg.mcp || cfg.responses) {
    registry.register({
      layer: 'explore',
      spec: {
        name: 'web_search',
        description: '上网搜索实时信息（天气、新闻、百科、不认识的新词或梗）。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
          },
          required: ['query'],
        },
      },
      async execute(args, ctx) {
        const { query } = SearchArgsSchema.parse(args)
        let text = ''
        if (cfg.mcp) {
          try {
            text = await callStreamableMcp(cfg.mcp, query, fetchImpl, timeoutMs, ctx.signal)
          } catch (e) {
            if (!cfg.responses) throw e
          }
        }
        if (!text && cfg.responses) {
          text = await callResponsesSearch(cfg.responses, query, fetchImpl, timeoutMs, ctx.signal)
        }
        if (!text) {
          return { output: `搜索「${query}」没有拿到结果。`, foldSummary: `搜了「${query}」：无结果` }
        }
        const clipped = text.slice(0, 2200)
        const brief = clipped.replace(/\s+/g, ' ').slice(0, 60)
        return {
          output: clipped,
          foldSummary: `搜了「${query}」：${brief}`,
        }
      },
    })
  }

  registry.register({
    layer: 'explore',
    spec: {
      name: 'web_fetch',
      description: '读取一个公开网页的正文内容（例如对方发来的链接）。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '以 http:// 或 https:// 开头的公开网址' },
        },
        required: ['url'],
      },
    },
    async execute(args, ctx) {
      const { url } = FetchArgsSchema.parse(args)
      let currentUrl = url
      let ctype = ''
      let raw = ''

      // 安全多跳重定向（最多 3 跳）：每一跳都重新校验公网 URL + DNS 解析 + IP 绑定，既支持短链/HTTPS 跳转又杜绝 302 打穿内网
      for (let hop = 0; hop <= MAX_WEB_REDIRECTS; hop++) {
        if (!isSafePublicUrl(currentUrl)) {
          return { output: '不能访问内网或非公开网址。', isError: true }
        }
        const parsedUrl = new URL(currentUrl)

        if (cfg.fetchImpl) {
          if (cfg.lookupImpl) {
            const pinned = await resolveAndVerifyHost(parsedUrl.hostname, cfg.lookupImpl)
            if (!pinned) return { output: '域名解析指向内网或非公开地址，已被拦截。', isError: true }
          }
          const timeout = AbortSignal.timeout(timeoutMs)
          const combined = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout
          let res: Response
          try {
            res = await cfg.fetchImpl(currentUrl, {
              headers: { 'User-Agent': 'ZySoulBot/0.1 (companion reader)' },
              redirect: 'manual',
              signal: combined,
            })
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return { output: `网页请求被拒绝或失败：${msg.slice(0, 120)}`, isError: true }
          }
          if (REDIRECT_STATUSES.has(res.status)) {
            const loc = res.headers.get('location')
            if (!loc || hop >= MAX_WEB_REDIRECTS) {
              return { output: '网页重定向次数过多或目标无效。', isError: true }
            }
            try {
              currentUrl = new URL(loc, currentUrl).toString()
            } catch {
              return { output: '网页重定向地址格式无效。', isError: true }
            }
            continue
          }
          if (!res.ok) {
            return { output: `网页打开失败（HTTP ${res.status}）。`, isError: true }
          }
          ctype = res.headers.get('content-type') ?? ''
          const bounded = await readStreamBounded(res, maxFetchBytes)
          raw = bounded.text
          break
        } else {
          const pinned = await resolveAndVerifyHost(parsedUrl.hostname, lookupImpl)
          if (!pinned) {
            return { output: '域名解析指向内网或非公开地址，已被拦截。', isError: true }
          }
          let fetched: { status: number; contentType: string; location: string | null; text: string; overflowed: boolean }
          try {
            fetched = await pinnedPublicHttpGet(currentUrl, pinned, maxFetchBytes, timeoutMs, ctx.signal)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return { output: `网页打开失败：${msg.slice(0, 120)}`, isError: true }
          }
          if (REDIRECT_STATUSES.has(fetched.status)) {
            if (!fetched.location || hop >= MAX_WEB_REDIRECTS) {
              return { output: '网页重定向次数过多或目标无效。', isError: true }
            }
            try {
              currentUrl = new URL(fetched.location, currentUrl).toString()
            } catch {
              return { output: '网页重定向地址格式无效。', isError: true }
            }
            continue
          }
          if (fetched.status < 200 || fetched.status >= 300) {
            return { output: `网页打开失败（HTTP ${fetched.status}）。`, isError: true }
          }
          ctype = fetched.contentType
          raw = fetched.text
          break
        }
      }

      const finalHost = new URL(currentUrl).hostname
      const readable = ctype.includes('html') ? stripHtmlToText(raw) : raw.trim()
      const clipped = readable.slice(0, 2200)
      return {
        output: clipped || '页面没有可读正文。',
        foldSummary: `读了网页 ${finalHost}：${clipped.slice(0, 50)}`,
      }
    },
  })
}
