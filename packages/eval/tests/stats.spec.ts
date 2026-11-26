import { describe, expect, it } from 'vitest'
import { bonferroni, pairedDelta, signTest, signTestPower } from '../src/stats.ts'

/** Literal copy of the pre-optimisation algorithm, kept only as a test oracle. */
function oldLogChoose(n: number, k: number): number {
  let value = 0
  for (let index = 0; index < k; index++) {
    value += Math.log(n - index) - Math.log(index + 1)
  }
  return value
}

function oldSignTest(wins: number, losses: number): { discordant: number; pValue: number } {
  const discordant = wins + losses
  if (discordant === 0) return { discordant, pValue: 1 }
  const tail = Math.min(wins, losses)
  const halfPow = discordant * Math.log(2)
  let cumulative = 0
  for (let index = 0; index <= tail; index++) {
    cumulative += Math.exp(oldLogChoose(discordant, index) - halfPow)
  }
  return { discordant, pValue: Math.min(1, 2 * cumulative) }
}

function oldSignTestPower(n: number, comparisons: number, alpha = 0.05) {
  const floor = (value: number): number => value === 0 ? 1 : Math.min(1, 2 ** (1 - value))
  const bestRawP = floor(n)
  const bestAdjustedP = Math.min(1, bestRawP * comparisons)
  let minimumWins: number | null = null
  for (let tail = Math.floor(n / 2); tail >= 0; tail--) {
    const adjusted = Math.min(1, oldSignTest(tail, n - tail).pValue * comparisons)
    if (adjusted <= alpha) {
      minimumWins = n - tail
      break
    }
  }
  let minimumDiscordant = 0
  while (Math.min(1, floor(minimumDiscordant) * comparisons) > alpha) minimumDiscordant += 1
  return {
    discordant: n,
    comparisons,
    alpha,
    bestRawP,
    bestAdjustedP,
    minimumWins,
    minimumDiscordant,
    detectable: bestAdjustedP <= alpha,
  }
}

/** Independent oracle: precomputed log factorials instead of ratio accumulation. */
function logFactorialPValue(n: number, tail: number): number {
  const logFact: number[] = [0]
  for (let k = 1; k <= n; k++) logFact[k] = logFact[k - 1]! + Math.log(k)
  let cumulative = 0
  const halfPow = n * Math.log(2)
  for (let k = 0; k <= tail; k++) {
    cumulative += Math.exp(logFact[n]! - logFact[k]! - logFact[n - k]! - halfPow)
  }
  return Math.min(1, 2 * cumulative)
}

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
    const larger = signTestPower(20, 1)
    expect(larger.minimumWins).toBe(15)
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

  it('preserves signTestPower semantics against the original algorithm', () => {
    expect(signTestPower(5, 4)).toEqual(oldSignTestPower(5, 4))
    expect(signTestPower(8, 4)).toEqual(oldSignTestPower(8, 4))
    expect(signTestPower(20, 1)).toEqual(oldSignTestPower(20, 1))
    expect(signTestPower(0, 1)).toEqual(oldSignTestPower(0, 1))
    expect(signTestPower(1, 2, 0.01)).toEqual(oldSignTestPower(1, 2, 0.01))
    expect(signTestPower(7, 3, 0.2)).toEqual(oldSignTestPower(7, 3, 0.2))
  })

  it('matches the original exact p-value bit-for-bit at n=2000 in under 500ms', () => {
    const started = performance.now()
    const fast = signTest(1100, 900)
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(500)
    expect(fast).toEqual(oldSignTest(1100, 900))
    expect(fast.pValue).toBeCloseTo(logFactorialPValue(2000, 900), 8)
  })

  it('scales signTest to n=5000 in under 500ms', () => {
    const started = performance.now()
    const fast = signTest(2600, 2400)
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(500)
    expect(fast.discordant).toBe(5000)
    expect(fast.pValue).toBeCloseTo(logFactorialPValue(5000, 2400), 8)
  })

  it('keeps signTestPower exact and fast at n=2000', () => {
    const started = performance.now()
    const fast = signTestPower(2000, 4)
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(500)
    expect(fast.discordant).toBe(2000)
    expect(fast.bestRawP).toBe(0) // 2 ** (1 - 2000) underflows, as in the old code.
    expect(fast.detectable).toBe(true)

    const logFact: number[] = [0]
    for (let k = 1; k <= 2000; k++) logFact[k] = logFact[k - 1]! + Math.log(k)
    const pValues: number[] = []
    let cumulative = 0
    const halfPow = 2000 * Math.log(2)
    for (let k = 0; k <= 1000; k++) {
      cumulative += Math.exp(logFact[2000]! - logFact[k]! - logFact[2000 - k]! - halfPow)
      pValues.push(Math.min(1, 2 * cumulative))
    }
    let expectedWins: number | null = null
    for (let tail = 1000; tail >= 0; tail--) {
      if (Math.min(1, pValues[tail]! * 4) <= 0.05) {
        expectedWins = 2000 - tail
        break
      }
    }
    expect(fast.minimumWins).toBe(expectedWins)
    expect(fast.minimumWins).toBeGreaterThan(1000)
  })

  it('handles the n=0 and n=1 boundaries', () => {
    expect(signTest(0, 0)).toEqual({ discordant: 0, pValue: 1 })
    expect(signTest(1, 0)).toEqual({ discordant: 1, pValue: 1 })
    expect(signTest(0, 1)).toEqual({ discordant: 1, pValue: 1 })
    expect(signTestPower(1, 1)).toEqual({
      discordant: 1,
      comparisons: 1,
      alpha: 0.05,
      bestRawP: 1,
      bestAdjustedP: 1,
      minimumWins: null,
      minimumDiscordant: 6,
      detectable: false,
    })
    expect(signTestPower(0, 4).minimumDiscordant).toBe(8)
  })

  it('treats invalid win/loss tallies as zero instead of producing NaN', () => {
    expect(signTest(-2, 2)).toEqual({ discordant: 2, pValue: 0.5 })
    expect(signTest(1.5, 0.5)).toEqual({ discordant: 1, pValue: 1 })
    expect(signTest(Number.NaN, 3).discordant).toBe(3)
    expect(signTest(Number.NaN, 3).pValue).toBeCloseTo(0.25, 12)
    expect(signTest(Number.POSITIVE_INFINITY, 1)).toEqual({ discordant: 1, pValue: 1 })
    expect(signTest(Number.NEGATIVE_INFINITY, 1)).toEqual({ discordant: 1, pValue: 1 })
  })
})
