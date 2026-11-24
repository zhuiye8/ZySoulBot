// 统一多模态表达工具（注册在 express 层）：
// 诚实能力原则：仅注册实际已配置的能力，绝不把未配置的 TTS/唱歌/表情包暴露给模型。
// - send_voice    : TTS 合成语音并发给当前会话（带每会话冷却防刷屏）
// - send_sticker  : 按情绪从表情包库选图并发送
// - react_message : 给对方刚发的消息贴一个小表情回应
// - poke_user     : 轻轻戳一戳对方
// - sing_song     : 提交 Mureka 异步唱歌任务并记入 works 表，绝不阻塞当前对话
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { EMOTION_KINDS } from '../shared/ports.ts'
import type {
  AffectKind,
  SendTarget,
  SingingPort,
  SoulStore,
  ToolRunContext,
  TransportPort,
  TtsPort,
} from '../shared/ports.ts'
import { nowLocal } from '../shared/time.ts'
import type { BodyEngine } from '../soul/body/engine.ts'
import type { RelationEngine } from '../soul/relation/engine.ts'
import type { StickerLibrary } from '../soul/expression/stickers.ts'
import type { InMemoryToolRegistry } from './registry.ts'

export interface ExpressionToolsDeps {
  store: SoulStore
  relations: RelationEngine
  body?: BodyEngine
  getTransport: () => TransportPort | null
  tts?: TtsPort | null
  singing?: SingingPort | null
  stickers?: StickerLibrary | null
  defaultVocalId?: string
  voiceCooldownMs?: number
  actCooldownMs?: number
}

function targetFromCtx(ctx: ToolRunContext): SendTarget | null {
  if (ctx.solo) return null
  if (ctx.isGroup) {
    const groupId = ctx.groupId ?? (ctx.threadKey.startsWith('qq:group:') ? ctx.threadKey.slice('qq:group:'.length) : undefined)
    return groupId ? { messageType: 'group', groupId } : null
  }
  return ctx.userId ? { messageType: 'private', userId: ctx.userId } : null
}

const SendVoiceArgsSchema = z.object({
  text: z.string().min(1).max(300),
  emotion: z.enum(EMOTION_KINDS).optional(),
  tone: z.string().max(40).optional(),
})

function inferVoiceEmotion(store: SoulStore, body: BodyEngine | undefined, now: Date): { emotion: AffectKind; speechRateDelta: number } {
  const state = body?.state(now)
  const sleepy = state ? (state.energy < 0.3 || state.sleepDebt > 0.65) : false
  // 优先看最近 30 分钟内的真实情绪来由
  const recent = store.recentEmotionCauses(1)[0]
  if (recent && recent.affectKind !== 'neutral') {
    const at = Date.parse(recent.createdAt.replace(' ', 'T'))
    if (Number.isFinite(at) && now.getTime() - at <= 30 * 60_000) {
      return { emotion: recent.affectKind, speechRateDelta: sleepy ? -8 : 0 }
    }
  }
  if (sleepy) return { emotion: 'boredom', speechRateDelta: 0 }
  if (state) {
    if (state.pad.p < -0.25 && state.pad.a > 0.15) return { emotion: 'annoyed', speechRateDelta: 0 }
    if (state.pad.p < -0.25) return { emotion: 'sadness', speechRateDelta: 0 }
    if (state.pad.p > 0.4) return { emotion: 'praised', speechRateDelta: 0 }
  }
  return { emotion: 'neutral', speechRateDelta: 0 }
}

const SendStickerArgsSchema = z.object({
  emotion: z.enum(EMOTION_KINDS),
  force: z.boolean().optional(),
})

const ReactArgsSchema = z.object({
  emoji_id: z.string().min(1).max(16).default('76'), // QQ 常用小表情 ID（76=赞，66=爱心，181=戳一戳等）
})

const SingSongArgsSchema = z.object({
  title: z.string().min(1).max(40),
  lyrics: z.string().min(8).max(1200),
  style: z.string().max(160).optional(),
  mood_note: z.string().max(120).optional(),
})

