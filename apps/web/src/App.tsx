import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, RouterProvider, useNavigate, useRouterState } from '@tanstack/react-router'
import { authApi, onSessionLost, type AuthStatus } from './lib/api'
import { describeAuthError } from './lib/http'
import { createAppRouter, isNavigationActive, navigationGroups, pagePaths, routeHref, type Route } from './lib/routing'
import { ConnectionsPage } from './pages/ConnectionsPage'
import { ConnectionDetailPage } from './pages/ConnectionDetailPage'
import { RemoteLoginPage } from './pages/RemoteLoginPage'
import { SettingsPage } from './pages/SettingsPage'
import { ClientsPage } from './pages/ClientsPage'
import { OverviewPage, TasksPage, ProposalsPage, AuditPage } from './pages/ProductPages'
import { MonitorsPage } from './pages/MonitorsPage'
import { ExtensionsPage } from './pages/ExtensionsPage'
import { McpToolsPage } from './pages/McpToolsPage'
import { BootstrapPage, LoginPage } from './pages/LoginPage'
import { StepUpDialog } from './components/StepUpDialog'
import { Icon } from './components/Icon'
import { BrandMark } from './components/BrandMark'

export type { Route } from './lib/routing'

const AUTH_STATUS_KEY = ['auth-status']
const AuthStatusContext = createContext<AuthStatus | null>(null)

export function App() {
  return <RouterProvider router={router} />
}

function AuthBoundary() {
  const qc = useQueryClient()
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const status = useQuery({
    queryKey: AUTH_STATUS_KEY,
    queryFn: authApi.status,
    retry: false,
    staleTime: 30_000,
  })

  // 任何后台接口返回 401：重新读取登录态。确实已登出时自然回到登录页。
  useEffect(
    () =>
      onSessionLost((err) => {
        setNotice(err.code === 'SESSION_EXPIRED' ? '登录已过期，请重新登录。' : '请先登录。')
        void qc.invalidateQueries({ queryKey: AUTH_STATUS_KEY })
      }),
    [qc],
  )

  const refresh = () => {
    setNotice(undefined)
    void qc.invalidateQueries({ queryKey: AUTH_STATUS_KEY })
  }

  if (status.isPending) {
    return (
      <div className="auth-shell">
        <p className="muted">正在读取登录状态…</p>
      </div>
    )
  }
  if (status.isError) {
    return (
      <div className="auth-shell">
        <div className="card error-card">
          <p className="card-title">无法连接后台服务</p>
          <p className="muted">发生了什么：{describeAuthError(status.error)}</p>
          <p className="muted">下一步：确认 server 正在运行，然后重试。</p>
          <div className="card-actions">
            <button onClick={() => void status.refetch()}>重试</button>
          </div>
        </div>
      </div>
    )
  }
  if (!status.data.hasUser) return <BootstrapPage onDone={refresh} />
  if (!status.data.authenticated) {
    return <LoginPage onDone={refresh} {...(notice !== undefined ? { notice } : {})} />
  }
  return <Shell status={status.data} />
}

