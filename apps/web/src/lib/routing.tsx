import type { ComponentType } from 'react'
import { Link, createRootRoute, createRoute, createRouter, useParams, type RouteComponent, type RouterHistory } from '@tanstack/react-router'

export type NavigationPage = 'overview' | 'tasks' | 'connections' | 'extensions'
  | 'monitors' | 'proposals' | 'clients' | 'mcp-tools' | 'audit' | 'settings'

export type SettingsSection = 'account' | 'appearance' | 'security'

export type Route =
  | { name: Exclude<NavigationPage, 'tasks' | 'settings'> }
  | { name: 'tasks'; id?: string }
  | { name: 'settings'; section?: SettingsSection }
  | { name: 'connection' | 'screen'; id: string }
  | { name: 'not-found' }

export const pagePaths: Record<NavigationPage, string> = {
  overview: '/', tasks: '/tasks', connections: '/connections',
  extensions: '/extensions', monitors: '/monitors', proposals: '/proposals', clients: '/clients',
  'mcp-tools': '/mcp-tools', audit: '/audit', settings: '/settings',
}

export const navigationGroups: ReadonlyArray<{ label: string; items: ReadonlyArray<{ page: NavigationPage; label: string }> }> = [
  { label: '常用', items: [{ page: 'overview', label: '概览' }, { page: 'tasks', label: '任务' }] },
  { label: '接入', items: [{ page: 'connections', label: '连接' }, { page: 'extensions', label: '扩展' }] },
  { label: '自动化', items: [{ page: 'monitors', label: '监控通知' }, { page: 'proposals', label: '提案' }] },
  { label: '管理', items: [{ page: 'clients', label: '客户端' }, { page: 'mcp-tools', label: 'MCP 工具' }, { page: 'audit', label: '审计记录' }, { page: 'settings', label: '设置' }] },
]

export function routeHref(route: Exclude<Route, { name: 'not-found' }>): string {
  if (route.name === 'connection') return `/connections/${encodeURIComponent(route.id)}`
  if (route.name === 'screen') return `/connections/${encodeURIComponent(route.id)}/login`
  if (route.name === 'tasks' && route.id !== undefined) return `/tasks/${encodeURIComponent(route.id)}`
  if (route.name === 'settings' && route.section && route.section !== 'account') return `/settings/${route.section}`
  return pagePaths[route.name]
}

export function isNavigationActive(page: NavigationPage, pathname: string): boolean {
  const path = pagePaths[page]
  return pathname === path || (page !== 'overview' && pathname.startsWith(`${path}/`))
}

type PageComponent = ComponentType<{ route: Route }>

function DetailRoute({ name, Page }: { name: 'tasks' | 'connection' | 'screen'; Page: PageComponent }) {
  const { id } = useParams({ strict: false })
  return typeof id === 'string' && id.length > 0
    ? <Page route={{ name, id }} />
    : <Page route={{ name: 'not-found' }} />
}

export function createAppRouter({ rootComponent, pageComponent: Page, history }: {
  rootComponent: RouteComponent
  pageComponent: PageComponent
  history?: RouterHistory
}) {
  const root = createRootRoute({
    component: rootComponent,
    notFoundComponent: () => <Page route={{ name: 'not-found' }} />,
  })
  const pages = Object.entries(pagePaths).map(([name, path]) => createRoute({
    getParentRoute: () => root, path,
    component: () => <Page route={{ name: name as NavigationPage }} />,
  }))
  const details = ([['/tasks/$id', 'tasks'], ['/connections/$id', 'connection'], ['/connections/$id/login', 'screen']] as const)
    .map(([path, name]) => createRoute({ getParentRoute: () => root, path, component: () => <DetailRoute name={name} Page={Page} /> }))
  const settingsSections = (['appearance', 'security'] as const).map(section => createRoute({
    getParentRoute: () => root,
    path: `/settings/${section}`,
    component: () => <Page route={{ name: 'settings', section }} />,
  }))
  return createRouter({
    routeTree: root.addChildren([...pages, ...details, ...settingsSections]),
    ...(history ? { history } : {}),
    scrollRestoration: true,
    defaultErrorComponent: ({ reset }) => (
      <section className="card error-card" role="alert">
        <h1>页面暂时无法打开</h1>
        <div className="card-actions"><button onClick={reset}>重试</button><Link to="/">返回概览</Link></div>
      </section>
    ),
  })
}
