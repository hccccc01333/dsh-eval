import { describe, expect, it } from 'vitest'
import { pairedDelta, signTest } from '../src/stats.ts'

describe('dsh-eval paired statistics', () => {
  it('reports no evidence when every pair tied', () => {
    expect(signTest(0, 0)).toEqual({ discordant: 0, pValue: 1 })
  })

  it('matches the exact binomial tail for a clean sweep', () => {
    // Five discordant pairs, all wins: p = 2 * C(5,0) / 2^5 = 0.0625.
    expect(signTest(5, 0).pValue).toBeCloseTo(0.0625, 12)
    expect(signTest(0, 5).pValue).toBeCloseTo(0.0625, 12)
    expect(signTest(10, 0).pValue).toBeCloseTo(2 / 1024, 12)
  })

  it('doubles the smaller tail and clamps at one', () => {
    // 4 wins / 1 loss: tails are 1/32 + 5/32 = 6/32 per side, 12/32 two-sided.
    expect(signTest(4, 1).pValue).toBeCloseTo(12 / 32, 12)
    // A near-even split cannot exceed 1.
    expect(signTest(3, 3).pValue).toBe(1)
  })

  it('stays finite for a large discordant count', () => {
    const outcome = signTest(400, 420)
    expect(outcome.discordant).toBe(820)
    expect(outcome.pValue).toBeGreaterThan(0.4)
    expect(outcome.pValue).toBeLessThan(0.6)
  })

  it('returns null for an empty delta sample', () => {
    expect(pairedDelta([])).toBeNull()
  })

  it('reports the mean without an interval for a single pair', () => {
    expect(pairedDelta([3])).toEqual({ mean: 3, lower: null, upper: null, pairs: 1 })
  })

  it('brackets the mean with a reproducible bootstrap interval', () => {
    const deltas = [-2, -1, 0, 1, 2, 3]
    const first = pairedDelta(deltas, { resamples: 500, seed: 7 })
    const second = pairedDelta(deltas, { resamples: 500, seed: 7 })
    expect(first).toEqual(second)
    expect(first?.pairs).toBe(6)
    expect(first?.mean).toBeCloseTo(0.5, 12)
    expect(first!.lower!).toBeLessThan(first!.mean)
    expect(first!.upper!).toBeGreaterThan(first!.mean)
    // The interval is a percentile band, so it must stay inside the observed range.
    expect(first!.lower!).toBeGreaterThanOrEqual(-2)
    expect(first!.upper!).toBeLessThanOrEqual(3)
  })

  it('honours the confidence and resample options', () => {
    const deltas = [1, 1, 1, 1]
    const narrow = pairedDelta(deltas, { confidence: 0 })
    expect(narrow?.lower).toBe(1)
    expect(narrow?.upper).toBe(1)
    const wide = pairedDelta([-5, 0, 5, 10], { confidence: 0.99, resamples: 200, seed: 1 })
    expect(wide!.upper! - wide!.lower!).toBeGreaterThan(0)
  })
})
