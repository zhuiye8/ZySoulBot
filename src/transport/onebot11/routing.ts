// OneBot11 入站消息解析：线程路由、说话人名、纯文本、图片、富媒体段与 @ 判定。
export interface OneBotSegment {
  type?: string
  data?: Record<string, unknown>
}

export interface OneBotEvent {
  post_type?: string
  message_type?: 'private' | 'group'
  message_id?: number | string
  user_id?: number | string
  group_id?: number | string
  self_id?: number | string
  message?: OneBotSegment[] | string
  sender?: { nickname?: string; card?: string }
}

export function threadKeyOf(ev: OneBotEvent): string | null {
  if (ev.message_type === 'private' && ev.user_id !== undefined) return `qq:private:${ev.user_id}`
  if (ev.message_type === 'group' && ev.group_id !== undefined) return `qq:group:${ev.group_id}`
  return null
}

export function senderNameOf(ev: OneBotEvent): string {
  return String(ev.sender?.card || ev.sender?.nickname || '').trim()
}

export function extractText(message: OneBotSegment[] | string | undefined): string {
  if (Array.isArray(message)) {
    return message
      .filter((s) => s?.type === 'text')
      .map((s) => String(s.data?.text ?? ''))
      .join('')
      .trim()
  }
  return String(message ?? '').replace(/\[CQ:[^\]]*\]/g, '').trim()
}

export function extractImages(message: OneBotSegment[] | string | undefined): string[] {
  if (!Array.isArray(message)) return []
  const out: string[] = []
  for (const s of message) {
    if (s?.type !== 'image' && s?.type !== 'mface') continue
    const rawUrl = String(s.data?.url ?? '')
    const rawFile = String(s.data?.file ?? '')
    const candidate = /^https?:\/\//i.test(rawUrl) ? rawUrl : (/^https?:\/\//i.test(rawFile) ? rawFile : '')
    if (candidate) out.push(candidate)
  }
  return out
}

export interface RichParts {
  mentions: string[]
  replyTo?: string
  attachments: Array<{ kind: string; title?: string; url?: string }>
  textExtra: string
}

export function extractRich(message: OneBotSegment[] | string | undefined, selfId?: string): RichParts {
  const out: RichParts = { mentions: [], attachments: [], textExtra: '' }
  if (!Array.isArray(message)) return out
  const notes: string[] = []
  for (const s of message) {
    const d = s?.data ?? {}
    const str = (k: string): string => String(d[k] ?? '')
    switch (s?.type) {
      case 'at': {
        const qq = str('qq')
        if (qq && qq !== 'all' && qq !== String(selfId ?? '')) {
          out.mentions.push(qq)
          notes.push(`@${str('name') || qq}`)
        } else if (qq === 'all') {
          notes.push('@全体成员')
        }
        break
      }
      case 'reply': {
        out.replyTo = str('id') || undefined
        notes.push('（引用了上面一条消息）')
        break
      }
      case 'record': {
        const rawUrl = str('url')
        const rawFile = str('file')
        const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : (/^https?:\/\//i.test(rawFile) ? rawFile : undefined)
        out.attachments.push({ kind: 'record', url })
        notes.push('[语音]')
        break
      }
      case 'image': {
        const summary = str('summary').trim()
        const subType = Number(d.sub_type ?? 0)
        if (summary) notes.push(summary.startsWith('[') ? summary : `[图片:${summary}]`)
        else if (subType === 1) notes.push('[表情包]')
        break
      }
      case 'mface': {
        const summary = str('summary').trim()
        notes.push(summary ? `[表情包:${summary.replace(/^\[|\]$/g, '')}]` : '[商城表情包]')
        break
      }
      case 'video': {
        out.attachments.push({ kind: 'video', url: str('url') || undefined })
        notes.push('[视频]')
        break
      }
      case 'file': {
        const title = str('name') || str('file') || '未命名'
        out.attachments.push({ kind: 'file', title, url: str('url') || undefined })
        notes.push(`[文件:${title}]`)
        break
      }
      case 'json':
      case 'xml': {
        const raw = str('data')
        let title = ''
        let url = ''
        try {
          const j = JSON.parse(raw) as { meta?: Record<string, Record<string, unknown>>; prompt?: string }
          const meta = j.meta?.detail_1 ?? j.meta?.news ?? j.meta?.music ?? {}
          title = String(meta.title ?? meta.desc ?? j.prompt ?? '')
          url = String(meta.qqdocurl ?? meta.jumpUrl ?? meta.url ?? '')
        } catch {
          title = /<title[^>]*>(?:<!\[CDATA\[)?([^<\]]+)/.exec(raw)?.[1] ?? ''
          url = /url="([^"]+)"/.exec(raw)?.[1] ?? ''
        }
        out.attachments.push({ kind: 'card', title: title || '卡片消息', url: url || undefined })
        notes.push(`[分享:${title || '卡片'}${url ? ` ${url}` : ''}]`)
        break
      }
      case 'share': {
        const title = str('title')
        const url = str('url')
        out.attachments.push({ kind: 'share', title, url })
        notes.push(`[链接:${title} ${url}]`.trim())
        break
      }
      case 'music': {
        const title = str('title') || str('id') || '音乐'
        const url = str('url') || str('audio') || undefined
        out.attachments.push({ kind: 'music', title, url })
        notes.push(`[音乐:${title}]`)
        break
      }
      case 'location': {
        const title = str('title') || str('content') || '位置'
        notes.push(`[位置:${title}]`)
        break
      }
      case 'forward': {
        out.attachments.push({ kind: 'forward', title: str('id') })
        notes.push('[合并转发聊天记录]')
        break
      }
      case 'face': {
        const rawObj = d.raw as { faceText?: string } | undefined
        const label = rawObj?.faceText?.trim() || str('id')
        notes.push(`[QQ表情:${label}]`)
        break
      }
      case 'dice': {
        notes.push(`[掷骰子:${str('result') || '?'}]`)
        break
      }
      case 'rps': {
        notes.push(`[猜拳:${str('result') || '?'}]`)
        break
      }
      case 'markdown': {
        const md = str('content').trim()
        if (md) notes.push(md.slice(0, 200))
        break
      }
      default: break
    }
  }
  out.textExtra = notes.join(' ')
  return out
}

export function isAtMe(ev: OneBotEvent, selfId: string): boolean {
  if (!selfId) return false
  if (Array.isArray(ev.message)) {
    return ev.message.some((s) => s?.type === 'at' && String(s.data?.qq ?? '') === selfId)
  }
  return new RegExp(`\\[CQ:at,qq=${selfId}\\]`).test(String(ev.message ?? ''))
}
