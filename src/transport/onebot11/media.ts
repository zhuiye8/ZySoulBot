// 入站图片下载：大小与 MIME 护栏 + 可选落盘到本地 inbox（供后台回放，防止 QQ 外链过期）。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ImagePart } from '../../shared/ports.ts'

const MAX_BYTES = 5 * 1024 * 1024
const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export async function fetchInboundImages(
  urls: string[],
  opts: {
    inboxDir?: string
    maxCount?: number
    fetchImpl?: typeof fetch
    onFail?: (url: string, reason: string) => void
  } = {},
): Promise<ImagePart[]> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const limit = opts.maxCount ?? 3
  const out: ImagePart[] = []
  for (const url of urls.slice(0, limit)) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) { opts.onFail?.(url, `http_${res.status}`); continue }
      const rawType = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0]!.trim().toLowerCase()
      const mimeType = rawType === 'image/jpg' ? 'image/jpeg' : rawType
      if (!ALLOWED_MIMES.has(mimeType)) { opts.onFail?.(url, `bad_mime_${mimeType}`); continue }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) {
        opts.onFail?.(url, `bad_size_${buf.byteLength}`)
        continue
      }
      let name: string | undefined
      if (opts.inboxDir) {
        try {
          mkdirSync(opts.inboxDir, { recursive: true })
          const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1] || 'png'
          name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.${ext}`
          writeFileSync(join(opts.inboxDir, name), buf)
        } catch {
          name = undefined
        }
      }
      out.push({ data: buf.toString('base64'), mimeType, name })
    } catch (e) {
      opts.onFail?.(url, (e as Error).message.slice(0, 80))
    }
  }
  return out
}
