// G0 隔离冒烟脚本：验证直连网关的原生 tool_calls、reasoning_effort、Prefix Cache 命中率与结构化抽取。
// 只读 zhuiyebot 配置里的端点和密钥，绝不读写任何线上/历史数据，也不打印密钥。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface GatewayCfg {
  baseUrl: string
  apiKey: string
  model: string
}

function resolveKey(val: string): string {
  if (val.startsWith('ENV:')) return process.env[val.slice(4)] ?? ''
  return val
}

function loadGateway(): GatewayCfg {
  const cfgPath = resolve('c:/Files/work/qq-bot/zhuiyebot/zhuiye.config.json')
  const raw = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
    brains?: { openai?: GatewayCfg }
    auxLlm?: GatewayCfg
  }
  const src = raw.brains?.openai ?? raw.auxLlm
  if (!src?.baseUrl || !src?.model) {
    throw new Error('Missing gateway config in zhuiye.config.json')
  }
  let apiKey = process.env.QWEN_TOKEN_PLAN_CN_API_KEY || resolveKey(src.apiKey || '')
  if (!apiKey || apiKey.startsWith('PLACEHOLDER')) {
    apiKey = readFileSync(resolve('c:/Files/work/qq-bot/zhuiyebot/.tokenplan_key'), 'utf8').trim()
  }
  return {
    baseUrl: src.baseUrl.replace(/\/+$/, ''),
    apiKey,
    model: src.model,
  }
}

