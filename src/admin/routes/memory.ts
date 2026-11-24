// 记忆、人物关系、对话回放与安全清空路由
import { Hono } from 'hono'
import { z } from 'zod'
import { systemClock } from '../../shared/time.ts'
import { memoryStrength } from '../../soul/memory/engine.ts'
import type { AdminContext } from '../context.ts'

const WipeSchema = z.object({
  confirm: z.string().min(1),
})

export function registerMemoryRoutes(app: Hono, ctx: AdminContext): void {
  const clock = ctx.clock ?? systemClock

  app.get('/api/bots/:id/memories', (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot) return c.json({ error: 'Bot not found' }, 404)
    const q = (c.req.query('q') ?? '').trim()
    const limit = Math.min(200, Math.max(10, Number(c.req.query('limit') ?? 60) || 60))
    const raw = q
      ? bot.soul.store.searchMemories(q, limit)
      : bot.soul.store.recentMemories(limit)
    const nowMs = clock.now().getTime()
    const items = raw.map((m) => ({
      ...m,
      clarity: Number(memoryStrength(m, nowMs).toFixed(3)),
    }))
    return c.json({ query: q, items })
  })

  app.delete('/api/bots/:id/memories/:mid', (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot) return c.json({ error: 'Bot not found' }, 404)
    const removed = bot.soul.store.removeMemory(c.req.param('mid'))
    if (!removed) return c.json({ error: 'Memory not found' }, 404)
    return c.json({ ok: true })
  })

  app.get('/api/bots/:id/relations', (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot) return c.json({ error: 'Bot not found' }, 404)
    const list = bot.soul.store.listRelations().map((r) => ({
      ...r,
      displayName: bot.soul.relations.nameOf(r.userId),
      sharedStories: bot.soul.memory.sharedStories(r.userId, 3).map((m) => ({
        id: m.id,
        text: m.text,
        createdAt: m.createdAt,
      })),
      lastContactAt: bot.soul.store.lastUserContactAt(r.userId),
    }))
    return c.json({ relations: list })
  })

  app.get('/api/bots/:id/threads', (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot) return c.json({ error: 'Bot not found' }, 404)
    const threads = bot.soul.store.listThreads(50)
    return c.json({ threads })
  })

  app.get('/api/bots/:id/messages', (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot) return c.json({ error: 'Bot not found' }, 404)
    const threadKey = (c.req.query('threadKey') ?? '').trim()
    if (!threadKey) return c.json({ error: 'threadKey required' }, 400)
    const limit = Math.min(200, Math.max(10, Number(c.req.query('limit') ?? 80) || 80))
    const messages = bot.soul.store.recentMessages(threadKey, limit)
    return c.json({ threadKey, messages })
  })

  app.post('/api/bots/:id/wipe', async (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot) return c.json({ error: 'Bot not found' }, 404)
    const parsed = WipeSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success || parsed.data.confirm !== bot.config.id) {
      return c.json({ error: `请传入 { confirm: "${bot.config.id}" } 确认清空` }, 400)
    }
    bot.soul.store.wipeRuntimeData()
    bot.soul.body.tick(clock.now())
    return c.json({ ok: true, wiped: bot.config.id })
  })
}
