import { describe, expect, it } from 'vitest'
import { comparisonValue } from '../src/lib/comparisons-api'
describe('Declared comparison values', () => {
  it('distinguishes missing values and unconfirmed units while preserving zero and declared units', () => {
    expect(comparisonValue(null, 'USD')).toBe('数值未知')
    expect(comparisonValue(0, 'unknown')).toBe('0（单位未确认）')
    expect(comparisonValue(7, 'USD')).toBe('7 USD')
    expect(comparisonValue(7, 'credits')).toBe('7 credits')
  })
})
