import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Users, Search, Trash2, MessageSquare, Wrench } from 'lucide-react'
import { api } from '../lib/api.ts'
import type { MemoryItem, RelationView, StoredMessage } from '../lib/api.ts'

const STAGE_LABEL: Record<string, string> = {
  hostile: '反感',
  distant: '疏远',
  stranger: '初识',
  acquaintance: '熟脸',
  familiar: '熟悉',
  trusted: '信任',
  bonded: '羁绊',
}

const TIER_LABEL: Record<string, string> = {
  fleeting: '闪念',
  season: '一阵',
  lasting: '很久',
  permanent: '永久',
}

export function MemoryView({
  botId,
  initialTab,
  onTabChange,
}: {
  botId: string
  initialTab?: string
  onTabChange?: (tab: 'people' | 'memories' | 'chat') => void
}) {
  const validTab = initialTab === 'memories' || initialTab === 'chat' ? initialTab : 'people'
  const [tab, setTab] = useState<'people' | 'memories' | 'chat'>(validTab)
  const [relations, setRelations] = useState<RelationView[]>([])
  const [memories, setMemories] = useState<MemoryItem[]>([])
  const [query, setQuery] = useState('')
  const [threads, setThreads] = useState<Array<{ threadKey: string; messageCount: number; lastAt: string; lastContent: string }>>([])
  const [activeThread, setActiveThread] = useState('')
  const [messages, setMessages] = useState<StoredMessage[]>([])

  useEffect(() => {
    setTab(validTab)
  }, [validTab])

  const switchTab = (next: 'people' | 'memories' | 'chat') => {
    setTab(next)
    onTabChange?.(next)
  }

  const loadPeople = async () => {
    const r = await api.relations(botId)
    setRelations(r.relations)
  }

  const loadMemories = async (q = query) => {
    const m = await api.memories(botId, q)
    setMemories(m.items)
  }

  const loadThreads = async () => {
    const t = await api.threads(botId)
    setThreads(t.threads)
    if (t.threads[0] && !activeThread) {
      setActiveThread(t.threads[0].threadKey)
      const ms = await api.messages(botId, t.threads[0].threadKey)
      setMessages(ms.messages)
    }
  }

  useEffect(() => {
    setActiveThread('')
    void Promise.all([loadPeople(), loadMemories(''), loadThreads()]).catch((e) => toast.error((e as Error).message))
  }, [botId])

  const selectThread = async (key: string) => {
    setActiveThread(key)
    try {
      const ms = await api.messages(botId, key)
      setMessages(ms.messages)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const removeMem = async (id: string) => {
    try {
      await api.deleteMemory(botId, id)
      setMemories((prev) => prev.filter((m) => m.id !== id))
      toast.success('已抹去这条记忆')
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const axisBar = (label: string, value: number, min = 0, max = 1) => {
    const pct = Math.max(0, Math.min(100, Math.round(((value - min) / (max - min)) * 100)))
    return (
      <div className="space-y-1">
        <div className="flex justify-between text-[11px]">
          <span style={{ color: 'var(--text-2)' }}>{label}</span>
          <span className="font-mono-num">{value.toFixed(2)}</span>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--surface)' }}>
          <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: 'var(--accent)' }} />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* 子页签 */}
      <div className="flex flex-wrap gap-2">
        {[
          { id: 'people' as const, label: '人物关系', icon: Users, count: relations.length },
          { id: 'memories' as const, label: '记忆检索池', icon: Search, count: memories.length },
          { id: 'chat' as const, label: '对话回放', icon: MessageSquare, count: threads.length },
        ].map((t) => {
          const Icon = t.icon
          const active = tab === t.id
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => switchTab(t.id)}
              className={`acg-btn ${active ? 'acg-btn-primary' : 'acg-btn-soft'}`}
            >
              <Icon className="w-4 h-4" />
              {t.label}
              <span className="text-xs opacity-80 font-mono-num">({t.count})</span>
            </button>
          )
        })}
      </div>

      {/* 1) 人物卡片网格 */}
      {tab === 'people' && (
        relations.length === 0 ? (
          <div className="acg-card p-10 text-center font-voice" style={{ color: 'var(--text-2)' }}>
            还没有认识新朋友。
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {relations.map((r) => (
              <div key={r.userId} className="acg-card p-5 space-y-3.5">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-base font-bold">{r.displayName}</div>
                    <div className="text-[11px] font-mono-num" style={{ color: 'var(--text-2)' }}>
                      ID: {r.userId} · {r.turns} 轮对话
                    </div>
                  </div>
                  <span
                    className="acg-pill"
                    style={{
                      color: r.stage === 'hostile' ? 'var(--danger)' : r.stage === 'distant' ? 'var(--warn)' : 'var(--accent)',
                    }}
                  >
                    {STAGE_LABEL[r.stage] ?? r.stage}
                  </span>
                </div>

                <div className="p-3 rounded-xl space-y-2" style={{ backgroundColor: 'var(--surface-2)' }}>
                  {axisBar('信任 Trust', r.trust, 0, 1)}
                  {axisBar('亲密 Closeness', r.closeness, 0, 1)}
                  {axisBar('好感 Valence', r.valence, -1, 1)}
                </div>

                {r.tensions && r.tensions.length > 0 && (
                  <div
                    className="p-3 rounded-xl border space-y-1.5"
                    style={{ backgroundColor: 'rgba(223, 83, 101, 0.06)', borderColor: 'rgba(223, 83, 101, 0.25)' }}
                  >
                    <div className="text-[11px] font-semibold" style={{ color: 'var(--danger)' }}>
                      未解心结（{r.tensions.length}）
                    </div>
                    {r.tensions.map((t) => (
                      <div key={t.id} className="font-voice text-xs leading-relaxed flex items-start justify-between gap-2">
                        <span>• {t.text}</span>
                        <span className="font-mono-num text-[10px] shrink-0" style={{ color: 'var(--danger)' }}>
                          {Math.round(t.severity * 100)}%
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {r.sharedStories.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-medium" style={{ color: 'var(--text-2)' }}>共同故事</div>
                    {r.sharedStories.map((s, idx) => {
                      const storyText = typeof s === 'string' ? s : s.text
                      const storyKey = typeof s === 'string' ? idx : s.id
                      return (
                        <p key={storyKey} className="font-voice text-xs leading-relaxed">• {storyText}</p>
                      )
                    })}
                  </div>
                )}

                <div className="text-[11px] font-mono-num pt-1 border-t" style={{ color: 'var(--text-2)', borderColor: 'var(--border)' }}>
                  最近联系：{r.lastContactAt ?? r.lastSeen ?? '—'}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* 2) FTS5 记忆检索池 */}
      {tab === 'memories' && (
        <div className="acg-card p-5 space-y-4">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void loadMemories(query)
            }}
            className="flex gap-2"
          >
            <div className="acg-input-box flex-1">
              <Search className="w-4 h-4 shrink-0" style={{ color: 'var(--text-2)' }} />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="全文检索记忆（支持中文关键词 FTS5）..."
                className="acg-input-bare"
              />
            </div>
            <button type="submit" className="acg-btn acg-btn-primary shrink-0">检索</button>
          </form>

          {memories.length === 0 ? (
            <p className="text-sm font-voice py-10 text-center" style={{ color: 'var(--text-2)' }}>
              没有找到匹配的记忆。
            </p>
          ) : (
            <div className="space-y-2.5">
              {memories.map((m) => {
                const clarityPct = Math.round((m.clarity ?? 1) * 100)
                return (
                  <div
                    key={m.id}
                    className="p-3.5 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    style={{ backgroundColor: 'var(--surface-2)', borderColor: 'var(--border)' }}
                  >
                    <div className="space-y-1.5 min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="acg-pill py-0.5 text-[11px]">{TIER_LABEL[m.tier] ?? m.tier}</span>
                        <span className="acg-pill py-0.5 text-[11px]">{m.sensitivity}</span>
                        <span className="acg-pill py-0.5 text-[11px]">{m.kind}</span>
                        <span className="text-[11px] font-mono-num" style={{ color: 'var(--text-2)' }}>
                          清晰度 {clarityPct}% · 想起 {m.recallCount} 次 · {m.createdAt.slice(0, 16)}
                        </span>
                      </div>
                      <p className="font-voice text-[14px] leading-relaxed">{m.text}</p>
                    </div>
                    <button
                      type="button"
                      aria-label="删除记忆"
                      onClick={() => { void removeMem(m.id) }}
                      className="acg-btn acg-btn-soft p-2 shrink-0 self-end sm:self-center"
                      style={{ color: 'var(--danger)' }}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* 3) QQ 气泡对话回放 */}
      {tab === 'chat' && (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          <div className="acg-card p-3 space-y-1.5 max-h-[540px] overflow-y-auto">
            {threads.length === 0 ? (
              <p className="text-xs font-voice p-4 text-center" style={{ color: 'var(--text-2)' }}>暂无对话记录</p>
            ) : (
              threads.map((t) => (
                <button
                  key={t.threadKey}
                  type="button"
                  onClick={() => { void selectThread(t.threadKey) }}
                  className="w-full text-left p-2.5 rounded-xl border cursor-pointer"
                  style={{
                    backgroundColor: activeThread === t.threadKey ? 'var(--accent-soft)' : 'var(--surface-2)',
                    borderColor: activeThread === t.threadKey ? 'var(--accent)' : 'transparent',
                  }}
                >
                  <div className="text-xs font-semibold font-mono-num truncate">{t.threadKey}</div>
                  <div className="text-[11px] truncate mt-0.5" style={{ color: 'var(--text-2)' }}>{t.lastContent}</div>
                  <div className="text-[10px] font-mono-num mt-1" style={{ color: 'var(--text-2)' }}>
                    {t.messageCount} 条 · {t.lastAt.slice(5, 16)}
                  </div>
                </button>
              ))
            )}
          </div>

          <div className="lg:col-span-3 acg-card p-5 space-y-3 max-h-[540px] overflow-y-auto">
            {messages.length === 0 ? (
              <p className="text-sm font-voice py-12 text-center" style={{ color: 'var(--text-2)' }}>
                选择左侧会话查看对话现场。
              </p>
            ) : (
              messages.map((m) => {
                if (m.role === 'summary') {
                  return (
                    <div key={m.id} className="text-center">
                      <span className="acg-pill text-[11px] font-voice">早先梗概：{m.content}</span>
                    </div>
                  )
                }
                const isBot = m.role === 'assistant'
                return (
                  <div key={m.id} className={`flex flex-col ${isBot ? 'items-start' : 'items-end'}`}>
                    <div className="text-[11px] mb-1 px-1" style={{ color: 'var(--text-2)' }}>
                      {m.userName} · <span className="font-mono-num">{m.createdAt.slice(5, 16)}</span>
                    </div>
                    {m.toolSummary && (
                      <div className="acg-pill text-[11px] mb-1" style={{ color: 'var(--info)' }}>
                        <Wrench className="w-3 h-3" />
                        {m.toolSummary}
                      </div>
                    )}
                    <div
                      className="max-w-[82%] px-4 py-2.5 rounded-2xl border font-voice text-[14px] leading-relaxed whitespace-pre-wrap"
                      style={{
                        backgroundColor: isBot ? 'var(--accent-soft)' : 'var(--surface-2)',
                        borderColor: 'var(--border)',
                      }}
                    >
                      {m.content}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
