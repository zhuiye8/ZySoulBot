import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import { ZysoulConfigSchema } from '../../src/shared/config.ts'
import type { ChatModel, LightAction, SendPayload, SendTarget, SingingPort, TransportPort, TtsPort } from '../../src/shared/ports.ts'
import { SqliteSoulStore } from '../../src/storage/sqlite-store.ts'
import { RelationEngine } from '../../src/soul/relation/engine.ts'
import { StickerLibrary } from '../../src/soul/expression/stickers.ts'
import { InMemoryToolRegistry } from '../../src/tools/registry.ts'
import { registerExpressionTools } from '../../src/tools/express.ts'
import { createApp } from '../../src/app.ts'
import type { WsLike } from '../../src/transport/onebot11/adapter.ts'

const PERSONA_DIR = resolve(process.cwd(), 'personas/nahida')

class FakeWs extends EventEmitter implements WsLike {
  readyState = 1
  sent: Array<Record<string, unknown>> = []
  send(data: string): void {
    const parsed = JSON.parse(data) as Record<string, unknown> & { echo?: string }
    this.sent.push(parsed)
    if (parsed.echo) {
      queueMicrotask(() => {
        this.emit('message', JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: parsed.echo }))
      })
    }
  }
  close(): void {
    this.readyState = 3
    this.emit('close')
  }
}

