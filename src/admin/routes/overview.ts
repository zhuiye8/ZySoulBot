// 概览、身心、Token 账本与 Trace 路由
import { Hono } from 'hono'
import { systemClock, todayLocal } from '../../shared/time.ts'
import { checkAutonomousBudget } from '../../soul/governance/budget.ts'
import type { AdminContext } from '../context.ts'

export function registerOverviewRoutes(app: Hono, ctx: AdminContext): void {
  const clock = ctx.clock ?? systemClock

  app.get('/api/bots', (c) => {
    const now = clock.now()
    const list = ctx.bots.map((b) => {
      const body = b.soul.body.state(now)
      const pendingApproval = b.soul.approvals.pending(now)
      const missingCreds = b.credentials.listPublic().filter((cr) => !cr.filled).length
      const activeDesires = b.soul.store.listDesires(['active', 'in_progress', 'waiting_credential', 'waiting_approval']).length
      return {
        id: b.config.id,
        name: b.soul.persona.name,
        summary: b.soul.persona.summary || b.soul.persona.identity.slice(0, 80),
        energy: body.energy,
        mood: body.mood,
        activity: body.activity,
        hasTransport: Boolean(b.transport),
        hasTts: Boolean(b.tts),
        hasSinging: Boolean(b.singing),
        activeDesires,
        pendingTodos: (pendingApproval ? 1 : 0) + missingCreds,
      }
    })
    return c.json({ bots: list })
  })

  app.get('/api/bots/:id/overview', (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot) return c.json({ error: 'Bot not found' }, 404)
    const now = clock.now()
    const today = todayLocal(now)
    const todayIso = `${today}T00:00:00.000Z`
    const body = bot.soul.body.state(now)
    const tokensToday = bot.soul.store.tokenStatsSince(todayIso)
    const cacheHitRate = tokensToday.totalInput > 0
      ? Number((tokensToday.totalCached / tokensToday.totalInput).toFixed(3))
      : 0

    const desires = bot.soul.store.listDesires(['seed', 'active', 'in_progress', 'waiting_credential', 'waiting_approval'])
    const pendingApproval = bot.soul.approvals.pending(now)
    const missingCreds = bot.credentials.listPublic().filter((cr) => !cr.filled)
    const recentMemories = bot.soul.store.recentMemories(8)
    const recentWorks = bot.soul.store.listWorks(undefined, 6)
    const recentTraces = bot.soul.store.recentTraces(20)
    const recentCauses = bot.soul.store.recentEmotionCauses(6)
    const budget = checkAutonomousBudget(bot.soul.store, bot.config.budget.dailyAutonomousTokens, now)

    const todayChatCalls = tokensToday.byScene.chat?.calls ?? 0

    return c.json({
      bot: {
        id: bot.config.id,
        name: bot.soul.persona.name,
        summary: bot.soul.persona.summary,
        proactivityEnabled: bot.config.proactivity.enabled,
        hasTransport: Boolean(bot.transport),
        hasTts: Boolean(bot.tts),
        hasSinging: Boolean(bot.singing),
      },
      body,
      bodyFacts: bot.soul.body.renderBodyFacts(now),
      kpis: {
        todayTurns: todayChatCalls,
        activeDesires: desires.length,
        todayTokens: tokensToday.totalInput + tokensToday.totalOutput,
        todayCostCny: tokensToday.totalCostCny,
        cacheHitRate,
        pendingApprovals: pendingApproval ? 1 : 0,
        missingCredentials: missingCreds.length,
      },
      budget,
      pendingApproval,
      missingCredentials: missingCreds,
      recentCauses,
      recentMemories,
      recentWorks,
      recentTraces,
    })
  })

  app.get('/api/bots/:id/body', (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot) return c.json({ error: 'Bot not found' }, 404)
    const now = clock.now()
    return c.json({
      state: bot.soul.body.state(now),
      facts: bot.soul.body.renderBodyFacts(now),
      causes: bot.soul.store.recentEmotionCauses(20),
    })
  })

  app.get('/api/bots/:id/tokens', (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot) return c.json({ error: 'Bot not found' }, 404)
    const now = clock.now()
    const todayIso = `${todayLocal(now)}T00:00:00.000Z`
    const weekIso = new Date(now.getTime() - 7 * 86_400_000).toISOString()
    const today = bot.soul.store.tokenStatsSince(todayIso)
    const week = bot.soul.store.tokenStatsSince(weekIso)
    const daily = bot.soul.store.tokenDailySeries(7)
    const budget = checkAutonomousBudget(bot.soul.store, bot.config.budget.dailyAutonomousTokens, now)
    return c.json({ today, week, daily, budget })
  })

  app.get('/api/bots/:id/traces', (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot) return c.json({ error: 'Bot not found' }, 404)
    const limit = Math.min(200, Math.max(10, Number(c.req.query('limit') ?? 80) || 80))
    return c.json({ traces: bot.soul.store.recentTraces(limit) })
  })
}
