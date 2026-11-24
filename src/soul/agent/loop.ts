// 灵魂原生轻量 Agent Loop（手脑合一 + 静前动后保 Prefix Cache + 工具脏输出回合折叠 + Token 账本）。
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
  toolLayers: ToolLayer[]
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

  while (steps < maxSteps) {
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

    // 记入 Token 账本（每一步都精确入账）
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

    if (res.toolCalls.length === 0) {
      finalReply = res.content.trim()
      break
    }

    // 工具调用步骤只活在 workingMessages 里，回合结束即抛弃，绝不污染长期历史
    workingMessages.push({
      role: 'assistant',
      content: res.content,
      toolCalls: res.toolCalls,
    })

    for (const tc of res.toolCalls) {
      const tool = deps.tools.get(tc.name)
      if (!tool) {
        const msg = `未知工具：${tc.name}`
        workingMessages.push({ role: 'tool', toolCallId: tc.id, content: msg })
        deps.store.logTrace({ traceId: input.traceId, event: 'tool_missing', level: 'warn', data: { name: tc.name } })
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

  return {
    reply: finalReply,
    toolSummaries,
    steps,
    totalUsage,
    finishReason: lastFinish,
  }
}
