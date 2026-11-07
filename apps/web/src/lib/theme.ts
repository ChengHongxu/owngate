import { useSyncExternalStore } from 'react'
import { createThemeStore, THEME_STORAGE_KEY } from './theme-store'

export type { ThemePreference } from './theme-store'

const media = window.matchMedia('(prefers-color-scheme: dark)')
const store = createThemeStore({
  read: () => window.localStorage.getItem(THEME_STORAGE_KEY),
  write: value => window.localStorage.setItem(THEME_STORAGE_KEY, value),
  systemIsDark: () => media.matches,
  apply: value => { document.documentElement.dataset['theme'] = value },
  listenSystem(listener) {
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  },
  listenStorage(listener) {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== THEME_STORAGE_KEY) return
      try { if (event.storageArea && event.storageArea !== window.localStorage) return } catch { return }
      try { listener(window.localStorage.getItem(THEME_STORAGE_KEY)) } catch { /* Keep this page's current choice. */ }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  },
})

// Release global subscriptions when Vite replaces this module during development.
if (import.meta.hot) import.meta.hot.dispose(() => store.destroy())

export function useTheme() {
  const preference = useSyncExternalStore(store.subscribe, store.getPreference)
  return { preference, setPreference: store.setPreference }
}
