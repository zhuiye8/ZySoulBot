// 群聊在场感与门控：旁观节流、续话窗（不续期防刷屏）、图片暂存、插话分类与动态话轮等待。
import { z } from 'zod'
import type { ActiveActivity, ChatModel, SoulStore } from '../../shared/ports.ts'
import { estimateCostCny } from '../agent/loop.ts'
import type { PriceTable } from '../agent/loop.ts'

export const CHIME_KINDS = ['about_me', 'question', 'comfort', 'chat', 'noise'] as const
export type ChimeKind = (typeof CHIME_KINDS)[number]

export const CHIME_SCORES: Record<ChimeKind, number> = {
  about_me: 0.85,
  question: 0.62,
  comfort: 0.6,
  chat: 0.18,
  noise: 0.05,
}

export interface GroupGateConfig {
  enabled?: boolean
  judgeGapMs?: number
  minSinceBotSpoke?: number
  minChars?: number
  chimeMin?: number
  followUpWindowMs?: number
  followUpMaxTurns?: number
}

export class GroupPresence {
  private watch = new Map<string, { lastJudgeAt: number; sinceBotSpoke: number }>()
  private followUp = new Map<string, { startedAt: number; turns: number }>()
  private recentImages = new Map<string, { urls: string[]; at: number }>()
  readonly cfg: Required<GroupGateConfig>

  constructor(cfg: GroupGateConfig = {}) {
    this.cfg = {
      enabled: cfg.enabled ?? true,
      judgeGapMs: cfg.judgeGapMs ?? 20_000,
      minSinceBotSpoke: cfg.minSinceBotSpoke ?? 2,
      minChars: cfg.minChars ?? 3,
      chimeMin: cfg.chimeMin ?? 0.55,
      followUpWindowMs: cfg.followUpWindowMs ?? 90_000,
      followUpMaxTurns: cfg.followUpMaxTurns ?? 2,
    }
  }

  noteGroupImages(threadKey: string, urls: string[], nowMs = Date.now()): void {
    if (urls.length > 0) this.recentImages.set(threadKey, { urls, at: nowMs })
  }

  takeRecentImages(threadKey: string, nowMs = Date.now(), maxAgeMs = 120_000): string[] {
    const entry = this.recentImages.get(threadKey)
    if (!entry) return []
    this.recentImages.delete(threadKey)
    return nowMs - entry.at <= maxAgeMs ? entry.urls : []
  }

  noteBotSpoke(threadKey: string, userId: string, nowMs = Date.now()): void {
    if (!threadKey.startsWith('qq:group:')) return
    const g = this.watch.get(threadKey) ?? { lastJudgeAt: 0, sinceBotSpoke: 0 }
    g.sinceBotSpoke = 0
    this.watch.set(threadKey, g)
    this.followUp.set(`${threadKey}:${userId}`, { startedAt: nowMs, turns: 0 })
  }

  // 续话窗：**不刷新 startedAt**，防止两人交替说话导致她永不过期、每条必回。
  inFollowUp(threadKey: string, userId: string, nowMs = Date.now()): boolean {
    if (!threadKey.startsWith('qq:group:')) return false
    const key = `${threadKey}:${userId}`
    const w = this.followUp.get(key)
    if (!w) return false
    if (nowMs - w.startedAt > this.cfg.followUpWindowMs || w.turns >= this.cfg.followUpMaxTurns) {
      this.followUp.delete(key)
      return false
    }
    w.turns += 1
    this.followUp.set(key, w)
    return true
  }

  // 廉价前置门（纯代码 0 token）：过门后才允许调用模型判插话。
  checkCheapGate(threadKey: string, text: string, opts: { atMe?: boolean; logOnly?: boolean; nowMs?: number } = {}): { worthJudging: boolean; sinceBotSpoke: number } {
    const nowMs = opts.nowMs ?? Date.now()
    const g = this.watch.get(threadKey) ?? { lastJudgeAt: 0, sinceBotSpoke: 99 }
    if (opts.logOnly) return { worthJudging: false, sinceBotSpoke: g.sinceBotSpoke }
    g.sinceBotSpoke += 1
    this.watch.set(threadKey, g)
    if (!this.cfg.enabled || opts.atMe) return { worthJudging: false, sinceBotSpoke: g.sinceBotSpoke }
    if (nowMs - g.lastJudgeAt < this.cfg.judgeGapMs) return { worthJudging: false, sinceBotSpoke: g.sinceBotSpoke }
    if (g.sinceBotSpoke < this.cfg.minSinceBotSpoke) return { worthJudging: false, sinceBotSpoke: g.sinceBotSpoke }
    const t = text.trim()
    if (t.length < this.cfg.minChars) return { worthJudging: false, sinceBotSpoke: g.sinceBotSpoke }
    if (/^[\p{P}\p{S}\s]+$/u.test(t)) return { worthJudging: false, sinceBotSpoke: g.sinceBotSpoke }
    g.lastJudgeAt = nowMs
    this.watch.set(threadKey, g)
    return { worthJudging: true, sinceBotSpoke: g.sinceBotSpoke }
  }
}

