import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { SqliteSoulStore } from '../../src/storage/sqlite-store.ts'
import { loadPersonaPack } from '../../src/storage/persona-loader.ts'
import { Soul } from '../../src/soul/index.ts'
import { InMemoryToolRegistry, registerSelfExplorationTools } from '../../src/tools/registry.ts'
import type { ChatModel, ChatRequest, ChatResponse } from '../../src/shared/ports.ts'

describe('Soul native Agent Loop, Prefix Cache invariant, and unified extraction', () => {
  it('loads Nahida PersonaPack + activities, runs native tool loop, folds raw tool output, and keeps static system byte-identical', async () => {
    const store = new SqliteSoulStore(':memory:')
    const persona = loadPersonaPack(fileURLToPath(new URL('../../personas/nahida', import.meta.url)))
    assert.ok(persona.activities.length >= 8)
    assert.ok(persona.staticSystemPrompt.includes('纳西妲'))

    const tools = new InMemoryToolRegistry()
    registerSelfExplorationTools(tools, { store, persona })
    tools.register({
      layer: 'explore',
      spec: {
        name: 'web_search',
        description: '模拟上网搜索',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
      async execute() {
        return {
          output: 'HUGE_RAW_HTML_CONTENT_'.repeat(300), // 6600 字脏网页输出
          foldSummary: '查了北京天气：晴 12℃',
        }
      },
    })

    const capturedSystemPrompts: string[] = []
    const capturedRequests: ChatRequest[] = []
    let chatCall = 0
    const fakeChatModel: ChatModel = {
      id: 'fake-chat',
      model: 'fake-v4',
      async complete(req: ChatRequest): Promise<ChatResponse> {
        capturedRequests.push(req)
        const sys = req.messages[0]?.content ?? ''
        capturedSystemPrompts.push(sys)
        chatCall += 1
        // 第 1 次：主动触发 web_search
        if (chatCall === 1) {
          return {
            content: '',
            toolCalls: [{ id: 'tc_1', name: 'web_search', arguments: '{"query":"北京天气"}' }],
            finishReason: 'tool_calls',
            usage: { inputTokens: 3000, cachedTokens: 0, outputTokens: 20, reasoningTokens: 5, totalTokens: 3020 },
            model: 'fake-v4',
          }
        }
        // 第 2 次：收到截断后的工具结果，回复正文
        if (chatCall === 2) {
          const toolMsg = req.messages[req.messages.length - 1]
          assert.equal(toolMsg?.role, 'tool')
          assert.ok((toolMsg?.content.length ?? 0) < 2600, 'raw tool output must be truncated')
          return {
            content: '今天北京是晴天，十二度左右。',
            toolCalls: [],
            finishReason: 'stop',
            usage: { inputTokens: 3100, cachedTokens: 3000, outputTokens: 18, reasoningTokens: 4, totalTokens: 3118 },
            model: 'fake-v4',
          }
        }
        // 第 3 次：第二轮极短寒暄
        return {
          content: '嗯。',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 3120, cachedTokens: 3000, outputTokens: 4, reasoningTokens: 2, totalTokens: 3124 },
          model: 'fake-v4',
        }
      },
    }

    let auxCalls = 0
    const fakeAuxModel: ChatModel = {
      id: 'fake-aux',
      model: 'fake-aux',
      async complete(): Promise<ChatResponse> {
        auxCalls += 1
        return {
          content: JSON.stringify({
            facts: [{ kind: 'address', text: '他让我叫他追夜', tier: 'permanent', sensitivity: 'open', disclosable: 'volunteer', call: '追夜' }],
            affect: { kind: 'curiosity', intensity: 0.6 },
            happened: '一起聊了北京的天气',
            relationFeel: 'better+',
            signalKind: 'chat',
            desireHint: '我想画一张秋日晴空的草图',
          }),
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 200, cachedTokens: 0, outputTokens: 90, reasoningTokens: 40, totalTokens: 290 },
          model: 'fake-aux',
        }
      },
    }

    let currentMs = Date.parse('2026-11-24T14:00:00+08:00')
    const soul = new Soul({
      botId: 'nahida',
      persona,
      store,
      chatModel: fakeChatModel,
      auxModel: fakeAuxModel,
      tools,
      clock: { now: () => new Date(currentMs) },
    })

    try {
      // Turn 1：带实质内容 + 主动工具调用
      const r1 = await soul.handleTurn({
        mode: 'chat',
        threadKey: 'qq:private:1563359387',
        userId: '1563359387',
        userName: '旧昵称',
        text: '以后喊我追夜，帮我看看北京今天天气怎么样？',
      })
      assert.equal(r1.reply, '今天北京是晴天，十二度左右。')
      assert.equal(r1.steps, 2)
      assert.deepEqual(r1.toolSummaries, ['查了北京天气：晴 12℃'])
      assert.equal(auxCalls, 1)
      // 称呼已联动更新，欲望种子已种下
      assert.equal(soul.relations.nameOf('1563359387'), '追夜')
      assert.equal(store.listDesires(['seed']).length, 1)

      // 时间前进 5 分钟，跑 Turn 2（极短寒暄 “嗯”）
      currentMs += 5 * 60_000
      const r2 = await soul.handleTurn({
        mode: 'chat',
        threadKey: 'qq:private:1563359387',
        userId: '1563359387',
        text: '嗯',
      })
      assert.equal(r2.reply, '嗯。')
      // 极短寒暄跳过后处理抽取：auxCalls 仍为 1
      assert.equal(auxCalls, 1)

      // 核心不变量 1：跨回合 System Prompt 必须逐字节一致（保护 Prefix Cache）
      assert.equal(capturedSystemPrompts[0], capturedSystemPrompts[2])

      // 核心不变量 2：第二轮历史里绝不出现 6600 字的 HUGE_RAW_HTML_CONTENT，只有折叠后的 1 行摘要
      const turn2Payload = JSON.stringify(capturedRequests[2]!.messages)
      assert.ok(!turn2Payload.includes('HUGE_RAW_HTML_CONTENT'))
      assert.ok(turn2Payload.includes('查了北京天气：晴 12℃'))

      // 核心不变量 3：Token 账本精确入账
      const stats = store.tokenStatsSince('2000-01-01T00:00:00.000Z')
      assert.equal(stats.byScene.chat?.calls, 3)
      assert.equal(stats.byScene.extract?.calls, 1)
      assert.equal(stats.totalCached, 6000)
    } finally {
      store.close()
    }
  })
})
