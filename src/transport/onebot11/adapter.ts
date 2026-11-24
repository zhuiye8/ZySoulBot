// OneBot11（NapCat）正向 WebSocket 适配器：收发消息、气泡拆泡、轻动作（贴表情/戳一戳）、断线退避重连。
import WebSocket from 'ws'
import type {
  IncomingMessage,
  LightAction,
  SendPayload,
  SendTarget,
  TransportPort,
} from '../../shared/ports.ts'
import { splitReply } from './deliver.ts'
import { extractImages, extractRich, extractText, isAtMe, senderNameOf, threadKeyOf } from './routing.ts'
import type { OneBotEvent } from './routing.ts'

export interface WsLike {
  readyState: number
  send(data: string): void
  close(): void
  on(event: 'open', cb: () => void): void
  on(event: 'message', cb: (data: Buffer | string) => void): void
  on(event: 'close', cb: () => void): void
  on(event: 'error', cb: (err: Error) => void): void
}

export interface OneBot11Options {
  botId: string
  url: string
  token?: string
  selfId?: string
  bubbleDelayMs?: number
  onMessage: (msg: IncomingMessage) => void
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void
  wsFactory?: (url: string, headers: Record<string, string>) => WsLike
}

export function createOneBot11Transport(opts: OneBot11Options): TransportPort {
  let ws: WsLike | null = null
  let closed = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let attempts = 0
  let selfId = opts.selfId ?? ''
  const bubbleDelayMs = opts.bubbleDelayMs ?? 450

  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  const sendAction = (action: string, params: Record<string, unknown>): Promise<unknown> => {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`OneBot WS not open (action=${action})`))
        return
      }
      const echo = `zy_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
      const timer = setTimeout(() => {
        pending.delete(echo)
        reject(new Error(`OneBot action timeout: ${action}`))
      }, 15_000)
      timer.unref?.()
      pending.set(echo, { resolve, reject, timer })
      ws.send(JSON.stringify({ action, params, echo }))
    })
  }

  const handleRaw = (raw: Buffer | string): void => {
    let data: Record<string, unknown>
    try {
      data = JSON.parse(raw.toString()) as Record<string, unknown>
    } catch {
      return
    }
    // 回执响应
    if (typeof data.echo === 'string' && pending.has(data.echo)) {
      const p = pending.get(data.echo)!
      pending.delete(data.echo)
      clearTimeout(p.timer)
      if (data.status === 'failed') p.reject(new Error(String(data.message ?? data.wording ?? 'action failed')))
      else p.resolve(data.data)
      return
    }

    const ev = data as unknown as OneBotEvent
    if (ev.self_id && !selfId) selfId = String(ev.self_id)
    if (ev.post_type !== 'message') return
    if (ev.user_id !== undefined && String(ev.user_id) === selfId) return

    const threadKey = threadKeyOf(ev)
    if (!threadKey || !ev.message_type || ev.user_id === undefined) return

    const baseText = extractText(ev.message)
    const images = extractImages(ev.message)
    const rich = extractRich(ev.message, selfId)
    const text = [baseText, rich.textExtra].filter(Boolean).join(' ').trim()
    const atMe = ev.message_type === 'group' ? isAtMe(ev, selfId) : false

    // 既没字也没图也没 @（空事件）直接忽略
    if (!text && images.length === 0 && !atMe) return

    opts.onMessage({
      botId: opts.botId,
      threadKey,
      messageType: ev.message_type,
      userId: String(ev.user_id),
      userName: senderNameOf(ev) || undefined,
      groupId: ev.group_id !== undefined ? String(ev.group_id) : null,
      messageId: ev.message_id !== undefined ? String(ev.message_id) : undefined,
      text,
      atMe,
      ...(images.length ? { images } : {}),
      ...(rich.mentions.length ? { mentions: rich.mentions } : {}),
      ...(rich.replyTo ? { replyTo: rich.replyTo } : {}),
      ...(rich.attachments.length ? { attachments: rich.attachments } : {}),
    })
  }

  const connect = (): Promise<void> => {
    return new Promise((resolve) => {
      const headers: Record<string, string> = {}
      if (opts.token) headers.Authorization = `Bearer ${opts.token}`
      const sock: WsLike = opts.wsFactory
        ? opts.wsFactory(opts.url, headers)
        : new WebSocket(opts.url, { headers })
      ws = sock
      let settled = false
      const settle = (): void => { if (!settled) { settled = true; resolve() } }

      sock.on('open', () => {
        attempts = 0
        opts.onLog?.('info', `OneBot11 connected: ${opts.url}`)
        settle()
      })
      sock.on('message', handleRaw)
      sock.on('error', (err) => {
        opts.onLog?.('warn', `OneBot11 ws error: ${err.message}`)
        settle()
      })
      sock.on('close', () => {
        if (ws === sock) ws = null
        settle()
        if (closed) return
        attempts += 1
        const waitMs = Math.min(30_000, 1000 * Math.pow(2, Math.min(5, attempts - 1)))
        opts.onLog?.('warn', `OneBot11 closed, reconnecting in ${waitMs}ms`)
        reconnectTimer = setTimeout(() => { void connect() }, waitMs)
        reconnectTimer.unref?.()
      })
    })
  }

  const sendRawSegments = async (target: SendTarget, segments: Array<{ type: string; data: Record<string, unknown> }>): Promise<void> => {
    if (target.messageType === 'private') {
      await sendAction('send_private_msg', { user_id: Number(target.userId), message: segments })
    } else {
      await sendAction('send_group_msg', { group_id: Number(target.groupId), message: segments })
    }
  }

  return {
    id: 'onebot11',
    async start(): Promise<void> {
      closed = false
      await connect()
    },
    async send(target: SendTarget, payload: SendPayload): Promise<void> {
      if (payload.type === 'image' && payload.url) {
        await sendRawSegments(target, [{ type: 'image', data: { file: payload.url } }])
        return
      }
      if (payload.type === 'record' && payload.url) {
        await sendRawSegments(target, [{ type: 'record', data: { file: payload.url } }])
        return
      }
      const text = (payload.text ?? '').trim()
      if (!text) return
      const bubbles = payload.instant ? [text] : splitReply(text)
      for (let i = 0; i < bubbles.length; i++) {
        const segs: Array<{ type: string; data: Record<string, unknown> }> = []
        if (i === 0 && target.messageType === 'group' && payload.mentionUserId) {
          segs.push({ type: 'at', data: { qq: payload.mentionUserId } })
          segs.push({ type: 'text', data: { text: ` ${bubbles[i]!}` } })
        } else {
          segs.push({ type: 'text', data: { text: bubbles[i]! } })
        }
        await sendRawSegments(target, segs)
        if (i < bubbles.length - 1 && bubbleDelayMs > 0) {
          await new Promise((r) => setTimeout(r, bubbleDelayMs))
        }
      }
    },
    async act(action: LightAction): Promise<void> {
      if (action.kind === 'react' && action.messageId && action.emojiId) {
        await sendAction('set_msg_emoji_like', {
          message_id: Number(action.messageId),
          emoji_id: action.emojiId,
          set: true,
        })
      } else if (action.kind === 'poke' && action.target.userId) {
        await sendAction('friend_poke', { user_id: Number(action.target.userId) })
      }
    },
    async dispose(): Promise<void> {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
      for (const p of pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('OneBot transport disposed'))
      }
      pending.clear()
      ws?.close()
      ws = null
    },
  }
}
