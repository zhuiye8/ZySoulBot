// 唯一审批闭环（全系统只有这一套审批）：同时最多悬 1 条待批，避免“可以”产生歧义。
// 铁律：只有高置信度明确批准才执行；追问、聊天、拖延一律判 neither（继续悬着，照常聊天）。
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ApprovalRecord, ChatModel, SoulStore } from '../../shared/ports.ts'
import { estimateCostCny } from '../agent/loop.ts'
import type { PriceTable } from '../agent/loop.ts'

export const APPROVAL_CONFIDENCE = 0.7
export const DEFAULT_APPROVAL_TTL_MS = 24 * 3_600_000

const ApprovalJudgeSchema = z.object({
  verdict: z.enum(['approve', 'reject', 'neither']),
  confidence: z.number().min(0).max(1),
})

export type ApprovalVerdict = z.infer<typeof ApprovalJudgeSchema>

export class ApprovalManager {
  private store: SoulStore

  constructor(store: SoulStore) {
    this.store = store
  }

  pending(now: Date = new Date()): ApprovalRecord | null {
    return this.store.pendingApproval(now.toISOString())
  }

  // 开一条新的待审批请求；若当前已有悬着的一条则拒绝并发，防止“可以”歧义。
  open(inp: {
    kind: 'approval' | 'allow-person'
    targetId: string
    what: string
    payload?: Record<string, unknown> | null
    ttlMs?: number
    now?: Date
  }): ApprovalRecord | null {
    const now = inp.now ?? new Date()
    if (this.pending(now)) return null
    const rec: ApprovalRecord = {
      id: `apr_${randomUUID().slice(0, 10)}`,
      kind: inp.kind,
      targetId: inp.targetId,
      what: inp.what.trim().slice(0, 200),
      payload: inp.payload ?? null,
      status: 'pending',
      askedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (inp.ttlMs ?? DEFAULT_APPROVAL_TTL_MS)).toISOString(),
      resolvedAt: null,
    }
    this.store.saveApproval(rec)
    return rec
  }

  // 判断管理员刚发的私聊是不是在批准/拒绝悬着的那条请求（fail-closed：解析失败或低置信一律当 neither）。
  async judgeReply(
    deps: { model: ChatModel | null; priceTable?: PriceTable },
    inp: { traceId: string; what: string; reply: string; recent?: string },
    signal?: AbortSignal,
  ): Promise<ApprovalVerdict> {
    if (!deps.model) return { verdict: 'neither', confidence: 0 }
    const system = `判断管理员这条回复是不是在明确批准或拒绝她之前提的请求。只输出 JSON：{"verdict":"approve|reject|neither","confidence":0.0}
铁律：
- 追问、让她先说说打算、问为什么、说“晚点再看”、正常聊别的事 → 一律选 neither（绝不能算 approve）
- 明确同意、答应、放行 → approve
- 明确拒绝、不行、算了 → reject`
    const user = `她悬着的请求：「${inp.what}」\n${inp.recent ? `前文：\n${inp.recent}\n` : ''}管理员刚回复：「${inp.reply}」`

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
      this.store.recordTokens({
        scene: 'approval_judge',
        model: res.model,
        inputTokens: res.usage.inputTokens,
        cachedTokens: res.usage.cachedTokens,
        outputTokens: res.usage.outputTokens,
        reasoningTokens: res.usage.reasoningTokens,
        estCostCny: estimateCostCny(res.usage, deps.priceTable),
      })
      const m = res.content.match(/\{[\s\S]*\}/)
      if (!m) return { verdict: 'neither', confidence: 0 }
      const parsed = ApprovalJudgeSchema.safeParse(JSON.parse(m[0]))
      return parsed.success ? parsed.data : { verdict: 'neither', confidence: 0 }
    } catch (e) {
      this.store.logTrace({
        traceId: inp.traceId,
        event: 'approval_judge_error',
        level: 'warn',
        data: { error: (e as Error).message.slice(0, 160) },
      })
      return { verdict: 'neither', confidence: 0 }
    }
  }

  resolve(rec: ApprovalRecord, decision: 'approved' | 'rejected', now: Date = new Date()): ApprovalRecord {
    const next: ApprovalRecord = {
      ...rec,
      status: decision,
      resolvedAt: now.toISOString(),
    }
    this.store.saveApproval(next)
    return next
  }
}

export function isApprovalGranted(v: ApprovalVerdict): boolean {
  return v.verdict === 'approve' && v.confidence >= APPROVAL_CONFIDENCE
}

export function isApprovalRejected(v: ApprovalVerdict): boolean {
  return v.verdict === 'reject' && v.confidence >= APPROVAL_CONFIDENCE
}
