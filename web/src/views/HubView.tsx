// 多角色灵魂大厅（/）：以清晰的操作层级呈现所有已挂载角色。
import { ArrowRight, BellRing, FolderPlus, Radio, Sparkles } from 'lucide-react'
import type { BotSummary } from '../lib/api.ts'
import { AppLink, Badge, EmptyState, Meter } from '../components/ui.tsx'

function moodLabel(p: number, a: number): string {
  if (p >= 0.35 && a >= 0.2) return '雀跃明朗'
  if (p >= 0.2) return '温柔平和'
  if (p <= -0.25 && a >= 0.2) return '有点紧绷'
  if (p <= -0.2) return '些许低落'
  return '安静惬意'
}

export function HubView({ bots }: { bots: BotSummary[] }) {
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-[24px] font-semibold tracking-tight">灵魂角色大厅</h1>
          <p className="text-[14px]" style={{ color: 'var(--gray-11)' }}>
            选择一位角色查看此刻身心状态、长期记忆与自主生活记录。
          </p>
        </div>
        <span className="font-mono-num text-[12px]" style={{ color: 'var(--gray-11)' }}>
          共 {bots.length}&nbsp;位角色
        </span>
      </div>

      {bots.length === 0 ? (
        <div className="ui-panel">
          <EmptyState
            icon={Sparkles}
            title="当前还没有挂载角色"
            description="在 personas/<id>/ 放入人设包，并在 zysoul.config.json 的 bots 数组中追加配置后重启服务即可启用。"
          />
        </div>
      ) : (
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {bots.map((bot) => {
            const energyPct = Math.round(bot.energy * 100)
            const initial = (bot.name || bot.id).slice(0, 1)
            return (
              <AppLink
                key={bot.id}
                to={{ page: 'bot', botId: bot.id, view: 'home' }}
                className="ui-panel p-5 flex flex-col justify-between gap-4 group transition-colors duration-150 hover:border-[var(--gray-8)]"
              >
                <div className="space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className="w-11 h-11 rounded-[10px] border shrink-0 flex items-center justify-center font-voice text-[18px] font-semibold"
                        style={{
                          backgroundColor: 'var(--accent-2)',
                          borderColor: 'var(--accent-6)',
                          color: 'var(--accent-11)',
                        }}
                      >
                        {initial}
                      </div>
                      <div className="min-w-0">
                        <div className="text-[16px] font-semibold truncate" style={{ color: 'var(--gray-12)' }}>
                          {bot.name}
                        </div>
                        <div className="text-[12px] font-mono-num truncate" style={{ color: 'var(--gray-11)' }} translate="no">
                          @{bot.id} · {moodLabel(bot.mood.p, bot.mood.a)}
                        </div>
                      </div>
                    </div>
                    <ArrowRight
                      className="w-4 h-4 shrink-0 mt-1 transition-transform duration-150 group-hover:translate-x-0.5"
                      style={{ color: 'var(--gray-10)' }}
                      aria-hidden="true"
                    />
                  </div>

                  <p className="font-voice text-[14px] leading-relaxed line-clamp-2" style={{ color: 'var(--gray-11)' }}>
                    {bot.activity
                      ? `正在「${bot.activity.place}」${bot.activity.label}`
                      : (bot.summary || '此刻很安静，正等待下一次对话。')}
                  </p>

                  <Meter
                    label="此刻精力"
                    value={bot.energy}
                    displayValue={`${energyPct}%`}
                    tone={energyPct > 40 ? 'ok' : energyPct > 20 ? 'warn' : 'danger'}
                  />
                </div>

                <div
                  className="pt-3 border-t flex flex-wrap items-center justify-between gap-2 text-[12px]"
                  style={{ borderColor: 'var(--gray-6)', color: 'var(--gray-11)' }}
                >
                  <div className="flex items-center gap-3">
                    <span className="inline-flex items-center gap-1.5">
                      <Radio
                        className="w-3.5 h-3.5"
                        style={{ color: bot.hasTransport ? 'var(--ok-solid)' : 'var(--gray-9)' }}
                        aria-hidden="true"
                      />
                      {bot.hasTransport ? 'QQ 在线' : '离线'}
                    </span>
                    <span className="font-mono-num">{bot.activeDesires}&nbsp;条心事</span>
                    {(bot.hasTts || bot.hasSinging) && (
                      <span>{[bot.hasTts ? '语音' : '', bot.hasSinging ? '唱歌' : ''].filter(Boolean).join(' / ')}</span>
                    )}
                  </div>
                  {bot.pendingTodos > 0 && (
                    <Badge tone="warn">
                      <BellRing className="w-3 h-3" aria-hidden="true" />
                      <span className="font-mono-num">{bot.pendingTodos}&nbsp;待办</span>
                    </Badge>
                  )}
                </div>
              </AppLink>
            )
          })}
        </section>
      )}

      {/* 克制的多角色扩展说明条（替代假等权虚线卡片） */}
      <section
        className="rounded-[12px] border px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
        style={{ backgroundColor: 'var(--surface-subtle)', borderColor: 'var(--gray-6)' }}
      >
        <div className="flex items-start gap-3 min-w-0">
          <FolderPlus className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--gray-11)' }} aria-hidden="true" />
          <div className="min-w-0 space-y-0.5">
            <div className="text-[13px] font-medium" style={{ color: 'var(--gray-12)' }}>
              接入新的自定义灵魂角色
            </div>
            <p className="text-[12px] leading-relaxed" style={{ color: 'var(--gray-11)' }}>
              每位角色拥有独立的 <code translate="no">persona-pack</code>、<code translate="no">soul.db</code>、日记本与音色配置。在{' '}
              <code translate="no">personas/&lt;id&gt;/</code> 放入人设包并追加到 <code translate="no">zysoul.config.json</code> 的{' '}
              <code translate="no">bots</code> 数组即可并行运行。
            </p>
          </div>
        </div>
      </section>
    </div>
  )
}
