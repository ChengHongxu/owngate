import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { authApi, onSessionLost, type AuthStatus } from './lib/api'
import { describeAuthError } from './lib/http'
import { ConnectionsPage } from './pages/ConnectionsPage'
import { ConnectionDetailPage } from './pages/ConnectionDetailPage'
import { RemoteLoginPage } from './pages/RemoteLoginPage'
import { SecurityPage } from './pages/SecurityPage'
import { BootstrapPage, LoginPage } from './pages/LoginPage'
import { StepUpDialog } from './components/StepUpDialog'

export type Route =
  | { name: 'connections' }
  | { name: 'connection'; id: string }
  | { name: 'screen'; id: string }
  | { name: 'security' }

const AUTH_STATUS_KEY = ['auth-status']

export function App() {
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
  // 直接手写路由：页面只有几个，引入 TanStack Router 的收益不足，
  // 且 shadcn/ui 组件尚未落地（M2 补）。路由状态保持简单可测试。
  const [route, setRoute] = useState<Route>({ name: 'connections' })

  const logout = useMutation({
    mutationFn: authApi.logout,
    onSettled: () => {
      // 先让登录态失效（渲染登录页），再丢掉其他缓存，避免下一位登录者看到旧数据
      void qc.invalidateQueries({ queryKey: AUTH_STATUS_KEY })
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== AUTH_STATUS_KEY[0] })
    },
  })

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setRoute({ name: 'connections' })}>
          webridge
        </button>
        <nav className="nav">
          <button
            className={route.name === 'connections' ? 'nav-item active' : 'nav-item'}
            onClick={() => setRoute({ name: 'connections' })}
          >
            连接
          </button>
          <button
            className={route.name === 'security' ? 'nav-item active' : 'nav-item'}
            onClick={() => setRoute({ name: 'security' })}
          >
            安全设置
          </button>
        </nav>
        <div className="topbar-end">
          <button className="nav-item" onClick={() => logout.mutate()} disabled={logout.isPending}>
            {logout.isPending ? '退出中…' : '退出'}
          </button>
        </div>
      </header>

      <main className="content">
        {route.name === 'connections' && (
          <ConnectionsPage
            onOpen={(id) => setRoute({ name: 'connection', id })}
          />
        )}
        {route.name === 'connection' && (
          <ConnectionDetailPage
            id={route.id}
            onBack={() => setRoute({ name: 'connections' })}
            onOpenScreen={(id) => setRoute({ name: 'screen', id })}
          />
        )}
        {route.name === 'screen' && (
          <RemoteLoginPage id={route.id} onBack={() => setRoute({ name: 'connection', id: route.id })} />
        )}
        {route.name === 'security' && <SecurityPage status={status} />}
      </main>

      <StepUpDialog status={status} onOpenSecurity={() => setRoute({ name: 'security' })} />
    </div>
  )
}
