// 统一生活决策引擎：动机池（0 token）→ 状态连续骰子（含精力/睡眠债/时段/驱力/冷却/忙碌）→ 一次生活抉择。
// 同步提供：活动开场思绪、自然主动措辞（带残句拦截）、概率日记触发与每日反思。
import { z } from 'zod'
import type {
  ActivityDef,
  BodyState,
  ChatModel,
  DesireRecord,
  ScheduleRecord,
  SoulStore,
} from '../../shared/ports.ts'
import { nowLocal, timeHHMM, todayLocal } from '../../shared/time.ts'
import { timeSlotOf } from '../body/engine.ts'
import type { PersonaPack } from '../persona/pack.ts'
import { estimateCostCny } from '../agent/loop.ts'
import type { PriceTable } from '../agent/loop.ts'

export interface LifeMotive {
  kind: 'promise' | 'missing' | 'social_desire' | 'clear_air' | 'make_amends'
  userId: string
  fact: string
  weight: number
  ref?: string
}

export interface RollFactors {
  base: number
  drive: number
  energy: number
  time: number
  motive: number
  cooldown: number
  busy: number
}

export interface LifeRollResult {
  p: number
  factors: RollFactors
  hit: boolean
}

export type LifeChoice =
  | { kind: 'nothing' }
  | { kind: 'stay' }
  | { kind: 'activity'; activityId: string }
  | { kind: 'speak'; userId: string; motive: LifeMotive }
  | { kind: 'pursue_desire'; desireId: string }

