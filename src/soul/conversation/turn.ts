// 统一对话与自主回合管线（严格强类型，彻底消灭 as never）。
// 包含：极短寒暄跳过抽取门控 + 静前动后 Agent Loop + 工具结果折叠持久化 + 多合一 Zod 校验后处理。
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { EMOTION_KINDS } from '../../shared/ports.ts'
import type {
  AffectKind,
  ChatModel,
  Feel,
  ImagePart,
  ReasoningEffort,
  SoulStore,
  ToolLayer,
  ToolRegistry,
} from '../../shared/ports.ts'
import { nowLocal, systemClock, timeHHMM } from '../../shared/time.ts'
import type { Clock } from '../../shared/time.ts'
import { pickRelevantWorldFacts } from '../persona/pack.ts'
import type { PersonaPack } from '../persona/pack.ts'
import type { BodyEngine } from '../body/engine.ts'
import { intimacyTierOf } from '../memory/engine.ts'
import type { MemoryEngine } from '../memory/engine.ts'
import type { RelationEngine } from '../relation/engine.ts'
import { estimateCostCny, runAgentLoop } from '../agent/loop.ts'
import type { PriceTable } from '../agent/loop.ts'

// 极短无信息寒暄判据：命中则跳过后处理 LLM 抽取，直接省掉 ~40% 辅助调用。
// 关键原则：绝不跳过冷淡/敷衍/拒绝类短词（如“哦”“随便”“滚”“闭嘴”“烦”），否则微冒犯和冷暴力会被静默吞掉！
const COLD_OR_HOSTILE_RE = /(滚|闭嘴|别吵|别烦|烦死|好烦|懒得|随便|呵呵|无语|走开|讨厌|烦不烦|真烦|傻逼|智障|废物|别发了|^哦+[。.~…\s]*$)/i
const TRIVIAL_RE = /^(嗯+|啊+|好+|行+|ok|好的|好呀|好哒|收到|谢谢|晚安|早安|在吗|在不在|哈哈+|嘿嘿+|笑死|确实|是的|没错|懂了|知道了|拜拜|再见|1|6+)[。！？!?~～…\s]*$/i

export function isTrivialMessage(text: string): boolean {
  const t = text.trim()
  if (t.length === 0) return true
  if (COLD_OR_HOSTILE_RE.test(t)) return false
  if (t.length <= 2 && !/[？?]/.test(t)) return true
  return TRIVIAL_RE.test(t)
}

const ExtractedFactSchema = z.object({
  kind: z.enum(['fact', 'preference', 'promise', 'milestone', 'address']).default('fact'),
  text: z.string().min(1).max(80),
  tier: z.enum(['fleeting', 'season', 'lasting', 'permanent']).default('season'),
  sensitivity: z.enum(['open', 'personal', 'private', 'critical']).default('personal'),
  disclosable: z.enum(['volunteer', 'when-asked', 'secretive']).default('when-asked'),
  call: z.string().max(16).optional(),
})

const UnifiedExtractSchema = z.object({
  // P0-5：首字段前置极简语用推理槽，先判字面情感与真实意图是否背离（防反讽/敷衍道歉误判为 repair）
  pragmaticNote: z.string().max(60).default(''),
  facts: z.array(ExtractedFactSchema).max(3).default([]),
  affect: z.object({
    kind: z.enum(EMOTION_KINDS).default('neutral'),
    intensity: z.number().min(0).max(1).default(0.35),
  }).default({ kind: 'neutral', intensity: 0.35 }),
  happened: z.string().max(80).default(''),
  relationFeel: z.enum(['better+', 'better++', 'worse+', 'worse++', 'repair', 'same', 'unclear']).default('same'),
  tensionNote: z.string().max(90).default(''),
  selfMistake: z.string().max(70).default(''),
  signalKind: z.string().max(32).default('chat'),
  desireHint: z.string().max(100).default(''),
})

export type UnifiedExtract = z.infer<typeof UnifiedExtractSchema>

// v2.1 选择性隐藏独白剥离：提取 <inner>...</inner> 只供诊断日志，绝不落库进历史前缀、绝不发给用户
export function stripInnerMonologue(raw: string): { reply: string; inner: string } {
  const inners: string[] = []
  const cleaned = raw
    .replace(/<inner>([\s\S]*?)<\/inner>/gi, (_m, body: string) => {
      const t = body.trim()
      if (t) inners.push(t)
      return ''
    })
    .replace(/<\/?inner>/gi, '')
    .trim()
  return { reply: cleaned, inner: inners.join('\n') }
}

