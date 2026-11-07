import { describe, expect, it } from 'vitest'
import { createMemoryHistory } from '@tanstack/react-router'
import { createAppRouter, isNavigationActive, navigationGroups, pagePaths, routeHref } from '../src/lib/routing'

function memoryRouter(path = '/') {
  const history = createMemoryHistory({ initialEntries: [path] })
  const router = createAppRouter({ rootComponent: () => null, pageComponent: () => null, history })
  return { router, history }
}

describe('application URLs', () => {
  it('every sidebar destination resolves to its own page', () => {
    const { router } = memoryRouter()
    const items = navigationGroups.flatMap(group => group.items)
    expect(items).toHaveLength(10)
    expect(navigationGroups.find(group => group.label === '常用')?.items.map(item => item.label)).toEqual(['概览', '任务'])
    expect(navigationGroups.find(group => group.label === '接入')?.items.map(item => item.label)).toEqual(['连接', '扩展'])
    expect(new Set(items.map(item => item.page)).size).toBe(items.length)
    for (const item of items) {
      const path = routeHref({ name: item.page })
      expect(path).toBe(pagePaths[item.page])
      const matches = router.matchRoutes(path)
      expect(matches.at(-1)?.routeId).toBe(path)
      expect(matches.some(match => match._notFound)).toBe(false)
    }
  })

  it.each([
    ['/tasks/task_123', '/tasks/$id', 'task_123'],
    ['/connections/con_123', '/connections/$id', 'con_123'],
    ['/connections/con_123/login', '/connections/$id/login', 'con_123'],
    ['/connections/%E4%B8%AA%E4%BA%BA%2F%E7%A4%BA%E4%BE%8B/login', '/connections/$id/login', '个人/示例'],
  ])('loads a directly opened detail URL %s', async (url, routeId, id) => {
    const { router } = memoryRouter(url)
    await router.load()
    expect(router.state.location.pathname).toBe(decodeURI(url))
    expect(router.state.matches.at(-1)?.routeId).toBe(routeId)
    expect(router.state.matches.at(-1)?.params).toMatchObject({ id })
    expect(router.state.matches.some(match => match._notFound)).toBe(false)
  })

  it('keeps IDs inside one URL segment instead of introducing queries or other routes', () => {
    const id = '示例/one?token=unsafe#part'
    const href = routeHref({ name: 'screen', id })
    const parsed = new URL(href, 'https://owngate.example')
    expect(parsed.search).toBe('')
    expect(parsed.hash).toBe('')
    expect(parsed.pathname.split('/')).toHaveLength(4)
    expect(memoryRouter().router.matchRoutes(href).at(-1)?.params).toMatchObject({ id })
    expect(routeHref({ name: 'tasks', id })).toBe(`/tasks/${encodeURIComponent(id)}`)
    const connectionHref = routeHref({ name: 'connection', id })
    expect(connectionHref).toBe(`/connections/${encodeURIComponent(id)}`)
    expect(memoryRouter().router.matchRoutes(connectionHref).at(-1)?.params).toMatchObject({ id })
  })

  it('restores pages and detail selection through history and a fresh router', async () => {
    const { router, history } = memoryRouter('/tasks/task_original')
    await router.load()
    history.push('/connections/con_selected/login')
    await router.load()
    expect(router.state.matches.at(-1)?.routeId).toBe('/connections/$id/login')
    history.back()
    await router.load()
    expect(router.state.matches.at(-1)?.routeId).toBe('/tasks/$id')
    expect(router.state.matches.at(-1)?.params).toMatchObject({ id: 'task_original' })
    history.forward()
    await router.load()
    expect(router.state.matches.at(-1)?.params).toMatchObject({ id: 'con_selected' })
    const refreshed = memoryRouter(history.location.href).router
    await refreshed.load()
    expect(refreshed.state.location.pathname).toBe('/connections/con_selected/login')
    expect(refreshed.state.matches.at(-1)?.routeId).toBe('/connections/$id/login')
  })

  it('opens settings sections directly and restores them through browser history', async () => {
    const { router, history } = memoryRouter(routeHref({ name: 'settings' }))
    await router.load()
    expect(router.state.matches.at(-1)?.routeId).toBe('/settings')
    for (const section of ['appearance', 'security'] as const) {
      const url = routeHref({ name: 'settings', section })
      history.push(url)
      await router.load()
      expect(router.state.matches.at(-1)?.routeId).toBe(url)
      expect(router.state.matches.some(match => match._notFound)).toBe(false)
      expect(isNavigationActive('settings', url)).toBe(true)
      const refreshed = memoryRouter(url).router
      await refreshed.load()
      expect(refreshed.state.matches.at(-1)?.routeId).toBe(url)
    }
    history.back()
    await router.load()
    expect(router.state.location.pathname).toBe('/settings/appearance')
    history.forward()
    await router.load()
    expect(router.state.location.pathname).toBe('/settings/security')
  })

  it.each(['/new-api', '/feed', '/security', '/connections/con_123/new-api', '/overview', '/unknown', '/security/extra', '/settings/extra', '/settings/security/extra', '/connections/con_123/login/extra', '/connections/con_123/new-api/extra'])('keeps unknown URL %s as not found', async path => {
    const { router } = memoryRouter(path)
    await router.load()
    expect(router.state.location.pathname).toBe(path)
    expect(router.state.matches.some(match => match._notFound)).toBe(true)
    expect(router.state.matches.some(match => match.routeId === '/')).toBe(false)
  })

  it('marks parent navigation for task and connection details without prefix collisions', () => {
    expect(isNavigationActive('overview', '/')).toBe(true)
    expect(isNavigationActive('overview', '/tasks')).toBe(false)
    expect(isNavigationActive('tasks', '/tasks/task_123')).toBe(true)
    expect(isNavigationActive('connections', '/connections/con_123/login')).toBe(true)
    expect(isNavigationActive('settings', '/settings-old')).toBe(false)
    expect(isNavigationActive('tasks', '/tasksmith')).toBe(false)
  })
})
