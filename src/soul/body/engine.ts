// 身心闭环引擎：昼夜节律 + 精力/睡眠债 + PAD/Mood + 持久化情绪来由 + 活动双向反馈。
// 铁律：状态既进入机制参数（影响精力消耗、自主概率与回复节奏），也只以“客观身体感受与真实来由”进上下文，绝不给行为命令。
import type {
  ActiveActivity,
  ActivityDef,
  AffectKind,
  BodyState,
  PAD,
  SoulStore,
  TimeSlot,
  Traits,
} from '../../shared/ports.ts'
import { nowLocal } from '../../shared/time.ts'

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

const DRIVE_TARGETS: Record<string, number> = {
  companionship: 0.5,
  curiosity: 0.78,
  creative: 0.72,
}

const EFFECTS: Record<AffectKind, PAD> = {
  praised: { p: +0.08, a: +0.03, d: +0.02 },
  affection: { p: +0.12, a: +0.05, d: +0.03 },
  curiosity: { p: +0.06, a: +0.1, d: +0.02 },
  humor: { p: +0.07, a: +0.06, d: +0.01 },
  annoyed: { p: -0.1, a: +0.08, d: +0.02 },
  hurt: { p: -0.16, a: -0.02, d: -0.07 },
  rejected: { p: -0.15, a: +0.07, d: -0.05 },
  conflict: { p: -0.15, a: +0.12, d: +0.02 },
  sadness: { p: -0.08, a: -0.06, d: -0.03 },
  uneasy: { p: -0.07, a: +0.05, d: -0.05 },
  boredom: { p: -0.03, a: -0.06, d: -0.01 },
  neutral: { p: 0, a: 0, d: 0 },
}

const DRIVE_EFFECTS: Partial<Record<AffectKind, Record<string, number>>> = {
  affection: { companionship: -0.1 },
  praised: { companionship: -0.05 },
  curiosity: { curiosity: -0.12 },
  humor: { creative: -0.06, companionship: -0.04 },
  annoyed: { companionship: -0.09 },
  hurt: { companionship: -0.14 },
  rejected: { companionship: -0.12 },
  conflict: { companionship: -0.14 },
  uneasy: { companionship: -0.08 },
  sadness: { companionship: -0.04 },
}

const EVENT_VALENCE: Record<AffectKind, number> = {
  praised: 1,
  affection: 1,
  curiosity: 1,
  humor: 1,
  annoyed: -1,
  hurt: -1,
  rejected: -1,
  conflict: -1,
  sadness: -1,
  uneasy: -1,
  boredom: 0,
  neutral: 0,
}

export const NEGATIVE_AFFECT_KINDS = new Set<AffectKind>([
  'annoyed',
  'hurt',
  'rejected',
  'conflict',
  'sadness',
  'uneasy',
])
const PAD_KEYS = ['p', 'a', 'd'] as const

export function timeSlotOf(now: Date): TimeSlot {
  const h = now.getHours()
  if (h >= 5 && h < 11) return 'morning'
  if (h >= 11 && h < 14) return 'noon'
  if (h >= 14 && h < 18) return 'afternoon'
  if (h >= 18 && h < 22) return 'evening'
  return 'night'
}

export class BodyEngine {
  private store: SoulStore
  readonly traits: Required<Traits>
  readonly baseline: PAD
  private recentNeg: Array<{ kind: AffectKind; at: number }> = []

  constructor(store: SoulStore, traits?: Traits, baseline?: PAD) {
    this.store = store
    this.traits = {
      O: traits?.O ?? 0.95,
      C: traits?.C ?? 0.7,
      E: traits?.E ?? 0.45,
      A: traits?.A ?? 0.85,
      N: traits?.N ?? 0.25,
    }
    this.baseline = baseline ?? { p: 0.2, a: -0.08, d: 0.1 }
  }

  state(now: Date = new Date()): BodyState {
    const saved = this.store.getBodyState()
    if (saved) return saved
    const init: BodyState = {
      pad: { ...this.baseline },
      mood: { ...this.baseline },
      drives: { ...DRIVE_TARGETS },
      energy: 0.82,
      sleepDebt: 0.05,
      activity: null,
      lastTickAt: now.toISOString(),
      updatedAt: nowLocal(now),
    }
    this.store.saveBodyState(init)
    return init
  }

