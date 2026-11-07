import { describe, expect, it } from 'vitest'
import { SCREEN_POLL_INTERVAL_MS, isTerminalPhase, nextScreenPhase, screenPhaseAfterClose, screenPoint } from '../src/lib/screen'

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
    expect(isTerminalPhase('checking')).toBe(false)
    expect(isTerminalPhase('idle')).toBe(false)
  })

  it('resolves a worker close using its final login state', () => {
    expect(screenPhaseAfterClose('success')).toBe('success')
    expect(screenPhaseAfterClose('timeout')).toBe('timeout')
    expect(screenPhaseAfterClose('pending')).toBe('ended')
  })

  it('maps a resized display back to the original browser coordinates', () => {
    const rect = { left: 10, top: 20, width: 640, height: 360 }
    const frame = { width: 1280, height: 720 }
    expect(screenPoint(330, 200, rect, frame)).toEqual({ x: 640, y: 360 })
    expect(screenPoint(-10, -20, rect, frame)).toEqual({ x: 0, y: 0 })
    expect(screenPoint(1000, 1000, rect, frame)).toEqual({ x: 1279, y: 719 })
    expect(screenPoint(10, 20, { ...rect, width: 0 }, frame)).toBeUndefined()
  })
})
