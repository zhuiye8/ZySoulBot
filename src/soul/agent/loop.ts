// 灵魂原生轻量 Agent Loop（手脑合一 + 静前动后保 Prefix Cache + 冻结工具定义与执行期能力掩码 + 步数耗尽受限收尾）。
import { createHash } from 'node:crypto'
import type {
  ChatMessage,
  ChatModel,
  ImagePart,
  ReasoningEffort,
  SoulStore,
  StoredMessage,
  TokenUsage,
  ToolLayer,
  ToolRegistry,
  ToolRunContext,
} from '../../shared/ports.ts'

export type LoopStopReason = 'completed' | 'exhausted' | 'failed' | 'cancelled'

export interface PriceTable {
  inputPerMillionCny: number
  cachedPerMillionCny: number
  outputPerMillionCny: number
}

export const DEFAULT_PRICE_TABLE: PriceTable = {
  inputPerMillionCny: 1.0,
  cachedPerMillionCny: 0.2,
  outputPerMillionCny: 2.0,
}

export function estimateCostCny(u: TokenUsage, price: PriceTable = DEFAULT_PRICE_TABLE): number {
  const uncached = Math.max(0, u.inputTokens - u.cachedTokens)
  const cost =
    (uncached / 1_000_000) * price.inputPerMillionCny +
    (u.cachedTokens / 1_000_000) * price.cachedPerMillionCny +
    (u.outputTokens / 1_000_000) * price.outputPerMillionCny
  return Number(cost.toFixed(6))
}

export interface AgentLoopInput {
  traceId: string
  scene: string
  staticSystemPrompt: string
  history: StoredMessage[]
  dynamicFacts: string
  userText: string
  images?: ImagePart[]
  isGroup: boolean
  /** 发给模型的冻结工具定义层（跨场景一致以保 Prefix Cache） */
  toolLayers: ToolLayer[]
  /** P1-CACHE-01 & P2-LOOP-01：当轮实际允许执行的工具层集合（默认等于 toolLayers） */
  allowedLayers?: ToolLayer[]
  reasoningEffort: ReasoningEffort
  temperature?: number
  maxSteps?: number
  maxToolOutputChars?: number
  toolCtx: ToolRunContext
  signal?: AbortSignal
}

export interface AgentLoopResult {
  reply: string
  toolSummaries: string[]
  steps: number
  totalUsage: TokenUsage
  finishReason: string
  stopReason: LoopStopReason
  toolsHash: string
}

// 将历史消息渲染为稳定的前缀序列（绝不把大段工具原始返回放进历史）。
export function buildHistoryMessages(history: StoredMessage[], isGroup: boolean): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of history) {
    if (m.role === 'summary') {
      out.push({ role: 'user', content: `[早先对话梗概] ${m.content}` })
      continue
    }
    if (m.role === 'user') {
      const text = isGroup && m.userName ? `${m.userName}: ${m.content}` : m.content
      out.push({ role: 'user', content: text })
      continue
    }
    const text = m.toolSummary ? `[${m.toolSummary}]\n${m.content}` : m.content
    out.push({ role: 'assistant', content: text })
  }
  return out
}

// 构建严格的“静前动后”三明治消息数组，保证 System + History 字节级命中 Prefix Cache。
export function buildSandwichMessages(opts: {
  staticSystemPrompt: string
  history: StoredMessage[]
  dynamicFacts: string
  userText: string
  images?: ImagePart[]
  isGroup: boolean
}): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: opts.staticSystemPrompt },
    ...buildHistoryMessages(opts.history, opts.isGroup),
  ]
  const tailParts: string[] = []
  if (opts.dynamicFacts.trim()) {
    tailParts.push(`[当下事实]\n${opts.dynamicFacts.trim()}\n[/当下事实]`)
  }
  tailParts.push(opts.userText)
  messages.push({
    role: 'user',
    content: tailParts.join('\n\n'),
    ...(opts.images?.length ? { images: opts.images } : {}),
  })
  return messages
}

