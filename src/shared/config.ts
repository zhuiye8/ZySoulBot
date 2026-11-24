// 强类型配置 Schema（Zod）：不生效的字段绝不留，启动期即校验。
import { z } from 'zod'

export const GatewayConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
  // 估算单价（元 / 百万 token），用于后台 Token 账本估算
  pricePerMillionInputCny: z.number().nonnegative().optional(),
  pricePerMillionCachedCny: z.number().nonnegative().optional(),
  pricePerMillionOutputCny: z.number().nonnegative().optional(),
})

export const BotConfigSchema = z.object({
  id: z.string().min(1),
  dataDir: z.string().min(1),
  personaDir: z.string().min(1).optional(),
  selfId: z.string().optional(),
  napcatWs: z.string().optional(),
  napcatToken: z.string().optional(),
  access: z.object({
    users: z.array(z.string()).default([]),
    groups: z.array(z.string()).default([]),
    admins: z.array(z.string()).default([]),
  }).default({ users: [], groups: [], admins: [] }),
  relations: z.object({
    defaultType: z.string().default('friend'),
    identityCall: z.string().optional(),
  }).default({ defaultType: 'friend' }),
  proactivity: z.object({
    enabled: z.boolean().default(false),
    allowlist: z.array(z.string()).default([]),
    quietHours: z.tuple([z.string(), z.string()]).optional(),
    exitPhrases: z.array(z.string()).default(['别发了', '我想安静会', '别吵', '闭嘴']),
    autonomyBuildEnabled: z.boolean().default(true),
    credentialsPath: z.string().optional(),
  }).default({ enabled: false, allowlist: [], exitPhrases: ['别发了', '我想安静会', '别吵', '闭嘴'], autonomyBuildEnabled: true }),
  budget: z.object({
    // 自主行为（生活/联想/造能力）每日输入+输出 token 软上限，超限自动休眠，不影响陪聊
    dailyAutonomousTokens: z.number().int().positive().default(120_000),
    // 对话历史按块裁剪配置：满 maxHistoryMessages 裁掉 compactDropCount 条
    maxHistoryMessages: z.number().int().min(12).default(30),
    compactDropCount: z.number().int().min(4).default(10),
  }).default({ dailyAutonomousTokens: 120_000, maxHistoryMessages: 30, compactDropCount: 10 }),
  traits: z.object({
    O: z.number().min(0).max(1).optional(),
    C: z.number().min(0).max(1).optional(),
    E: z.number().min(0).max(1).optional(),
    A: z.number().min(0).max(1).optional(),
    N: z.number().min(0).max(1).optional(),
  }).optional(),
  baselinePad: z.object({
    p: z.number().min(-1).max(1),
    a: z.number().min(-1).max(1),
    d: z.number().min(-1).max(1),
  }).optional(),
  mureka: z.object({
    apiKey: z.string().min(1),
    baseUrl: z.string().url().default('https://api.mureka.cn'),
    vocalId: z.string().optional(),
    model: z.string().default('auto'),
    timeoutMs: z.number().int().positive().optional(),
  }).optional(),
  tts: z.discriminatedUnion('provider', [
    z.object({
      provider: z.literal('volc'),
      apiKey: z.string().min(1),
      speaker: z.string().min(1),
      resourceId: z.string().default('seed-icl-2.0'),
      baseUrl: z.string().url().default('https://openspeech.bytedance.com'),
      format: z.enum(['mp3', 'wav']).default('mp3'),
      sampleRate: z.number().int().positive().default(24000),
      speechRate: z.number().min(-50).max(100).default(-10),
      contextTexts: z.array(z.string()).optional(),
      timeoutMs: z.number().int().positive().optional(),
    }),
    z.object({
      provider: z.literal('openai'),
      baseUrl: z.string().url(),
      apiKey: z.string().min(1),
      model: z.string().default('tts-1'),
      voice: z.string().default('alloy'),
      format: z.enum(['mp3', 'wav', 'opus']).default('mp3'),
      speed: z.number().min(0.25).max(4).default(1),
      timeoutMs: z.number().int().positive().optional(),
    }),
    z.object({
      provider: z.literal('local'),
      baseUrl: z.string().url(),
      path: z.string().default('/tts'),
      method: z.enum(['GET', 'POST']).default('GET'),
      query: z.record(z.string(), z.string()).optional(),
      timeoutMs: z.number().int().positive().optional(),
    }),
  ]).optional(),
  stickers: z.object({
    enabled: z.boolean().default(true),
    dir: z.string().optional(),
    cooldownTurns: z.number().int().nonnegative().default(3),
    cooldownMs: z.number().int().nonnegative().default(60_000),
    recentK: z.number().int().nonnegative().default(5),
    strangerThreshold: z.number().min(0).max(1).default(0.4),
  }).optional(),
  asr: z.object({
    baseUrl: z.string().url(),
    apiKey: z.string().min(1),
    model: z.string().default('whisper-1'),
    language: z.string().optional(),
  }).optional(),
  webSearch: z.object({
    enabled: z.boolean().default(true),
    mcpUrl: z.string().url().optional(),
    mcpApiKey: z.string().optional(),
    mcpToolName: z.string().optional(),
    useResponsesFallback: z.boolean().default(true),
  }).optional(),
  group: z.object({
    enabled: z.boolean().default(true),
    ambient: z.boolean().default(false),
    judgeGapMs: z.number().int().nonnegative().default(20_000),
    minSinceBotSpoke: z.number().int().nonnegative().default(2),
    minChars: z.number().int().nonnegative().default(3),
    chimeMin: z.number().min(0).max(1).default(0.55),
  }).default({ enabled: true, ambient: false, judgeGapMs: 20_000, minSinceBotSpoke: 2, minChars: 3, chimeMin: 0.55 }),
  batch: z.object({
    privateQuietMs: z.number().int().nonnegative().default(1200),
    privateMaxWaitMs: z.number().int().nonnegative().default(3500),
    groupQuietMs: z.number().int().nonnegative().default(2000),
    groupMaxWaitMs: z.number().int().nonnegative().default(12_000),
    groupExtendMs: z.number().int().nonnegative().default(3000),
    groupMaxExtensions: z.number().int().nonnegative().default(3),
  }).default({
    privateQuietMs: 1200,
    privateMaxWaitMs: 3500,
    groupQuietMs: 2000,
    groupMaxWaitMs: 12_000,
    groupExtendMs: 3000,
    groupMaxExtensions: 3,
  }),
})

export const ZysoulConfigSchema = z.object({
  chatLlm: GatewayConfigSchema,
  auxLlm: GatewayConfigSchema.optional(),
  admin: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().positive().default(8788),
    publicUrl: z.string().optional(),
  }).optional(),
  bots: z.array(BotConfigSchema).default([]),
})

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>
export type BotConfig = z.infer<typeof BotConfigSchema>
export type ZysoulConfig = z.infer<typeof ZysoulConfigSchema>
