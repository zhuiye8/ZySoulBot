import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteSoulStore } from '../../src/storage/sqlite-store.ts'
import { BodyEngine } from '../../src/soul/body/engine.ts'
import { RelationEngine } from '../../src/soul/relation/engine.ts'
import { isTrivialMessage } from '../../src/soul/conversation/turn.ts'
import { decideAttention } from '../../src/soul/conversation/attention.ts'
import { decideGroupChime } from '../../src/soul/conversation/group.ts'
import { collectSocialMotives } from '../../src/soul/desire/life.ts'
import { StickerLibrary } from '../../src/storage/sticker-store.ts'
import type { ChatModel } from '../../src/shared/ports.ts'

test('isTrivialMessage never skips cold/dismissive/hostile short words while keeping benign skips', () => {
  assert.equal(isTrivialMessage('晚安'), true)
  assert.equal(isTrivialMessage('好呀'), true)
  assert.equal(isTrivialMessage('谢谢'), true)

  assert.equal(isTrivialMessage('哦'), false)
  assert.equal(isTrivialMessage('随便'), false)
  assert.equal(isTrivialMessage('闭嘴'), false)
  assert.equal(isTrivialMessage('滚'), false)
  assert.equal(isTrivialMessage('好烦'), false)
})

test('BodyEngine escalates consecutive negative hits before defensive withdrawal and renders nuanced facts', () => {
  const store = new SqliteSoulStore(':memory:')
  const body = new BodyEngine(store)
  const baseTime = new Date('2026-11-24T15:00:00+08:00')
  const p0 = body.state(baseTime).pad.p

  const p1 = body.appraise({ source: 'chat', affectKind: 'annoyed', intensity: 0.7, text: '敷衍我', now: baseTime }).pad.p
  const p2 = body.appraise({ source: 'chat', affectKind: 'annoyed', intensity: 0.7, text: '又敷衍我', now: new Date(baseTime.getTime() + 60_000) }).pad.p
  const p3 = body.appraise({ source: 'chat', affectKind: 'conflict', intensity: 0.8, text: '凶我让我闭嘴', now: new Date(baseTime.getTime() + 120_000) }).pad.p

  const d1 = p0 - p1
  const d2 = p1 - p2
  assert.ok(d2 > d1, `second consecutive negative hit should escalate (${d2} > ${d1})`)
  assert.ok(p3 < p2, 'third hit should push pleasure lower')

  const facts = body.renderBodyFacts(new Date(baseTime.getTime() + 180_000))
  assert.match(facts, /堵着一口气|烦躁|绷着|疙瘩|委屈/)
  store.close()
})

test('RelationEngine enforces trust asymmetry, persists unresolved tensions, and heals via repair', () => {
  const store = new SqliteSoulStore(':memory:')
  const rels = new RelationEngine(store)
  const t0 = new Date('2026-11-24T14:00:00+08:00')

  // 建立一定熟悉度后遭遇连续严重冒犯
  for (let i = 0; i < 30; i++) rels.noteTurn('u1', { displayName: '阿明', now: t0 })
  rels.applyFeel('u1', 'worse++', 'insult', t0, '他说我太吵让我滚')
  rels.applyFeel('u1', 'worse++', 'insult', new Date(t0.getTime() + 60_000), '继续贬低我')
  const strained = rels.get('u1')
  assert.ok(strained.valence <= -0.3, `expected sharp valence drop, got ${strained.valence}`)
  assert.equal(strained.stage, 'distant')
  assert.equal(rels.isStrained('u1'), true)
  assert.ok(strained.tensions.length >= 1)

  const factsBefore = rels.renderRelationFacts({ userId: 'u1', now: t0, sharedStories: [] })
  assert.match(factsBefore, /没说开的疙瘩/)
  assert.match(factsBefore, /继续贬低我/)
  assert.match(factsBefore, /第 2 次/)

  // 认真道歉/修复两次后，心结逐步消解、关系回暖
  rels.applyFeel('u1', 'repair', 'apology', new Date(t0.getTime() + 3_600_000))
  rels.applyFeel('u1', 'repair', 'apology', new Date(t0.getTime() + 7_200_000))
  rels.applyFeel('u1', 'repair', 'apology', new Date(t0.getTime() + 10_800_000))
  const healed = rels.get('u1')
  assert.equal(healed.tensions.length, 0)
  assert.ok(healed.valence > strained.valence)
  store.close()
})

