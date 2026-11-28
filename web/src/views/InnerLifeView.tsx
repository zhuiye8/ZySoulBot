import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Heart,
  Sparkles,
  BookOpen,
  ArrowUpCircle,
  PlayCircle,
  XCircle,
  Search,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import { api } from '../lib/api.ts'
import type { BodyState, DesireRecord, EmotionCause } from '../lib/api.ts'
import {
  AlertDialog,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  FilterChip,
  Meter,
  UnderlineTabs,
  useDelayedLoading,
} from '../components/ui.tsx'
import type { BadgeTone } from '../components/ui.tsx'

export type LifeTab = 'body' | 'desires' | 'diary'

const STAGE_META: Record<string, { label: string; tone: BadgeTone }> = {
  seed: { label: '萌芽', tone: 'info' },
  active: { label: '跃跃欲试', tone: 'accent' },
  in_progress: { label: '推进中', tone: 'ok' },
  waiting_credential: { label: '等凭证', tone: 'warn' },
  waiting_approval: { label: '等点头', tone: 'warn' },
  fulfilled: { label: '已实现', tone: 'ok' },
  faded: { label: '淡去了', tone: 'neutral' },
  abandoned: { label: '已收起', tone: 'danger' },
}

const EXIT_LABEL: Record<string, string> = {
  experience: '体验',
  create_work: '创作',
  social: '社交',
  build_skill: '造技能',
}

const ACTIVE_GROUP = new Set(['active', 'in_progress', 'waiting_credential', 'waiting_approval'])
const CLOSED_GROUP = new Set(['fulfilled', 'faded', 'abandoned'])
const DESIRE_PAGE_SIZE = 8

function stripDiaryDateHeader(date: string | null, content: string | null): string {
  if (!content) return ''
  let text = content.trim()
  if (date) {
    const escaped = date.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    text = text.replace(new RegExp(`^(?:#+\\s*${escaped}\\s*\\r?\\n*)+`, 'i'), '').trim()
  }
  return text
}

