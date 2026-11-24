import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SqliteSoulStore } from '../../src/storage/sqlite-store.ts'
import { CredentialStore } from '../../src/storage/credentials-store.ts'
import { loadPersonaPack } from '../../src/storage/persona-loader.ts'
import { DiaryBook } from '../../src/storage/diary.ts'
import { BodyEngine } from '../../src/soul/body/engine.ts'
import { MemoryEngine, visibilityOf } from '../../src/soul/memory/engine.ts'
import { RelationEngine } from '../../src/soul/relation/engine.ts'
import { checkBuildScope, DesireEngine } from '../../src/soul/desire/engine.ts'
import { reflectOnToday } from '../../src/soul/desire/life.ts'
import { isTrivialMessage, stripInnerMonologue } from '../../src/soul/conversation/turn.ts'
import { runAgentLoop } from '../../src/soul/agent/loop.ts'
import { Soul } from '../../src/soul/index.ts'
import { InMemoryToolRegistry, registerSelfExplorationTools } from '../../src/tools/registry.ts'
import { registerWorkspaceTools, safeResolveInWorkspace } from '../../src/tools/workspace.ts'
import { isSafePublicUrl, registerWebTools } from '../../src/tools/web.ts'
import { registerSelfLifeTools } from '../../src/tools/self.ts'
import { createOpenAIChatModel } from '../../src/llm/openai-chat.ts'
import { createRhythm } from '../../src/rhythm.ts'
import { SerialQueue } from '../../src/shared/serial-queue.ts'
import { ZysoulConfigSchema } from '../../src/shared/config.ts'
import { createAdminApp } from '../../src/admin/server.ts'
import type { ChatModel, ChatRequest, ChatResponse, SingingPort, TransportPort } from '../../src/shared/ports.ts'

const NAHIDA_PACK_DIR = fileURLToPath(new URL('../../personas/nahida', import.meta.url))

function stubModel(fn: (req: ChatRequest, call: number) => ChatResponse | Promise<ChatResponse>): ChatModel {
  let n = 0
  return {
    id: 'stub',
    model: 'stub',
    async complete(req) {
      n += 1
      return fn(req, n)
    },
  }
}

