// 原生 OpenAI 兼容 ChatModel 适配器（零重型 SDK）：支持 tools、reasoning_effort、视觉图片与 cached_tokens 精确统计。
import { classifyHttp, parseRetryAfter, SoulError } from '../shared/errors.ts'
import { resolveEnvValue } from '../shared/time.ts'
import type {
  ChatMessage,
  ChatModel,
  ChatRequest,
  ChatResponse,
  FinishReason,
  ToolCall,
  TokenUsage,
} from '../shared/ports.ts'

export interface OpenAIChatOptions {
  id?: string
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs?: number
  maxRetries?: number
  fetchImpl?: typeof fetch
}

function serializeMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content }
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: m.content || null,
      ...(m.reasoningContent !== undefined ? { reasoning_content: m.reasoningContent } : {}),
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    }
  }
  if (m.role === 'user' && m.images && m.images.length > 0) {
    return {
      role: 'user',
      content: [
        { type: 'text', text: m.content },
        ...m.images.map((im) => ({
          type: 'image_url',
          image_url: { url: `data:${im.mimeType};base64,${im.data}` },
        })),
      ],
    }
  }
  return { role: m.role, content: m.content }
}

function parseUsage(raw: unknown): TokenUsage {
  const u = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const pDetails = (u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object'
    ? u.prompt_tokens_details
    : {}) as Record<string, unknown>
  const cDetails = (u.completion_tokens_details && typeof u.completion_tokens_details === 'object'
    ? u.completion_tokens_details
    : {}) as Record<string, unknown>
  const inputTokens = Number(u.prompt_tokens ?? u.input_tokens ?? 0)
  const outputTokens = Number(u.completion_tokens ?? u.output_tokens ?? 0)
  return {
    inputTokens,
    cachedTokens: Number(pDetails.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0),
    outputTokens,
    reasoningTokens: Number(cDetails.reasoning_tokens ?? 0),
    totalTokens: Number(u.total_tokens ?? inputTokens + outputTokens),
  }
}

function mapFinishReason(raw: unknown): FinishReason {
  const s = String(raw ?? 'stop')
  if (s === 'tool_calls') return 'tool_calls'
  if (s === 'length') return 'length'
  if (s === 'content_filter') return 'content_filter'
  return 'stop'
}

export function createOpenAIChatModel(opts: OpenAIChatOptions): ChatModel {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const apiKey = resolveEnvValue(opts.apiKey)
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const timeoutMs = opts.timeoutMs ?? 60_000
  const maxRetries = opts.maxRetries ?? 2

  return {
    id: opts.id ?? 'openai-chat',
    model: opts.model,
    async complete(req: ChatRequest): Promise<ChatResponse> {
      const payload: Record<string, unknown> = {
        model: opts.model,
        messages: req.messages.map(serializeMessage),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        // 不传 maxTokens 时不发 max_tokens，避免推理模型思考吃光正文导致静默截断
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
        ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
      }
      if (req.tools && req.tools.length > 0) {
        payload.tools = req.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }))
        payload.tool_choice = req.toolChoice ?? 'auto'
      }

      let lastErr: unknown
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const timeout = AbortSignal.timeout(timeoutMs)
        const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout
        try {
          const res = await fetchImpl(`${base}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(payload),
            signal,
          })
          if (!res.ok) {
            const body = await res.text().catch(() => '')
            const kind = classifyHttp(res.status, body)
            const err = new SoulError(kind, `LLM HTTP ${res.status}: ${body.slice(0, 200)}`, parseRetryAfter(res.headers))
            if ((kind === 'ratelimit' || kind === 'unavailable') && attempt < maxRetries) {
              await new Promise((r) => setTimeout(r, err.retryAfterMs ?? 500 * (attempt + 1)))
              lastErr = err
              continue
            }
            throw err
          }

          const data = (await res.json()) as {
            model?: string
            choices?: Array<{
              finish_reason?: string
              message?: {
                content?: string | null
                reasoning_content?: string | null
                tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
              }
            }>
            usage?: unknown
          }
          const choice = data.choices?.[0]
          if (!choice?.message) {
            throw new SoulError('protocol', 'LLM response missing choices[0].message')
          }
          const finishReason = mapFinishReason(choice.finish_reason)
          const content = String(choice.message.content ?? '')
          const toolCalls: ToolCall[] = (choice.message.tool_calls ?? [])
            .filter((tc) => Boolean(tc?.function?.name))
            .map((tc, i) => ({
              id: String(tc.id || `call_${i}`),
              name: String(tc.function!.name),
              arguments: String(tc.function?.arguments ?? '{}'),
            }))

          // 截断时若正文为空且无工具调用，显式报错（杜绝静默空回复）
          if (finishReason === 'length' && !content.trim() && toolCalls.length === 0) {
            throw new SoulError('protocol', 'LLM truncated with empty content (finish_reason=length)')
          }

          return {
            content,
            toolCalls,
            finishReason,
            usage: parseUsage(data.usage),
            model: String(data.model || opts.model),
            ...(typeof choice.message.reasoning_content === 'string'
              ? { reasoningContent: choice.message.reasoning_content }
              : {}),
          }
        } catch (e) {
          if (e instanceof SoulError) throw e
          const name = (e as Error)?.name
          if (name === 'AbortError' || name === 'TimeoutError') {
            throw new SoulError('timeout', 'LLM request timed out or aborted')
          }
          lastErr = new SoulError('unavailable', `LLM fetch failed: ${(e as Error)?.message ?? String(e)}`)
          if (attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
            continue
          }
          throw lastErr
        }
      }
      throw lastErr
    },
  }
}
