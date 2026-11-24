import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SqliteSoulStore } from '../../src/storage/sqlite-store.ts'

describe('SqliteSoulStore (soul.db + FTS5)', () => {
  it('supports FTS5 Chinese search, short-token fallback, recall touch, and atomic wipe', () => {
    const store = new SqliteSoulStore(':memory:')
    try {
      const m1 = store.addMemory({
        kind: 'fact',
        text: '追夜答应周末带我去看须弥的沙漠和植物园',
        about: ['1563359387'],
        sensitivity: 'personal',
        tier: 'lasting',
        disclosable: 'volunteer',
        consented: false,
        source: 'private',
        threadKey: 'qq:private:1563359387',
        affect: 'affection',
      })
      store.addMemory({
        kind: 'experience',
        text: '群里大家都在聊午饭吃什么拉面',
        about: ['999'],
        sensitivity: 'open',
        tier: 'fleeting',
        disclosable: 'when-asked',
        consented: false,
        source: 'group',
        threadKey: 'qq:group:100',
        affect: 'neutral',
      })

      // 3 字以上命中 FTS5 trigram
      const hitLong = store.searchMemories('植物园', 5)
      assert.equal(hitLong.length, 1)
      assert.equal(hitLong[0]!.id, m1.id)

      // 2 字短词走 LIKE 补全
      const hitShort = store.searchMemories('沙漠', 5)
      assert.equal(hitShort.length, 1)
      assert.equal(hitShort[0]!.id, m1.id)

      // 复习触碰更新 recallCount
      store.touchMemories([m1.id], '2026-11-24 10:00:00')
      const updated = store.memoriesAbout('1563359387', 5)
      assert.equal(updated[0]!.recallCount, 1)
      assert.equal(updated[0]!.lastRecalledAt, '2026-11-24 10:00:00')

      // Token 账本统计
      store.recordTokens({
        scene: 'chat',
        model: 'deepseek-v4.1-flash',
        inputTokens: 3300,
        cachedTokens: 3000,
        outputTokens: 60,
        reasoningTokens: 15,
        estCostCny: 0.001,
      })
      const stats = store.tokenStatsSince('2000-01-01T00:00:00.000Z')
      assert.equal(stats.totalInput, 3300)
      assert.equal(stats.totalCached, 3000)
      assert.equal(stats.byScene.chat?.calls, 1)

      // 一键原子清空：全部表归零
      store.wipeRuntimeData()
      assert.equal(store.recentMemories(10).length, 0)
      assert.equal(store.tokenStatsSince('2000-01-01T00:00:00.000Z').totalInput, 0)
    } finally {
      store.close()
    }
  })

  it('compacts oldest messages in blocks while preserving chronological order', () => {
    const store = new SqliteSoulStore(':memory:')
    try {
      for (let i = 1; i <= 12; i++) {
        store.appendMessage({
          threadKey: 'qq:private:1',
          role: i % 2 === 1 ? 'user' : 'assistant',
          userId: i % 2 === 1 ? '1' : 'nahida',
          userName: i % 2 === 1 ? '追夜' : '纳西妲',
          content: `msg-${i}`,
          toolSummary: null,
          mediaJson: null,
        })
      }
      assert.equal(store.countMessages('qq:private:1'), 12)
      store.compactOldMessages('qq:private:1', 5, '前面聊了 msg-1 到 msg-5')
      const kept = store.recentMessages('qq:private:1', 20)
      // 12 - 5 + 1 summary = 8
      assert.equal(kept.length, 8)
      assert.equal(kept[0]!.role, 'summary')
      assert.equal(kept[1]!.content, 'msg-6')
      assert.equal(kept[kept.length - 1]!.content, 'msg-12')
    } finally {
      store.close()
    }
  })
})
