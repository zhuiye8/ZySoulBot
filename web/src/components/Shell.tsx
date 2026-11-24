import { useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import {
  Sparkles,
  Home,
  HeartHandshake,
  Brain,
  Music2,
  Wand2,
  BarChart3,
  LogOut,
  Menu,
  X,
  Leaf,
  CloudSun,
  Flower2,
  MoonStar,
  Lock,
  Eye,
  EyeOff,
  LayoutGrid,
  ArrowRight,
} from 'lucide-react'
import type { BotSummary } from '../lib/api.ts'
import type { ViewId } from '../lib/router.ts'
import { AmbientLayer } from './AmbientLayer.tsx'

export type ThemeId = 'mint' | 'sky' | 'sakura' | 'night'

const THEMES: Array<{ id: ThemeId; label: string; icon: typeof Leaf }> = [
  { id: 'mint', label: '薄荷青岚', icon: Leaf },
  { id: 'sky', label: '晴空天蓝', icon: CloudSun },
  { id: 'sakura', label: '樱花桃粉', icon: Flower2 },
  { id: 'night', label: '星夜深色', icon: MoonStar },
]

const NAV_ITEMS: Array<{ id: ViewId; label: string; sub: string; icon: typeof Home }> = [
  { id: 'home', label: '今日概览', sub: '当下状态', icon: Home },
  { id: 'life', label: '内心与生活', sub: '情绪 · 心事 · 日记', icon: HeartHandshake },
  { id: 'memory', label: '记忆与关系', sub: '人物 · 记忆 · 对话', icon: Brain },
  { id: 'works', label: '声音与作品', sub: '歌单 · 表情 · 语音', icon: Music2 },
  { id: 'soul', label: '灵魂与能力', sub: '人设 · 技能 · 凭证', icon: Wand2 },
  { id: 'usage', label: '账本与诊断', sub: 'Token · Trace · 安全', icon: BarChart3 },
]

export function BrandStar({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path
        d="M16 2.5C17.2 10.2 21.8 14.8 29.5 16C21.8 17.2 17.2 21.8 16 29.5C14.8 21.8 10.2 17.2 2.5 16C10.2 14.8 14.8 10.2 16 2.5Z"
        fill="var(--accent)"
        fillOpacity="0.92"
      />
      <circle cx="16" cy="16" r="3" fill="var(--surface)" />
    </svg>
  )
}

export function BrandWordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className={`font-bold tracking-tight ${compact ? 'text-[15px]' : 'text-[22px]'}`}
        style={{ color: 'var(--text)' }}
      >
        ZySoulBot
      </span>
      <span
        className="font-mono-num uppercase font-semibold tracking-[0.1em] px-1.5 py-0.5 rounded-md border text-[10px] leading-none"
        style={{
          backgroundColor: 'var(--accent-soft)',
          borderColor: 'var(--border)',
          color: 'var(--accent)',
        }}
      >
        SOUL
      </span>
    </span>
  )
}

function ThemeSwitcher({
  theme,
  onThemeChange,
  layoutId = 'theme-pill',
}: {
  theme: ThemeId
  onThemeChange: (t: ThemeId) => void
  layoutId?: string
}) {
  return (
    <div
      className="flex items-center p-1 rounded-full border gap-0.5"
      style={{
        backgroundColor: 'color-mix(in srgb, var(--surface) 88%, transparent)',
        backdropFilter: 'blur(10px)',
        borderColor: 'var(--border)',
      }}
      role="radiogroup"
      aria-label="切换主题风格"
    >
      {THEMES.map((t) => {
        const Icon = t.icon
        const active = theme === t.id
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={t.label}
            onClick={() => onThemeChange(t.id)}
            className="relative px-2.5 py-1 rounded-full text-xs font-medium flex items-center gap-1.5 cursor-pointer"
            style={{ color: active ? 'var(--accent)' : 'var(--text-2)' }}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                className="absolute inset-0 rounded-full"
                style={{ backgroundColor: 'var(--accent-soft)' }}
              />
            )}
            <Icon className="w-3.5 h-3.5 relative z-10" />
            <span className="hidden sm:inline relative z-10">{t.label}</span>
          </button>
        )
      })}
    </div>
  )
}

