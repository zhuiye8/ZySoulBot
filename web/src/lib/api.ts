// 强类型管理后台 API 客户端（自动携带会话 Cookie + X-CSRF-Token）
export interface BotSummary {
  id: string
  name: string
  summary: string
  energy: number
  mood: { p: number; a: number; d: number }
  activity: ActiveActivity | null
  hasTransport: boolean
  hasTts: boolean
  hasSinging: boolean
  activeDesires: number
  pendingTodos: number
}

export interface ActiveActivity {
  id: string
  label: string
  place: string
  thinking: string
  thinkingAt: string
  startedAt: string
  endsAt: string
}

export interface BodyState {
  pad: { p: number; a: number; d: number }
  mood: { p: number; a: number; d: number }
  drives: Record<string, number>
  energy: number
  sleepDebt: number
  activity: ActiveActivity | null
  lastTickAt: string
  updatedAt: string
}

export interface EmotionCause {
  id: number
  source: string
  who: string
  text: string
  affectKind: string
  createdAt: string
}

export interface MemoryItem {
  id: string
  kind: string
  text: string
  about: string[]
  sensitivity: string
  tier: string
  disclosable: string
  source: string
  affect: string | null
  recallCount: number
  createdAt: string
  clarity?: number
}

export interface DesireRecord {
  id: string
  source: string
  motive: string
  want: string
  why: string
  exitKind: string
  stage: string
  strength: number
  thoughtCount: number
  progressNote: string | null
  aboutUser: string | null
  blocker: { kind: string; what: string } | null
  createdAt: string
  updatedAt: string
}

export interface ApprovalRecord {
  id: string
  kind: string
  targetId: string
  what: string
  status: string
  askedAt: string
  expiresAt: string
  resolvedAt: string | null
}

export interface RelationView {
  userId: string
  displayName: string
  callName: string | null
  type: string
  stage: string
  trust: number
  closeness: number
  valence: number
  turns: number
  firstSeen: string | null
  lastSeen: string | null
  lastContactAt: string | null
  sharedStories: Array<{ id: string; text: string; createdAt?: string } | string>
  tensions?: Array<{ id: string; source?: 'user' | 'self'; text: string; severity: number; repeatCount?: number; createdAt: string }>
}

export interface StoredMessage {
  id: number
  threadKey: string
  role: 'user' | 'assistant' | 'summary'
  userId: string
  userName: string
  content: string
  toolSummary: string | null
  createdAt: string
}

export interface WorkItem {
  id: string
  kind: 'song' | 'poem' | 'image' | 'note'
  title: string
  content: string
  mediaPath: string | null
  hasAudio: boolean
  status: 'draft' | 'generating' | 'ready' | 'failed'
  forUser: string | null
  moodNote: string | null
  createdAt: string
}

export interface StickerItem {
  key: string
  file: string
  emotions: string[]
  tags?: string[]
  description?: string
  enabled?: boolean
  uses?: number
}

export interface CapabilityItem {
  name: string
  kind: string
  summary: string
  skillDir: string
  status: 'active' | 'disabled' | 'revoked'
  createdAt: string
  doc: string
}

export interface PublicCredential {
  name: string
  label: string
  provider: string
  providerName?: string
  why?: string
  howto?: string
  fields: Array<{ key: string; label: string; type: 'text' | 'secret'; required: boolean; placeholder?: string }>
  filled: boolean
  filledAt: string | null
  maskedValues: Record<string, string>
}

export interface TraceItem {
  id?: number
  traceId: string
  event: string
  level: 'info' | 'warn' | 'error'
  data: Record<string, unknown>
  createdAt?: string
}

export interface OverviewResponse {
  bot: {
    id: string
    name: string
    summary: string
    proactivityEnabled: boolean
    hasTransport: boolean
    hasTts: boolean
    hasSinging: boolean
  }
  body: BodyState
  bodyFacts: string
  kpis: {
    todayTurns: number
    activeDesires: number
    todayTokens: number
    todayCostCny: number
    cacheHitRate: number
    pendingApprovals: number
    missingCredentials: number
  }
  budget: { allowed: boolean; used: number; limit: number }
  pendingApproval: ApprovalRecord | null
  missingCredentials: PublicCredential[]
  recentCauses: EmotionCause[]
  recentMemories: MemoryItem[]
  recentWorks: WorkItem[]
  recentTraces: TraceItem[]
}

export interface TokenStats {
  totalInput: number
  totalCached: number
  totalOutput: number
  totalReasoning: number
  totalCostCny: number
  byScene: Record<string, { calls: number; input: number; cached: number; output: number }>
}

export interface TokensResponse {
  today: TokenStats
  week: TokenStats
  daily: Array<{ day: string; calls: number; input: number; cached: number; output: number; costCny: number }>
  budget: { allowed: boolean; used: number; limit: number }
}

let csrfToken = ''