test('Expression tools register honestly and enforce cooldown / stranger negative masking', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zysoul-exp-'))
  try {
    const store = new SqliteSoulStore(':memory:')
    const relations = new RelationEngine(store)

    // 未配置 tts / singing / stickers 时不暴露这些工具
    const bareReg = new InMemoryToolRegistry()
    registerExpressionTools(bareReg, { store, relations, getTransport: () => null })
    const bareNames = bareReg.list(['express']).map((t) => t.name)
    assert.ok(!bareNames.includes('send_voice'))
    assert.ok(!bareNames.includes('sing_song'))
    assert.ok(!bareNames.includes('send_sticker'))

    // 配置全套表达能力
    mkdirSync(join(dir, 'stickers'), { recursive: true })
    const stickers = new StickerLibrary(join(dir, 'stickers'), { cooldownTurns: 2, cooldownMs: 1000 })
    writeFileSync(join(dir, 'stickers', 'happy.png'), new Uint8Array([1, 2, 3]))
    writeFileSync(join(dir, 'stickers', 'sad.png'), new Uint8Array([4, 5, 6]))
    stickers.upsert({ key: 'happy', file: 'happy.png', emotions: ['praised', 'humor'], description: '开心笑' })
    stickers.upsert({ key: 'sad', file: 'sad.png', emotions: ['sadness'], description: '委屈' })

    const sent: Array<{ target: SendTarget; payload: SendPayload }> = []
    const acts: LightAction[] = []
    const transport: TransportPort = {
      id: 'fake',
      async start() { /* noop */ },
      async send(target, payload) { sent.push({ target, payload }) },
      async act(action) { acts.push(action) },
      async dispose() { /* noop */ },
    }
    const tts: TtsPort = {
      id: 'fake-tts',
      async synth({ text }) { return { bytes: new Uint8Array(Buffer.from(`AUDIO:${text}`)), mimeType: 'audio/mpeg' } },
    }

    const reg = new InMemoryToolRegistry()
    registerExpressionTools(reg, {
      store,
      relations,
      getTransport: () => transport,
      tts,
      stickers,
      voiceCooldownMs: 30_000,
    })

    const ctx = {
      botId: 'nahida',
      threadKey: 'qq:private:u1',
      userId: 'u1',
      userName: '小叶',
      messageId: 'msg_99',
      isGroup: false,
      solo: false,
      now: new Date('2026-11-24T10:00:00+08:00'),
    }

    // 1) send_voice 剥离括号动作并遵守冷却
    const voiceTool = reg.get('send_voice')!
    const v1 = await voiceTool.execute({ text: '（轻声笑）早安呀。' }, ctx)
    assert.ok(!v1.isError)
    assert.equal(sent[0]?.payload.type, 'record')
    assert.ok(sent[0]?.payload.url?.startsWith('base64://'))
    const decoded = Buffer.from(sent[0]!.payload.url!.slice('base64://'.length), 'base64').toString('utf8')
    assert.equal(decoded, 'AUDIO:早安呀。')

    const v2 = await voiceTool.execute({ text: '再说一句' }, ctx)
    assert.match(v2.output, /刚刚才发过语音/)

    // 2) send_sticker：陌生人默认 closeness=0.25 屏蔽 sadness，但允许 humor
    const stickerTool = reg.get('send_sticker')!
    const sNeg = await stickerTool.execute({ emotion: 'sadness' }, ctx)
    assert.match(sNeg.output, /没有适合/)
    const sPos = await stickerTool.execute({ emotion: 'humor' }, ctx)
    assert.ok(!sPos.isError)
    assert.equal(sent.filter((x) => x.payload.type === 'image').length, 1)
    assert.equal(stickers.get('happy')?.uses, 1)

    // 3) react_message
    const reactTool = reg.get('react_message')!
    const r1 = await reactTool.execute({ emoji_id: '76' }, ctx)
    assert.ok(!r1.isError)
    assert.equal(acts[0]?.kind, 'react')
    assert.equal(acts[0]?.messageId, 'msg_99')

    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Async singing E2E: sing_song submits immediately -> rhythm.songTick downloads & delivers record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zysoul-sing-e2e-'))
  try {
    let wsInstance: FakeWs | null = null
    let chatTurn = 0
    const fakeChat: ChatModel = {
      id: 'fake-chat',
      model: 'fake',
      async complete(req) {
        chatTurn++
        if (chatTurn === 1) {
          // 第 1 步模型决定调用 sing_song
          assert.ok(req.tools?.some((t) => t.name === 'sing_song'))
          return {
            content: '',
            toolCalls: [{
              id: 'call_sing_1',
              name: 'sing_song',
              arguments: JSON.stringify({
                title: '净善宫的晚风',
                lyrics: '[Verse]\n微风吹过绿叶与露水\n[Chorus]\n愿你今晚有个甜甜的梦',
                style: 'gentle acoustic folk, kalimba, soft female vocal',
              }),
            }],
            finishReason: 'tool_calls',
            usage: { inputTokens: 120, cachedTokens: 60, outputTokens: 40, reasoningTokens: 0, totalTokens: 160 },
            model: 'fake',
          }
        }
        return {
          content: '我先轻轻试着哼一段，等我一小会儿录好就发给你听。',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 180, cachedTokens: 120, outputTokens: 20, reasoningTokens: 0, totalTokens: 200 },
          model: 'fake',
        }
      },
    }

    const fakeAux: ChatModel = {
      id: 'fake-aux',
      model: 'fake',
      async complete(req) {
        const sys = req.messages[0]?.content ?? ''
        if (sys.includes('记下')) {
          return {
            content: '{"facts":[],"affect":{"kind":"praised","intensity":0.5},"happened":"给他唱了首歌","relationFeel":"better+","signalKind":"chat","desireHint":""}',
            toolCalls: [],
            finishReason: 'stop',
            usage: { inputTokens: 50, cachedTokens: 0, outputTokens: 20, reasoningTokens: 0, totalTokens: 70 },
            model: 'fake',
          }
        }
        return {
          content: '《净善宫的晚风》录好啦，你听听看喜不喜欢？',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 50, cachedTokens: 0, outputTokens: 15, reasoningTokens: 0, totalTokens: 65 },
          model: 'fake',
        }
      },
    }

    let pollCount = 0
    const fakeSinging: SingingPort = {
      id: 'fake-mureka',
      async createSong() {
        return { taskId: 'mk_e2e_42' }
      },
      async pollSong(taskId) {
        assert.equal(taskId, 'mk_e2e_42')
        pollCount++
        if (pollCount === 1) return { status: 'processing' }
        return { status: 'succeeded', audioUrl: 'https://cdn.mureka.test/e2e.mp3', durationSec: 42 }
      },
    }

    const cfg = ZysoulConfigSchema.parse({
      chatLlm: { baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'm' },
      bots: [{
        id: 'nahida',
        dataDir: dir,
        personaDir: PERSONA_DIR,
        napcatWs: 'ws://127.0.0.1:9999',
        access: { users: ['u_leaf'], admins: ['u_leaf'] },
        batch: { privateQuietMs: 10, privateMaxWaitMs: 30 },
        webSearch: { enabled: false },
      }],
    })

    const app = createApp(cfg, {
      inMemoryDb: true,
      chatModelOverride: fakeChat,
      auxModelOverride: fakeAux,
      singingOverride: fakeSinging,
      fetchImpl: async (url) => {
        assert.equal(String(url), 'https://cdn.mureka.test/e2e.mp3')
        return new Response(new Uint8Array(Buffer.from('FAKE-MP3-BYTES')), { status: 200 })
      },
      wsFactory: () => {
        wsInstance = new FakeWs()
        return wsInstance
      },
    })

    const startP = app.start()
    wsInstance!.emit('open')
    await startP

    // 用户私聊点歌
    wsInstance!.emit('message', Buffer.from(JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      user_id: 'u_leaf',
      message_id: 'm1',
      sender: { nickname: '小叶' },
      message: [{ type: 'text', data: { text: '纳西妲，能给我唱首晚安歌吗？' } }],
    })))

    await new Promise((r) => setTimeout(r, 120))
    const bot = app.bots[0]!

    // 此时立即回复了文字，且 works 里已挂上 generating 任务
    const works1 = bot.store.listWorks('song')
    assert.equal(works1.length, 1)
    assert.equal(works1[0]?.status, 'generating')
    assert.equal(works1[0]?.externalTaskId, 'mk_e2e_42')
    assert.equal(works1[0]?.forUser, 'u_leaf')

    // 第一次轮询：还在 processing
    await app.rhythm.songTick()
    assert.equal(bot.store.listWorks('song')[0]?.status, 'generating')

    // 第二次轮询：succeeded → 下载落盘 → 推语音条 + 文字
    await app.rhythm.songTick()
    const readyWork = bot.store.listWorks('song')[0]!
    assert.equal(readyWork.status, 'ready')
    assert.ok(readyWork.mediaPath && existsSync(readyWork.mediaPath))

    const recordFrame = wsInstance!.sent.find((f) => {
      const segs = (f.params as { message?: Array<{ type: string; data?: { file?: string } }> })?.message
      return Array.isArray(segs) && segs.some((s) => s.type === 'record')
    })
    assert.ok(recordFrame, 'should have sent record segment via OneBot11 WS')
    const allText = wsInstance!.sent
      .map((f) => JSON.stringify(f.params ?? {}))
      .join('\n')
    assert.match(allText, /净善宫的晚风/)

    await app.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
