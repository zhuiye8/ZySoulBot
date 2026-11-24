import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SqliteSoulStore } from '../../src/storage/sqlite-store.ts'
import { BodyEngine } from '../../src/soul/body/engine.ts'
import { RelationEngine } from '../../src/soul/relation/engine.ts'

describe('BodyEngine (circadian rhythm, activity feedback, persistent causes)', () => {
  it('applies bidirectional activity effects and persists emotion causes', () => {
    const store = new SqliteSoulStore(':memory:')
    try {
      const t0 = new Date('2026-11-24T14:00:00+08:00')
      const body = new BodyEngine(store)
      body.spendEnergy(0.35, t0)
      const tiredEnergy = body.state(t0).energy

      // 小憩活动：真实恢复精力
      body.startActivity(
        {
          id: 'nap',
          label: '靠在窗边打个小盹',
          place: '净善宫',
          times: ['afternoon'],
          durationMin: [30, 45],
          yields: 'none',
          effects: { energy: 0.25, pad: { p: 0.06, a: -0.05 } },
        },
        '雨声很轻',
        30,
        t0,
      )

      const t1 = new Date('2026-11-24T14:35:00+08:00')
      const finished = body.completeActivityIfDue(t1)
      assert.ok(finished)
      assert.ok(body.state(t1).energy > tiredEnergy + 0.15)
      assert.equal(body.state(t1).activity, null)

      // 情绪来由持久化在 soul.db 里，重建 BodyEngine 也不会丢
      const bodyReloaded = new BodyEngine(store)
      const facts = bodyReloaded.renderBodyFacts(t1)
      assert.match(facts, /打个小盹/)
    } finally {
      store.close()
    }
  })

  it('accumulates sleep debt late at night and recovers after uninterrupted night rest', () => {
    const store = new SqliteSoulStore(':memory:')
    try {
      const body = new BodyEngine(store)
      const late = new Date('2026-11-24T01:30:00+08:00')
      body.state(late)
      body.spendEnergy(0.2, late)
      const debtAfterChat = body.state(late).sleepDebt
      assert.ok(debtAfterChat > 0.15)

      // 连续 4 小时无打扰深夜休息 → 精力恢复、睡眠债下降
      const dawn = new Date('2026-11-24T05:30:00+08:00')
      const afterSleep = body.tick(dawn)
      assert.ok(afterSleep.sleepDebt < debtAfterChat)
    } finally {
      store.close()
    }
  })
})

describe('RelationEngine (bidirectional stage, streak accuracy, shared stories)', () => {
  it('supports both rising and falling stages and renders shared stories as facts', () => {
    const store = new SqliteSoulStore(':memory:')
    try {
      const rels = new RelationEngine(store, { identityCall: '旅行者' })
      const t0 = new Date('2026-11-20T12:00:00+08:00')

      // 提升至 familiar
      for (let i = 0; i < 22; i++) {
        rels.noteTurn('u1', { displayName: '追夜', now: t0 })
      }
      for (let i = 0; i < 12; i++) {
        const d = new Date(t0.getTime() + i * 4 * 86_400_000) // 超过 3 天 grace，每次 streak 重置为 1
        rels.applyFeel('u1', 'better++', 'connected', d)
      }
      const warm = rels.get('u1')
      assert.equal(warm.stage, 'familiar')
      // 验证首次信号 streak count 为 1（修复了旧版 (x||1)+1 变成 2 的 bug）
      assert.equal(warm.streaks.connected?.count, 1)

      // 连续强烈负面信号 → 必须能从 familiar 降级到 distant/hostile
      for (let i = 0; i < 12; i++) {
        const d = new Date(t0.getTime() + (60 + i * 4) * 86_400_000)
        rels.applyFeel('u1', 'worse++', 'crossed_line', d)
      }
      const cold = rels.get('u1')
      assert.ok(cold.stage === 'distant' || cold.stage === 'hostile', `expected drop, got ${cold.stage}`)

      // 故事化渲染：包含共同经历 + 称呼 + 时间跨度
      const story = store.addMemory({
        kind: 'experience',
        text: '追夜答应带我去沙漠看星星',
        about: ['u1'],
        sensitivity: 'personal',
        tier: 'lasting',
        disclosable: 'volunteer',
        consented: false,
        source: 'private',
        threadKey: 'qq:private:u1',
        affect: 'affection',
      })
      const facts = rels.renderRelationFacts({
        userId: 'u1',
        now: new Date('2026-11-24T12:00:00+08:00'),
        sharedStories: [story],
        lastContactIso: '2026-11-22 12:00:00',
      })
      assert.match(facts, /追夜/)
      assert.match(facts, /带我去沙漠看星星/)
      assert.match(facts, /2 天前/)
    } finally {
      store.close()
    }
  })
})
