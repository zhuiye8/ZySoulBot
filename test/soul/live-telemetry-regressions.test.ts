import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SqliteSoulStore } from '../../src/storage/sqlite-store.ts'
import { DiaryBook } from '../../src/storage/diary.ts'
import { loadPersonaPack } from '../../src/storage/persona-loader.ts'
import { BodyEngine } from '../../src/soul/body/engine.ts'
import { DesireEngine } from '../../src/soul/desire/engine.ts'
import { collectSocialMotives, composeOutreach } from '../../src/soul/desire/life.ts'
import { MemoryEngine } from '../../src/soul/memory/engine.ts'
import { RelationEngine } from '../../src/soul/relation/engine.ts'
import { runConversationTurn } from '../../src/soul/conversation/turn.ts'
import { InMemoryToolRegistry } from '../../src/tools/registry.ts'
import { registerSelfLifeTools } from '../../src/tools/self.ts'
import { splitReply } from '../../src/transport/onebot11/deliver.ts'
import { ZysoulConfigSchema } from '../../src/shared/config.ts'
import { createApp } from '../../src/app.ts'
import type { ChatModel, ChatRequest, ChatResponse } from '../../src/shared/ports.ts'

const PERSONA_DIR = fileURLToPath(new URL('../../personas/nahida', import.meta.url))

function stubResponse(content: string): ChatResponse {
  return {
    content,
    toolCalls: [],
    finishReason: 'stop',
    usage: { inputTokens: 200, cachedTokens: 100, outputTokens: 30, reasoningTokens: 0, totalTokens: 230 },
    model: 'fake',
  }
}

