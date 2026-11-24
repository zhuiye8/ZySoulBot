// 人设包纯领域模型与静态 System Prompt 拼装器（零文件系统 I/O，I/O 加载见 src/storage/persona-loader.ts）。
// 关键原则：渲染静态 System Prompt 时字节级锁定（严禁混入日期/轮数/剩余分钟等动态字段），保证 Prefix Cache 高命中。
import { z } from 'zod'
import type { ActivityDef } from '../../shared/ports.ts'

export const PackManifestSchema = z.object({
  pack_version: z.string().default('1.0'),
  id: z.string().min(1),
  name: z.string().min(1),
  summary: z.string().default(''),
  content_dir: z.string().default('persona'),
  content: z.object({
    identity: z.string().default('identity.md'),
    origin: z.string().optional(),
    examples: z.string().optional(),
    worldview: z.string().optional(),
    scenario: z.string().optional(),
    discipline: z.string().optional(),
    greeting: z.string().optional(),
  }),
})

export const LoreEntrySchema = z.object({
  id: z.string(),
  keys: z.array(z.string()),
  content: z.string(),
  priority: z.number().default(5),
})

export const ActivityDefSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  place: z.string().min(1),
  times: z.array(z.enum(['morning', 'noon', 'afternoon', 'evening', 'night'])).default([]),
  durationMin: z.tuple([z.number().positive(), z.number().positive()]),
  yields: z.enum(['sight', 'none']).default('none'),
  effects: z.object({
    energy: z.number().optional(),
    pad: z.object({ p: z.number().optional(), a: z.number().optional(), d: z.number().optional() }).optional(),
    drives: z.record(z.number()).optional(),
  }).optional(),
  requiresCapability: z.string().optional(),
  source: z.string().optional(),
})

export interface LoreEntry {
  id: string
  keys: string[]
  content: string
  priority: number
}

export interface WorldSection {
  title: string
  keywords: string[]
  body: string
}

export interface PersonaPack {
  id: string
  name: string
  summary: string
  identity: string
  origin: string
  examples: string
  worldview: string
  scenario: string
  discipline: string
  greeting: string
  lore: LoreEntry[]
  activities: ActivityDef[]
  worldSections: WorldSection[]
  staticSystemPrompt: string
}

export interface RawPersonaPackFiles {
  manifestJson: string
  identity: string
  origin?: string
  examples?: string
  worldview?: string
  scenario?: string
  discipline?: string
  greeting?: string
  loreJson?: string | null
  activitiesJson?: string | null
}

function parseWorldSections(raw: string): WorldSection[] {
  if (!raw.trim()) return []
  const parts = raw.split(/^(?=##\s+)/m).map((s) => s.trim()).filter(Boolean)
  return parts.map((part) => {
    const firstLine = part.split('\n')[0] ?? ''
    const title = firstLine.replace(/^#+\s*/, '').trim()
    const clean = title.replace(/[（(].*?[)）]/g, '').trim()
    const keywords = clean
      .split(/[与和、,，\s/·]+/)
      .map((k) => k.trim())
      .filter((k) => k.length >= 2)
    return { title, keywords, body: part }
  })
}

export function buildStaticSystemPrompt(p: {
  identity: string
  origin: string
  examples: string
  scenario: string
  discipline: string
}): string {
  const blocks: string[] = []
  if (p.identity) {
    blocks.push(`# 你是谁\n${p.identity}${p.origin ? `\n\n## 你的来历\n${p.origin}` : ''}`)
  }
  if (p.examples) blocks.push(`# 语气锚点\n${p.examples}`)
  if (p.scenario) blocks.push(`# 你的日常处境\n${p.scenario}`)
  if (p.discipline) blocks.push(`# 你就是这样的人\n${p.discipline}`)
  return blocks.join('\n\n')
}

export function parsePersonaPack(files: RawPersonaPackFiles): PersonaPack {
  const parsed = PackManifestSchema.parse(JSON.parse(files.manifestJson))
  const identity = files.identity.trim()
  if (!identity) {
    throw new Error(`人设包 "${parsed.id}" 的核心身份（identity）为空，拒绝空灵魂启动`)
  }
  const origin = (files.origin ?? '').trim()
  const examples = (files.examples ?? '').trim()
  const worldview = (files.worldview ?? '').trim()
  const scenario = (files.scenario ?? '').trim()
  const discipline = (files.discipline ?? '').trim()
  const greeting = (files.greeting ?? '').trim()

  let lore: LoreEntry[] = []
  if (files.loreJson) {
    const rawLore: unknown = JSON.parse(files.loreJson)
    const arr = Array.isArray(rawLore) ? rawLore : (rawLore as { entries?: unknown[] })?.entries ?? []
    lore = z.array(LoreEntrySchema).parse(arr)
  }

  let activities: ActivityDef[] = []
  if (files.activitiesJson) {
    const rawActs: unknown = JSON.parse(files.activitiesJson)
    activities = z.array(ActivityDefSchema).parse(rawActs)
  }

  const staticSystemPrompt = buildStaticSystemPrompt({ identity, origin, examples, scenario, discipline })

  return {
    id: parsed.id,
    name: parsed.name,
    summary: parsed.summary,
    identity,
    origin,
    examples,
    worldview,
    scenario,
    discipline,
    greeting,
    lore,
    activities,
    worldSections: parseWorldSections(worldview),
    staticSystemPrompt,
  }
}

// 按需匹配世界观片段与世界书（只放进末尾动态块，绝不污染静态 System）。
export function pickRelevantWorldFacts(pack: PersonaPack, haystack: string, maxChars = 600): string {
  const text = haystack.trim()
  if (!text) return ''
  const snippets: string[] = []
  let used = 0

  for (const sec of pack.worldSections) {
    if (!sec.keywords.some((k) => text.includes(k))) continue
    const slice = sec.body.slice(0, 320)
    if (used + slice.length > maxChars) break
    snippets.push(slice)
    used += slice.length
  }

  const matchedLore = pack.lore
    .filter((e) => e.keys.some((k) => k && text.includes(k)))
    .sort((a, b) => b.priority - a.priority)
  for (const e of matchedLore) {
    const slice = e.content.slice(0, 260)
    if (used + slice.length > maxChars) break
    snippets.push(slice)
    used += slice.length
  }

  return snippets.join('\n\n')
}
