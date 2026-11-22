import { describe, expect, it } from 'vitest'
import { bonferroni, pairedDelta, signTest, signTestPower } from '../src/stats.ts'

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

  it('reports the attainable p-value floor and the sample size needed for power', () => {
    const small = signTestPower(5, 4)
    expect(small.bestRawP).toBeCloseTo(0.0625, 12)
    expect(small.bestAdjustedP).toBeCloseTo(0.25, 12)
    expect(small.detectable).toBe(false)
    expect(small.minimumWins).toBeNull()
    expect(small.minimumDiscordant).toBe(8)

    const enough = signTestPower(8, 4)
    expect(enough.bestAdjustedP).toBeCloseTo(4 / 128, 12)
    expect(enough.detectable).toBe(true)
    expect(enough.minimumWins).toBe(8)

    const noPairs = signTestPower(0, 1)
    expect(noPairs.bestRawP).toBe(1)
    expect(noPairs.minimumDiscordant).toBe(6)
    expect(noPairs.minimumWins).toBeNull()
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

  it('scales the p-value and widens intervals for the whole family', () => {
    expect(bonferroni(0.03, 4)).toEqual({
      comparisons: 4,
      alpha: 0.05,
      adjustedPValue: 0.12,
      intervalConfidence: 0.9875,
    })
    expect(bonferroni(0.9, 3).adjustedPValue).toBeCloseTo(1, 12)
    expect(bonferroni(0.5, 1, 0.1)).toEqual({
      comparisons: 1, alpha: 0.1, adjustedPValue: 0.5, intervalConfidence: 0.9,
    })
  })

  it('rejects a family with no comparisons', () => {
    expect(() => bonferroni(0.5, 0)).toThrow('comparisons must be a positive integer')
    expect(() => bonferroni(0.5, 1.5)).toThrow('comparisons must be a positive integer')
  })
})
