// 可开关的二次元主题氛围浮尘层（pointer-events: none，不遮挡点击、清晰可见且克制）：
// - mint   : 薄荷光点与星芒微微上升
// - sky    : 晴空菱形光斑轻缓漂浮
// - sakura : 浅樱花瓣轻盈旋落
// - night  : 星夜微光星尘闪烁
import type { ThemeId } from './Shell.tsx'

interface ParticleSeed {
  id: number
  left: string
  top: string
  size: number
  dur: string
  delay: string
  drift: string
}

const SEEDS: ParticleSeed[] = [
  { id: 1, left: '6%', top: '18%', size: 12, dur: '11s', delay: '0s', drift: '18px' },
  { id: 2, left: '15%', top: '72%', size: 9, dur: '13s', delay: '-3s', drift: '-14px' },
  { id: 3, left: '24%', top: '40%', size: 14, dur: '15s', delay: '-6s', drift: '22px' },
  { id: 4, left: '34%', top: '84%', size: 10, dur: '12s', delay: '-2s', drift: '-18px' },
  { id: 5, left: '44%', top: '22%', size: 13, dur: '14s', delay: '-5s', drift: '16px' },
  { id: 6, left: '53%', top: '66%', size: 8, dur: '10s', delay: '-1s', drift: '-12px' },
  { id: 7, left: '62%', top: '30%', size: 15, dur: '16s', delay: '-8s', drift: '24px' },
  { id: 8, left: '71%', top: '78%', size: 11, dur: '12s', delay: '-4s', drift: '-16px' },
  { id: 9, left: '80%', top: '20%', size: 13, dur: '13s', delay: '-7s', drift: '18px' },
  { id: 10, left: '88%', top: '55%', size: 10, dur: '11s', delay: '-2.5s', drift: '-20px' },
  { id: 11, left: '94%', top: '82%', size: 12, dur: '14s', delay: '-9s', drift: '14px' },
  { id: 12, left: '19%', top: '12%', size: 10, dur: '12.5s', delay: '-4.5s', drift: '15px' },
  { id: 13, left: '49%', top: '90%', size: 11, dur: '13.5s', delay: '-1.5s', drift: '-15px' },
  { id: 14, left: '76%', top: '46%', size: 9, dur: '10.5s', delay: '-6.5s', drift: '12px' },
]

function ParticleShape({ theme, size }: { theme: ThemeId; size: number }) {
  if (theme === 'sakura') {
    return (
      <svg width={size} height={size} viewBox="0 0 20 20" fill="none">
        <path
          d="M10 2C14 5 17 9.5 14.5 14.5C12.8 17.5 8.5 18 6 15.5C3.5 13 4.5 7.5 10 2Z"
          fill="var(--accent)"
          fillOpacity="0.45"
        />
      </svg>
    )
  }
  if (theme === 'sky') {
    return (
      <svg width={size} height={size} viewBox="0 0 20 20" fill="none">
        <path
          d="M10 1.5L18.5 10L10 18.5L1.5 10L10 1.5Z"
          fill="var(--accent)"
          fillOpacity="0.34"
          stroke="var(--accent)"
          strokeOpacity="0.55"
          strokeWidth="1"
        />
      </svg>
    )
  }
  // mint & night: 精致四角星芒
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <path
        d="M10 1C10.9 6.2 13.8 9.1 19 10C13.8 10.9 10.9 13.8 10 19C9.1 13.8 6.2 10.9 1 10C6.2 9.1 9.1 6.2 10 1Z"
        fill="var(--accent)"
        fillOpacity={theme === 'night' ? '0.68' : '0.45'}
      />
    </svg>
  )
}

export function AmbientLayer({ theme, enabled }: { theme: ThemeId; enabled: boolean }) {
  if (!enabled) return null
  const cls = theme === 'sakura' ? 'acg-ambient-fall' : 'acg-ambient-rise'
  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden z-30" aria-hidden="true">
      {SEEDS.map((p) => (
        <span
          key={p.id}
          className={cls}
          style={{
            left: p.left,
            top: p.top,
            ['--dur' as string]: p.dur,
            ['--delay' as string]: p.delay,
            ['--drift' as string]: p.drift,
          }}
        >
          <ParticleShape theme={theme} size={p.size} />
        </span>
      ))}
    </div>
  )
}