async function callChat(
  gw: GatewayCfg,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const t0 = performance.now()
  const res = await fetch(`${gw.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${gw.apiKey}`,
    },
    body: JSON.stringify({ model: gw.model, ...body }),
    signal: AbortSignal.timeout(45_000),
  })
  const durMs = Math.round(performance.now() - t0)
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} (${durMs}ms): ${text.slice(0, 300)}`)
  }
  const json = JSON.parse(text) as Record<string, unknown>
  return { ...json, _durMs: durMs }
}

async function main(): Promise<void> {
  const gw = loadGateway()
  console.log(`[G0] Gateway: ${gw.baseUrl} | Model: ${gw.model}`)

  // 读取纳西妲静态人设作为真实长度的静态前缀（确保超过 1024 token 缓存门槛）
  const personaDir = 'c:/Files/work/qq-bot/zhuiyebot/personas/nahida/persona'
  const staticSystem = [
    readFileSync(`${personaDir}/identity.md`, 'utf8'),
    readFileSync(`${personaDir}/origin.md`, 'utf8'),
    readFileSync(`${personaDir}/examples.md`, 'utf8'),
    readFileSync(`${personaDir}/discipline.md`, 'utf8'),
  ].join('\n\n')
  console.log(`[G0] Static system prefix chars: ${staticSystem.length}`)

  const tools = [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: '上网查询实时信息（如天气、新闻、百科、不认识的新词）。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
          },
          required: ['query'],
        },
      },
    },
  ]

  // ── Test 1: 原生 tool_calls + reasoning_effort=low ────────────────
  console.log('\n=== Test 1: Native tool_calls + reasoning_effort=low ===')
  const turn1User = '[当下事实] 现在是 14:20，晴，私聊，眼前是追夜。\n\n今天北京天气怎么样？'
  const messages1: Array<Record<string, unknown>> = [
    { role: 'system', content: staticSystem },
    { role: 'user', content: turn1User },
  ]
  const r1 = await callChat(gw, {
    messages: messages1,
    tools,
    tool_choice: 'auto',
    reasoning_effort: 'low',
    temperature: 0.7,
  })
  const c1 = (r1.choices as Array<Record<string, unknown>>)[0]!
  const m1 = c1.message as Record<string, unknown>
  console.log(`Step 1a (${r1._durMs}ms) finish_reason=${c1.finish_reason}`)
  console.log('Usage 1a:', JSON.stringify(r1.usage))
  console.log('Tool calls:', JSON.stringify(m1.tool_calls ?? null))

  let finalReply1 = String(m1.content ?? '')
  let foldedNote = ''
  if (Array.isArray(m1.tool_calls) && m1.tool_calls.length > 0) {
    const tc = m1.tool_calls[0] as { id: string; function: { name: string; arguments: string } }
    const toolResult = JSON.stringify({ query: tc.function.arguments, summary: '北京今日晴，气温 6~14℃，微风，空气质量优。' })
    foldedNote = '[工具行动摘要：查了北京天气，今日晴 6~14℃ 微风]'
    const r1b = await callChat(gw, {
      messages: [
        ...messages1,
        m1,
        { role: 'tool', tool_call_id: tc.id, content: toolResult },
      ],
      tools,
      reasoning_effort: 'low',
      temperature: 0.7,
    })
    const c1b = (r1b.choices as Array<Record<string, unknown>>)[0]!
    const m1b = c1b.message as Record<string, unknown>
    finalReply1 = String(m1b.content ?? '')
    console.log(`Step 1b (${r1b._durMs}ms) finish_reason=${c1b.finish_reason}`)
    console.log('Usage 1b:', JSON.stringify(r1b.usage))
    console.log('Reply 1:', finalReply1)
  } else {
    console.log('Reply 1 (no tool call):', finalReply1)
  }

  // ── Test 2: 静前动后 + 工具结果折叠后的第二轮 Prefix Cache 实测 ────
  console.log('\n=== Test 2: Turn 2 Prefix Cache + Folded History ===')
  const messages2: Array<Record<string, unknown>> = [
    { role: 'system', content: staticSystem },
    { role: 'user', content: '今天北京天气怎么样？' },
    { role: 'assistant', content: foldedNote ? `${foldedNote}\n${finalReply1}` : finalReply1 },
    { role: 'user', content: '[当下事实] 现在是 14:21，私聊，眼前是追夜。\n\n那挺适合出门走走的，你今天在干嘛？' },
  ]
  const r2 = await callChat(gw, {
    messages: messages2,
    tools,
    tool_choice: 'auto',
    reasoning_effort: 'low',
    temperature: 0.7,
  })
  const c2 = (r2.choices as Array<Record<string, unknown>>)[0]!
  const m2 = c2.message as Record<string, unknown>
  console.log(`Turn 2 (${r2._durMs}ms) finish_reason=${c2.finish_reason}`)
  console.log('Usage 2:', JSON.stringify(r2.usage))
  console.log('Reply 2:', String(m2.content ?? ''))

  // ── Test 3: 多合一后处理 JSON 抽取（不传小 max_tokens 防截断）──────
  console.log('\n=== Test 3: Unified Post-Turn JSON Extraction ===')
  const r3 = await callChat(gw, {
    messages: [
      {
        role: 'system',
        content: '你是记忆与情绪抽取器。只输出严格 JSON：{"facts":[{"text":"...","tier":"fleeting|season|lasting|permanent","sensitivity":"open|personal|private|critical"}],"affect":{"kind":"neutral|curiosity|affection|humor","intensity":0.5},"desireHint":""}',
      },
      {
        role: 'user',
        content: '追夜说：周末我想去植物园拍点秋叶，顺便给你带点好吃的。\n我回复：好呀，记得拍清楚一点的叶子给我看。',
      },
    ],
    reasoning_effort: 'low',
    temperature: 0,
  })
  const c3 = (r3.choices as Array<Record<string, unknown>>)[0]!
  const m3 = c3.message as Record<string, unknown>
  console.log(`Extract (${r3._durMs}ms) finish_reason=${c3.finish_reason}`)
  console.log('Usage 3:', JSON.stringify(r3.usage))
  console.log('Raw JSON:', String(m3.content ?? ''))
}

main().catch((err) => {
  console.error('[G0] FAILED:', err)
  process.exit(1)
})
