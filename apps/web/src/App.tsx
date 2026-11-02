import { useState } from 'react'
import { ConnectionsPage } from './pages/ConnectionsPage'
import { ConnectionDetailPage } from './pages/ConnectionDetailPage'
import { RemoteLoginPage } from './pages/RemoteLoginPage'

export type Route =
  | { name: 'connections' }
  | { name: 'connection'; id: string }
  | { name: 'screen'; id: string }

export function App() {
  // 直接手写路由：页面只有三个，引入 TanStack Router 的收益不足，
  // 且 shadcn/ui 组件尚未落地（M2 补）。路由状态保持简单可测试。
  const [route, setRoute] = useState<Route>({ name: 'connections' })

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
        </nav>
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
      </main>
    </div>
  )
}
