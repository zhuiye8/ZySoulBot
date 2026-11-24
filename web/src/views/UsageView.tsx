import { useEffect, useState } from 'react'
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
import { Zap, Activity, AlertTriangle, KeyRound, RefreshCw } from 'lucide-react'
import { api, setCsrfToken } from '../lib/api.ts'
import type { TokensResponse, TraceItem } from '../lib/api.ts'

export function UsageView({ botId, onWiped }: { botId: string; onWiped: () => void }) {
  const [tokens, setTokens] = useState<TokensResponse | null>(null)
  const [traces, setTraces] = useState<TraceItem[]>([])
  const [levelFilter, setLevelFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all')

  const [wipeConfirm, setWipeConfirm] = useState('')
  const [wiping, setWiping] = useState(false)

  const [curPwd, setCurPwd] = useState('')
  const [nextPwd, setNextPwd] = useState('')

  const loadAll = async () => {
    try {
      const [t, tr] = await Promise.all([api.tokens(botId), api.traces(botId, 120)])
      setTokens(t)
      setTraces(tr.traces)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  useEffect(() => {
    void loadAll()
  }, [botId])

  const handleWipe = async () => {
    if (wipeConfirm.trim() !== botId) {
      toast.error(`请输入 ${botId} 确认清空`)
      return
    }
    setWiping(true)
    try {
      await api.wipe(botId, botId)
      setWipeConfirm('')
      toast.success(`已安全清空 ${botId} 的运行记忆（人设与技能文件完好保留）`)
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
    try {
      const res = await api.changePassword(curPwd, nextPwd)
      setCsrfToken(res.csrf)
      setCurPwd('')
      setNextPwd('')
      toast.success('管理员密码已更新')
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const todayHitPct = tokens && tokens.today.totalInput > 0
    ? Math.round((tokens.today.totalCached / tokens.today.totalInput) * 100)
    : 0
  const weekHitPct = tokens && tokens.week.totalInput > 0
    ? Math.round((tokens.week.totalCached / tokens.week.totalInput) * 100)
    : 0
  const sceneData = tokens
    ? Object.entries(tokens.week.byScene).map(([scene, s]) => ({
      scene,
      input: s.input,
      cached: s.cached,
      output: s.output,
      calls: s.calls,
    }))
    : []

  const filteredTraces = levelFilter === 'all' ? traces : traces.filter((t) => t.level === levelFilter)

  return (
    <div className="space-y-6">
      {/* 1) Prefix Cache & 成本看板 */}
      {tokens && (
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="acg-card p-5 space-y-1">
            <div className="text-xs flex items-center gap-1.5" style={{ color: 'var(--text-2)' }}>
              <Zap className="w-3.5 h-3.5" style={{ color: 'var(--info)' }} />
              今日 Prefix Cache 命中率
            </div>
            <div className="text-3xl font-bold font-mono-num" style={{ color: 'var(--info)' }}>{todayHitPct}%</div>
            <div className="text-xs font-mono-num" style={{ color: 'var(--text-2)' }}>近 7 日均值 {weekHitPct}%</div>
          </div>

          <div className="acg-card p-5 space-y-1">
            <div className="text-xs" style={{ color: 'var(--text-2)' }}>今日估算费用</div>
            <div className="text-3xl font-bold font-mono-num">¥{tokens.today.totalCostCny.toFixed(4)}</div>
            <div className="text-xs font-mono-num" style={{ color: 'var(--text-2)' }}>
              7 日累计 ¥{tokens.week.totalCostCny.toFixed(4)}
            </div>
          </div>

          <div className="acg-card p-5 space-y-1">
            <div className="text-xs" style={{ color: 'var(--text-2)' }}>今日输入 / 输出</div>
            <div className="text-2xl font-bold font-mono-num">
              {(tokens.today.totalInput / 1000).toFixed(1)}k / {(tokens.today.totalOutput / 1000).toFixed(1)}k
            </div>
            <div className="text-xs font-mono-num" style={{ color: 'var(--text-2)' }}>
              缓存复用 {(tokens.today.totalCached / 1000).toFixed(1)}k
            </div>
          </div>

          <div className="acg-card p-5 space-y-2">
            <div className="text-xs" style={{ color: 'var(--text-2)' }}>每日自主行为预算</div>
            <div className="text-lg font-bold font-mono-num">
              {(tokens.budget.used / 1000).toFixed(1)}k / {(tokens.budget.limit / 1000).toFixed(0)}k
            </div>
            <div className="h-2 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--surface-2)' }}>
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min(100, Math.round((tokens.budget.used / Math.max(1, tokens.budget.limit)) * 100))}%`,
                  backgroundColor: tokens.budget.allowed ? 'var(--ok)' : 'var(--danger)',
                }}
              />
            </div>
          </div>
        </section>
      )}

      {/* 2) Recharts 双图：7日趋势 + 按场景分布 */}
      {tokens && (
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="acg-card p-5 space-y-3">
            <h3 className="text-[15px] font-semibold">近 7 日 Token 消耗与缓存复用</h3>
            <div className="h-[230px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={tokens.daily}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'var(--text-2)' }} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--text-2)' }} />
                  <Tooltip />
                  <Area type="monotone" dataKey="input" name="总输入" stroke="#4A8FE0" fill="#4A8FE0" fillOpacity={0.18} />
                  <Area type="monotone" dataKey="cached" name="缓存命中" stroke="#26A678" fill="#26A678" fillOpacity={0.28} />
                  <Area type="monotone" dataKey="output" name="输出" stroke="#E59A32" fill="#E59A32" fillOpacity={0.2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="acg-card p-5 space-y-3">
            <h3 className="text-[15px] font-semibold">按场景分布（近 7 日）</h3>
            <div className="h-[230px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={sceneData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="scene" tick={{ fontSize: 11, fill: 'var(--text-2)' }} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--text-2)' }} />
                  <Tooltip />
                  <Bar dataKey="cached" name="缓存命中" stackId="a" fill="#26A678" radius={[0, 0, 4, 4]} />
                  <Bar dataKey="output" name="输出" stackId="a" fill="#E59A32" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </section>
      )}

      {/* 3) 实时 Trace 检视器 */}
      <section className="acg-card p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[15px] font-semibold flex items-center gap-2">
            <Activity className="w-4 h-4" style={{ color: 'var(--accent)' }} />
            最近 Trace 诊断日志（{filteredTraces.length}）
          </h3>
          <div className="flex items-center gap-1.5">
            {(['all', 'info', 'warn', 'error'] as const).map((lv) => (
              <button
                key={lv}
                type="button"
                onClick={() => setLevelFilter(lv)}
                className="acg-pill cursor-pointer"
                style={{
                  backgroundColor: levelFilter === lv ? 'var(--accent-soft)' : 'var(--surface-2)',
                  color: levelFilter === lv ? 'var(--accent)' : 'var(--text-2)',
                }}
              >
                {lv}
              </button>
            ))}
            <button type="button" aria-label="刷新日志" onClick={() => { void loadAll() }} className="acg-btn acg-btn-soft p-1.5">
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="space-y-1.5 max-h-[340px] overflow-y-auto pr-1">
          {filteredTraces.length === 0 ? (
            <p className="text-xs text-center py-6" style={{ color: 'var(--text-2)' }}>暂无诊断事件</p>
          ) : (
            filteredTraces.map((tr, i) => (
              <details
                key={tr.id ?? i}
                className="p-2.5 rounded-xl border text-xs"
                style={{ backgroundColor: 'var(--surface-2)', borderColor: 'var(--border)' }}
              >
                <summary className="flex items-center justify-between gap-2 cursor-pointer list-none font-mono-num">
                  <span className="flex items-center gap-2 min-w-0">
                    <span
                      className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase"
                      style={{
                        backgroundColor: tr.level === 'error' ? 'rgba(223,83,101,0.16)' : tr.level === 'warn' ? 'rgba(229,154,50,0.16)' : 'var(--accent-soft)',
                        color: tr.level === 'error' ? 'var(--danger)' : tr.level === 'warn' ? 'var(--warn)' : 'var(--accent)',
                      }}
                    >
                      {tr.level}
                    </span>
                    <strong className="truncate">{tr.event}</strong>
                    <span style={{ color: 'var(--text-2)' }}>{tr.traceId}</span>
                  </span>
                  <span style={{ color: 'var(--text-2)' }} className="shrink-0">{tr.createdAt?.slice(5, 19)}</span>
                </summary>
                <pre className="mt-2 pt-2 border-t text-[11px] font-mono-num overflow-x-auto m-0" style={{ borderColor: 'var(--border)', color: 'var(--text-2)' }}>
                  {JSON.stringify(tr.data, null, 2)}
                </pre>
              </details>
            ))
          )}
        </div>
      </section>

      {/* 4) 安全区：修改口令 & 安全清空单 Bot 记忆 */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <form onSubmit={(e) => { void handleChangePwd(e) }} className="acg-card p-5 space-y-3">
          <h3 className="text-[15px] font-semibold flex items-center gap-2">
            <KeyRound className="w-4 h-4" style={{ color: 'var(--accent)' }} />
            修改管理后台口令
          </h3>
          <input
            type="password"
            value={curPwd}
            onChange={(e) => setCurPwd(e.target.value)}
            placeholder="当前口令"
            className="acg-input w-full"
          />
          <input
            type="password"
            value={nextPwd}
            onChange={(e) => setNextPwd(e.target.value)}
            placeholder="新口令（至少 8 位）"
            className="acg-input w-full"
          />
          <button type="submit" className="acg-btn acg-btn-primary text-xs">更新口令</button>
        </form>

        <div className="acg-card p-5 space-y-3" style={{ borderColor: 'rgba(223,83,101,0.4)' }}>
          <h3 className="text-[15px] font-semibold flex items-center gap-2" style={{ color: 'var(--danger)' }}>
            <AlertTriangle className="w-4 h-4" />
            一键安全清空运行记忆（不动人设）
          </h3>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-2)' }}>
            将原子清空 <code>{botId}</code> 的对话历史、记忆池、人物关系、情绪、欲望、作品与账本；
            <strong>人设包、表情包库与工作区技能文件完好保留</strong>。
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={wipeConfirm}
              onChange={(e) => setWipeConfirm(e.target.value)}
              placeholder={`输入 ${botId} 确认清空`}
              className="acg-input flex-1 text-xs font-mono-num"
            />
            <button
              type="button"
              disabled={wiping || wipeConfirm.trim() !== botId}
              onClick={() => { void handleWipe() }}
              className="acg-btn text-xs disabled:opacity-45"
              style={{ backgroundColor: 'var(--danger)', color: '#fff' }}
            >
              {wiping ? '清空中...' : '确认清空'}
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
