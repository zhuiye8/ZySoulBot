import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  Users,
  Search,
  Trash2,
  MessageSquare,
  Wrench,
  ChevronLeft,
  ChevronRight,
  Bookmark,
} from 'lucide-react'
import { api } from '../lib/api.ts'
import type { MemoryItem, RelationView, StoredMessage } from '../lib/api.ts'
import {
  AlertDialog,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Meter,
  UnderlineTabs,
  useDelayedLoading,
} from '../components/ui.tsx'
import type { BadgeTone } from '../components/ui.tsx'

const STAGE_META: Record<string, { label: string; tone: BadgeTone }> = {
  hostile: { label: '反感', tone: 'danger' },
  distant: { label: '疏远', tone: 'warn' },
  stranger: { label: '初识', tone: 'neutral' },
  acquaintance: { label: '熟脸', tone: 'info' },
  familiar: { label: '熟悉', tone: 'accent' },
  trusted: { label: '信任', tone: 'ok' },
  bonded: { label: '羁绊', tone: 'ok' },
}

const TIER_LABEL: Record<string, string> = {
  fleeting: '闪念',
  season: '一阵',
  lasting: '很久',
  permanent: '永久',
}

const KIND_LABEL: Record<string, string> = {
  fact: '事实',
  experience: '经历',
  insight: '感悟',
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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [relations, setRelations] = useState<RelationView[]>([])
  const [memories, setMemories] = useState<MemoryItem[]>([])
  const [memPage, setMemPage] = useState(1)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<MemoryItem | null>(null)
  const [deleting, setDeleting] = useState(false)

  const [threads, setThreads] = useState<Array<{ threadKey: string; messageCount: number; lastAt: string; lastContent: string }>>([])
  const [activeThread, setActiveThread] = useState('')
  const [messages, setMessages] = useState<StoredMessage[]>([])
  const showSkeleton = useDelayedLoading(loading && relations.length === 0 && memories.length === 0 && threads.length === 0, 180)

  useEffect(() => {
    setTab(validTab)
  }, [validTab])

  const switchTab = (next: 'people' | 'memories' | 'chat') => {
    setTab(next)
    onTabChange?.(next)
  }

  const loadMemories = async (q = query) => {
    setSearching(true)
    try {
      const m = await api.memories(botId, q)
      setMemories(m.items)
      setMemPage(1)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSearching(false)
    }
  }

  const loadAll = async () => {
    setLoading(true)
    setError('')
    try {
      const [r, m, t] = await Promise.all([api.relations(botId), api.memories(botId, ''), api.threads(botId)])
      setRelations(r.relations)
      setMemories(m.items)
      setThreads(t.threads)
      if (t.threads[0]) {
        setActiveThread(t.threads[0].threadKey)
        const ms = await api.messages(botId, t.threads[0].threadKey)
        setMessages(ms.messages)
      } else {
        setActiveThread('')
        setMessages([])
      }
    } catch (e) {
      const msg = (e as Error).message
      setError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setQuery('')
    setMemPage(1)
    void loadAll()
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

  const confirmDeleteMemory = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api.deleteMemory(botId, deleteTarget.id)
      setMemories((prev) => prev.filter((m) => m.id !== deleteTarget.id))
      setDeleteTarget(null)
      toast.success('已抹去这条记忆')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  const pageSize = 10
  const totalPages = Math.max(1, Math.ceil(memories.length / pageSize))
  const safePage = Math.min(memPage, totalPages)
  const pagedMemories = memories.slice((safePage - 1) * pageSize, safePage * pageSize)

  return (
    <div className="space-y-6">
      <UnderlineTabs
        ariaLabel="记忆与关系视图切换"
        value={tab}
        onChange={switchTab}
        items={[
          { id: 'people', label: '人物关系', icon: Users, count: relations.length },
          { id: 'memories', label: '记忆检索池', icon: Search, count: memories.length },
          { id: 'chat', label: '对话回放', icon: MessageSquare, count: threads.length },
        ]}
      />

      {error && <ErrorState title="无法加载记忆与关系" message={error} onRetry={() => { void loadAll() }} />}

      {showSkeleton && (
        <div className="ui-panel p-6 space-y-3">
          <div className="ui-skeleton h-5 w-44" />
          <div className="ui-skeleton h-16 w-full" />
        </div>
      )}

      {/* 1) 人物关系 */}
      {!showSkeleton && tab === 'people' && (
        relations.length === 0 ? (
          <div className="ui-panel">
            <EmptyState
              icon={Users}
              title="还没有认识新朋友"
              description="只要有人和她聊过天，信任、亲密、好感三轴关系与共同故事就会自动建立。"
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {relations.map((r) => {
              const st = STAGE_META[r.stage] ?? { label: r.stage, tone: 'neutral' as BadgeTone }
              return (
                <article key={r.userId} className="ui-panel p-5 flex flex-col justify-between gap-4">
                  <div className="space-y-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h2 className="text-[16px] font-semibold truncate">{r.displayName}</h2>
                        <div className="text-[12px] font-mono-num" style={{ color: 'var(--gray-11)' }}>
                          ID {r.userId} · {r.turns}&nbsp;轮对话
                        </div>
                      </div>
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </div>

                    <div className="pt-3 border-t space-y-2.5" style={{ borderColor: 'var(--gray-6)' }}>
                      <Meter label="信任 Trust" value={r.trust} min={0} max={1} />
                      <Meter label="亲密 Closeness" value={r.closeness} min={0} max={1} />
                      <Meter
                        label="好感 Valence"
                        value={r.valence}
                        min={-1}
                        max={1}
                        tone={r.valence < -0.15 ? 'danger' : 'ok'}
                      />
                    </div>

                    {r.tensions && r.tensions.length > 0 && (
                      <div
                        className="rounded-[8px] border px-3 py-2.5 space-y-1.5"
                        style={{ backgroundColor: 'var(--danger-bg)', borderColor: 'var(--danger-border)' }}
                      >
                        <div className="text-[12px] font-semibold" style={{ color: 'var(--danger-fg)' }}>
                          未解心结（{r.tensions.length}）
                        </div>
                        {r.tensions.map((t) => (
                          <div key={t.id} className="font-voice text-[12px] leading-relaxed flex items-start justify-between gap-2">
                            <span style={{ color: 'var(--gray-12)' }}>
                              {t.source === 'self' ? '[愧疚] ' : ''}{t.text}
                              {(t.repeatCount ?? 0) > 0 ? `（第 ${(t.repeatCount ?? 0) + 1} 次）` : ''}
                            </span>
                            <span className="font-mono-num text-[11px] shrink-0" style={{ color: t.source === 'self' ? 'var(--warn-fg)' : 'var(--danger-fg)' }}>
                              {Math.round(t.severity * 100)}%
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {r.sharedStories.length > 0 && (
                      <div className="pt-3 border-t space-y-1.5" style={{ borderColor: 'var(--gray-6)' }}>
                        <div className="text-[12px] font-medium" style={{ color: 'var(--gray-11)' }}>共同经历</div>
                        <ul className="space-y-1">
                          {r.sharedStories.map((s, idx) => {
                            const storyText = typeof s === 'string' ? s : s.text
                            const storyKey = typeof s === 'string' ? idx : s.id
                            return (
                              <li key={storyKey} className="font-voice text-[13px] leading-relaxed" style={{ color: 'var(--gray-12)' }}>
                                {storyText}
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    )}
                  </div>

                  <div className="text-[12px] font-mono-num pt-3 border-t" style={{ color: 'var(--gray-11)', borderColor: 'var(--gray-6)' }}>
                    最近联系：{r.lastContactAt ?? r.lastSeen ?? '—'}
                  </div>
                </article>
              )
            })}
          </div>
        )
      )}

      {/* 2) FTS5 记忆检索池 */}
      {!showSkeleton && tab === 'memories' && (
        <section className="ui-panel p-5 space-y-4">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void loadMemories(query)
            }}
            className="flex flex-col sm:flex-row gap-2"
          >
            <div className="ui-input-group flex-1">
              <Search className="w-4 h-4 shrink-0" style={{ color: 'var(--gray-10)' }} aria-hidden="true" />
              <label htmlFor="memory-fts-query" className="sr-only">全文检索记忆</label>
              <input
                id="memory-fts-query"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="输入关键词全文检索记忆（支持 FTS5 中文）…"
                className="ui-input-bare"
              />
            </div>
            <div className="flex gap-2 shrink-0">
              {query && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setQuery('')
                    void loadMemories('')
                  }}
                >
                  清空
                </Button>
              )}
              <Button type="submit" variant="primary" loading={searching}>
                {searching ? '检索中…' : '检索记忆'}
              </Button>
            </div>
          </form>

          {pagedMemories.length === 0 ? (
            <EmptyState
              icon={Bookmark}
              title={query ? '没有找到匹配的记忆' : '记忆池还是空的'}
              description={query ? '可以尝试更短的关键词，或清空搜索词查看全部记忆。' : '对话中确认的事实、偏好和经历会按时间与清晰度沉淀于此。'}
              action={
                query ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setQuery('')
                      void loadMemories('')
                    }}
                  >
                    显示全部记忆
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <ul className="divide-y" style={{ borderColor: 'var(--gray-6)' }}>
                {pagedMemories.map((m) => {
                  const clarityPct = Math.round((m.clarity ?? 1) * 100)
                  return (
                    <li key={m.id} className="py-3.5 flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2 text-[12px]" style={{ color: 'var(--gray-11)' }}>
                          <span className="font-medium" style={{ color: 'var(--gray-12)' }}>
                            {KIND_LABEL[m.kind] ?? m.kind}
                          </span>
                          <span>·</span>
                          <span>{TIER_LABEL[m.tier] ?? m.tier}</span>
                          <span>·</span>
                          <span>{m.sensitivity}</span>
                          <span>·</span>
                          <span className="font-mono-num">
                            清晰度 {clarityPct}% · 想起 {m.recallCount}&nbsp;次 · {m.createdAt.slice(0, 16)}
                          </span>
                        </div>
                        <p className="font-voice text-[14px] leading-relaxed max-w-[68ch] break-words" style={{ color: 'var(--gray-12)' }}>
                          {m.text}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`删除记忆：${m.text.slice(0, 20)}`}
                        onClick={() => setDeleteTarget(m)}
                        style={{ color: 'var(--danger-fg)' }}
                        className="shrink-0"
                      >
                        <Trash2 className="w-4 h-4" aria-hidden="true" />
                      </Button>
                    </li>
                  )
                })}
              </ul>

              {totalPages > 1 && (
                <div className="flex items-center justify-between pt-3 border-t text-[12px]" style={{ borderColor: 'var(--gray-6)', color: 'var(--gray-11)' }}>
                  <span className="font-mono-num">
                    显示 {(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, memories.length)} / 共 {memories.length}&nbsp;条
                  </span>
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={safePage <= 1}
                      onClick={() => setMemPage((p) => Math.max(1, p - 1))}
                    >
                      <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />
                      上一页
                    </Button>
                    <span className="font-mono-num px-2">{safePage} / {totalPages}</span>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={safePage >= totalPages}
                      onClick={() => setMemPage((p) => Math.min(totalPages, p + 1))}
                    >
                      下一页
                      <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* 3) 对话回放（主从分栏，清晰区隔工具摘要与消息气泡） */}
      {!showSkeleton && tab === 'chat' && (
        <section className="ui-panel overflow-hidden">
          {threads.length === 0 ? (
            <EmptyState
              icon={MessageSquare}
              title="暂无对话记录"
              description="私聊或群聊产生真实消息后，你可以在这里按会话回放完整对话与工具调用轨迹。"
            />
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-12 min-h-[500px]">
              <aside
                className="lg:col-span-3 border-b lg:border-b-0 lg:border-r p-3 space-y-1 max-h-[540px] overflow-y-auto"
                style={{ backgroundColor: 'var(--surface-subtle)', borderColor: 'var(--gray-6)' }}
              >
                {threads.map((t) => {
                  const active = activeThread === t.threadKey
                  return (
                    <button
                      key={t.threadKey}
                      type="button"
                      onClick={() => { void selectThread(t.threadKey) }}
                      aria-current={active ? 'true' : undefined}
                      className="w-full text-left px-3 py-2.5 rounded-[8px] cursor-pointer transition-colors duration-150"
                      style={{
                        backgroundColor: active ? 'var(--accent-3)' : 'transparent',
                      }}
                    >
                      <div
                        className="text-[12px] font-semibold font-mono-num truncate"
                        style={{ color: active ? 'var(--accent-11)' : 'var(--gray-12)' }}
                        translate="no"
                      >
                        {t.threadKey}
                      </div>
                      <div className="text-[12px] truncate mt-0.5" style={{ color: 'var(--gray-11)' }}>
                        {t.lastContent}
                      </div>
                      <div className="text-[11px] font-mono-num mt-1" style={{ color: 'var(--gray-10)' }}>
                        {t.messageCount}&nbsp;条 · {t.lastAt.slice(5, 16)}
                      </div>
                    </button>
                  )
                })}
              </aside>

              <div className="lg:col-span-9 p-5 space-y-4 max-h-[540px] overflow-y-auto">
                {messages.length === 0 ? (
                  <EmptyState
                    icon={MessageSquare}
                    title="选择一个会话"
                    description="从左侧选择任意私聊或群聊会话即可查看历史记录。"
                  />
                ) : (
                  messages.map((m) => {
                    if (m.role === 'summary') {
                      return (
                        <div key={m.id} className="flex items-center gap-3 py-1">
                          <span className="flex-1 h-px" style={{ backgroundColor: 'var(--gray-6)' }} />
                          <span className="text-[12px] font-voice px-2" style={{ color: 'var(--gray-11)' }}>
                            早先梗概：{m.content}
                          </span>
                          <span className="flex-1 h-px" style={{ backgroundColor: 'var(--gray-6)' }} />
                        </div>
                      )
                    }
                    const isBot = m.role === 'assistant'
                    return (
                      <div key={m.id} className={`flex flex-col ${isBot ? 'items-start' : 'items-end'}`}>
                        <div className="text-[11px] mb-1 px-1 flex items-center gap-1.5" style={{ color: 'var(--gray-11)' }}>
                          <span className="font-medium">{m.userName}</span>
                          <time className="font-mono-num">{m.createdAt.slice(5, 16)}</time>
                        </div>
                        {m.toolSummary && (
                          <div className="mb-1.5">
                            <Badge tone="info">
                              <Wrench className="w-3 h-3" aria-hidden="true" />
                              {m.toolSummary}
                            </Badge>
                          </div>
                        )}
                        <div
                          className="max-w-[82%] px-4 py-2.5 rounded-[12px] border font-voice text-[14px] leading-[1.65] whitespace-pre-wrap break-words"
                          style={{
                            backgroundColor: isBot ? 'var(--accent-2)' : 'var(--surface-subtle)',
                            borderColor: isBot ? 'var(--accent-5)' : 'var(--gray-6)',
                            color: 'var(--gray-12)',
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
        </section>
      )}

      <AlertDialog
        open={Boolean(deleteTarget)}
        title="抹去这条记忆？"
        description={
          deleteTarget ? (
            <span>
              删除后无法恢复，她将不再记得「<strong style={{ color: 'var(--gray-12)' }}>{deleteTarget.text}</strong>」。
            </span>
          ) : ''
        }
        confirmLabel="抹去记忆"
        destructive
        loading={deleting}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => { void confirmDeleteMemory() }}
      />
    </div>
  )
}
