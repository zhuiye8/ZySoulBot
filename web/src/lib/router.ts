// 轻量前端 URL 路由（History API，刷新与前进后退完全保持页面状态）：
// - /                    -> 多 Bot 大厅（选择灵魂角色）
// - /b/:botId/home       -> 今日概览
// - /b/:botId/life       -> 内心与生活
// - /b/:botId/memory     -> 记忆与关系（支持 ?tab=people|memories|chat）
// - /b/:botId/works      -> 声音与作品
// - /b/:botId/soul       -> 灵魂与能力（兼容 /b/:botId/credentials 别名）
// - /b/:botId/usage      -> 账本与诊断
export type ViewId = 'home' | 'life' | 'memory' | 'works' | 'soul' | 'usage'

const VALID_VIEWS = new Set<string>(['home', 'life', 'memory', 'works', 'soul', 'usage'])

export type AppRoute =
  | { page: 'hub' }
  | { page: 'bot'; botId: string; view: ViewId; tab?: string }

export function parseRoute(pathname: string, search = '', hash = ''): AppRoute {
  // 兼容旧版 #/b/:id/credentials 形式的哈希深链
  let effectivePath = pathname
  if (hash.startsWith('#/')) {
    effectivePath = hash.slice(1)
  }
  const clean = effectivePath.replace(/\/+$/, '') || '/'
  if (clean === '/' || clean === '/hub') {
    return { page: 'hub' }
  }
  const m = clean.match(/^\/b\/([^/]+)(?:\/([^/]+))?$/)
  if (!m) return { page: 'hub' }

  const botId = decodeURIComponent(m[1]!)
  const rawView = (m[2] ?? 'home').toLowerCase()
  const view: ViewId = rawView === 'credentials'
    ? 'soul'
    : (VALID_VIEWS.has(rawView) ? (rawView as ViewId) : 'home')
  const params = new URLSearchParams(search)
  const tab = params.get('tab') ?? undefined
  return { page: 'bot', botId, view, tab }
}

export function buildRouteUrl(route: AppRoute): string {
  if (route.page === 'hub') return '/'
  const base = `/b/${encodeURIComponent(route.botId)}/${route.view}`
  if (route.tab) return `${base}?tab=${encodeURIComponent(route.tab)}`
  return base
}

export function navigateTo(route: AppRoute, replace = false): void {
  const url = buildRouteUrl(route)
  const current = `${window.location.pathname}${window.location.search}`
  if (current === url) return
  if (replace) window.history.replaceState(null, '', url)
  else window.history.pushState(null, '', url)
  window.dispatchEvent(new PopStateEvent('popstate'))
}
