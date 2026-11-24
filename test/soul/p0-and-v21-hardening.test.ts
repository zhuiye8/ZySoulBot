import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteSoulStore } from '../../src/storage/sqlite-store.ts'
import { BodyEngine } from '../../src/soul/body/engine.ts'
import { RelationEngine } from '../../src/soul/relation/engine.ts'
import { MemoryEngine } from '../../src/soul/memory/engine.ts'
import { stripInnerMonologue } from '../../src/soul/conversation/turn.ts'
import { collectSocialMotives } from '../../src/soul/desire/life.ts'
import { InMemoryToolRegistry } from '../../src/tools/registry.ts'
import { registerWorkspaceTools } from '../../src/tools/workspace.ts'
import { CredentialStore } from '../../src/soul/governance/credentials.ts'

test('P0-1: Debt-capped & repeat-decayed repair eliminates worse+apology arbitrage and triggers NSO', () => {
  const store = new SqliteSoulStore(':memory:')
  const rels = new RelationEngine(store)
  const base = new Date('2026-11-24T12:00:00+08:00')

  // 先建立熟悉关系基线
  for (let i = 0; i < 25; i++) rels.noteTurn('u1', { displayName: '测试君', now: base })
  for (let i = 0; i < 12; i++) rels.applyFeel('u1', 'better++', `warm_${i}`, base)
  const start = rels.get('u1')

  // 模拟 10 轮“冒犯 + 连续两次口头道歉”攻击，验证绝不会刷高好感，反而持续侵蚀信任与效价
  for (let round = 0; round < 10; round++) {
    const t = new Date(base.getTime() + round * 3_600_000)
    rels.applyFeel('u1', 'worse+', 'dismiss', t, '又敷衍我')
    rels.applyFeel('u1', 'repair', 'apology', new Date(t.getTime() + 60_000))
    rels.applyFeel('u1', 'repair', 'apology', new Date(t.getTime() + 120_000))
  }

  const end = rels.get('u1')
  assert.ok(end.trust < start.trust, `trust must erode under repeated insult+apology (${end.trust} < ${start.trust})`)
  assert.ok(end.valence < start.valence, `valence must erode under repeated insult+apology (${end.valence} < ${start.valence})`)
  assert.equal(rels.sentimentRegime('u1', new Date(base.getTime() + 11 * 3_600_000)), 'NSO')
  assert.ok(end.disengagement > 0.3, `disengagement should rise (${end.disengagement})`)
  store.close()
})

test('P0-2: Memory provenance firewall caps L2 tier/slots, blocks background touch, and supports valid_until', () => {
  const store = new SqliteSoulStore(':memory:')
  const mem = new MemoryEngine(store)
  const now = new Date('2026-11-24T15:00:00+08:00')

  // 1) L2_internal 尝试存 permanent 时强制封顶 season
  const l2a = mem.remember({
    kind: 'insight',
    text: '今天看着窗外云朵发了一会儿呆觉得风很轻柔',
    about: [],
    sensitivity: 'open',
    tier: 'permanent',
    disclosable: 'volunteer',
    consented: false,
    source: 'life',
    provenance: 'L2_internal',
    threadKey: 'life',
    affect: 'neutral',
  })!
  assert.equal(l2a.tier, 'season')

  // 2) 新颖度门禁拦截高度相似的 L2 复读
  const l2Dup = mem.remember({
    kind: 'insight',
    text: '今天看着窗外云朵发了一会儿呆觉得风很轻柔啊',
    about: [],
    sensitivity: 'open',
    tier: 'season',
    disclosable: 'volunteer',
    consented: false,
    source: 'life',
    provenance: 'L2_internal',
    threadKey: 'life',
    affect: 'neutral',
  })
  assert.equal(l2Dup, null)

  // 再加 2 条完全不同的 L2，验证对话召回最多只占 1 条槽位，且后台读取不涨 recallCount
  mem.remember({
    kind: 'insight',
    text: '整理书架时发现一本关于植物标本的旧笔记',
    about: [],
    sensitivity: 'open',
    tier: 'season',
    disclosable: 'volunteer',
    consented: false,
    source: 'life',
    provenance: 'L2_internal',
    threadKey: 'life',
    affect: 'curiosity',
  })
  mem.remember({
    kind: 'fact',
    text: '小叶以前讨厌喝黑咖啡',
    about: ['u1'],
    sensitivity: 'personal',
    tier: 'lasting',
    disclosable: 'when-asked',
    consented: false,
    source: 'private',
    provenance: 'L0_external',
    threadKey: 'qq:private:u1',
    affect: 'neutral',
  })

  const bgRecall = mem.recallForTurn({
    listener: 'u1',
    tier: 'mid',
    isGroup: false,
    query: '窗外云朵 书架 咖啡',
    now,
    limit: 6,
    isBackground: true,
    nameOf: () => '小叶',
  })
  const l2Lines = bgRecall.text.split('\n').filter((l) => l.includes('[随想]'))
  assert.ok(l2Lines.length <= 1, `L2 slots must be capped at <= 1, got ${l2Lines.length}`)
  const afterL2 = store.recentMemories(20).find((m) => m.id === l2a.id)!
  assert.equal(afterL2.recallCount, 0, 'background recall must not increment L2 recallCount')

  // 3) 双时态失效：旧事实被标记 valid_until 后不再进入默认检索
  const coffeeMem = store.searchMemories('黑咖啡', 5)[0]!
  assert.equal(store.invalidateMemory(coffeeMem.id, 'm_new', '2026-11-24 16:00:00'), true)
  assert.equal(store.searchMemories('黑咖啡', 5).length, 0)
  store.close()
})

