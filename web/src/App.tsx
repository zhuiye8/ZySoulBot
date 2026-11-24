import { useEffect, useState } from 'react'
import { Toaster, toast } from 'sonner'
import { api, setCsrfToken } from './lib/api.ts'
import type { BotSummary, OverviewResponse } from './lib/api.ts'
import { navigateTo, parseRoute } from './lib/router.ts'
import type { AppRoute, ViewId } from './lib/router.ts'
import { LoginScreen, Shell } from './components/Shell.tsx'
import type { ThemeId } from './components/Shell.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { HubView } from './views/HubView.tsx'
import { HomeView } from './views/HomeView.tsx'
import { InnerLifeView } from './views/InnerLifeView.tsx'
import { MemoryView } from './views/MemoryView.tsx'
import { WorksView } from './views/WorksView.tsx'
import { SoulView } from './views/SoulView.tsx'
import { UsageView } from './views/UsageView.tsx'

export function App() {
  const [theme, setTheme] = useState<ThemeId>(() => {
    const saved = localStorage.getItem('zysoul_theme')
    if (saved === 'mint' || saved === 'sky' || saved === 'sakura' || saved === 'night') return saved
    return 'mint'
  })
  const [ambient, setAmbient] = useState<boolean>(() => localStorage.getItem('zysoul_ambient') !== 'off')
  const [authState, setAuthState] = useState<'loading' | 'login' | 'ready'>('loading')
  const [bots, setBots] = useState<BotSummary[]>([])
  const [route, setRoute] = useState<AppRoute>(() =>
    parseRoute(window.location.pathname, window.location.search, window.location.hash),
  )
  const [overview, setOverview] = useState<OverviewResponse | null>(null)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('zysoul_theme', theme)
  }, [theme])

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

  const toggleAmbient = () => {
    setAmbient((prev) => {
      const next = !prev
      localStorage.setItem('zysoul_ambient', next ? 'on' : 'off')
      return next
    })
  }

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
    try {
      const [list, ov] = await Promise.all([api.bots(), api.overview(id)])
      setBots(list.bots)
      setOverview(ov)
    } catch (e) {
      toast.error((e as Error).message)
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
    toast.success('欢迎回来')
  }

  const handleLogout = async () => {
    await api.logout().catch(() => undefined)
    setCsrfToken('')
    setAuthState('login')
  }

  if (authState === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="font-voice text-sm" style={{ color: 'var(--text-2)' }}>正在唤醒灵魂中枢...</span>
      </div>
    )
  }

  if (authState === 'login') {
    return (
      <>
        <Toaster position="bottom-right" richColors />
        <LoginScreen theme={theme} onThemeChange={setTheme} ambient={ambient} onLogin={handleLogin} />
      </>
    )
  }

  const resetKey = route.page === 'hub' ? 'hub' : `${route.botId}:${route.view}:${route.tab ?? ''}`

  return (
    <>
      <Toaster position="bottom-right" richColors />
      <Shell
        theme={theme}
        onThemeChange={setTheme}
        ambient={ambient}
        onToggleAmbient={toggleAmbient}
        bots={bots}
        activeBotId={activeBotId}
        onGoHub={() => navigateTo({ page: 'hub' })}
        onSelectBot={(id) => navigateTo({ page: 'bot', botId: id, view: activeBotId ? activeView : 'home' })}
        view={activeView}
        onSelectView={(v) => {
          if (activeBotId) navigateTo({ page: 'bot', botId: activeBotId, view: v })
        }}
        onLogout={() => { void handleLogout() }}
      >
        <ErrorBoundary resetKey={resetKey}>
          {route.page === 'hub' ? (
            <HubView
              bots={bots}
              onSelectBot={(id) => navigateTo({ page: 'bot', botId: id, view: 'home' })}
            />
          ) : (
            <>
              {route.view === 'home' && overview && (
                <HomeView
                  data={overview}
                  onNavigate={(v) => navigateTo({ page: 'bot', botId: route.botId, view: v })}
                />
              )}
              {route.view === 'life' && <InnerLifeView botId={route.botId} />}
              {route.view === 'memory' && (
                <MemoryView
                  botId={route.botId}
                  initialTab={route.tab}
                  onTabChange={(tab) => navigateTo({ page: 'bot', botId: route.botId, view: 'memory', tab }, true)}
                />
              )}
              {route.view === 'works' && <WorksView botId={route.botId} />}
              {route.view === 'soul' && <SoulView botId={route.botId} />}
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
