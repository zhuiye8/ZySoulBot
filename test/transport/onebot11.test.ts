import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { extractImages, extractRich, extractText, isAtMe, threadKeyOf } from '../../src/transport/onebot11/routing.ts'
import { splitReply } from '../../src/transport/onebot11/deliver.ts'
import { ZysoulConfigSchema } from '../../src/shared/config.ts'
import { createApp } from '../../src/app.ts'
import type { WsLike } from '../../src/transport/onebot11/adapter.ts'
import type { ChatModel, ChatRequest, ChatResponse } from '../../src/shared/ports.ts'

class FakeWs extends EventEmitter implements WsLike {
  readyState: number = WebSocket.OPEN
  sent: Array<{ action: string; params: Record<string, unknown>; echo?: string }> = []

  send(data: string): void {
    const parsed = JSON.parse(data) as { action: string; params: Record<string, unknown>; echo?: string }
    this.sent.push(parsed)
    if (parsed.echo) {
      queueMicrotask(() => {
        this.emit('message', JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: parsed.echo }))
      })
    }
  }

  close(): void {
    this.readyState = WebSocket.CLOSED
    this.emit('close')
  }

  triggerOpen(): void {
    this.emit('open')
  }

  pushEvent(ev: Record<string, unknown>): void {
    this.emit('message', JSON.stringify(ev))
  }
}

describe('OneBot11 routing & bubble splitting', () => {
  it('parses segments, images, rich cards, and @me accurately', () => {
    const ev = {
      post_type: 'message',
      message_type: 'group' as const,
      group_id: 888,
      user_id: 123,
      sender: { card: '追夜' },
      message: [
        { type: 'at', data: { qq: '3164305169' } },
        { type: 'text', data: { text: ' 看看这张图 ' } },
        { type: 'image', data: { url: 'https://img.example.com/a.png' } },
        { type: 'share', data: { title: '须弥攻略', url: 'https://example.com' } },
      ],
    }
    assert.equal(threadKeyOf(ev), 'qq:group:888')
    assert.equal(isAtMe(ev, '3164305169'), true)
    assert.equal(extractText(ev.message), '看看这张图')
    assert.deepEqual(extractImages(ev.message), ['https://img.example.com/a.png'])
    const rich = extractRich(ev.message, '3164305169')
    assert.equal(rich.attachments[0]?.kind, 'share')
    assert.match(rich.textExtra, /须弥攻略/)
  })

  it('splits bubbles cleanly, strips markdown, and keeps lists intact', () => {
    const bubbles = splitReply('**今天**风不大。\n\n- 逛市集\n- 看花\n\n你要一起去吗？')
    assert.equal(bubbles.length, 3)
    assert.equal(bubbles[0], '今天风不大。')
    assert.equal(bubbles[1], '- 逛市集\n- 看花')
    assert.equal(bubbles[2], '你要一起去吗？')
  })
})

describe('createApp full offline integration (OneBot11 -> Soul -> Tool -> Reply + Attention)', () => {
  it('handles private message through WS, invokes reply, and respects busy later decision', async () => {
    let wsInstance: FakeWs | null = null
    let chatTurnCount = 0

    const fakeChat: ChatModel = {
      id: 'fake-chat',
      model: 'fake',
      async complete(_req: ChatRequest): Promise<ChatResponse> {
        chatTurnCount += 1
        return {
          content: '风挺轻的，今天适合出门走走。',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 1000, cachedTokens: 800, outputTokens: 20, reasoningTokens: 0, totalTokens: 1020 },
          model: 'fake',
        }
      },
    }

    const fakeAux: ChatModel = {
      id: 'fake-aux',
      model: 'fake-aux',
      async complete(req: ChatRequest): Promise<ChatResponse> {
        const sys = req.messages[0]?.content ?? ''
        if (sys.includes('now|later|ignore')) {
          return {
            content: '{"decision":"later","reason":"正在削木锁"}',
            toolCalls: [],
            finishReason: 'stop',
            usage: { inputTokens: 120, cachedTokens: 0, outputTokens: 15, reasoningTokens: 0, totalTokens: 135 },
            model: 'fake-aux',
          }
        }
        return {
          content: '{"facts":[],"affect":{"kind":"neutral","intensity":0.2},"happened":"","relationFeel":"same","signalKind":"chat","desireHint":""}',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 150, cachedTokens: 0, outputTokens: 30, reasoningTokens: 0, totalTokens: 180 },
          model: 'fake-aux',
        }
      },
    }

    const tempDataDir = mkdtempSync(join(tmpdir(), 'zysoul-app-'))
    const cfg = ZysoulConfigSchema.parse({
      chatLlm: { baseUrl: 'https://example.com/v1', apiKey: 'test', model: 'fake' },
      bots: [{
        id: 'nahida',
        dataDir: tempDataDir,
        personaDir: fileURLToPath(new URL('../../personas/nahida', import.meta.url)),
        selfId: '3164305169',
        napcatWs: 'ws://127.0.0.1:3003',
        access: { users: ['1563359387'], groups: [], admins: ['1563359387'] },
        batch: { privateQuietMs: 0, privateMaxWaitMs: 50, groupQuietMs: 0, groupMaxWaitMs: 50, groupExtendMs: 10, groupMaxExtensions: 0 },
      }],
    })

    const app = createApp(cfg, {
      inMemoryDb: true,
      chatModelOverride: fakeChat,
      auxModelOverride: fakeAux,
      wsFactory: () => {
        wsInstance = new FakeWs()
        queueMicrotask(() => wsInstance?.triggerOpen())
        return wsInstance
      },
    })

    try {
      await app.start()
      assert.ok(wsInstance)
      const ws = wsInstance as FakeWs

      // 1) 未授权用户被直接拦截，不落库也不调用模型
      ws.pushEvent({
        post_type: 'message',
        message_type: 'private',
        user_id: 999999,
        sender: { nickname: '陌生人' },
        message: [{ type: 'text', data: { text: '你好' } }],
      })
      await new Promise((r) => setTimeout(r, 30))
      assert.equal(chatTurnCount, 0)

      // 2) 授权用户发私聊 → 正常走 Soul 并经 WS 回发
      ws.pushEvent({
        post_type: 'message',
        message_type: 'private',
        user_id: 1563359387,
        sender: { nickname: '追夜' },
        message: [{ type: 'text', data: { text: '今天外面天气舒服吗？' } }],
      })
      await new Promise((r) => setTimeout(r, 60))
      assert.equal(chatTurnCount, 1)
      const sentPrivate = ws.sent.filter((s) => s.action === 'send_private_msg')
      assert.equal(sentPrivate.length, 1)

      // 3) 她正忙着做活动 → 注意力决策判 later → 不立即回，持久存进 soul.db pending_replies
      const bot = app.bots[0]!
      bot.soul.body.startActivity(bot.soul.persona.activities[2]!, '第三面槽偏了', 40)
      ws.pushEvent({
        post_type: 'message',
        message_type: 'private',
        user_id: 1563359387,
        sender: { nickname: '追夜' },
        message: [{ type: 'text', data: { text: '在干嘛呢' } }],
      })
      await new Promise((r) => setTimeout(r, 60))
      assert.equal(chatTurnCount, 1, 'later decision must not trigger immediate reply')
      const pendings = bot.store.listPendingReplies()
      assert.equal(pendings.length, 1)
      assert.equal(pendings[0]!.text, '在干嘛呢')
    } finally {
      await app.dispose()
      rmSync(tempDataDir, { recursive: true, force: true })
    }
  })
})
