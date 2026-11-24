// 统一语音合成适配器（实现 TtsPort）：支持火山豆包 ICL 2.0（SSE 流）、OpenAI 兼容 /audio/speech 与自托管 HTTP。
import { randomUUID } from 'node:crypto'
import { classifyHttp, SoulError } from '../shared/errors.ts'
import type { BotConfig } from '../shared/config.ts'
import type { TtsPort } from '../shared/ports.ts'

const DEFAULT_TIMEOUT_MS = 90_000
const MAX_TTS_TEXT = 400

export type TtsConfig = NonNullable<BotConfig['tts']>

export interface TtsAdapterDeps {
  fetchImpl?: typeof fetch
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.byteLength
  }
  return out
}

function createVolcTts(cfg: Extract<TtsConfig, { provider: 'volc' }>, fetchImpl: typeof fetch): TtsPort {
  const base = cfg.baseUrl.replace(/\/+$/, '')
  return {
    id: 'volc',
    async synth({ text, signal }) {
      const body = text.trim().slice(0, MAX_TTS_TEXT)
      if (!body) throw new SoulError('protocol', 'tts text empty')
      const timeout = AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

      let res: Response
      try {
        res = await fetchImpl(`${base}/api/v3/tts/unidirectional/sse`, {
          method: 'POST',
          headers: {
            'X-Api-Key': cfg.apiKey,
            'X-Api-Resource-Id': cfg.resourceId,
            'X-Api-Request-Id': randomUUID(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            user: { uid: 'zysoulbot' },
            req_params: {
              text: body,
              speaker: cfg.speaker,
              audio_params: {
                format: cfg.format,
                sample_rate: cfg.sampleRate,
                speech_rate: Math.max(-50, Math.min(100, cfg.speechRate)),
              },
              ...(cfg.contextTexts?.length ? { context_texts: cfg.contextTexts } : {}),
            },
          }),
          signal: combined,
        })
      } catch (e) {
        const name = (e as Error).name
        if (name === 'AbortError' || name === 'TimeoutError') throw new SoulError('timeout', 'volc tts timeout')
        throw new SoulError('unavailable', `volc tts fetch failed: ${(e as Error).message}`)
      }

      const raw = await res.text().catch(() => '')
      if (!res.ok) throw new SoulError(classifyHttp(res.status, raw), `volc tts HTTP ${res.status}: ${raw.slice(0, 160)}`)

      const parts: Uint8Array[] = []
      for (const line of raw.split('\n')) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        let obj: { code?: number; message?: string; data?: string }
        try {
          obj = JSON.parse(t.slice(5).trim()) as { code?: number; message?: string; data?: string }
        } catch {
          continue
        }
        const code = obj.code ?? 0
        if (code !== 0 && code !== 20000000) {
          throw new SoulError('protocol', `volc tts code ${code}: ${String(obj.message ?? '').slice(0, 120)}`)
        }
        if (obj.data) parts.push(new Uint8Array(Buffer.from(obj.data, 'base64')))
      }
      if (parts.length === 0) throw new SoulError('protocol', 'volc tts returned no audio')
      return {
        bytes: concatBytes(parts),
        mimeType: cfg.format === 'wav' ? 'audio/wav' : 'audio/mpeg',
      }
    },
  }
}

function createOpenAiTts(cfg: Extract<TtsConfig, { provider: 'openai' }>, fetchImpl: typeof fetch): TtsPort {
  const base = cfg.baseUrl.replace(/\/+$/, '')
  return {
    id: 'openai-tts',
    async synth({ text, signal }) {
      const body = text.trim().slice(0, MAX_TTS_TEXT)
      if (!body) throw new SoulError('protocol', 'tts text empty')
      const timeout = AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

      let res: Response
      try {
        res = await fetchImpl(`${base}/audio/speech`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfg.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: cfg.model,
            voice: cfg.voice,
            input: body,
            response_format: cfg.format,
            speed: cfg.speed,
          }),
          signal: combined,
        })
      } catch (e) {
        const name = (e as Error).name
        if (name === 'AbortError' || name === 'TimeoutError') throw new SoulError('timeout', 'openai tts timeout')
        throw new SoulError('unavailable', `openai tts fetch failed: ${(e as Error).message}`)
      }

      if (!res.ok) {
        const raw = await res.text().catch(() => '')
        throw new SoulError(classifyHttp(res.status, raw), `openai tts HTTP ${res.status}: ${raw.slice(0, 160)}`)
      }
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (bytes.byteLength === 0) throw new SoulError('protocol', 'openai tts returned empty audio')
      const mimeType = cfg.format === 'wav' ? 'audio/wav' : cfg.format === 'opus' ? 'audio/ogg' : 'audio/mpeg'
      return { bytes, mimeType }
    },
  }
}

function createLocalTts(cfg: Extract<TtsConfig, { provider: 'local' }>, fetchImpl: typeof fetch): TtsPort {
  const base = cfg.baseUrl.replace(/\/+$/, '')
  return {
    id: 'local-tts',
    async synth({ text, signal }) {
      const body = text.trim().slice(0, MAX_TTS_TEXT)
      if (!body) throw new SoulError('protocol', 'tts text empty')
      const timeout = AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
      let url = `${base}${cfg.path}`
      let init: RequestInit = { method: cfg.method, signal: combined }
      if (cfg.method === 'GET') {
        const q = new URLSearchParams({ text: body, ...(cfg.query ?? {}) })
        url += `?${q.toString()}`
      } else {
        init = {
          ...init,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: body, ...(cfg.query ?? {}) }),
        }
      }

      let res: Response
      try {
        res = await fetchImpl(url, init)
      } catch (e) {
        const name = (e as Error).name
        if (name === 'AbortError' || name === 'TimeoutError') throw new SoulError('timeout', 'local tts timeout')
        throw new SoulError('unavailable', `local tts fetch failed: ${(e as Error).message}`)
      }
      if (!res.ok) throw new SoulError(classifyHttp(res.status), `local tts HTTP ${res.status}`)

      const ct = (res.headers.get('content-type') ?? '').toLowerCase()
      if (ct.includes('json')) {
        const j = await res.json().catch(() => null) as { audio?: string; mime?: string } | null
        if (!j?.audio) throw new SoulError('protocol', 'local tts json missing audio')
        return { bytes: new Uint8Array(Buffer.from(j.audio, 'base64')), mimeType: j.mime ?? 'audio/wav' }
      }
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (bytes.byteLength === 0) throw new SoulError('protocol', 'local tts returned empty audio')
      return { bytes, mimeType: ct.includes('mpeg') || ct.includes('mp3') ? 'audio/mpeg' : 'audio/wav' }
    },
  }
}

export function createTtsAdapter(cfg: TtsConfig, deps: TtsAdapterDeps = {}): TtsPort {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  if (cfg.provider === 'volc') return createVolcTts(cfg, fetchImpl)
  if (cfg.provider === 'openai') return createOpenAiTts(cfg, fetchImpl)
  return createLocalTts(cfg, fetchImpl)
}
