import { describe, expect, it } from 'vitest'
import { helpPosition } from '../src/lib/help-position'

describe('contextual help placement', () => {
  it('keeps help within a narrow viewport when its trigger is at the right edge', () => {
    const result = helpPosition({ left: 360, right: 384, top: 100, bottom: 124 }, { width: 320, height: 130 }, { width: 390, height: 844 })
    expect(result.left).toBe(58)
    expect(result.left + 320).toBeLessThanOrEqual(390 - 12)
    expect(result.top).toBe(132)
  })
  it('moves above a trigger near the bottom instead of hiding content below the screen', () => {
    const result = helpPosition({ left: 20, right: 44, top: 700, bottom: 724 }, { width: 280, height: 160 }, { width: 390, height: 760 })
    expect(result).toEqual({ left: 12, top: 532, maxHeight: 736 })
  })
  it('limits tall help to the visible viewport and provides a scrollable area', () => {
    const result = helpPosition({ left: 10, right: 34, top: 80, bottom: 104 }, { width: 320, height: 900 }, { width: 320, height: 400 })
    expect(result).toEqual({ left: 12, top: 12, maxHeight: 376 })
  })
})
