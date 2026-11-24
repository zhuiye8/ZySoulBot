import assert from 'node:assert/strict'
import test from 'node:test'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ZysoulConfigSchema } from '../../src/shared/config.ts'
import type { ChatModel, TtsPort } from '../../src/shared/ports.ts'
import { createApp } from '../../src/app.ts'

const SRC_PERSONA = resolve(process.cwd(), 'personas/nahida')

const fakeModel: ChatModel = {
  id: 'fake',
  model: 'fake',
  async complete() {
    return {
      content: '{"emotions":["humor"],"tags":["笑"],"description":"微笑"}',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 10, reasoningTokens: 0, totalTokens: 20 },
      model: 'fake',
    }
  },
}

test('Hono Admin API: auth + CSRF + overview + FTS5 memories + persona hot-reload + credentials + works + wipe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zysoul-admin-test-'))
  try {
    const botDir = join(dir, 'bots', 'nahida')
    const personaDir = join(dir, 'persona-copy')
    cpSync(SRC_PERSONA, personaDir, { recursive: true })

    const fakeTts: TtsPort = {
      id: 'fake-tts',
      async synth({ text }) { return { bytes: new Uint8Array(Buffer.from(`VOICE:${text}`)), mimeType: 'audio/mpeg' } },
    }

    const cfg = ZysoulConfigSchema.parse({
      chatLlm: { baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'm' },
      admin: { host: '127.0.0.1', port: 18788 },
      bots: [{
        id: 'nahida',
        dataDir: botDir,
        personaDir,
        webSearch: { enabled: false },
      }],
    })

    const app = createApp(cfg, {
      inMemoryDb: true,
      chatModelOverride: fakeModel,
      auxModelOverride: fakeModel,
      ttsOverride: fakeTts,
      adminAuthFilePath: join(dir, 'admin-auth.json'),
      adminInitialPassword: 'test-password-123',
      listenAdmin: false,
    })

    const api = app.admin!.app
    const bot = app.bots[0]!

    // 1) 未登录访问 API 返回 401
    const unauth = await api.request('/api/bots')
    assert.equal(unauth.status, 401)

    // 2) 错误密码返回 401；正确密码登录拿到 cookie + csrf
    const badLogin = await api.request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    })
    assert.equal(badLogin.status, 401)

    const loginRes = await api.request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-password-123' }),
    })
    assert.equal(loginRes.status, 200)
    const setCookie = loginRes.headers.get('set-cookie')!
    const cookieHeader = setCookie.split(';')[0]!
    const { csrf } = await loginRes.json() as { ok: boolean; csrf: string }
    assert.ok(csrf.length > 10)

    const authHeaders = { Cookie: cookieHeader }
    const mutHeaders = { Cookie: cookieHeader, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }

    // 3) 写入测试数据：记忆、凭证、歌单作品
    const mem = bot.store.addMemory({
      kind: 'fact',
      text: '小叶非常喜欢雨天听轻音乐',
      about: ['u1'],
      sensitivity: 'personal',
      tier: 'lasting',
      disclosable: 'when-asked',
      consented: false,
      source: 'private',
      threadKey: 'qq:private:u1',
      affect: 'affection',
    })
    bot.credentials.registerNeed({
      name: 'weather_api',
      label: '天气接口',
      provider: 'qweather',
      fields: [{ key: 'API_KEY', label: '密钥', type: 'secret', required: true }],
      why: '查晴雨',
    })
    const songFile = join(dir, 'song1.mp3')
    writeFileSync(songFile, new Uint8Array(Buffer.from('MP3-DATA')))
    bot.store.upsertWork({
      id: 'song_1',
      kind: 'song',
      title: '雨声小调',
      content: '滴滴答答落在叶尖',
      mediaPath: songFile,
      status: 'ready',
      externalTaskId: 'ext_1',
      forUser: 'u1',
      moodNote: '下雨天想唱的',
      createdAt: '2026-11-24 12:00:00',
    })

    // 4) Overview & FTS5 记忆搜索 & 删除
    const ovRes = await api.request('/api/bots/nahida/overview', { headers: authHeaders })
    assert.equal(ovRes.status, 200)
    const ov = await ovRes.json() as { bot: { name: string }; kpis: { missingCredentials: number } }
    assert.equal(ov.bot.name, '纳西妲')
    assert.equal(ov.kpis.missingCredentials, 1)

    const memSearch = await api.request('/api/bots/nahida/memories?q=%E8%BD%BB%E9%9F%B3%E4%B9%90', { headers: authHeaders })
    assert.equal(memSearch.status, 200)
    const memData = await memSearch.json() as { items: Array<{ id: string; clarity: number }> }
    assert.equal(memData.items[0]?.id, mem.id)
    assert.ok(memData.items[0]!.clarity > 0.5)

    // 关系接口 sharedStories 必须是轻量结构 {id,text,createdAt} 而非原始大对象
    bot.soul.relations.noteTurn('u1', { displayName: '小叶', now: new Date('2026-11-24T12:00:00+08:00') })
    const relRes = await api.request('/api/bots/nahida/relations', { headers: authHeaders })
    assert.equal(relRes.status, 200)
    const relJson = await relRes.json() as { relations: Array<{ userId: string; sharedStories: Array<{ id: string; text: string }> }> }
    assert.equal(relJson.relations[0]?.userId, 'u1')
    assert.equal(typeof relJson.relations[0]?.sharedStories[0]?.text, 'string')

    // 缺 CSRF 时 DELETE 拒绝 403
    const noCsrf = await api.request(`/api/bots/nahida/memories/${mem.id}`, { method: 'DELETE', headers: authHeaders })
    assert.equal(noCsrf.status, 403)

    const delOk = await api.request(`/api/bots/nahida/memories/${mem.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrf },
    })
    assert.equal(delOk.status, 200)

    // 5) 人设编辑与热重载
    const savePersona = await api.request('/api/bots/nahida/persona', {
      method: 'PUT',
      headers: mutHeaders,
      body: JSON.stringify({ file: 'scenario.md', content: '此刻窗外正下着细雨。' }),
    })
    assert.equal(savePersona.status, 200)
    assert.match(bot.soul.persona.scenario, /细雨/)

    // 6) 凭证填写（返回遮罩，不泄露明文）
    const fillCred = await api.request('/api/bots/nahida/credentials/weather_api', {
      method: 'PUT',
      headers: mutHeaders,
      body: JSON.stringify({ values: { API_KEY: 'super-secret-value' } }),
    })
    assert.equal(fillCred.status, 200)
    const credListRes = await api.request('/api/bots/nahida/credentials', { headers: authHeaders })
    const credText = await credListRes.text()
    assert.ok(!credText.includes('super-secret-value'), 'secret must never appear in API response')

    // 7) 作品音频流 + TTS 试听
    const audioRes = await api.request('/api/bots/nahida/works/song_1/audio', { headers: authHeaders })
    assert.equal(audioRes.status, 200)
    assert.equal(await audioRes.text(), 'MP3-DATA')

    const ttsRes = await api.request('/api/bots/nahida/tts/preview', {
      method: 'POST',
      headers: mutHeaders,
      body: JSON.stringify({ text: '试听一句' }),
    })
    assert.equal(ttsRes.status, 200)
    assert.equal(await ttsRes.text(), 'VOICE:试听一句')

    // 8) 安全清空（确认名不匹配 400，匹配则清空运行态并保留人设）
    const badWipe = await api.request('/api/bots/nahida/wipe', {
      method: 'POST',
      headers: mutHeaders,
      body: JSON.stringify({ confirm: 'wrong-id' }),
    })
    assert.equal(badWipe.status, 400)

    const goodWipe = await api.request('/api/bots/nahida/wipe', {
      method: 'POST',
      headers: mutHeaders,
      body: JSON.stringify({ confirm: 'nahida' }),
    })
    assert.equal(goodWipe.status, 200)
    assert.equal(bot.store.listWorks().length, 0)
    assert.equal(bot.soul.persona.name, '纳西妲')

    await app.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
