import { useEffect, useRef, useState } from 'react'
import {
  Home,
  HeartHandshake,
  Brain,
  Music2,
  Wand2,
  BarChart3,
  LogOut,
  Menu,
  X,
  Sun,
  Moon,
  Monitor,
  Lock,
  Eye,
  EyeOff,
  LayoutGrid,
  ArrowRight,
} from 'lucide-react'
import type { BotSummary } from '../lib/api.ts'
import type { ViewId } from '../lib/router.ts'
import { AppLink, Button, Select } from './ui.tsx'

export type ThemeMode = 'light' | 'dark' | 'system'

const THEME_MODES: Array<{ id: ThemeMode; label: string; icon: typeof Sun }> = [
  { id: 'light', label: '浅色', icon: Sun },
  { id: 'dark', label: '深色', icon: Moon },
  { id: 'system', label: '系统', icon: Monitor },
]

const NAV_ITEMS: Array<{ id: ViewId; label: string; icon: typeof Home }> = [
  { id: 'home', label: '今日概览', icon: Home },
  { id: 'life', label: '内心与生活', icon: HeartHandshake },
  { id: 'memory', label: '记忆与关系', icon: Brain },
  { id: 'works', label: '声音与作品', icon: Music2 },
  { id: 'soul', label: '灵魂与能力', icon: Wand2 },
  { id: 'usage', label: '账本与诊断', icon: BarChart3 },
]

export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2.5C13.1 8.1 15.9 10.9 21.5 12C15.9 13.1 13.1 15.9 12 21.5C10.9 15.9 8.1 13.1 2.5 12C8.1 10.9 10.9 8.1 12 2.5Z"
        fill="var(--accent-9)"
      />
      <circle cx="12" cy="12" r="2.2" fill="var(--surface)" />
    </svg>
  )
}