export function setCsrfToken(token: string): void {
  csrfToken = token
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const method = (init.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD' && csrfToken) {
    headers.set('X-CSRF-Token', csrfToken)
  }
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const res = await fetch(path, { ...init, headers, credentials: 'include' })
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string }
    throw new Error(errBody.error || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  me: () => request<{ authenticated: boolean; csrf?: string }>('/api/me'),
  login: (password: string) => request<{ ok: boolean; csrf: string }>('/api/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request<{ ok: boolean }>('/api/logout', { method: 'POST' }),
  changePassword: (currentPassword: string, nextPassword: string) =>
    request<{ ok: boolean; csrf: string }>('/api/password', { method: 'POST', body: JSON.stringify({ currentPassword, nextPassword }) }),

  bots: () => request<{ bots: BotSummary[] }>('/api/bots'),
  overview: (id: string) => request<OverviewResponse>(`/api/bots/${encodeURIComponent(id)}/overview`),
  body: (id: string) => request<{ state: BodyState; facts: string; causes: EmotionCause[] }>(`/api/bots/${encodeURIComponent(id)}/body`),
  desires: (id: string) => request<{ desires: DesireRecord[] }>(`/api/bots/${encodeURIComponent(id)}/desires`),
  desireOp: (id: string, did: string, op: 'boost' | 'abandon' | 'resume') =>
    request<{ ok: boolean; desire: DesireRecord }>(`/api/bots/${encodeURIComponent(id)}/desires/${encodeURIComponent(did)}/${op}`, { method: 'POST' }),
  diary: (id: string, date?: string) =>
    request<{ dates: string[]; activeDate: string | null; content: string | null }>(
      `/api/bots/${encodeURIComponent(id)}/diary${date ? `?date=${encodeURIComponent(date)}` : ''}`,
    ),
  approvals: (id: string) => request<{ pending: ApprovalRecord | null; history: ApprovalRecord[] }>(`/api/bots/${encodeURIComponent(id)}/approvals`),
  approvalOp: (id: string, aid: string, op: 'approve' | 'reject') =>
    request<{ ok: boolean; status: string }>(`/api/bots/${encodeURIComponent(id)}/approvals/${encodeURIComponent(aid)}/${op}`, { method: 'POST' }),

  memories: (id: string, q = '') =>
    request<{ query: string; items: MemoryItem[] }>(`/api/bots/${encodeURIComponent(id)}/memories?q=${encodeURIComponent(q)}&limit=80`),
  deleteMemory: (id: string, mid: string) =>
    request<{ ok: boolean }>(`/api/bots/${encodeURIComponent(id)}/memories/${encodeURIComponent(mid)}`, { method: 'DELETE' }),
  relations: (id: string) => request<{ relations: RelationView[] }>(`/api/bots/${encodeURIComponent(id)}/relations`),
  threads: (id: string) =>
    request<{ threads: Array<{ threadKey: string; messageCount: number; lastAt: string; lastContent: string }> }>(`/api/bots/${encodeURIComponent(id)}/threads`),
  messages: (id: string, threadKey: string) =>
    request<{ threadKey: string; messages: StoredMessage[] }>(`/api/bots/${encodeURIComponent(id)}/messages?threadKey=${encodeURIComponent(threadKey)}&limit=100`),
  wipe: (id: string, confirm: string) =>
    request<{ ok: boolean }>(`/api/bots/${encodeURIComponent(id)}/wipe`, { method: 'POST', body: JSON.stringify({ confirm }) }),

  works: (id: string) => request<{ works: WorkItem[]; hasSinging: boolean; hasTts: boolean }>(`/api/bots/${encodeURIComponent(id)}/works`),
  stickers: (id: string) => request<{ enabled: boolean; items: StickerItem[] }>(`/api/bots/${encodeURIComponent(id)}/stickers`),
  uploadSticker: (id: string, form: FormData) =>
    request<{ ok: boolean; sticker: StickerItem }>(`/api/bots/${encodeURIComponent(id)}/stickers`, { method: 'POST', body: form }),
  deleteSticker: (id: string, key: string) =>
    request<{ ok: boolean }>(`/api/bots/${encodeURIComponent(id)}/stickers/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  ttsPreviewBlob: async (id: string, text: string, opts?: { emotion?: string; tone?: string }): Promise<Blob> => {
    const res = await fetch(`/api/bots/${encodeURIComponent(id)}/tts/preview`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({
        text,
        ...(opts?.emotion ? { emotion: opts.emotion } : {}),
        ...(opts?.tone?.trim() ? { tone: opts.tone.trim() } : {}),
      }),
    })
    if (!res.ok) {
      const e = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string }
      throw new Error(e.error || `HTTP ${res.status}`)
    }
    return res.blob()
  },

  persona: (id: string) =>
    request<{ name: string; summary: string; staticPromptChars: number; activityCount: number; files: Record<string, string> }>(
      `/api/bots/${encodeURIComponent(id)}/persona`,
    ),
  savePersonaFile: (id: string, file: string, content: string) =>
    request<{ ok: boolean; staticPromptChars: number; activityCount: number }>(`/api/bots/${encodeURIComponent(id)}/persona`, {
      method: 'PUT',
      body: JSON.stringify({ file, content }),
    }),
  capabilities: (id: string) => request<{ capabilities: CapabilityItem[] }>(`/api/bots/${encodeURIComponent(id)}/capabilities`),
  toggleCapability: (id: string, name: string, status: 'active' | 'disabled') =>
    request<{ ok: boolean }>(`/api/bots/${encodeURIComponent(id)}/capabilities/${encodeURIComponent(name)}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    }),
  credentials: (id: string) => request<{ credentials: PublicCredential[] }>(`/api/bots/${encodeURIComponent(id)}/credentials`),
  fillCredential: (id: string, name: string, values: Record<string, string>) =>
    request<{ ok: boolean; resumedDesireIds: string[] }>(`/api/bots/${encodeURIComponent(id)}/credentials/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ values }),
    }),
  deleteCredential: (id: string, name: string) =>
    request<{ ok: boolean }>(`/api/bots/${encodeURIComponent(id)}/credentials/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  tokens: (id: string) => request<TokensResponse>(`/api/bots/${encodeURIComponent(id)}/tokens`),
  traces: (id: string, limit = 100) => request<{ traces: TraceItem[] }>(`/api/bots/${encodeURIComponent(id)}/traces?limit=${limit}`),
}
