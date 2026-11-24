// 探索类联网工具：web_search（支持 Responses API 内置搜索或 Streamable-HTTP MCP）与 SSRF 防护 web_fetch。
// 工具结果严格截断并附带 1 行 foldSummary，避免大段网页正文污染后续轮次 Token。
import { z } from 'zod'
import { resolveEnvValue } from '../shared/time.ts'
import type { InMemoryToolRegistry } from './registry.ts'

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
  timeoutMs?: number
}

const SearchArgsSchema = z.object({
  query: z.string().min(1).max(160),
})

const FetchArgsSchema = z.object({
  url: z.string().url().max(600),
})

// SSRF 防护：拦截内网地址、回环地址与云元数据地址
export function isSafePublicUrl(rawUrl: string): boolean {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return false
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (a === 127 || a === 10 || a === 0) return false
    if (a === 169 && b === 254) return false
    if (a === 192 && b === 168) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 100 && b >= 64 && b <= 127) return false
  }
  return true
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
      if (!isSafePublicUrl(url)) {
        return { output: '不能访问内网或非公开网址。', isError: true }
      }
      const timeout = AbortSignal.timeout(timeoutMs)
      const combined = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': 'zySoulbot/0.1 (companion reader)' },
        redirect: 'follow',
        signal: combined,
      })
      if (!res.ok) {
        return { output: `网页打开失败（HTTP ${res.status}）。`, isError: true }
      }
      const ctype = res.headers.get('content-type') ?? ''
      const raw = await res.text()
      const readable = ctype.includes('html') ? stripHtmlToText(raw) : raw.trim()
      const clipped = readable.slice(0, 2200)
      return {
        output: clipped || '页面没有可读正文。',
        foldSummary: `读了网页 ${new URL(url).hostname}：${clipped.slice(0, 50)}`,
      }
    },
  })
}