describe('Live telemetry bugfix regressions (2026-11-27)', () => {
  it('1. recovers energy and pays down sleepDebt across 5-minute nocturnal ticks', () => {
    const store = new SqliteSoulStore(':memory:')
    try {
      const body = new BodyEngine(store)
      let t = new Date('2026-11-25T00:50:00+08:00')
      body.state(t)
      body.spendEnergy(0.35, t)
      const before = body.state(t)
      assert.ok(before.sleepDebt > 0.3)
      assert.ok(before.energy < 0.3)

      // 模拟真实节律器：从 00:55 到 06:50 每 5 分钟 tick 一次（dtHours = 0.083 < 2）
      for (let i = 1; i <= 71; i++) {
        t = new Date(t.getTime() + 5 * 60_000)
        body.tick(t)
      }
      const morning = body.state(t)
      assert.ok(morning.energy > 0.75, `expected recovered energy > 0.75, got ${morning.energy}`)
      assert.ok(morning.sleepDebt < 0.05, `expected sleepDebt < 0.05, got ${morning.sleepDebt}`)

      // 深夜原本在休息时被叫醒，动态感受应体现真实困意
      const lateRest = new Date('2026-11-26T01:30:00+08:00')
      const facts = body.renderBodyFacts(lateRest)
      assert.match(facts, /深夜|睡|迷糊/)
    } finally {
      store.close()
    }
  })

  it('2. tolerates null optional fields in desire_shape and prevents mindWander echo chamber', async () => {
    const store = new SqliteSoulStore(':memory:')
    try {
      const persona = loadPersonaPack(PERSONA_DIR)
      const body = new BodyEngine(store)
      const desires = new DesireEngine(store)
      const t0 = new Date('2026-11-25T10:00:00+08:00')

      const d = desires.seed({
        source: 'chat',
        motive: 'curiosity',
        want: '想去市集看看香料',
        why: '刚刚聊起须弥香料',
        now: t0,
      })!

      const nullShapeModel: ChatModel = {
        id: 'null-shape',
        model: 'fake',
        async complete(): Promise<ChatResponse> {
          return stubResponse(JSON.stringify({
            items: [{
              id: d.id,
              exitKind: 'experience',
              skillAction: null,
              skillName: null,
              basedOn: null,
              spec: null,
              needsCredential: null,
              blocker: null,
            }],
          }))
        },
      }
      const shaped = await desires.shapeSeeds({ model: nullShapeModel, readyCredentials: [] }, { traceId: 't_shape', now: t0 })
      assert.equal(shaped, 1)
      assert.equal(store.getDesire(d.id)!.stage, 'active')

      // 记忆池仅有 1 条外部记忆 + 1 条内部来由：第二次联想应在 24h 冷却内直接返回 none，且不把内部来由喂回自身
      store.addMemory({
        kind: 'fact',
        text: '追夜住在地球自己的房间里',
        about: ['u1'],
        sensitivity: 'open',
        tier: 'season',
        disclosable: 'when-asked',
        consented: false,
        source: 'private',
        provenance: 'L0_external',
        threadKey: 'qq:private:u1',
        affect: 'curiosity',
        createdAt: '2026-11-25 00:51:00',
      })
      body.appraise({
        source: 'life',
        affectKind: 'affection',
        intensity: 0.4,
        text: '窗台上的小种子酸酸的暖',
        now: t0,
      })

      let seenUserPrompt = ''
      const wanderModel: ChatModel = {
        id: 'wander',
        model: 'fake',
        async complete(req: ChatRequest): Promise<ChatResponse> {
          seenUserPrompt = req.messages[1]?.content ?? ''
          return stubResponse(JSON.stringify({ kind: 'feeling', affect: 'curiosity', intensity: 0.3, feelingNote: '想起地球的窗' }))
        },
      }
      const w1 = await desires.mindWander({ model: wanderModel, persona, body, random: () => 0 }, { traceId: 'w1', now: t0 })
      assert.equal(w1.kind, 'feeling')
      assert.doesNotMatch(seenUserPrompt, /窗台上的小种子/, 'internal life emotion cause must not feed back into mindWander')

      // 1 小时后同一记忆仍在 24h 冷却内，不再重复抽中制造回声室
      const w2 = await desires.mindWander(
        { model: wanderModel, persona, body, random: () => 0 },
        { traceId: 'w2', now: new Date(t0.getTime() + 3_600_000) },
      )
      assert.equal(w2.kind, 'none')
    } finally {
      store.close()
    }
  })

  it('3. blocks unanswered outreach spam and filters stale night-bound desires during daytime', async () => {
    const afternoon = new Date('2026-11-25T16:48:00+08:00')
    const motivesStale = collectSocialMotives({
      now: afternoon,
      promises: [],
      people: [{
        userId: 'u1',
        name: '追夜',
        lastAtMs: new Date('2026-11-25T09:59:00+08:00').getTime(),
        lastText: '早',
        lastRole: 'user',
        unansweredCount: 0,
      }],
      socialDesires: [{
        id: 'd_night',
        source: 'chat',
        motive: 'curiosity',
        want: '想了解对方深夜醒着做什么',
        why: '凌晨聊天时冒出的念头',
        exitKind: 'social',
        stage: 'active',
        spec: null,
        blocker: null,
        strength: 0.6,
        thoughtCount: 1,
        progressNote: null,
        aboutUser: 'u1',
        parentId: null,
        createdAt: '2026-11-25 00:49:39',
        updatedAt: '2026-11-25 00:49:39',
      }],
    })
    assert.equal(motivesStale.some((m) => m.ref === 'd_night'), false, 'stale midnight desire must not fire at 16:48')

    // 若她已经发过 1 条主动消息且对方 2 小时内未回，应拦截非约定类主动打扰
    const motivesBlocked = collectSocialMotives({
      now: afternoon,
      promises: [],
      people: [{
        userId: 'u1',
        name: '追夜',
        lastAtMs: new Date('2026-11-25T09:59:00+08:00').getTime(),
        lastText: '你觉得这样问合适吗？',
        lastRole: 'assistant',
        unansweredCount: 1,
        lastMsgAtMs: new Date('2026-11-25T15:28:00+08:00').getTime(),
      }],
      socialDesires: [{
        id: 'd_day',
        source: 'chat',
        motive: 'curiosity',
        want: '想聊聊须弥的雨林',
        why: '忽然想起',
        exitKind: 'social',
        stage: 'active',
        spec: null,
        blocker: null,
        strength: 0.6,
        thoughtCount: 1,
        progressNote: null,
        aboutUser: 'u1',
        parentId: null,
        createdAt: '2026-11-25 14:00:00',
        updatedAt: '2026-11-25 14:00:00',
      }],
    })
    assert.equal(motivesBlocked.length, 0)

    // composeOutreach 必须注入精确当下时间与时段，防止时间幻觉
    const store = new SqliteSoulStore(':memory:')
    try {
      const persona = loadPersonaPack(PERSONA_DIR)
      let capturedSys = ''
      const fakeModel: ChatModel = {
        id: 'outreach',
        model: 'fake',
        async complete(req: ChatRequest): Promise<ChatResponse> {
          capturedSys = req.messages[0]?.content ?? ''
          return stubResponse('下午好呀，忽然想起早上那片叶子。')
        },
      }
      const text = await composeOutreach(
        { model: fakeModel, store, persona },
        { traceId: 'o1', purpose: '聊聊叶子', relationFacts: '追夜', memoryFacts: '', bodyFacts: '', now: afternoon },
      )
      assert.ok(text)
      assert.match(capturedSys, /16:48/)
      assert.match(capturedSys, /下午/)
    } finally {
      store.close()
    }
  })

  it('4. supersedes old name facts on call_changed, deduplicates repeated call_changed, and triggers HumanLM <inner> alignment', async () => {
    const store = new SqliteSoulStore(':memory:')
    try {
      const persona = loadPersonaPack(PERSONA_DIR)
      const body = new BodyEngine(store)
      const memory = new MemoryEngine(store)
      const relations = new RelationEngine(store)
      const tools = new InMemoryToolRegistry()
      const t0 = new Date('2026-11-25T10:00:00+08:00')

      // 先存一条旧昵称事实
      const oldMem = memory.remember({
        kind: 'fact',
        text: '对方名字是★灬☆そ，今天第一次听见',
        about: ['u1'],
        sensitivity: 'open',
        tier: 'lasting',
        disclosable: 'when-asked',
        consented: false,
        source: 'private',
        provenance: 'L0_external',
        threadKey: 'qq:private:u1',
        affect: 'curiosity',
        createdAt: '2026-11-25 00:49:45',
      })!
      assert.ok(oldMem)

      const seenDynamicBlocks: string[] = []
      const chatModel: ChatModel = {
        id: 'chat',
        model: 'fake',
        async complete(req: ChatRequest): Promise<ChatResponse> {
          seenDynamicBlocks.push(req.messages[req.messages.length - 1]?.content ?? '')
          return stubResponse('<inner>立场：初见自然微距；目的：记住名字说完就停；表达：短句不反问</inner>\n追夜 好，我记住了')
        },
      }
      const auxModel: ChatModel = {
        id: 'aux',
        model: 'fake',
        async complete(): Promise<ChatResponse> {
          return stubResponse(JSON.stringify({
            pragmaticNote: '对方告知偏好称呼',
            facts: [{ kind: 'address', text: '对方让我称呼其追夜', tier: 'permanent', sensitivity: 'personal', disclosable: 'when-asked', call: '追夜' }],
            affect: { kind: 'curiosity', intensity: 0.3 },
            happened: '',
            relationFeel: 'better+',
            tensionNote: '',
            selfMistake: '',
            signalKind: 'chat',
            desireHint: '',
          }))
        },
      }

      // 第 1 轮：改称呼 ★灬☆そ -> 追夜
      const out1 = await runConversationTurn(
        { persona, store, body, memory, relations, chatModel, auxModel, tools, clock: { now: () => t0 } },
        { mode: 'chat', botId: 'nahida', threadKey: 'qq:private:u1', userId: 'u1', userName: '★灬☆そ', text: '叫我追夜吧' },
      )
      // <inner> 已剥离，且初见阶段动态尾注启用了立场/目的/表达节奏锚点
      assert.equal(out1.reply, '追夜 好，我记住了')
      assert.match(seenDynamicBlocks[0]!, /立场.*目的.*表达节奏/)

      // 旧名字事实必须被双时态失效，不再出现在 memoriesAbout 里
      const activeFacts = store.memoriesAbout('u1', 10)
      assert.equal(activeFacts.some((m) => m.id === oldMem.id), false, 'old nickname fact must be superseded')
      assert.equal(relations.nameOf('u1'), '追夜')

      // 第 2 轮：模型再次抽到同一个 call="追夜"，不得重复写 call_changed trace
      await runConversationTurn(
        { persona, store, body, memory, relations, chatModel, auxModel, tools, clock: { now: () => new Date(t0.getTime() + 60_000) } },
        { mode: 'chat', botId: 'nahida', threadKey: 'qq:private:u1', userId: 'u1', userName: '追夜', text: '你在哪儿' },
      )
      const callTraces = store.recentTraces(50).filter((tr) => tr.event === 'call_changed')
      assert.equal(callTraces.length, 1, 'repeated same call must not emit duplicate call_changed trace')
    } finally {
      store.close()
    }
  })

  it('5. softens mid-bubble periods naturally in casual QQ replies and supports save_work tool', async () => {
    const bubbles = splitReply('在净善宫。我自己的房间。\n\n你呢，追夜现在在哪儿？')
    assert.deepEqual(bubbles, ['在净善宫 我自己的房间', '你呢，追夜现在在哪儿？'])

    // 引号内与列表保持原样
    const quoted = splitReply('书上写「见过」。\n\n- 第一步\n- 第二步')
    assert.deepEqual(quoted, ['书上写「见过」', '- 第一步\n- 第二步'])

    // save_work 正常落入 works 表
    const tmpDir = mkdtempSync(join(tmpdir(), 'zysoul-work-'))
    const store = new SqliteSoulStore(':memory:')
    try {
      const tools = new InMemoryToolRegistry()
      registerSelfLifeTools(tools, { store, diary: new DiaryBook(tmpDir) })
      const tool = tools.get('save_work')
      assert.ok(tool)
      const res = await tool.execute(
        { kind: 'note', title: '叶形小木牌尺寸', content: '长 48 宽 26 厚 4 毫米，绳孔距边 4 毫米。', moodNote: '算好了步骤' },
        { botId: 'nahida', threadKey: 'solo:desire:1', userId: 'nahida', userName: '纳西妲', isGroup: false, solo: true, now: new Date() },
      )
      assert.match(res.output, /叶形小木牌尺寸/)
      const works = store.listWorks('note', 10)
      assert.equal(works.length, 1)
      assert.equal(works[0]!.title, '叶形小木牌尺寸')
      assert.equal(works[0]!.status, 'ready')
    } finally {
      store.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('6. prevents pursue_desire amnesia/infinite loop via progressNote injection, 4h cooldown, and 3-strike fade', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'zysoul-desire-loop-'))
    let currentTime = new Date('2026-11-26T10:00:00+08:00')
    const seenSoloPrompts: string[] = []

    // 永远返回工具调用，模拟每轮耗尽 maxSteps (stopReason = exhausted)
    const endlessToolModel: ChatModel = {
      id: 'endless',
      model: 'fake',
      async complete(req: ChatRequest): Promise<ChatResponse> {
        const userMsg = req.messages.find((m) => m.role === 'user')?.content ?? ''
        if (!seenSoloPrompts.includes(userMsg)) seenSoloPrompts.push(userMsg)
        return {
          content: '',
          toolCalls: [{ id: `tc_${Math.random().toString(36).slice(2, 7)}`, name: 'workspace_list', arguments: '{"dir":"."}' }],
          finishReason: 'tool_calls',
          usage: { inputTokens: 300, cachedTokens: 200, outputTokens: 20, reasoningTokens: 0, totalTokens: 320 },
          model: 'fake',
        }
      },
    }

    const auxModel: ChatModel = {
      id: 'aux',
      model: 'fake',
      async complete(req: ChatRequest): Promise<ChatResponse> {
        const user = req.messages[1]?.content ?? ''
        const m = /-\s*\[([^\]]+)\]\s*\(create_work\)/.exec(user)
        if (m?.[1]) return stubResponse(JSON.stringify({ do: 'pursue_desire', id: m[1] }))
        return stubResponse('{"do":"nothing"}')
      },
    }

    const cfg = ZysoulConfigSchema.parse({
      chatLlm: { baseUrl: 'https://example.com/v1', apiKey: 'test', model: 'fake' },
      bots: [{
        id: 'nahida',
        dataDir: tempDir,
        personaDir: PERSONA_DIR,
        selfId: '3164305169',
        access: { users: ['u1'], groups: [], admins: ['u1'] },
        proactivity: { enabled: true, allowlist: ['u1'] },
      }],
    })

    const app = createApp(cfg, {
      inMemoryDb: true,
      chatModelOverride: endlessToolModel,
      auxModelOverride: auxModel,
      clock: { now: () => currentTime },
      random: () => 0.01,
      rhythmStartupGraceMs: 0,
      listenAdmin: false,
    })

    try {
      const bot = app.bots[0]!
      const d = bot.soul.desires.seed({
        source: 'wander',
        motive: 'curiosity',
        want: '做一片叶脉拼图',
        why: '想比对那片偏深的绿',
        exitKind: 'create_work',
        stage: 'active',
        now: currentTime,
      })!
      const origProgressAt = d.lastProgressAt

      // 第 1 次推进：耗尽步数 → 保留 active，但不得刷新 lastProgressAt，且进入 4h 冷却
      await app.rhythm.tickOnce()
      const after1 = bot.store.getDesire(d.id)!
      assert.equal(after1.stage, 'active')
      assert.equal(after1.lastProgressAt, origProgressAt, 'exhausted run must not refresh lastProgressAt')

      // 30 分钟后再 tick：仍在 4h 冷却期内，不得重复拉起同一愿望
      currentTime = new Date(currentTime.getTime() + 30 * 60_000)
      const promptsBeforeCooldown = seenSoloPrompts.length
      await app.rhythm.tickOnce()
      assert.equal(seenSoloPrompts.length, promptsBeforeCooldown, 'desire must be in 4h cooldown')

      // 5 小时后第 2 次推进：Prompt 必须注入上次的 progressNote
      currentTime = new Date(currentTime.getTime() + 5 * 3_600_000)
      await app.rhythm.tickOnce()
      assert.ok(seenSoloPrompts.some((p) => p.includes('上次推进进度')))
      assert.equal(bot.store.getDesire(d.id)!.stage, 'active')

      // 再过 5 小时第 3 次推进仍未收口 → 自动淡去为 faded，彻底阻断死循环
      currentTime = new Date(currentTime.getTime() + 5 * 3_600_000)
      await app.rhythm.tickOnce()
      assert.equal(bot.store.getDesire(d.id)!.stage, 'faded')
    } finally {
      await app.dispose()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
