import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SqliteSoulStore } from '../../src/storage/sqlite-store.ts'
import { loadPersonaPack } from '../../src/storage/persona-loader.ts'
import { BodyEngine } from '../../src/soul/body/engine.ts'
import { checkBuildScope, DesireEngine } from '../../src/soul/desire/engine.ts'
import { lifeRoll } from '../../src/soul/desire/life.ts'
import { CredentialStore } from '../../src/storage/credentials-store.ts'
import { ApprovalManager, isApprovalGranted } from '../../src/soul/governance/approval.ts'
import { checkAutonomousBudget, inQuietHours } from '../../src/soul/governance/budget.ts'
import type { ChatModel, ChatResponse } from '../../src/shared/ports.ts'

function stubModel(reply: string): ChatModel {
  return {
    id: 'stub',
    model: 'stub',
    async complete(): Promise<ChatResponse> {
      return {
        content: reply,
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 120, cachedTokens: 0, outputTokens: 50, reasoningTokens: 10, totalTokens: 170 },
        model: 'stub',
      }
    },
  }
}

describe('DesireEngine (dedup, bidirectional tick, scope routing, shaping, mind wandering)', () => {
  it('merges duplicate wants, grows active desires, decays waiting ones, and fades stale ones', () => {
    const store = new SqliteSoulStore(':memory:')
    try {
      const engine = new DesireEngine(store, { maxActive: 5, ttlDays: 7 })
      const t0 = new Date('2026-11-20T12:00:00+08:00')

      const d1 = engine.seed({ source: 'chat', motive: 'curiosity', want: '我想学会认出常见的植物', why: '在市集看到了没见过的花', stage: 'active', strength: 0.4, now: t0 })!
      const d1Dup = engine.seed({ source: 'chat', motive: 'curiosity', want: '我想认出常见的植物呀', why: '又看到一株', stage: 'active', strength: 0.45, now: t0 })!
      assert.equal(d1Dup.id, d1.id)
      assert.equal(d1Dup.thoughtCount, 2)

      // 放着 2 天没做 → 越压越重（双向验证：能涨）
      const t2 = new Date('2026-11-22T12:00:00+08:00')
      engine.tick(t2)
      const grown = store.getDesire(d1.id)!
      assert.ok(grown.strength > d1Dup.strength)

      // 转成 waiting_approval 后过 2 天 → 缓慢回落（双向验证：能降）
      grown.stage = 'waiting_approval'
      store.upsertDesire(grown)
      const t4 = new Date('2026-11-24T12:00:00+08:00')
      engine.tick(t4)
      const cooled = store.getDesire(d1.id)!
      assert.ok(cooled.strength < grown.strength)

      // 超过 TTL 7 天 → 淡去 faded
      const t15 = new Date('2026-12-04T12:00:00+08:00')
      engine.tick(t15)
      assert.equal(store.getDesire(d1.id)!.stage, 'faded')
    } finally {
      store.close()
    }
  })

  it('routes credentials cleanly (not hard-blocked), hard-blocks destructive ops, and gates autonomy_off', () => {
    const base = {
      id: 'd1', source: 'chat' as const, motive: 'create', exitKind: 'build_skill' as const, stage: 'active' as const,
      spec: null, blocker: null, strength: 0.7, thoughtCount: 1, progressNote: null, aboutUser: null, parentId: null,
      createdAt: '2026-11-24 10:00:00', updatedAt: '2026-11-24 10:00:00',
    }

    const credVerdict = checkBuildScope({ ...base, want: '我想接通生图服务画画', why: '需要外部 API 密钥' })
    assert.equal(credVerdict.allowed, true)
    assert.equal(credVerdict.requiresCredential, true)
    assert.equal(credVerdict.hardBlocked, false)

    const dangerVerdict = checkBuildScope({ ...base, want: '帮我清理磁盘', why: '执行 rm -rf /tmp' })
    assert.equal(dangerVerdict.allowed, false)
    assert.equal(dangerVerdict.hardBlocked, true)

    const offVerdict = checkBuildScope({ ...base, want: '我想学认植物', why: '好奇' }, { autonomyEnabled: false })
    assert.equal(offVerdict.allowed, false)
    assert.equal(offVerdict.needsApproval, true)
    assert.equal(offVerdict.reason, 'autonomy_off')
  })

  it('shapes seeds in one pass and sparks unprompted thoughts via mindWander', async () => {
    const store = new SqliteSoulStore(':memory:')
    const persona = loadPersonaPack(fileURLToPath(new URL('../../personas/nahida', import.meta.url)))
    const body = new BodyEngine(store)
    const desires = new DesireEngine(store)
    try {
      const seed = desires.seed({ source: 'chat', motive: 'create', want: '我想把看到的夕阳画下来', why: '今天傍晚云很好看' })!
      const shapeModel = stubModel(JSON.stringify({
        items: [{
          id: seed.id,
          exitKind: 'build_skill',
          skillAction: 'create',
          skillName: 'draw-sunset',
          spec: '输入画面描述，调用生图 API 输出图片',
          needsCredential: true,
          blocker: null,
        }],
      }))
      const count = await desires.shapeSeeds({ model: shapeModel, readyCredentials: [] }, { traceId: 't_shape' })
      assert.equal(count, 1)
      const shaped = store.getDesire(seed.id)!
      assert.equal(shaped.stage, 'active')
      assert.equal(shaped.exitKind, 'build_skill')
      assert.equal((shaped.spec as { needsCredential?: boolean })?.needsCredential, true)

      // 空闲自发联想：从记忆池里浮出旧记忆并长出新念头
      store.addMemory({
        kind: 'experience',
        text: '追夜说过海边灯塔晚上会有海风声',
        about: ['1563359387'],
        sensitivity: 'personal',
        tier: 'lasting',
        disclosable: 'volunteer',
        consented: false,
        source: 'private',
        threadKey: 'qq:private:1563359387',
        affect: 'affection',
      })
      const wanderModel = stubModel(JSON.stringify({
        kind: 'thought',
        want: '我想问问追夜这周末去没去看海',
        why: '忽然想起他说过灯塔和海风声',
        exitKind: 'social',
        aboutUser: '1563359387',
      }))
      const w = await desires.mindWander({ model: wanderModel, persona, body, random: () => 0 }, { traceId: 't_w' })
      assert.equal(w.kind, 'thought')
      assert.ok(desires.active().some((d) => d.source === 'wander' && d.exitKind === 'social'))
    } finally {
      store.close()
    }
  })

  it('lowers lifeRoll probability significantly when energy is exhausted', () => {
    const store = new SqliteSoulStore(':memory:')
    try {
      const body = new BodyEngine(store)
      const now = new Date('2026-11-24T15:00:00+08:00')
      const fresh = body.state(now)
      const rollFresh = lifeRoll({ state: fresh, motives: [], actionableDesireCount: 1, now, random: () => 0.99 })

      const tired = { ...fresh, energy: 0.12, sleepDebt: 0.85 }
      const rollTired = lifeRoll({ state: tired, motives: [], actionableDesireCount: 1, now, random: () => 0.99 })
      assert.ok(rollTired.p < rollFresh.p * 0.4, `tired p=${rollTired.p} should be far below fresh p=${rollFresh.p}`)
    } finally {
      store.close()
    }
  })
})

