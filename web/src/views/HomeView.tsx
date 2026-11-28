import {
  ArrowRight,
  BellRing,
  Bookmark,
  MapPin,
  Radio,
  RefreshCw,
} from 'lucide-react'
import type { OverviewResponse } from '../lib/api.ts'
import type { ViewId } from '../lib/router.ts'
import {
  AppLink,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Meter,
  useDelayedLoading,
} from '../components/ui.tsx'
import type { BadgeTone } from '../components/ui.tsx'

function moodMeta(p: number, a: number): { text: string; tone: BadgeTone } {
  if (p >= 0.35 && a >= 0.2) return { text: '雀跃明朗', tone: 'ok' }
  if (p >= 0.2) return { text: '温柔平和', tone: 'accent' }
  if (p <= -0.25 && a >= 0.2) return { text: '有点紧绷', tone: 'danger' }
  if (p <= -0.2) return { text: '些许低落', tone: 'warn' }
  return { text: '安静惬意', tone: 'info' }
}

const AFFECT_LABEL: Record<string, string> = {
  praised: '开心',
  affection: '亲近',
  curiosity: '好奇',
  humor: '愉悦',
  annoyed: '烦躁',
  hurt: '委屈',
  rejected: '受挫',
  conflict: '冲突',
  sadness: '低落',
  uneasy: '不安',
  guilty: '愧疚',
  boredom: '倦意',
  neutral: '平静',
}

function HomeSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="正在加载概览数据">
      <div className="ui-panel p-6 flex flex-col lg:flex-row gap-6 justify-between">
        <div className="flex items-start gap-4 flex-1">
          <div className="ui-skeleton w-14 h-14 shrink-0" />
          <div className="space-y-2.5 flex-1">
            <div className="ui-skeleton h-6 w-40" />
            <div className="ui-skeleton h-4 w-full max-w-[420px]" />
          </div>
        </div>
        <div className="w-full lg:w-64 space-y-2.5">
          <div className="ui-skeleton h-4 w-full" />
          <div className="ui-skeleton h-2 w-full" />
          <div className="ui-skeleton h-3 w-3/4" />
        </div>
      </div>
      <div className="ui-panel grid grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="p-5 space-y-2.5">
            <div className="ui-skeleton h-3 w-20" />
            <div className="ui-skeleton h-7 w-16" />
            <div className="ui-skeleton h-3 w-28" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function HomeView({
  botId,
  data,
  loading,
  error,
  onRetry,
}: {
  botId: string
  data: OverviewResponse | null
  loading: boolean
  error: string
  onRetry: () => void
}) {
  const showSkeleton = useDelayedLoading(loading && !data, 160)

  if (error && !data) {
    return <ErrorState title="无法读取角色概览" message={error} onRetry={onRetry} />
  }

  if (!data) {
    return showSkeleton ? <HomeSkeleton /> : null
  }

  const { bot, body, kpis, pendingApproval, missingCredentials, recentMemories, recentWorks, recentCauses } = data
  const mood = moodMeta(body.mood.p, body.mood.a)
  const energyPct = Math.round(body.energy * 100)
  const sleepPct = Math.round(body.sleepDebt * 100)
  const cachePct = Math.round(kpis.cacheHitRate * 100)
  const todoCount = kpis.pendingApprovals + kpis.missingCredentials

  const metrics: Array<{ label: string; value: string; hint: string; target: ViewId; urgent?: boolean }> = [
    {
      label: '今日对话轮次',
      value: String(kpis.todayTurns),
      hint: bot.hasTransport ? 'QQ 通道已连接' : '当前离线模式',
      target: 'memory',
    },
    {
      label: '活跃心事',
      value: String(kpis.activeDesires),
      hint: bot.proactivityEnabled ? '自主节律运行中' : '仅被动陪聊',
      target: 'life',
    },
    {
      label: '今日 Token',
      value: `${(kpis.todayTokens / 1000).toFixed(1)}k`,
      hint: `缓存 ${cachePct}% · ¥${kpis.todayCostCny.toFixed(4)}`,
      target: 'usage',
    },
    {
      label: '待你处理',
      value: String(todoCount),
      hint: todoCount > 0 ? '有等待批准或凭证' : '暂无待办事项',
      target: 'soul',
      urgent: todoCount > 0,
    },
  ]

  return (
    <div className="space-y-6">
      {/* 1) 核心状态面板：左侧伴侣当下声音，右侧生理精力指标，零嵌套卡片 */}
      <section className="ui-panel overflow-hidden">
        <div className="p-5 lg:p-6 flex flex-col lg:flex-row gap-6 lg:items-center justify-between">
          <div className="flex items-start gap-4 min-w-0 flex-1">
            <div
              className="w-14 h-14 rounded-[12px] border shrink-0 flex items-center justify-center font-voice text-[22px] font-semibold"
              style={{
                backgroundColor: 'var(--accent-2)',
                borderColor: 'var(--accent-6)',
                color: 'var(--accent-11)',
              }}
            >
              {(bot.name || bot.id).slice(0, 1)}
            </div>

            <div className="min-w-0 space-y-2 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[20px] font-semibold tracking-tight">{bot.name}</h2>
                <Badge tone={mood.tone}>{mood.text}</Badge>
                <span className="inline-flex items-center gap-1 text-[12px]" style={{ color: 'var(--gray-11)' }}>
                  <Radio
                    className="w-3.5 h-3.5"
                    style={{ color: bot.hasTransport ? 'var(--ok-solid)' : 'var(--gray-9)' }}
                    aria-hidden="true"
                  />
                  {bot.hasTransport ? '在线' : '离线'}
                </span>
                {body.activity && (
                  <span className="inline-flex items-center gap-1 text-[12px] truncate" style={{ color: 'var(--gray-11)' }}>
                    <MapPin className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--accent-9)' }} aria-hidden="true" />
                    <span className="truncate">{body.activity.place} · {body.activity.label}</span>
                  </span>
                )}
              </div>

              <p className="font-voice text-[15px] leading-[1.7] max-w-[62ch]" style={{ color: 'var(--gray-12)' }}>
                {body.activity?.thinking
                  ? `“${body.activity.thinking}”`
                  : recentCauses[0]?.text
                    ? `刚刚惦记着：${recentCauses[0].text}`
                    : `“${bot.summary || '此刻很安静，正享受着自己的独处时光。'}”`}
              </p>
            </div>
          </div>

          <div
            className="w-full lg:w-[256px] shrink-0 pt-4 lg:pt-0 lg:pl-6 border-t lg:border-t-0 lg:border-l space-y-3"
            style={{ borderColor: 'var(--gray-6)' }}
          >
            <Meter
              label="此刻精力"
              value={body.energy}
              displayValue={`${energyPct}%`}
              tone={energyPct > 45 ? 'ok' : energyPct > 20 ? 'warn' : 'danger'}
            />
            <div className="flex items-center justify-between text-[12px]" style={{ color: 'var(--gray-11)' }}>
              <span>
                睡眠债 <strong className="font-mono-num font-medium" style={{ color: sleepPct > 55 ? 'var(--warn-fg)' : 'var(--gray-12)' }}>{sleepPct}%</strong>
              </span>
              <span className="font-mono-num">
                PAD {body.mood.p.toFixed(2)} / {body.mood.a.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" loading={loading} onClick={onRetry} className="px-2">
                <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{loading ? '刷新中…' : '刷新状态'}</span>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* 2) 待处理提醒条（仅在确实有待批/缺凭证时展示，作为屏幕唯一主 CTA） */}
      {(pendingApproval || missingCredentials.length > 0) && (
        <section
          role="region"
          aria-label="待处理事项"
          className="rounded-[12px] border px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          style={{ backgroundColor: 'var(--warn-bg)', borderColor: 'var(--warn-border)' }}
        >
          <div className="flex items-start gap-3 min-w-0">
            <BellRing className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--warn-fg)' }} aria-hidden="true" />
            <div className="min-w-0 space-y-0.5">
              <div className="text-[14px] font-semibold" style={{ color: 'var(--warn-fg)' }}>
                有等待你确认或补充的事项
              </div>
              <p className="text-[13px] break-words" style={{ color: 'var(--warn-fg)' }}>
                {[
                  pendingApproval ? `待批准：${pendingApproval.what}` : '',
                  missingCredentials.length > 0 ? `待填写凭证：${missingCredentials.map((c) => c.label).join('、')}` : '',
                ].filter(Boolean).join(' · ')}
              </p>
            </div>
          </div>
          <AppLink
            to={{ page: 'bot', botId, view: 'soul', tab: missingCredentials.length > 0 ? 'credentials' : 'persona' }}
            className="ui-btn ui-btn-primary min-h-[34px] px-3.5 py-1.5 text-[13px] shrink-0"
          >
            前往处理
            <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
          </AppLink>
        </section>
      )}

      {/* 3) 统一指标条（单容器 1px 分割，拒绝 4 张雷同浮卡） */}
      <section className="ui-panel grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x overflow-hidden">
        {metrics.map((m) => (
          <AppLink
            key={m.label}
            to={{ page: 'bot', botId, view: m.target }}
            className="p-5 flex flex-col justify-between gap-2 transition-colors duration-150 hover:bg-[var(--gray-2)]"
          >
            <span className="text-[12px] font-medium" style={{ color: 'var(--gray-11)' }}>
              {m.label}
            </span>
            <span
              className="text-[26px] font-semibold font-mono-num tracking-tight leading-none"
              style={{ color: m.urgent ? 'var(--danger-fg)' : 'var(--gray-12)' }}
            >
              {m.value}
            </span>
            <span className="text-[12px] truncate" style={{ color: 'var(--gray-11)' }}>
              {m.hint}
            </span>
          </AppLink>
        ))}
      </section>

      {/* 4) 非对称双栏动态区（7/5 比例，内部纯 1px 细线分组，无卡套卡） */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-7 ui-panel p-5 flex flex-col">
          <div className="flex items-center justify-between gap-2 pb-3 border-b" style={{ borderColor: 'var(--gray-6)' }}>
            <h3 className="text-[15px] font-semibold">最近记在心里的事</h3>
            <AppLink
              to={{ page: 'bot', botId, view: 'memory', tab: 'memories' }}
              className="text-[12px] font-medium inline-flex items-center gap-1 transition-colors hover:underline"
              style={{ color: 'var(--accent-11)' }}
            >
              全部记忆
              <ArrowRight className="w-3 h-3" aria-hidden="true" />
            </AppLink>
          </div>

          {recentMemories.length === 0 ? (
            <EmptyState
              icon={Bookmark}
              title="还没有新的记忆碎片"
              description="和她自然聊上几句，值得记住的事实与共同经历会自动沉淀在这里。"
            />
          ) : (
            <ul className="divide-y" style={{ borderColor: 'var(--gray-6)' }}>
              {recentMemories.map((m) => (
                <li key={m.id} className="py-3 flex items-baseline justify-between gap-4">
                  <p className="font-voice text-[14px] leading-relaxed min-w-0 break-words" style={{ color: 'var(--gray-12)' }}>
                    {m.text}
                  </p>
                  <time className="text-[12px] font-mono-num shrink-0" style={{ color: 'var(--gray-11)' }}>
                    {m.createdAt.slice(5, 16)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="lg:col-span-5 ui-panel p-5 flex flex-col gap-5">
          <div>
            <div className="flex items-center justify-between gap-2 pb-3 border-b" style={{ borderColor: 'var(--gray-6)' }}>
              <h3 className="text-[15px] font-semibold">近期作品</h3>
              <AppLink
                to={{ page: 'bot', botId, view: 'works', tab: 'songs' }}
                className="text-[12px] font-medium inline-flex items-center gap-1 transition-colors hover:underline"
                style={{ color: 'var(--accent-11)' }}
              >
                打开作品集
                <ArrowRight className="w-3 h-3" aria-hidden="true" />
              </AppLink>
            </div>
            {recentWorks.length === 0 ? (
              <p className="text-[13px] py-4" style={{ color: 'var(--gray-11)' }}>
                暂无新作品。她兴起写诗、记设计笔记或唱歌后会收进这里。
              </p>
            ) : (
              <ul className="divide-y" style={{ borderColor: 'var(--gray-6)' }}>
                {recentWorks.slice(0, 3).map((w) => (
                  <li key={w.id} className="py-2.5 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium truncate">《{w.title}》</div>
                      <div className="text-[11px] font-mono-num" style={{ color: 'var(--gray-11)' }}>
                        {w.createdAt.slice(0, 16)}
                      </div>
                    </div>
                    <Badge tone={w.status === 'ready' ? 'ok' : w.status === 'failed' ? 'danger' : 'neutral'}>
                      {w.status === 'ready' ? '已完成' : w.status === 'generating' ? '录制中' : w.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between gap-2 pb-3 border-b" style={{ borderColor: 'var(--gray-6)' }}>
              <h3 className="text-[15px] font-semibold">最近心情波澜</h3>
              <AppLink
                to={{ page: 'bot', botId, view: 'life', tab: 'body' }}
                className="text-[12px] font-medium inline-flex items-center gap-1 transition-colors hover:underline"
                style={{ color: 'var(--accent-11)' }}
              >
                身心详情
                <ArrowRight className="w-3 h-3" aria-hidden="true" />
              </AppLink>
            </div>
            {recentCauses.length === 0 ? (
              <p className="text-[13px] py-4" style={{ color: 'var(--gray-11)' }}>
                心境平稳，近期没有明显情绪起伏。
              </p>
            ) : (
              <ul className="divide-y" style={{ borderColor: 'var(--gray-6)' }}>
                {recentCauses.slice(0, 4).map((c) => (
                  <li key={c.id} className="py-2.5 flex items-start gap-2.5">
                    <span
                      className="text-[11px] font-medium shrink-0 mt-0.5 px-1.5 py-0.5 rounded"
                      style={{ backgroundColor: 'var(--gray-3)', color: 'var(--gray-11)' }}
                    >
                      {AFFECT_LABEL[c.affectKind] ?? c.affectKind}
                    </span>
                    <span className="font-voice text-[13px] leading-relaxed min-w-0 break-words" style={{ color: 'var(--gray-12)' }}>
                      {c.text}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
