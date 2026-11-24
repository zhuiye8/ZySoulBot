// 公开领域契约与端口接口：soul 仅认这里，绝不依赖外部适配器、框架或具体数据库。
export type ReasoningEffort = 'low' | 'high' | 'max'
export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'timeout' | 'content_filter' | 'error'

export const EMOTION_KINDS = [
  'praised',
  'affection',
  'curiosity',
  'humor',
  'annoyed',
  'hurt',
  'rejected',
  'conflict',
  'sadness',
  'uneasy',
  'guilty',
  'boredom',
  'neutral',
] as const
export type AffectKind = (typeof EMOTION_KINDS)[number]

export interface PAD { p: number; a: number; d: number }
export interface Traits { O?: number; C?: number; E?: number; A?: number; N?: number }

// ── LLM / Native Agent Loop 端口 ───────────────────────────────────────
export interface ImagePart {
  data: string // base64
  mimeType: string
  name?: string
}

export interface ToolCall {
  id: string
  name: string
  arguments: string // raw JSON string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  images?: ImagePart[]
  toolCalls?: ToolCall[]
  toolCallId?: string
  name?: string
  /** DeepSeek thinking+tools 等模式要求在后续工具回传中保留推理正文 */
  reasoningContent?: string
}

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON Schema object
}

export interface TokenUsage {
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
}

export interface ChatRequest {
  messages: ChatMessage[]
  tools?: ToolSpec[]
  toolChoice?: 'auto' | 'none'
  temperature?: number
  maxTokens?: number
  reasoningEffort?: ReasoningEffort
  signal?: AbortSignal
}

export interface ChatResponse {
  content: string
  toolCalls: ToolCall[]
  finishReason: FinishReason
  usage: TokenUsage
  model: string
  reasoningContent?: string
}

export interface ChatModel {
  id: string
  model: string
  complete(req: ChatRequest): Promise<ChatResponse>
}

// ── 工具腰带端口 ───────────────────────────────────────────────────────
export type ToolLayer = 'explore' | 'express' | 'create'

export interface ToolRunContext {
  botId: string
  threadKey: string
  userId: string
  userName: string
  groupId?: string | null
  messageId?: string
  isGroup: boolean
  solo: boolean
  now: Date
  signal?: AbortSignal
}

export interface ToolRunResult {
  output: string
  /** 折叠进长期历史的极简一行摘要（避免几千字网页/日志反复计费） */
  foldSummary?: string
  isError?: boolean
}

export interface RegisteredTool {
  spec: ToolSpec
  layer: ToolLayer
  execute(args: unknown, ctx: ToolRunContext): Promise<ToolRunResult>
}

export interface ToolRegistry {
  list(layers: ToolLayer[]): ToolSpec[]
  get(name: string): RegisteredTool | undefined
}

// ── 多模态感知与表达端口（TTS / ASR / 唱歌 / 平台传话）──────────────────
export interface TtsSynthRequest {
  text: string
  /** 当下情绪（火山豆包 ICL 2.0 等动态调整语速与 context_texts 语气，neutral/缺省回落至基线） */
  emotion?: AffectKind
  /** 可选自定义语气指令，优先级高于默认情绪映射 */
  tone?: string
  /** 可选额外语速偏移（如深夜犯困 -10），最终会被钳位在安全区间 */
  speechRateDelta?: number
  signal?: AbortSignal
}

export interface TtsPort {
  id: string
  synth(req: TtsSynthRequest): Promise<{ bytes: Uint8Array; mimeType: string }>
}

export interface AsrPort {
  id: string
  transcribe(req: { audio: Uint8Array; filename?: string; mimeType?: string; signal?: AbortSignal }): Promise<string>
}

export interface SingingCreateReq {
  title: string
  lyrics: string
  style?: string
  vocalId?: string
  signal?: AbortSignal
}

export interface SingingPollResult {
  status: 'pending' | 'processing' | 'succeeded' | 'failed'
  audioUrl?: string
  durationSec?: number
  error?: string
}