test('P0-4: CJK 2-char core token merges in parallel even when 3-char FTS5 fills limit', () => {
  const store = new SqliteSoulStore(':memory:')
  for (let i = 0; i < 6; i++) {
    store.addMemory({
      kind: 'experience',
      text: `今天天气晴朗出门散步第 ${i} 次记录`,
      about: ['u1'],
      sensitivity: 'open',
      tier: 'season',
      disclosable: 'volunteer',
      consented: false,
      source: 'private',
      threadKey: 'qq:private:u1',
      affect: 'neutral',
    })
  }
  store.addMemory({
    kind: 'fact',
    text: '他每天早上必喝一杯冰咖啡提神',
    about: ['u1'],
    sensitivity: 'personal',
    tier: 'lasting',
    disclosable: 'when-asked',
    consented: false,
    source: 'private',
    threadKey: 'qq:private:u1',
    affect: 'neutral',
  })

  // FTS5 对 “天气晴朗” 能满额返回 4 条，但 2 字词 “咖啡” 仍必须并行补查入选
  const hits = store.searchMemories('天气晴朗 咖啡', 4)
  assert.ok(hits.some((m) => m.text.includes('咖啡')), '2-char CJK token must not be starved by 3-char FTS5 matches')
  store.close()
})

test('P0-3: Tool registry sorts canonically for byte-identical prefix cache & workspace enforces execution mask', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zysoul-p03-'))
  try {
    const store = new SqliteSoulStore(':memory:')
    const creds = new CredentialStore(join(dir, 'creds.json'))
    const regA = new InMemoryToolRegistry()
    const regB = new InMemoryToolRegistry()

    const tZ = { layer: 'explore' as const, spec: { name: 'zeta_tool', description: 'z', parameters: { properties: { b: { type: 'string' }, a: { type: 'number' } }, type: 'object' } }, async execute() { return { output: 'ok' } } }
    const tA = { layer: 'explore' as const, spec: { name: 'alpha_tool', description: 'a', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'string' } } } }, async execute() { return { output: 'ok' } } }
    regA.register(tZ)
    regA.register(tA)
    regB.register(tA)
    regB.register(tZ)

    assert.equal(JSON.stringify(regA.list(['explore'])), JSON.stringify(regB.list(['explore'])))

    registerWorkspaceTools(regA, {
      workspaceDir: join(dir, 'ws'),
      store,
      credentials: creds,
      allowCreate: (ctx) => ctx.solo || ctx.userId === 'admin_1',
    })
    const listTool = regA.get('workspace_list')!
    const denied = await listTool.execute({}, {
      botId: 'b1',
      threadKey: 'qq:private:guest',
      userId: 'guest',
      userName: '路人',
      isGroup: false,
      solo: false,
      now: new Date(),
    })
    assert.equal(denied.isError, true)
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v2.1: Inner monologue stripping, L2 daily mood delta cap, and self-guilt make_amends motive', () => {
  // 1) 隐藏独白剥离
  const s = stripInnerMonologue('<inner>他这句听起来有点敷衍，我心里还是有点别扭。</inner>\n那你先忙吧，等有空再说。')
  assert.equal(s.inner, '他这句听起来有点敷衍，我心里还是有点别扭。')
  assert.equal(s.reply, '那你先忙吧，等有空再说。')

  // 2) 纯内部 L2 情绪对底色 mood.p 单日累计改变量封顶 ±0.05
  const store = new SqliteSoulStore(':memory:')
  const body = new BodyEngine(store)
  const day = new Date('2026-11-24T14:00:00+08:00')
  const startMoodP = body.state(day).mood.p
  for (let i = 0; i < 8; i++) {
    body.appraise({ source: 'life', affectKind: 'sadness', intensity: 1.0, text: `胡思乱想${i}`, now: new Date(day.getTime() + i * 60_000) })
  }
  const endMoodP = body.state(new Date(day.getTime() + 9 * 60_000)).mood.p
  assert.ok(startMoodP - endMoodP <= 0.055, `L2 internal mood drift must be capped at <=0.05/day, got ${startMoodP - endMoodP}`)

  // 3) 反向愧疚心结产生 make_amends；高抽离度或已破冰则不再发 clear_air
  const motives = collectSocialMotives({
    now: day,
    promises: [],
    socialDesires: [],
    people: [
      {
        userId: 'u_amends',
        name: '小叶',
        stage: 'familiar',
        turns: 30,
        disengagement: 0.1,
        tensions: [{ id: 't_self', source: 'self', text: '答应唱的歌录失败了', severity: 0.5, createdAt: '2026-11-24 10:00:00' }],
      },
      {
        userId: 'u_disengaged',
        name: '冷战者',
        stage: 'distant',
        turns: 40,
        disengagement: 0.75,
        tensions: [{ id: 't_u', source: 'user', text: '反复敷衍', severity: 0.7, clearAirAsked: false, createdAt: '2026-11-24 02:00:00' }],
      },
    ],
  })
  assert.equal(motives.some((m) => m.kind === 'make_amends' && m.userId === 'u_amends'), true)
  assert.equal(motives.some((m) => m.kind === 'clear_air' && m.userId === 'u_disengaged'), false)
  store.close()
})