export function LoginScreen({
  theme,
  onThemeChange,
  ambient,
  onLogin,
}: {
  theme: ThemeId
  onThemeChange: (t: ThemeId) => void
  ambient: boolean
  onLogin: (password: string) => Promise<void>
}) {
  const [password, setPassword] = useState('')
  const [showPwd, setShowPwd] = useState(false)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [shakeKey, setShakeKey] = useState(0)
  const [pointer, setPointer] = useState({ x: 50, y: 45 })

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password.trim()) {
      setErr('请先输入管理员口令')
      setShakeKey((k) => k + 1)
      return
    }
    setLoading(true)
    setErr('')
    try {
      await onLogin(password)
    } catch (error) {
      setErr((error as Error).message)
      setShakeKey((k) => k + 1)
    } finally {
      setLoading(false)
    }
  }

  const handlePointerMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 100
    const y = ((e.clientY - rect.top) / Math.max(1, rect.height)) * 100
    setPointer({ x, y })
  }

  return (
    <div
      onMouseMove={handlePointerMove}
      className="min-h-screen flex flex-col items-center justify-center p-6 relative overflow-hidden acg-dot-grid"
    >
      {/* 1) 轻二次元柔彩光晕层（随主题实时变化 + 呼吸漂移） */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
        <div
          className="acg-orb-a absolute -top-28 -left-24 w-[440px] h-[440px] rounded-full blur-[86px]"
          style={{ background: 'var(--orb-1)' }}
        />
        <div
          className="acg-orb-b absolute -bottom-28 -right-20 w-[480px] h-[480px] rounded-full blur-[92px]"
          style={{ background: 'var(--orb-2)' }}
        />
        <div
          className="acg-orb-a absolute top-1/3 right-1/4 w-[320px] h-[320px] rounded-full blur-[80px]"
          style={{ background: 'var(--orb-3)' }}
        />
        {/* 跟随鼠标的柔和径向高光 */}
        <div
          className="absolute inset-0"
          style={{
            background: `radial-gradient(460px circle at ${pointer.x}% ${pointer.y}%, color-mix(in srgb, var(--accent) 11%, transparent), transparent 65%)`,
          }}
        />
      </div>

      {/* 2) 缓慢旋转的二次元星轨几何背景（居中于卡片后方） */}
      <svg
        className="fixed w-[640px] h-[640px] max-w-[95vw] pointer-events-none opacity-45"
        viewBox="0 0 600 600"
        fill="none"
        aria-hidden="true"
      >
        <g className="acg-ring-cw" style={{ transformOrigin: '300px 300px' }}>
          <circle cx="300" cy="300" r="245" stroke="var(--accent)" strokeOpacity="0.24" strokeWidth="1" strokeDasharray="6 10" />
          <circle cx="300" cy="55" r="4" fill="var(--accent)" fillOpacity="0.6" />
          <circle cx="545" cy="300" r="3" fill="var(--accent)" fillOpacity="0.45" />
          <path d="M300 44 L303 52 L311 55 L303 58 L300 66 L297 58 L289 55 L297 52 Z" fill="var(--accent)" fillOpacity="0.55" />
        </g>
        <g className="acg-ring-ccw" style={{ transformOrigin: '300px 300px' }}>
          <circle cx="300" cy="300" r="196" stroke="var(--border)" strokeWidth="1.2" />
          <polygon
            points="300,118 458,209 458,391 300,482 142,391 142,209"
            stroke="var(--accent)"
            strokeOpacity="0.16"
            strokeWidth="1"
          />
          <circle cx="142" cy="209" r="3.5" fill="var(--accent)" fillOpacity="0.5" />
          <circle cx="458" cy="391" r="3.5" fill="var(--accent)" fillOpacity="0.5" />
        </g>
      </svg>

      {/* 3) 主题粒子浮尘 */}
      <AmbientLayer theme={theme} enabled={ambient} />

      {/* 4) 顶部右侧直接放 4 套主题实时切换 */}
      <div className="fixed top-4 right-4 z-40">
        <ThemeSwitcher theme={theme} onThemeChange={onThemeChange} layoutId="login-theme-pill" />
      </div>

      {/* 5) 居中毛玻璃卡片 */}
      <motion.div
        key={shakeKey}
        initial={shakeKey === 0 ? { opacity: 0, y: 20, scale: 0.97 } : { x: -8 }}
        animate={shakeKey === 0 ? { opacity: 1, y: 0, scale: 1 } : { x: [0, -7, 7, -4, 4, 0] }}
        transition={
          shakeKey === 0
            ? { type: 'spring', stiffness: 300, damping: 26 }
            : { duration: 0.36 }
        }
        className="w-full max-w-[410px] acg-glass-card relative z-20 overflow-hidden"
      >
        {/* 顶部柔光装饰条 */}
        <div
          className="h-1.5 w-full"
          style={{ background: 'linear-gradient(90deg, var(--grad-a), var(--accent), var(--grad-b))' }}
        />

        {/* 四角极细二次元取景锚点 */}
        <span className="absolute top-3.5 left-3.5 w-2.5 h-2.5 border-t-2 border-l-2 rounded-tl-[2px] opacity-40" style={{ borderColor: 'var(--accent)' }} />
        <span className="absolute top-3.5 right-3.5 w-2.5 h-2.5 border-t-2 border-r-2 rounded-tr-[2px] opacity-40" style={{ borderColor: 'var(--accent)' }} />
        <span className="absolute bottom-3.5 left-3.5 w-2.5 h-2.5 border-b-2 border-l-2 rounded-bl-[2px] opacity-40" style={{ borderColor: 'var(--accent)' }} />
        <span className="absolute bottom-3.5 right-3.5 w-2.5 h-2.5 border-b-2 border-r-2 rounded-br-[2px] opacity-40" style={{ borderColor: 'var(--accent)' }} />

        <div className="p-8 space-y-6">
          {/* 居中品牌星标 + 标题 */}
          <div className="flex flex-col items-center text-center space-y-3">
            <div className="relative">
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 24, repeat: Infinity, ease: 'linear' }}
                className="absolute -inset-2 rounded-full border border-dashed opacity-45"
                style={{ borderColor: 'var(--accent)' }}
              />
              <div
                className="w-14 h-14 rounded-2xl flex items-center justify-center border relative"
                style={{
                  background: 'linear-gradient(135deg, var(--grad-a), var(--grad-b))',
                  borderColor: 'var(--border)',
                }}
              >
                <BrandStar size={30} />
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex justify-center">
                <BrandWordmark />
              </div>
              <p className="text-[13px] font-voice" style={{ color: 'var(--text-2)' }}>
                连接并照料你的每一个数字灵魂
              </p>
            </div>
          </div>

          <form onSubmit={(e) => { void submit(e) }} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="admin-pwd" className="block text-xs font-medium" style={{ color: 'var(--text-2)' }}>
                管理员口令
              </label>

              {/* 物理分列弹性输入壳：锁图标 | 输入框 | 显示隐藏按钮，永不重叠 */}
              <div className="acg-input-box">
                <Lock className="w-4 h-4 shrink-0" style={{ color: 'var(--text-2)' }} />
                <input
                  id="admin-pwd"
                  type={showPwd ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value)
                    if (err) setErr('')
                  }}
                  placeholder="输入后台口令"
                  autoFocus
                  autoComplete="current-password"
                  className="acg-input-bare"
                />
                <button
                  type="button"
                  aria-label={showPwd ? '隐藏口令' : '显示口令'}
                  onClick={() => setShowPwd((v) => !v)}
                  className="p-1 rounded-md cursor-pointer shrink-0"
                  style={{ color: 'var(--text-2)' }}
                >
                  {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <AnimatePresence>
              {err && (
                <motion.p
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  className="text-xs px-3 py-2 rounded-xl border"
                  style={{
                    backgroundColor: 'rgba(223, 83, 101, 0.09)',
                    borderColor: 'rgba(223, 83, 101, 0.25)',
                    color: 'var(--danger)',
                  }}
                >
                  {err}
                </motion.p>
              )}
            </AnimatePresence>

            <motion.button
              type="submit"
              disabled={loading}
              whileHover={{ y: -1 }}
              whileTap={{ scale: 0.985 }}
              className="acg-btn acg-btn-primary acg-shimmer-btn w-full py-3 text-[14px] font-semibold"
            >
              <span>{loading ? '正在连接灵魂中枢...' : '进入灵魂中枢'}</span>
              {!loading && <ArrowRight className="w-4 h-4" />}
            </motion.button>
          </form>

          <div
            className="pt-3 border-t flex items-center justify-between text-[11px]"
            style={{ borderColor: 'var(--border)', color: 'var(--text-2)' }}
          >
            <span className="font-mono-num">SOUL CORE v2</span>
            <span>多角色陪伴 · 记忆与生活</span>
          </div>
        </div>
      </motion.div>
    </div>
  )
}

