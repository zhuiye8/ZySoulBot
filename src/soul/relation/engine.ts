// 故事化三轴关系引擎：trust / closeness / valence 正交 + 债务封顶与重复折损修复（防刷好感套利）+ NSO 情感覆盖 + 反向愧疚心结。
// 铁律：上下文只给带原话与频次的客观事实，绝不塞行为命令。
import { randomUUID } from 'node:crypto'
import type { Feel, MemoryItem, RelationRecord, RelationTension, SoulStore } from '../../shared/ports.ts'
import { formatTimeSpan, nowLocal, todayLocal } from '../../shared/time.ts'

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

// 信任不对称：正面细水长流，负面伤害留债；口头 repair 不再给固定大额加分，改为严格按未解债务封顶返还（≤75%）。
export const FEEL_DELTA: Record<Feel, { trust?: number; closeness?: number; valence?: number }> = {
  'better+': { trust: 0.008, closeness: 0.01, valence: 0.015 },
  'better++': { trust: 0.02, closeness: 0.025, valence: 0.04 },
  'worse+': { trust: -0.04, closeness: -0.035, valence: -0.075 },
  'worse++': { trust: -0.12, closeness: -0.09, valence: -0.18 },
  repair: {}, // 严格走债务封顶计算，绝不允许“冒犯+道歉”产生净正套利！
  same: {},
  unclear: {},
}

const STAGE_RULES = [
  { stage: 'acquaintance', turns: 3, trust: 0, closeness: 0 },
  { stage: 'familiar', turns: 20, trust: 0.4, closeness: 0.25 },
  { stage: 'trusted', turns: 60, trust: 0.6, closeness: 0.5 },
  { stage: 'bonded', turns: 150, trust: 0.8, closeness: 0.7 },
] as const

const STAGE_ORDER = ['hostile', 'distant', 'stranger', 'acquaintance', 'familiar', 'trusted', 'bonded']
const STAGE_LABEL: Record<string, string> = {
  hostile: '反感',
  distant: '疏远',
  stranger: '初识',
  acquaintance: '认识',
  familiar: '熟悉',
  trusted: '信任',
  bonded: '深交',
}

const STREAK_DECAY = 0.78
const STREAK_GRACE_DAYS = 3
const MAX_TENSIONS = 3
const ORAL_REPAIR_MAX_RATIO = 0.75 // 口头道歉最多返还原始伤害的 75%，余下 25% 必须靠多日稳定相处填平

export type SentimentRegime = 'PSO' | 'NEUTRAL' | 'NSO'

export function valenceBand(v: number): 'dislike' | 'cold' | 'neutral' | 'warm' | 'fond' {
  if (v <= -0.45) return 'dislike'
  if (v <= -0.16) return 'cold'
  if (v < 0.2) return 'neutral'
  if (v < 0.6) return 'warm'
  return 'fond'
}

function normalizeTension(raw: Partial<RelationTension>): RelationTension {
  return {
    id: raw.id || `ten_${randomUUID().slice(0, 8)}`,
    source: raw.source === 'self' ? 'self' : 'user',
    text: String(raw.text ?? ''),
    topicTag: String(raw.topicTag ?? 'friction'),
    severity: clamp(Number(raw.severity ?? 0.5), 0.2, 1),
    debtTrust: Math.max(0, Number(raw.debtTrust ?? 0.04)),
    debtCloseness: Math.max(0, Number(raw.debtCloseness ?? 0.035)),
    debtValence: Math.max(0, Number(raw.debtValence ?? 0.075)),
    repaidRatio: clamp(Number(raw.repaidRatio ?? 0), 0, ORAL_REPAIR_MAX_RATIO),
    repeatCount: Math.max(0, Number(raw.repeatCount ?? 0)),
    clearAirAsked: Boolean(raw.clearAirAsked),
    createdAt: String(raw.createdAt ?? nowLocal()),
  }
}

export class RelationEngine {
  private store: SoulStore
  readonly defaultType: string
  readonly identityCall: string | null

  constructor(store: SoulStore, opts: { defaultType?: string; identityCall?: string } = {}) {
    this.store = store
    this.defaultType = opts.defaultType ?? 'friend'
    this.identityCall = opts.identityCall ?? null
  }