describe('Governance (CredentialStore, ApprovalManager, AutonomousBudget)', () => {
  it('manages credential lifecycle and invalidates filled secret when provider changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zysoul-cred-'))
    try {
      const creds = new CredentialStore(join(dir, 'credentials.json'))
      creds.registerNeed({
        name: 'image-gen',
        label: '生图服务',
        provider: 'aliyun-wanx',
        fields: [{ key: 'apiKey', label: 'API Key', type: 'secret', required: true }],
      })
      assert.equal(creds.isReady('image-gen'), false)
      assert.equal(creds.fill('image-gen', {}), false) // 必填缺失拒绝
      assert.equal(creds.fill('image-gen', { apiKey: 'sk-abc' }), true)
      assert.equal(creds.isReady('image-gen'), true)

      // 更换供应商 → 自动作废旧密钥
      const { providerChanged } = creds.registerNeed({
        name: 'image-gen',
        label: '生图服务',
        provider: 'openai-image',
        fields: [{ key: 'apiKey', label: 'API Key', type: 'secret', required: true }],
      })
      assert.equal(providerChanged, true)
      assert.equal(creds.isReady('image-gen'), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('enforces single pending approval, fail-closed judging, quiet hours, and autonomous budget', async () => {
    const store = new SqliteSoulStore(':memory:')
    try {
      const approvals = new ApprovalManager(store)
      const now = new Date('2026-11-24T14:00:00+08:00')
      const a1 = approvals.open({ kind: 'approval', targetId: 'd1', what: '允许我自主造技能', now })
      assert.ok(a1)
      // 一次只允许悬一条，第二条拒绝并发
      const a2 = approvals.open({ kind: 'approval', targetId: 'd2', what: '另一条', now })
      assert.equal(a2, null)

      // 追问/低置信一律判不执行
      const q = await approvals.judgeReply(
        { model: stubModel('{"verdict":"neither","confidence":0.92}') },
        { traceId: 't1', what: a1.what, reply: '你打算先做什么？' },
      )
      assert.equal(isApprovalGranted(q), false)

      const ok = await approvals.judgeReply(
        { model: stubModel('{"verdict":"approve","confidence":0.95}') },
        { traceId: 't2', what: a1.what, reply: '可以，你去试试吧' },
      )
      assert.equal(isApprovalGranted(ok), true)

      // 安静时段（跨零点）
      assert.equal(inQuietHours(new Date('2026-11-24T02:00:00+08:00'), ['23:30', '08:00']), true)
      assert.equal(inQuietHours(new Date('2026-11-24T14:00:00+08:00'), ['23:30', '08:00']), false)

      // 自主预算只算自主场景，不算普通 chat
      store.recordTokens({ scene: 'chat', model: 'm', inputTokens: 50_000, cachedTokens: 0, outputTokens: 5000, reasoningTokens: 0, estCostCny: 0.1, createdAt: now.toISOString() })
      assert.equal(checkAutonomousBudget(store, 10_000, now).allowed, true)
      store.recordTokens({ scene: 'solo', model: 'm', inputTokens: 12_000, cachedTokens: 0, outputTokens: 2000, reasoningTokens: 0, estCostCny: 0.02, createdAt: now.toISOString() })
      assert.equal(checkAutonomousBudget(store, 10_000, now).allowed, false)
    } finally {
      store.close()
    }
  })
})
