// 每 bot 单库 soul.db（Node 24 内置 node:sqlite，WAL + FTS5）。
// 唯一权威结构化事实源：对话历史、记忆、关系、身心、欲望、审批、日程、能力、作品、Token 账本、Trace。
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { nowLocal } from '../shared/time.ts'
import type {
  AffectKind,
  ApprovalRecord,
  BodyState,
  CapabilityRecord,
  DesireRecord,
  DesireStage,
  EmotionCause,
  MemoryItem,
  PendingReply,
  RelationRecord,
  ScheduleRecord,
  SoulStore,
  StoredMessage,
  TokenLedgerEntry,
  TraceEntry,
  WorkRecord,
} from '../shared/ports.ts'

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_key TEXT NOT NULL,
  role TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_summary TEXT,
  media_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_key, id);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, created_at);

CREATE TABLE IF NOT EXISTS memories (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  about_json TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  tier TEXT NOT NULL,
  disclosable TEXT NOT NULL,
  consented INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  provenance TEXT NOT NULL DEFAULT 'L1_shared',
  valid_from TEXT,
  valid_until TEXT,
  superseded_by TEXT,
  thread_key TEXT NOT NULL,
  affect TEXT,
  recall_count INTEGER NOT NULL DEFAULT 0,
  last_recalled_at TEXT,
  embedding_blob BLOB,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  text,
  content='memories',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF text ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE IF NOT EXISTS relations (
  user_id TEXT PRIMARY KEY,
  call_name TEXT,
  custom_call INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL,
  stage TEXT NOT NULL,
  trust REAL NOT NULL,
  closeness REAL NOT NULL,
  valence REAL NOT NULL,
  disengagement REAL NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT,
  last_seen TEXT,
  feels_json TEXT NOT NULL,
  streaks_json TEXT NOT NULL,
  windows_json TEXT NOT NULL,
  tensions_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS body_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  pad_json TEXT NOT NULL,
  mood_json TEXT NOT NULL,
  drives_json TEXT NOT NULL,
  energy REAL NOT NULL,
  sleep_debt REAL NOT NULL,
  activity_json TEXT,
  l2_mood_day TEXT,
  l2_mood_delta REAL NOT NULL DEFAULT 0,
  last_tick_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS emotion_causes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  who TEXT NOT NULL,
  text TEXT NOT NULL,
  affect_kind TEXT NOT NULL,
  delta_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS desires (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  motive TEXT NOT NULL,
  want TEXT NOT NULL,
  why TEXT NOT NULL,
  exit_kind TEXT NOT NULL,
  stage TEXT NOT NULL,
  spec_json TEXT,
  blocker_json TEXT,
  strength REAL NOT NULL,
  thought_count INTEGER NOT NULL DEFAULT 1,
  progress_note TEXT,
  about_user TEXT,
  parent_id TEXT,
  last_progress_at TEXT,
  approved_plan_version INTEGER,
  rejected_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  what TEXT NOT NULL,
  payload_json TEXT,
  status TEXT NOT NULL,
  asked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS schedule (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  user_id TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  text TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedule_due ON schedule(status, due_at);

CREATE TABLE IF NOT EXISTS pending_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capabilities (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  skill_dir TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS works (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  media_path TEXT,
  status TEXT NOT NULL,
  external_task_id TEXT,
  for_user TEXT,
  mood_note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS token_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  est_cost_cny REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_created ON token_ledger(created_at);

CREATE TABLE IF NOT EXISTS traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  event TEXT NOT NULL,
  level TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_traces_created ON traces(id DESC);
`

function safeParseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function rowToMemory(r: Record<string, unknown>): MemoryItem {
  const createdAt = String(r.created_at)
  const rawProv = String(r.provenance ?? '')
  const provenance: MemoryItem['provenance'] = rawProv === 'L0_external' || rawProv === 'L1_shared' || rawProv === 'L2_internal'
    ? rawProv
    : (String(r.source) === 'life' ? 'L2_internal' : 'L1_shared')
  return {
    id: String(r.id),
    kind: String(r.kind) as MemoryItem['kind'],
    text: String(r.text),
    about: safeParseJson<string[]>(r.about_json, []),
    sensitivity: String(r.sensitivity) as MemoryItem['sensitivity'],
    tier: String(r.tier) as MemoryItem['tier'],
    disclosable: String(r.disclosable) as MemoryItem['disclosable'],
    consented: Number(r.consented) === 1,
    source: String(r.source) as MemoryItem['source'],
    provenance,
    validFrom: r.valid_from ? String(r.valid_from) : createdAt,
    validUntil: r.valid_until ? String(r.valid_until) : null,
    supersededBy: r.superseded_by ? String(r.superseded_by) : null,
    threadKey: String(r.thread_key),
    affect: r.affect ? (String(r.affect) as AffectKind) : null,
    recallCount: Number(r.recall_count ?? 0),
    lastRecalledAt: r.last_recalled_at ? String(r.last_recalled_at) : null,
    createdAt,
  }
}

function rowToMessage(r: Record<string, unknown>): StoredMessage {
  return {
    id: Number(r.id),
    threadKey: String(r.thread_key),
    role: String(r.role) as StoredMessage['role'],
    userId: String(r.user_id),
    userName: String(r.user_name),
    content: String(r.content),
    toolSummary: r.tool_summary ? String(r.tool_summary) : null,
    mediaJson: r.media_json ? String(r.media_json) : null,
    createdAt: String(r.created_at),
  }
}

export class SqliteSoulStore implements SoulStore {
  private db: DatabaseSync
  readonly dbPath: string

  constructor(dbPath: string) {
    this.dbPath = dbPath
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true })
    }
    this.db = new DatabaseSync(dbPath)
    this.db.exec(SCHEMA_SQL)
    // 平滑迁移已存在的旧版 soul.db（幂等补列，零数据丢失）
    const relCols = this.db.prepare('PRAGMA table_info(relations)').all() as Array<{ name?: string }>
    if (!relCols.some((c) => c.name === 'tensions_json')) {
      this.db.exec('ALTER TABLE relations ADD COLUMN tensions_json TEXT NOT NULL DEFAULT \'[]\'')
    }
    if (!relCols.some((c) => c.name === 'disengagement')) {
      this.db.exec('ALTER TABLE relations ADD COLUMN disengagement REAL NOT NULL DEFAULT 0')
    }
    const memCols = this.db.prepare('PRAGMA table_info(memories)').all() as Array<{ name?: string }>
    if (!memCols.some((c) => c.name === 'provenance')) {
      this.db.exec('ALTER TABLE memories ADD COLUMN provenance TEXT NOT NULL DEFAULT \'L1_shared\'')
    }
    if (!memCols.some((c) => c.name === 'valid_from')) {
      this.db.exec('ALTER TABLE memories ADD COLUMN valid_from TEXT')
    }
    if (!memCols.some((c) => c.name === 'valid_until')) {
      this.db.exec('ALTER TABLE memories ADD COLUMN valid_until TEXT')
    }
    if (!memCols.some((c) => c.name === 'superseded_by')) {
      this.db.exec('ALTER TABLE memories ADD COLUMN superseded_by TEXT')
    }

    const bodyCols = this.db.prepare('PRAGMA table_info(body_state)').all() as Array<{ name?: string }>
    if (!bodyCols.some((c) => c.name === 'l2_mood_day')) {
      this.db.exec('ALTER TABLE body_state ADD COLUMN l2_mood_day TEXT')
    }
    if (!bodyCols.some((c) => c.name === 'l2_mood_delta')) {
      this.db.exec('ALTER TABLE body_state ADD COLUMN l2_mood_delta REAL NOT NULL DEFAULT 0')
    }

    const desireCols = this.db.prepare('PRAGMA table_info(desires)').all() as Array<{ name?: string }>
    if (!desireCols.some((c) => c.name === 'last_progress_at')) {
      this.db.exec('ALTER TABLE desires ADD COLUMN last_progress_at TEXT')
    }
    if (!desireCols.some((c) => c.name === 'approved_plan_version')) {
      this.db.exec('ALTER TABLE desires ADD COLUMN approved_plan_version INTEGER')
    }
    if (!desireCols.some((c) => c.name === 'rejected_until')) {
      this.db.exec('ALTER TABLE desires ADD COLUMN rejected_until TEXT')
    }

    // P1-MEM-01 版本化一次性迁移：旧版 source='life' 的随想/反思记忆回填为 L2_internal（不改动显式 L0_external 作品）
    const uvRow = this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    const userVersion = Number(uvRow?.user_version ?? 0)
    if (userVersion < 2) {
      this.db.exec('BEGIN')
      try {
        this.db.prepare(
          `UPDATE memories SET provenance = 'L2_internal'
           WHERE source = 'life' AND provenance = 'L1_shared'`,
        ).run()
        this.db.exec('PRAGMA user_version = 2')
        this.db.exec('COMMIT')
      } catch (e) {
        this.db.exec('ROLLBACK')
        throw e
      }
    }
  }

  // ── 对话消息 ────────────────────────────────────────────────────────
  appendMessage(msg: Omit<StoredMessage, 'id' | 'createdAt'> & { createdAt?: string }): StoredMessage {
    const createdAt = msg.createdAt ?? nowLocal()
    const stmt = this.db.prepare(
      `INSERT INTO messages (thread_key, role, user_id, user_name, content, tool_summary, media_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const info = stmt.run(
      msg.threadKey,
      msg.role,
      msg.userId,
      msg.userName,
      msg.content,
      msg.toolSummary,
      msg.mediaJson,
      createdAt,
    )
    return {
      id: Number(info.lastInsertRowid),
      threadKey: msg.threadKey,
      role: msg.role,
      userId: msg.userId,
      userName: msg.userName,
      content: msg.content,
      toolSummary: msg.toolSummary,
      mediaJson: msg.mediaJson,
      createdAt,
    }
  }

  recentMessages(threadKey: string, limit: number): StoredMessage[] {
    const rows = this.db.prepare(
      `SELECT * FROM (
         SELECT * FROM messages WHERE thread_key = ? ORDER BY id DESC LIMIT ?
       ) ORDER BY id ASC`,
    ).all(threadKey, limit) as Array<Record<string, unknown>>
    return rows.map(rowToMessage)
  }

  listThreads(limit = 50): Array<{ threadKey: string; messageCount: number; lastAt: string; lastContent: string }> {
    const rows = this.db.prepare(
      `SELECT m.thread_key, stats.cnt, m.created_at, m.content
       FROM messages m
       JOIN (
         SELECT thread_key, COUNT(*) AS cnt, MAX(id) AS max_id
         FROM messages
         GROUP BY thread_key
       ) stats ON m.id = stats.max_id
       ORDER BY m.id DESC
       LIMIT ?`,
    ).all(limit) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      threadKey: String(r.thread_key),
      messageCount: Number(r.cnt ?? 0),
      lastAt: String(r.created_at),
      lastContent: String(r.content),
    }))
  }

  countMessages(threadKey: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS cnt FROM messages WHERE thread_key = ?').get(threadKey) as { cnt?: number } | undefined
    return Number(row?.cnt ?? 0)
  }

  // 按块裁剪最老的 dropCount 条消息，并插入 1 条 summary 锚点，确保对话窗口前缀缓存稳定。
  compactOldMessages(threadKey: string, dropCount: number, summaryText: string): void {
    const oldest = this.db.prepare(
      'SELECT id, created_at FROM messages WHERE thread_key = ? ORDER BY id ASC LIMIT ?',
    ).all(threadKey, dropCount) as Array<{ id: number; created_at: string }>
    if (oldest.length === 0) return
    const maxId = oldest[oldest.length - 1]!.id
    const anchorTime = oldest[oldest.length - 1]!.created_at
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM messages WHERE thread_key = ? AND id <= ?').run(threadKey, maxId)
      if (summaryText.trim()) {
        // 用原 maxId 回插 summary，保证时间顺序仍排在较新消息之前
        this.db.prepare(
          `INSERT INTO messages (id, thread_key, role, user_id, user_name, content, tool_summary, media_json, created_at)
           VALUES (?, ?, 'summary', 'system', '梗概', ?, NULL, NULL, ?)`,
        ).run(maxId, threadKey, summaryText.trim(), anchorTime)
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  lastUserContactAt(userId: string): string | null {
    const row = this.db.prepare(
      'SELECT created_at FROM messages WHERE role = \'user\' AND user_id = ? ORDER BY id DESC LIMIT 1',
    ).get(userId) as { created_at?: string } | undefined
    return row?.created_at ?? null
  }

  // ── 记忆池 + FTS5 检索（支持双时态 valid_until + 认知溯源 + 2 字中文并行补查）───
  addMemory(
    item: Omit<MemoryItem, 'id' | 'recallCount' | 'lastRecalledAt' | 'createdAt' | 'provenance' | 'validFrom' | 'validUntil' | 'supersededBy'> & {
      id?: string
      createdAt?: string
      provenance?: MemoryItem['provenance']
      validFrom?: string
      validUntil?: string | null
      supersededBy?: string | null
    },
  ): MemoryItem {
    const id = item.id ?? `m_${randomUUID().slice(0, 12)}`
    const createdAt = item.createdAt ?? nowLocal()
    const provenance: MemoryItem['provenance'] = item.provenance ?? (item.source === 'life' ? 'L2_internal' : 'L1_shared')
    const validFrom = item.validFrom ?? createdAt
    const validUntil = item.validUntil ?? null
    const supersededBy = item.supersededBy ?? null
    this.db.prepare(
      `INSERT INTO memories (
         id, kind, text, about_json, sensitivity, tier, disclosable, consented,
         source, provenance, valid_from, valid_until, superseded_by,
         thread_key, affect, recall_count, last_recalled_at, created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
    ).run(
      id,
      item.kind,
      item.text,
      JSON.stringify(item.about),
      item.sensitivity,
      item.tier,
      item.disclosable,
      item.consented ? 1 : 0,
      item.source,
      provenance,
      validFrom,
      validUntil,
      supersededBy,
      item.threadKey,
      item.affect,
      createdAt,
    )
    return {
      ...item,
      id,
      provenance,
      validFrom,
      validUntil,
      supersededBy,
      recallCount: 0,
      lastRecalledAt: null,
      createdAt,
    }
  }

  searchMemories(query: string, limit: number): MemoryItem[] {
    const clean = query.replace(/["'()*^:[\]{}，。！？、,.!?；;：:（）()]/g, ' ').trim()
    if (!clean) return this.recentMemories(limit)

    const rawTokens = clean.split(/\s+/).filter(Boolean)
    const ftsTokens = rawTokens.filter((t) => t.length >= 3).slice(0, 6)
    const twoCharTokens = rawTokens.filter((t) => t.length === 2).slice(0, 6)

    const ftsHits: MemoryItem[] = []
    if (ftsTokens.length > 0) {
      const ftsQuery = ftsTokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ')
      try {
        const rows = this.db.prepare(
          `SELECT m.* FROM memories m
           JOIN memories_fts f ON m.rowid = f.rowid
           WHERE memories_fts MATCH ? AND m.valid_until IS NULL
           ORDER BY bm25(memories_fts) ASC
           LIMIT ?`,
        ).all(ftsQuery, limit) as Array<Record<string, unknown>>
        for (const r of rows) ftsHits.push(rowToMemory(r))
      } catch {
        // FTS5 语法异常时由下方 LIKE 兜底，不中断查询
      }
    }

    // P0-4：只要查询包含 2 字核心词（如“咖啡”“熬夜”“考研”），无论 FTS5 是否满额都并行补查并交错融合，
    // 绝不因 3 字弱命中把 2 字核心实词挤掉！
    const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&')
    const likeHits: MemoryItem[] = []
    const likeTokens = twoCharTokens.length > 0
      ? twoCharTokens
      : (ftsHits.length < limit ? rawTokens.filter((t) => t.length >= 2).slice(0, 4) : [])
    for (const tok of likeTokens) {
      const rows = this.db.prepare(
        "SELECT * FROM memories WHERE valid_until IS NULL AND text LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?",
      ).all(`%${escapeLike(tok)}%`, Math.max(4, Math.ceil(limit / 2))) as Array<Record<string, unknown>>
      for (const r of rows) likeHits.push(rowToMemory(r))
    }

    // 交错去重合并（2 字直接命中与 FTS5 命中轮流入选）
    const merged = new Map<string, MemoryItem>()
    const maxLen = Math.max(ftsHits.length, likeHits.length)
    for (let i = 0; i < maxLen && merged.size < limit; i++) {
      const a = likeHits[i]
      if (a && !merged.has(a.id)) merged.set(a.id, a)
      if (merged.size >= limit) break
      const b = ftsHits[i]
      if (b && !merged.has(b.id)) merged.set(b.id, b)
    }

    return [...merged.values()].slice(0, limit)
  }

  recentMemories(limit: number): MemoryItem[] {
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE valid_until IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?',
    ).all(limit) as Array<Record<string, unknown>>
    return rows.map(rowToMemory)
  }

  memoriesAbout(userId: string, limit: number): MemoryItem[] {
    // about_json 为 JSON 数组，精确匹配引号内 userId 避免子串误中
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE valid_until IS NULL AND about_json LIKE ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    ).all(`%"${userId}"%`, limit) as Array<Record<string, unknown>>
    return rows.map(rowToMemory)
  }

  invalidateMemory(id: string, supersededBy: string | null, at: string): boolean {
    const info = this.db.prepare(
      'UPDATE memories SET valid_until = ?, superseded_by = ? WHERE id = ? AND valid_until IS NULL',
    ).run(at, supersededBy, id)
    return Number(info.changes) > 0
  }

  touchMemories(ids: string[], at: string): void {
    if (ids.length === 0) return
    const stmt = this.db.prepare(
      'UPDATE memories SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id = ?',
    )
    this.db.exec('BEGIN')
    try {
      for (const id of ids) stmt.run(at, id)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  removeMemory(id: string): boolean {
    const info = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    return Number(info.changes) > 0
  }

  // ── 关系 ────────────────────────────────────────────────────────────
  getRelation(userId: string): RelationRecord | null {
    const r = this.db.prepare('SELECT * FROM relations WHERE user_id = ?').get(userId) as Record<string, unknown> | undefined
    if (!r) return null
    return {
      userId: String(r.user_id),
      callName: r.call_name ? String(r.call_name) : null,
      customCall: Number(r.custom_call) === 1,
      type: String(r.type),
      stage: String(r.stage),
      trust: Number(r.trust),
      closeness: Number(r.closeness),
      valence: Number(r.valence),
      disengagement: Number(r.disengagement ?? 0),
      turns: Number(r.turns),
      firstSeen: r.first_seen ? String(r.first_seen) : null,
      lastSeen: r.last_seen ? String(r.last_seen) : null,
      feels: safeParseJson<RelationRecord['feels']>(r.feels_json, []),
      streaks: safeParseJson<RelationRecord['streaks']>(r.streaks_json, {}),
      windows: safeParseJson<RelationRecord['windows']>(r.windows_json, {}),
      tensions: safeParseJson<RelationRecord['tensions']>(r.tensions_json, []),
    }
  }

  saveRelation(rec: RelationRecord): void {
    this.db.prepare(
      `INSERT INTO relations (user_id, call_name, custom_call, type, stage, trust, closeness, valence, disengagement, turns, first_seen, last_seen, feels_json, streaks_json, windows_json, tensions_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         call_name=excluded.call_name, custom_call=excluded.custom_call, type=excluded.type,
         stage=excluded.stage, trust=excluded.trust, closeness=excluded.closeness, valence=excluded.valence,
         disengagement=excluded.disengagement,
         turns=excluded.turns, first_seen=excluded.first_seen, last_seen=excluded.last_seen,
         feels_json=excluded.feels_json, streaks_json=excluded.streaks_json, windows_json=excluded.windows_json,
         tensions_json=excluded.tensions_json`,
    ).run(
      rec.userId,
      rec.callName,
      rec.customCall ? 1 : 0,
      rec.type,
      rec.stage,
      rec.trust,
      rec.closeness,
      rec.valence,
      rec.disengagement ?? 0,
      rec.turns,
      rec.firstSeen,
      rec.lastSeen,
      JSON.stringify(rec.feels),
      JSON.stringify(rec.streaks),
      JSON.stringify(rec.windows),
      JSON.stringify(rec.tensions ?? []),
    )
  }

  listRelations(): RelationRecord[] {
    const rows = this.db.prepare('SELECT user_id FROM relations ORDER BY turns DESC').all() as Array<{ user_id: string }>
    return rows.map((r) => this.getRelation(r.user_id)).filter((x): x is RelationRecord => x !== null)
  }

  // ── 身心状态与情绪来由 ──────────────────────────────────────────────
  getBodyState(): BodyState | null {
    const r = this.db.prepare('SELECT * FROM body_state WHERE singleton = 1').get() as Record<string, unknown> | undefined
    if (!r) return null
    return {
      pad: safeParseJson(r.pad_json, { p: 0.2, a: -0.1, d: 0.1 }),
      mood: safeParseJson(r.mood_json, { p: 0.2, a: -0.1, d: 0.1 }),
      drives: safeParseJson(r.drives_json, { companionship: 0.5, curiosity: 0.78, creative: 0.72 }),
      energy: Number(r.energy),
      sleepDebt: Number(r.sleep_debt),
      activity: safeParseJson(r.activity_json, null),
      l2MoodDay: r.l2_mood_day ? String(r.l2_mood_day) : undefined,
      l2MoodDelta: typeof r.l2_mood_delta === 'number' ? r.l2_mood_delta : Number(r.l2_mood_delta ?? 0),
      lastTickAt: String(r.last_tick_at),
      updatedAt: String(r.updated_at),
    }
  }

  saveBodyState(state: BodyState): void {
    this.db.prepare(
      `INSERT INTO body_state (singleton, pad_json, mood_json, drives_json, energy, sleep_debt, activity_json, l2_mood_day, l2_mood_delta, last_tick_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         pad_json=excluded.pad_json, mood_json=excluded.mood_json, drives_json=excluded.drives_json,
         energy=excluded.energy, sleep_debt=excluded.sleep_debt, activity_json=excluded.activity_json,
         l2_mood_day=excluded.l2_mood_day, l2_mood_delta=excluded.l2_mood_delta,
         last_tick_at=excluded.last_tick_at, updated_at=excluded.updated_at`,
    ).run(
      JSON.stringify(state.pad),
      JSON.stringify(state.mood),
      JSON.stringify(state.drives),
      state.energy,
      state.sleepDebt,
      state.activity ? JSON.stringify(state.activity) : null,
      state.l2MoodDay ?? null,
      state.l2MoodDelta ?? 0,
      state.lastTickAt,
      state.updatedAt,
    )
  }

  addEmotionCause(cause: Omit<EmotionCause, 'id' | 'createdAt'> & { createdAt?: string }): EmotionCause {
    const createdAt = cause.createdAt ?? nowLocal()
    const info = this.db.prepare(
      `INSERT INTO emotion_causes (source, who, text, affect_kind, delta_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(cause.source, cause.who, cause.text, cause.affectKind, JSON.stringify(cause.delta), createdAt)
    // 只保留最近 50 条来由，避免表无限增长
    this.db.prepare('DELETE FROM emotion_causes WHERE id NOT IN (SELECT id FROM emotion_causes ORDER BY id DESC LIMIT 50)').run()
    return {
      id: Number(info.lastInsertRowid),
      source: cause.source,
      who: cause.who,
      text: cause.text,
      affectKind: cause.affectKind,
      delta: cause.delta,
      createdAt,
    }
  }

  recentEmotionCauses(limit: number): EmotionCause[] {
    const rows = this.db.prepare(
      'SELECT * FROM (SELECT * FROM emotion_causes ORDER BY id DESC LIMIT ?) ORDER BY id ASC',
    ).all(limit) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      id: Number(r.id),
      source: String(r.source) as EmotionCause['source'],
      who: String(r.who),
      text: String(r.text),
      affectKind: String(r.affect_kind) as AffectKind,
      delta: safeParseJson(r.delta_json, {}),
      createdAt: String(r.created_at),
    }))
  }

  // ── 欲望与唯一审批 ──────────────────────────────────────────────────
  upsertDesire(d: DesireRecord): void {
    this.db.prepare(
      `INSERT INTO desires (id, source, motive, want, why, exit_kind, stage, spec_json, blocker_json, strength, thought_count, progress_note, about_user, parent_id, last_progress_at, approved_plan_version, rejected_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         motive=excluded.motive, want=excluded.want, why=excluded.why, exit_kind=excluded.exit_kind,
         stage=excluded.stage, spec_json=excluded.spec_json, blocker_json=excluded.blocker_json,
         strength=excluded.strength, thought_count=excluded.thought_count, progress_note=excluded.progress_note,
         about_user=excluded.about_user, parent_id=excluded.parent_id,
         last_progress_at=excluded.last_progress_at, approved_plan_version=excluded.approved_plan_version,
         rejected_until=excluded.rejected_until, updated_at=excluded.updated_at`,
    ).run(
      d.id, d.source, d.motive, d.want, d.why, d.exitKind, d.stage,
      d.spec ? JSON.stringify(d.spec) : null,
      d.blocker ? JSON.stringify(d.blocker) : null,
      d.strength, d.thoughtCount, d.progressNote, d.aboutUser, d.parentId,
      d.lastProgressAt ?? null,
      d.approvedPlanVersion ?? null,
      d.rejectedUntil ?? null,
      d.createdAt, d.updatedAt,
    )
  }

  getDesire(id: string): DesireRecord | null {
    const r = this.db.prepare('SELECT * FROM desires WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? this.rowToDesire(r) : null
  }

  listDesires(stages?: DesireStage[]): DesireRecord[] {
    if (!stages || stages.length === 0) {
      const rows = this.db.prepare('SELECT * FROM desires ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>
      return rows.map((r) => this.rowToDesire(r))
    }
    const placeholders = stages.map(() => '?').join(',')
    const rows = this.db.prepare(`SELECT * FROM desires WHERE stage IN (${placeholders}) ORDER BY strength DESC`).all(...stages) as Array<Record<string, unknown>>
    return rows.map((r) => this.rowToDesire(r))
  }

  private rowToDesire(r: Record<string, unknown>): DesireRecord {
    return {
      id: String(r.id),
      source: String(r.source) as DesireRecord['source'],
      motive: String(r.motive),
      want: String(r.want),
      why: String(r.why),
      exitKind: String(r.exit_kind) as DesireRecord['exitKind'],
      stage: String(r.stage) as DesireRecord['stage'],
      spec: safeParseJson(r.spec_json, null),
      blocker: safeParseJson(r.blocker_json, null),
      strength: Number(r.strength),
      thoughtCount: Number(r.thought_count),
      progressNote: r.progress_note ? String(r.progress_note) : null,
      aboutUser: r.about_user ? String(r.about_user) : null,
      parentId: r.parent_id ? String(r.parent_id) : null,
      lastProgressAt: r.last_progress_at ? String(r.last_progress_at) : undefined,
      approvedPlanVersion: typeof r.approved_plan_version === 'number' ? r.approved_plan_version : undefined,
      rejectedUntil: r.rejected_until ? String(r.rejected_until) : undefined,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }
  }

  pendingApproval(nowIso: string): ApprovalRecord | null {
    this.db.prepare('UPDATE approvals SET status = \'expired\' WHERE status = \'pending\' AND expires_at <= ?').run(nowIso)
    const r = this.db.prepare('SELECT * FROM approvals WHERE status = \'pending\' ORDER BY asked_at ASC LIMIT 1').get() as Record<string, unknown> | undefined
    if (!r) return null
    return {
      id: String(r.id),
      kind: String(r.kind) as ApprovalRecord['kind'],
      targetId: String(r.target_id),
      what: String(r.what),
      payload: safeParseJson(r.payload_json, null),
      status: String(r.status) as ApprovalRecord['status'],
      askedAt: String(r.asked_at),
      expiresAt: String(r.expires_at),
      resolvedAt: r.resolved_at ? String(r.resolved_at) : null,
    }
  }

  saveApproval(a: ApprovalRecord): void {
    this.db.prepare(
      `INSERT INTO approvals (id, kind, target_id, what, payload_json, status, asked_at, expires_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, resolved_at=excluded.resolved_at, expires_at=excluded.expires_at`,
    ).run(a.id, a.kind, a.targetId, a.what, a.payload ? JSON.stringify(a.payload) : null, a.status, a.askedAt, a.expiresAt, a.resolvedAt)
  }

  listApprovals(limit = 30): ApprovalRecord[] {
    const rows = this.db.prepare('SELECT * FROM approvals ORDER BY asked_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      id: String(r.id),
      kind: String(r.kind) as ApprovalRecord['kind'],
      targetId: String(r.target_id),
      what: String(r.what),
      payload: safeParseJson(r.payload_json, null),
      status: String(r.status) as ApprovalRecord['status'],
      askedAt: String(r.asked_at),
      expiresAt: String(r.expires_at),
      resolvedAt: r.resolved_at ? String(r.resolved_at) : null,
    }))
  }

  // ── 日程与忙时待回 ──────────────────────────────────────────────────
  addSchedule(item: ScheduleRecord): void {
    this.db.prepare(
      `INSERT INTO schedule (id, kind, user_id, thread_key, text, due_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(item.id, item.kind, item.userId, item.threadKey, item.text, item.dueAt, item.status, item.createdAt)
  }

  dueSchedules(nowIso: string, kind?: 'reminder' | 'promise'): ScheduleRecord[] {
    const sql = kind
      ? 'SELECT * FROM schedule WHERE status = \'pending\' AND kind = ? AND due_at <= ? ORDER BY due_at ASC'
      : 'SELECT * FROM schedule WHERE status = \'pending\' AND due_at <= ? ORDER BY due_at ASC'
    const rows = (kind ? this.db.prepare(sql).all(kind, nowIso) : this.db.prepare(sql).all(nowIso)) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      id: String(r.id),
      kind: String(r.kind) as ScheduleRecord['kind'],
      userId: String(r.user_id),
      threadKey: String(r.thread_key),
      text: String(r.text),
      dueAt: String(r.due_at),
      status: String(r.status) as ScheduleRecord['status'],
      createdAt: String(r.created_at),
    }))
  }

  updateScheduleStatus(id: string, status: ScheduleRecord['status']): void {
    this.db.prepare('UPDATE schedule SET status = ? WHERE id = ?').run(status, id)
  }

  addPendingReply(item: Omit<PendingReply, 'id' | 'createdAt'> & { createdAt?: string }): void {
    const createdAt = item.createdAt ?? nowLocal()
    const existing = this.db.prepare(
      'SELECT id, text FROM pending_replies WHERE user_id = ? AND thread_key = ? ORDER BY id DESC LIMIT 1',
    ).get(item.userId, item.threadKey) as { id: number; text: string } | undefined
    if (existing) {
      const merged = `${existing.text} / ${item.text}`.slice(0, 400)
      this.db.prepare('UPDATE pending_replies SET text = ?, created_at = ? WHERE id = ?').run(merged, createdAt, existing.id)
    } else {
      this.db.prepare(
        'INSERT INTO pending_replies (user_id, user_name, thread_key, text, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(item.userId, item.userName, item.threadKey, item.text, createdAt)
    }
  }

  listPendingReplies(): PendingReply[] {
    const rows = this.db.prepare('SELECT * FROM pending_replies ORDER BY id ASC').all() as Array<Record<string, unknown>>
    return rows.map((r) => ({
      id: Number(r.id),
      userId: String(r.user_id),
      userName: String(r.user_name),
      threadKey: String(r.thread_key),
      text: String(r.text),
      createdAt: String(r.created_at),
    }))
  }

  takePendingReplies(): PendingReply[] {
    const list = this.listPendingReplies()
    if (list.length > 0) this.db.prepare('DELETE FROM pending_replies').run()
    return list
  }

  removePendingReply(id: number): boolean {
    const info = this.db.prepare('DELETE FROM pending_replies WHERE id = ?').run(id)
    return Number(info.changes) > 0
  }

  // ── 能力与作品 ──────────────────────────────────────────────────────
  upsertCapability(cap: CapabilityRecord): void {
    this.db.prepare(
      `INSERT INTO capabilities (name, kind, summary, skill_dir, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET summary=excluded.summary, skill_dir=excluded.skill_dir, status=excluded.status`,
    ).run(cap.name, cap.kind, cap.summary, cap.skillDir, cap.status, cap.createdAt)
  }

  listCapabilities(): CapabilityRecord[] {
    const rows = this.db.prepare('SELECT * FROM capabilities ORDER BY created_at DESC').all() as Array<Record<string, unknown>>
    return rows.map((r) => ({
      name: String(r.name),
      kind: String(r.kind) as CapabilityRecord['kind'],
      summary: String(r.summary),
      skillDir: String(r.skill_dir),
      status: String(r.status) as CapabilityRecord['status'],
      createdAt: String(r.created_at),
    }))
  }

  upsertWork(w: WorkRecord): void {
    this.db.prepare(
      `INSERT INTO works (id, kind, title, content, media_path, status, external_task_id, for_user, mood_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title, content=excluded.content, media_path=excluded.media_path,
         status=excluded.status, external_task_id=excluded.external_task_id, mood_note=excluded.mood_note`,
    ).run(w.id, w.kind, w.title, w.content, w.mediaPath, w.status, w.externalTaskId, w.forUser, w.moodNote, w.createdAt)
  }

  getWork(id: string): WorkRecord | null {
    const r = this.db.prepare('SELECT * FROM works WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!r) return null
    return {
      id: String(r.id),
      kind: String(r.kind) as WorkRecord['kind'],
      title: String(r.title),
      content: String(r.content),
      mediaPath: r.media_path ? String(r.media_path) : null,
      status: String(r.status) as WorkRecord['status'],
      externalTaskId: r.external_task_id ? String(r.external_task_id) : null,
      forUser: r.for_user ? String(r.for_user) : null,
      moodNote: r.mood_note ? String(r.mood_note) : null,
      createdAt: String(r.created_at),
    }
  }

  listWorks(kind?: WorkRecord['kind'], limit = 50): WorkRecord[] {
    const sql = kind
      ? 'SELECT * FROM works WHERE kind = ? ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM works ORDER BY created_at DESC LIMIT ?'
    const rows = (kind ? this.db.prepare(sql).all(kind, limit) : this.db.prepare(sql).all(limit)) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      id: String(r.id),
      kind: String(r.kind) as WorkRecord['kind'],
      title: String(r.title),
      content: String(r.content),
      mediaPath: r.media_path ? String(r.media_path) : null,
      status: String(r.status) as WorkRecord['status'],
      externalTaskId: r.external_task_id ? String(r.external_task_id) : null,
      forUser: r.for_user ? String(r.for_user) : null,
      moodNote: r.mood_note ? String(r.mood_note) : null,
      createdAt: String(r.created_at),
    }))
  }

  listWorksByStatus(statuses: WorkRecord['status'][], limit = 20): WorkRecord[] {
    if (statuses.length === 0) return []
    const placeholders = statuses.map(() => '?').join(',')
    const rows = this.db.prepare(
      `SELECT * FROM works WHERE status IN (${placeholders}) ORDER BY created_at ASC LIMIT ?`,
    ).all(...statuses, limit) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      id: String(r.id),
      kind: String(r.kind) as WorkRecord['kind'],
      title: String(r.title),
      content: String(r.content),
      mediaPath: r.media_path ? String(r.media_path) : null,
      status: String(r.status) as WorkRecord['status'],
      externalTaskId: r.external_task_id ? String(r.external_task_id) : null,
      forUser: r.for_user ? String(r.for_user) : null,
      moodNote: r.mood_note ? String(r.mood_note) : null,
      createdAt: String(r.created_at),
    }))
  }

  // ── Token 账本与 Trace ──────────────────────────────────────────────
  recordTokens(entry: TokenLedgerEntry): void {
    this.db.prepare(
      `INSERT INTO token_ledger (scene, model, input_tokens, cached_tokens, output_tokens, reasoning_tokens, est_cost_cny, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.scene,
      entry.model,
      entry.inputTokens,
      entry.cachedTokens,
      entry.outputTokens,
      entry.reasoningTokens,
      entry.estCostCny,
      entry.createdAt ?? new Date().toISOString(),
    )
  }

  tokenStatsSince(sinceIso: string): {
    totalInput: number
    totalCached: number
    totalOutput: number
    totalReasoning: number
    totalCostCny: number
    byScene: Record<string, { calls: number; input: number; cached: number; output: number }>
  } {
    const rows = this.db.prepare(
      `SELECT scene, COUNT(*) AS calls, SUM(input_tokens) AS inp, SUM(cached_tokens) AS cac,
              SUM(output_tokens) AS outp, SUM(reasoning_tokens) AS reas, SUM(est_cost_cny) AS cost
       FROM token_ledger WHERE created_at >= ? GROUP BY scene`,
    ).all(sinceIso) as Array<Record<string, unknown>>
    let totalInput = 0
    let totalCached = 0
    let totalOutput = 0
    let totalReasoning = 0
    let totalCostCny = 0
    const byScene: Record<string, { calls: number; input: number; cached: number; output: number }> = {}
    for (const r of rows) {
      const scene = String(r.scene)
      const inp = Number(r.inp ?? 0)
      const cac = Number(r.cac ?? 0)
      const outp = Number(r.outp ?? 0)
      const reas = Number(r.reas ?? 0)
      const cost = Number(r.cost ?? 0)
      totalInput += inp
      totalCached += cac
      totalOutput += outp
      totalReasoning += reas
      totalCostCny += cost
      byScene[scene] = { calls: Number(r.calls ?? 0), input: inp, cached: cac, output: outp }
    }
    return { totalInput, totalCached, totalOutput, totalReasoning, totalCostCny, byScene }
  }

  tokenDailySeries(days = 7): Array<{ day: string; calls: number; input: number; cached: number; output: number; costCny: number }> {
    const since = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString()
    const rows = this.db.prepare(
      `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS calls,
              SUM(input_tokens) AS inp, SUM(cached_tokens) AS cac,
              SUM(output_tokens) AS outp, SUM(est_cost_cny) AS cost
       FROM token_ledger
       WHERE created_at >= ?
       GROUP BY substr(created_at, 1, 10)
       ORDER BY day ASC`,
    ).all(since) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      day: String(r.day),
      calls: Number(r.calls ?? 0),
      input: Number(r.inp ?? 0),
      cached: Number(r.cac ?? 0),
      output: Number(r.outp ?? 0),
      costCny: Number(r.cost ?? 0),
    }))
  }

  logTrace(entry: TraceEntry): void {
    this.db.prepare(
      'INSERT INTO traces (trace_id, event, level, data_json, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(entry.traceId, entry.event, entry.level, JSON.stringify(entry.data), entry.createdAt ?? new Date().toISOString())
  }

  recentTraces(limit: number): TraceEntry[] {
    const rows = this.db.prepare('SELECT * FROM traces ORDER BY id DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      id: Number(r.id),
      traceId: String(r.trace_id),
      event: String(r.event),
      level: String(r.level) as TraceEntry['level'],
      data: safeParseJson(r.data_json, {}),
      createdAt: String(r.created_at),
    }))
  }

  // 一键原子清空该 bot 的全部运行记忆（人设与技能文件保留）
  wipeRuntimeData(): void {
    this.db.exec(`
      BEGIN;
      DELETE FROM messages;
      DELETE FROM memories;
      DELETE FROM relations;
      DELETE FROM body_state;
      DELETE FROM emotion_causes;
      DELETE FROM desires;
      DELETE FROM approvals;
      DELETE FROM schedule;
      DELETE FROM pending_replies;
      DELETE FROM works;
      DELETE FROM token_ledger;
      DELETE FROM traces;
      COMMIT;
    `)
  }

  close(): void {
    this.db.close()
  }
}
