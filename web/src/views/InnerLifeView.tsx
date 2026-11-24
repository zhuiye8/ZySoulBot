import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Heart, Sparkles, BookOpen, ArrowUpCircle, PlayCircle, XCircle } from 'lucide-react'
import { api } from '../lib/api.ts'
import type { BodyState, DesireRecord, EmotionCause } from '../lib/api.ts'

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

export function InnerLifeView({ botId }: { botId: string }) {
  const [body, setBody] = useState<{ state: BodyState; facts: string; causes: EmotionCause[] } | null>(null)
  const [desires, setDesires] = useState<DesireRecord[]>([])
  const [diary, setDiary] = useState<{ dates: string[]; activeDate: string | null; content: string | null }>({
    dates: [],
    activeDate: null,
    content: null,
  })

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
    <div className="space-y-6">
      {/* 身心节律与情绪来由 */}
      {body && (
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
            <h3 className="text-[15px] font-semibold">情绪来由记录</h3>
            {body.causes.length === 0 ? (
              <p className="text-sm font-voice py-10 text-center" style={{ color: 'var(--text-2)' }}>
                最近没有明显的情绪起伏。
              </p>
            ) : (
              <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                {body.causes.map((c) => (
                  <div
                    key={c.id}
                    className="p-3 rounded-xl border flex items-start justify-between gap-3"
                    style={{ backgroundColor: 'var(--surface-2)', borderColor: 'var(--border)' }}
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="acg-pill py-0.5 text-[11px]">{c.affectKind}</span>
                        <span className="text-[11px]" style={{ color: 'var(--text-2)' }}>{c.source}</span>
                      </div>
                      <p className="font-voice text-sm">{c.text}</p>
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

      {/* 心事与欲望板 */}
      <section className="acg-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-[15px] font-semibold flex items-center gap-2">
            <Sparkles className="w-4 h-4" style={{ color: 'var(--accent)' }} />
            心事与欲望板
          </h3>
          <span className="text-xs font-mono-num" style={{ color: 'var(--text-2)' }}>共 {desires.length} 条</span>
        </div>

        {desires.length === 0 ? (
          <p className="text-sm font-voice py-8 text-center" style={{ color: 'var(--text-2)' }}>
            此刻心里静悄悄的，还没有冒出新念头。
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {desires.map((d) => {
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
                    {d.why && <p className="text-xs" style={{ color: 'var(--text-2)' }}>起因：{d.why}</p>}
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
        )}
      </section>

      {/* 书页式日记阅读器 */}
      <section className="acg-card p-5 space-y-4">
        <h3 className="text-[15px] font-semibold flex items-center gap-2">
          <BookOpen className="w-4 h-4" style={{ color: 'var(--accent)' }} />
          她的日记本
        </h3>
        {diary.dates.length === 0 ? (
          <p className="text-sm font-voice py-8 text-center" style={{ color: 'var(--text-2)' }}>
            日记本还是空白的，等夜深她有感触时会自己落笔。
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="space-y-1 max-h-[340px] overflow-y-auto pr-1">
              {diary.dates.map((dt) => (
                <button
                  key={dt}
                  type="button"
                  onClick={() => { void openDiaryDate(dt) }}
                  className="w-full text-left px-3 py-2 rounded-xl text-xs font-mono-num cursor-pointer border"
                  style={{
                    backgroundColor: diary.activeDate === dt ? 'var(--accent-soft)' : 'var(--surface-2)',
                    borderColor: diary.activeDate === dt ? 'var(--accent)' : 'transparent',
                    color: diary.activeDate === dt ? 'var(--accent)' : 'var(--text)',
                  }}
                >
                  {dt}
                </button>
              ))}
            </div>
            <article
              className="md:col-span-3 p-6 rounded-2xl border font-voice text-[15px] leading-[1.9] whitespace-pre-wrap"
              style={{ backgroundColor: 'var(--surface-2)', borderColor: 'var(--border)' }}
            >
              <div className="text-xs font-mono-num mb-3" style={{ color: 'var(--text-2)' }}>
                {diary.activeDate}
              </div>
              {diary.content || '（这一天没有写下文字）'}
            </article>
          </div>
        )}
      </section>
    </div>
  )
}