  // 墙钟演化：PAD/Mood 回基线（负面心境衰减更慢，不装作秒忘），驱力缓慢回升，精力按昼夜节律演化。
  tick(now: Date = new Date()): BodyState {
    const s = this.state(now)
    const last = Date.parse(s.lastTickAt)
    const dtHours = Number.isFinite(last) ? (now.getTime() - last) / 3_600_000 : 0
    if (!(dtHours > 0.008)) return s

    const decay = (cur: number, base: number, halfLifeHours: number): number =>
      base + (cur - base) * Math.pow(0.5, dtHours / halfLifeHours)

    // 负面情绪的即时消退慢于正面（5h vs 3h），底色心境 120h 缓慢回稳
    const padHalfLife = s.pad.p < this.baseline.p - 0.1 ? 5 : 3
    for (const k of PAD_KEYS) {
      s.pad[k] = clamp(decay(s.pad[k], this.baseline[k], padHalfLife), -1, 1)
      s.mood[k] = clamp(decay(s.mood[k], this.baseline[k], 120), -1, 1)
    }
    for (const k of Object.keys(DRIVE_TARGETS)) {
      const target = DRIVE_TARGETS[k] ?? 0.5
      s.drives[k] = clamp(decay(s.drives[k] ?? target, target, 12), 0, 1)
    }

    const hour = now.getHours()
    const isLateNight = hour >= 23 || hour < 6
    if (isLateNight && !s.activity && dtHours >= 2) {
      s.energy = clamp(s.energy + dtHours * 0.14, 0.15, 0.95)
      s.sleepDebt = clamp(s.sleepDebt - dtHours * 0.18, 0, 1)
    } else if (isLateNight) {
      s.energy = clamp(s.energy - dtHours * 0.08, 0.08, 1)
      s.sleepDebt = clamp(s.sleepDebt + dtHours * 0.07, 0, 1)
    } else {
      const targetEnergy = clamp(0.85 - s.sleepDebt * 0.35, 0.3, 0.9)
      s.energy = clamp(decay(s.energy, targetEnergy, 6), 0.1, 1)
      s.sleepDebt = clamp(s.sleepDebt - dtHours * 0.02, 0, 1)
    }

    s.lastTickAt = now.toISOString()
    s.updatedAt = nowLocal(now)
    this.store.saveBodyState(s)
    return s
  }

  // 说话或执行重活真实消耗精力（深夜聊越久越困）
  spendEnergy(cost: number, now: Date = new Date()): BodyState {
    const s = this.tick(now)
    const hour = now.getHours()
    const nightMult = hour >= 23 || hour < 6 ? 1.8 : 1
    s.energy = clamp(s.energy - Math.max(0, cost) * nightMult, 0.05, 1)
    if (hour >= 23 || hour < 6) {
      s.sleepDebt = clamp(s.sleepDebt + cost * 0.9, 0, 1)
    }
    s.updatedAt = nowLocal(now)
    this.store.saveBodyState(s)
    return s
  }