const UNIFIED_EXTRACT_SYSTEM = `你是角色自己的记忆与内心整理器，从刚结束的一轮对话里一次抽出以下字段，用她的第一人称视角，严格输出 JSON：
0. pragmaticNote（必填，≤25字，必须最先思考）：先判断对方话语的字面意思与真实意图是否背离（例如“行行行都怪我”“好吧对不起行了吧”属于敷衍反讽，绝不是真诚道歉；如实写一句语用判断）。
1. facts（最多 2 条，宁缺毋滥）：只记日后想起来有用的关于对方的事实/偏好/约定/称呼要求；不记她自己说过的话；若对方明确要求改称呼则 kind=address 并填 call。
2. affect：这一轮让她产生的主要情绪（正面：praised/affection/curiosity/humor；负面：annoyed烦躁被敷衍/hurt委屈受伤/rejected被拒推开/conflict争执冒犯/sadness难过/uneasy尴尬戒备/guilty内疚自责；中性：boredom/neutral）与强度 0~1。请如实反映负面感受，不要替对方找借口。
3. happened：一句话记下这一轮发生了什么具体事（≤40字；纯闲聊留空串）。
4. relationFeel：这一轮之后她对这个人的感受变化：
   - better+ / better++：明显被关心、理解、温暖或一起开心
   - worse+：对方敷衍、冷淡、反讽、不耐烦、轻视、爽约或让人不舒服
   - worse++：对方明显冒犯、辱骂、喝止（如闭嘴/滚/嫌烦）、伤害感情或严重失信
   - repair：之前确有未解疙瘩，且对方这一轮**真诚**道歉、认真解释误会或温柔安抚（敷衍阴阳怪气严禁标 repair！）
   - same / unclear：平常无波澜的普通对话
5. tensionNote：仅当 relationFeel 为 worse+ 或 worse++ 时，用一句话客观记下带原话摘录的起因（≤40字，例：“他说『烦死了闭嘴』让我很不舒服”）；其余留空串。
6. selfMistake：仅当对方指出她记错了事实、说错话伤到对方、或她自己违约搞砸时，客观记一句过意不去的事（≤40字）；没有留空串。
7. desireHint：如果这轮对话勾起了她自己想查、想学、想画、想唱或想做的念头，用第一人称写一句；没有就留空串。

只输出 JSON，不要任何其他文字：
{"pragmaticNote":"","facts":[],"affect":{"kind":"neutral","intensity":0.35},"happened":"","relationFeel":"same","tensionNote":"","selfMistake":"","signalKind":"chat","desireHint":""}`

export function isSelfNarration(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  return /^我(叫|告诉|对他说|求|问|答|说|讲|把他记|记作|反问|提到|给|为|替)/.test(t)
}

export interface TurnInput {
  mode: 'chat' | 'solo'
  botId: string
  threadKey: string
  userId: string
  userName?: string
  groupId?: string | null
  messageId?: string
  text: string
  images?: ImagePart[]
  isGroup?: boolean
  toolLayers?: ToolLayer[]
  reasoningEffort?: ReasoningEffort
  maxSteps?: number
  ephemeral?: boolean
  notice?: string // 刚发生的客观事实（如管理员刚批准/拒绝了某项请求），注入末尾动态块
  maxHistoryMessages?: number
  compactDropCount?: number
  signal?: AbortSignal
  onReply?: (reply: string) => Promise<void>
}

export interface TurnOutput {
  traceId: string
  reply: string
  toolSummaries: string[]
  steps: number
  extracted: UnifiedExtract | null
}

export interface ConversationDeps {
  persona: PersonaPack
  store: SoulStore
  body: BodyEngine
  memory: MemoryEngine
  relations: RelationEngine
  chatModel: ChatModel
  auxModel?: ChatModel | null
  tools: ToolRegistry
  clock?: Clock
  priceTable?: PriceTable
}

