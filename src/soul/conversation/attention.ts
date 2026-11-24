// 注意力与打断决策：她在忙时收到消息，决定 now / later / ignore。
// 关键修复（相对旧版）：必须带上「她是谁（人设摘要）+ 真实精力与身体状态 + 当前活动与思绪 + 关系背景」，
// 绝不让无性格的通用 AI 替她决定回不回话。
import { z } from 'zod'
import type { ActiveActivity, ChatModel, SoulStore } from '../../shared/ports.ts'
import { timeHHMM } from '../../shared/time.ts'
import { estimateCostCny } from '../agent/loop.ts'
import type { PriceTable } from '../agent/loop.ts'

export type AttentionDecision = 'now' | 'later' | 'ignore'

export interface AttentionInput {
  traceId: string
  personaName: string
  personaSummary: string
  activity: ActiveActivity
  bodyFacts: string
  relationFacts: string
  relationStage?: string
  message: string
  unreadCount: number
  isGroup: boolean
  isAtMe: boolean
  now: Date
}

const AttentionSchema = z.object({
  decision: z.enum(['now', 'later', 'ignore']),
  reason: z.string().max(80).default(''),
})

export function buildAttentionPrompt(inp: AttentionInput): { system: string; user: string } {
  const leftMin = Math.max(0, Math.round((Date.parse(inp.activity.endsAt) - inp.now.getTime()) / 60_000))
  const where = inp.isGroup
    ? (inp.isAtMe ? '群里有人直接叫了你的名字' : '群里有人说话')
    : '有人私聊给你发消息'
  const system = `你就是${inp.personaName}。${inp.personaSummary}
下面是此刻真实发生的情形。只根据你是谁、你手上的事和眼前这个人，决定现在怎么办。
只输出严格 JSON：{"decision":"now|later|ignore","reason":"一句话"}
- now：现在就放下手头的事回他
- later：先把手上这件事做完，回头再回他
- ignore：这条不回`

  const lines = [
    `现在是 ${timeHHMM(inp.now)}。`,
    `你正在${inp.activity.place}，${inp.activity.label}${leftMin > 0 && leftMin < 240 ? `（大概还要 ${leftMin} 分钟）` : ''}。`,
    ...(inp.activity.thinking ? [`你刚才心里在想：${inp.activity.thinking}`] : []),
    `\n你的状态：\n${inp.bodyFacts}`,
    `\n${where}。`,
    inp.relationFacts,
    inp.unreadCount > 1
      ? `他刚连发了 ${inp.unreadCount} 条：「${inp.message}」`
      : `消息是：「${inp.message}」`,
  ]
  return { system, user: lines.join('\n') }
}

// 失败回落 now（fail-open 于回话：宁可多应一声，不因判断故障让她装死）。
export async function decideAttention(
  deps: { model: ChatModel | null; store: SoulStore; priceTable?: PriceTable },
  inp: AttentionInput,
  signal?: AbortSignal,
): Promise<{ decision: AttentionDecision; reason: string }> {
  // 处于明显反感期且自己正在忙：0 token 直接延后处理，不为让她反感的人放下手头的事
  if (inp.relationStage === 'hostile') {
    return { decision: 'later', reason: 'hostile_not_interrupting' }
  }
  if (!deps.model) return { decision: 'now', reason: 'no_model' }
  const prompt = buildAttentionPrompt(inp)
  try {
    const res = await deps.model.complete({
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      reasoningEffort: 'low',
      temperature: 0.2,
      signal,
    })
    deps.store.recordTokens({
      scene: 'attention',
      model: res.model,
      inputTokens: res.usage.inputTokens,
      cachedTokens: res.usage.cachedTokens,
      outputTokens: res.usage.outputTokens,
      reasoningTokens: res.usage.reasoningTokens,
      estCostCny: estimateCostCny(res.usage, deps.priceTable),
    })
    const m = res.content.match(/\{[\s\S]*\}/)
    if (!m) {
      deps.store.logTrace({ traceId: inp.traceId, event: 'attention_unparseable', level: 'warn', data: { raw: res.content.slice(0, 100) } })
      return { decision: 'now', reason: 'unparseable' }
    }
    const parsed = AttentionSchema.safeParse(JSON.parse(m[0]))
    if (!parsed.success) {
      deps.store.logTrace({ traceId: inp.traceId, event: 'attention_schema_fail', level: 'warn', data: { issues: parsed.error.issues.slice(0, 2) } })
      return { decision: 'now', reason: 'schema_fail' }
    }
    return parsed.data
  } catch (e) {
    deps.store.logTrace({
      traceId: inp.traceId,
      event: 'attention_error',
      level: 'warn',
      data: { error: (e as Error).message.slice(0, 160) },
    })
    return { decision: 'now', reason: 'error' }
  }
}
