// 三道门记忆系统（存 / 召回+遗忘曲线+复习 / 分级与模糊披露）+ 按块滑动的对话历史窗口。
import type {
  MemoryItem,
  RetentionTier,
  SoulStore,
  StoredMessage,
} from '../../shared/ports.ts'
import { nowLocal } from '../../shared/time.ts'

export const TIER_HALFLIFE_H: Record<RetentionTier, number> = {
  fleeting: 6,
  season: 240,
  lasting: 2160,
  permanent: Number.POSITIVE_INFINITY,
}

export type IntimacyTier = 'high' | 'mid' | 'low'

export function intimacyTierOf(stage: string): IntimacyTier {
  if (stage === 'trusted' || stage === 'bonded') return 'high'
  if (stage === 'familiar') return 'mid'
  return 'low'
}

export function similarText(a: string, b: string): boolean {
  const norm = (s: string): string =>
    s.replace(/[\s，。！？、,.!?；;：:"'「」（）()~～]/g, '').replace(/^(他|她|我|你)/, '')
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return false
  if (x.includes(y) || y.includes(x)) return true
  const sx = new Set(x)
  const sy = new Set(y)
  let hit = 0
  for (const ch of sy) if (sx.has(ch)) hit++
  return Math.max(hit / Math.max(1, sy.size), hit / Math.max(1, sx.size)) >= 0.58
}

export function vagueOf(text: string, names: string[] = []): string {
  let t = text.trim()
  if (!t) return ''
  t = t.replace(/^\s*[^：:\s]{1,20}[：:]\s*/, '')
  for (const n of names) {
    const nm = n.trim()
    if (nm.length >= 1) t = t.split(nm).join('有人')
  }
  t = t.replace(/\d{6,}/g, '…')
  t = t.replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, '一个地址')
  t = t.replace(/(他|她)(说|问|答应|提到|想|要|让)/g, '有人$2')
  return t.trim()
}

export function visibilityOf(
  item: MemoryItem,
  ctx: { listener: string; tier: IntimacyTier; isGroup: boolean },
): 'full' | 'vague' | 'no' {
  const aboutSelf = item.about.length === 0 || item.about.includes(ctx.listener)
  if (aboutSelf) return 'full'
  if (item.consented) return 'full'
  if (item.sensitivity === 'open') return 'full'
  if (ctx.isGroup) {
    if (item.sensitivity === 'personal') return item.source === 'group' ? 'full' : 'vague'
    if (item.sensitivity === 'private') return 'vague'
    return 'no'
  }
  if (item.sensitivity === 'personal') return 'full'
  if (item.sensitivity === 'critical') return ctx.tier === 'high' ? 'full' : 'no'
  if (ctx.tier === 'high') return 'full'
  if (ctx.tier === 'mid') return 'vague'
  return 'no'
}

// 记忆强度（0..1）：半衰期衰减 + 复习效应（被反复想起的记忆衰减变慢）
export function memoryStrength(item: MemoryItem, nowMs: number): number {
  const half = TIER_HALFLIFE_H[item.tier] ?? TIER_HALFLIFE_H.season
  if (!Number.isFinite(half)) return 1
  const anchor = item.lastRecalledAt ?? item.createdAt
  const at = Date.parse(anchor.replace(' ', 'T'))
  const hours = Number.isFinite(at) ? Math.max(0, (nowMs - at) / 3_600_000) : 0
  const reviewBoost = 1 + Math.min(3, item.recallCount) * 0.45
  return Math.pow(0.5, hours / (half * reviewBoost))
}

function bigramOverlap(text: string, query: string): number {
  const grams = (s: string): Set<string> => {
    const clean = s.replace(/[\s，。！？、,.!?；;：:"'「」（）()~～]/g, '')
    const out = new Set<string>()
    for (let i = 0; i < clean.length - 1; i++) out.add(clean.slice(i, i + 2))
    return out
  }
  const g1 = grams(text)
  const g2 = grams(query)
  if (g1.size === 0 || g2.size === 0) return 0
  let hit = 0
  for (const g of g2) if (g1.has(g)) hit++
  return hit / g2.size
}

export class MemoryEngine {
  private store: SoulStore

  constructor(store: SoulStore) {
    this.store = store
  }

  remember(
    item: Omit<MemoryItem, 'id' | 'recallCount' | 'lastRecalledAt' | 'createdAt'> & { createdAt?: string },
  ): MemoryItem | null {
    const text = item.text.trim()
    if (!text) return null
    const recent = this.store.recentMemories(40)
    if (recent.some((r) => similarText(r.text, text))) return null
    return this.store.addMemory({ ...item, text })
  }

  // 精准、紧凑地捞取本轮相关记忆（默认 Top 6 条，省 token；更细的靠她自己调 recall_memory 工具）
  recallForTurn(ctx: {
    listener: string
    tier: IntimacyTier
    isGroup: boolean
    query: string
    now: Date
    limit?: number
    nameOf: (userId: string) => string
  }): { text: string; touchedIds: string[] } {
    const limit = ctx.limit ?? 6
    const nowMs = ctx.now.getTime()
    // FTS5 关键词召回 + 最近记忆池去重合并
    const pool = new Map<string, MemoryItem>()
    for (const m of this.store.searchMemories(ctx.query, 16)) pool.set(m.id, m)
    for (const m of this.store.memoriesAbout(ctx.listener, 12)) pool.set(m.id, m)
    for (const m of this.store.recentMemories(20)) pool.set(m.id, m)

    const ranked = [...pool.values()]
      .map((item) => {
        const strength = memoryStrength(item, nowMs)
        const rel = bigramOverlap(item.text, ctx.query)
        const score = strength * (0.45 + 1.1 * rel)
        return { item, strength, score }
      })
      .sort((a, b) => b.score - a.score)

    const lines: string[] = []
    const touchedIds: string[] = []
    for (const { item, strength } of ranked) {
      const vis = visibilityOf(item, { listener: ctx.listener, tier: ctx.tier, isGroup: ctx.isGroup })
      if (vis === 'no') continue
      const aboutSelf = item.about.length === 0 || item.about.includes(ctx.listener)
      const body = vis === 'full'
        ? item.text
        : vagueOf(item.text, item.about.flatMap((u) => [u, ctx.nameOf(u)]))
      if (!body) continue

      const day = item.createdAt.slice(0, 10)
      // 经历类随时间淡化，事实/约定保持清晰
      const fuzzyTag = item.kind === 'experience' && strength < 0.35 ? '（过去有阵子了，细节记得有点模糊）' : ''
      const secretTag = item.disclosable === 'secretive' ? '（这件事你一直压在心里，还没跟谁提过）' : ''
      const ownerTag = !aboutSelf
        ? (vis === 'full'
          ? `（这是${item.about.map((u) => ctx.nameOf(u)).join('、')}的事，不是眼前这位）`
          : '（听人说起过，不涉及眼前这位）')
        : ''

      lines.push(`- [${day}] ${body}${fuzzyTag}${secretTag}${ownerTag}`)
      touchedIds.push(item.id)
      if (lines.length >= limit) break
    }

    if (touchedIds.length > 0) {
      this.store.touchMemories(touchedIds, nowLocal(ctx.now))
    }

    return { text: lines.join('\n'), touchedIds }
  }

  // 捞取与某人的共同故事（关系叙事化用，2-3 条高留存经历/约定）
  sharedStories(userId: string, limit = 3): MemoryItem[] {
    return this.store.memoriesAbout(userId, 24)
      .filter((m) => m.kind === 'experience' || m.tier === 'lasting' || m.tier === 'permanent')
      .slice(0, limit)
  }

  // 按块裁剪对话窗口（满 maxMessages 时一次性折叠最老 dropCount 条，保护 Prefix Cache 前缀稳定）
  loadStableWindow(threadKey: string, maxMessages = 30, dropCount = 10): StoredMessage[] {
    const total = this.store.countMessages(threadKey)
    if (total > maxMessages) {
      const oldest = this.store.recentMessages(threadKey, total).slice(0, dropCount)
      const brief = oldest
        .filter((m) => m.role !== 'summary')
        .slice(-4)
        .map((m) => `${m.userName}: ${m.content.slice(0, 36)}`)
        .join('；')
      this.store.compactOldMessages(threadKey, dropCount, brief ? `早些时候聊过：${brief}` : '')
    }
    return this.store.recentMessages(threadKey, maxMessages)
  }
}
