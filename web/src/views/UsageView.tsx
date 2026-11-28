import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  CartesianGrid,
} from 'recharts'
import { Activity, AlertTriangle, KeyRound, RefreshCw, Search } from 'lucide-react'
import { api, setCsrfToken } from '../lib/api.ts'
import type { TokensResponse, TraceItem } from '../lib/api.ts'
import {
  AlertDialog,
  Badge,
  Button,
  Disclosure,
  EmptyState,
  ErrorState,
  FilterChip,
  Meter,
  useDelayedLoading,
} from '../components/ui.tsx'
import type { BadgeTone } from '../components/ui.tsx'

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: Array<{ name?: string; value?: number; color?: string }>
  label?: string
}) {
  if (!active || !payload || payload.length === 0) return null
  return (
    <div
      className="rounded-[10px] border px-3 py-2.5 text-[12px] space-y-1.5"
      style={{
        backgroundColor: 'var(--surface-elevated)',
        borderColor: 'var(--gray-6)',
        boxShadow: 'var(--shadow-md)',
      }}
    >
      <div className="font-mono-num font-semibold" style={{ color: 'var(--gray-12)' }}>{label}</div>
      {payload.map((entry, idx) => (
        <div key={idx} className="flex items-center justify-between gap-4">
          <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--gray-11)' }}>
            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
            {entry.name}
          </span>
          <span className="font-mono-num font-medium" style={{ color: 'var(--gray-12)' }}>
            {typeof entry.value === 'number' ? entry.value.toLocaleString('zh-CN') : entry.value}
          </span>
        </div>
      ))}
    </div>
  )
}

const LEVEL_TONE: Record<string, BadgeTone> = {
  error: 'danger',
  warn: 'warn',
  info: 'neutral',
}