  // 情绪评估（支持对话与她自己的生活事件），持久化来由，重启不断片。
  appraise(inp: {
    source: 'chat' | 'life' | 'desire' | 'awaiting'
    affectKind: AffectKind
    intensity?: number
    confidence?: number
    text: string
    who?: string
    now?: Date
  }): BodyState {
    const now = inp.now ?? new Date()
    const s = this.tick(now)
    const kind = inp.affectKind
    const eff = EFFECTS[kind]
    const conf = clamp(inp.confidence ?? 1, 0, 1)
    const m = this.modulate(kind, inp.intensity) * conf * this.moodCongruent(s, kind) * this.negEscalation(kind, now)

    const applied: Partial<PAD> = {}
    const moodRatio = NEGATIVE_AFFECT_KINDS.has(kind) ? 0.45 : 0.35
    for (const k of PAD_KEYS) {
      const before = s.pad[k]
      s.pad[k] = clamp(s.pad[k] + eff[k] * m, -1, 1)
      s.mood[k] = clamp(s.mood[k] + eff[k] * m * moodRatio, -1, 1)
      applied[k] = Number((s.pad[k] - before).toFixed(3))
    }
    const de = DRIVE_EFFECTS[kind] ?? {}
    for (const [k, dv] of Object.entries(de)) {
      s.drives[k] = clamp((s.drives[k] ?? 0.5) + dv * m, 0, 1)
    }

    s.updatedAt = nowLocal(now)
    this.store.saveBodyState(s)

    if (kind !== 'neutral' && inp.text.trim()) {
      this.store.addEmotionCause({
        source: inp.source,
        who: inp.who?.trim() ?? '',
        text: inp.text.trim().slice(0, 120),
        affectKind: kind,
        delta: applied,
        createdAt: nowLocal(now),
      })
    }
    return s
  }

  startActivity(def: ActivityDef, thinking: string, minutes: number, now: Date = new Date()): ActiveActivity {
    const s = this.tick(now)
    const active: ActiveActivity = {
      id: def.id,
      label: def.label,
      place: def.place,
      thinking: thinking.trim(),
      thinkingAt: now.toISOString(),
      startedAt: now.toISOString(),
      endsAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
      yields: def.yields,
      effects: def.effects,
    }
    s.activity = active
    s.updatedAt = nowLocal(now)
    this.store.saveBodyState(s)
    return active
  }

  // 活动结束：真实回写精力、PAD 与驱力，形成身心闭环。
  completeActivityIfDue(now: Date = new Date(), force = false): ActiveActivity | null {
    const s = this.tick(now)
    const act = s.activity
    if (!act) return null
    if (!force && now.getTime() < Date.parse(act.endsAt)) return null

    if (act.effects) {
      if (typeof act.effects.energy === 'number') {
        s.energy = clamp(s.energy + act.effects.energy, 0.05, 1)
        if (act.effects.energy > 0.1) {
          s.sleepDebt = clamp(s.sleepDebt - act.effects.energy * 0.5, 0, 1)
        }
      }
      if (act.effects.pad) {
        for (const k of PAD_KEYS) {
          const dv = act.effects.pad[k]
          if (typeof dv === 'number') {
            s.pad[k] = clamp(s.pad[k] + dv, -1, 1)
            s.mood[k] = clamp(s.mood[k] + dv * 0.25, -1, 1)
          }
        }
      }
      if (act.effects.drives) {
        for (const [k, dv] of Object.entries(act.effects.drives)) {
          s.drives[k] = clamp((s.drives[k] ?? 0.5) + dv, 0, 1)
        }
      }
    }

    if (act.thinking) {
      this.store.addEmotionCause({
        source: 'life',
        who: '',
        text: `${act.label}：${act.thinking.slice(0, 80)}`,
        affectKind: (act.effects?.pad?.p ?? 0) >= 0.05 ? 'curiosity' : 'neutral',
        delta: act.effects?.pad ?? {},
        createdAt: nowLocal(now),
      })
    }

    s.activity = null
    s.updatedAt = nowLocal(now)
    this.store.saveBodyState(s)
    return act
  }

