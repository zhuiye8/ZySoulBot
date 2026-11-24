// 语音识别（ASR）适配器：将用户发来的 QQ 语音条转为文字（OpenAI/Whisper 兼容 multipart 协议）。
import { classifyHttp, SoulError } from '../shared/errors.ts'
import { resolveEnvValue } from '../shared/time.ts'
import type { AsrPort } from '../shared/ports.ts'

export interface AsrOptions {
  baseUrl: string
  apiKey: string
  model?: string
  language?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export function createAsrAdapter(opts: AsrOptions): AsrPort {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const key = resolveEnvValue(opts.apiKey)
  const model = opts.model ?? 'whisper-1'
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const timeoutMs = opts.timeoutMs ?? 25_000

  return {
    id: 'openai-asr',
    async transcribe(req): Promise<string> {
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