export function looksTruncated(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (/[。！？…!?~」』"')）]$/.test(t)) return false
  if (/[，,、；;：:]$/.test(t)) return true
  if (/[对把被给跟和与在从向往为以之其而但如果虽然因为所这那哪怎什]$/.test(t)) return true
  return false
}

// ── 1) 纯代码收集社交动机（0 token，纯事实描述）────────────────────────
export function collectSocialMotives(opts: {
  now: Date
  promises: ScheduleRecord[]
  people: Array<{
    userId: string
    name: string
    lastAtMs?: number
    lastText?: string
    stage?: string
    turns?: number
    disengagement?: number
    tensions?: Array<{
      id?: string
      source?: 'user' | 'self'
      text: string
      severity: number
      clearAirAsked?: boolean
      createdAt: string
    }>
  }>
  socialDesires: DesireRecord[]
}): LifeMotive[] {
  const out: LifeMotive[] = []
  const byId = new Map(opts.people.map((p) => [p.userId, p]))
  const nameOf = new Map(opts.people.map((p) => [p.userId, p.name]))
  const idByName = new Map(opts.people.map((p) => [p.name, p.userId]))

  const isHostile = (uid: string): boolean => byId.get(uid)?.stage === 'hostile'

  for (const pr of opts.promises) {
    if (isHostile(pr.userId)) continue
    out.push({
      kind: 'promise',
      userId: pr.userId,
      fact: `你和${nameOf.get(pr.userId) ?? '他'}定过的事：「${pr.text}」，时间差不多到了`,
      weight: 0.78,
      ref: pr.id,
    })
  }

  for (const p of opts.people) {
    // v2.1 反向愧疚弥补动机（即使关系未冷，做错了事也想主动补救）
    const selfTension = p.tensions?.find((t) => t.source === 'self')
    if (selfTension && p.stage !== 'hostile') {
      out.push({
        kind: 'make_amends',
        userId: p.userId,
        fact: `你之前有件事对${p.name}过意不去：「${selfTension.text}」，心里一直惦记着想弥补一下`,
        weight: 0.62,
        ref: selfTension.id,
      })
    }

    if (p.stage === 'hostile') continue
    const userTensions = (p.tensions ?? []).filter((t) => t.source !== 'self')
    const topTension = userTensions.slice().sort((a, b) => b.severity - a.severity)[0]
    const strained = p.stage === 'distant' || (topTension !== undefined && topTension.severity >= 0.4)

    if (strained) {
      // 关系冷淡/带心结时不寒暄；仅在未深度情感抽离（disengagement <= 0.6）、原本相处较深、
      // 且该心结未破冰过（!clearAirAsked）时，在 6~72 小时窗口内最多产生 1 次 clear_air 动机。
      if (topTension && !topTension.clearAirAsked && (p.disengagement ?? 0) <= 0.6 && (p.turns ?? 0) >= 25) {
        const at = Date.parse(topTension.createdAt.replace(' ', 'T'))
        const ageH = Number.isFinite(at) ? (opts.now.getTime() - at) / 3_600_000 : 0
        if (ageH >= 6 && ageH <= 72) {
          out.push({
            kind: 'clear_air',
            userId: p.userId,
            fact: `你和${p.name}之间还有个没说开的疙瘩（「${topTension.text}」），心里一直有点放不下`,
            weight: 0.48,
            ref: topTension.id,
          })
        }
      }
      continue
    }

    if (p.lastAtMs === undefined) continue
    const hours = (opts.now.getTime() - p.lastAtMs) / 3_600_000
    if (hours < 6) continue
    const span = hours >= 48 ? `${Math.floor(hours / 24)} 天` : `${Math.round(hours)} 小时`
    out.push({
      kind: 'missing',
      userId: p.userId,
      fact: `你和${p.name}上次说话是 ${span} 前${p.lastText ? `，最后提到「${p.lastText.slice(0, 24)}」` : ''}`,
      weight: Math.min(0.65, 0.3 + hours / 72),
    })
  }

  for (const d of opts.socialDesires) {
    let target = d.aboutUser
    if (!target) {
      for (const [nm, uid] of idByName) {
        if (nm.length >= 2 && nm !== uid && d.want.includes(nm)) {
          target = uid
          break
        }
      }
    }
    if (!target || isHostile(target)) continue
    out.push({
      kind: 'social_desire',
      userId: target,
      fact: `你心里有件事想跟${nameOf.get(target) ?? '他'}说：「${d.want}」`,
      weight: Math.min(0.75, 0.4 + d.strength * 0.35),
      ref: d.id,
    })
  }

  return out.sort((a, b) => b.weight - a.weight)
}

// ── 2) 状态连续骰子（纯代码可审计，含真实精力因子）─────────────────────
function timeFactor(now: Date): number {
  const h = now.getHours()
  if (h >= 2 && h < 6) return 0.2
  if (h >= 6 && h < 9) return 0.8
  if (h >= 9 && h < 12) return 1.1
  if (h >= 12 && h < 14) return 0.8
  if (h >= 14 && h < 18) return 1.15
  if (h >= 18 && h < 22) return 1.0
  return 0.45
}

function driveFactor(state: BodyState): number {
  const dev = (k: string, base: number): number => Math.max(0, (state.drives[k] ?? base) - base)
  const push = dev('companionship', 0.5) * 1.2 + dev('curiosity', 0.78) + dev('creative', 0.72)
  return Math.max(0.35, Math.min(1.6, 0.65 + push))
}

function energyFactor(state: BodyState): number {
  // 精力低或睡眠债高 → 真实压低主动活性，让她歇着
  const fatigue = Math.max(0, state.sleepDebt - 0.3) * 0.8
  const raw = 0.25 + state.energy * 0.95 - fatigue
  return Math.max(0.15, Math.min(1.15, raw))
}

function motiveFactor(motives: LifeMotive[], desireCount: number): number {
  const top = motives.length ? Math.max(...motives.map((m) => m.weight)) : 0
  const desireBoost = Math.min(0.3, desireCount * 0.1)
  if (motives.length === 0 && desireCount === 0) return 0.35
  return Math.min(1.6, 0.5 + top + desireBoost)
}

function cooldownFactor(lastActMs: number | undefined, now: Date): number {
  if (!lastActMs) return 1
  const min = (now.getTime() - lastActMs) / 60_000
  if (min < 20) return 0.25
  if (min < 60) return 0.6
  if (min < 180) return 0.85
  return 1
}

export function lifeRoll(opts: {
  state: BodyState
  motives: LifeMotive[]
  actionableDesireCount: number
  now: Date
  lastActMs?: number
  random?: () => number
}): LifeRollResult {
  const busy = Boolean(opts.state.activity && Date.parse(opts.state.activity.endsAt) > opts.now.getTime())
  const factors: RollFactors = {
    base: 0.08,
    drive: Number(driveFactor(opts.state).toFixed(2)),
    energy: Number(energyFactor(opts.state).toFixed(2)),
    time: Number(timeFactor(opts.now).toFixed(2)),
    motive: Number(motiveFactor(opts.motives, opts.actionableDesireCount).toFixed(2)),
    cooldown: Number(cooldownFactor(opts.lastActMs, opts.now).toFixed(2)),
    busy: busy ? 0.22 : 1,
  }
  const raw = factors.base * factors.drive * factors.energy * factors.time * factors.motive * factors.cooldown * factors.busy
  const p = Number(Math.max(0, Math.min(0.42, raw)).toFixed(3))
  const hit = (opts.random ?? Math.random)() < p
  return { p, factors, hit }
}

// ── 3) 人设包活动筛选与时长浮动 ────────────────────────────────────────
export function activitiesForSlot(activities: ActivityDef[], now: Date): ActivityDef[] {
  const slot = timeSlotOf(now)
  return activities.filter((a) => a.times.length === 0 || a.times.includes(slot))
}

export function pickActivityDuration(def: ActivityDef, state: BodyState, random = Math.random): number {
  const [lo, hi] = def.durationMin
  const bias = Math.max(0, Math.min(1, state.energy * 0.7 + (state.drives.curiosity ?? 0.7) * 0.3))
  const t = bias * 0.65 + random() * 0.35
  return Math.round(lo + (hi - lo) * t)
}

// ── 4) 一次生活抉择（严格硬校验所有 ID）─────────────────────────────────
const LifeDecisionSchema = z.object({
  do: z.enum(['nothing', 'stay', 'activity', 'speak', 'pursue_desire']),
  id: z.string().optional(),
  userId: z.string().optional(),
})

export async function decideLifeAction(
  deps: { model: ChatModel; store: SoulStore; persona: PersonaPack; priceTable?: PriceTable },
  inp: {
    traceId: string
    now: Date
    bodyFacts: string
    currentActivity: BodyState['activity']
    candidateActivities: Array<{ id: string; label: string; place: string; minutes: number }>
    motives: LifeMotive[]
    actionableDesires: DesireRecord[]
  },
  signal?: AbortSignal,
): Promise<LifeChoice> {
  const system = `你就是${deps.persona.name}。${deps.persona.summary || deps.persona.identity.slice(0, 120)}
现在是 ${timeHHMM(inp.now)}。下面是你此刻的状态、可以做的日常活动、心里的事和想做的念头。
想做什么由你自己决定，什么都不做（nothing）完全正常。只输出严格 JSON，不要其他文字。`

  const actLines = inp.candidateActivities
    .map((a) => `- [${a.id}] ${a.label}（${a.place}，约 ${a.minutes} 分钟）`)
    .join('\n')
  const motiveLines = inp.motives
    .map((m) => `- [对象=${m.userId}] ${m.fact}`)
    .join('\n')
  const desireLines = inp.actionableDesires
    .map((d) => `- [${d.id}] (${d.exitKind}) ${d.want}（起因：${d.why}）`)
    .join('\n')

  const curActLine = inp.currentActivity
    ? `你正在做：${inp.currentActivity.label}${inp.currentActivity.thinking ? `（心里在想：${inp.currentActivity.thinking}）` : ''}。\n\n`
    : ''

  const user = `${curActLine}此刻状态：\n${inp.bodyFacts}

这个时候能做的日常事：
${actLines || '（无）'}

心里惦记着的人和事：
${motiveLines || '（没什么特别惦记的）'}

心里一直想做的念头（体验/创作/造本领）：
${desireLines || '（暂时没有）'}

选一种输出 JSON：
${inp.currentActivity ? '- 接着做手上这件事 → {"do":"stay"}\n' : ''}- 什么都不做 → {"do":"nothing"}
- 去做上面一件日常事 → {"do":"activity","id":"编号"}
- 找上面某个人说点什么 → {"do":"speak","userId":"对象ID"}
- 现在就去推进心里那个念头 → {"do":"pursue_desire","id":"念头编号"}`

  try {
    const res = await deps.model.complete({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      reasoningEffort: 'low',
      temperature: 0.7,
      signal,
    })
    deps.store.recordTokens({
      scene: 'life',
      model: res.model,
      inputTokens: res.usage.inputTokens,
      cachedTokens: res.usage.cachedTokens,
      outputTokens: res.usage.outputTokens,
      reasoningTokens: res.usage.reasoningTokens,
      estCostCny: estimateCostCny(res.usage, deps.priceTable),
    })
    const m = res.content.match(/\{[\s\S]*\}/)
    if (!m) return { kind: 'nothing' }
    const parsed = LifeDecisionSchema.safeParse(JSON.parse(m[0]))
    if (!parsed.success) return { kind: 'nothing' }

    const d = parsed.data
    if (d.do === 'stay' && inp.currentActivity) return { kind: 'stay' }
    if (d.do === 'activity' && d.id && inp.candidateActivities.some((a) => a.id === d.id)) {
      return { kind: 'activity', activityId: d.id }
    }
    if (d.do === 'pursue_desire' && d.id && inp.actionableDesires.some((x) => x.id === d.id)) {
      return { kind: 'pursue_desire', desireId: d.id }
    }
    if (d.do === 'speak' && d.userId) {
      const hit = inp.motives.find((x) => x.userId === d.userId)
      if (hit) return { kind: 'speak', userId: hit.userId, motive: hit }
    }
    return { kind: 'nothing' }
  } catch (e) {
    deps.store.logTrace({
      traceId: inp.traceId,
      event: 'life_decide_error',
      level: 'warn',
      data: { error: (e as Error).message.slice(0, 160) },
    })
    return { kind: 'nothing' }
  }
}

// ── 5) 活动思绪 & 自然主动措辞 ───────────────────────────────────────
export async function composeActivityThinking(
  deps: { model: ChatModel; store: SoulStore; persona: PersonaPack; priceTable?: PriceTable },
  inp: { def: ActivityDef; bodyFacts: string },
  signal?: AbortSignal,
): Promise<string> {
  try {
    const res = await deps.model.complete({
      messages: [
        {
          role: 'system',
          content: `你就是${deps.persona.name}。${deps.persona.identity.slice(0, 800)}\n你正在${inp.def.place}，${inp.def.label}。这是一个人的时候，没人看着你。只用一句话写出你心里此刻冒出来的念头（≤60字）。`,
        },
        { role: 'user', content: `此刻状态：\n${inp.bodyFacts}` },
      ],
      reasoningEffort: 'low',
      temperature: 0.85,
      signal,
    })
    deps.store.recordTokens({
      scene: 'life',
      model: res.model,
      inputTokens: res.usage.inputTokens,
      cachedTokens: res.usage.cachedTokens,
      outputTokens: res.usage.outputTokens,
      reasoningTokens: res.usage.reasoningTokens,
      estCostCny: estimateCostCny(res.usage, deps.priceTable),
    })
    return res.content.trim().replace(/^["'「]|["'」]$/g, '').slice(0, 100)
  } catch {
    return ''
  }
}

export async function composeOutreach(
  deps: { model: ChatModel; store: SoulStore; persona: PersonaPack; priceTable?: PriceTable },
  inp: { traceId: string; purpose: string; relationFacts: string; memoryFacts: string; bodyFacts: string },
  signal?: AbortSignal,
): Promise<string | null> {
  const greetings = deps.persona.greeting.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
  const anchor = greetings.length > 0 ? greetings[Math.floor(Math.random() * greetings.length)]! : ''
  const system = `你就是${deps.persona.name}。${deps.persona.identity.slice(0, 1000)}\n现在你想主动给对方发一条消息（不是回复，是你先开口）。只说要说的话，自然简短。`
  const user = [
    `缘由：${inp.purpose}`,
    `关于眼前人：\n${inp.relationFacts}`,
    ...(inp.memoryFacts ? [`记得的相关事：\n${inp.memoryFacts}`] : []),
    `此刻状态：\n${inp.bodyFacts}`,
    ...(anchor ? [`平时开口的语气参考（别照抄）：${anchor}`] : []),
  ].join('\n\n')

  try {
    const res = await deps.model.complete({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      reasoningEffort: 'low',
      temperature: 0.8,
      signal,
    })
    deps.store.recordTokens({
      scene: 'outreach',
      model: res.model,
      inputTokens: res.usage.inputTokens,
      cachedTokens: res.usage.cachedTokens,
      outputTokens: res.usage.outputTokens,
      reasoningTokens: res.usage.reasoningTokens,
      estCostCny: estimateCostCny(res.usage, deps.priceTable),
    })
    const text = res.content.trim()
    if (!text || looksTruncated(text)) return null
    return text
  } catch (e) {
    deps.store.logTrace({
      traceId: inp.traceId,
      event: 'outreach_compose_error',
      level: 'warn',
      data: { error: (e as Error).message.slice(0, 160) },
    })
    return null
  }
}

// ── 6) 概率日记权重 & 每日反思 ─────────────────────────────────────────
export function diaryProbability(now: Date): number {
  const h = now.getHours()
  if (h >= 23 || h < 4) return 0.09
  if (h >= 20) return 0.025
  return 0.004
}

export function shouldConsiderDiary(now: Date, random = Math.random): boolean {
  return random() < diaryProbability(now)
}

const ReflectSchema = z.object({
  insights: z.array(z.string().min(4).max(120)).max(2).default([]),
})

export async function reflectOnToday(
  deps: { model: ChatModel; store: SoulStore; persona: PersonaPack; priceTable?: PriceTable },
  opts: { traceId: string; now?: Date; signal?: AbortSignal },
): Promise<number> {
  const now = opts.now ?? new Date()
  const day = todayLocal(now)
  const todays = deps.store.recentMemories(40).filter((m) => m.createdAt.startsWith(day) && m.kind !== 'insight')
  if (todays.length < 2) return 0

  try {
    const res = await deps.model.complete({
      messages: [
        {
          role: 'system',
          content: `你是${deps.persona.name}。睡前安静回顾今天记下的事，提炼 0–2 条你真正想明白的小感悟（用第一人称，不是流水账总结；没什么悟出来就给空数组）。只输出 JSON：{"insights":["..."]}`,
        },
        { role: 'user', content: todays.map((m) => `- ${m.text}`).join('\n') },
      ],
      reasoningEffort: 'low',
      temperature: 0.6,
      signal: opts.signal,
    })
    deps.store.recordTokens({
      scene: 'reflect',
      model: res.model,
      inputTokens: res.usage.inputTokens,
      cachedTokens: res.usage.cachedTokens,
      outputTokens: res.usage.outputTokens,
      reasoningTokens: res.usage.reasoningTokens,
      estCostCny: estimateCostCny(res.usage, deps.priceTable),
    })
    const m = res.content.match(/\{[\s\S]*\}/)
    if (!m) return 0
    const parsed = ReflectSchema.safeParse(JSON.parse(m[0]))
    if (!parsed.success) return 0

    let added = 0
    for (const text of parsed.data.insights) {
      deps.store.addMemory({
        kind: 'insight',
        text,
        about: [],
        sensitivity: 'open',
        tier: 'lasting',
        disclosable: 'when-asked',
        consented: false,
        source: 'life',
        threadKey: 'life',
        affect: null,
        createdAt: nowLocal(now),
      })
      added += 1
    }
    if (added > 0) {
      deps.store.logTrace({ traceId: opts.traceId, event: 'reflect_done', level: 'info', data: { count: added, day } })
    }
    return added
  } catch (e) {
    deps.store.logTrace({
      traceId: opts.traceId,
      event: 'reflect_error',
      level: 'warn',
      data: { error: (e as Error).message.slice(0, 160) },
    })
    return 0
  }
}
