import { useEffect, useState } from 'react'
import { Toaster, toast } from 'sonner'
import { api, setCsrfToken } from './lib/api.ts'
import type { BotSummary, OverviewResponse } from './lib/api.ts'
import { navigateTo, parseRoute } from './lib/router.ts'
import type { AppRoute, ViewId } from './lib/router.ts'
import { LoginScreen, Shell } from './components/Shell.tsx'
import type { ThemeMode } from './components/Shell.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { HubView } from './views/HubView.tsx'
import { HomeView } from './views/HomeView.tsx'
import { InnerLifeView } from './views/InnerLifeView.tsx'
import { MemoryView } from './views/MemoryView.tsx'
import { WorksView } from './views/WorksView.tsx'
import { SoulView } from './views/SoulView.tsx'
import { UsageView } from './views/UsageView.tsx'

function resolveEffectiveMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') return mode
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark'
  }
  return 'light'
}

export function App() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('zysoul_mode')
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
    // 兼容旧版 night 主题偏好
    if (localStorage.getItem('zysoul_theme') === 'night') return 'dark'
    return 'light'
  })
  const [effectiveMode, setEffectiveMode] = useState<'light' | 'dark'>(() => resolveEffectiveMode(mode))
  const [authState, setAuthState] = useState<'loading' | 'login' | 'ready'>('loading')
  const [bots, setBots] = useState<BotSummary[]>([])
  const [route, setRoute] = useState<AppRoute>(() =>
    parseRoute(window.location.pathname, window.location.search, window.location.hash),
  )
  const [overview, setOverview] = useState<OverviewResponse | null>(null)
  const [overviewLoading, setOverviewLoading] = useState(false)
  const [overviewError, setOverviewError] = useState('')

  useEffect(() => {
    localStorage.setItem('zysoul_mode', mode)
    const apply = () => {
      const resolved = resolveEffectiveMode(mode)
      setEffectiveMode(resolved)
      document.documentElement.setAttribute('data-mode', resolved)
      const meta = document.querySelector('meta[name="theme-color"]')
      if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0C100E' : '#FAFBF9')
    }
    apply()
    if (mode !== 'system' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [mode])

  useEffect(() => {
    const sync = () => {
      setRoute(parseRoute(window.location.pathname, window.location.search, window.location.hash))
    }
    window.addEventListener('popstate', sync)
    window.addEventListener('hashchange', sync)
    return () => {
      window.removeEventListener('popstate', sync)
      window.removeEventListener('hashchange', sync)
    }
  }, [])

  const loadBots = async (): Promise<BotSummary[]> => {
    const list = await api.bots()
    setBots(list.bots)
    return list.bots
  }

  const bootstrap = async () => {
    try {
      const me = await api.me()
      if (!me.authenticated) {
        setAuthState('login')
        return
      }
      if (me.csrf) setCsrfToken(me.csrf)
      const list = await loadBots()
      const current = parseRoute(window.location.pathname, window.location.search, window.location.hash)
      if (current.page === 'bot' && !list.some((b) => b.id === current.botId)) {
        navigateTo({ page: 'hub' }, true)
      } else if (window.location.hash.startsWith('#/')) {
        navigateTo(current, true)
      }
      setAuthState('ready')
    } catch {
      setAuthState('login')
    }
  }

  useEffect(() => {
    void bootstrap()
  }, [])

  const activeBotId = route.page === 'bot' ? route.botId : null
  const activeView: ViewId = route.page === 'bot' ? route.view : 'home'

  const refreshOverview = async (id: string) => {
    setOverviewLoading(true)
    setOverviewError('')
    try {
      const [list, ov] = await Promise.all([api.bots(), api.overview(id)])
      setBots(list.bots)
      setOverview(ov)
    } catch (e) {
      const msg = (e as Error).message
      setOverviewError(msg)
      toast.error(msg)
    } finally {
      setOverviewLoading(false)
    }
  }

  useEffect(() => {
    if (authState !== 'ready') return
    if (route.page === 'hub') {
      void loadBots().catch(() => undefined)
      return
    }
    if (route.view === 'home') {
      void refreshOverview(route.botId)
    }
  }, [authState, route.page, activeBotId, activeView])

  const handleLogin = async (password: string) => {
    const res = await api.login(password)
    setCsrfToken(res.csrf)
    await bootstrap()
    toast.success('已进入数字灵魂中枢')
  }

  const handleLogout = async () => {
    await api.logout().catch(() => undefined)
    setCsrfToken('')
    setAuthState('login')
  }

  if (authState === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: 'var(--canvas)' }}>
        <span className="text-[13px]" style={{ color: 'var(--gray-11)' }}>正在连接后台服务…</span>
      </div>
    )
  }

  if (authState === 'login') {
    return (
      <>
        <Toaster position="bottom-right" theme={effectiveMode} closeButton />
        <LoginScreen mode={mode} onModeChange={setMode} onLogin={handleLogin} />
      </>
    )
  }

  const resetKey = route.page === 'hub' ? 'hub' : `${route.botId}:${route.view}:${route.tab ?? ''}`

  return (
    <>
      <Toaster position="bottom-right" theme={effectiveMode} closeButton />
      <Shell
        mode={mode}
        onModeChange={setMode}
        bots={bots}
        activeBotId={activeBotId}
        onSelectBot={(id) => navigateTo({ page: 'bot', botId: id, view: activeBotId ? activeView : 'home' })}
        view={activeView}
        onLogout={() => { void handleLogout() }}
      >
        <ErrorBoundary resetKey={resetKey}>
          {route.page === 'hub' ? (
            <HubView bots={bots} />
          ) : (
            <>
              {route.view === 'home' && (
                <HomeView
                  botId={route.botId}
                  data={overview}
                  loading={overviewLoading}
                  error={overviewError}
                  onRetry={() => { void refreshOverview(route.botId) }}
                />
              )}
              {route.view === 'life' && (
                <InnerLifeView
                  botId={route.botId}
                  initialTab={route.tab}
                  onTabChange={(tab) => navigateTo({ page: 'bot', botId: route.botId, view: 'life', tab }, true)}
                />
              )}
              {route.view === 'memory' && (
                <MemoryView
                  botId={route.botId}
                  initialTab={route.tab}
                  onTabChange={(tab) => navigateTo({ page: 'bot', botId: route.botId, view: 'memory', tab }, true)}
                />
              )}
              {route.view === 'works' && (
                <WorksView
                  botId={route.botId}
                  initialTab={route.tab}
                  onTabChange={(tab) => navigateTo({ page: 'bot', botId: route.botId, view: 'works', tab }, true)}
                />
              )}
              {route.view === 'soul' && (
                <SoulView
                  botId={route.botId}
                  initialTab={route.tab}
                  onTabChange={(tab) => navigateTo({ page: 'bot', botId: route.botId, view: 'soul', tab }, true)}
                />
              )}
              {route.view === 'usage' && (
                <UsageView
                  botId={route.botId}
                  onWiped={() => { void refreshOverview(route.botId) }}
                />
              )}
            </>
          )}
        </ErrorBoundary>
      </Shell>
    </>
  )
}
