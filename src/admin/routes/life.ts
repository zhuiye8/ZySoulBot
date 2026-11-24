// 内心与生活路由：欲望板干预、日记阅读、审批一键处理
import { Hono } from 'hono'
import { nowLocal, systemClock } from '../../shared/time.ts'
import type { AdminContext } from '../context.ts'

export function registerLifeRoutes(app: Hono, ctx: AdminContext): void {
  const clock = ctx.clock ?? systemClock

  app.get('/api/bots/:id/desires', (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot) return c.json({ error: 'Bot not found' }, 404)
    return c.json({ desires: bot.soul.store.listDesires() })
  })

  app.post('/api/bots/:id/desires/:did/:op', async (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot) return c.json({ error: 'Bot not found' }, 404)
    const did = c.req.param('did')
    const op = c.req.param('op')
    if (op !== 'boost' && op !== 'abandon' && op !== 'resume') {
      return c.json({ error: 'Unsupported desire op' }, 400)
    }

    // P1-STATE-04：后台写入统一进单 Bot 串行队列
    const updated = await bot.runSerialized(() => {
      const desire = bot.soul.store.getDesire(did)
      if (!desire) return null
      const now = clock.now()
      const stamp = nowLocal(now)
      if (op === 'boost') {
        desire.strength = Math.min(1, Number((desire.strength + 0.25).toFixed(2)))
        if (desire.stage === 'seed' || desire.stage === 'faded') desire.stage = 'active'
        desire.progressNote = '后台轻推了一下这个念头'
      } else if (op === 'abandon') {
        desire.stage = 'abandoned'
        desire.progressNote = '在后台收起了这个念头'
      } else {
        desire.stage = 'active'
        desire.blocker = null
        desire.rejectedUntil = undefined
        desire.strength = Math.max(desire.strength, 0.65)
        desire.progressNote = '后台恢复推进'
      }
      desire.lastProgressAt = stamp
      desire.updatedAt = stamp
      bot.soul.store.upsertDesire(desire)
      return desire
    })
    if (!updated) return c.json({ error: 'Desire not found' }, 404)
    return c.json({ ok: true, desire: updated })
  })

  app.get('/api/bots/:id/diary', (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot) return c.json({ error: 'Bot not found' }, 404)
    const entries = bot.diary.list(60)
    const dates = entries.map((e) => e.date)
    const reqDate = c.req.query('date') ?? dates[0] ?? null
    const content = reqDate ? bot.diary.read(reqDate) : null
    return c.json({ dates, activeDate: reqDate, content })
  })

  app.get('/api/bots/:id/approvals', (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot) return c.json({ error: 'Bot not found' }, 404)
    const now = clock.now()
    return c.json({
      pending: bot.soul.approvals.pending(now),
      history: bot.soul.store.listApprovals(30),
    })
  })

  app.post('/api/bots/:id/approvals/:aid/:op', async (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot) return c.json({ error: 'Bot not found' }, 404)
    const aid = c.req.param('aid')
    const op = c.req.param('op')
    if (op !== 'approve' && op !== 'reject') return c.json({ error: 'Unsupported approval op' }, 400)

    const result = await bot.runSerialized(() => {
      const now = clock.now()
      const stamp = nowLocal(now)
      const pending = bot.soul.approvals.pending(now)
      if (!pending || pending.id !== aid) return null

      const status = op === 'approve' ? 'approved' : 'rejected'
      bot.soul.approvals.resolve(pending, status, now)
      const desire = bot.soul.store.getDesire(pending.targetId)
      if (desire) {
        if (status === 'approved') {
          // P1-STATE-05：授予绑定当前任务的一次性授权版本，解锁不受全局开关阻挡
          desire.stage = 'active'
          desire.blocker = null
          desire.approvedPlanVersion = (desire.approvedPlanVersion ?? 0) + 1
          desire.rejectedUntil = undefined
          desire.progressNote = '后台已同意'
        } else {
          // 拒绝后进入 24 小时冷静期，避免立即反复弹出同一审批
          desire.stage = 'active'
          desire.blocker = null
          desire.rejectedUntil = nowLocal(new Date(now.getTime() + 24 * 3_600_000))
          desire.progressNote = '后台暂未同意，先搁置一段时间'
        }
        desire.lastProgressAt = stamp
        desire.updatedAt = stamp
        bot.soul.store.upsertDesire(desire)
      }
      return { status }
    })
    if (!result) return c.json({ error: 'Pending approval not found' }, 404)
    return c.json({ ok: true, status: result.status })
  })
}