describe('GPT Pro Red-Team Regressions (All 8 Adversarial Suites)', () => {
  it('Suite 1: Workspace disables local exec by default, keeps tools frozen, scrubs secrets, and blocks symlinks & huge reads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zysoul-rt-ws-'))
    const store = new SqliteSoulStore(':memory:')
    const creds = new CredentialStore(join(dir, 'creds.json'))
    try {
      const wsDir = join(dir, 'workspace')
      const regDefault = new InMemoryToolRegistry()
      registerWorkspaceTools(regDefault, { workspaceDir: wsDir, store, credentials: creds })
      const ctx = { botId: 'nahida', threadKey: 'solo:1', userId: '1', userName: 'admin', isGroup: false, solo: true, now: new Date() }

      // 默认关闭执行期，但工具定义仍完整冻结
      assert.ok(regDefault.list(['create']).some((s) => s.name === 'workspace_run'))
      const runBlocked = await regDefault.get('workspace_run')!.execute({ command: 'echo hi' }, ctx)
      assert.equal(runBlocked.isError, true)

      await regDefault.get('workspace_write')!.execute({ path: 'skills/demo/SKILL.md', content: '# demo' }, ctx)
      const verifyBlocked = await regDefault.get('register_skill')!.execute({
        name: 'demo',
        summary: 'test',
        verifyCommand: 'echo ok',
      }, ctx)
      assert.equal(verifyBlocked.isError, true)

      // 显式开启后仍强制脱敏输出中的凭证（含原值与 base64）
      creds.registerNeed({
        name: 'svc',
        label: 'SVC',
        provider: 'p',
        fields: [{ key: 'token', label: 'Token', type: 'secret', required: true }],
      })
      creds.fill('svc', { token: 'TOP_SECRET_ALPHA_999' })
      const regOptIn = new InMemoryToolRegistry()
      registerWorkspaceTools(regOptIn, {
        workspaceDir: wsDir,
        store,
        credentials: creds,
        allowUnsafeLocalExec: true,
        injectCredentialsPath: true,
      })
      const runRes = await regOptIn.get('workspace_run')!.execute({
        command: 'node -e "const fs=require(\'fs\'); const v=JSON.parse(fs.readFileSync(process.env.ZYSOUL_CREDENTIALS,\'utf8\')).filled.svc.values.token; console.log(v, Buffer.from(v).toString(\'base64\'))"',
      }, ctx)
      assert.ok(!runRes.output.includes('TOP_SECRET_ALPHA_999'))
      assert.ok(!runRes.output.includes(Buffer.from('TOP_SECRET_ALPHA_999').toString('base64')))
      assert.match(runRes.output, /REDACTED_SECRET/)

      // 超大文件在读取前拦截（P1-SEC-04）
      writeFileSync(join(wsDir, 'huge.txt'), 'A'.repeat(1_200_000), 'utf8')
      const hugeRes = await regDefault.get('workspace_read')!.execute({ path: 'huge.txt' }, ctx)
      assert.equal(hugeRes.isError, true)

      // 符号链接越界拦截（P1-SEC-03；若当前环境有 symlink 权限则执行真实符号链接验证）
      const outside = join(dir, 'outside-secret.txt')
      writeFileSync(outside, 'OUTSIDE_DATA', 'utf8')
      let symlinkCreated = false
      try {
        symlinkSync(outside, join(wsDir, 'escape-link.txt'))
        symlinkCreated = true
      } catch {
        // 无 Windows 符号链接权限时跳过文件创建
      }
      if (symlinkCreated) {
        assert.equal(safeResolveInWorkspace(wsDir, 'escape-link.txt'), null)
        const symRead = await regDefault.get('workspace_read')!.execute({ path: 'escape-link.txt' }, ctx)
        assert.equal(symRead.isError, true)
        assert.ok(!symRead.output.includes('OUTSIDE_DATA'))
      }
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('Suite 2: web_fetch blocks mapped IPv6, localhost., private DNS, redirects, and cancels oversized streams', async () => {
    assert.equal(isSafePublicUrl('http://[::ffff:127.0.0.1]/'), false)
    assert.equal(isSafePublicUrl('http://[::ffff:7f00:1]/'), false)
    assert.equal(isSafePublicUrl('http://localhost./'), false)
    assert.equal(isSafePublicUrl('http://sub.localhost/'), false)
    assert.equal(isSafePublicUrl('http://169.254.169.254/latest/meta-data/'), false)
    assert.equal(isSafePublicUrl('https://example.com/article'), true)

    const ctx = { botId: 'nahida', threadKey: 'qq:private:1', userId: '1', userName: 'u', isGroup: false, solo: false, now: new Date() }

    // DNS 解析到内网地址拦截
    const regDns = new InMemoryToolRegistry()
    registerWebTools(regDns, {
      lookupImpl: async () => [{ address: '::ffff:127.0.0.1', family: 6 }],
      fetchImpl: (async () => new Response('SHOULD_NOT_FETCH')) as unknown as typeof fetch,
    })
    const dnsBlocked = await regDns.get('web_fetch')!.execute({ url: 'https://evil.example.com/' }, ctx)
    assert.equal(dnsBlocked.isError, true)

    // 重定向拒绝（redirect: 'error'）与 302 拒绝
    let seenRedirect: string | undefined
    const regRedir = new InMemoryToolRegistry()
    registerWebTools(regRedir, {
      fetchImpl: (async (_u: string | URL | Request, init?: RequestInit) => {
        seenRedirect = init?.redirect
        return new Response('', { status: 302, headers: { location: 'http://127.0.0.1:8787/' } })
      }) as unknown as typeof fetch,
    })
    const redirRes = await regRedir.get('web_fetch')!.execute({ url: 'https://example.com/r' }, ctx)
    assert.equal(seenRedirect, 'error')
    assert.equal(redirRes.isError, true)

    // 分块大响应触发流式字节预算并取消读取
    let cancelled = false
    const regStream = new InMemoryToolRegistry()
    registerWebTools(regStream, {
      maxFetchBytes: 64,
      fetchImpl: (async () => {
        let sent = 0
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            sent += 1
            if (sent <= 10) controller.enqueue(new Uint8Array(32).fill(65))
            else controller.close()
          },
          cancel() {
            cancelled = true
          },
        })
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } })
      }) as unknown as typeof fetch,
    })
    const streamRes = await regStream.get('web_fetch')!.execute({ url: 'https://example.com/big' }, ctx)
    assert.equal(cancelled, true)
    assert.ok(streamRes.output.length <= 64)
  })

  it('Suite 3: Privacy disclosure unifies recall/tool/sharedStories, strips unclosed <inner>, and enforces L2 provenance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zysoul-rt-priv-'))
    const dbPath = join(dir, 'soul.db')
    const store = new SqliteSoulStore(dbPath)
    try {
      const mem = new MemoryEngine(store)
      const persona = loadPersonaPack(NAHIDA_PACK_DIR)
      const reg = new InMemoryToolRegistry()
      registerSelfExplorationTools(reg, { store, persona, memory: mem })

      // 存入用户 A 的私密绝密口令
      const secretItem = store.addMemory({
        kind: 'fact',
        text: '示例甲的保险柜口令是 DEMO_PRIVATE_4711',
        about: ['userA'],
        sensitivity: 'critical',
        tier: 'permanent',
        disclosable: 'secretive',
        consented: false,
        source: 'private',
        threadKey: 'qq:private:userA',
        affect: null,
      })

      // 陌生人 B 通过正常召回、recall_memory 工具、sharedStories 均不可见
      assert.equal(visibilityOf(secretItem, { listener: 'userB', tier: 'low', isGroup: false }), 'no')
      const recalled = mem.recallForTurn({
        listener: 'userB',
        tier: 'low',
        isGroup: false,
        query: '保险柜',
        now: new Date(),
        nameOf: (u) => u,
      })
      assert.ok(!recalled.text.includes('DEMO_PRIVATE_4711'))

      const toolOut = await reg.get('recall_memory')!.execute(
        { query: '保险柜' },
        { botId: 'nahida', threadKey: 'qq:private:userB', userId: 'userB', userName: 'B', isGroup: false, solo: false, now: new Date() },
      )
      assert.ok(!toolOut.output.includes('DEMO_PRIVATE_4711'))

      // 用户 A 本人在群聊里也不能把未授权私聊绝密记忆带进群聊
      assert.equal(visibilityOf(secretItem, { listener: 'userA', tier: 'high', isGroup: true }), 'no')
      assert.equal(mem.sharedStories('userA', 3, { isGroup: true, listener: 'userA', tier: 'high' }).length, 0)

      // 未闭合 <inner> 截断绝不外泄
      const unclosed = stripInnerMonologue('<inner>PRIVATE_DEMO')
      assert.equal(unclosed.reply, '')
      assert.equal(unclosed.inner, 'PRIVATE_DEMO')
      assert.equal(unclosed.hadInner, true)

      const mixed = stripInnerMonologue('先说一句<inner>秘密吐槽<inner>嵌套')
      assert.equal(mixed.reply, '先说一句')
      assert.ok(mixed.inner.includes('秘密吐槽'))

      // reflectOnToday 走 MemoryEngine.remember → L2_internal + tier 封顶 season
      const now = new Date('2026-11-24T22:00:00+08:00')
      store.addMemory({ kind: 'experience', text: '上午晒了太阳', about: [], sensitivity: 'open', tier: 'season', disclosable: 'volunteer', consented: false, source: 'private', threadKey: 't', affect: null, createdAt: '2026-11-24 10:00:00' })
      store.addMemory({ kind: 'experience', text: '下午喝了花茶', about: [], sensitivity: 'open', tier: 'season', disclosable: 'volunteer', consented: false, source: 'private', threadKey: 't', affect: null, createdAt: '2026-11-24 15:00:00' })
      const added = await reflectOnToday(
        {
          model: stubModel(() => ({
            content: JSON.stringify({ insights: ['安静的日子也有淡淡的甜味'] }),
            toolCalls: [],
            finishReason: 'stop',
            usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 10, reasoningTokens: 0, totalTokens: 20 },
            model: 'stub',
          })),
          store,
          persona,
        },
        { traceId: 't_ref', now },
      )
      assert.equal(added, 1)
      const insight = store.recentMemories(10).find((m) => m.kind === 'insight')!
      assert.equal(insight.provenance, 'L2_internal')
      assert.equal(insight.tier, 'season')
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('Suite 4: Strict debt conservation prevents all 3 GPT Pro repair arbitrage counterexamples', () => {
    const store = new SqliteSoulStore(':memory:')
    try {
      const rel = new RelationEngine(store)
      const t0 = new Date('2026-11-24T12:00:00+08:00')

      // 反例 1：初始三轴均为 0.8；(worse++, repair) × 3，之后只在有心结时继续 repair
      const u1 = rel.get('u1')
      u1.trust = 0.8
      u1.closeness = 0.8
      u1.valence = 0.8
      store.saveRelation(u1)
      for (let i = 0; i < 3; i++) {
        rel.applyFeel('u1', 'worse++', 'insult', new Date(t0.getTime() + i * 60_000), `骂我第${i}次`)
        rel.applyFeel('u1', 'repair', 'apology', new Date(t0.getTime() + i * 60_000 + 30_000))
      }
      for (let i = 0; i < 10 && rel.get('u1').tensions.length > 0; i++) {
        rel.applyFeel('u1', 'repair', 'apology', new Date(t0.getTime() + (10 + i) * 60_000))
      }
      assert.ok(rel.get('u1').trust <= 0.8, `expected trust <= 0.8, got ${rel.get('u1').trust}`)
      assert.ok(rel.get('u1').closeness <= 0.8)
      assert.ok(rel.get('u1').valence <= 0.8)

      // 反例 2：默认关系；一次 worse+，再二十次 repair
      const initTrust = rel.get('u2').trust
      rel.applyFeel('u2', 'worse+', 'dismissive', t0, '敷衍')
      for (let i = 0; i < 20; i++) {
        rel.applyFeel('u2', 'repair', 'apology', new Date(t0.getTime() + (i + 1) * 60_000))
      }
      assert.ok(rel.get('u2').trust <= initTrust, `expected trust <= ${initTrust}, got ${rel.get('u2').trust}`)

      // 反例 3：默认关系触底；三次 worse++，再只在有心结时 repair
      const init3 = rel.get('u3')
      for (let i = 0; i < 3; i++) {
        rel.applyFeel('u3', 'worse++', 'insult', new Date(t0.getTime() + i * 60_000), '重伤')
      }
      for (let i = 0; i < 20 && rel.get('u3').tensions.length > 0; i++) {
        rel.applyFeel('u3', 'repair', 'apology', new Date(t0.getTime() + (10 + i) * 60_000))
      }
      assert.ok(rel.get('u3').trust <= init3.trust, `expected trust <= ${init3.trust}, got ${rel.get('u3').trust}`)
      assert.ok(rel.get('u3').closeness <= init3.closeness, `expected closeness <= ${init3.closeness}, got ${rel.get('u3').closeness}`)
    } finally {
      store.close()
    }
  })

  it('Suite 5: Daily kind interactions recover from hostile, tension decay is idempotent, and 2-char insults/apologies are not skipped', () => {
    const store = new SqliteSoulStore(':memory:')
    try {
      const rel = new RelationEngine(store)
      const day0 = new Date('2026-01-01T12:00:00+08:00')
      for (let i = 0; i < 6; i++) {
        rel.applyFeel('u_rec', 'worse++', 'insult', new Date(day0.getTime() + i * 60_000), '狠狠伤了心')
      }
      assert.equal(rel.get('u_rec').stage, 'hostile')
      for (let d = 1; d <= 60; d++) {
        rel.applyFeel('u_rec', 'better++', 'affection', new Date(day0.getTime() + d * 86_400_000))
      }
      const recovered = rel.get('u_rec')
      assert.ok(recovered.valence > 0, `expected positive valence after 60 daily kind days, got ${recovered.valence}`)
      assert.notEqual(recovered.stage, 'hostile')

      // 同一时间戳重复调用 noteTurn 严格幂等
      rel.applyFeel('u_dec', 'worse+', 'dismissive', day0, '语气不好')
      const day8 = new Date(day0.getTime() + 8 * 86_400_000)
      rel.noteTurn('u_dec', { now: day8 })
      const sevAfter1 = rel.get('u_dec').tensions[0]?.severity
      assert.ok(sevAfter1 !== undefined)
      for (let i = 0; i < 5; i++) {
        rel.noteTurn('u_dec', { now: day8 })
      }
      assert.equal(rel.get('u_dec').tensions[0]?.severity, sevAfter1)

      // 两字冒犯/道歉绝不当寒暄跳过
      assert.equal(isTrivialMessage('抱歉'), false)
      assert.equal(isTrivialMessage('去死'), false)
      assert.equal(isTrivialMessage('垃圾'), false)
      assert.equal(isTrivialMessage('嗯'), true)
      assert.equal(isTrivialMessage('ok'), true)
    } finally {
      store.close()
    }
  })

  it('Suite 6: Persistent L2 daily mood cap survives SQLite reopen and covers internal activity completions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zysoul-rt-body-'))
    const dbPath = join(dir, 'soul.db')
    const now = new Date('2026-11-24T14:00:00+08:00')
    try {
      const store1 = new SqliteSoulStore(dbPath)
      const body1 = new BodyEngine(store1)
      const startMoodP = body1.state(now).mood.p
      for (let i = 0; i < 4; i++) {
        body1.appraise({ source: 'life', affectKind: 'sadness', intensity: 1, text: '自省', now })
      }
      const after1 = body1.state(now).mood.p
      assert.ok(startMoodP - after1 <= 0.0501)
      store1.close()

      // 重开同一数据库 + 重建 BodyEngine，当日已用额度仍保持持久化
      const store2 = new SqliteSoulStore(dbPath)
      const body2 = new BodyEngine(store2)
      body2.appraise({ source: 'life', affectKind: 'sadness', intensity: 1, text: '重启后再次自省', now })
      const after2 = body2.state(now).mood.p
      assert.ok(Math.abs(after2 - after1) < 1e-6, `expected mood.p unchanged after restart, got ${after1} -> ${after2}`)
      store2.close()

      // 新库测试内部活动完成同样受单日 +0.05 限额约束
      const store3 = new SqliteSoulStore(':memory:')
      const body3 = new BodyEngine(store3)
      const baseP = body3.state(now).mood.p
      for (let i = 0; i < 4; i++) {
        const t = new Date(now.getTime() + i * 35 * 60_000)
        body3.startActivity({
          id: 'listen_dreams',
          label: '听梦',
          place: '净善宫',
          times: ['afternoon'],
          durationMin: [20, 30],
          yields: 'sight',
          effects: { pad: { p: 0.2 } },
        }, '听见好梦', 30, t)
        body3.completeActivityIfDue(new Date(t.getTime() + 31 * 60_000))
      }
      assert.ok(body3.state(new Date(now.getTime() + 180 * 60_000)).mood.p - baseP <= 0.0501)
      store3.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('Suite 7: Resilient rhythm ticks, crash recovery, ACK pending replies, song delivery retry, abandon race, and one-shot approval', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zysoul-rt-state-'))
    const store = new SqliteSoulStore(':memory:')
    const creds = new CredentialStore(join(dir, 'creds.json'))
    try {
      const persona = loadPersonaPack(NAHIDA_PACK_DIR)
      const tools = new InMemoryToolRegistry()
      registerSelfExplorationTools(tools, { store, persona })

      // P1-STATE-01：in_progress 任务每 12 小时 tick 不会续期 lastProgressAt，7 天后淡去；recoverInterrupted 可恢复中断任务
      const dEng = new DesireEngine(store, { ttlDays: 7 })
      const t0 = new Date('2026-11-01T10:00:00+08:00')
      const d = dEng.seed({ source: 'chat', motive: 'curiosity', want: '研究星空', why: '好奇', stage: 'active', now: t0 })!
      d.stage = 'in_progress'
      store.upsertDesire(d)
      for (let h = 12; h <= 24 * 8; h += 12) {
        dEng.tick(new Date(t0.getTime() + h * 3_600_000))
      }
      assert.equal(store.getDesire(d.id)!.stage, 'faded')

      const d2 = dEng.seed({ source: 'chat', motive: 'curiosity', want: '整理草药笔记', why: '想学', stage: 'active', now: t0 })!
      d2.stage = 'in_progress'
      store.upsertDesire(d2)
      const rec = dEng.recoverInterrupted(new Date(t0.getTime() + 3_600_000))
      assert.equal(rec.length, 1)
      assert.equal(store.getDesire(d2.id)!.stage, 'active')

      // P1-STATE-05：autonomy_off 下人工一次性批准解锁，拒绝进入冷静期
      const buildD = dEng.seed({ source: 'chat', motive: 'create', want: '学识花', why: '好玩', exitKind: 'build_skill', stage: 'active', now: t0 })!
      assert.equal(checkBuildScope(buildD, { autonomyEnabled: false, now: t0 }).needsApproval, true)
      buildD.approvedPlanVersion = 1
      assert.equal(checkBuildScope(buildD, { autonomyEnabled: false, now: t0 }).allowed, true)
      buildD.approvedPlanVersion = undefined
      buildD.rejectedUntil = '2026-11-02 10:00:00'
      const rejVerdict = checkBuildScope(buildD, { autonomyEnabled: false, now: t0 })
      assert.equal(rejVerdict.allowed, false)
      assert.equal(rejVerdict.needsApproval, false)

      // P0-RUN-01 + P1-STATE-02 + P1-STATE-03：发送失败不抛出未处理拒绝、不提前 markAsked、不删待回复、歌曲不被 12 条 ready 饿死且投递失败保留重试
      creds.registerNeed({
        name: 'img',
        label: '生图',
        provider: 'p',
        fields: [{ key: 'k', label: 'K', type: 'secret', required: true }],
        now: t0,
      })
      store.addPendingReply({ userId: 'u1', userName: '追夜', threadKey: 'qq:private:u1', text: '在吗', createdAt: '2026-11-01 10:00:00' })

      let failSend = true
      const sentTexts: string[] = []
      const transport: TransportPort = {
        id: 'fake',
        async start() {},
        async dispose() {},
        async send(_t, payload) {
          if (failSend) throw new Error('network down')
          if (payload.text) sentTexts.push(payload.text)
        },
      }
      const chatModel = stubModel(() => ({
        content: '刚忙完回来看到啦',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 10, reasoningTokens: 0, totalTokens: 20 },
        model: 'stub',
      }))
      const soul = new Soul({ botId: 'nahida', persona, store, chatModel, auxModel: chatModel, tools })
      const cfg = ZysoulConfigSchema.parse({
        chatLlm: { baseUrl: 'https://example.com/v1', apiKey: 'k', model: 'm' },
        bots: [{
          id: 'nahida',
          dataDir: dir,
          access: { users: ['u1'], groups: [], admins: ['u1'] },
          proactivity: { enabled: true, allowlist: ['u1'], autonomyBuildEnabled: true },
        }],
      }).bots[0]!

      // 预置 1 条旧 generating 歌曲 + 12 条更新的 ready 作品（验证不被 LIMIT 10 饿死）
      store.upsertWork({
        id: 'w_old_song',
        kind: 'song',
        title: '旧歌',
        content: '歌词',
        mediaPath: null,
        status: 'generating',
        externalTaskId: 'task_old',
        forUser: 'u1',
        moodNote: null,
        createdAt: '2026-11-01 09:00:00',
      })
      for (let i = 0; i < 12; i++) {
        store.upsertWork({
          id: `w_ready_${i}`,
          kind: 'song',
          title: `新歌${i}`,
          content: '',
          mediaPath: null,
          status: 'ready',
          externalTaskId: null,
          forUser: null,
          moodNote: null,
          createdAt: `2026-11-01 10:${String(i).padStart(2, '0')}:00`,
        })
      }
      let pollCalls = 0
      const singing: SingingPort = {
        id: 'fake-mureka',
        async createSong() { return { taskId: 'x' } },
        async pollSong() {
          pollCalls += 1
          return { status: 'succeeded', audioUrl: 'https://cdn.example.com/song.mp3' }
        },
      }
      const rhythm = createRhythm({
        bots: [{
          config: cfg,
          soul,
          diary: new DiaryBook(dir),
          credentials: creds,
          transport,
          singing,
          songsDir: join(dir, 'songs'),
          fetchImpl: (async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })) as unknown as typeof fetch,
          takeRequestedCredential: () => null,
        }],
        queue: new SerialQueue(),
        startupGraceMs: 0,
      })

      // 断网期间 tickOnce 不抛异常，pendingReply 保留，凭证未 markAsked
      await rhythm.tickOnce()
      assert.equal(store.listPendingReplies().length, 1)
      assert.equal(creds.getNeed('img')?.askedAt, undefined)

      // 断网期间 songTick：音频下载保存并置为 ready_undelivered，不丢失也不误置 ready
      await rhythm.songTick()
      assert.equal(pollCalls, 1)
      assert.equal(store.getWork('w_old_song')?.status, 'ready_undelivered')

      // 网络恢复：pendingReply 投递成功并删除；songTick 复发已保存音频并置 ready（不重复 pollSong）
      failSend = false
      await rhythm.tickOnce()
      assert.equal(store.listPendingReplies().length, 0)
      assert.ok(creds.getNeed('img')?.askedAt)

      await rhythm.songTick()
      assert.equal(pollCalls, 1, 'should retry delivery from saved file without re-polling')
      assert.equal(store.getWork('w_old_song')?.status, 'ready')
      assert.ok(sentTexts.length >= 2)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('Suite 8: Frozen toolsHash, loop exhaustion & undeclared tool block, LIKE escape, seed dedup, Admin auth & reasoning_content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zysoul-rt-proto-'))
    const store = new SqliteSoulStore(':memory:')
    try {
      const reg = new InMemoryToolRegistry()
      let secretExecuted = false
      reg.register({
        layer: 'explore',
        spec: { name: 'a_explore', description: 'e', parameters: { type: 'object', properties: {} } },
        async execute() { return { output: 'ok' } },
      })
      reg.register({
        layer: 'express',
        spec: { name: 'b_express', description: 'x', parameters: { type: 'object', properties: {} } },
        async execute() { secretExecuted = true; return { output: 'sent' } },
      })
      reg.register({
        layer: 'create',
        spec: { name: 'c_create', description: 'c', parameters: { type: 'object', properties: {} } },
        async execute() { secretExecuted = true; return { output: 'created' } },
      })

      // 未声明工具与被掩码层工具绝不执行（P2-LOOP-01 & P1-CACHE-01）
      const loopMasked = await runAgentLoop(
        {
          model: stubModel((_req, n) => {
            if (n === 1) {
              return {
                content: '',
                toolCalls: [
                  { id: 'c1', name: 'b_express', arguments: '{}' },
                  { id: 'c2', name: 'c_create', arguments: '{}' },
                ],
                finishReason: 'tool_calls',
                usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 10, reasoningTokens: 0, totalTokens: 20 },
                model: 'stub',
              }
            }
            return {
              content: '收到',
              toolCalls: [],
              finishReason: 'stop',
              usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5, reasoningTokens: 0, totalTokens: 15 },
              model: 'stub',
            }
          }),
          tools: reg,
          store,
        },
        {
          traceId: 't1',
          scene: 'diary',
          staticSystemPrompt: 'sys',
          history: [],
          dynamicFacts: '',
          userText: '写日记',
          isGroup: false,
          toolLayers: ['explore', 'express', 'create'],
          allowedLayers: ['explore'],
          reasoningEffort: 'low',
          maxSteps: 3,
          toolCtx: { botId: 'nahida', threadKey: 'solo:1', userId: 'nahida', userName: '纳西妲', isGroup: false, solo: true, now: new Date() },
        },
      )
      assert.equal(secretExecuted, false)
      assert.equal(loopMasked.stopReason, 'completed')

      // 步数耗尽必须返回 exhausted（P1-LOOP-01）
      const loopExhausted = await runAgentLoop(
        {
          model: stubModel((req) => {
            if (req.toolChoice === 'none') {
              return { content: '', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 5, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 5 }, model: 'stub' }
            }
            return {
              content: '',
              toolCalls: [{ id: 'tc', name: 'a_explore', arguments: '{}' }],
              finishReason: 'tool_calls',
              usage: { inputTokens: 5, cachedTokens: 0, outputTokens: 5, reasoningTokens: 0, totalTokens: 10 },
              model: 'stub',
            }
          }),
          tools: reg,
          store,
        },
        {
          traceId: 't2',
          scene: 'solo',
          staticSystemPrompt: 'sys',
          history: [],
          dynamicFacts: '',
          userText: '干活',
          isGroup: false,
          toolLayers: ['explore', 'express', 'create'],
          reasoningEffort: 'low',
          maxSteps: 2,
          toolCtx: { botId: 'nahida', threadKey: 'solo:1', userId: 'nahida', userName: '纳西妲', isGroup: false, solo: true, now: new Date() },
        },
      )
      assert.equal(loopExhausted.stopReason, 'exhausted')
      assert.equal(loopMasked.toolsHash, loopExhausted.toolsHash)

      // P2-DB-01：LIKE 通配符 %_ 按字面量转义，不误查无关记录
      store.addMemory({ kind: 'fact', text: '今天天气晴朗', about: [], sensitivity: 'open', tier: 'season', disclosable: 'volunteer', consented: false, source: 'private', threadKey: 't', affect: null })
      const wildHits = store.searchMemories('%_', 5)
      assert.equal(wildHits.length, 0)

      // P2-DES-01：note_thought 经 DesireEngine.seed 去重，不会反复插入重复念头
      const selfReg = new InMemoryToolRegistry()
      registerSelfLifeTools(selfReg, { store, diary: new DiaryBook(dir) })
      const ctx = { botId: 'nahida', threadKey: 'qq:private:1', userId: '1', userName: 'u', isGroup: false, solo: false, now: new Date() }
      await selfReg.get('note_thought')!.execute({ want: '我想学画水彩画', why: '好看', exitKind: 'experience' }, ctx)
      await selfReg.get('note_thought')!.execute({ want: '我想学画水彩画呀', why: '真的想学', exitKind: 'experience' }, ctx)
      assert.equal(store.listDesires().length, 1)

      // P2-LLM-01：OpenAI 适配器在工具调用轮保留 reasoning_content
      const seenPayloads: Array<Record<string, unknown>> = []
      const oai = createOpenAIChatModel({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'k',
        model: 'deepseek-reasoner',
        fetchImpl: (async (_u: string | URL | Request, init?: RequestInit) => {
          seenPayloads.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
          return new Response(JSON.stringify({
            model: 'deepseek-reasoner',
            choices: [{
              finish_reason: 'tool_calls',
              message: {
                content: '',
                reasoning_content: 'THOUGHT_CHAIN_123',
                tool_calls: [{ id: 'call_1', function: { name: 'a_explore', arguments: '{}' } }],
              },
            }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        }) as unknown as typeof fetch,
      })
      const first = await oai.complete({ messages: [{ role: 'user', content: 'hi' }] })
      assert.equal(first.reasoningContent, 'THOUGHT_CHAIN_123')
      await oai.complete({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: '', toolCalls: first.toolCalls, reasoningContent: first.reasoningContent },
          { role: 'tool', toolCallId: 'call_1', content: 'ok' },
        ],
      })
      const sentMsgs = seenPayloads[1]!.messages as Array<Record<string, unknown>>
      assert.equal(sentMsgs[1]!.reasoning_content, 'THOUGHT_CHAIN_123')

      // P1-SEC-05 + P2-AUTH-01 + P2-INIT-01：首次随机密码落盘 0600 文件、改密保留 Secure Cookie 且自动清理初始文件、伪造 XFF 不绕过限流
      const adminBundle = createAdminApp({
        bots: [],
        authFilePath: join(dir, 'admin-auth.json'),
        trustProxy: false,
        getBot: () => undefined,
      })
      assert.ok(adminBundle.auth.initialPasswordFilePath)
      const initFileText = readFileSync(adminBundle.auth.initialPasswordFilePath!, 'utf8')
      const initPwd = initFileText.trim().split('\n').pop()!.trim()
      assert.equal(initPwd, adminBundle.auth.generatedPassword)

      // 换 10 次不同伪造 X-Forwarded-For 仍归为同一 direct 桶并触发 429
      for (let i = 0; i < 10; i++) {
        const r = await adminBundle.app.request('https://admin.example.com/api/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${i + 1}` },
          body: JSON.stringify({ password: 'wrong-password' }),
        })
        assert.equal(r.status, 401)
      }
      const blocked = await adminBundle.app.request('https://admin.example.com/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.99' },
        body: JSON.stringify({ password: initPwd }),
      })
      assert.equal(blocked.status, 429)

      // 清理失败记录后登录并改密：改密 Cookie 保留 Secure
      adminBundle.auth.clearLoginFails('direct')
      const okLogin = await adminBundle.app.request('https://admin.example.com/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: initPwd }),
      })
      assert.equal(okLogin.status, 200)
      const loginCookie = okLogin.headers.get('set-cookie') ?? ''
      assert.match(loginCookie, /Secure/)
      const { csrf } = (await okLogin.json()) as { csrf: string }

      const chg = await adminBundle.app.request('https://admin.example.com/api/password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: loginCookie.split(';')[0]!,
          'x-csrf-token': csrf,
        },
        body: JSON.stringify({ currentPassword: initPwd, nextPassword: 'NewStrongPassword123' }),
      })
      assert.equal(chg.status, 200)
      assert.match(chg.headers.get('set-cookie') ?? '', /Secure/)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
