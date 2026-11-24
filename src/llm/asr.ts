// 语音识别（ASR）适配器：将用户发来的 QQ 语音条转为文字，支持 MiniMax (/v1/speech_to_text) 与 OpenAI/Whisper 兼容协议。
import { classifyHttp, SoulError } from '../shared/errors.ts'
import { resolveEnvValue } from '../shared/time.ts'
import type { AsrPort } from '../shared/ports.ts'

export interface AsrOptions {
  provider?: 'openai' | 'minimax'
  baseUrl?: string
  apiKey: string
  model?: string
  language?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

function createMiniMaxAsr(opts: AsrOptions): AsrPort {
  const base = (opts.baseUrl || 'https://api.minimax.cn').replace(/\/+$/, '')
  const key = resolveEnvValue(opts.apiKey)
  const model = opts.model || 'asr-1.0'
  const language = opts.language || 'zh'
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const timeoutMs = opts.timeoutMs ?? 60_000

  return {
    id: 'minimax-asr',
    async transcribe(req): Promise<string> {
      if (!key) throw new SoulError('auth', 'minimax asr api key missing')
      const form = new FormData()
      form.append('model', model)
      const blob = new Blob([new Uint8Array(req.audio)], { type: req.mimeType ?? 'audio/mpeg' })
      form.append('file', blob, req.filename ?? 'voice.mp3')

      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout
      const res = await fetchImpl(`${base}/v1/speech_to_text`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          language,
        },
        body: form,
        signal,
      })
      const raw = await res.text().catch(() => '')
      if (!res.ok) {
        throw new SoulError(classifyHttp(res.status, raw), `MiniMax ASR HTTP ${res.status}: ${raw.slice(0, 160)}`)
      }
      const data = JSON.parse(raw) as { text?: string; base_resp?: { status_code?: number; status_msg?: string } }
      const code = data?.base_resp?.status_code
      if (code && code !== 0) {
        throw new SoulError('protocol', `MiniMax ASR code ${code}: ${String(data?.base_resp?.status_msg ?? '').slice(0, 120)}`)
      }
      return String(data?.text ?? '').trim()
    },
  }
}

export function createAsrAdapter(opts: AsrOptions): AsrPort {
  if (opts.provider === 'minimax') return createMiniMaxAsr(opts)

  const base = (opts.baseUrl ?? '').replace(/\/+$/, '')
  const key = resolveEnvValue(opts.apiKey)
  const model = opts.model ?? 'whisper-1'
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const timeoutMs = opts.timeoutMs ?? 25_000

  return {
    id: 'openai-asr',
    async transcribe(req): Promise<string> {
      if (!key) throw new SoulError('auth', 'openai asr api key missing')
      const form = new FormData()
      const blob = new Blob([new Uint8Array(req.audio)], { type: req.mimeType ?? 'audio/mpeg' })
      form.append('file', blob, req.filename ?? 'voice.mp3')
      form.append('model', model)
      if (opts.language) form.append('language', opts.language)

      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout
      const res = await fetchImpl(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal,
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new SoulError(classifyHttp(res.status, body), `ASR HTTP ${res.status}: ${body.slice(0, 160)}`)
      }
      const data = (await res.json()) as { text?: string }
      return String(data.text ?? '').trim()
    },
  }
}
