import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { ZysoulConfigSchema } from '../src/shared/config.ts'
import { createApp } from '../src/app.ts'
import type { WsLike } from '../src/transport/onebot11/adapter.ts'
import type { ChatModel, ChatRequest, ChatResponse } from '../src/shared/ports.ts'

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

  close(): void { this.readyState = WebSocket.CLOSED; this.emit('close') }
  triggerOpen(): void { this.emit('open') }
}

describe('P2 Rhythm E2E (Desire -> Credential Wait -> Resume -> Build & Verify + Pending Replies + Reminders)', () => {
  it('completes the full autonomous desire -> request_credential -> admin fill -> resume -> skill build loop', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'zysoul-p2-e2e-'))
    let wsInstance: FakeWs | null = null
    let currentTime = new Date('2026-11-24T15:00:00+08:00')
    let soloPhase: 'register_cred' | 'build_skill' = 'register_cred'
    let soloSubStep = 0

    const fakeChat: ChatModel = {
      id: 'fake-chat',
      model: 'fake',
      async complete(req: ChatRequest): Promise<ChatResponse> {
        const last = req.messages[req.messages.length - 1]!
        // 阶段 1：她决定先登记凭证需求
        if (soloPhase === 'register_cred') {
          if (last.role !== 'tool') {
            return {
              content: '',
              toolCalls: [{
                id: 'tc_cred',
                name: 'request_credential',
                arguments: JSON.stringify({
                  name: 'image-gen',
                  label: '生图服务',
                  provider: 'aliyun-wanx',
                  providerName: '阿里云通义万相',
                  why: '我想把看到的花画下来',
                  fields: [{ key: 'apiKey', label: 'API Key', type: 'secret', required: true }],
                }),
              }],
              finishReason: 'tool_calls',
              usage: { inputTokens: 800, cachedTokens: 600, outputTokens: 40, reasoningTokens: 0, totalTokens: 840 },
              model: 'fake',
            }
          }
          return {
            content: '我先记下了需要的生图密钥，等他去后台填好再接着画。',
            toolCalls: [],
            finishReason: 'stop',
            usage: { inputTokens: 900, cachedTokens: 600, outputTokens: 25, reasoningTokens: 0, totalTokens: 925 },
            model: 'fake',
          }
        }

        // 阶段 2：凭证填好唤醒后，写 SKILL.md 并自检登记
        soloSubStep += 1
        if (soloSubStep === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'tc_w1',
              name: 'workspace_write',
              arguments: JSON.stringify({ path: 'skills/draw-flower/SKILL.md', content: '# draw-flower\n把花画出来。' }),
            }],
            finishReason: 'tool_calls',
            usage: { inputTokens: 800, cachedTokens: 600, outputTokens: 30, reasoningTokens: 0, totalTokens: 830 },
            model: 'fake',
          }
        }
        if (soloSubStep === 2) {
          return {
            content: '',
            toolCalls: [{
              id: 'tc_r1',
              name: 'register_skill',
              arguments: JSON.stringify({ name: 'draw-flower', summary: '调用生图服务画出看到的花' }),
            }],
            finishReason: 'tool_calls',
            usage: { inputTokens: 850, cachedTokens: 600, outputTokens: 30, reasoningTokens: 0, totalTokens: 880 },
            model: 'fake',
          }
        }
        return {
          content: '我把画花的本领做好了，试了一下也顺手。',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 900, cachedTokens: 600, outputTokens: 20, reasoningTokens: 0, totalTokens: 920 },
          model: 'fake',
        }
      },
    }

    const fakeAux: ChatModel = {
      id: 'fake-aux',
      model: 'fake-aux',
      async complete(req: ChatRequest): Promise<ChatResponse> {
        const sys = req.messages[0]?.content ?? ''
        const user = req.messages[1]?.content ?? ''
        if (sys.includes('冷工程判断')) {
          const idMatch = /\[id=([^\]]+)\]/.exec(user)
          return {
            content: JSON.stringify({
              items: [{
                id: idMatch?.[1] ?? 'unknown',
                exitKind: 'build_skill',
                skillAction: 'create',
                skillName: 'draw-flower',
                spec: '输入花朵描述调用生图服务画图',
                needsCredential: true,
                blocker: null,
              }],
            }),
            toolCalls: [],
            finishReason: 'stop',
            usage: { inputTokens: 150, cachedTokens: 0, outputTokens: 60, reasoningTokens: 0, totalTokens: 210 },
            model: 'fake-aux',
          }
        }
        if (user.includes('pursue_desire')) {
          const idMatch = /-\s*\[([^\]]+)\]\s*\(build_skill\)/.exec(user)
          return {
            content: JSON.stringify({ do: 'pursue_desire', id: idMatch?.[1] ?? '' }),
            toolCalls: [],
            finishReason: 'stop',
            usage: { inputTokens: 180, cachedTokens: 0, outputTokens: 20, reasoningTokens: 0, totalTokens: 200 },
            model: 'fake-aux',
          }
        }
        return {
          content: '我想学着把看到的花画下来，需要你去后台帮我填一下通义万相的密钥呀。',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 150, cachedTokens: 0, outputTokens: 30, reasoningTokens: 0, totalTokens: 180 },
          model: 'fake-aux',
        }
      },
    }

    const cfg = ZysoulConfigSchema.parse({
      chatLlm: { baseUrl: 'https://example.com/v1', apiKey: 'test', model: 'fake' },
      admin: { host: '127.0.0.1', port: 8788, publicUrl: 'http://101.132.130.146:8788' },
      bots: [{
        id: 'nahida',
        dataDir: tempDir,
        personaDir: fileURLToPath(new URL('../personas/nahida', import.meta.url)),
        selfId: '3164305169',
        napcatWs: 'ws://127.0.0.1:3003',
        access: { users: ['1563359387'], groups: [], admins: ['1563359387'] },
        proactivity: { enabled: true, allowlist: ['1563359387'], autonomyBuildEnabled: true, allowUnsafeLocalExec: true },
      }],
    })

    const app = createApp(cfg, {
      inMemoryDb: true,
      chatModelOverride: fakeChat,
      auxModelOverride: fakeAux,
      clock: { now: () => currentTime },
      random: () => 0.01, // 保证测试里稳定命中生活骰子（但不触发 0.004 概率的白天日记）
      rhythmStartupGraceMs: 0,
      listenAdmin: false,
      adminAuthFilePath: join(tempDir, 'admin-auth.json'),
      wsFactory: () => {
        wsInstance = new FakeWs()
        queueMicrotask(() => wsInstance?.triggerOpen())
        return wsInstance
      },
    })

    try {
      await app.start()
      const bot = app.bots[0]!
      const ws = wsInstance!

      // 种下一条种子欲望
      const d = bot.soul.desires.seed({
        source: 'chat',
        motive: 'create',
        want: '我想把看到的花画下来',
        why: '今天在市集看见了很漂亮的花',
        now: currentTime,
      })!

      // Tick 1：单步成型 → 骰子命中 → 选 pursue_desire → 调用 request_credential → 暂停在 waiting_credential
      await app.rhythm.tickOnce()
      assert.equal(bot.store.getDesire(d.id)!.stage, 'waiting_credential')
      assert.equal(bot.credentials.listNeeds().length, 1)

      // Tick 2：确定性凭证提醒发给管理员（附带后台凭证页链接）
      currentTime = new Date(currentTime.getTime() + 10 * 60_000)
      await app.rhythm.tickOnce()
      const credMsgs = ws.sent.filter((s) => s.action === 'send_private_msg')
      assert.ok(credMsgs.length >= 1)
      const credText = JSON.stringify(credMsgs.map((m) => m.params))
      assert.match(credText, /credentials/)

      // 管理员在后台填好密钥
      assert.equal(bot.credentials.fill('image-gen', { apiKey: 'sk-live-key' }, undefined, currentTime), true)

      // Tick 3：自动唤醒 waiting_credential → active → 动手造技能并自检登记 → fulfilled + 通知管理员
      soloPhase = 'build_skill'
      currentTime = new Date(currentTime.getTime() + 30 * 60_000)
      await app.rhythm.tickOnce()
      assert.equal(bot.store.getDesire(d.id)!.stage, 'fulfilled')
      assert.equal(bot.store.listCapabilities().some((c) => c.name === 'draw-flower'), true)

      // 精确提醒验证：到点发送并标记 done
      bot.store.addSchedule({
        id: 'rem_test_1',
        kind: 'reminder',
        userId: '1563359387',
        threadKey: 'qq:private:1563359387',
        text: '喝水',
        dueAt: new Date(currentTime.getTime() - 1000).toISOString(),
        status: 'pending',
        createdAt: '2026-11-24 15:00:00',
      })
      const sentBefore = ws.sent.length
      await app.rhythm.reminderTick()
      assert.ok(ws.sent.length > sentBefore)
      assert.equal(bot.store.dueSchedules(currentTime.toISOString(), 'reminder').length, 0)
    } finally {
      await app.dispose()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
