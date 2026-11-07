import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { THEME_STORAGE_KEY } from '../src/lib/theme-store'

const initializer = readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8')

function storage(initial: string | null = null) {
  const values = new Map(initial === null ? [] : [[THEME_STORAGE_KEY, initial]])
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value) }),
    removeItem(key: string) { values.delete(key) },
    clear() { values.clear() },
  }
}

function firstPaint(localStorage: ReturnType<typeof storage>, dark = false) {
  const document = { documentElement: { dataset: {} as Record<string, string> } }
  runInNewContext(initializer, { localStorage, document, matchMedia: () => ({ matches: dark }) })
  expect(localStorage.setItem).not.toHaveBeenCalled()
  return document.documentElement.dataset['theme']
}

async function mountTheme(localStorage: ReturnType<typeof storage>, dark = false) {
  const document = { documentElement: { dataset: {} as Record<string, string> } }
  let storageChange: (event: Pick<StorageEvent, 'key' | 'storageArea'>) => void = () => {}
  const media = { matches: dark, addEventListener: vi.fn(), removeEventListener: vi.fn() }
  vi.stubGlobal('window', {
    localStorage, matchMedia: () => media,
    addEventListener: (_name: string, listener: typeof storageChange) => { storageChange = listener },
    removeEventListener: vi.fn(),
  })
  vi.stubGlobal('document', document)
  await import('../src/lib/theme')
  return {
    dataset: document.documentElement.dataset,
    dispatch(key: string | null, storageArea: Storage | null = localStorage as unknown as Storage) {
      storageChange({ key, storageArea })
    },
  }
}

beforeEach(() => { vi.resetModules() })
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('browser theme initialization and storage events', () => {
  it.each(['light', 'dark'] as const)('restores saved %s consistently before and after the application starts', async preference => {
    const localStorage = storage(preference)
    expect(firstPaint(localStorage, preference === 'light')).toBe(preference)
    const { dataset } = await mountTheme(localStorage, preference === 'light')
    expect(dataset['theme']).toBe(preference)
    expect(localStorage.setItem).not.toHaveBeenCalled()
  })

  it.each(['system', 'invalid', '', null])('uses the system theme for saved preference %j in both startup paths', async preference => {
    const localStorage = storage(preference)
    expect(firstPaint(localStorage, true)).toBe('dark')
    const { dataset } = await mountTheme(localStorage, true)
    expect(dataset['theme']).toBe('dark')
  })

  it('uses the system theme when browser storage is disabled', async () => {
    const localStorage = storage('light')
    localStorage.getItem.mockImplementation(() => { throw new Error('Storage disabled') })
    expect(firstPaint(localStorage, true)).toBe('dark')
    const { dataset } = await mountTheme(localStorage, true)
    expect(dataset['theme']).toBe('dark')
  })

  it('syncs choices and clearing from other tabs while ignoring unrelated storage events', async () => {
    const localStorage = storage('dark')
    const { dataset, dispatch } = await mountTheme(localStorage)
    expect(dataset['theme']).toBe('dark')
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    dispatch(THEME_STORAGE_KEY)
    expect(dataset['theme']).toBe('light')
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    dispatch(THEME_STORAGE_KEY)
    expect(dataset['theme']).toBe('dark')
    localStorage.removeItem(THEME_STORAGE_KEY)
    dispatch(THEME_STORAGE_KEY)
    expect(dataset['theme']).toBe('light')
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    dispatch(THEME_STORAGE_KEY)
    localStorage.clear()
    dispatch(null)
    expect(dataset['theme']).toBe('light')
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    dispatch('unrelated-setting')
    expect(dataset['theme']).toBe('light')
    dispatch(THEME_STORAGE_KEY, {} as Storage)
    expect(dataset['theme']).toBe('light')
    dispatch(THEME_STORAGE_KEY)
    expect(dataset['theme']).toBe('dark')
  })
})
