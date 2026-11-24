// 表情包多模态自动打标：上传表情包时复用 ChatModel 视觉能力，输出受控 9 情绪 + 简短描述。
import { z } from 'zod'
import { EMOTION_KINDS } from '../shared/ports.ts'
import type { AffectKind, ChatModel } from '../shared/ports.ts'

const TagResultSchema = z.object({
  emotions: z.array(z.enum(EMOTION_KINDS)).min(1).max(3),
  tags: z.array(z.string().max(16)).max(6).default([]),
  description: z.string().max(80).default(''),
})

export interface StickerTagResult {
  emotions: AffectKind[]
  tags: string[]
  description: string
}

const TAG_SYSTEM = `你是表情包情绪打标助手。看这张聊天表情包，判断它最适合在什么情绪下发。
情绪只能从这 12 个里选 1~3 个：praised, affection, curiosity, humor, annoyed, hurt, rejected, conflict, sadness, uneasy, boredom, neutral。
严格输出 JSON，不要其他文字：
{"emotions":["humor"],"tags":["偷笑","调皮"],"description":"小女孩眯着眼笑"}`

export async function tagStickerImage(
  model: ChatModel,
  image: { bytes: Uint8Array; mimeType: string },
  signal?: AbortSignal,
): Promise<StickerTagResult> {
  const res = await model.complete({
    messages: [
      { role: 'system', content: TAG_SYSTEM },
      {
        role: 'user',
        content: '给这张表情包打情绪标签与简短说明。',
        images: [{ data: Buffer.from(image.bytes).toString('base64'), mimeType: image.mimeType }],
      },
    ],
    temperature: 0.2,
    maxTokens: 200,
    reasoningEffort: 'low',
    signal,
  })
  const m = res.content.match(/\{[\s\S]*\}/)
  if (!m) return { emotions: ['neutral'], tags: [], description: '' }
  try {
    const parsed = TagResultSchema.safeParse(JSON.parse(m[0]))
    if (parsed.success) return parsed.data
  } catch {
    // 落回默认标签
  }
  return { emotions: ['neutral'], tags: [], description: '' }
}
