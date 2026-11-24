// 故事化三轴关系引擎：trust / closeness / valence 正交 + 信任不对称曲线 + 未解心结（Tension）+ 修复（Repair）闭环。
// 铁律：上下文只给客观事实（称呼、阶段、时间跨度、共同故事、未说开的疙瘩），绝不塞行为命令。
import { randomUUID } from 'node:crypto'
import type { Feel, MemoryItem, RelationRecord, RelationTension, SoulStore } from '../../shared/ports.ts'
import { formatTimeSpan, nowLocal, todayLocal } from '../../shared/time.ts'

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

// 信任不对称：建立靠细水长流，伤害一次就会留下明显裂痕；真诚道歉/说开（repair）则能修复裂痕。
export const FEEL_DELTA: Record<Feel, { trust?: number; closeness?: number; valence?: number }> = {
  'better+': { trust: 0.008, closeness: 0.01, valence: 0.015 },
  'better++': { trust: 0.02, closeness: 0.025, valence: 0.04 },
  'worse+': { trust: -0.04, closeness: -0.035, valence: -0.075 },
  'worse++': { trust: -0.12, closeness: -0.09, valence: -0.18 },
  repair: { trust: 0.045, closeness: 0.03, valence: 0.095 },
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

export function valenceBand(v: number): 'dislike' | 'cold' | 'neutral' | 'warm' | 'fond' {
  if (v <= -0.45) return 'dislike'
  if (v <= -0.16) return 'cold'
  if (v < 0.2) return 'neutral'
  if (v < 0.6) return 'warm'
  return 'fond'
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
    if (saved) return { ...saved, tensions: Array.isArray(saved.tensions) ? saved.tensions : [] }
    return {
      userId,
      callName: this.identityCall,
      customCall: false,
      type: this.defaultType,
      stage: 'stranger',
      trust: 0.3,
      closeness: 0.15,
      valence: 0,
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

  // 双向关系演化 + 修复通道：
  // - 正面信号连续同类出现温和递减（防止刷好感）；
  // - 负面信号（worse+ / worse++）在短时内不打折削弱，且亲近者的严重伤害对信任打击更重；
  // - repair（道歉/解释/说开）同时拉升关系并消解未解心结。
  applyFeel(
    userId: string,
    feel: Feel,
    kind: string,
    now: Date = new Date(),
    tensionNote?: string,
  ): RelationRecord {
    const r = this.get(userId)
    this.decayTensionsInPlace(r, now)
    const delta = FEEL_DELTA[feel]
    if (Object.keys(delta).length > 0) {
      const prev = r.streaks[kind]
      const gapDays = prev ? (now.getTime() - Date.parse(prev.lastAt)) / 86_400_000 : Number.POSITIVE_INFINITY
      const count = gapDays > STREAK_GRACE_DAYS ? 1 : (prev?.count ?? 0) + 1
      r.streaks[kind] = { count, lastAt: now.toISOString() }

      const isPos = feel === 'better+' || feel === 'better++'
      const isMinorNeg = feel === 'worse+'
      const isSevereNeg = feel === 'worse++'
      const streakFactor = isPos ? Math.pow(STREAK_DECAY, Math.max(0, count - 1)) : 1
      // 轻度摩擦在非常喜欢时有轻微缓冲（0.85）；严重冒犯绝不打折，亲近者反而更伤信任（1.15）
      const band = valenceBand(r.valence)
      const valenceScale = isMinorNeg && band === 'fond' ? 0.85 : 1
      const trustScale = isSevereNeg && (r.stage === 'trusted' || r.stage === 'bonded') ? 1.15 : valenceScale

      if (delta.trust !== undefined) r.trust = clamp(r.trust + delta.trust * streakFactor * trustScale, 0.05, 0.95)
      if (delta.closeness !== undefined) r.closeness = clamp(r.closeness + delta.closeness * streakFactor * valenceScale, 0.05, 0.95)
      if (delta.valence !== undefined) r.valence = clamp(r.valence + delta.valence * streakFactor * valenceScale, -1, 1)

      if ((isMinorNeg || isSevereNeg) && tensionNote?.trim()) {
        this.pushTensionInPlace(r, {
          text: tensionNote.trim().slice(0, 90),
          severity: isSevereNeg ? 0.78 : 0.42,
          now,
        })
      }
      if (feel === 'repair') {
        this.softenTensionInPlace(r, 0.48)
      }
    }
    r.feels = [...r.feels, { at: now.toISOString(), feel, kind }].slice(-40)
    this.recomputeStage(r)
    this.store.saveRelation(r)
    return r
  }

  addTension(userId: string, inp: { text: string; severity: number; now?: Date }): RelationRecord {
    const r = this.get(userId)
    this.pushTensionInPlace(r, { text: inp.text.trim().slice(0, 90), severity: inp.severity, now: inp.now ?? new Date() })
    this.recomputeStage(r)
    this.store.saveRelation(r)
    return r
  }

  tensionScore(userId: string): number {
    const r = this.get(userId)
    if (r.tensions.length === 0) return 0
    return clamp(r.tensions.reduce((mx, t) => Math.max(mx, t.severity), 0), 0, 1)
  }

  isStrained(userId: string): boolean {
    const r = this.get(userId)
    return r.stage === 'hostile' || r.stage === 'distant' || this.tensionScore(userId) >= 0.4
  }

  private pushTensionInPlace(r: RelationRecord, inp: { text: string; severity: number; now: Date }): void {
    if (!inp.text) return
    const sev = clamp(inp.severity, 0.2, 1)
    const norm = (s: string): string => s.replace(/[\s，。！？,.!?]/g, '')
    const existing = r.tensions.find((t) => norm(t.text).includes(norm(inp.text).slice(0, 8)) || norm(inp.text).includes(norm(t.text).slice(0, 8)))
    if (existing) {
      existing.severity = clamp(Math.max(existing.severity, sev) + 0.15, 0.2, 1)
      existing.createdAt = nowLocal(inp.now)
      return
    }
    const item: RelationTension = {
      id: `ten_${randomUUID().slice(0, 8)}`,
      text: inp.text,
      severity: sev,
      createdAt: nowLocal(inp.now),
    }
    r.tensions = [...r.tensions, item]
      .sort((a, b) => b.severity - a.severity)
      .slice(0, MAX_TENSIONS)
  }

  private softenTensionInPlace(r: RelationRecord, amount: number): void {
    if (r.tensions.length === 0) return
    const next: RelationTension[] = []
    let remaining = amount
    // 优先缓解最新或最轻的疙瘩，认真多次安抚才能化开深疙瘩
    for (let i = r.tensions.length - 1; i >= 0; i--) {
      const t = { ...r.tensions[i]! }
      if (remaining > 0) {
        const drop = Math.min(t.severity, remaining)
        t.severity = Number((t.severity - drop).toFixed(2))
        remaining = Math.max(0, remaining - drop * 0.7)
      }
      if (t.severity >= 0.18) next.unshift(t)
    }
    r.tensions = next
  }

  // 轻度摩擦过一周以上自然淡化；重度疙瘩（>=0.7）保留更久，需要真正说开。
  private decayTensionsInPlace(r: RelationRecord, now: Date): void {
    if (r.tensions.length === 0) return
    const kept: RelationTension[] = []
    for (const t of r.tensions) {
      const at = Date.parse(t.createdAt.replace(' ', 'T'))
      const ageDays = Number.isFinite(at) ? Math.max(0, (now.getTime() - at) / 86_400_000) : 0
      if (ageDays > 7 && t.severity < 0.7) {
        const decayed = Number((t.severity - (ageDays - 7) * 0.06).toFixed(2))
        if (decayed >= 0.18) kept.push({ ...t, severity: decayed })
      } else if (ageDays > 21) {
        const decayed = Number((t.severity - (ageDays - 21) * 0.03).toFixed(2))
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
    // 带着极重未解心结时，关系上限暂时压在 distant/acquaintance，防止表面笑脸相迎
    const maxTen = r.tensions.reduce((mx, t) => Math.max(mx, t.severity), 0)
    if (maxTen >= 0.85 && r.valence < 0.15) {
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
    // 从负面状态恢复时，先落在 acquaintance，避免一步弹回深交
    const wasNeg = r.stage === 'hostile' || r.stage === 'distant'
    if (wasNeg && STAGE_ORDER.indexOf(cur) > STAGE_ORDER.indexOf('acquaintance')) {
      cur = 'acquaintance'
    }
    r.stage = cur
  }

  // 生成“纯事实 + 共同故事 + 未解心结 + 时间跨度”的关系段落（无命令、无数值）。
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
    if (band === 'dislike') lines.push('之前和他的相处让你很不舒服，心里有明显反感与防备。')
    else if (band === 'cold') lines.push('之前和他的相处让你有些疏远，心里还没完全放下。')
    else if (band === 'fond' && r.tensions.length === 0) lines.push('你很喜欢这个人，和他在一起心里放松。')

    if (r.tensions.length > 0) {
      lines.push('你们之间还有没说开的疙瘩：')
      for (const ten of r.tensions) {
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