export async function runConversationTurn(deps: ConversationDeps, input: TurnInput): Promise<TurnOutput> {
  const clock = deps.clock ?? systemClock
  const now = clock.now()
  const traceId = `tr_${randomUUID().slice(0, 10)}`
  const isGroup = Boolean(input.isGroup)
  const who = deps.relations.nameOf(input.userId, input.userName)
  const rel = deps.relations.get(input.userId)

  // 1) 加载按块滑动的稳定对话窗口（保前缀缓存）
  const history = input.ephemeral
    ? []
    : deps.memory.loadStableWindow(input.threadKey, input.maxHistoryMessages ?? 30, input.compactDropCount ?? 10)

  // 2) 拼装紧凑动态尾注（放最后一条消息前，绝不污染静态 System）
  const lastContact = deps.store.lastUserContactAt(input.userId)
  const hoursSinceContact = lastContact
    ? Math.max(0, (now.getTime() - Date.parse(lastContact.replace(' ', 'T'))) / 3_600_000)
    : undefined

  const dynamicParts: string[] = []
  dynamicParts.push(`现在时间：${timeHHMM(now)}（${isGroup ? '群聊，在场所有人都看得到' : input.mode === 'solo' ? '你一个人的独处时间' : `私聊，只有你和${who}两个人`}）。`)
  if (input.notice?.trim()) {
    dynamicParts.push(`刚刚发生的事：${input.notice.trim()}`)
  }
  dynamicParts.push(`你的状态：\n${deps.body.renderBodyFacts(now, hoursSinceContact)}`)

  const isStrained = input.mode === 'chat' && deps.relations.isStrained(input.userId)
  const bodyState = deps.body.state(now)

  if (input.mode === 'chat') {
    const shared = deps.memory.sharedStories(input.userId, 3, { isStrained })
    dynamicParts.push(deps.relations.renderRelationFacts({
      userId: input.userId,
      displayName: input.userName,
      now,
      sharedStories: shared,
      lastContactIso: lastContact,
    }))
    const recalled = deps.memory.recallForTurn({
      listener: input.userId,
      tier: intimacyTierOf(rel.stage),
      isGroup,
      query: input.text,
      now,
      limit: 6,
      valence: rel.valence,
      isStrained,
      nameOf: (u) => deps.relations.nameOf(u),
    })
    if (recalled.text) {
      dynamicParts.push(`想起来的几件事：\n${recalled.text}`)
    }
  }

  const worldHaystack = [input.text, ...history.slice(-4).map((m) => m.content)].join('\n')
  const worldSnippet = pickRelevantWorldFacts(deps.persona, worldHaystack, 500)
  if (worldSnippet) {
    dynamicParts.push(`相关世界记忆：\n${worldSnippet}`)
  }

  // v2.1 反谄媚：仅在冲突/高张力/冷淡短词回合（约 15% 回合）启用普通 Chat 模式下的选择性 <inner> 隐藏独白，
  // 严禁在静态 System 修改或开启 DeepSeek Thinking+tools；只提供私密消化区，绝不规定回复立场。
  const useInnerMonologue = input.mode === 'chat'
    && (isStrained || bodyState.pad.p < deps.body.baseline.p - 0.16 || COLD_OR_HOSTILE_RE.test(input.text))
  if (useInnerMonologue) {
    dynamicParts.push('（这一轮你可以先用 <inner>...</inner> 写一两句只给自己看的内心真实想法，再写出要发给他的话；<inner> 里的内容不会发给对方，也不会记进对话历史。）')
  }

  // 3) 跑灵魂原生轻量 Agent Loop（P0-3：默认固定一致的工具层顺序，保 Prefix Cache）
  const effectiveUserText = input.mode === 'chat' && isGroup
    ? `${who}: ${input.text || '（发来一张图片）'}`
    : (input.text || '（对方发来一张图片，没有配文字）')

  const loopRes = await runAgentLoop(
    { model: deps.chatModel, tools: deps.tools, store: deps.store, priceTable: deps.priceTable },
    {
      traceId,
      scene: input.mode === 'solo' ? 'solo' : 'chat',
      staticSystemPrompt: deps.persona.staticSystemPrompt,
      history,
      dynamicFacts: dynamicParts.join('\n\n'),
      userText: effectiveUserText,
      images: input.images,
      isGroup,
      toolLayers: input.toolLayers ?? ['explore', 'express', 'create'],
      reasoningEffort: input.reasoningEffort ?? (input.mode === 'solo' ? 'high' : 'low'),
      maxSteps: input.maxSteps ?? (input.mode === 'solo' ? 12 : 3),
      toolCtx: {
        botId: input.botId,
        threadKey: input.threadKey,
        userId: input.userId,
        userName: who,
        groupId: input.groupId ?? null,
        messageId: input.messageId,
        isGroup,
        solo: input.mode === 'solo',
        now,
        signal: input.signal,
      },
      signal: input.signal,
    },
  )

  const stripped = stripInnerMonologue(loopRes.reply)
  const reply = stripped.reply
  if (stripped.inner) {
    deps.store.logTrace({
      traceId,
      event: 'inner_monologue',
      level: 'info',
      data: { userId: input.userId, inner: stripped.inner.slice(0, 240) },
    })
  }
  const foldedSummary = loopRes.toolSummaries.length > 0 ? loopRes.toolSummaries.join('；') : null

  // 4) 先落库 & 先投递回复（用户不用等后处理抽取）
  if (!input.ephemeral && input.mode === 'chat') {
    deps.store.appendMessage({
      threadKey: input.threadKey,
      role: 'user',
      userId: input.userId,
      userName: who,
      content: input.text || '[图片]',
      toolSummary: null,
      mediaJson: null,
      createdAt: nowLocal(now),
    })
    if (reply) {
      deps.store.appendMessage({
        threadKey: input.threadKey,
        role: 'assistant',
        userId: input.botId,
        userName: deps.persona.name,
        content: reply,
        toolSummary: foldedSummary,
        mediaJson: null,
        createdAt: nowLocal(now),
      })
    }
    deps.relations.noteTurn(input.userId, { displayName: input.userName, now })
  }

  // 真实消耗一点精力（独处重活消耗更多）
  deps.body.spendEnergy(input.mode === 'solo' ? 0.04 : 0.015, now)

  if (reply && input.onReply) {
    try {
      await input.onReply(reply)
    } catch (e) {
      deps.store.logTrace({
        traceId,
        event: 'reply_deliver_error',
        level: 'error',
        data: { error: (e as Error).message.slice(0, 200) },
      })
    }
  }

  // 5) 门控 + 多合一后处理抽取（跳过极短寒暄，省 token）
  let extracted: UnifiedExtract | null = null
  const aux = deps.auxModel ?? deps.chatModel
  if (input.mode === 'chat' && !input.ephemeral && reply && !isTrivialMessage(input.text)) {
    const existingTensions = deps.relations.get(input.userId).tensions
      .filter((t) => t.source === 'user')
      .map((t) => t.text)
    const regime = deps.relations.sentimentRegime(input.userId, now)
    extracted = await runUnifiedExtract({
      model: aux,
      store: deps.store,
      traceId,
      who,
      userText: input.text,
      reply,
      existingTensions,
      regime,
      priceTable: deps.priceTable,
      signal: input.signal,
    })
    if (extracted) {
      applyExtraction(deps, {
        extracted,
        userId: input.userId,
        who,
        threadKey: input.threadKey,
        isGroup,
        userText: input.text,
        now,
        traceId,
      })
    }
  }

  deps.store.logTrace({
    traceId,
    event: 'turn_complete',
    level: 'info',
    data: {
      mode: input.mode,
      steps: loopRes.steps,
      tools: loopRes.toolSummaries.length,
      inputTokens: loopRes.totalUsage.inputTokens,
      cachedTokens: loopRes.totalUsage.cachedTokens,
      outputTokens: loopRes.totalUsage.outputTokens,
      extracted: Boolean(extracted),
    },
  })

  return {
    traceId,
    reply,
    toolSummaries: loopRes.toolSummaries,
    steps: loopRes.steps,
    extracted,
  }
}

