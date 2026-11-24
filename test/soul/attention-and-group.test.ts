import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SqliteSoulStore } from '../../src/storage/sqlite-store.ts'
import { buildAttentionPrompt, decideAttention } from '../../src/soul/conversation/attention.ts'
import { decideGroupChime, decideShouldWait, GroupPresence } from '../../src/soul/conversation/group.ts'
import type { ChatModel, ChatRequest, ChatResponse } from '../../src/shared/ports.ts'

function fakeModel(replyText: string, onReq?: (req: ChatRequest) => void): ChatModel {
  return {
    id: 'fake',
    model: 'fake',
    async complete(req: ChatRequest): Promise<ChatResponse> {
      onReq?.(req)
      return {
        content: replyText,
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 20, reasoningTokens: 0, totalTokens: 120 },
        model: 'fake',
      }
    },
  }
}

describe('Persona-aware attention decision', () => {
  it('injects persona summary, real body facts, activity, and relation into prompt', async () => {
    const store = new SqliteSoulStore(':memory:')
    let capturedSystem = ''
    let capturedUser = ''
    const model = fakeModel('{"decision":"later","reason":"正专注拼木锁"}', (req) => {
      capturedSystem = req.messages[0]?.content ?? ''
      capturedUser = req.messages[1]?.content ?? ''
    })
    const now = new Date('2026-11-24T15:00:00+08:00')
    try {
      const inp = {
        traceId: 'tr_1',
        personaName: '纳西妲',
        personaSummary: '须弥的草神，温柔好奇，专注时会沉浸在手头的事里。',
        activity: {
          id: 'woodcraft',
          label: '拿木料和小刻刀做一件立体拼合锁',
          place: '净善宫',
          thinking: '第三面的槽有点偏',
          thinkingAt: now.toISOString(),
          startedAt: now.toISOString(),
          endsAt: new Date(now.getTime() + 25 * 60_000).toISOString(),
          yields: 'none' as const,
        },
        bodyFacts: '眼皮有点沉，稍微有点累。',
        relationFacts: '眼前这位是 追夜（相处：熟悉）。',
        message: '在吗',
        unreadCount: 1,
        isGroup: false,
        isAtMe: false,
        now,
      }
      const prompt = buildAttentionPrompt(inp)
      assert.match(prompt.system, /纳西妲/)
      assert.match(prompt.system, /须弥的草神/)
      assert.match(prompt.user, /眼皮有点沉/)
      assert.match(prompt.user, /第三面的槽有点偏/)

      const res = await decideAttention({ model, store }, inp)
      assert.equal(res.decision, 'later')
      assert.match(capturedSystem, /纳西妲/)
      assert.match(capturedUser, /追夜/)
      assert.equal(store.tokenStatsSince('2000-01-01T00:00:00.000Z').byScene.attention?.calls, 1)
    } finally {
      store.close()
    }
  })
})

describe('GroupPresence, chime classification, and dynamic wait', () => {
  it('does not refresh follow-up window timestamp and stops after maxTurns', () => {
    const gp = new GroupPresence({ followUpWindowMs: 60_000, followUpMaxTurns: 2 })
    gp.noteBotSpoke('qq:group:100', 'u1', 1000)
    assert.equal(gp.inFollowUp('qq:group:100', 'u1', 20_000), true)
    assert.equal(gp.inFollowUp('qq:group:100', 'u1', 40_000), true)
    // 第 3 次超过 maxTurns=2 → 关闭
    assert.equal(gp.inFollowUp('qq:group:100', 'u1', 50_000), false)

    // 超时校验：即使只用了 1 次，60s 后必须过期
    gp.noteBotSpoke('qq:group:100', 'u2', 1000)
    assert.equal(gp.inFollowUp('qq:group:100', 'u2', 30_000), true)
    assert.equal(gp.inFollowUp('qq:group:100', 'u2', 65_000), false)
  })

  it('dampens group chime when busy and fast-skips wait check on closing words', async () => {
    const store = new SqliteSoulStore(':memory:')
    let waitCalls = 0
    const model = fakeModel('{"kind":"question","mentionSpeaker":true}', () => { waitCalls += 1 })
    try {
      const verdictIdle = await decideGroupChime(
        { model, store },
        {
          traceId: 'tr_g1',
          botName: '纳西妲',
          recentText: '',
          currentText: '谁知道今天为什么这么冷？',
          speakerName: '小明',
          speakerId: 'u2',
          sinceBotSpoke: 5,
          activity: null,
        },
      )
      assert.ok(verdictIdle && verdictIdle.speak >= 0.6)
      assert.equal(verdictIdle?.mentionUserId, 'u2')

      const verdictBusy = await decideGroupChime(
        { model, store },
        {
          traceId: 'tr_g2',
          botName: '纳西妲',
          recentText: '',
          currentText: '谁知道今天为什么这么冷？',
          speakerName: '小明',
          speakerId: 'u2',
          sinceBotSpoke: 5,
          activity: {
            id: 'nap', label: '小憩', place: '净善宫', thinking: '',
            thinkingAt: '', startedAt: '', endsAt: '', yields: 'none',
          },
        },
      )
      assert.ok(verdictBusy && verdictBusy.speak < verdictIdle.speak)

      const callsBefore = waitCalls
      const shouldWait = await decideShouldWait({ model, store }, { recent: '', pending: '小明: 好的谢谢' })
      assert.equal(shouldWait, false)
      assert.equal(waitCalls, callsBefore, 'closing word must short-circuit with 0 LLM calls')
    } finally {
      store.close()
    }
  })
})
