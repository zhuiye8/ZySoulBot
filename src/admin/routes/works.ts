// 声音、歌单作品与表情包图库路由
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import { EMOTION_KINDS } from '../../shared/ports.ts'
import type { AffectKind } from '../../shared/ports.ts'
import { tagStickerImage } from '../../llm/sticker-tagger.ts'
import type { AdminContext } from '../context.ts'

const TtsPreviewSchema = z.object({
  text: z.string().min(1).max(200),
})

const ALLOWED_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

function mimeOfImage(file: string): string {
  const ext = extname(file).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  return 'image/jpeg'
}

export function registerWorksRoutes(app: Hono, ctx: AdminContext): void {
  app.get('/api/bots/:id/works', (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot) return c.json({ error: 'Bot not found' }, 404)
    const works = bot.soul.store.listWorks(undefined, 60).map((w) => ({
      ...w,
      hasAudio: Boolean(w.mediaPath && existsSync(w.mediaPath)),
    }))
    return c.json({ works, hasSinging: Boolean(bot.singing), hasTts: Boolean(bot.tts) })
  })

  app.get('/api/bots/:id/works/:wid/audio', (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot) return c.json({ error: 'Bot not found' }, 404)
    const work = bot.soul.store.getWork(c.req.param('wid'))
    if (!work?.mediaPath || !existsSync(work.mediaPath)) {
      return c.json({ error: 'Audio not found' }, 404)
    }
    const bytes = readFileSync(work.mediaPath)
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': work.mediaPath.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg',
        'Cache-Control': 'private, max-age=3600',
      },
    })
  })

  app.get('/api/bots/:id/stickers', (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot) return c.json({ error: 'Bot not found' }, 404)
    if (!bot.stickers) return c.json({ enabled: false, items: [] })
    return c.json({ enabled: true, items: bot.stickers.list() })
  })

  app.get('/api/bots/:id/stickers/:key/file', (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot?.stickers) return c.json({ error: 'Sticker library disabled' }, 404)
    const meta = bot.stickers.get(c.req.param('key'))
    if (!meta) return c.json({ error: 'Sticker not found' }, 404)
    const root = resolve(bot.stickers.dir)
    const target = resolve(root, meta.file)
    if (!target.startsWith(root) || !existsSync(target)) return c.json({ error: 'Sticker file missing' }, 404)
    const bytes = readFileSync(target)
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': mimeOfImage(target),
        'Cache-Control': 'private, max-age=86400',
      },
    })
  })

  app.post('/api/bots/:id/stickers', async (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot?.stickers) return c.json({ error: 'Sticker library disabled' }, 404)
    const form = await c.req.formData().catch(() => null)
    if (!form) return c.json({ error: 'Expected multipart/form-data' }, 400)
    const file = form.get('file')
    if (!(file instanceof File)) return c.json({ error: 'Missing image file' }, 400)
    if (file.size === 0 || file.size > 5 * 1024 * 1024) {
      return c.json({ error: '图片大小需在 1B ~ 5MB 之间' }, 400)
    }

    const ext = extname(file.name).toLowerCase() || '.png'
    if (!ALLOWED_IMAGE_EXT.has(ext)) return c.json({ error: '仅支持 png/jpg/webp/gif' }, 400)

    const bytes = new Uint8Array(await file.arrayBuffer())
    const key = `stk_${randomUUID().slice(0, 8)}`
    const filename = `${key}${ext}`
    mkdirSync(bot.stickers.dir, { recursive: true })
    writeFileSync(join(bot.stickers.dir, filename), bytes)

    const rawEmotions = String(form.get('emotions') ?? '').trim()
    let emotions: AffectKind[] = rawEmotions
      ? rawEmotions.split(',').map((s) => s.trim()).filter((e): e is AffectKind => (EMOTION_KINDS as readonly string[]).includes(e))
      : []
    let description = String(form.get('description') ?? '').trim()
    let tags: string[] = []

    const autoTag = String(form.get('autoTag') ?? 'true') !== 'false'
    if (emotions.length === 0 && autoTag) {
      try {
        const model = bot.soul.auxModel ?? bot.soul.chatModel
        const tagged = await tagStickerImage(model, { bytes, mimeType: file.type || mimeOfImage(filename) })
        emotions = tagged.emotions
        tags = tagged.tags
        if (!description) description = tagged.description
      } catch {
        emotions = ['neutral']
      }
    }
    if (emotions.length === 0) emotions = ['neutral']

    const meta = { key, file: filename, emotions, tags, description, enabled: true, weight: 1, uses: 0 }
    bot.stickers.upsert(meta)
    return c.json({ ok: true, sticker: meta })
  })

  app.delete('/api/bots/:id/stickers/:key', (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot?.stickers) return c.json({ error: 'Sticker library disabled' }, 404)
    const key = c.req.param('key')
    const meta = bot.stickers.get(key)
    if (!meta) return c.json({ error: 'Sticker not found' }, 404)
    bot.stickers.remove(key)
    const root = resolve(bot.stickers.dir)
    const filePath = resolve(root, meta.file)
    if (filePath.startsWith(root) && existsSync(filePath)) {
      try {
        unlinkSync(filePath)
      } catch {
        // 忽略清理失败
      }
    }
    return c.json({ ok: true })
  })

  app.post('/api/bots/:id/tts/preview', async (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot) return c.json({ error: 'Bot not found' }, 404)
    if (!bot.tts) return c.json({ error: '当前未配置语音合成（TTS）' }, 400)
    const body = TtsPreviewSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: '请输入 1~200 字试听文本' }, 400)
    const audio = await bot.tts.synth({ text: body.data.text })
    return new Response(new Uint8Array(audio.bytes), {
      status: 200,
      headers: { 'Content-Type': audio.mimeType },
    })
  })
}
