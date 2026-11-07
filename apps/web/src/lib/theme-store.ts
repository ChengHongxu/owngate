export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = Exclude<ThemePreference, 'system'>

export const THEME_STORAGE_KEY = 'owngate.theme'

export function parseThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system'
}

interface ThemeEnvironment {
  read: () => string | null
  write: (value: ThemePreference) => void
  systemIsDark: () => boolean
  apply: (value: ResolvedTheme) => void
  listenSystem: (listener: () => void) => () => void
  listenStorage: (listener: (value: string | null) => void) => () => void
}

/** Device preference stays usable even when browser storage is unavailable. */
export function createThemeStore(environment: ThemeEnvironment) {
  let preference: ThemePreference = 'system'
  try { preference = parseThemePreference(environment.read()) } catch { /* Use the system default. */ }
  const listeners = new Set<() => void>()
  const apply = () => environment.apply(preference === 'system'
    ? environment.systemIsDark() ? 'dark' : 'light'
    : preference)
  const update = (value: ThemePreference) => {
    const changed = preference !== value
    preference = value
    apply()
    if (changed) for (const listener of listeners) listener()
  }

  apply()
  const stopSystem = environment.listenSystem(() => { if (preference === 'system') apply() })
  const stopStorage = environment.listenStorage(value => update(parseThemePreference(value)))

  return {
    getPreference: () => preference,
    setPreference(value: ThemePreference) {
      try { environment.write(value) } catch { /* Keep the choice for this page. */ }
      update(value)
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    destroy() {
      stopSystem()
      stopStorage()
      listeners.clear()
    },
  }
}
