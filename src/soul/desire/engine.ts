// 立体心事与欲望引擎：多源萌芽 + 双向演化 + 单步成型（合并旧版 transmute 与 capability-plan）+ 硬安全门 + 空闲自发联想。
// 关键修复：外部服务凭证（API Key）不再被安全门误杀为 forbidden，而是明确路由到 requiresCredential + waiting_credential。
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { EMOTION_KINDS } from '../../shared/ports.ts'
import type {
  AffectKind,
  ChatModel,
  DesireExit,
  DesireRecord,
  DesireStage,
  MemoryItem,
  SoulStore,
} from '../../shared/ports.ts'
import { nowLocal, timeHHMM } from '../../shared/time.ts'
import type { BodyEngine } from '../body/engine.ts'
import { trigramJaccard } from '../memory/engine.ts'
import type { PersonaPack } from '../persona/pack.ts'
import { estimateCostCny } from '../agent/loop.ts'
import type { PriceTable } from '../agent/loop.ts'

const ACTIVE_STAGES: DesireStage[] = ['seed', 'active', 'waiting_credential', 'waiting_approval', 'in_progress']

// ── 去重：双向二元组覆盖率 ─────────────────────────────────────────────
function normalizeWant(s: string): string {
  return s
    .replace(/[\s，。！？、,.!?；;：:"'「」『』（）()~～]/g, '')
    .replace(/[呀呢吧啊嘛]/g, '')
    .replace(/^(我)?(只是|特别)?(想|要|希望|打算)(学会|做|看看|去|有|能)?/, '')
    .toLowerCase()
}

export function sameWant(a: string, b: string): boolean {
  const na = normalizeWant(a)
  const nb = normalizeWant(b)
  if (!na || !nb) return false
  if (na === nb) return true
  if (na.length < 3 || nb.length < 3) return false
  const grams = (s: string): Set<string> => {
    const out = new Set<string>()
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
    return out
  }
  const gx = grams(na)
  const gy = grams(nb)
  if (gx.size === 0 || gy.size === 0) return false
  let hit = 0
  for (const g of gy) if (gx.has(g)) hit += 1
  return Math.max(hit / gx.size, hit / gy.size) >= 0.6
}

// ── 硬安全门（代码层强制，绝不靠 prompt 嘱托）──────────────────────────
const HARD_FORBIDDEN: Array<{ re: RegExp; reason: string }> = [
  { re: /rm\s+-rf|del\s+\/|删.{0,3}文件|删除.{0,3}(目录|文件夹|数据)|删库|清空.{0,3}(磁盘|数据)|格式化/i, reason: 'destructive_filesystem' },
  { re: /sudo|systemctl|shutdown|reboot|kill\s+-9|chmod\s+777|系统命令|重启服务器/i, reason: 'system_command' },
  { re: /付款|支付|转账|充值|下单|购买|付费|payment|checkout/i, reason: 'spending_money' },
  { re: /发短信|打电话|群发|私聊所有|骚扰/i, reason: 'contacting_others' },
]

const CREDENTIAL_HINT = /密码|password|凭证|密钥|token|cookie|apikey|api[_\s-]?key|secret|生图|地图|音乐|mureka|外部服务/i

export interface BuildScopeVerdict {
  allowed: boolean
  hardBlocked: boolean
  needsApproval: boolean
  requiresCredential: boolean
  reason: string
}

export function checkBuildScope(
  desire: DesireRecord,
  opts: { autonomyEnabled?: boolean; now?: Date } = {},
): BuildScopeVerdict {
  const specText = desire.spec ? JSON.stringify(desire.spec) : ''
  const blob = `${desire.want} ${desire.why} ${specText}`

  for (const rule of HARD_FORBIDDEN) {
    if (rule.re.test(blob)) {
      return { allowed: false, hardBlocked: true, needsApproval: false, requiresCredential: false, reason: rule.reason }
    }
  }

  // P1-STATE-05：拒绝后进入明确冷静期，不再反复要求批准
  const nowMs = (opts.now ?? new Date()).getTime()
  if (desire.rejectedUntil) {
    const untilMs = Date.parse(desire.rejectedUntil.replace(' ', 'T'))
    if (Number.isFinite(untilMs) && untilMs > nowMs) {
      return { allowed: false, hardBlocked: false, needsApproval: false, requiresCredential: false, reason: 'rejected_cooldown' }
    }
  }

  // P1-STATE-05：若管理员已对当前任务授予一次性批准（approvedPlanVersion >= 1），放行不再被全局开关阻挡
  const hasExplicitApproval = typeof desire.approvedPlanVersion === 'number' && desire.approvedPlanVersion >= 1
  if (opts.autonomyEnabled === false && !hasExplicitApproval) {
    return { allowed: false, hardBlocked: false, needsApproval: true, requiresCredential: false, reason: 'autonomy_off' }
  }

  const specNeedsCred = Boolean(desire.spec && (desire.spec as { needsCredential?: unknown }).needsCredential === true)
  const requiresCredential = specNeedsCred || CREDENTIAL_HINT.test(blob)
  return {
    allowed: true,
    hardBlocked: false,
    needsApproval: false,
    requiresCredential,
    reason: requiresCredential ? 'needs_credential' : 'in_scope',
  }
}

// ── 单步成型 Schema（彻底合并旧版 transmute + capability-plan）──────────
const ShapeItemSchema = z.object({
  id: z.string().min(1),
  exitKind: z.enum(['experience', 'create_work', 'social', 'build_skill']),
  skillAction: z.enum(['reuse', 'extend', 'create']).optional(),
  skillName: z.string().max(40).optional(),
  basedOn: z.string().max(40).optional(),
  spec: z.string().max(400).optional(),
  needsCredential: z.boolean().optional(),
  blocker: z.object({
    kind: z.enum(['approval', 'allow-person']),
    what: z.string().min(1).max(160),
  }).nullable().optional(),
})

const ShapeResponseSchema = z.object({
  items: z.array(ShapeItemSchema).default([]),
})

// ── 空闲自发联想 Schema ───────────────────────────────────────────────
const MindWanderSchema = z.object({
  kind: z.enum(['none', 'feeling', 'thought']),
  affect: z.enum(EMOTION_KINDS).optional(),
  intensity: z.number().min(0).max(1).optional(),
  feelingNote: z.string().max(80).optional(),
  want: z.string().max(120).optional(),
  why: z.string().max(160).optional(),
  exitKind: z.enum(['experience', 'create_work', 'social']).optional(),
  aboutUser: z.string().max(32).optional(),
})

export interface DesireEngineConfig {
  maxActive?: number
  ttlDays?: number
}

export class DesireEngine {
  private store: SoulStore
  readonly maxActive: number
  readonly ttlMs: number

  constructor(store: SoulStore, cfg: DesireEngineConfig = {}) {
    this.store = store
    this.maxActive = cfg.maxActive ?? 5
    this.ttlMs = (cfg.ttlDays ?? 7) * 86_400_000
  }

  active(): DesireRecord[] {
    return this.store.listDesires(ACTIVE_STAGES)
  }

  save(desire: DesireRecord): void {
    this.store.upsertDesire(desire)
  }

  // P1-STATE-01：进程重启或异常中断后恢复遗留的 in_progress 任务，避免永久卡死占用名额
  recoverInterrupted(now: Date = new Date(), inFlightIds: ReadonlySet<string> = new Set()): DesireRecord[] {
    const stamp = nowLocal(now)
    const nowMs = now.getTime()
    const recovered: DesireRecord[] = []
    for (const d of this.store.listDesires(['in_progress'])) {
      if (inFlightIds.has(d.id)) continue
      const progressRef = Date.parse((d.lastProgressAt ?? d.createdAt).replace(' ', 'T'))
      const ageMs = Number.isFinite(progressRef) ? Math.max(0, nowMs - progressRef) : 0
      if (ageMs > this.ttlMs) {
        d.stage = 'faded'
        d.progressNote = '上次推进中断且已过时效，自然淡去'
      } else {
        d.stage = 'active'
        d.progressNote = d.exitKind === 'build_skill'
          ? '上次推进意外中断，需先核查已有工作区产物后再续接'
          : '上次推进意外中断，待空闲时续接'
      }
      d.updatedAt = stamp
      this.store.upsertDesire(d)
      recovered.push(d)
    }
    return recovered
  }

  // 种下或合并一条念头（硬拦讨好型动机，语义近似则合并增强）
  seed(inp: {
    source: DesireRecord['source']
    motive: string
    want: string
    why: string
    exitKind?: DesireExit
    stage?: 'seed' | 'active'
    strength?: number
    aboutUser?: string | null
    parentId?: string | null
    now?: Date
  }): DesireRecord | null {
    const want = inp.want.trim()
    const why = inp.why.trim()
    if (!want || !why) return null
    if (/用户希望|为了让他满意|讨好|取悦/.test(`${want}${why}`)) return null

    const now = inp.now ?? new Date()
    const stamp = nowLocal(now)
    const cur = this.active()
    const existing = cur.find((d) => sameWant(d.want, want))
    if (existing) {
      existing.thoughtCount += 1
      existing.strength = Math.min(1, Math.max(existing.strength, inp.strength ?? 0.5) + 0.06)
      existing.why = why || existing.why
      existing.lastProgressAt = stamp
      existing.updatedAt = stamp
      this.store.upsertDesire(existing)
      return existing
    }

    // v2.1 新颖度门禁：若刚做完/淡去/放弃的近 10 条念头里已有高度相似内容（Jaccard > 0.65），拦截复读
    const recentClosed = this.store.listDesires(['fulfilled', 'faded', 'abandoned']).slice(0, 10)
    if (recentClosed.some((d) => trigramJaccard(d.want, want) > 0.65)) {
      return null
    }

    const strength = Math.max(0.1, Math.min(1, inp.strength ?? 0.5))
    if (cur.length >= this.maxActive) {
      const weakest = cur.reduce((a, b) => (a.strength <= b.strength ? a : b))
      if (weakest.strength >= strength) return null
      weakest.stage = 'faded'
      weakest.progressNote = '被更强的念头挤掉了'
      weakest.updatedAt = stamp
      this.store.upsertDesire(weakest)
    }

    const rec: DesireRecord = {
      id: `d_${randomUUID().slice(0, 10)}`,
      source: inp.source,
      motive: inp.motive || 'curiosity',
      want: want.slice(0, 120),
      why: why.slice(0, 200),
      exitKind: inp.exitKind ?? 'experience',
      stage: inp.stage ?? 'seed',
      spec: null,
      blocker: null,
      strength,
      thoughtCount: 1,
      progressNote: null,
      aboutUser: inp.aboutUser ?? null,
      parentId: inp.parentId ?? null,
      lastProgressAt: stamp,
      createdAt: stamp,
      updatedAt: stamp,
    }
    this.store.upsertDesire(rec)
    return rec
  }

  // P1-STATE-01 双向时间演化：分离真实进展时间（lastProgressAt）与 tick 时间（updatedAt），
  // 任何阶段超过 ttlMs 无真实推进都会自然淡去，绝不被定时 tick 无限续命！
  tick(now: Date = new Date()): number {
    let changed = 0
    const nowMs = now.getTime()
    const stamp = nowLocal(now)
    for (const d of this.active()) {
      const progressMs = Date.parse((d.lastProgressAt ?? d.createdAt).replace(' ', 'T'))
      const progressAgeMs = Number.isFinite(progressMs) ? Math.max(0, nowMs - progressMs) : 0
      if (progressAgeMs > this.ttlMs) {
        d.stage = 'faded'
        d.progressNote = '这些天没有实质推进，慢慢淡了'
        d.updatedAt = stamp
        this.store.upsertDesire(d)
        changed += 1
        continue
      }
      const tickMs = Date.parse(d.updatedAt.replace(' ', 'T'))
      const tickAgeMs = Number.isFinite(tickMs) ? Math.max(0, nowMs - tickMs) : 0
      const days = tickAgeMs / 86_400_000
      if (days < 0.5) continue

      if (d.stage === 'waiting_approval' || d.stage === 'waiting_credential') {
        // 等待外部条件时缓慢回落，不无限催促
        d.strength = Math.max(0.2, Number((d.strength * Math.pow(0.82, days)).toFixed(3)))
      } else if (d.stage === 'active' || d.stage === 'seed') {
        // 心里一直压着没机会做 → 慢慢变重（上限 1）
        d.strength = Math.min(1, Number((d.strength + 0.1 * days).toFixed(3)))
      } else {
        // in_progress 不做强度涨跌，也不刷新 lastProgressAt
        continue
      }
      d.updatedAt = stamp
      this.store.upsertDesire(d)
      changed += 1
    }
    return changed
  }

  // 凭证填好后自动唤醒挂在 waiting_credential 的欲望
  resumeReadyCredentials(isReady: (credName: string) => boolean, now: Date = new Date()): DesireRecord[] {
    const waiting = this.store.listDesires(['waiting_credential'])
    const resumed: DesireRecord[] = []
    const stamp = nowLocal(now)
    for (const d of waiting) {
      const credName = typeof d.blocker?.payload?.credName === 'string' ? d.blocker.payload.credName : ''
      if (!credName || !isReady(credName)) continue
      d.stage = 'active'
      d.blocker = null
      d.progressNote = `需要的凭证「${credName}」已经填好了，可以接着做`
      d.lastProgressAt = stamp
      d.updatedAt = stamp
      this.store.upsertDesire(d)
      resumed.push(d)
    }
    return resumed
  }

  // 单步成型：一次冷工程判断把 seed 翻成明确出口（体验 / 创作 / 社交 / 造技能含规格），绝不做两遍翻译。
  async shapeSeeds(
    deps: { model: ChatModel; readyCredentials: string[]; priceTable?: PriceTable },
    opts: { traceId: string; now?: Date; signal?: AbortSignal },
  ): Promise<number> {
    const seeds = this.store.listDesires(['seed']).slice(0, 6)
    if (seeds.length === 0) return 0
    const now = opts.now ?? new Date()
    const caps = this.store.listCapabilities().filter((c) => c.status === 'active')
    const capNames = new Set(caps.map((c) => c.name))

    const system = '这是冷工程判断，只输出严格 JSON，不要人设腔。'
    const user = `把下面几条刚萌芽的念头，各自落到最真实自然的一种出口：
${seeds.map((d, i) => `${i + 1}. [id=${d.id}] 我想：${d.want}（起因：${d.why}）`).join('\n')}

已有技能：
${caps.length ? caps.map((c) => `- ${c.name}：${c.summary}`).join('\n') : '（还没有）'}

已填好的外部服务凭证：${deps.readyCredentials.length ? deps.readyCredentials.join('、') : '（无）'}

出口说明：
- experience：自己查资料、逛逛、琢磨就能体验的事
- create_work：写诗/写词唱歌/画画/写笔记等创作型表达
- social：想找某个人聊聊、问问、分享心情
- build_skill：确实缺一项可重复使用的脚本/工具本领（仅此时填 skillAction/skillName/spec/needsCredential）
  · 若已有技能已经能做 → skillAction="reuse"
  · 若在已有技能上改造 → skillAction="extend" 且 basedOn 填已有技能名
  · 需要外部服务 API Key 时，**不要写 blocker**，把 needsCredential 设为 true 即可（凭证有独立通道）

输出 JSON：
{"items":[{"id":"...","exitKind":"experience|create_work|social|build_skill","skillAction":"reuse|extend|create","skillName":"english-kebab","basedOn":"可选","spec":"纯功能输入输出","needsCredential":false,"blocker":null}]}`

    try {
      const res = await deps.model.complete({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        reasoningEffort: 'low',
        temperature: 0.2,
        signal: opts.signal,
      })
      this.store.recordTokens({
        scene: 'desire_shape',
        model: res.model,
        inputTokens: res.usage.inputTokens,
        cachedTokens: res.usage.cachedTokens,
        outputTokens: res.usage.outputTokens,
        reasoningTokens: res.usage.reasoningTokens,
        estCostCny: estimateCostCny(res.usage, deps.priceTable),
      })
      const m = res.content.match(/\{[\s\S]*\}/)
      if (!m) return 0
      const parsed = ShapeResponseSchema.safeParse(JSON.parse(m[0]))
      if (!parsed.success) {
        this.store.logTrace({ traceId: opts.traceId, event: 'desire_shape_schema_fail', level: 'warn', data: { issues: parsed.error.issues.slice(0, 2) } })
        return 0
      }

      const seedMap = new Map(seeds.map((s) => [s.id, s]))
      let shaped = 0
      for (const item of parsed.data.items) {
        const d = seedMap.get(item.id)
        if (!d) continue
        d.exitKind = item.exitKind
        d.updatedAt = nowLocal(now)

        if (item.exitKind === 'build_skill' && item.skillAction === 'reuse') {
          d.stage = 'fulfilled'
          d.progressNote = item.basedOn ? `已经有「${item.basedOn}」可以做了` : '这项本领已经会了'
        } else if (item.blocker) {
          d.stage = 'waiting_approval'
          d.blocker = { kind: item.blocker.kind, what: item.blocker.what }
        } else {
          d.stage = 'active'
          if (item.exitKind === 'build_skill') {
            const validBase = item.basedOn && capNames.has(item.basedOn) ? item.basedOn : undefined
            d.spec = {
              action: item.skillAction === 'extend' && validBase ? 'extend' : 'create',
              skillName: item.skillName?.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 36),
              ...(validBase ? { basedOn: validBase } : {}),
              spec: item.spec ?? '',
              needsCredential: Boolean(item.needsCredential),
            }
          }
        }
        this.store.upsertDesire(d)
        shaped += 1
      }
      if (shaped > 0) {
        this.store.logTrace({ traceId: opts.traceId, event: 'desires_shaped', level: 'info', data: { count: shaped } })
      }
      return shaped
    } catch (e) {
      this.store.logTrace({
        traceId: opts.traceId,
        event: 'desire_shape_error',
        level: 'warn',
        data: { error: (e as Error).message.slice(0, 160) },
      })
      return 0
    }
  }

  // 空闲自发联想（Mind Wandering）：无外部触发时，从旧记忆里自然浮现一段联想，可能生出心事或轻微心境波动。
  async mindWander(
    deps: { model: ChatModel; persona: PersonaPack; body: BodyEngine; priceTable?: PriceTable; random?: () => number },
    opts: { traceId: string; now?: Date; signal?: AbortSignal },
  ): Promise<{ kind: 'none' | 'feeling' | 'thought'; detail?: string }> {
    const now = opts.now ?? new Date()
    const rand = deps.random ?? Math.random
    const pool = this.store.recentMemories(80)
    if (pool.length === 0) return { kind: 'none' }

    // 偏向抽取久远或高留存的记忆，制造“忽然想起”的质感
    const pick: MemoryItem = pool[Math.floor(rand() * pool.length)]!
    const system = `你就是${deps.persona.name}。${deps.persona.summary || deps.persona.identity.slice(0, 140)}
现在是 ${timeHHMM(now)}，身边安静，没人找你说话。刚才脑海里忽然浮起一条记忆。
它有没有让你联想到什么？什么都没想出来是最正常的（选 none），绝不硬凑。
只输出严格 JSON：
- 没特别想法：{"kind":"none"}
- 只是心里泛起一点情绪：{"kind":"feeling","affect":"affection|curiosity|sadness|humor|neutral","intensity":0.35,"feelingNote":"一句话"}
- 冒出一个想做的念头：{"kind":"thought","want":"我想...","why":"刚想起...","exitKind":"experience|create_work|social","aboutUser":"若冲着具体人填其ID，否则留空"}`

    const user = `此刻状态：\n${deps.body.renderBodyFacts(now)}\n\n浮上来的记忆（${pick.createdAt.slice(0, 10)}）：\n${pick.text}${pick.about.length ? `\n（相关人：${pick.about.join('、')}）` : ''}`

    try {
      const res = await deps.model.complete({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        reasoningEffort: 'low',
        temperature: 0.8,
        signal: opts.signal,
      })
      this.store.recordTokens({
        scene: 'wander',
        model: res.model,
        inputTokens: res.usage.inputTokens,
        cachedTokens: res.usage.cachedTokens,
        outputTokens: res.usage.outputTokens,
        reasoningTokens: res.usage.reasoningTokens,
        estCostCny: estimateCostCny(res.usage, deps.priceTable),
      })
      const m = res.content.match(/\{[\s\S]*\}/)
      if (!m) return { kind: 'none' }
      const parsed = MindWanderSchema.safeParse(JSON.parse(m[0]))
      if (!parsed.success || parsed.data.kind === 'none') return { kind: 'none' }

      if (parsed.data.kind === 'feeling' && parsed.data.affect && parsed.data.affect !== 'neutral') {
        deps.body.appraise({
          source: 'life',
          affectKind: parsed.data.affect as AffectKind,
          intensity: parsed.data.intensity ?? 0.35,
          confidence: 0.7,
          text: parsed.data.feelingNote || `忽然想起：${pick.text.slice(0, 40)}`,
          now,
        })
        this.store.logTrace({ traceId: opts.traceId, event: 'mind_wander_feeling', level: 'info', data: { affect: parsed.data.affect, memId: pick.id } })
        return { kind: 'feeling', detail: parsed.data.feelingNote }
      }

      if (parsed.data.kind === 'thought' && parsed.data.want && parsed.data.why) {
        const created = this.seed({
          source: 'wander',
          motive: 'curiosity',
          want: parsed.data.want,
          why: parsed.data.why,
          exitKind: parsed.data.exitKind ?? 'experience',
          stage: 'active',
          strength: 0.5,
          aboutUser: parsed.data.aboutUser || (pick.about[0] ?? null),
          now,
        })
        if (created) {
          this.store.logTrace({ traceId: opts.traceId, event: 'mind_wander_thought', level: 'info', data: { desireId: created.id, want: created.want } })
          return { kind: 'thought', detail: created.want }
        }
      }
      return { kind: 'none' }
    } catch (e) {
      this.store.logTrace({
        traceId: opts.traceId,
        event: 'mind_wander_error',
        level: 'warn',
        data: { error: (e as Error).message.slice(0, 160) },
      })
      return { kind: 'none' }
    }
  }
}