export interface SingingPort {
  id: string
  createSong(req: SingingCreateReq): Promise<{ taskId: string }>
  pollSong(taskId: string, signal?: AbortSignal): Promise<SingingPollResult>
}

export interface SendTarget {
  messageType: 'private' | 'group'
  userId?: string
  groupId?: string
}

export interface SendPayload {
  type: 'text' | 'image' | 'record'
  text?: string
  url?: string
  instant?: boolean
  mentionUserId?: string | null
}

export interface LightAction {
  kind: 'react' | 'poke'
  messageId?: string
  emojiId?: string
  target: SendTarget
}

export interface IncomingMessage {
  botId: string
  threadKey: string
  messageType: 'private' | 'group'
  userId: string
  userName?: string
  groupId?: string | null
  messageId?: string
  text: string
  atMe?: boolean
  images?: string[]
  mentions?: string[]
  replyTo?: string
  attachments?: Array<{ kind: string; title?: string; url?: string }>
}

export interface TransportPort {
  id: string
  start(): Promise<void>
  send(target: SendTarget, payload: SendPayload): Promise<void>
  act?(action: LightAction): Promise<void>
  dispose(): Promise<void>
}

// ── 灵魂核心领域记录（持久化进 soul.db）────────────────────────────────
export type Sensitivity = 'open' | 'personal' | 'private' | 'critical'
export type MemoryKind = 'experience' | 'fact' | 'concern' | 'insight'
export type RetentionTier = 'fleeting' | 'season' | 'lasting' | 'permanent'
export type Disclosable = 'volunteer' | 'when-asked' | 'secretive'
export type MemoryProvenance = 'L0_external' | 'L1_shared' | 'L2_internal'

export interface StoredMessage {
  id: number
  threadKey: string
  role: 'user' | 'assistant' | 'summary'
  userId: string
  userName: string
  content: string
  toolSummary: string | null
  mediaJson: string | null
  createdAt: string
}

export interface MemoryItem {
  id: string
  kind: MemoryKind
  text: string
  about: string[]
  sensitivity: Sensitivity
  tier: RetentionTier
  disclosable: Disclosable
  consented: boolean
  source: 'private' | 'group' | 'life'
  provenance: MemoryProvenance
  validFrom: string
  validUntil: string | null
  supersededBy: string | null
  threadKey: string
  affect: AffectKind | null
  recallCount: number
  lastRecalledAt: string | null
  createdAt: string
}

export type Feel = 'better+' | 'better++' | 'worse+' | 'worse++' | 'repair' | 'same' | 'unclear'

export interface RelationTension {
  id: string
  source: 'user' | 'self'
  text: string
  topicTag: string
  severity: number // 0.2..1.0，未解心结的严重程度
  debtTrust: number // 原始 trust 扣分绝对值（用于口头 repair 75% 债务封顶）
  debtCloseness: number
  debtValence: number
  repaidRatio: number // 0..0.75
  repeatCount: number // 14 天内同类复发次数
  clearAirAsked?: boolean
  /** 上次完成时间衰减的时间戳（保证同日重复调用严格幂等） */
  lastDecayedAt?: string
  createdAt: string
}

export interface RelationRecord {
  userId: string
  callName: string | null
  customCall: boolean
  type: string
  stage: string
  trust: number
  closeness: number
  valence: number
  disengagement: number // 0..1 慢性情感抽离度
  turns: number
  firstSeen: string | null
  lastSeen: string | null
  feels: Array<{ at: string; feel: Feel; kind: string }>
  streaks: Record<string, { count: number; lastAt: string }>
  windows: Record<string, number>
  tensions: RelationTension[]
}

export type TimeSlot = 'morning' | 'noon' | 'afternoon' | 'evening' | 'night'

export interface ActivityEffects {
  energy?: number
  pad?: Partial<PAD>
  drives?: Record<string, number>
}

