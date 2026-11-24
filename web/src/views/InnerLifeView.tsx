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

export type LifeTab = 'body' | 'desires' | 'diary'

const STAGE_META: Record<string, { label: string; color: string }> = {
  seed: { label: '萌芽', color: 'var(--info)' },
  active: { label: '跃跃欲试', color: 'var(--accent)' },
  in_progress: { label: '正在推进', color: 'var(--ok)' },
  waiting_credential: { label: '等凭证', color: 'var(--warn)' },
  waiting_approval: { label: '等点头', color: 'var(--warn)' },
  fulfilled: { label: '已实现', color: 'var(--ok)' },
  faded: { label: '淡去了', color: 'var(--text-2)' },
  abandoned: { label: '已放下', color: 'var(--danger)' },
}

const ACTIVE_GROUP = new Set(['active', 'in_progress', 'waiting_credential', 'waiting_approval'])
const CLOSED_GROUP = new Set(['fulfilled', 'faded', 'abandoned'])
const DESIRE_PAGE_SIZE = 8

// 去除日记正文开头重复的 `# YYYY-MM-DD` 标题（阅读器顶部已有日期栏，避免出现双标题）
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
  const [body, setBody] = useState<{ state: BodyState; facts: string; causes: EmotionCause[] } | null>(null)
  const [desires, setDesires] = useState<DesireRecord[]>([])
  const [desireFilter, setDesireFilter] = useState<'all' | 'working' | 'seed' | 'closed'>('all')
  const [desireQuery, setDesireQuery] = useState('')
  const [desirePage, setDesirePage] = useState(1)

  const [diary, setDiary] = useState<{ dates: string[]; activeDate: string | null; content: string | null }>({
    dates: [],
    activeDate: null,
    content: null,
  })
  const [diaryQuery, setDiaryQuery] = useState('')

  useEffect(() => {
    setTab(validTab)
  }, [validTab])

  const switchTab = (next: LifeTab) => {
    setTab(next)
    onTabChange?.(next)
  }

  const loadAll = async () => {
    try {
      const [b, d, dy] = await Promise.all([api.body(botId), api.desires(botId), api.diary(botId)])
      setBody(b)
      setDesires(d.desires)
      setDiary(dy)
    } catch (e) {
      toast.error((e as Error).message)
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
    try {
      await api.desireOp(botId, did, op)
      toast.success(op === 'boost' ? '轻推了这个念头' : op === 'resume' ? '已恢复推进' : '已收起这个念头')
      const d = await api.desires(botId)
      setDesires(d.desires)
    } catch (e) {
      toast.error((e as Error).message)
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

  const meter = (label: string, val: number, min = 0, max = 1) => {
    const pct = Math.max(0, Math.min(100, Math.round(((val - min) / (max - min)) * 100)))
    return (
      <div key={label} className="space-y-1">
        <div className="flex justify-between text-xs">
          <span style={{ color: 'var(--text-2)' }}>{label}</span>
          <span className="font-mono-num font-medium">{val.toFixed(2)}</span>
        </div>
        <div className="h-2 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--surface-2)' }}>
          <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: 'var(--accent)' }} />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* 顶部子页签：身心状态 / 心事欲望 / 日记本一屏直达 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {[
            { id: 'body' as const, label: '此刻身心', icon: Heart, count: body?.causes.length ?? 0 },
            { id: 'desires' as const, label: '心事与欲望', icon: Sparkles, count: desires.length },
            { id: 'diary' as const, label: '日记本', icon: BookOpen, count: diary.dates.length },
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
      </div>

      {/* 1) 此刻身心与情绪来由 */}
      {tab === 'body' && body && (
        <section className="grid grid-cols-1 lg:grid-cols-5 gap-5">
          <div className="lg:col-span-2 acg-card p-5 space-y-4">
            <h3 className="text-[15px] font-semibold flex items-center gap-2">
              <Heart className="w-4 h-4" style={{ color: 'var(--accent)' }} />
              此刻身心状态
            </h3>
            <p className="font-voice text-sm p-3.5 rounded-xl border leading-relaxed" style={{ backgroundColor: 'var(--surface-2)', borderColor: 'var(--border)' }}>
              {body.facts}
            </p>
            <div className="space-y-3">
              {meter('生理精力', body.state.energy, 0, 1)}
              {meter('睡眠债', body.state.sleepDebt, 0, 1)}
              {meter('愉悦度 (Pleasure)', body.state.mood.p, -1, 1)}
              {meter('唤醒度 (Arousal)', body.state.mood.a, -1, 1)}
              {meter('掌控感 (Dominance)', body.state.mood.d, -1, 1)}
            </div>
          </div>

          <div className="lg:col-span-3 acg-card p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-semibold">情绪来由记录</h3>
              <span className="text-xs font-mono-num" style={{ color: 'var(--text-2)' }}>最近 {body.causes.length} 条</span>
            </div>
            {body.causes.length === 0 ? (
              <p className="text-sm font-voice py-12 text-center" style={{ color: 'var(--text-2)' }}>
                最近没有明显的情绪起伏。
              </p>
            ) : (
              <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                {body.causes.map((c) => (
                  <div
                    key={c.id}
                    className="p-3 rounded-xl border flex items-start justify-between gap-3"
                    style={{ backgroundColor: 'var(--surface-2)', borderColor: 'var(--border)' }}
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="acg-pill py-0.5 text-[11px]">{c.affectKind}</span>
                        <span className="text-[11px]" style={{ color: 'var(--text-2)' }}>{c.source}</span>
                      </div>
                      <p className="font-voice text-sm break-words">{c.text}</p>
                    </div>
                    <span className="text-[11px] font-mono-num shrink-0" style={{ color: 'var(--text-2)' }}>
                      {c.createdAt.slice(5, 16)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* 2) 心事与欲望板（状态筛选 + 搜索 + 分页，永不无限拉长） */}
      {tab === 'desires' && (
        <section className="acg-card p-5 space-y-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="flex flex-wrap gap-1.5">
              {[
                { id: 'all' as const, label: '全部', count: desireCounts.all },
                { id: 'working' as const, label: '进行中', count: desireCounts.working },
                { id: 'seed' as const, label: '萌芽', count: desireCounts.seed },
                { id: 'closed' as const, label: '已完结', count: desireCounts.closed },
              ].map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => {
                    setDesireFilter(f.id)
                    setDesirePage(1)
                  }}
                  className="acg-pill cursor-pointer text-xs"
                  style={{
                    backgroundColor: desireFilter === f.id ? 'var(--accent-soft)' : 'var(--surface-2)',
                    color: desireFilter === f.id ? 'var(--accent)' : 'var(--text-2)',
                    borderColor: desireFilter === f.id ? 'var(--accent)' : 'var(--border)',
                  }}
                >
                  {f.label} <span className="font-mono-num opacity-80">({f.count})</span>
                </button>
              ))}
            </div>

            <div className="acg-input-box w-full md:w-64">
              <Search className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-2)' }} />
              <input
                type="search"
                value={desireQuery}
                onChange={(e) => {
                  setDesireQuery(e.target.value)
                  setDesirePage(1)
                }}
                placeholder="筛选念头或起因..."
                className="acg-input-bare text-xs"
              />
            </div>
          </div>

          {pagedDesires.length === 0 ? (
            <p className="text-sm font-voice py-10 text-center" style={{ color: 'var(--text-2)' }}>
              这个分类下暂时没有念头。
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                {pagedDesires.map((d) => {
                  const st = STAGE_META[d.stage] ?? { label: d.stage, color: 'var(--text-2)' }
                  const done = d.stage === 'fulfilled' || d.stage === 'abandoned'
                  return (
                    <div
                      key={d.id}
                      className="p-4 rounded-xl border space-y-2.5 flex flex-col justify-between"
                      style={{ backgroundColor: 'var(--surface-2)', borderColor: 'var(--border)' }}
                    >
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="acg-pill text-[11px]" style={{ color: st.color }}>{st.label}</span>
                          <span className="text-[11px] font-mono-num" style={{ color: 'var(--text-2)' }}>
                            {d.source} · {d.exitKind} · 强度 {Math.round(d.strength * 100)}%
                          </span>
                        </div>
                        <div className="font-voice text-[15px] font-medium">{d.want}</div>
                        {d.why && <p className="text-xs line-clamp-2" style={{ color: 'var(--text-2)' }}>起因：{d.why}</p>}
                        {d.progressNote && (
                          <p className="text-xs px-2.5 py-1.5 rounded-lg" style={{ backgroundColor: 'var(--surface)', color: 'var(--text-2)' }}>
                            {d.progressNote}
                          </p>
                        )}
                      </div>

                      {!done && (
                        <div className="flex items-center gap-2 pt-1">
                          <button type="button" onClick={() => { void runDesireOp(d.id, 'boost') }} className="acg-btn acg-btn-soft text-xs py-1 px-2.5">
                            <ArrowUpCircle className="w-3.5 h-3.5" />
                            轻推一下
                          </button>
                          {(d.stage === 'waiting_approval' || d.stage === 'waiting_credential' || d.stage === 'faded') && (
                            <button type="button" onClick={() => { void runDesireOp(d.id, 'resume') }} className="acg-btn acg-btn-soft text-xs py-1 px-2.5">
                              <PlayCircle className="w-3.5 h-3.5" />
                              恢复推进
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => { void runDesireOp(d.id, 'abandon') }}
                            className="acg-btn acg-btn-soft text-xs py-1 px-2.5 ml-auto"
                            style={{ color: 'var(--danger)' }}
                          >
                            <XCircle className="w-3.5 h-3.5" />
                            收起
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-between pt-2 border-t text-xs" style={{ borderColor: 'var(--border)', color: 'var(--text-2)' }}>
                  <span className="font-mono-num">
                    显示 {(safePage - 1) * DESIRE_PAGE_SIZE + 1}–{Math.min(safePage * DESIRE_PAGE_SIZE, filteredDesires.length)} / 共 {filteredDesires.length} 条
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={safePage <= 1}
                      onClick={() => setDesirePage((p) => Math.max(1, p - 1))}
                      className="acg-btn acg-btn-soft py-1 px-2.5 text-xs disabled:opacity-40"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                      上一页
                    </button>
                    <span className="font-mono-num px-2">{safePage} / {totalPages}</span>
                    <button
                      type="button"
                      disabled={safePage >= totalPages}
                      onClick={() => setDesirePage((p) => Math.min(totalPages, p + 1))}
                      className="acg-btn acg-btn-soft py-1 px-2.5 text-xs disabled:opacity-40"
                    >
                      下一页
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* 3) 书页式日记阅读器（一屏直达、左侧目录定高滚动、去重日期双标题） */}
      {tab === 'diary' && (
        <section className="acg-card p-5 space-y-4">
          {diary.dates.length === 0 ? (
            <p className="text-sm font-voice py-12 text-center" style={{ color: 'var(--text-2)' }}>
              日记本还是空白的，等夜深她有感触时会自己落笔。
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
              <div className="md:col-span-3 space-y-2.5">
                <div className="acg-input-box">
                  <Search className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-2)' }} />
                  <input
                    type="search"
                    value={diaryQuery}
                    onChange={(e) => setDiaryQuery(e.target.value)}
                    placeholder="按日期筛选..."
                    className="acg-input-bare text-xs font-mono-num"
                  />
                </div>
                <div className="space-y-1 max-h-[480px] overflow-y-auto pr-1">
                  {filteredDiaryDates.map((dt) => (
                    <button
                      key={dt}
                      type="button"
                      onClick={() => { void openDiaryDate(dt) }}
                      className="w-full text-left px-3 py-2 rounded-xl text-xs font-mono-num cursor-pointer border transition-colors"
                      style={{
                        backgroundColor: diary.activeDate === dt ? 'var(--accent-soft)' : 'var(--surface-2)',
                        borderColor: diary.activeDate === dt ? 'var(--accent)' : 'transparent',
                        color: diary.activeDate === dt ? 'var(--accent)' : 'var(--text)',
                        fontWeight: diary.activeDate === dt ? 600 : 400,
                      }}
                    >
                      {dt}
                    </button>
                  ))}
                  {filteredDiaryDates.length === 0 && (
                    <p className="text-xs text-center py-6" style={{ color: 'var(--text-2)' }}>无匹配日期</p>
                  )}
                </div>
              </div>

              <article
                className="md:col-span-9 p-6 rounded-2xl border max-h-[540px] overflow-y-auto"
                style={{ backgroundColor: 'var(--surface-2)', borderColor: 'var(--border)' }}
              >
                <div className="flex items-center justify-between pb-3 mb-4 border-b" style={{ borderColor: 'var(--border)' }}>
                  <h4 className="text-base font-bold font-mono-num">{diary.activeDate ?? '—'}</h4>
                  <span className="text-xs font-mono-num" style={{ color: 'var(--text-2)' }}>
                    {cleanDiaryText.length} 字
                  </span>
                </div>
                <div className="font-voice text-[15px] leading-[1.9] whitespace-pre-wrap">
                  {cleanDiaryText || '（这一天没有写下文字）'}
                </div>
              </article>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
