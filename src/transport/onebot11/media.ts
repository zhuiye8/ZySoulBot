// 入站图片下载：大小与 MIME 护栏 + 可选落盘到本地 inbox（供后台回放，防止 QQ 外链过期）。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ImagePart } from '../../shared/ports.ts'

const MAX_BYTES = 5 * 1024 * 1024
const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

// QQ CDN（如 multimedia.nt.qq.com.cn）经常返回 application/octet-stream，通过文件头魔数兜底识别真实图片格式
function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 6 && buf.subarray(0, 6).toString('ascii').startsWith('GIF8')) return 'image/gif'
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

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
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) {
        opts.onFail?.(url, `bad_size_${buf.byteLength}`)
        continue
      }
      const rawType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
      const headerMime = rawType === 'image/jpg' ? 'image/jpeg' : rawType
      const mimeType = ALLOWED_MIMES.has(headerMime) ? headerMime : (sniffImageMime(buf) ?? '')
      if (!ALLOWED_MIMES.has(mimeType)) { opts.onFail?.(url, `bad_mime_${rawType || 'unknown'}`); continue }
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