test('Mechanical consequences: hostile skips attention/chime/outreach, strained emits clear_air & adjusts stickers', async () => {
  const store = new SqliteSoulStore(':memory:')
  let llmCalls = 0
  const spyModel: ChatModel = {
    id: 'spy',
    model: 'spy',
    async complete() {
      llmCalls++
      return {
        content: '{"kind":"chat","mentionSpeaker":false}',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 10, reasoningTokens: 0, totalTokens: 20 },
        model: 'spy',
      }
    },
  }

  const now = new Date('2026-11-24T18:00:00+08:00')
  const activity = {
    id: 'read',
    label: '翻书',
    place: '书房',
    thinking: '安静看一会',
    thinkingAt: now.toISOString(),
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    yields: 'none' as const,
  }

  // 1) hostile 时在忙直接 later，不花 LLM token
  const att = await decideAttention(
    { model: spyModel, store },
    {
      traceId: 't1',
      personaName: '角色',
      personaSummary: '摘要',
      activity,
      bodyFacts: '平静',
      relationFacts: '反感',
      relationStage: 'hostile',
      message: '在干嘛',
      unreadCount: 1,
      isGroup: false,
      isAtMe: false,
      now,
    },
  )
  assert.equal(att.decision, 'later')
  assert.equal(llmCalls, 0)

  // 2) hostile 时群聊插话直接返回 null（0 token）
  const chime = await decideGroupChime(
    { model: spyModel, store },
    {
      traceId: 't2',
      botName: '角色',
      recentText: '',
      currentText: '今天天气不错',
      speakerName: '讨厌的人',
      speakerId: 'u_bad',
      speakerStage: 'hostile',
      speakerStrained: true,
      sinceBotSpoke: 5,
      activity: null,
    },
  )
  assert.equal(chime, null)
  assert.equal(llmCalls, 0)

  // 3) 自主生活动机：hostile 完全跳过；深交带未解疙瘩（12h前）只产生 clear_air 而不产生日常 missing 寒暄
  const motives = collectSocialMotives({
    now,
    promises: [],
    socialDesires: [],
    people: [
      { userId: 'u_bad', name: '反感者', lastAtMs: now.getTime() - 24 * 3_600_000, stage: 'hostile', turns: 50 },
      {
        userId: 'u_close',
        name: '老友',
        lastAtMs: now.getTime() - 12 * 3_600_000,
        stage: 'distant',
        turns: 40,
        tensions: [{ text: '昨晚说话太冲', severity: 0.7, createdAt: '2026-11-24 06:00:00' }],
      },
    ],
  })
  assert.equal(motives.some((m) => m.userId === 'u_bad'), false)
  assert.equal(motives.length, 1)
  assert.equal(motives[0]?.kind, 'clear_air')
  assert.equal(motives[0]?.userId, 'u_close')

  // 4) 表情包库：关系紧绷时屏蔽主动亲昵表情，允许负面表情
  const dir = mkdtempSync(join(tmpdir(), 'zysoul-stk-neg-'))
  try {
    writeFileSync(join(dir, 'love.png'), new Uint8Array([1]))
    writeFileSync(join(dir, 'annoyed.png'), new Uint8Array([2]))
    const lib = new StickerLibrary(dir)
    lib.upsert({ key: 'love', file: 'love.png', emotions: ['affection'] })
    lib.upsert({ key: 'annoyed', file: 'annoyed.png', emotions: ['annoyed'] })

    assert.equal(lib.select('affection', { route: 'r1', closeness: 0.2, strained: true }), null)
    assert.equal(lib.select('annoyed', { route: 'r1', closeness: 0.2, strained: true })?.key, 'annoyed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  store.close()
})