export function registerExpressionTools(registry: InMemoryToolRegistry, deps: ExpressionToolsDeps): void {
  const lastVoiceAt = new Map<string, number>()
  const lastActAt = new Map<string, number>()
  const voiceCooldownMs = deps.voiceCooldownMs ?? 45_000
  const actCooldownMs = deps.actCooldownMs ?? 20_000

  // 1) 语音表达：仅在配置了 TTS 时注册
  if (deps.tts) {
    const tts = deps.tts
    registry.register({
      layer: 'express',
      spec: {
        name: 'send_voice',
        description: '把你想说的一段简短的话合成语音条发给对方（会随你的情绪自然改变语速和语调，别每句都发）。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要念出来的纯口语文本（不要带括号动作或颜文字，≤200字）' },
            emotion: { type: 'string', enum: [...EMOTION_KINDS], description: '可选：说这句话时的真实情绪（如 conflict/annoyed/hurt/praised/curiosity/neutral）' },
            tone: { type: 'string', description: '可选：简短语气提示（如「语气冷淡地说」「带着笑意轻快地说」，≤24字）' },
          },
          required: ['text'],
        },
      },
      async execute(rawArgs, ctx) {
        const parsed = SendVoiceArgsSchema.safeParse(rawArgs)
        if (!parsed.success) return { output: '参数无效：请提供要念出的 text。', isError: true }
        const target = targetFromCtx(ctx)
        const transport = deps.getTransport()
        if (!target || !transport) return { output: '当前不在可发语音的聊天里。', isError: true }

        const nowMs = ctx.now.getTime()
        const prev = lastVoiceAt.get(ctx.threadKey) ?? 0
        if (nowMs - prev < voiceCooldownMs) {
          return { output: '刚刚才发过语音，这句直接打字说就好。' }
        }

        const clean = parsed.data.text.replace(/[（(][^）)]{0,24}[）)]/g, '').trim()
        if (!clean) return { output: '去掉括号动作后文本为空，请改用打字。', isError: true }

        const inferred = inferVoiceEmotion(deps.store, deps.body, ctx.now)
        const emotion = parsed.data.emotion ?? inferred.emotion

        try {
          const audio = await tts.synth({
            text: clean,
            emotion,
            tone: parsed.data.tone,
            speechRateDelta: parsed.data.emotion ? 0 : inferred.speechRateDelta,
            signal: ctx.signal,
          })
          const b64 = Buffer.from(audio.bytes).toString('base64')
          await transport.send(target, { type: 'record', url: `base64://${b64}` })
          lastVoiceAt.set(ctx.threadKey, nowMs)
          return {
            output: `语音已发出（${clean.length}字）。你刚才已经把这句话说出口了，接下来回复里不必逐字重复。`,
            foldSummary: `发语音：${clean.slice(0, 32)}`,
          }
        } catch (e) {
          deps.store.logTrace({
            traceId: 'express',
            event: 'tts_send_error',
            level: 'warn',
            data: { error: (e as Error).message.slice(0, 160) },
          })
          return { output: `语音合成暂时没成功（${(e as Error).message.slice(0, 80)}），改用文字说就好。`, isError: true }
        }
      },
    })
  }

  // 2) 表情包表达：仅在启用了表情包库时注册
  if (deps.stickers) {
    const stickers = deps.stickers
    registry.register({
      layer: 'express',
      spec: {
        name: 'send_sticker',
        description: '按当下情绪从自己的表情包里挑一张发出去（情绪合适时偶尔用，宁缺毋滥）。',
        parameters: {
          type: 'object',
          properties: {
            emotion: {
              type: 'string',
              enum: [...EMOTION_KINDS],
              description: '要表达的情绪类型',
            },
            force: {
              type: 'boolean',
              description: '对方明确要你发表情包时设 true',
            },
          },
          required: ['emotion'],
        },
      },
      async execute(rawArgs, ctx) {
        const parsed = SendStickerArgsSchema.safeParse(rawArgs)
        if (!parsed.success) return { output: '参数无效：请指定受控情绪 emotion。', isError: true }
        const target = targetFromCtx(ctx)
        const transport = deps.getTransport()
        if (!target || !transport) return { output: '当前不在可发表情包的聊天里。', isError: true }

        const rel = deps.relations.get(ctx.userId)
        const picked = stickers.select(parsed.data.emotion, {
          route: ctx.threadKey,
          closeness: rel.closeness,
          strained: deps.relations.isStrained(ctx.userId),
          force: parsed.data.force,
          nowMs: ctx.now.getTime(),
        })
        if (!picked) {
          return { output: `表情包库里此刻没有适合「${parsed.data.emotion}」的图（或在冷却中），直接说话就好。` }
        }
        try {
          const url = pathToFileURL(picked.absPath).href
          await transport.send(target, { type: 'image', url })
          stickers.noteSent(ctx.threadKey, picked.key, parsed.data.emotion, ctx.now.getTime())
          return {
            output: `已发出一张「${parsed.data.emotion}」表情包${picked.description ? `（${picked.description}）` : ''}。`,
            foldSummary: `发表情包(${parsed.data.emotion}:${picked.key})`,
          }
        } catch (e) {
          return { output: `表情包发送失败：${(e as Error).message.slice(0, 80)}`, isError: true }
        }
      },
    })
  }

  // 3) 轻动作：贴表情回应 / 戳一戳（依赖 TransportPort.act）
  registry.register({
    layer: 'express',
    spec: {
      name: 'react_message',
      description: '给对方刚才那条消息贴一个小表情回应（轻互动，不必多说话）。',
      parameters: {
        type: 'object',
        properties: {
          emoji_id: {
            type: 'string',
            description: 'QQ 表情 ID，例如 76(赞)、66(爱心)、128076(OK)、10024(闪亮)',
          },
        },
      },
    },
    async execute(rawArgs, ctx) {
      const parsed = ReactArgsSchema.safeParse(rawArgs ?? {})
      if (!parsed.success) return { output: 'emoji_id 参数无效', isError: true }
      const target = targetFromCtx(ctx)
      const transport = deps.getTransport()
      if (!target || !transport?.act || !ctx.messageId) {
        return { output: '当前渠道或消息不支持贴表情回应。', isError: true }
      }
      const nowMs = ctx.now.getTime()
      if (nowMs - (lastActAt.get(ctx.threadKey) ?? 0) < actCooldownMs) {
        return { output: '刚才已经互动过啦，这次直接说话就行。' }
      }
      try {
        await transport.act({ kind: 'react', target, messageId: ctx.messageId, emojiId: parsed.data.emoji_id })
        lastActAt.set(ctx.threadKey, nowMs)
        return { output: '已给对方消息贴上小表情。', foldSummary: `贴表情(${parsed.data.emoji_id})` }
      } catch (e) {
        return { output: `贴表情失败：${(e as Error).message.slice(0, 80)}`, isError: true }
      }
    },
  })

  registry.register({
    layer: 'express',
    spec: {
      name: 'poke_user',
      description: '轻轻戳一戳对方（俏皮或喊对方注意时偶尔用）。',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_rawArgs, ctx) {
      const target = targetFromCtx(ctx)
      const transport = deps.getTransport()
      if (!target || !transport?.act) return { output: '当前渠道不支持戳一戳。', isError: true }
      const nowMs = ctx.now.getTime()
      if (nowMs - (lastActAt.get(ctx.threadKey) ?? 0) < actCooldownMs) {
        return { output: '刚刚已经戳过了，别频繁戳。' }
      }
      try {
        await transport.act({
          kind: 'poke',
          target: { ...target, userId: ctx.userId },
        })
        lastActAt.set(ctx.threadKey, nowMs)
        return { output: '已经轻轻戳了对方一下。', foldSummary: '戳了戳对方' }
      } catch (e) {
        return { output: `戳一戳失败：${(e as Error).message.slice(0, 80)}`, isError: true }
      }
    },
  })

  // 4) 异步唱歌：仅在配置了 Mureka SingingPort 时注册
  if (deps.singing) {
    const singing = deps.singing
    registry.register({
      layer: 'express',
      spec: {
        name: 'sing_song',
        description: '自己填词并哼唱一首歌（异步合成约需半分钟到一分钟；提交后会立即返回，做好后系统会自动把歌声送给对方）。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '这首歌的小标题（≤20字）' },
            lyrics: { type: 'string', description: '你自己写的完整歌词，可用 [Verse] [Chorus] 分段' },
            style: { type: 'string', description: '曲风提示词（英文更稳，如 gentle acoustic folk, kalimba, lullaby, soft female vocal）' },
            mood_note: { type: 'string', description: '写这首歌时心里的念头或寄语' },
          },
          required: ['title', 'lyrics'],
        },
      },
      async execute(rawArgs, ctx) {
        const parsed = SingSongArgsSchema.safeParse(rawArgs)
        if (!parsed.success) return { output: '参数无效：请提供歌名 title 与完整歌词 lyrics。', isError: true }

        // 防止同时提交多首正在生成的歌
        const generating = deps.store.listWorks('song', 10).filter((w) => w.status === 'generating')
        if (generating.length >= 2) {
          return { output: `手头已经有 ${generating.length} 首歌正在哼着还没录完，等它们好了再唱下一首吧。` }
        }

        try {
          const { taskId } = await singing.createSong({
            title: parsed.data.title,
            lyrics: parsed.data.lyrics,
            style: parsed.data.style,
            vocalId: deps.defaultVocalId,
            signal: ctx.signal,
          })
          const workId = `song_${randomUUID().slice(0, 10)}`
          deps.store.upsertWork({
            id: workId,
            kind: 'song',
            title: parsed.data.title,
            content: parsed.data.lyrics,
            mediaPath: null,
            status: 'generating',
            externalTaskId: taskId,
            forUser: ctx.solo ? null : ctx.userId,
            moodNote: parsed.data.mood_note ?? (ctx.isGroup ? ctx.threadKey : null),
            createdAt: nowLocal(ctx.now),
          })
          deps.store.logTrace({
            traceId: 'sing',
            event: 'song_submitted',
            level: 'info',
            data: { workId, taskId, title: parsed.data.title, forUser: ctx.userId },
          })
          return {
            output: `已经开始哼唱《${parsed.data.title}》了（作品号 ${workId}），大约需要一分钟录好，录完会自动发过去。你可以先自然告诉对方稍等一下。`,
            foldSummary: `开始唱歌《${parsed.data.title}》`,
          }
        } catch (e) {
          deps.store.logTrace({
            traceId: 'sing',
            event: 'song_submit_error',
            level: 'warn',
            data: { error: (e as Error).message.slice(0, 160) },
          })
          return { output: `这次起调没连上唱歌服务：${(e as Error).message.slice(0, 100)}`, isError: true }
        }
      },
    })
  }
}
