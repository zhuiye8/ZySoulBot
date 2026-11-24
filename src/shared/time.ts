// 可注入时钟与本地时间格式化工具（测试可自由控制时间推进）。
export interface Clock {
  now(): Date
}

export const systemClock: Clock = {
  now: () => new Date(),
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

export function todayLocal(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export function nowLocal(d: Date = new Date()): string {
  return `${todayLocal(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

export function timeHHMM(d: Date = new Date()): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export function resolveEnvValue(value: string): string {
  if (value.startsWith('ENV:')) return process.env[value.slice(4)] ?? ''
  return value
}

export function formatTimeSpan(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000))
  if (mins < 2) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return `${Math.floor(days / 30)} 个月前`
}