export interface ActivityDef {
  id: string
  label: string
  place: string
  times: TimeSlot[]
  durationMin: [number, number]
  yields: 'sight' | 'none'
  effects?: ActivityEffects
  requiresCapability?: string
  source?: string
}

export interface ActiveActivity {
  id: string
  label: string
  place: string
  thinking: string
  thinkingAt: string
  startedAt: string
  endsAt: string
  yields: 'sight' | 'none'
  effects?: ActivityEffects
}

export interface BodyState {
  pad: PAD
  mood: PAD
  drives: Record<string, number>
  energy: number // 0..1，生理精力
  sleepDebt: number // 0..1，睡眠债（深夜未休累积）
  activity: ActiveActivity | null
  /** 持久化 L2 内部每日心境波动限额（跨进程重启不重置） */
  l2MoodDay?: string
  l2MoodDelta?: number
  lastTickAt: string
  updatedAt: string
}

export interface EmotionCause {
  id: number
  source: 'chat' | 'life' | 'desire' | 'awaiting'
  who: string
  text: string
  affectKind: AffectKind
  delta: Partial<PAD>
  createdAt: string
}

export type DesireExit = 'experience' | 'create_work' | 'social' | 'build_skill'
export type DesireStage =
  | 'seed'
  | 'active'
  | 'waiting_credential'
  | 'waiting_approval'
  | 'in_progress'
  | 'fulfilled'
  | 'faded'
  | 'abandoned'

export interface DesireRecord {
  id: string
  source: 'chat' | 'wander' | 'diary' | 'reflect'
  motive: string
  want: string
  why: string
  exitKind: DesireExit
  stage: DesireStage
  spec: Record<string, unknown> | null
  blocker: { kind: 'approval' | 'allow-person' | 'credential'; what: string; payload?: Record<string, unknown> } | null
  strength: number
  thoughtCount: number
  progressNote: string | null
  aboutUser: string | null
  parentId: string | null
  /** 最近一次真实推进时间戳（与 tick 时间分离，防止卡死任务被无限续期 TTL） */
  lastProgressAt?: string
  /** 人工一次性批准后记录的授权版本号，解锁当前任务不受全局 autonomyBuildEnabled 阻挡 */
  approvedPlanVersion?: number
  /** 审批拒绝后的冷静期截止时间 */
  rejectedUntil?: string
  createdAt: string
  updatedAt: string
}

export interface ApprovalRecord {
  id: string
  kind: 'approval' | 'allow-person'
  targetId: string
  what: string
  payload: Record<string, unknown> | null
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  askedAt: string
  expiresAt: string
  resolvedAt: string | null
}

export interface ScheduleRecord {
  id: string
  kind: 'reminder' | 'promise'
  userId: string
  threadKey: string
  text: string
  dueAt: string
  status: 'pending' | 'done' | 'cancelled' | 'expired'
  createdAt: string
}

export interface PendingReply {
  id: number
  userId: string
  userName: string
  threadKey: string
  text: string
  createdAt: string
}

export interface CapabilityRecord {
  name: string
  kind: 'skill' | 'mcp'
  summary: string
  skillDir: string
  status: 'active' | 'disabled' | 'revoked'
  createdAt: string
}

export interface WorkRecord {
  id: string
  kind: 'song' | 'poem' | 'image' | 'note'
  title: string
  content: string
  mediaPath: string | null
  status: 'draft' | 'generating' | 'ready_undelivered' | 'ready' | 'failed'
  externalTaskId: string | null
  forUser: string | null
  moodNote: string | null
  createdAt: string
}

export interface TokenLedgerEntry {
  id?: number
  scene: string
  model: string
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  reasoningTokens: number
  estCostCny: number
  createdAt?: string
}

export interface TraceEntry {
  id?: number
  traceId: string
  event: string
  level: 'info' | 'warn' | 'error'
  data: Record<string, unknown>
  createdAt?: string
}