const ChimeVerdictSchema = z.object({
  kind: z.enum(CHIME_KINDS),
  mentionSpeaker: z.boolean().default(false),
})

export interface ChimeVerdict {
  speak: number
  kind: ChimeKind
  mentionUserId: string | null
}

// 群聊插话分类：模型只做离散分类（about_me/question/comfort/chat/noise），分数与冷却由确定性表控制。
export async function decideGroupChime(
  deps: { model: ChatModel | null; store: SoulStore; priceTable?: PriceTable },
  inp: {
    traceId: string
    botName: string
    recentText: string
    currentText: string
    speakerName: string
    speakerId: string
    speakerStage?: string
    speakerStrained?: boolean
    sinceBotSpoke: number
    activity: ActiveActivity | null
  },
  signal?: AbortSignal,
): Promise<ChimeVerdict | null> {
  if (!deps.model) return null
  // 对处于明显反感状态的人，在群里不主动凑上去搭话（0 token）
  if (inp.speakerStage === 'hostile') return null
  const busyNote = inp.activity ? `\n她此刻正在${inp.activity.place}，${inp.activity.label}，正忙着。` : ''
  const system = `判断群里刚说的这一句话属于哪一类（不是写回复）。只输出 JSON：{"kind":"about_me|question|comfort|chat|noise","mentionSpeaker":false}
- about_me：在议论「${inp.botName}」、喊她名字、或问明显只有她能答的事
- question：有人在提问等回答
- comfort：有人直接表达负面情绪（累、烦、难受、想哭、撑不住）
- chat：普通日常闲聊（默认）
- noise：纯应和、单字、哈哈、表情`

  const user = `${inp.recentText ? `刚才群里聊到：\n${inp.recentText}\n\n` : ''}焦点（${inp.speakerName} 刚说的）：「${inp.currentText}」${busyNote}`

  try {
    const res = await deps.model.complete({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      reasoningEffort: 'low',
      temperature: 0,
      signal,
    })
    deps.store.recordTokens({
      scene: 'group_chime',
      model: res.model,
      inputTokens: res.usage.inputTokens,
      cachedTokens: res.usage.cachedTokens,
      outputTokens: res.usage.outputTokens,
      reasoningTokens: res.usage.reasoningTokens,
      estCostCny: estimateCostCny(res.usage, deps.priceTable),
    })
    const m = res.content.match(/\{[\s\S]*\}/)
    if (!m) return null
    const parsed = ChimeVerdictSchema.safeParse(JSON.parse(m[0]))
    if (!parsed.success) return null
    const { kind, mentionSpeaker } = parsed.data
    // 刚说过话且不是叫她 → 不抢话；正在忙或与发言者关系有疙瘩时降低主动插话倾向
    let speak = inp.sinceBotSpoke < 3 && kind !== 'about_me' ? 0 : CHIME_SCORES[kind]
    if (inp.activity && kind !== 'about_me') speak *= 0.65
    if (inp.speakerStrained && kind !== 'about_me') speak *= 0.55
    return {
      speak,
      kind,
      mentionUserId: mentionSpeaker ? inp.speakerId : null,
    }
  } catch (e) {
    deps.store.logTrace({
      traceId: inp.traceId,
      event: 'group_chime_error',
      level: 'warn',
      data: { error: (e as Error).message.slice(0, 160) },
    })
    return null
  }
}

const ShouldWaitSchema = z.object({ wait: z.boolean() })

// 群聊动态等待（话轮判断）：话明显停在半句时多等一轮；失败立刻回 false（不拖延）。
export async function decideShouldWait(
  deps: { model: ChatModel | null; store: SoulStore; priceTable?: PriceTable },
  inp: { recent: string; pending: string },
  signal?: AbortSignal,
): Promise<boolean> {
  if (!deps.model) return false
  // 明显以句末收尾词结束时直接不等（0 token 快捷判定）
  if (/(?:好的|行|谢谢|哈哈+|拜拜|晚安|收到)[。！？!?~～]*$/.test(inp.pending.trim())) return false
  try {
    const res = await deps.model.complete({
      messages: [
        { role: 'system', content: '判断群里刚发出的话是否明显还没说完（停在半句、正在连续补充）。只输出 JSON：{"wait":true|false}' },
        { role: 'user', content: `${inp.recent ? `前文：\n${inp.recent}\n\n` : ''}刚收到：\n${inp.pending}` },
      ],
      reasoningEffort: 'low',
      temperature: 0,
      signal,
    })
    deps.store.recordTokens({
      scene: 'batch_wait',
      model: res.model,
      inputTokens: res.usage.inputTokens,
      cachedTokens: res.usage.cachedTokens,
      outputTokens: res.usage.outputTokens,
      reasoningTokens: res.usage.reasoningTokens,
      estCostCny: estimateCostCny(res.usage, deps.priceTable),
    })
    const m = res.content.match(/\{[\s\S]*\}/)
    if (!m) return false
    const parsed = ShouldWaitSchema.safeParse(JSON.parse(m[0]))
    return parsed.success && parsed.data.wait
  } catch {
    return false
  }
}