  // 生成“事实化、无指令”的此刻身心描述（用于末尾动态块，绝不报裸数字）。
  renderBodyFacts(now: Date = new Date(), hoursSinceContact?: number): string {
    const s = this.tick(now)
    const lines: string[] = []

    // 1) 最近 6 小时内真实发生过的情绪来由（最多 2 条）
    const causes = this.store.recentEmotionCauses(4).filter((c) => {
      const t = Date.parse(c.createdAt.replace(' ', 'T'))
      return Number.isFinite(t) && now.getTime() - t < 6 * 3_600_000
    }).slice(-2)
    for (const c of causes) {
      if (c.source === 'life') lines.push(`刚才自己做了件事：${c.text}`)
      else lines.push(c.who ? `刚才${c.who}说：「${c.text}」` : `刚才发生的事：「${c.text}」`)
    }
    if (causes.length === 0 && hoursSinceContact !== undefined && hoursSinceContact >= 8) {
      const h = Math.round(hoursSinceContact)
      lines.push(h >= 24 ? `已经 ${Math.floor(h / 24)} 天没人来找你说话了。` : '今天一直很安静，没什么人来找你。')
    }

    // 2) 身体精力与睡眠债感受（客观陈述）
    if (s.energy < 0.28 || s.sleepDebt > 0.65) {
      lines.push('眼皮有点沉，脑子转得比平时慢一点。')
    } else if (s.energy < 0.48) {
      lines.push('稍微有点累，精力不太满。')
    } else if (s.energy > 0.8 && s.pad.a > 0.15) {
      lines.push('精神很清爽，身上轻快。')
    }

    // 3) 细粒度情绪与心境偏离（区分烦躁紧绷 vs 委屈发沉 vs 闷）
    const dp = s.pad.p - this.baseline.p
    const da = s.pad.a - this.baseline.a
    const dm = s.mood.p - this.baseline.p
    if (dp <= -0.32 && da >= 0.12) {
      lines.push('心里堵着一口气，有些烦躁，不太想勉强陪笑。')
    } else if (dp <= -0.32) {
      lines.push('心里很沉、带着委屈，兴致提不起来。')
    } else if (dp <= -0.16 && da >= 0.08) {
      lines.push('心里有点绷着，不太舒坦。')
    } else if (dp <= -0.16) {
      lines.push('心里有点闷，带着点说不出的疙瘩。')
    } else if (dp > 0.25) {
      lines.push('心情是松快的。')
    }
    if (dm < -0.16 && dp > -0.16) lines.push('这阵子心境底色一直略微发沉。')

    // 4) 驱力倾向（心情很差时不强推社交冲动）
    if ((s.drives.companionship ?? 0.5) > 0.66 && dp > -0.2) lines.push('有点想听听人声。')
    if ((s.drives.curiosity ?? 0.5) >= 0.74) lines.push('想看点没见过的东西。')
    if ((s.drives.creative ?? 0.5) >= 0.68) lines.push('手边有点想摆弄点什么。')

    // 5) 正在进行的活动
    if (s.activity) {
      lines.push(`你此刻正在${s.activity.place}，${s.activity.label}${s.activity.thinking ? `（心里在想：${s.activity.thinking}）` : ''}。`)
    }

    if (lines.length === 0) lines.push('和平常一样，没什么特别波动。')
    return lines.join('\n')
  }

  private modulate(kind: AffectKind, intensity?: number): number {
    const i = clamp(intensity ?? 0.55, 0, 1)
    // 温和人格同样会真的感到委屈或烦躁，不再被过度打折
    if (NEGATIVE_AFFECT_KINDS.has(kind)) return i * Math.max(0.55, 1.0 - this.traits.A * 0.22 + this.traits.N * 0.35)
    if (kind === 'curiosity') return i * (0.7 + this.traits.O * 0.5)
    if (kind === 'affection' || kind === 'praised') return i * (0.75 + this.traits.A * 0.35)
    return i
  }

  private moodCongruent(s: BodyState, kind: AffectKind): number {
    const v = EVENT_VALENCE[kind]
    if (v === 0) return 1
    const dev = s.mood.p - this.baseline.p
    return clamp(1 + 0.6 * dev * v, 0.55, 1.55)
  }

  // 短时负面累积放大曲线：连续被刺第 2、3 次越攒越难受/气愤，第 4 次后转为冷淡防御（而非越骂越麻木）。
  private negEscalation(kind: AffectKind, now: Date): number {
    if (!NEGATIVE_AFFECT_KINDS.has(kind)) return 1
    const ts = now.getTime()
    this.recentNeg = this.recentNeg.filter((e) => ts - e.at < 30 * 60_000)
    const count = this.recentNeg.length
    this.recentNeg.push({ kind, at: ts })
    if (this.recentNeg.length > 20) this.recentNeg.shift()
    if (count === 0) return 1.0
    if (count === 1) return 1.25
    if (count === 2) return 1.45
    return 0.85
  }
}