// ── 统一存储仓储契约（由 src/storage/sqlite-store.ts 实现）──────────────
export interface SoulStore {
  // 对话消息
  appendMessage(msg: Omit<StoredMessage, 'id' | 'createdAt'> & { createdAt?: string }): StoredMessage
  recentMessages(threadKey: string, limit: number): StoredMessage[]
  listThreads(limit?: number): Array<{ threadKey: string; messageCount: number; lastAt: string; lastContent: string }>
  countMessages(threadKey: string): number
  compactOldMessages(threadKey: string, dropCount: number, summaryText: string): void
  lastUserContactAt(userId: string): string | null

  // 记忆池 + FTS5 检索（支持双时态 valid_until 与认知溯源 provenance）
  addMemory(
    item: Omit<MemoryItem, 'id' | 'recallCount' | 'lastRecalledAt' | 'createdAt' | 'provenance' | 'validFrom' | 'validUntil' | 'supersededBy'> & {
      id?: string
      createdAt?: string
      provenance?: MemoryProvenance
      validFrom?: string
      validUntil?: string | null
      supersededBy?: string | null
    },
  ): MemoryItem
  searchMemories(query: string, limit: number): MemoryItem[]
  recentMemories(limit: number): MemoryItem[]
  memoriesAbout(userId: string, limit: number): MemoryItem[]
  touchMemories(ids: string[], at: string): void
  invalidateMemory(id: string, supersededBy: string | null, at: string): boolean
  removeMemory(id: string): boolean

  // 关系
  getRelation(userId: string): RelationRecord | null
  saveRelation(rec: RelationRecord): void
  listRelations(): RelationRecord[]

  // 身心状态与情绪来由
  getBodyState(): BodyState | null
  saveBodyState(state: BodyState): void
  addEmotionCause(cause: Omit<EmotionCause, 'id' | 'createdAt'> & { createdAt?: string }): EmotionCause
  recentEmotionCauses(limit: number): EmotionCause[]

  // 欲望与审批
  upsertDesire(desire: DesireRecord): void
  getDesire(id: string): DesireRecord | null
  listDesires(stages?: DesireStage[]): DesireRecord[]
  pendingApproval(nowIso: string): ApprovalRecord | null
  saveApproval(approval: ApprovalRecord): void
  listApprovals(limit?: number): ApprovalRecord[]

  // 日程与忙时待回
  addSchedule(item: ScheduleRecord): void
  dueSchedules(nowIso: string, kind?: 'reminder' | 'promise'): ScheduleRecord[]
  updateScheduleStatus(id: string, status: ScheduleRecord['status']): void
  addPendingReply(item: Omit<PendingReply, 'id' | 'createdAt'> & { createdAt?: string }): void
  takePendingReplies(): PendingReply[]
  listPendingReplies(): PendingReply[]
  removePendingReply(id: number): boolean

  // 能力与作品
  upsertCapability(cap: CapabilityRecord): void
  listCapabilities(): CapabilityRecord[]
  upsertWork(work: WorkRecord): void
  getWork(id: string): WorkRecord | null
  listWorks(kind?: WorkRecord['kind'], limit?: number): WorkRecord[]
  listWorksByStatus(statuses: WorkRecord['status'][], limit?: number): WorkRecord[]

  // Token 账本与 Trace
  recordTokens(entry: TokenLedgerEntry): void
  tokenStatsSince(sinceIso: string): {
    totalInput: number
    totalCached: number
    totalOutput: number
    totalReasoning: number
    totalCostCny: number
    byScene: Record<string, { calls: number; input: number; cached: number; output: number }>
  }
  tokenDailySeries(days?: number): Array<{ day: string; calls: number; input: number; cached: number; output: number; costCny: number }>
  logTrace(entry: TraceEntry): void
  recentTraces(limit: number): TraceEntry[]

  // 一键清空单 bot 运行记忆（不动人设）
  wipeRuntimeData(): void
  close(): void
}