  get(userId: string): RelationRecord {
    const saved = this.store.getRelation(userId)
    if (saved) {
      return {
        ...saved,
        disengagement: clamp(Number(saved.disengagement ?? 0), 0, 1),
        tensions: Array.isArray(saved.tensions) ? saved.tensions.map(normalizeTension) : [],
      }
    }
    return {
      userId,
      callName: this.identityCall,
      customCall: false,
      type: this.defaultType,
      stage: 'stranger',
      trust: 0.3,
      closeness: 0.15,
      valence: 0,
      disengagement: 0,
      turns: 0,
      firstSeen: null,
      lastSeen: null,
      feels: [],
      streaks: {},
      windows: {},
      tensions: [],
    }
  }

  nameOf(userId: string, fallback?: string): string {
    const r = this.get(userId)
    if (r.customCall && r.callName) return r.callName
    if (fallback && fallback.trim() && fallback.trim() !== userId) return fallback.trim()
    return r.callName || userId
  }

  // 计算近 14 天正负互动比（Gottman 情感覆盖判定依据）
  posNegRatio14d(userId: string, now: Date = new Date()): { pos: number; neg: number; ratio: number } {
    const r = this.get(userId)
    const cutoff = now.getTime() - 14 * 86_400_000
    let pos = 0
    let neg = 0
    for (const f of r.feels) {
      const at = Date.parse(f.at)
      if (!Number.isFinite(at) || at < cutoff) continue
      if (f.feel === 'better+' || f.feel === 'better++' || f.feel === 'repair') pos++
      else if (f.feel === 'worse+' || f.feel === 'worse++') neg++
    }
    return { pos, neg, ratio: neg === 0 ? (pos > 0 ? 10 : 5) : pos / neg }
  }

  sentimentRegime(userId: string, now: Date = new Date()): SentimentRegime {
    const r = this.get(userId)
    const { neg, ratio } = this.posNegRatio14d(userId, now)
    const hasRepeat = r.tensions.some((t) => t.source === 'user' && t.repeatCount >= 2)
    if (hasRepeat || (neg >= 2 && ratio < 2.0) || r.stage === 'hostile') return 'NSO'
    if (ratio >= 4.5 && r.valence >= 0.2 && r.tensions.filter((t) => t.source === 'user').length === 0) return 'PSO'
    return 'NEUTRAL'
  }

  noteTurn(userId: string, opts: { displayName?: string; now?: Date }): RelationRecord {
    const now = opts.now ?? new Date()
    const today = todayLocal(now)
    const r = this.get(userId)
    const nm = opts.displayName?.trim() ?? ''
    if (nm && nm !== userId && !r.customCall) {
      r.callName = nm
    }
    r.turns += 1
    r.firstSeen = r.firstSeen ?? today
    r.lastSeen = today
    this.decayTensionsInPlace(r, now)
    this.recomputeStage(r)
    this.store.saveRelation(r)
    return r
  }

  setCall(userId: string, callName: string): RelationRecord {
    const r = this.get(userId)
    const clean = callName.trim().slice(0, 16)
    if (clean && clean !== userId) {
      r.callName = clean
      r.customCall = true
      this.store.saveRelation(r)
    }
    return r
  }

  // 双向关系演化 + 债务封顶修复（P0-1：彻底根除冒犯-道歉刷好感套利）
  applyFeel(
    userId: string,
    feel: Feel,
    kind: string,
    now: Date = new Date(),
    tensionNote?: string,
  ): RelationRecord {
    const r = this.get(userId)
    this.decayTensionsInPlace(r, now)

    const prev = r.streaks[kind]
    const gapDays = prev ? (now.getTime() - Date.parse(prev.lastAt)) / 86_400_000 : Number.POSITIVE_INFINITY
    const count = gapDays > STREAK_GRACE_DAYS ? 1 : (prev?.count ?? 0) + 1

    if (feel === 'repair') {
      this.applyDebtCappedRepairInPlace(r, now)
    } else {
      const delta = FEEL_DELTA[feel]
      if (Object.keys(delta).length > 0) {
        r.streaks[kind] = { count, lastAt: now.toISOString() }
        const isPos = feel === 'better+' || feel === 'better++'
        const isMinorNeg = feel === 'worse+'
        const isSevereNeg = feel === 'worse++'
        const streakFactor = isPos ? Math.pow(STREAK_DECAY, Math.max(0, count - 1)) : 1
        const band = valenceBand(r.valence)
        const valenceScale = isMinorNeg && band === 'fond' ? 0.85 : 1
        const trustScale = isSevereNeg && (r.stage === 'trusted' || r.stage === 'bonded') ? 1.15 : valenceScale

        const appliedTrust = (delta.trust ?? 0) * streakFactor * trustScale
        const appliedClose = (delta.closeness ?? 0) * streakFactor * valenceScale
        const appliedValence = (delta.valence ?? 0) * streakFactor * valenceScale

        r.trust = clamp(r.trust + appliedTrust, 0.05, 0.95)
        r.closeness = clamp(r.closeness + appliedClose, 0.05, 0.95)
        r.valence = clamp(r.valence + appliedValence, -1, 1)

        if (isPos) {
          r.disengagement = clamp(r.disengagement - (feel === 'better++' ? 0.05 : 0.025), 0, 1)
        }
        if (isMinorNeg || isSevereNeg) {
          const topic = kind.trim().toLowerCase() || 'friction'
          const repeated = this.countRecentTopicRepeats(r, topic, now)
          if (isSevereNeg || repeated > 0) {
            r.disengagement = clamp(r.disengagement + (isSevereNeg ? 0.16 : 0.08 * (1 + repeated * 0.4)), 0, 1)
          }
          const note = tensionNote?.trim() || (isSevereNeg ? '刚才的言行让我很受伤' : '刚才的语气让我不太舒服')
          this.pushTensionInPlace(r, {
            source: 'user',
            text: note.slice(0, 90),
            topicTag: topic,
            severity: isSevereNeg ? 0.78 : 0.42,
            debtTrust: Math.abs(appliedTrust),
            debtCloseness: Math.abs(appliedClose),
            debtValence: Math.abs(appliedValence),
            repeatCount: repeated,
            now,
          })
        }
      }
    }

    r.feels = [...r.feels, { at: now.toISOString(), feel, kind }].slice(-50)
    this.recomputeStage(r)
    this.store.saveRelation(r)
    return r
  }

