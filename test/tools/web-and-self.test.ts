import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteSoulStore } from '../../src/storage/sqlite-store.ts'
import { DiaryBook } from '../../src/storage/diary.ts'
import { InMemoryToolRegistry } from '../../src/tools/registry.ts'
import { isSafePublicUrl, registerWebTools, stripHtmlToText } from '../../src/tools/web.ts'
import { registerSelfLifeTools } from '../../src/tools/self.ts'

describe('Web tools (SSRF guard, MCP search, web_fetch)', () => {
  it('blocks private/loopback/metadata URLs and allows public HTTPS URLs', () => {
    assert.equal(isSafePublicUrl('http://127.0.0.1:8787/api'), false)
    assert.equal(isSafePublicUrl('http://localhost:3003'), false)
    assert.equal(isSafePublicUrl('http://192.168.1.5/admin'), false)
    assert.equal(isSafePublicUrl('http://169.254.169.254/latest/meta-data'), false)
    assert.equal(isSafePublicUrl('file:///etc/passwd'), false)
    assert.equal(isSafePublicUrl('https://example.com/article'), true)
  })

  it('strips HTML cleanly and runs MCP web_search + web_fetch with foldSummary', async () => {
    assert.equal(stripHtmlToText('<html><script>bad()</script><body><h1>标题</h1><p>内容 &amp; 细节</p></body></html>'), '标题 内容 & 细节')

    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input)
      if (url.includes('/mcp')) {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: '北京今日晴，气温 12℃' }] },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('<html><body><p>公开网页正文内容</p></body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    const reg = new InMemoryToolRegistry()
    registerWebTools(reg, {
      mcp: { url: 'https://dashscope.example.com/mcp', apiKey: 'test-key' },
      fetchImpl: fakeFetch,
    })

    const ctx = { botId: 'nahida', threadKey: 'qq:private:1', userId: '1', userName: '追夜', isGroup: false, solo: false, now: new Date() }
    const sRes = await reg.get('web_search')!.execute({ query: '北京天气' }, ctx)
    assert.match(sRes.output, /12℃/)
    assert.match(sRes.foldSummary ?? '', /搜了「北京天气」/)

    const fRes = await reg.get('web_fetch')!.execute({ url: 'https://example.com/post' }, ctx)
    assert.equal(fRes.output, '公开网页正文内容')

    const blocked = await reg.get('web_fetch')!.execute({ url: 'http://127.0.0.1:8788' }, ctx)
    assert.equal(blocked.isError, true)
  })
})

describe('Self-life tools (diary, reminder, note_thought)', () => {
  it('writes/reads diary and persists reminders & desires to soul.db', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zysoul-self-'))
    const store = new SqliteSoulStore(':memory:')
    const diary = new DiaryBook(dir)
    try {
      const reg = new InMemoryToolRegistry()
      registerSelfLifeTools(reg, { store, diary })
      const now = new Date('2026-11-24T22:00:00+08:00')
      const ctx = { botId: 'nahida', threadKey: 'qq:private:1', userId: '1', userName: '追夜', isGroup: false, solo: true, now }

      await reg.get('write_diary')!.execute({ content: '今天看到了一株发光的蘑菇，想画下来。' }, ctx)
      const readRes = await reg.get('read_diary')!.execute({ date: '2026-11-24' }, ctx)
      assert.match(readRes.output, /发光的蘑菇/)

      await reg.get('set_reminder')!.execute({ text: '明早喊他起床', dueAtIso: '2026-11-25T07:00:00+08:00' }, ctx)
      const due = store.dueSchedules('2026-11-25T07:05:00+08:00', 'reminder')
      assert.equal(due.length, 1)
      assert.equal(due[0]!.text, '明早喊他起床')

      await reg.get('note_thought')!.execute({ want: '我想给这朵蘑菇写一首小歌', why: '刚才看它发着光很有意思', exitKind: 'create_work' }, ctx)
      const desires = store.listDesires(['active'])
      assert.equal(desires.length, 1)
      assert.equal(desires[0]!.exitKind, 'create_work')
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