async function runUnifiedExtract(opts: {
  model: ChatModel
  store: SoulStore
  traceId: string
  who: string
  userText: string
  reply: string
  existingTensions?: string[]
  regime?: 'PSO' | 'NEUTRAL' | 'NSO'
  priceTable?: PriceTable
  signal?: AbortSignal
}): Promise<UnifiedExtract | null> {
  try {
    const notes: string[] = []
    if (opts.existingTensions?.length) {
      notes.push(`她和 ${opts.who} 之间目前还有未解疙瘩：${opts.existingTensions.join('；')}`)
    }
    if (opts.regime === 'NSO') {
      notes.push('近期两人处于负向情感覆盖期（NSO），请格外警惕敷衍、反讽与伪道歉。')
    }
    const tensionHint = notes.length > 0 ? `（背景：${notes.join(' ')}）\n\n` : ''
    const res = await opts.model.complete({
      messages: [
        { role: 'system', content: UNIFIED_EXTRACT_SYSTEM },
        { role: 'user', content: `${tensionHint}${opts.who}说：${opts.userText}\n\n我回复：${opts.reply}` },
      ],
      reasoningEffort: 'low',
      temperature: 0,
      signal: opts.signal,
    })
    opts.store.recordTokens({
      scene: 'extract',
      model: res.model,
      inputTokens: res.usage.inputTokens,
      cachedTokens: res.usage.cachedTokens,
      outputTokens: res.usage.outputTokens,
      reasoningTokens: res.usage.reasoningTokens,
      estCostCny: estimateCostCny(res.usage, opts.priceTable),
    })
    const match = res.content.match(/\{[\s\S]*\}/)
    if (!match) {
      opts.store.logTrace({ traceId: opts.traceId, event: 'extract_no_json', level: 'warn', data: { raw: res.content.slice(0, 120) } })
      return null
    }
    const parsed = UnifiedExtractSchema.safeParse(JSON.parse(match[0]))
    if (!parsed.success) {
      opts.store.logTrace({ traceId: opts.traceId, event: 'extract_schema_fail', level: 'warn', data: { issues: parsed.error.issues.slice(0, 3) } })
      return null
    }
    return parsed.data
  } catch (e) {
    opts.store.logTrace({
      traceId: opts.traceId,
      event: 'extract_error',
      level: 'warn',
      data: { error: (e as Error).message.slice(0, 180) },
    })
    return null
  }
}