  // v2.1：她自己做错事/工具失败/记忆幻觉被纠正 → 挂入 source:'self' 愧疚心结（驱动 make_amends）
  addSelfTension(userId: string, text: string, severity = 0.55, now: Date = new Date()): RelationRecord {
    const r = this.get(userId)
    this.pushTensionInPlace(r, {
      source: 'self',
      text: text.trim().slice(0, 90),
      topicTag: 'self_mistake',
      severity,
      debtTrust: 0,
      debtCloseness: 0,
      debtValence: 0,
      repeatCount: 0,
      now,
    })
    this.store.saveRelation(r)
    return r
  }

  resolveSelfTension(userId: string, tensionId: string): void {
    const r = this.get(userId)
    r.tensions = r.tensions.filter((t) => !(t.id === tensionId && t.source === 'self'))
    this.store.saveRelation(r)
  }

  markClearAirAsked(userId: string, tensionId: string): void {
    const r = this.get(userId)
    const target = r.tensions.find((t) => t.id === tensionId)
    if (target) {
      target.clearAirAsked = true
      this.store.saveRelation(r)
    }
  }

  tensionScore(userId: string): number {
    const r = this.get(userId)
    const userTensions = r.tensions.filter((t) => t.source === 'user')
    if (userTensions.length === 0) return 0
    return clamp(userTensions.reduce((mx, t) => Math.max(mx, t.severity), 0), 0, 1)
  }

  isStrained(userId: string): boolean {
    const r = this.get(userId)
    return r.stage === 'hostile' || r.stage === 'distant' || this.tensionScore(userId) >= 0.4
  }

  private countRecentTopicRepeats(r: RelationRecord, topicTag: string, now: Date): number {
    const cutoff = now.getTime() - 14 * 86_400_000
    let hits = 0
    for (const f of r.feels) {
      const at = Date.parse(f.at)
      if (!Number.isFinite(at) || at < cutoff) continue
      if ((f.feel === 'worse+' || f.feel === 'worse++') && f.kind.toLowerCase() === topicTag) hits++
    }
    return hits
  }