function ThemeModeToggle({
  mode,
  onModeChange,
}: {
  mode: ThemeMode
  onModeChange: (m: ThemeMode) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="切换外观模式"
      className="inline-flex items-center p-0.5 rounded-[8px] border"
      style={{ backgroundColor: 'var(--surface-subtle)', borderColor: 'var(--gray-6)' }}
    >
      {THEME_MODES.map((item) => {
        const Icon = item.icon
        const active = mode === item.id
        return (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={item.label}
            title={item.label}
            onClick={() => onModeChange(item.id)}
            className="inline-flex items-center gap-1 px-2 py-1 min-h-[28px] rounded-[6px] text-[12px] font-medium cursor-pointer touch-manipulation transition-colors duration-150"
            style={{
              backgroundColor: active ? 'var(--surface)' : 'transparent',
              color: active ? 'var(--gray-12)' : 'var(--gray-11)',
              boxShadow: active ? 'var(--shadow-sm)' : 'none',
            }}
          >
            <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}

export function LoginScreen({
  mode,
  onModeChange,
  onLogin,
}: {
  mode: ThemeMode
  onModeChange: (m: ThemeMode) => void
  onLogin: (password: string) => Promise<void>
}) {
  const [password, setPassword] = useState('')
  const [showPwd, setShowPwd] = useState(false)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password.trim()) {
      setErr('请输入管理员口令后再登录。')
      inputRef.current?.focus()
      return
    }
    setLoading(true)
    setErr('')
    try {
      await onLogin(password)
    } catch (error) {
      const msg = (error as Error).message || '登录失败'
      setErr(`${msg}，请核对口令后重试。`)
      inputRef.current?.focus()
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: 'var(--canvas)' }}>
      <header className="px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BrandMark size={20} />
          <span className="text-[15px] font-semibold tracking-tight" translate="no">
            ZySoulBot
          </span>
        </div>
        <ThemeModeToggle mode={mode} onModeChange={onModeChange} />
      </header>

      <main className="flex-1 flex items-center justify-center px-4 pb-16">
        <div className="ui-panel w-full max-w-[396px] p-7 space-y-6">
          <div className="space-y-1.5">
            <h1 className="text-[20px] font-semibold tracking-tight">进入数字灵魂中枢</h1>
            <p className="text-[13px] leading-relaxed" style={{ color: 'var(--gray-11)' }}>
              输入管理员口令以查看角色状态、记忆库与自主生活日志。
            </p>
          </div>

          <form onSubmit={(e) => { void submit(e) }} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <label htmlFor="admin-pwd" className="block text-[13px] font-medium" style={{ color: 'var(--gray-12)' }}>
                管理员口令
              </label>
              <div className="ui-input-group" data-invalid={Boolean(err)}>
                <Lock className="w-4 h-4 shrink-0" style={{ color: 'var(--gray-10)' }} aria-hidden="true" />
                <input
                  ref={inputRef}
                  id="admin-pwd"
                  name="password"
                  type={showPwd ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value)
                    if (err) setErr('')
                  }}
                  placeholder="输入后台口令…"
                  autoComplete="current-password"
                  spellCheck={false}
                  aria-invalid={Boolean(err)}
                  aria-describedby={err ? 'login-err' : undefined}
                  className="ui-input-bare"
                />
                <button
                  type="button"
                  aria-label={showPwd ? '隐藏口令' : '显示口令'}
                  onClick={() => setShowPwd((v) => !v)}
                  className="min-w-[28px] min-h-[28px] flex items-center justify-center rounded-[6px] cursor-pointer transition-colors duration-150"
                  style={{ color: 'var(--gray-11)' }}
                >
                  {showPwd ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
                </button>
              </div>
              {err && (
                <p
                  id="login-err"
                  role="alert"
                  aria-live="polite"
                  className="text-[12px] pt-0.5"
                  style={{ color: 'var(--danger-fg)' }}
                >
                  {err}
                </p>
              )}
            </div>

            <Button type="submit" variant="primary" loading={loading} className="w-full min-h-[40px] text-[14px]">
              <span>{loading ? '正在验证口令…' : '登录后台'}</span>
              {!loading && <ArrowRight className="w-4 h-4" aria-hidden="true" />}
            </Button>
          </form>

          <div
            className="pt-4 border-t flex items-center justify-between text-[12px]"
            style={{ borderColor: 'var(--gray-6)', color: 'var(--gray-11)' }}
          >
            <span className="font-mono-num" translate="no">ZySoulBot Admin</span>
            <span>本地受限会话 · CSRF 保护</span>
          </div>
        </div>
      </main>
    </div>
  )
}

export function Shell({
  mode,
  onModeChange,
  bots,
  activeBotId,
  onSelectBot,
  view,
  onLogout,
  children,
}: {
  mode: ThemeMode
  onModeChange: (m: ThemeMode) => void
  bots: BotSummary[]
  activeBotId: string | null
  onSelectBot: (id: string) => void
  view: ViewId
  onLogout: () => void
  children: React.ReactNode
}) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const inHub = !activeBotId
  const activeBot = activeBotId ? bots.find((b) => b.id === activeBotId) : undefined

  useEffect(() => {
    if (!mobileOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false)
    }
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [mobileOpen])

  const botOptions = bots.map((b) => ({
    value: b.id,
    label: b.name,
    sublabel: `@${b.id}`,
  }))

  const sidebarContent = (
    <div className="flex flex-col h-full px-3 py-4 gap-4">
      <div className="flex items-center justify-between px-1.5">
        <AppLink
          to={{ page: 'hub' }}
          onClick={() => setMobileOpen(false)}
          className="inline-flex items-center gap-2 min-w-0"
        >
          <BrandMark size={20} />
          <span className="text-[15px] font-semibold tracking-tight truncate" translate="no">
            ZySoulBot
          </span>
        </AppLink>
        <Button
          variant="ghost"
          size="icon"
          aria-label="关闭导航菜单"
          onClick={() => setMobileOpen(false)}
          className="lg:hidden"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </Button>
      </div>

      {/* 角色切换与返回大厅 */}
      <div className="space-y-2 pb-3 border-b" style={{ borderColor: 'var(--gray-6)' }}>
        <AppLink
          to={{ page: 'hub' }}
          onClick={() => setMobileOpen(false)}
          className="ui-btn ui-btn-ghost w-full justify-start min-h-[32px] px-2.5 text-[13px]"
        >
          <LayoutGrid className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--gray-10)' }} aria-hidden="true" />
          <span>全部角色大厅</span>
        </AppLink>
        {activeBotId && botOptions.length > 0 && (
          <Select
            ariaLabel="切换当前管理的角色"
            value={activeBotId}
            options={botOptions}
            onChange={(next) => {
              onSelectBot(next)
              setMobileOpen(false)
            }}
          />
        )}
      </div>

      {/* 6 大核心导航（真实 <a href> 支持中键/Cmd+Click 新开标签） */}
      <nav aria-label="角色视图导航" className="flex-1 space-y-0.5 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          const active = view === item.id
          return (
            <AppLink
              key={item.id}
              to={{ page: 'bot', botId: activeBotId ?? '', view: item.id }}
              onClick={() => setMobileOpen(false)}
              aria-current={active ? 'page' : undefined}
              className="flex items-center gap-2.5 px-2.5 py-2 min-h-[36px] rounded-[8px] text-[13px] transition-colors duration-150"
              style={{
                backgroundColor: active ? 'var(--accent-3)' : 'transparent',
                color: active ? 'var(--accent-11)' : 'var(--gray-11)',
                fontWeight: active ? 600 : 500,
              }}
            >
              <Icon className="w-4 h-4 shrink-0" strokeWidth={active ? 2 : 1.75} aria-hidden="true" />
              <span className="truncate flex-1">{item.label}</span>
              {item.id === 'soul' && (activeBot?.pendingTodos ?? 0) > 0 && (
                <span
                  className="font-mono-num text-[11px] px-1.5 py-0.5 rounded-full font-semibold leading-none"
                  style={{ backgroundColor: 'var(--warn-bg)', color: 'var(--warn-fg)' }}
                >
                  {activeBot!.pendingTodos}
                </span>
              )}
            </AppLink>
          )
        })}
      </nav>

      {/* 底部退出操作 */}
      <div className="pt-3 border-t" style={{ borderColor: 'var(--gray-6)' }}>
        <Button
          variant="ghost"
          size="sm"
          onClick={onLogout}
          className="w-full justify-start px-2.5"
        >
          <LogOut className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>退出登录</span>
        </Button>
      </div>
    </div>
  )

  const currentNav = NAV_ITEMS.find((n) => n.id === view)

  return (
    <div className="min-h-screen flex" style={{ backgroundColor: 'var(--canvas)' }}>
      {!inHub && (
        <>
          <aside
            className="hidden lg:block w-[232px] shrink-0 border-r sticky top-0 h-screen"
            style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--gray-6)' }}
          >
            {sidebarContent}
          </aside>

          {mobileOpen && (
            <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="导航菜单">
              <div
                className="ui-backdrop fixed inset-0"
                onClick={() => setMobileOpen(false)}
                aria-hidden="true"
              />
              <aside
                className="fixed left-0 top-0 bottom-0 w-[256px] border-r z-10 overscroll-contain"
                style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--gray-6)' }}
              >
                {sidebarContent}
              </aside>
            </div>
          )}
        </>
      )}

      <div className="flex-1 min-w-0 flex flex-col">
        <header
          className="sticky top-0 z-20 h-[54px] px-4 lg:px-7 border-b flex items-center justify-between gap-3"
          style={{
            backgroundColor: 'color-mix(in srgb, var(--canvas) 88%, transparent)',
            backdropFilter: 'blur(10px)',
            borderColor: 'var(--gray-6)',
          }}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            {inHub ? (
              <div className="flex items-center gap-2 min-w-0">
                <BrandMark size={20} />
                <span className="text-[15px] font-semibold tracking-tight" translate="no">
                  ZySoulBot
                </span>
              </div>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="打开导航菜单"
                  onClick={() => setMobileOpen(true)}
                  className="lg:hidden"
                >
                  <Menu className="w-4 h-4" aria-hidden="true" />
                </Button>
                <div className="flex items-center gap-1.5 min-w-0 text-[13px]">
                  <AppLink
                    to={{ page: 'hub' }}
                    className="hidden sm:inline truncate transition-colors hover:underline"
                    style={{ color: 'var(--gray-11)' }}
                  >
                    {activeBot?.name ?? activeBotId}
                  </AppLink>
                  <span className="hidden sm:inline" style={{ color: 'var(--gray-8)' }} aria-hidden="true">/</span>
                  <h1 className="text-[15px] font-semibold tracking-tight truncate">
                    {currentNav?.label}
                  </h1>
                </div>
              </>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <ThemeModeToggle mode={mode} onModeChange={onModeChange} />
            {inHub && (
              <Button variant="ghost" size="sm" onClick={onLogout} aria-label="退出登录">
                <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">退出</span>
              </Button>
            )}
          </div>
        </header>

        <main className="flex-1 w-full max-w-[1160px] mx-auto px-4 lg:px-7 py-6">
          {children}
        </main>
      </div>
    </div>
  )
}