function Shell({ status }: { status: AuthStatus }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const pathname = useRouterState({ select: state => state.location.pathname })
  const [menuOpen, setMenuOpen] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const menuDialog = useRef<HTMLDialogElement>(null)
  const closeMenu = useCallback(() => {
    menuDialog.current?.close()
    setMenuOpen(false)
    menuButton.current?.focus()
  }, [])

  useEffect(() => {
    const dialog = menuDialog.current
    if (!menuOpen || !dialog || dialog.open) return
    dialog.showModal()
    dialog.querySelector<HTMLElement>('.nav [aria-current="page"]')?.focus()
  }, [menuOpen])

  useEffect(() => {
    if (menuDialog.current?.open) closeMenu()
  }, [pathname, closeMenu])

  useEffect(() => {
    const mobile = window.matchMedia('(max-width: 900px)')
    const resized = () => { if (!mobile.matches && menuDialog.current?.open) closeMenu() }
    mobile.addEventListener('change', resized)
    return () => mobile.removeEventListener('change', resized)
  }, [closeMenu])

  const logout = useMutation({
    mutationFn: authApi.logout,
    onSettled: () => {
      // 先让登录态失效（渲染登录页），再丢掉其他缓存，避免下一位登录者看到旧数据
      void qc.invalidateQueries({ queryKey: AUTH_STATUS_KEY })
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== AUTH_STATUS_KEY[0] })
    },
  })

  const sidebarContent = (mobile: boolean) => (
    <>
      <div className="sidebar-head">
        <Link className="brand" to="/" onClick={mobile ? closeMenu : undefined}><BrandMark /><span>OwnGate</span></Link>
        {mobile && <button className="sidebar-close" aria-label="关闭导航" onClick={closeMenu}><Icon name="close" size={20} /></button>}
      </div>
      <nav className="nav" aria-label="主导航">
        {navigationGroups.map(group => (
          <div className="nav-group" key={group.label}>
            <h2 className="nav-group-label">{group.label}</h2>
            {group.items.map(item => {
              const active = isNavigationActive(item.page, pathname)
              return <Link key={item.page} to={pagePaths[item.page]} className={`nav-item${active ? ' active' : ''}`}
                activeOptions={{ exact: item.page === 'overview', includeSearch: false }}
                aria-current={active ? 'page' : undefined} onClick={mobile ? closeMenu : undefined}><Icon name={item.page} size={18} /><span>{item.label}</span></Link>
            })}
          </div>
        ))}
      </nav>
      <div className="sidebar-footer">
        <button className="nav-item" onClick={() => { if (mobile) closeMenu(); logout.mutate() }} disabled={logout.isPending}>
          <Icon name="logout" size={18} />
          {logout.isPending ? '退出中…' : '退出'}
        </button>
      </div>
    </>
  )

  return (
    <AuthStatusContext.Provider value={status}>
      <div className="app-shell">
        <a className="skip-link" href="#main-content">跳到主内容</a>
        <aside className="sidebar">{sidebarContent(false)}</aside>
        <div className="main-shell">
          <header className="mobile-topbar">
            <button ref={menuButton} className="menu-toggle" aria-label="打开导航" aria-controls="mobile-navigation"
              aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Icon name="menu" size={22} /></button>
            <Link className="brand" to="/"><BrandMark size={26} /><span>OwnGate</span></Link>
          </header>
          <main className="content" id="main-content" tabIndex={-1}><Outlet /></main>
        </div>
        <dialog ref={menuDialog} id="mobile-navigation" className="sidebar-dialog" aria-label="导航菜单"
          onCancel={event => { event.preventDefault(); closeMenu() }}
          onClose={() => { setMenuOpen(false); menuButton.current?.focus() }}
          onClick={event => {
            if (event.target !== event.currentTarget) return
            const bounds = event.currentTarget.getBoundingClientRect()
            if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeMenu()
          }}>
          <aside className="sidebar sidebar-drawer">{sidebarContent(true)}</aside>
        </dialog>
        <StepUpDialog status={status} onOpenSecurity={() => void navigate({ to: '/settings/security' })} />
      </div>
    </AuthStatusContext.Provider>
  )
}

function PageContent({ route }: { route: Route }) {
  const navigate = useNavigate()
  const status = useContext(AuthStatusContext)
  const go = (destination: Exclude<Route, { name: 'not-found' }>) => void navigate({ to: routeHref(destination) })
  switch (route.name) {
    case 'overview': return <OverviewPage onConnection={id => go({ name: 'connection', id })} onNavigate={name => go({ name })} />
    case 'tasks': return <TasksPage {...(route.id !== undefined ? { selectedId: route.id } : {})} onSelect={id => go(id === undefined ? { name: 'tasks' } : { name: 'tasks', id })} />
    case 'monitors': return <MonitorsPage />
    case 'extensions': return <ExtensionsPage />
    case 'mcp-tools': return <McpToolsPage />
    case 'proposals': return <ProposalsPage />
    case 'audit': return <AuditPage />
    case 'connections': return <ConnectionsPage onOpen={id => go({ name: 'connection', id })} />
    case 'connection': return <ConnectionDetailPage id={route.id} onBack={() => go({ name: 'connections' })}
      onOpenScreen={id => go({ name: 'screen', id })} />
    case 'screen': return <RemoteLoginPage id={route.id} onBack={() => go({ name: 'connection', id: route.id })} />
    case 'settings': return status ? <SettingsPage status={status} section={route.section ?? 'account'} /> : null
    case 'clients': return <ClientsPage />
    case 'not-found': return <section className="card"><h1>找不到页面</h1><p className="muted">请检查地址，或返回概览。</p><Link to="/">返回概览</Link></section>
  }
}

const router = createAppRouter({ rootComponent: AuthBoundary, pageComponent: PageContent })
