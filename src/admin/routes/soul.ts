// 灵魂人设包编辑（读取 pack.json 映射并热重载）、本领/技能清单、外部凭证安全填报路由
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import { systemClock } from '../../shared/time.ts'
import type { AdminContext } from '../context.ts'

const SavePersonaFileSchema = z.object({
  file: z.string().min(1).max(80),
  content: z.string().max(64_000),
})

const FillCredentialSchema = z.object({
  values: z.record(z.string(), z.string()),
})

const ToggleCapSchema = z.object({
  status: z.enum(['active', 'disabled']),
})

const PackContentMapSchema = z.object({
  content_dir: z.string().default('content'),
  content: z.record(z.string(), z.string()),
})

function resolvePersonaFiles(personaDir: string): Record<string, string> {
  const map: Record<string, string> = {}
  const packPath = join(personaDir, 'pack.json')
  if (existsSync(packPath)) {
    const parsed = PackContentMapSchema.safeParse(JSON.parse(readFileSync(packPath, 'utf8')))
    if (parsed.success) {
      const contentDir = resolve(personaDir, parsed.data.content_dir)
      for (const [slot, rel] of Object.entries(parsed.data.content)) {
        if (rel.includes('..')) continue
        map[`${slot}.md`] = resolve(contentDir, rel)
      }
    }
  }
  map['activities.json'] = resolve(personaDir, 'activities.json')
  return map
}

export function registerSoulRoutes(app: Hono, ctx: AdminContext): void {
  const clock = ctx.clock ?? systemClock

  app.get('/api/bots/:id/persona', (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot) return c.json({ error: 'Bot not found' }, 404)
    const fileMap = resolvePersonaFiles(bot.personaDir)
    const files: Record<string, string> = {}
    for (const [name, fullPath] of Object.entries(fileMap)) {
      files[name] = existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : ''
    }
    return c.json({
      name: bot.soul.persona.name,
      summary: bot.soul.persona.summary,
      staticPromptChars: bot.soul.persona.staticSystemPrompt.length,
      activityCount: bot.soul.persona.activities.length,
      files,
    })
  })

  app.put('/api/bots/:id/persona', async (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot) return c.json({ error: 'Bot not found' }, 404)
    const parsed = SavePersonaFileSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: '无效的保存请求' }, 400)

    const fileMap = resolvePersonaFiles(bot.personaDir)
    const target = fileMap[parsed.data.file]
    if (!target) return c.json({ error: `不允许编辑文件：${parsed.data.file}` }, 400)

    if (parsed.data.file === 'activities.json') {
      try {
        const arr: unknown = JSON.parse(parsed.data.content)
        if (!Array.isArray(arr)) return c.json({ error: 'activities.json 必须是 JSON 数组' }, 400)
      } catch (e) {
        return c.json({ error: `activities.json JSON 格式错误：${(e as Error).message}` }, 400)
      }
    }

    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, parsed.data.content, 'utf8')
    bot.reloadPersona()
    return c.json({
      ok: true,
      name: bot.soul.persona.name,
      staticPromptChars: bot.soul.persona.staticSystemPrompt.length,
      activityCount: bot.soul.persona.activities.length,
    })
  })

  app.get('/api/bots/:id/capabilities', (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot) return c.json({ error: 'Bot not found' }, 404)
    const items = bot.soul.store.listCapabilities().map((cap) => {
      const skillMdPath = join(cap.skillDir, 'SKILL.md')
      const doc = existsSync(skillMdPath) ? readFileSync(skillMdPath, 'utf8').slice(0, 6000) : ''
      return { ...cap, doc }
    })
    return c.json({ capabilities: items })
  })

  app.post('/api/bots/:id/capabilities/:name/status', async (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot) return c.json({ error: 'Bot not found' }, 404)
    const parsed = ToggleCapSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'status 必须是 active 或 disabled' }, 400)
    const target = bot.soul.store.listCapabilities().find((x) => x.name === c.req.param('name'))
    if (!target) return c.json({ error: 'Capability not found' }, 404)
    bot.soul.store.upsertCapability({ ...target, status: parsed.data.status })
    return c.json({ ok: true })
  })

  app.get('/api/bots/:id/credentials', (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot) return c.json({ error: 'Bot not found' }, 404)
    return c.json({ credentials: bot.credentials.listPublic() })
  })

  app.put('/api/bots/:id/credentials/:name', async (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot) return c.json({ error: 'Bot not found' }, 404)
    const name = c.req.param('name')
    const parsed = FillCredentialSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: '请提供字段键值 values' }, 400)
    const ok = bot.credentials.fill(name, parsed.data.values, undefined, clock.now())
    if (!ok) return c.json({ error: '凭证不存在或字段值不全' }, 400)
    const resumed = bot.soul.desires.resumeReadyCredentials((n) => bot.credentials.isReady(n), clock.now())
    return c.json({ ok: true, resumedDesireIds: resumed.map((d) => d.id) })
  })

  app.delete('/api/bots/:id/credentials/:name', (c) => {
    const bot = ctx.getBot(c.req.param('id'))
    if (!bot) return c.json({ error: 'Bot not found' }, 404)
    const removed = bot.credentials.removeNeed(c.req.param('name'))
    if (!removed) return c.json({ error: 'Credential not found' }, 404)
    return c.json({ ok: true })
  })
}