export function Shell({
  theme,
  onThemeChange,
  ambient,
  onToggleAmbient,
  bots,
  activeBotId,
  onGoHub,
  onSelectBot,
  view,
  onSelectView,
  onLogout,
  children,
}: {
  theme: ThemeId
  onThemeChange: (t: ThemeId) => void
  ambient: boolean
  onToggleAmbient: () => void
  bots: BotSummary[]
  activeBotId: string | null
  onGoHub: () => void
  onSelectBot: (id: string) => void
  view: ViewId
  onSelectView: (v: ViewId) => void
  onLogout: () => void
  children: React.ReactNode
}) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const inHub = !activeBotId
  const activeBot = activeBotId ? bots.find((b) => b.id === activeBotId) : undefined

  const sidebarContent = (
    <div className="flex flex-col h-full p-4 gap-4">
      {/* 品牌抬头 */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => {
            onGoHub()
            setMobileOpen(false)
          }}
          className="flex items-center gap-2.5 text-left cursor-pointer"
        >
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center border shrink-0"
            style={{ background: 'linear-gradient(135deg, var(--grad-a), var(--grad-b))', borderColor: 'var(--border)' }}
          >
            <BrandStar size={20} />
          </div>
          <div>
            <BrandWordmark compact />
            <div className="text-[11px]" style={{ color: 'var(--text-2)' }}>数字灵魂中枢</div>
          </div>
        </button>
        <button
          type="button"
          aria-label="关闭导航"
          onClick={() => setMobileOpen(false)}
          className="lg:hidden p-1.5 rounded-lg"
          style={{ color: 'var(--text-2)' }}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 返回角色大厅 + 角色快速切换 */}
      <div className="space-y-2 pb-3 border-b" style={{ borderColor: 'var(--border)' }}>
        <button
          type="button"
          onClick={() => {
            onGoHub()
            setMobileOpen(false)
          }}
          className="w-full acg-btn acg-btn-soft text-xs justify-start py-1.5"
        >
          <LayoutGrid className="w-3.5 h-3.5" style={{ color: 'var(--accent)' }} />
          全部灵魂角色（大厅）
        </button>
        {activeBotId && (
          <select
            aria-label="切换当前角色"
            value={activeBotId}
            onChange={(e) => onSelectBot(e.target.value)}
            className="acg-input w-full text-xs py-1.5"
          >
            {bots.map((b) => (
              <option key={b.id} value={b.id}>{b.name} (@{b.id})</option>
            ))}
          </select>
        )}
      </div>

      {/* 角色 6 大视图导航 */}
      <nav className="flex-1 space-y-1">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          const active = view === item.id
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onSelectView(item.id)
                setMobileOpen(false)
              }}
              className="relative w-full text-left px-3 py-2.5 rounded-xl flex items-center gap-3 cursor-pointer"
              style={{ color: active ? 'var(--accent)' : 'var(--text)' }}
            >
              {active && (
                <motion.span
                  layoutId="nav-pill"
                  transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                  className="absolute inset-0 rounded-xl border"
                  style={{ backgroundColor: 'var(--accent-soft)', borderColor: 'var(--border)' }}
                />
              )}
              <Icon className="w-[17px] h-[17px] relative z-10 shrink-0" strokeWidth={1.8} />
              <div className="relative z-10 min-w-0">
                <div className="text-[13px] font-semibold leading-tight">{item.label}</div>
                <div className="text-[11px] truncate" style={{ color: 'var(--text-2)' }}>{item.sub}</div>
              </div>
              {item.id === 'soul' && (activeBot?.pendingTodos ?? 0) > 0 && (
                <span
                  className="relative z-10 ml-auto text-[11px] font-mono-num px-1.5 py-0.5 rounded-full font-semibold"
                  style={{ backgroundColor: 'var(--warn)', color: '#fff' }}
                >
                  {activeBot!.pendingTodos}
                </span>
              )}
            </button>
          )
        })}
      </nav>

      {/* 底部氛围开关与登出 */}
      <div className="pt-3 border-t space-y-2" style={{ borderColor: 'var(--border)' }}>
        <button
          type="button"
          onClick={onToggleAmbient}
          className="w-full acg-btn acg-btn-soft text-xs justify-between py-2"
        >
          <span className="flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5" style={{ color: 'var(--accent)' }} />
            氛围浮尘
          </span>
          <span style={{ color: ambient ? 'var(--ok)' : 'var(--text-2)' }}>{ambient ? '开启' : '关闭'}</span>
        </button>
        <button
          type="button"
          onClick={onLogout}
          className="w-full acg-btn acg-btn-soft text-xs justify-start py-2"
          style={{ color: 'var(--text-2)' }}
        >
          <LogOut className="w-3.5 h-3.5" />
          退出后台
        </button>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen flex relative">
      <AmbientLayer theme={theme} enabled={ambient} />

      {!inHub && (
        <>
          <aside
            className="hidden lg:block w-[236px] shrink-0 border-r sticky top-0 h-screen z-20"
            style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}
          >
            {sidebarContent}
          </aside>

          <AnimatePresence>
            {mobileOpen && (
              <>
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={() => setMobileOpen(false)}
                  className="fixed inset-0 bg-black/25 z-40 lg:hidden"
                />
                <motion.aside
                  initial={{ x: -244 }}
                  animate={{ x: 0 }}
                  exit={{ x: -244 }}
                  transition={{ type: 'spring', stiffness: 360, damping: 32 }}
                  className="fixed left-0 top-0 bottom-0 w-[244px] z-50 lg:hidden border-r"
                  style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}
                >
                  {sidebarContent}
                </motion.aside>
              </>
            )}
          </AnimatePresence>
        </>
      )}

      <div className="flex-1 min-w-0 flex flex-col relative z-10">
        <header
          className="sticky top-0 z-20 px-4 lg:px-7 py-3 border-b flex items-center justify-between gap-3"
          style={{
            backgroundColor: 'color-mix(in srgb, var(--bg) 82%, transparent)',
            backdropFilter: 'blur(12px)',
            borderColor: 'var(--border)',
          }}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            {inHub ? (
              <div className="flex items-center gap-2.5">
                <div
                  className="w-8 h-8 rounded-xl flex items-center justify-center border"
                  style={{ background: 'linear-gradient(135deg, var(--grad-a), var(--grad-b))', borderColor: 'var(--border)' }}
                >
                  <BrandStar size={18} />
                </div>
                <BrandWordmark compact />
              </div>
            ) : (
              <>
                <button
                  type="button"
                  aria-label="打开菜单"
                  onClick={() => setMobileOpen(true)}
                  className="lg:hidden acg-btn acg-btn-soft p-2"
                >
                  <Menu className="w-4 h-4" />
                </button>
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs hidden sm:inline" style={{ color: 'var(--text-2)' }}>
                    {activeBot?.name ?? activeBotId} /
                  </span>
                  <h2 className="text-[16px] font-bold tracking-tight truncate">
                    {NAV_ITEMS.find((n) => n.id === view)?.label}
                  </h2>
                </div>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            {inHub && (
              <>
                <button
                  type="button"
                  onClick={onToggleAmbient}
                  className="acg-btn acg-btn-soft text-xs py-1.5 px-2.5"
                  title="开关背景氛围粒子"
                >
                  <Sparkles className="w-3.5 h-3.5" style={{ color: ambient ? 'var(--accent)' : 'var(--text-2)' }} />
                  <span className="hidden md:inline">{ambient ? '浮尘开' : '浮尘关'}</span>
                </button>
                <button
                  type="button"
                  onClick={onLogout}
                  aria-label="退出后台"
                  className="acg-btn acg-btn-soft text-xs py-1.5 px-2.5"
                  style={{ color: 'var(--text-2)' }}
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </>
            )}
            <ThemeSwitcher theme={theme} onThemeChange={onThemeChange} />
          </div>
        </header>

        <main className="flex-1 p-4 lg:p-7 max-w-[1200px] w-full mx-auto">
          {children}
        </main>
      </div>
    </div>
  )
}