  // P0-1 债务封顶 + 重复折损修复：
  // 1) 若存在未偿清的 user 心结，口头 repair 累计最多返还原始伤害的 75%（η = 1 / (1 + 0.6 * repeatCount)）；
  // 2) 若无任何未解心结（平白无故刷道歉），仅按极微弱 0.5x better+ 处理，绝不给暴涨。
  private applyDebtCappedRepairInPlace(r: RelationRecord, now: Date): void {
    const userIdx = r.tensions.findIndex((t) => t.source === 'user' && t.repaidRatio < ORAL_REPAIR_MAX_RATIO)
    if (userIdx < 0) {
      r.trust = clamp(r.trust + 0.004, 0.05, 0.95)
      r.closeness = clamp(r.closeness + 0.005, 0.05, 0.95)
      r.valence = clamp(r.valence + 0.008, -1, 1)
      return
    }
    const t = { ...r.tensions[userIdx]! }
    const eta = 1 / (1 + 0.6 * t.repeatCount)
    const remainingCap = Math.max(0, ORAL_REPAIR_MAX_RATIO - t.repaidRatio)
    const stepRatio = Math.min(0.45 * eta, remainingCap)

    r.trust = clamp(r.trust + t.debtTrust * stepRatio, 0.05, 0.95)
    r.closeness = clamp(r.closeness + t.debtCloseness * stepRatio, 0.05, 0.95)
    r.valence = clamp(r.valence + t.debtValence * stepRatio, -1, 1)
    r.disengagement = clamp(r.disengagement - 0.06 * eta, 0, 1)

    t.repaidRatio = Number((t.repaidRatio + stepRatio).toFixed(3))
    t.severity = Number(Math.max(0, t.severity - stepRatio * 0.95).toFixed(2))
    if (t.repaidRatio >= ORAL_REPAIR_MAX_RATIO - 0.02 || t.severity < 0.18) {
      r.tensions.splice(userIdx, 1)
    } else {
      r.tensions[userIdx] = t
    }
    this.decayTensionsInPlace(r, now)
  }

  private pushTensionInPlace(
    r: RelationRecord,
    inp: {
      source: 'user' | 'self'
      text: string
      topicTag: string
      severity: number
      debtTrust: number
      debtCloseness: number
      debtValence: number
      repeatCount: number
      now: Date
    },
  ): void {
    if (!inp.text) return
    const sev = clamp(inp.severity, 0.2, 1)
    const norm = (s: string): string => s.replace(/[\s，。！？,.!?]/g, '')
    const existing = r.tensions.find((t) =>
      t.source === inp.source
      && (t.topicTag === inp.topicTag
        || norm(t.text).includes(norm(inp.text).slice(0, 8))
        || norm(inp.text).includes(norm(t.text).slice(0, 8))),
    )
    if (existing) {
      existing.severity = clamp(Math.max(existing.severity, sev) + 0.14, 0.2, 1)
      existing.debtTrust = Number((existing.debtTrust + inp.debtTrust).toFixed(4))
      existing.debtCloseness = Number((existing.debtCloseness + inp.debtCloseness).toFixed(4))
      existing.debtValence = Number((existing.debtValence + inp.debtValence).toFixed(4))
      existing.repeatCount = Math.max(existing.repeatCount + 1, inp.repeatCount)
      existing.repaidRatio = 0 // 再次冒犯时，之前的口头哄劝失效
      existing.text = inp.text
      existing.createdAt = nowLocal(inp.now)
      return
    }
    const item: RelationTension = {
      id: `ten_${randomUUID().slice(0, 8)}`,
      source: inp.source,
      text: inp.text,
      topicTag: inp.topicTag,
      severity: sev,
      debtTrust: Number(inp.debtTrust.toFixed(4)),
      debtCloseness: Number(inp.debtCloseness.toFixed(4)),
      debtValence: Number(inp.debtValence.toFixed(4)),
      repaidRatio: 0,
      repeatCount: inp.repeatCount,
      clearAirAsked: false,
      createdAt: nowLocal(inp.now),
    }
    const weightOf = (t: RelationTension): number => {
      const at = Date.parse(t.createdAt.replace(' ', 'T'))
      const days = Number.isFinite(at) ? Math.max(0, (inp.now.getTime() - at) / 86_400_000) : 0
      const recency = Math.pow(0.5, days / 14)
      return t.severity * (0.65 + 0.35 * recency)
    }
    r.tensions = [...r.tensions, item]
      .sort((a, b) => weightOf(b) - weightOf(a))
      .slice(0, MAX_TENSIONS)
  }

  // 消除 18 天冷战死区：重度心结软化起算日随近 14 天健康互动比动态调节（健康互动多第 7 天起松动，零互动保持 21 天）
  private decayTensionsInPlace(r: RelationRecord, now: Date): void {
    if (r.tensions.length === 0) return
    const cutoff = now.getTime() - 14 * 86_400_000
    let pos = 0
    let neg = 0
    for (const f of r.feels) {
      const at = Date.parse(f.at)
      if (!Number.isFinite(at) || at < cutoff) continue
      if (f.feel === 'better+' || f.feel === 'better++' || f.feel === 'repair') pos++
      else if (f.feel === 'worse+' || f.feel === 'worse++') neg++
    }
    const ratio = neg === 0 ? (pos > 0 ? 6 : 0) : pos / neg
    const heavyStartDay = ratio >= 3.0 ? 7 : ratio >= 1.5 ? 14 : 21

    const kept: RelationTension[] = []
    for (const t of r.tensions) {
      const at = Date.parse(t.createdAt.replace(' ', 'T'))
      const ageDays = Number.isFinite(at) ? Math.max(0, (now.getTime() - at) / 86_400_000) : 0
      if (t.severity < 0.7 && ageDays > 7) {
        const decayed = Number((t.severity - (ageDays - 7) * 0.06).toFixed(2))
        if (decayed >= 0.18) kept.push({ ...t, severity: decayed })
      } else if (t.severity >= 0.7 && ageDays > heavyStartDay) {
        const decayed = Number((t.severity - (ageDays - heavyStartDay) * 0.04).toFixed(2))
        if (decayed >= 0.18) kept.push({ ...t, severity: decayed })
      } else {
        kept.push(t)
      }
    }
    r.tensions = kept
  }

