import { motion } from 'motion/react'
import {
  MapPin,
  BatteryCharging,
  Sparkles,
  MessageCircle,
  Flame,
  Coins,
  BellRing,
  ArrowRight,
  Music2,
  Bookmark,
} from 'lucide-react'
import type { OverviewResponse } from '../lib/api.ts'
import type { ViewId } from '../lib/router.ts'

function moodLabel(p: number, a: number): { text: string; tone: string } {
  if (p >= 0.35 && a >= 0.2) return { text: '雀跃明朗', tone: 'var(--ok)' }
  if (p >= 0.2) return { text: '温柔平和', tone: 'var(--accent)' }
  if (p <= -0.25 && a >= 0.2) return { text: '有点紧绷', tone: 'var(--danger)' }
  if (p <= -0.2) return { text: '些许低落', tone: 'var(--warn)' }
  return { text: '安静惬意', tone: 'var(--info)' }
}

export function HomeView({
  data,
  onNavigate,
}: {
  data: OverviewResponse
  onNavigate: (v: ViewId) => void
}) {
  const { bot, body, kpis, pendingApproval, missingCredentials, recentMemories, recentWorks, recentCauses } = data
  const mood = moodLabel(body.mood.p, body.mood.a)
  const energyPct = Math.round(body.energy * 100)
  const cachePct = Math.round(kpis.cacheHitRate * 100)

  const kpiCards = [
    {
      label: '今日对话轮次',
      value: String(kpis.todayTurns),
      hint: bot.hasTransport ? 'QQ 通道在线' : '离线模式',
      icon: MessageCircle,
      color: 'var(--accent)',
      target: 'memory' as ViewId,
    },
    {
      label: '活跃心事 / 欲望',
      value: String(kpis.activeDesires),
      hint: bot.proactivityEnabled ? '自主生活已开启' : '仅被动陪聊',
      icon: Flame,
      color: 'var(--warn)',
      target: 'life' as ViewId,
    },
    {
      label: '今日 Token & 缓存',
      value: `${(kpis.todayTokens / 1000).toFixed(1)}k`,
      hint: `缓存命中 ${cachePct}% · ¥${kpis.todayCostCny.toFixed(4)}`,
      icon: Coins,
      color: 'var(--info)',
      target: 'usage' as ViewId,
    },
    {
      label: '待你处理',
      value: String(kpis.pendingApprovals + kpis.missingCredentials),
      hint: kpis.pendingApprovals + kpis.missingCredentials > 0 ? '有等待点头或凭证' : '一切安好',
      icon: BellRing,
      color: kpis.pendingApprovals + kpis.missingCredentials > 0 ? 'var(--danger)' : 'var(--ok)',
      target: 'soul' as ViewId,
    },
  ]

  return (
    <div className="space-y-6">
      {/* Hero 角色陪伴卡 */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 320, damping: 28 }}
        className="acg-hero p-1.5"
      >
        <div className="acg-hero-inner rounded-[14px] p-5 lg:p-6 flex flex-col lg:flex-row gap-5 items-start lg:items-center justify-between">
          <div className="flex items-start gap-4 min-w-0">
            {/* 角色首字徽记头像框（随角色自动适配，不锁死任何单一角色） */}
            <div
              className="w-16 h-16 rounded-2xl shrink-0 flex items-center justify-center border relative text-2xl font-bold font-voice"
              style={{
                background: 'linear-gradient(135deg, var(--grad-a), var(--grad-b))',
                borderColor: 'var(--border)',
                color: 'var(--text)',
              }}
            >
              {(bot.name || bot.id).slice(0, 1)}
              <span
                className="w-3 h-3 rounded-full border-2 absolute -bottom-0.5 -right-0.5"
                style={{
                  backgroundColor: bot.hasTransport ? 'var(--ok)' : 'var(--text-2)',
                  borderColor: 'var(--surface)',
                }}
              />
            </div>

            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-[22px] font-bold tracking-tight">{bot.name}</h1>
                <span className="acg-pill" style={{ color: mood.tone }}>
                  <Sparkles className="w-3 h-3" />
                  {mood.text}
                </span>
                {body.activity && (
                  <span className="acg-pill">
                    <MapPin className="w-3 h-3" style={{ color: 'var(--accent)' }} />
                    {body.activity.place} · {body.activity.label}
                  </span>
                )}
              </div>

              {/* 她的此刻内心独白（霞鹜文楷） */}
              <p className="font-voice text-[15px] leading-relaxed" style={{ color: 'var(--text)' }}>
                {body.activity?.thinking
                  ? `“${body.activity.thinking}”`
                  : recentCauses[0]?.text
                    ? `刚刚心里惦记着：${recentCauses[0].text}`
                    : `“${bot.summary || '此刻很安静，正享受着自己的独处时光。'}”`}
              </p>
            </div>
          </div>

          {/* 精力条与睡眠状态 */}
          <div className="w-full lg:w-64 shrink-0 space-y-2.5 p-3.5 rounded-xl border" style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}>
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 font-medium" style={{ color: 'var(--text-2)' }}>
                <BatteryCharging className="w-3.5 h-3.5" style={{ color: 'var(--ok)' }} />
                此刻精力
              </span>
              <span className="font-mono-num font-semibold">{energyPct}%</span>
            </div>
            <div className="h-2 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--surface-2)' }}>
              <div
                className="h-full rounded-full"
                style={{
                  width: `${energyPct}%`,
                  backgroundColor: energyPct > 45 ? 'var(--ok)' : energyPct > 20 ? 'var(--warn)' : 'var(--danger)',
                  transition: 'width 400ms ease',
                }}
              />
            </div>
            <div className="flex justify-between text-[11px]" style={{ color: 'var(--text-2)' }}>
              <span>睡眠债 <strong className="font-mono-num">{Math.round(body.sleepDebt * 100)}%</strong></span>
              <span>PAD <strong className="font-mono-num">{body.mood.p.toFixed(2)} / {body.mood.a.toFixed(2)}</strong></span>
            </div>
          </div>
        </div>
      </motion.section>

      {/* 待办审批 / 凭证提醒条 */}
      {(pendingApproval || missingCredentials.length > 0) && (
        <div
          className="acg-card p-4 flex flex-wrap items-center justify-between gap-3"
          style={{ borderColor: 'var(--warn)' }}
        >
          <div className="space-y-0.5">
            <div className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--warn)' }}>
              <BellRing className="w-4 h-4" />
              她有事情在等你回个信
            </div>
            <p className="text-xs" style={{ color: 'var(--text-2)' }}>
              {pendingApproval ? `待批准：${pendingApproval.what}` : ''}
              {pendingApproval && missingCredentials.length > 0 ? ' · ' : ''}
              {missingCredentials.length > 0 ? `待填写凭证：${missingCredentials.map((c) => c.label).join('、')}` : ''}
            </p>
          </div>
          <button type="button" onClick={() => onNavigate('soul')} className="acg-btn acg-btn-primary text-xs">
            去处理
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 四格关键指标 */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {kpiCards.map((k, idx) => {
          const Icon = k.icon
          return (
            <motion.button
              key={k.label}
              type="button"
              onClick={() => onNavigate(k.target)}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: 'spring', stiffness: 320, damping: 28, delay: idx * 0.03 }}
              className="acg-card p-5 text-left hover:-translate-y-0.5 cursor-pointer"
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-medium" style={{ color: 'var(--text-2)' }}>{k.label}</span>
                <Icon className="w-4 h-4" style={{ color: k.color }} />
              </div>
              <div className="text-2xl font-bold font-mono-num tracking-tight">{k.value}</div>
              <div className="text-xs mt-1.5 truncate" style={{ color: 'var(--text-2)' }}>{k.hint}</div>
            </motion.button>
          )
        })}
      </section>

      {/* 近期动态双栏：新记忆 & 近期作品/情绪 */}
      <section className="grid grid-cols-1 lg:grid-cols-5 gap-5">
        <div className="lg:col-span-3 acg-card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[15px] font-semibold flex items-center gap-2">
              <Bookmark className="w-4 h-4" style={{ color: 'var(--accent)' }} />
              最近记在心里的事
            </h3>
            <button
              type="button"
              onClick={() => onNavigate('memory')}
              className="text-xs cursor-pointer"
              style={{ color: 'var(--accent)' }}
            >
              查看全部 →
            </button>
          </div>
          {recentMemories.length === 0 ? (
            <p className="text-sm py-8 text-center font-voice" style={{ color: 'var(--text-2)' }}>
              还没有新的记忆碎片，找她聊几句吧。
            </p>
          ) : (
            <ul className="space-y-2.5">
              {recentMemories.map((m) => (
                <li
                  key={m.id}
                  className="p-3 rounded-xl border flex items-start justify-between gap-3"
                  style={{ backgroundColor: 'var(--surface-2)', borderColor: 'var(--border)' }}
                >
                  <p className="font-voice text-[14px] leading-relaxed">{m.text}</p>
                  <span className="text-[11px] font-mono-num shrink-0" style={{ color: 'var(--text-2)' }}>
                    {m.createdAt.slice(5, 16)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="lg:col-span-2 acg-card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[15px] font-semibold flex items-center gap-2">
              <Music2 className="w-4 h-4" style={{ color: 'var(--accent)' }} />
              最近的作品与心情波澜
            </h3>
            <button
              type="button"
              onClick={() => onNavigate('works')}
              className="text-xs cursor-pointer"
              style={{ color: 'var(--accent)' }}
            >
              打开歌单 →
            </button>
          </div>

          {recentWorks.length > 0 && (
            <div className="space-y-2">
              {recentWorks.slice(0, 3).map((w) => (
                <div
                  key={w.id}
                  className="p-3 rounded-xl border flex items-center justify-between gap-2"
                  style={{ backgroundColor: 'var(--surface-2)', borderColor: 'var(--border)' }}
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">《{w.title}》</div>
                    <div className="text-[11px]" style={{ color: 'var(--text-2)' }}>{w.createdAt}</div>
                  </div>
                  <span className="acg-pill text-[11px]">{w.status === 'ready' ? '已录好' : w.status}</span>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-2">
            {recentCauses.length === 0 ? (
              <p className="text-xs font-voice py-4 text-center" style={{ color: 'var(--text-2)' }}>
                心境像静水一样平稳。
              </p>
            ) : (
              recentCauses.slice(0, 4).map((c) => (
                <div key={c.id} className="text-xs flex items-start gap-2">
                  <span className="acg-pill shrink-0 py-0.5 px-2 text-[11px]">{c.affectKind}</span>
                  <span className="font-voice leading-relaxed" style={{ color: 'var(--text)' }}>{c.text}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
