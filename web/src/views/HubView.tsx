// 多 Bot 灵魂大厅（/）：框架默认首页，自由选择进入任意角色或查看扩展指南。
import { motion } from 'motion/react'
import {
  BatteryCharging,
  Flame,
  BellRing,
  ArrowRight,
  Music2,
  Volume2,
  MapPin,
  PlusCircle,
  Radio,
} from 'lucide-react'
import type { BotSummary } from '../lib/api.ts'

function moodBadge(p: number, a: number): string {
  if (p >= 0.35 && a >= 0.2) return '雀跃明朗'
  if (p >= 0.2) return '温柔平和'
  if (p <= -0.25 && a >= 0.2) return '有点紧绷'
  if (p <= -0.2) return '些许低落'
  return '安静惬意'
}

export function HubView({
  bots,
  onSelectBot,
}: {
  bots: BotSummary[]
  onSelectBot: (botId: string) => void
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight">灵魂角色大厅</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--text-2)' }}>
            ZySoulBot 是多角色数字灵魂框架，选择任意一位角色查看当下状态，或随时接入新的自定义人设包。
          </p>
        </div>
        <span className="acg-pill font-mono-num">已挂载 {bots.length} 位角色</span>
      </div>

      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {bots.map((bot, idx) => {
          const energyPct = Math.round(bot.energy * 100)
          const initial = (bot.name || bot.id).slice(0, 1)
          return (
            <motion.button
              key={bot.id}
              type="button"
              onClick={() => onSelectBot(bot.id)}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: 'spring', stiffness: 320, damping: 28, delay: idx * 0.04 }}
              className="acg-card p-5 text-left flex flex-col justify-between gap-4 hover:-translate-y-0.5 cursor-pointer group"
            >
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className="w-12 h-12 rounded-2xl shrink-0 flex items-center justify-center border text-lg font-bold font-voice relative"
                      style={{
                        background: 'linear-gradient(135deg, var(--grad-a), var(--grad-b))',
                        borderColor: 'var(--border)',
                        color: 'var(--text)',
                      }}
                    >
                      {initial}
                      <span
                        className="w-3 h-3 rounded-full border-2 absolute -bottom-0.5 -right-0.5"
                        style={{
                          backgroundColor: bot.hasTransport ? 'var(--ok)' : 'var(--text-2)',
                          borderColor: 'var(--surface)',
                        }}
                      />
                    </div>
                    <div className="min-w-0">
                      <div className="text-base font-bold truncate">{bot.name}</div>
                      <div className="text-[11px] font-mono-num" style={{ color: 'var(--text-2)' }}>
                        @{bot.id} · {moodBadge(bot.mood.p, bot.mood.a)}
                      </div>
                    </div>
                  </div>
                  <ArrowRight
                    className="w-4 h-4 shrink-0 transition-transform group-hover:translate-x-0.5"
                    style={{ color: 'var(--accent)' }}
                  />
                </div>

                <p className="font-voice text-xs leading-relaxed line-clamp-2" style={{ color: 'var(--text-2)' }}>
                  {bot.activity
                    ? `此刻正在「${bot.activity.place}」${bot.activity.label}`
                    : (bot.summary || '静静等待下一次对话。')}
                </p>

                {/* 精力细条 */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="flex items-center gap-1" style={{ color: 'var(--text-2)' }}>
                      <BatteryCharging className="w-3 h-3" style={{ color: 'var(--ok)' }} />
                      精力
                    </span>
                    <span className="font-mono-num">{energyPct}%</span>
                  </div>
                  <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--surface-2)' }}>
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${energyPct}%`, backgroundColor: energyPct > 40 ? 'var(--ok)' : 'var(--warn)' }}
                    />
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
                <span className="acg-pill py-0.5 text-[11px]">
                  <Radio className="w-3 h-3" style={{ color: bot.hasTransport ? 'var(--ok)' : 'var(--text-2)' }} />
                  {bot.hasTransport ? 'QQ 在线' : '离线'}
                </span>
                <span className="acg-pill py-0.5 text-[11px]">
                  <Flame className="w-3 h-3" style={{ color: 'var(--warn)' }} />
                  {bot.activeDesires} 心事
                </span>
                {bot.hasTts && (
                  <span className="acg-pill py-0.5 text-[11px]">
                    <Volume2 className="w-3 h-3" style={{ color: 'var(--accent)' }} />
                    语音
                  </span>
                )}
                {bot.hasSinging && (
                  <span className="acg-pill py-0.5 text-[11px]">
                    <Music2 className="w-3 h-3" style={{ color: 'var(--accent)' }} />
                    唱歌
                  </span>
                )}
                {bot.activity && (
                  <span className="acg-pill py-0.5 text-[11px]">
                    <MapPin className="w-3 h-3" style={{ color: 'var(--info)' }} />
                    活动中
                  </span>
                )}
                {bot.pendingTodos > 0 && (
                  <span className="acg-pill py-0.5 text-[11px] ml-auto" style={{ color: 'var(--danger)' }}>
                    <BellRing className="w-3 h-3" />
                    {bot.pendingTodos} 待办
                  </span>
                )}
              </div>
            </motion.button>
          )
        })}

        {/* 多角色扩展卡片 */}
        <div
          className="acg-card p-5 border-dashed flex flex-col justify-between gap-3"
          style={{ backgroundColor: 'var(--surface-2)' }}
        >
          <div className="space-y-2">
            <div className="flex items-center gap-2 font-semibold text-sm">
              <PlusCircle className="w-4 h-4" style={{ color: 'var(--accent)' }} />
              接入新的自定义灵魂
            </div>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-2)' }}>
              每位角色拥有完全独立的 <code>persona-pack</code>、<code>soul.db</code> 记忆库、日记本、表情包与音色配置。
              在 <code>personas/&lt;新角色&gt;/</code> 放入人设包，并在 <code>zysoul.config.json</code> 的 <code>bots</code> 数组追加一项即可同时运行多位角色。
            </p>
          </div>
          <div className="text-[11px] font-mono-num" style={{ color: 'var(--text-2)' }}>
            personas/&lt;id&gt;/pack.json + activities.json
          </div>
        </div>
      </section>
    </div>
  )
}
