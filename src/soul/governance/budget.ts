// 自主行为 Token 软预算守卫 + 安静时段判定（防后台自主系统偷跑刷爆费用，绝不影响正常陪聊）。
import type { SoulStore } from '../../shared/ports.ts'

const AUTONOMOUS_SCENES = new Set(['life', 'wander', 'desire_shape', 'solo', 'reflect', 'diary', 'outreach'])

export function inQuietHours(now: Date, quietHours?: [string, string]): boolean {
  if (!quietHours) return false
  const [start, end] = quietHours
  if (!start || !end) return false
  const m = now.getHours() * 60 + now.getMinutes()
  const [sh = 0, sm = 0] = start.split(':').map(Number)
  const [eh = 0, em = 0] = end.split(':').map(Number)
  const s = sh * 60 + sm
  const e = eh * 60 + em
  return s <= e ? m >= s && m < e : m >= s || m < e
}

export function checkAutonomousBudget(
  store: SoulStore,
  dailyCapTokens: number,
  now: Date = new Date(),
): { allowed: boolean; usedTokens: number; capTokens: number } {
  const startOfDay = new Date(now)
  startOfDay.setHours(0, 0, 0, 0)
  const stats = store.tokenStatsSince(startOfDay.toISOString())
  let used = 0
  for (const [scene, row] of Object.entries(stats.byScene)) {
    if (AUTONOMOUS_SCENES.has(scene)) {
      // 未命中缓存的输入 + 输出，按真实计费权重折算
      used += Math.max(0, row.input - row.cached) + Math.round(row.cached * 0.2) + row.output
    }
  }
  return {
    allowed: used < dailyCapTokens,
    usedTokens: used,
    capTokens: dailyCapTokens,
  }
}
