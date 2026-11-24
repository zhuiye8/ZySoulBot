// P0 真网关端到端验证（纯内存 soul.db，完全隔离，不碰线上与磁盘数据）。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SqliteSoulStore } from '../src/storage/sqlite-store.ts'
import { loadPersonaPack } from '../src/storage/persona-loader.ts'
import { Soul } from '../src/soul/index.ts'
import { createOpenAIChatModel } from '../src/llm/openai-chat.ts'
import { InMemoryToolRegistry, registerSelfExplorationTools } from '../src/tools/registry.ts'

function loadGateway(): { baseUrl: string; apiKey: string; model: string } {
  const raw = JSON.parse(readFileSync(resolve('c:/Files/work/qq-bot/zhuiyebot/zhuiye.config.json'), 'utf8')) as {
    brains?: { openai?: { baseUrl: string; apiKey: string; model: string } }
  }
  const src = raw.brains?.openai
  if (!src) throw new Error('missing gateway config')
  let apiKey = process.env.QWEN_TOKEN_PLAN_CN_API_KEY || src.apiKey
  if (!apiKey || apiKey.startsWith('PLACEHOLDER')) {
    apiKey = readFileSync(resolve('c:/Files/work/qq-bot/zhuiyebot/.tokenplan_key'), 'utf8').trim()
  }
  return { baseUrl: src.baseUrl, apiKey, model: src.model }
}

async function main(): Promise<void> {
  const gw = loadGateway()
  const store = new SqliteSoulStore(':memory:')
  const persona = loadPersonaPack(fileURLToPath(new URL('../personas/nahida', import.meta.url)))
  const model = createOpenAIChatModel({ baseUrl: gw.baseUrl, apiKey: gw.apiKey, model: gw.model })
  const tools = new InMemoryToolRegistry()
  registerSelfExplorationTools(tools, { store, persona })

  // 预置一条过往共同记忆，验证她能自然带出故事或主动翻记忆
  store.addMemory({
    kind: 'experience',
    text: '追夜上周在雨天给我讲过一个关于海边灯塔的故事',
    about: ['1563359387'],
    sensitivity: 'personal',
    tier: 'lasting',
    disclosable: 'volunteer',
    consented: false,
    source: 'private',
    threadKey: 'qq:private:1563359387',
    affect: 'affection',
    createdAt: '2026-11-18 20:00:00',
  })

  const soul = new Soul({
    botId: 'nahida',
    persona,
    store,
    chatModel: model,
    auxModel: model,
    tools,
    identityCall: '旅行者',
  })

  try {
    console.log('--- Turn 1 ---')
    const r1 = await soul.handleTurn({
      mode: 'chat',
      threadKey: 'qq:private:1563359387',
      userId: '1563359387',
      userName: '追夜',
      text: '最近加班有点累，周末想找个安静的地方看海，你记得我上次给你讲过什么吗？',
    })
    console.log('Reply 1:', r1.reply)
    console.log('Tools 1:', r1.toolSummaries)
    console.log('Extracted 1:', JSON.stringify(r1.extracted))

    console.log('\n--- Turn 2 (极短寒暄，应跳过抽取且高命中缓存) ---')
    const r2 = await soul.handleTurn({
      mode: 'chat',
      threadKey: 'qq:private:1563359387',
      userId: '1563359387',
      userName: '追夜',
      text: '嗯',
    })
    console.log('Reply 2:', r2.reply)
    console.log('Extracted 2 (expect null):', r2.extracted)

    console.log('\n--- Token Ledger Summary ---')
    const stats = store.tokenStatsSince('2000-01-01T00:00:00.000Z')
    console.log(JSON.stringify(stats, null, 2))
    console.log('Desires seeded:', store.listDesires(['seed']).map((d) => d.want))
    console.log('Memories count:', store.recentMemories(20).length)
  } finally {
    store.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