export async function runAgentLoop(deps: {
  model: ChatModel
  tools: ToolRegistry
  store: SoulStore
  priceTable?: PriceTable
}, input: AgentLoopInput): Promise<AgentLoopResult> {
  const maxSteps = input.maxSteps ?? 4
  const maxToolChars = input.maxToolOutputChars ?? 2500
  const availableSpecs = deps.tools.list(input.toolLayers)
  const declaredNames = new Set(availableSpecs.map((s) => s.name))
  const execAllowedLayers = new Set(input.allowedLayers ?? input.toolLayers)
  const toolsHash = createHash('sha256').update(JSON.stringify(availableSpecs)).digest('hex').slice(0, 12)

  const workingMessages = buildSandwichMessages({
    staticSystemPrompt: input.staticSystemPrompt,
    history: input.history,
    dynamicFacts: input.dynamicFacts,
    userText: input.userText,
    images: input.images,
    isGroup: input.isGroup,
  })

  const totalUsage: TokenUsage = {
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  }
  const toolSummaries: string[] = []
  let steps = 0
  let finalReply = ''
  let lastFinish = 'stop'
  let stopReason: LoopStopReason = 'exhausted'

  const recordStepUsage = (res: { model: string; usage: TokenUsage }): void => {
    totalUsage.inputTokens += res.usage.inputTokens
    totalUsage.cachedTokens += res.usage.cachedTokens
    totalUsage.outputTokens += res.usage.outputTokens
    totalUsage.reasoningTokens += res.usage.reasoningTokens
    totalUsage.totalTokens += res.usage.totalTokens
    deps.store.recordTokens({
      scene: input.scene,
      model: res.model,
      inputTokens: res.usage.inputTokens,
      cachedTokens: res.usage.cachedTokens,
      outputTokens: res.usage.outputTokens,
      reasoningTokens: res.usage.reasoningTokens,
      estCostCny: estimateCostCny(res.usage, deps.priceTable),
    })
  }

  while (steps < maxSteps) {
    if (input.signal?.aborted) {
      stopReason = 'cancelled'
      break
    }
    steps += 1
    const res = await deps.model.complete({
      messages: workingMessages,
      tools: availableSpecs.length > 0 ? availableSpecs : undefined,
      toolChoice: availableSpecs.length > 0 ? 'auto' : undefined,
      reasoningEffort: input.reasoningEffort,
      temperature: input.temperature ?? 0.75,
      signal: input.signal,
    })
    lastFinish = res.finishReason
    recordStepUsage(res)

    if (res.finishReason === 'error' || res.finishReason === 'timeout') {
      stopReason = 'failed'
      finalReply = res.content.trim()
      break
    }

    if (res.toolCalls.length === 0) {
      finalReply = res.content.trim()
      stopReason = 'completed'
      break
    }

    // 工具调用步骤只活在 workingMessages 里，回合结束即抛弃，绝不污染长期历史
    workingMessages.push({
      role: 'assistant',
      content: res.content,
      toolCalls: res.toolCalls,
      ...(res.reasoningContent ? { reasoningContent: res.reasoningContent } : {}),
    })

    for (const tc of res.toolCalls) {
      const tool = deps.tools.get(tc.name)
      // P2-LOOP-01：分发前同时校验“是否在本次声明的工具列表中”与“是否在当前场景执行权限内”
      if (!tool || !declaredNames.has(tc.name)) {
        const msg = `未知或未声明的工具：${tc.name}`
        workingMessages.push({ role: 'tool', toolCallId: tc.id, content: msg })
        deps.store.logTrace({ traceId: input.traceId, event: 'tool_missing', level: 'warn', data: { name: tc.name } })
        continue
      }
      if (!execAllowedLayers.has(tool.layer)) {
        const msg = `工具「${tc.name}」在当前场景被能力策略限制，不可执行。`
        workingMessages.push({ role: 'tool', toolCallId: tc.id, content: msg })
        deps.store.logTrace({ traceId: input.traceId, event: 'tool_masked', level: 'warn', data: { name: tc.name, layer: tool.layer } })
        continue
      }
      let parsedArgs: unknown = {}
      try {
        parsedArgs = tc.arguments.trim() ? JSON.parse(tc.arguments) : {}
      } catch (e) {
        const errMsg = `工具参数 JSON 解析失败：${(e as Error).message}`
        workingMessages.push({ role: 'tool', toolCallId: tc.id, content: errMsg })
        deps.store.logTrace({ traceId: input.traceId, event: 'tool_bad_args', level: 'warn', data: { name: tc.name, error: errMsg } })
        continue
      }

      try {
        const out = await tool.execute(parsedArgs, input.toolCtx)
        const clipped = out.output.length > maxToolChars
          ? `${out.output.slice(0, maxToolChars)}\n…（已截断，原长 ${out.output.length} 字）`
          : out.output
        workingMessages.push({ role: 'tool', toolCallId: tc.id, content: clipped })
        if (out.foldSummary) toolSummaries.push(out.foldSummary.slice(0, 120))
        deps.store.logTrace({
          traceId: input.traceId,
          event: 'tool_called',
          level: out.isError ? 'warn' : 'info',
          data: { name: tc.name, chars: out.output.length, folded: out.foldSummary ?? null },
        })
      } catch (e) {
        const errText = `工具执行异常：${(e as Error).message}`
        workingMessages.push({ role: 'tool', toolCallId: tc.id, content: errText })
        deps.store.logTrace({
          traceId: input.traceId,
          event: 'tool_error',
          level: 'error',
          data: { name: tc.name, error: errText.slice(0, 200) },
        })
      }
    }
  }

  // P1-LOOP-01：步数耗尽仍无文本收尾时，保留一次无工具受限收尾预算（保持 tools 数组不变以保前缀缓存）
  if (stopReason === 'exhausted' && !finalReply && !input.signal?.aborted) {
    try {
      const wrapRes = await deps.model.complete({
        messages: [
          ...workingMessages,
          { role: 'user', content: '（工具步骤已用完，请直接用简短自然的话收尾答复，不要再调用工具。）' },
        ],
        tools: availableSpecs.length > 0 ? availableSpecs : undefined,
        toolChoice: availableSpecs.length > 0 ? 'none' : undefined,
        reasoningEffort: 'low',
        temperature: input.temperature ?? 0.7,
        signal: input.signal,
      })
      recordStepUsage(wrapRes)
      lastFinish = wrapRes.finishReason
      finalReply = wrapRes.content.trim()
    } catch {
      // 收尾失败保持 exhausted
    }
  }

  return {
    reply: finalReply,
    toolSummaries,
    steps,
    totalUsage,
    finishReason: lastFinish,
    stopReason,
    toolsHash,
  }
}