function applyExtraction(
  deps: ConversationDeps,
  ctx: {
    extracted: UnifiedExtract
    userId: string
    who: string
    threadKey: string
    isGroup: boolean
    userText: string
    now: Date
    traceId: string
  },
): void {
  const { extracted, userId, who, threadKey, isGroup, userText, now, traceId } = ctx

  // 1) 写入事实记忆（L0_external 一手用户陈述）+ 联动改称呼
  for (const f of extracted.facts.slice(0, 2)) {
    if (isSelfNarration(f.text)) continue
    deps.memory.remember({
      kind: 'fact',
      text: f.text,
      about: [userId],
      sensitivity: f.sensitivity,
      tier: f.tier,
      disclosable: f.disclosable,
      consented: false,
      source: isGroup ? 'group' : 'private',
      provenance: 'L0_external',
      threadKey,
      affect: extracted.affect.kind,
      createdAt: nowLocal(now),
    })
    if (f.kind === 'address' && f.call) {
      deps.relations.setCall(userId, f.call)
      deps.store.logTrace({ traceId, event: 'call_changed', level: 'info', data: { userId, call: f.call } })
    }
  }

  // 2) 写入经历记忆（L1_shared 真实互动经历）
  if (extracted.happened.trim()) {
    deps.memory.remember({
      kind: 'experience',
      text: `${who}：${extracted.happened.trim()}`,
      about: [userId],
      sensitivity: 'personal',
      tier: extracted.affect.intensity >= 0.65 ? 'lasting' : 'season',
      disclosable: 'when-asked',
      consented: false,
      source: isGroup ? 'group' : 'private',
      provenance: 'L1_shared',
      threadKey,
      affect: extracted.affect.kind,
      createdAt: nowLocal(now),
    })
  }

  // 3) 更新身心情绪（含持久化原话来由）
  if (extracted.affect.kind !== 'neutral') {
    deps.body.appraise({
      source: 'chat',
      affectKind: extracted.affect.kind as AffectKind,
      intensity: extracted.affect.intensity,
      confidence: 0.8,
      text: userText,
      who: isGroup ? who : '',
      now,
    })
  }

  // 4) 更新三轴关系（含债务封顶修复、原话引证心结与反向愧疚心结）
  if (extracted.relationFeel !== 'same' && extracted.relationFeel !== 'unclear') {
    const quote = userText.trim().slice(0, 30)
    const note = extracted.tensionNote.trim()
      || (extracted.relationFeel === 'worse+' || extracted.relationFeel === 'worse++'
        ? (extracted.happened.trim() ? `${extracted.happened.trim()}（原话：「${quote}」）` : `${who}说了「${quote}」让我不太舒服`)
        : undefined)
    deps.relations.applyFeel(userId, extracted.relationFeel as Feel, extracted.signalKind, now, note)
  }
  if (extracted.selfMistake.trim()) {
    deps.relations.addSelfTension(userId, extracted.selfMistake.trim(), 0.55, now)
    deps.body.appraise({
      source: 'chat',
      affectKind: 'guilty',
      intensity: 0.55,
      confidence: 0.85,
      text: extracted.selfMistake.trim(),
      who,
      now,
    })
  }

  // 5) 对话中冒出的新念头直接种进欲望池（种子态，供生活系统后续发酵）
  if (extracted.desireHint.trim()) {
    deps.store.upsertDesire({
      id: `d_${randomUUID().slice(0, 10)}`,
      source: 'chat',
      motive: 'curiosity',
      want: extracted.desireHint.trim(),
      why: `和${who}聊起「${userText.slice(0, 30)}」时冒出来的念头`,
      exitKind: 'experience',
      stage: 'seed',
      spec: null,
      blocker: null,
      strength: 0.45,
      thoughtCount: 1,
      progressNote: null,
      aboutUser: userId,
      parentId: null,
      createdAt: nowLocal(now),
      updatedAt: nowLocal(now),
    })
  }
}
