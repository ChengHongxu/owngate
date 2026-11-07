import { describe, expect, it, vi } from 'vitest'
import { createThemeStore } from '../src/lib/theme-store'

function browser(initial: string | null = null, dark = false, blocked = false) {
  let value = initial
  let systemChange = () => {}
  let storageChange = (_value: string | null) => {}
  const apply = vi.fn()
  const write = vi.fn((next: string) => { if (blocked) throw new Error('Storage disabled'); value = next })
  const stopSystem = vi.fn()
  const stopStorage = vi.fn()
  const store = createThemeStore({
    read: () => { if (blocked) throw new Error('Storage disabled'); return value },
    write, apply, systemIsDark: () => dark,
    listenSystem: listener => { systemChange = listener; return stopSystem },
    listenStorage: listener => { storageChange = listener; return stopStorage },
  })
  return {
    store, apply, write, stopSystem, stopStorage,
    changeSystem(next: boolean) { dark = next; systemChange() },
    changeStorage(next: string | null) { storageChange(next) },
  }
}

describe('browser theme preference', () => {
  it('defaults to system and responds to operating-system changes', () => {
    const { store, apply, changeSystem } = browser(null, true)
    expect(store.getPreference()).toBe('system')
    expect(apply).toHaveBeenLastCalledWith('dark')
    changeSystem(false)
    expect(apply).toHaveBeenLastCalledWith('light')
    expect(store.getPreference()).toBe('system')
  })

  it.each(['light', 'dark'] as const)('restores an explicit %s choice and ignores system changes', preference => {
    const { store, apply, changeSystem } = browser(preference, preference === 'light')
    expect(store.getPreference()).toBe(preference)
    expect(apply).toHaveBeenLastCalledWith(preference)
    const calls = apply.mock.calls.length
    changeSystem(preference !== 'light')
    expect(apply).toHaveBeenCalledTimes(calls)
  })

  it('applies and persists changes immediately, including returning to system', () => {
    const { store, apply, write, changeSystem } = browser(null, true)
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    store.setPreference('light')
    expect(write).toHaveBeenLastCalledWith('light')
    expect(apply).toHaveBeenLastCalledWith('light')
    expect(listener).toHaveBeenCalledTimes(1)
    store.setPreference('system')
    expect(apply).toHaveBeenLastCalledWith('dark')
    changeSystem(false)
    expect(apply).toHaveBeenLastCalledWith('light')
    unsubscribe()
    store.setPreference('dark')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('syncs other tabs and storage clearing without writing the event back', () => {
    const { store, apply, write, changeStorage } = browser('dark', false)
    const listener = vi.fn()
    store.subscribe(listener)
    changeStorage('light')
    expect(store.getPreference()).toBe('light')
    expect(apply).toHaveBeenLastCalledWith('light')
    changeStorage(null)
    expect(store.getPreference()).toBe('system')
    expect(apply).toHaveBeenLastCalledWith('light')
    expect(listener).toHaveBeenCalledTimes(2)
    expect(write).not.toHaveBeenCalled()
  })

  it('falls back for an invalid saved choice and stays usable when storage is blocked', () => {
    const invalid = browser('unrecognised', true)
    expect(invalid.store.getPreference()).toBe('system')
    expect(invalid.apply).toHaveBeenLastCalledWith('dark')
    const { store, apply, changeSystem } = browser(null, true, true)
    store.setPreference('light')
    expect(store.getPreference()).toBe('light')
    expect(apply).toHaveBeenLastCalledWith('light')
    changeSystem(false)
    expect(store.getPreference()).toBe('light')
  })

  it('releases browser listeners when the application is replaced', () => {
    const { store, stopSystem, stopStorage } = browser()
    store.destroy()
    expect(stopSystem).toHaveBeenCalledOnce()
    expect(stopStorage).toHaveBeenCalledOnce()
  })
})
