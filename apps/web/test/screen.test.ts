import { describe, expect, it } from 'vitest'
import { SCREEN_POLL_INTERVAL_MS, isTerminalPhase, nextScreenPhase } from '../src/lib/screen'

describe('nextScreenPhase', () => {
  it('polls every 2 seconds', () => {
    expect(SCREEN_POLL_INTERVAL_MS).toBe(2000)
  })

  it('moves live → success / timeout', () => {
    expect(nextScreenPhase('live', 'success')).toBe('success')
    expect(nextScreenPhase('live', 'timeout')).toBe('timeout')
  })

  it('stays live on pending / idle', () => {
    expect(nextScreenPhase('live', 'pending')).toBe('live')
    expect(nextScreenPhase('live', 'idle')).toBe('live')
  })

  it('ignores late polls once the screen has ended', () => {
    expect(nextScreenPhase('ended', 'success')).toBe('ended')
    expect(nextScreenPhase('success', 'timeout')).toBe('success')
    expect(nextScreenPhase('idle', 'success')).toBe('idle')
  })

  it('closes the socket on terminal phases only', () => {
    expect(isTerminalPhase('success')).toBe(true)
    expect(isTerminalPhase('timeout')).toBe(true)
    expect(isTerminalPhase('ended')).toBe(true)
    expect(isTerminalPhase('error')).toBe(true)
    expect(isTerminalPhase('live')).toBe(false)
    expect(isTerminalPhase('connecting')).toBe(false)
    expect(isTerminalPhase('idle')).toBe(false)
  })
})