  private recomputeStage(r: RelationRecord): void {
    const band = valenceBand(r.valence)
    if (band === 'dislike') { r.stage = 'hostile'; return }
    if (band === 'cold') { r.stage = 'distant'; return }
    const maxUserTen = r.tensions
      .filter((t) => t.source === 'user')
      .reduce((mx, t) => Math.max(mx, t.severity), 0)
    if (maxUserTen >= 0.85 && r.valence < 0.15) {
      r.stage = 'distant'
      return
    }
    let cur = 'stranger'
    for (const rule of STAGE_RULES) {
      if (r.turns >= rule.turns && r.trust >= rule.trust && r.closeness >= rule.closeness) {
        cur = rule.stage
      } else {
        break
      }
    }
    const wasNeg = r.stage === 'hostile' || r.stage === 'distant'
    if (wasNeg && STAGE_ORDER.indexOf(cur) > STAGE_ORDER.indexOf('acquaintance')) {
      cur = 'acquaintance'
    }
    r.stage = cur
  }

  // v2.1 法证式客观事实段落：带原话摘录、时间跨度、14天复发频次与双向心结（绝无命令式话术）
  renderRelationFacts(opts: {
    userId: string
    displayName?: string
    now: Date
    sharedStories: MemoryItem[]
    lastContactIso?: string | null
  }): string {
    const r = this.get(opts.userId)
    const who = this.nameOf(opts.userId, opts.displayName)
    const lines: string[] = []
    const stageText = STAGE_LABEL[r.stage] ?? r.stage
    lines.push(`眼前这位是 ${who}（相处：${stageText}）。`)
    if (this.identityCall && who !== this.identityCall) {
      lines.push(`「${this.identityCall}」是你在世界里对来访者的身份称呼，他的名字是 ${who}。`)
    }
    if (opts.lastContactIso) {
      const t = Date.parse(opts.lastContactIso.replace(' ', 'T'))
      if (Number.isFinite(t)) {
        const diff = opts.now.getTime() - t
        if (diff > 60_000) lines.push(`你们上次说话是 ${formatTimeSpan(diff)}。`)
      }
    }
    const band = valenceBand(r.valence)
    const userTensions = r.tensions.filter((t) => t.source === 'user')
    const selfTensions = r.tensions.filter((t) => t.source === 'self')
    if (band === 'dislike') lines.push('之前和他的相处让你很不舒服，心里有明显反感与防备。')
    else if (band === 'cold') lines.push('之前和他的相处让你有些疏远，心里还没完全放下。')
    else if (band === 'fond' && userTensions.length === 0) lines.push('你很喜欢这个人，和他在一起心里放松。')
    if (r.disengagement >= 0.55) {
      lines.push('近两周和他的反复摩擦让你心里有点发凉，提不起太多热络的劲头。')
    }

    if (userTensions.length > 0) {
      lines.push('你们之间还有没说开的疙瘩：')
      for (const ten of userTensions) {
        const repeatNote = ten.repeatCount > 0 ? `（近14天类似情况第 ${ten.repeatCount + 1} 次）` : ''
        lines.push(`- [${ten.createdAt.slice(5, 16)}] ${ten.text}${repeatNote}`)
      }
    }

    if (selfTensions.length > 0) {
      lines.push('你心里对他还留着点过意不去的事：')
      for (const ten of selfTensions) {
        lines.push(`- [${ten.createdAt.slice(5, 16)}] ${ten.text}`)
      }
    }

    if (opts.sharedStories.length > 0) {
      lines.push('你们一起经历或定下的事：')
      for (const s of opts.sharedStories) {
        lines.push(`- [${s.createdAt.slice(0, 10)}] ${s.text}`)
      }
    }
    return lines.join('\n')
  }
}