export function InnerLifeView({
  botId,
  initialTab,
  onTabChange,
}: {
  botId: string
  initialTab?: string
  onTabChange?: (tab: LifeTab) => void
}) {
  const validTab: LifeTab = initialTab === 'desires' || initialTab === 'diary' ? initialTab : 'body'
  const [tab, setTab] = useState<LifeTab>(validTab)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [body, setBody] = useState<{ state: BodyState; facts: string; causes: EmotionCause[] } | null>(null)
  const [desires, setDesires] = useState<DesireRecord[]>([])
  const [desireFilter, setDesireFilter] = useState<'all' | 'working' | 'seed' | 'closed'>('all')
  const [desireQuery, setDesireQuery] = useState('')
  const [desirePage, setDesirePage] = useState(1)
  const [abandonTarget, setAbandonTarget] = useState<DesireRecord | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const [diary, setDiary] = useState<{ dates: string[]; activeDate: string | null; content: string | null }>({
    dates: [],
    activeDate: null,
    content: null,
  })
  const [diaryQuery, setDiaryQuery] = useState('')
  const showSkeleton = useDelayedLoading(loading && !body, 180)

  useEffect(() => {
    setTab(validTab)
  }, [validTab])

  const switchTab = (next: LifeTab) => {
    setTab(next)
    onTabChange?.(next)
  }

  const loadAll = async () => {
    setLoading(true)
    setError('')
    try {
      const [b, d, dy] = await Promise.all([api.body(botId), api.desires(botId), api.diary(botId)])
      setBody(b)
      setDesires(d.desires)
      setDiary(dy)
    } catch (e) {
      const msg = (e as Error).message
      setError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setDesirePage(1)
    void loadAll()
  }, [botId])

  const openDiaryDate = async (date: string) => {
    try {
      const dy = await api.diary(botId, date)
      setDiary(dy)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const runDesireOp = async (did: string, op: 'boost' | 'abandon' | 'resume') => {
    setBusyId(did)
    try {
      await api.desireOp(botId, did, op)
      toast.success(op === 'boost' ? '已轻推这个念头' : op === 'resume' ? '已恢复推进' : '已收起这个念头')
      const d = await api.desires(botId)
      setDesires(d.desires)
      if (op === 'abandon') setAbandonTarget(null)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  const desireCounts = useMemo(() => ({
    working: desires.filter((d) => ACTIVE_GROUP.has(d.stage)).length,
    seed: desires.filter((d) => d.stage === 'seed').length,
    closed: desires.filter((d) => CLOSED_GROUP.has(d.stage)).length,
    all: desires.length,
  }), [desires])

  const filteredDesires = useMemo(() => {
    const q = desireQuery.trim().toLowerCase()
    return desires.filter((d) => {
      if (desireFilter === 'working' && !ACTIVE_GROUP.has(d.stage)) return false
      if (desireFilter === 'seed' && d.stage !== 'seed') return false
      if (desireFilter === 'closed' && !CLOSED_GROUP.has(d.stage)) return false
      if (q && !d.want.toLowerCase().includes(q) && !d.why.toLowerCase().includes(q)) return false
      return true
    })
  }, [desires, desireFilter, desireQuery])

  const totalPages = Math.max(1, Math.ceil(filteredDesires.length / DESIRE_PAGE_SIZE))
  const safePage = Math.min(desirePage, totalPages)
  const pagedDesires = filteredDesires.slice((safePage - 1) * DESIRE_PAGE_SIZE, safePage * DESIRE_PAGE_SIZE)

  const filteredDiaryDates = useMemo(() => {
    const q = diaryQuery.trim()
    if (!q) return diary.dates
    return diary.dates.filter((dt) => dt.includes(q))
  }, [diary.dates, diaryQuery])

  const cleanDiaryText = useMemo(
    () => stripDiaryDateHeader(diary.activeDate, diary.content),
    [diary.activeDate, diary.content],
  )

  return (
    <div className="space-y-6">
      <UnderlineTabs
        ariaLabel="内心与生活视图切换"
        value={tab}
        onChange={switchTab}
        items={[
          { id: 'body', label: '此刻身心', icon: Heart, count: body?.causes.length ?? 0 },
          { id: 'desires', label: '心事与欲望', icon: Sparkles, count: desires.length },
          { id: 'diary', label: '日记本', icon: BookOpen, count: diary.dates.length },
        ]}
      />

      {error && !body && <ErrorState title="无法加载内心状态" message={error} onRetry={() => { void loadAll() }} />}

      {showSkeleton && (
        <div className="ui-panel p-6 space-y-4">
          <div className="ui-skeleton h-5 w-36" />
          <div className="ui-skeleton h-20 w-full" />
          <div className="ui-skeleton h-4 w-2/3" />
        </div>
      )}

      {/* 1) 此刻身心与情绪来由 */}
      {tab === 'body' && body && (
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <div className="lg:col-span-5 ui-panel p-5 space-y-5">
            <div className="space-y-2">
              <h2 className="text-[15px] font-semibold">主观身体与心境感受</h2>
              <p
                className="font-voice text-[14px] leading-[1.7] pl-3.5 border-l-2"
                style={{ borderColor: 'var(--accent-7)', color: 'var(--gray-12)' }}
              >
                {body.facts || '此刻状态平稳。'}
              </p>
            </div>

            <div className="pt-4 border-t space-y-3.5" style={{ borderColor: 'var(--gray-6)' }}>
              <h3 className="text-[12px] font-semibold" style={{ color: 'var(--gray-11)' }}>
                生理与三轴情绪基线
              </h3>
              <Meter
                label="生理精力"
                value={body.state.energy}
                displayValue={`${Math.round(body.state.energy * 100)}%`}
                tone={body.state.energy > 0.45 ? 'ok' : body.state.energy > 0.2 ? 'warn' : 'danger'}
              />
              <Meter
                label="睡眠债"
                value={body.state.sleepDebt}
                displayValue={`${Math.round(body.state.sleepDebt * 100)}%`}
                tone={body.state.sleepDebt > 0.55 ? 'warn' : 'accent'}
              />
              <Meter label="愉悦度 (Pleasure)" value={body.state.mood.p} min={-1} max={1} />
              <Meter label="唤醒度 (Arousal)" value={body.state.mood.a} min={-1} max={1} />
              <Meter label="掌控感 (Dominance)" value={body.state.mood.d} min={-1} max={1} />
            </div>
          </div>

          <div className="lg:col-span-7 ui-panel p-5 flex flex-col">
            <div className="flex items-center justify-between pb-3 border-b" style={{ borderColor: 'var(--gray-6)' }}>
              <h2 className="text-[15px] font-semibold">情绪来由时间线</h2>
              <span className="text-[12px] font-mono-num" style={{ color: 'var(--gray-11)' }}>
                最近 {body.causes.length}&nbsp;条
              </span>
            </div>

            {body.causes.length === 0 ? (
              <EmptyState
                icon={Heart}
                title="最近没有明显的情绪起伏"
                description="对话里的触动、独处活动或睡前联想产生的情绪波动会按时间顺序记在这里。"
              />
            ) : (
              <ul className="divide-y max-h-[460px] overflow-y-auto pr-1" style={{ borderColor: 'var(--gray-6)' }}>
                {body.causes.map((c) => (
                  <li key={c.id} className="py-3 flex items-start justify-between gap-4">
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2 text-[12px]">
                        <Badge tone="neutral">{c.affectKind}</Badge>
                        <span style={{ color: 'var(--gray-11)' }}>{c.source}</span>
                      </div>
                      <p className="font-voice text-[14px] leading-relaxed break-words">{c.text}</p>
                    </div>
                    <time className="text-[12px] font-mono-num shrink-0" style={{ color: 'var(--gray-11)' }}>
                      {c.createdAt.slice(5, 16)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {/* 2) 心事与欲望列表 */}
      {tab === 'desires' && (
        <section className="ui-panel p-5 space-y-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-3 border-b" style={{ borderColor: 'var(--gray-6)' }}>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="按心事状态筛选">
              {[
                { id: 'all' as const, label: '全部', count: desireCounts.all },
                { id: 'working' as const, label: '进行中', count: desireCounts.working },
                { id: 'seed' as const, label: '萌芽', count: desireCounts.seed },
                { id: 'closed' as const, label: '已完结', count: desireCounts.closed },
              ].map((f) => (
                <FilterChip
                  key={f.id}
                  pressed={desireFilter === f.id}
                  onClick={() => {
                    setDesireFilter(f.id)
                    setDesirePage(1)
                  }}
                >
                  <span>{f.label}</span>
                  <span className="font-mono-num opacity-80">{f.count}</span>
                </FilterChip>
              ))}
            </div>

            <div className="ui-input-group w-full md:w-64">
              <Search className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--gray-10)' }} aria-hidden="true" />
              <label htmlFor="desire-search" className="sr-only">搜索念头或起因</label>
              <input
                id="desire-search"
                type="search"
                value={desireQuery}
                onChange={(e) => {
                  setDesireQuery(e.target.value)
                  setDesirePage(1)
                }}
                placeholder="筛选念头或起因…"
                className="ui-input-bare"
              />
            </div>
          </div>

          {pagedDesires.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title={desireQuery || desireFilter !== 'all' ? '没有符合筛选条件的心事' : '心事本还是空的'}
              description={
                desireQuery || desireFilter !== 'all'
                  ? '试试清空搜索词或切换到“全部”查看所有记录。'
                  : '在对话、活动或空闲联想里冒出来想做的事，会在这里慢慢成型和推进。'
              }
              action={
                (desireQuery || desireFilter !== 'all') ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setDesireFilter('all')
                      setDesireQuery('')
                      setDesirePage(1)
                    }}
                  >
                    重置筛选条件
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <ul className="divide-y" style={{ borderColor: 'var(--gray-6)' }}>
                {pagedDesires.map((d) => {
                  const st = STAGE_META[d.stage] ?? { label: d.stage, tone: 'neutral' as BadgeTone }
                  const done = d.stage === 'fulfilled' || d.stage === 'abandoned'
                  const isBusy = busyId === d.id
                  return (
                    <li key={d.id} className="py-4 flex flex-col lg:flex-row lg:items-start justify-between gap-4">
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={st.tone}>{st.label}</Badge>
                          <span className="text-[12px] font-mono-num" style={{ color: 'var(--gray-11)' }}>
                            {EXIT_LABEL[d.exitKind] ?? d.exitKind} · 来源 {d.source} · 强度 {Math.round(d.strength * 100)}%
                          </span>
                        </div>
                        <div className="font-voice text-[15px] font-medium" style={{ color: 'var(--gray-12)' }}>
                          {d.want}
                        </div>
                        {d.why && (
                          <p className="text-[13px] max-w-[65ch]" style={{ color: 'var(--gray-11)' }}>
                            起因：{d.why}
                          </p>
                        )}
                        {d.progressNote && (
                          <p
                            className="text-[12px] pl-3 border-l-2 max-w-[65ch] break-words"
                            style={{ borderColor: 'var(--gray-7)', color: 'var(--gray-11)' }}
                          >
                            {d.progressNote}
                          </p>
                        )}
                      </div>

                      {!done && (
                        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                          <Button
                            variant="secondary"
                            size="sm"
                            loading={isBusy}
                            onClick={() => { void runDesireOp(d.id, 'boost') }}
                          >
                            <ArrowUpCircle className="w-3.5 h-3.5" aria-hidden="true" />
                            轻推
                          </Button>
                          {(d.stage === 'waiting_approval' || d.stage === 'waiting_credential' || d.stage === 'faded') && (
                            <Button
                              variant="secondary"
                              size="sm"
                              loading={isBusy}
                              onClick={() => { void runDesireOp(d.id, 'resume') }}
                            >
                              <PlayCircle className="w-3.5 h-3.5" aria-hidden="true" />
                              恢复
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isBusy}
                            onClick={() => setAbandonTarget(d)}
                            style={{ color: 'var(--danger-fg)' }}
                          >
                            <XCircle className="w-3.5 h-3.5" aria-hidden="true" />
                            收起…
                          </Button>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>

              {totalPages > 1 && (
                <div className="flex items-center justify-between pt-3 border-t text-[12px]" style={{ borderColor: 'var(--gray-6)', color: 'var(--gray-11)' }}>
                  <span className="font-mono-num">
                    显示 {(safePage - 1) * DESIRE_PAGE_SIZE + 1}–{Math.min(safePage * DESIRE_PAGE_SIZE, filteredDesires.length)} / 共 {filteredDesires.length}&nbsp;条
                  </span>
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={safePage <= 1}
                      onClick={() => setDesirePage((p) => Math.max(1, p - 1))}
                    >
                      <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />
                      上一页
                    </Button>
                    <span className="font-mono-num px-2">{safePage} / {totalPages}</span>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={safePage >= totalPages}
                      onClick={() => setDesirePage((p) => Math.min(totalPages, p + 1))}
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

      {/* 3) 阅读模式日记本（65ch 行宽、1.85 行高、干净主从分栏） */}
      {tab === 'diary' && (
        <section className="ui-panel overflow-hidden">
          {diary.dates.length === 0 ? (
            <EmptyState
              icon={BookOpen}
              title="日记本还是空白的"
              description="等夜深或发生让她有感触的事时，她会用第一人称把今天写进日记。"
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-12 min-h-[480px]">
              <aside
                className="md:col-span-3 border-b md:border-b-0 md:border-r p-3.5 space-y-3"
                style={{ backgroundColor: 'var(--surface-subtle)', borderColor: 'var(--gray-6)' }}
              >
                <div className="ui-input-group">
                  <Search className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--gray-10)' }} aria-hidden="true" />
                  <label htmlFor="diary-search" className="sr-only">按日期筛选日记</label>
                  <input
                    id="diary-search"
                    type="search"
                    value={diaryQuery}
                    onChange={(e) => setDiaryQuery(e.target.value)}
                    placeholder="按日期筛选…"
                    className="ui-input-bare font-mono-num"
                  />
                </div>
                <div className="space-y-0.5 max-h-[440px] overflow-y-auto">
                  {filteredDiaryDates.map((dt) => {
                    const active = diary.activeDate === dt
                    return (
                      <button
                        key={dt}
                        type="button"
                        onClick={() => { void openDiaryDate(dt) }}
                        aria-current={active ? 'true' : undefined}
                        className="w-full text-left px-2.5 py-2 rounded-[8px] text-[13px] font-mono-num cursor-pointer transition-colors duration-150"
                        style={{
                          backgroundColor: active ? 'var(--accent-3)' : 'transparent',
                          color: active ? 'var(--accent-11)' : 'var(--gray-12)',
                          fontWeight: active ? 600 : 400,
                        }}
                      >
                        {dt}
                      </button>
                    )
                  })}
                  {filteredDiaryDates.length === 0 && (
                    <p className="text-[12px] text-center py-6" style={{ color: 'var(--gray-11)' }}>无匹配日期</p>
                  )}
                </div>
              </aside>

              <article className="md:col-span-9 p-6 lg:p-8 max-h-[580px] overflow-y-auto">
                <div className="max-w-[65ch] mx-auto space-y-5">
                  <header className="flex items-baseline justify-between pb-3 border-b" style={{ borderColor: 'var(--gray-6)' }}>
                    <h2 className="text-[18px] font-semibold font-mono-num">{diary.activeDate ?? '—'}</h2>
                    <span className="text-[12px] font-mono-num" style={{ color: 'var(--gray-11)' }}>
                      {cleanDiaryText.length}&nbsp;字
                    </span>
                  </header>
                  <div className="font-voice text-[16px] leading-[1.85] whitespace-pre-wrap" style={{ color: 'var(--gray-12)' }}>
                    {cleanDiaryText || '（这一天没有写下文字）'}
                  </div>
                </div>
              </article>
            </div>
          )}
        </section>
      )}

      <AlertDialog
        open={Boolean(abandonTarget)}
        title="收起这条心事？"
        description={
          abandonTarget ? (
            <span>
              收起后她将不再自主推进「<strong style={{ color: 'var(--gray-12)' }}>{abandonTarget.want}</strong>」，该记录会移入已完结列表。
            </span>
          ) : ''
        }
        confirmLabel="收起心事"
        destructive
        loading={Boolean(abandonTarget && busyId === abandonTarget.id)}
        onCancel={() => setAbandonTarget(null)}
        onConfirm={() => { if (abandonTarget) void runDesireOp(abandonTarget.id, 'abandon') }}
      />
    </div>
  )
}
