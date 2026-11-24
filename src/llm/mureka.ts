// Mureka 异步唱歌适配器（实现 SingingPort）：
// - POST /v1/song/generate  提交填词/风格/声线生成任务（立即返回 taskId，绝不阻塞聊天）
// - GET  /v1/song/query/{id} 轮询生成状态，拿到音频 URL
// - POST /v1/song/vocal-clone 独立工具函数：上传 15-30s 干声获取 vocal_id
import { z } from 'zod'
import { classifyHttp, parseRetryAfter, SoulError } from '../shared/errors.ts'
import { resolveEnvValue } from '../shared/time.ts'
import type { SingingCreateReq, SingingPollResult, SingingPort } from '../shared/ports.ts'

const DEFAULT_TIMEOUT_MS = 30_000

export interface MurekaOptions {
  apiKey: string
  baseUrl?: string
  model?: string
  vocalId?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

const GenerateResponseSchema = z.object({
  id: z.string().min(1),
})

const QueryResponseSchema = z.object({
  id: z.string().optional(),
  status: z.string(),
  failed_reason: z.string().nullable().optional(),
  choices: z.array(z.object({
    url: z.string().url().optional(),
    flac_url: z.string().url().optional(),
    duration: z.number().optional(),
  })).optional(),
})

const VocalCloneResponseSchema = z.object({
  vocal_id: z.string().min(1),
})

function mapMurekaStatus(raw: string): SingingPollResult['status'] {
  switch (raw.toLowerCase()) {
    case 'preparing':
    case 'queued':
      return 'pending'
    case 'running':
    case 'streaming':
      return 'processing'
    case 'succeeded':
      return 'succeeded'
    default:
      return 'failed'
  }
}

export function createMurekaAdapter(opts: MurekaOptions): SingingPort {
  const base = (opts.baseUrl ?? 'https://api.mureka.cn').replace(/\/+$/, '')
  const apiKey = resolveEnvValue(opts.apiKey)
  const defaultModel = opts.model ?? 'auto'
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    id: 'mureka',

    async createSong(req: SingingCreateReq): Promise<{ taskId: string }> {
      const lyrics = req.lyrics.trim()
      if (!lyrics) throw new SoulError('protocol', 'mureka lyrics empty')
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout

      const payload: Record<string, unknown> = {
        lyrics,
        model: defaultModel,
        prompt: req.style?.trim() || 'gentle acoustic folk, soft luminous melody, clear female vocal',
      }
      const vocalId = req.vocalId ?? opts.vocalId
      if (vocalId) payload.vocal_id = vocalId

      let res: Response
      try {
        res = await fetchImpl(`${base}/v1/song/generate`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal,
        })
      } catch (e) {
        const name = (e as Error).name
        if (name === 'AbortError' || name === 'TimeoutError') throw new SoulError('timeout', 'mureka createSong timeout')
        throw new SoulError('unavailable', `mureka createSong failed: ${(e as Error).message}`)
      }

      const raw = await res.text().catch(() => '')
      if (!res.ok) {
        throw new SoulError(
          classifyHttp(res.status, raw),
          `mureka createSong HTTP ${res.status}: ${raw.slice(0, 180)}`,
          parseRetryAfter(res.headers),
        )
      }

      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(raw)
      } catch {
        throw new SoulError('protocol', 'mureka createSong returned invalid JSON')
      }
      const parsed = GenerateResponseSchema.safeParse(parsedJson)
      if (!parsed.success) throw new SoulError('protocol', 'mureka createSong missing task id')
      return { taskId: parsed.data.id }
    },

    async pollSong(taskId: string, callerSignal?: AbortSignal): Promise<SingingPollResult> {
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout

      let res: Response
      try {
        res = await fetchImpl(`${base}/v1/song/query/${encodeURIComponent(taskId)}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
          signal,
        })
      } catch (e) {
        const name = (e as Error).name
        if (name === 'AbortError' || name === 'TimeoutError') throw new SoulError('timeout', 'mureka pollSong timeout')
        throw new SoulError('unavailable', `mureka pollSong failed: ${(e as Error).message}`)
      }

      const raw = await res.text().catch(() => '')
      if (!res.ok) {
        throw new SoulError(
          classifyHttp(res.status, raw),
          `mureka pollSong HTTP ${res.status}: ${raw.slice(0, 180)}`,
          parseRetryAfter(res.headers),
        )
      }

      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(raw)
      } catch {
        throw new SoulError('protocol', 'mureka pollSong returned invalid JSON')
      }
      const parsed = QueryResponseSchema.safeParse(parsedJson)
      if (!parsed.success) throw new SoulError('protocol', 'mureka pollSong schema mismatch')

      const status = mapMurekaStatus(parsed.data.status)
      if (status === 'succeeded') {
        const choice = parsed.data.choices?.find((c) => c.url || c.flac_url)
        if (!choice?.url && !choice?.flac_url) {
          return { status: 'failed', error: 'mureka succeeded without audio url' }
        }
        return {
          status: 'succeeded',
          audioUrl: choice.url ?? choice.flac_url,
          durationSec: choice.duration ? Math.round(choice.duration / (choice.duration > 1000 ? 1000 : 1)) : undefined,
        }
      }
      if (status === 'failed') {
        return { status: 'failed', error: parsed.data.failed_reason ?? `status=${parsed.data.status}` }
      }
      return { status }
    },
  }
}

export async function cloneMurekaVocal(opts: {
  apiKey: string
  baseUrl?: string
  audioBytes: Uint8Array
  filename: string
  mimeType?: string
  description?: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}): Promise<{ vocalId: string }> {
  const base = (opts.baseUrl ?? 'https://api.mureka.cn').replace(/\/+$/, '')
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const form = new FormData()
  const copy = new Uint8Array(opts.audioBytes)
  const blob = new Blob([copy], { type: opts.mimeType ?? 'audio/mpeg' })
  form.append('file', blob, opts.filename)
  if (opts.description) form.append('description', opts.description)

  let res: Response
  try {
    res = await fetchImpl(`${base}/v1/song/vocal-clone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      body: form,
      signal: opts.signal ?? AbortSignal.timeout(60_000),
    })
  } catch (e) {
    throw new SoulError('unavailable', `mureka vocal-clone failed: ${(e as Error).message}`)
  }

  const raw = await res.text().catch(() => '')
  if (!res.ok) throw new SoulError(classifyHttp(res.status, raw), `mureka vocal-clone HTTP ${res.status}: ${raw.slice(0, 160)}`)
  const parsed = VocalCloneResponseSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) throw new SoulError('protocol', 'mureka vocal-clone missing vocal_id')
  return { vocalId: parsed.data.vocal_id }
}