export function UsageView({ botId, onWiped }: { botId: string; onWiped: () => void }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tokens, setTokens] = useState<TokensResponse | null>(null)
  const [traces, setTraces] = useState<TraceItem[]>([])
  const [levelFilter, setLevelFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all')
  const [traceQuery, setTraceQuery] = useState('')

  const [wipeOpen, setWipeOpen] = useState(false)
  const [wiping, setWiping] = useState(false)

  const [curPwd, setCurPwd] = useState('')
  const [nextPwd, setNextPwd] = useState('')
  const [pwdErr, setPwdErr] = useState('')
  const [pwdSaving, setPwdSaving] = useState(false)
  const curPwdRef = useRef<HTMLInputElement | null>(null)
  const nextPwdRef = useRef<HTMLInputElement | null>(null)
  const showSkeleton = useDelayedLoading(loading && !tokens, 180)

  const loadAll = async () => {
    setLoading(true)
    setError('')
    try {
      const [t, tr] = await Promise.all([api.tokens(botId), api.traces(botId, 120)])
      setTokens(t)
      setTraces(tr.traces)
    } catch (e) {
      const msg = (e as Error).message
      setError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadAll()
  }, [botId])

  const confirmWipe = async () => {
    setWiping(true)
    try {
      await api.wipe(botId, botId)
      setWipeOpen(false)
      toast.success(`已安全清空 ${botId} 的运行记忆（人设与表情包保留）`)
      onWiped()
      void loadAll()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setWiping(false)
    }
  }

  const handleChangePwd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!curPwd.trim()) {
      setPwdErr('请输入当前口令。')
      curPwdRef.current?.focus()
      return
    }
    if (nextPwd.trim().length < 8) {
      setPwdErr('新口令长度至少需要 8 位字符。')
      nextPwdRef.current?.focus()
      return
    }
    setPwdErr('')
    setPwdSaving(true)
    try {
      const res = await api.changePassword(curPwd, nextPwd)
      setCsrfToken(res.csrf)
      setCurPwd('')
      setNextPwd('')
      toast.success('管理员口令已更新')
    } catch (err) {
      const msg = (err as Error).message
      setPwdErr(`${msg}，请核对当前口令后重试。`)
      curPwdRef.current?.focus()
    } finally {
      setPwdSaving(false)
    }
  }

  const todayHitPct = tokens && tokens.today.totalInput > 0
    ? Math.round((tokens.today.totalCached / tokens.today.totalInput) * 100)
    : 0
  const weekHitPct = tokens && tokens.week.totalInput > 0
    ? Math.round((tokens.week.totalCached / tokens.week.totalInput) * 100)
    : 0
  const sceneData = useMemo(() => (
    tokens
      ? Object.entries(tokens.week.byScene).map(([scene, s]) => ({
        scene,
        input: s.input,
        cached: s.cached,
        output: s.output,
        calls: s.calls,
      }))
      : []
  ), [tokens])

  const filteredTraces = useMemo(() => {
    const q = traceQuery.trim().toLowerCase()
    return traces.filter((t) => {
      if (levelFilter !== 'all' && t.level !== levelFilter) return false
      if (q && !t.event.toLowerCase().includes(q) && !t.traceId.toLowerCase().includes(q)) return false
      return true
    })
  }, [traces, levelFilter, traceQuery])

  return (
    <div className="space-y-6">
      {error && !tokens && <ErrorState title="无法加载账本与诊断日志" message={error} onRetry={() => { void loadAll() }} />}

      {showSkeleton && (
        <div className="ui-panel grid grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="p-5 space-y-2">
              <div className="ui-skeleton h-3 w-24" />
              <div className="ui-skeleton h-7 w-20" />
              <div className="ui-skeleton h-3 w-28" />
            </div>
          ))}
        </div>
      )}

      {/* 1) 统一指标条（Prefix Cache、费用、消耗、自主预算） */}
      {tokens && (
        <section className="ui-panel grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x overflow-hidden">
          <div className="p-5 space-y-1.5">
            <div className="text-[12px] font-medium" style={{ color: 'var(--gray-11)' }}>今日 Prefix Cache 命中率</div>
            <div className="text-[28px] font-semibold font-mono-num leading-none" style={{ color: 'var(--accent-11)' }}>
              {todayHitPct}%
            </div>
            <div className="text-[12px] font-mono-num" style={{ color: 'var(--gray-11)' }}>近 7 日均值 {weekHitPct}%</div>
          </div>

          <div className="p-5 space-y-1.5">
            <div className="text-[12px] font-medium" style={{ color: 'var(--gray-11)' }}>今日估算费用</div>
            <div className="text-[28px] font-semibold font-mono-num leading-none">
              ¥{tokens.today.totalCostCny.toFixed(4)}
            </div>
            <div className="text-[12px] font-mono-num" style={{ color: 'var(--gray-11)' }}>
              7 日累计 ¥{tokens.week.totalCostCny.toFixed(4)}
            </div>
          </div>

          <div className="p-5 space-y-1.5">
            <div className="text-[12px] font-medium" style={{ color: 'var(--gray-11)' }}>今日输入 / 输出</div>
            <div className="text-[22px] font-semibold font-mono-num leading-tight pt-1">
              {(tokens.today.totalInput / 1000).toFixed(1)}k / {(tokens.today.totalOutput / 1000).toFixed(1)}k
            </div>
            <div className="text-[12px] font-mono-num" style={{ color: 'var(--gray-11)' }}>
              缓存复用 {(tokens.today.totalCached / 1000).toFixed(1)}k
            </div>
          </div>

          <div className="p-5 flex flex-col justify-between gap-2">
            <Meter
              label="每日自主行为预算"
              value={tokens.budget.used}
              max={Math.max(1, tokens.budget.limit)}
              displayValue={`${(tokens.budget.used / 1000).toFixed(1)}k / ${(tokens.budget.limit / 1000).toFixed(0)}k`}
              tone={tokens.budget.allowed ? 'ok' : 'danger'}
            />
            <div className="text-[12px]" style={{ color: tokens.budget.allowed ? 'var(--gray-11)' : 'var(--danger-fg)' }}>
              {tokens.budget.allowed ? '今日额度充裕' : '已触及自主额度上限'}
            </div>
          </div>
        </section>
      )}

      {/* 2) Recharts 双图（自适应深浅主题 Tooltip） */}
      {tokens && (
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="ui-panel p-5 space-y-4">
            <h2 className="text-[15px] font-semibold">近 7 日 Token 消耗与缓存复用</h2>
            <div className="h-[230px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={tokens.daily}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--gray-6)" vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'var(--gray-11)' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--gray-11)' }} axisLine={false} tickLine={false} width={44} />
                  <Tooltip content={<ChartTooltip />} />
                  <Area type="monotone" dataKey="input" name="总输入" stroke="var(--info-solid)" fill="var(--info-solid)" fillOpacity={0.14} strokeWidth={2} />
                  <Area type="monotone" dataKey="cached" name="缓存命中" stroke="var(--ok-solid)" fill="var(--ok-solid)" fillOpacity={0.22} strokeWidth={2} />
                  <Area type="monotone" dataKey="output" name="输出" stroke="var(--warn-solid)" fill="var(--warn-solid)" fillOpacity={0.16} strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="ui-panel p-5 space-y-4">
            <h2 className="text-[15px] font-semibold">按场景分布（近 7 日）</h2>
            <div className="h-[230px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={sceneData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--gray-6)" vertical={false} />
                  <XAxis dataKey="scene" tick={{ fontSize: 11, fill: 'var(--gray-11)' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--gray-11)' }} axisLine={false} tickLine={false} width={44} />
                  <Tooltip content={<ChartTooltip />} />
                  <Bar dataKey="cached" name="缓存命中" stackId="a" fill="var(--ok-solid)" radius={[0, 0, 3, 3]} />
                  <Bar dataKey="output" name="输出" stackId="a" fill="var(--warn-solid)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </section>
      )}

      {/* 3) Trace 诊断检视器（筛选 + 搜索 + 无障碍折叠） */}
      <section className="ui-panel p-5 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-3 border-b" style={{ borderColor: 'var(--gray-6)' }}>
          <div className="flex items-center gap-2">
            <h2 className="text-[15px] font-semibold">Trace 诊断日志</h2>
            <span className="font-mono-num text-[12px]" style={{ color: 'var(--gray-11)' }}>
              {filteredTraces.length}&nbsp;条
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1" role="group" aria-label="按日志级别筛选">
              {(['all', 'info', 'warn', 'error'] as const).map((lv) => (
                <FilterChip
                  key={lv}
                  pressed={levelFilter === lv}
                  onClick={() => setLevelFilter(lv)}
                >
                  {lv === 'all' ? '全部' : lv}
                </FilterChip>
              ))}
            </div>

            <div className="ui-input-group w-44">
              <Search className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--gray-10)' }} aria-hidden="true" />
              <label htmlFor="trace-search" className="sr-only">搜索事件名</label>
              <input
                id="trace-search"
                type="search"
                value={traceQuery}
                onChange={(e) => setTraceQuery(e.target.value)}
                placeholder="筛选事件名…"
                className="ui-input-bare font-mono-num"
              />
            </div>

            <Button variant="secondary" size="icon" aria-label="刷新诊断日志" loading={loading} onClick={() => { void loadAll() }}>
              {!loading && <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />}
            </Button>
          </div>
        </div>

        <div className="max-h-[380px] overflow-y-auto pr-1">
          {filteredTraces.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="没有符合条件的诊断事件"
              description="调整级别或事件筛选条件，或稍后刷新查看最新运行轨迹。"
              action={
                (levelFilter !== 'all' || traceQuery) ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setLevelFilter('all')
                      setTraceQuery('')
                    }}
                  >
                    重置筛选
                  </Button>
                ) : undefined
              }
            />
          ) : (
            filteredTraces.map((tr, i) => (
              <Disclosure
                key={tr.id ?? i}
                header={
                  <div className="flex items-center justify-between gap-3 font-mono-num text-[12px] min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge tone={LEVEL_TONE[tr.level] ?? 'neutral'} className="uppercase text-[10px]">
                        {tr.level}
                      </Badge>
                      <span className="font-semibold truncate" style={{ color: 'var(--gray-12)' }} translate="no">
                        {tr.event}
                      </span>
                      <span className="hidden sm:inline truncate" style={{ color: 'var(--gray-11)' }} translate="no">
                        {tr.traceId}
                      </span>
                    </div>
                    <time className="shrink-0 text-[11px]" style={{ color: 'var(--gray-11)' }}>
                      {tr.createdAt?.slice(5, 19)}
                    </time>
                  </div>
                }
              >
                <pre
                  className="p-3 rounded-[8px] text-[11px] font-mono-num overflow-x-auto m-0"
                  style={{ backgroundColor: 'var(--surface-subtle)', color: 'var(--gray-11)' }}
                >
                  {JSON.stringify(tr.data, null, 2)}
                </pre>
              </Disclosure>
            ))
          )}
        </div>
      </section>

      {/* 4) 安全设置与危险操作区 */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <form onSubmit={(e) => { void handleChangePwd(e) }} className="ui-panel p-5 space-y-4" noValidate>
          <div className="space-y-0.5">
            <h2 className="text-[15px] font-semibold flex items-center gap-2">
              <KeyRound className="w-4 h-4" style={{ color: 'var(--gray-11)' }} aria-hidden="true" />
              修改管理后台口令
            </h2>
            <p className="text-[12px]" style={{ color: 'var(--gray-11)' }}>
              更新后立即刷新当前会话凭证，旧口令即刻失效。
            </p>
          </div>

          <div className="space-y-3">
            <div className="space-y-1">
              <label htmlFor="cur-pwd" className="block text-[12px] font-medium">当前口令</label>
              <input
                ref={curPwdRef}
                id="cur-pwd"
                type="password"
                autoComplete="current-password"
                spellCheck={false}
                value={curPwd}
                onChange={(e) => {
                  setCurPwd(e.target.value)
                  if (pwdErr) setPwdErr('')
                }}
                placeholder="输入当前口令…"
                className="ui-input"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="next-pwd" className="block text-[12px] font-medium">新口令（至少 8 位）</label>
              <input
                ref={nextPwdRef}
                id="next-pwd"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={nextPwd}
                onChange={(e) => {
                  setNextPwd(e.target.value)
                  if (pwdErr) setPwdErr('')
                }}
                placeholder="输入新口令…"
                className="ui-input"
              />
            </div>
          </div>

          {pwdErr && (
            <p role="alert" aria-live="polite" className="text-[12px]" style={{ color: 'var(--danger-fg)' }}>
              {pwdErr}
            </p>
          )}

          <div>
            <Button type="submit" variant="secondary" loading={pwdSaving}>
              {pwdSaving ? '更新中…' : '更新后台口令'}
            </Button>
          </div>
        </form>

        <div
          className="ui-panel p-5 flex flex-col justify-between gap-4"
          style={{ borderColor: 'var(--danger-border)' }}
        >
          <div className="space-y-2">
            <h2 className="text-[15px] font-semibold flex items-center gap-2" style={{ color: 'var(--danger-fg)' }}>
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
              危险操作：清空运行记忆
            </h2>
            <p className="text-[13px] leading-relaxed" style={{ color: 'var(--gray-11)' }}>
              将原子清空 <code translate="no">{botId}</code> 的对话历史、记忆池、人物关系、情绪来由、心事、作品与账本。
              <strong style={{ color: 'var(--gray-12)' }}>人设包、表情包图库与配置完好保留。</strong>
            </p>
          </div>

          <div>
            <Button variant="destructiveSoft" onClick={() => setWipeOpen(true)}>
              清空运行记忆…
            </Button>
          </div>
        </div>
      </section>

      <AlertDialog
        open={wipeOpen}
        title={`清空 ${botId} 的全部运行记忆？`}
        description="此操作不可撤销，会立即清空对话历史、记忆池、人物关系、情绪、心事、作品与账本记录（人设与表情包不受影响）。"
        confirmLabel="确认清空记忆"
        confirmTextRequired={botId}
        confirmInputPlaceholder={`输入 ${botId}…`}
        destructive
        loading={wiping}
        onCancel={() => setWipeOpen(false)}
        onConfirm={() => { void confirmWipe() }}
      />
    </div>
  )
}
