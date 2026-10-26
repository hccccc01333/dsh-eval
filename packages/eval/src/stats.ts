/**
 * Paired-comparison statistics for cross-run reports: an exact two-sided sign
 * test over paired outcomes, and a seeded bootstrap confidence interval for a
 * paired mean delta.
 *
 * Both are distribution-free on purpose. A benchmark run yields few paired
 * trials (single digits to low tens), the per-trial deltas are integers with
 * long tails, and the question is "on the same case, did B beat A" — which a
 * paired sign test answers exactly, without a normality or symmetry assumption
 * the data cannot support. Ties carry no sign and drop out of the test, as the
 * sign test requires.
 *
 * The bootstrap resamples the observed deltas with replacement, so its interval
 * needs no shape assumption either, and it is seeded so that re-running
 * `compare` on the same reports prints a byte-identical table.
 *
 * @module dsh-eval/stats
 */

/** Outcome of an exact two-sided sign test. */
export interface SignTestOutcome {
  /** Discordant pairs (`wins + losses`); ties drop out of the test. */
  discordant: number
  /** Exact two-sided p-value; 1 when every pair tied. */
  pValue: number
}

/** A paired mean delta with its bootstrap interval. */
export interface PairedDelta {
  /** Mean per-pair delta (`b - a`). */
  mean: number
  /** Lower interval bound, or null when fewer than two pairs are available. */
  lower: number | null
  /** Upper interval bound, or null when fewer than two pairs are available. */
  upper: number | null
  /** Pairs contributing to the mean. */
  pairs: number
}

/** Knobs for {@link pairedDelta}; defaults keep reports reproducible. */
export interface BootstrapOptions {
  /** Interval confidence, default `0.95`. */
  confidence?: number
  /** Resample count, default `2000`. */
  resamples?: number
  /** PRNG seed, default `0`. */
  seed?: number
}

/**
 * Log of the binomial coefficient, accumulated rather than factorized so large
 * pair counts stay finite.
 * @param n - trials.
 * @param k - successes, at most n.
 * @returns `ln C(n, k)`.
 */
function logChoose(n: number, k: number): number {
  let value = 0
  for (let index = 0; index < k; index++) {
    value += Math.log(n - index) - Math.log(index + 1)
  }
  return value
}

/**
 * Exact two-sided sign test. Under the null hypothesis a discordant pair is a
 * win or a loss with equal probability, so the win count is Binomial(n, 1/2)
 * and the p-value doubles the smaller tail.
 * @param wins - pairs where B beat A.
 * @param losses - pairs where A beat B.
 * @returns the discordant count and the exact p-value in `[0, 1]`.
 */
export function signTest(wins: number, losses: number): SignTestOutcome {
  const discordant = wins + losses
  if (discordant === 0) return { discordant, pValue: 1 }
  const tail = Math.min(wins, losses)
  const halfPow = discordant * Math.log(2)
  let cumulative = 0
  for (let index = 0; index <= tail; index++) {
    cumulative += Math.exp(logChoose(discordant, index) - halfPow)
  }
  return { discordant, pValue: Math.min(1, 2 * cumulative) }
}

/**
 * Small deterministic PRNG (mulberry32): identical seeds must produce identical
 * intervals, otherwise `compare` output would drift between runs.
 * @param seed - any integer.
 * @returns a generator of floats in `[0, 1)`.
 */
function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Percentile of a sorted sample, linearly interpolated between neighbours.
 * @param sorted - ascending values, non-empty.
 * @param q - quantile in `[0, 1]`.
 * @returns the interpolated value.
 */
function quantile(sorted: readonly number[], q: number): number {
  const position = (sorted.length - 1) * q
  const low = Math.floor(position)
  const weight = position - low
  return sorted[low]! * (1 - weight) + sorted[Math.ceil(position)]! * weight
}

/**
 * Mean paired delta with a percentile bootstrap interval.
 * @param deltas - per-pair differences (`b - a`).
 * @param options - confidence, resample count, and PRNG seed.
 * @returns the mean and interval, or null when `deltas` is empty.
 */
export function pairedDelta(
  deltas: readonly number[],
  options: BootstrapOptions = {},
): PairedDelta | null {
  if (deltas.length === 0) return null
  const mean = deltas.reduce((total, value) => total + value, 0) / deltas.length
  if (deltas.length === 1) return { mean, lower: null, upper: null, pairs: 1 }
  const confidence = options.confidence ?? 0.95
  const resamples = options.resamples ?? 2000
  const random = prng(options.seed ?? 0)
  const means: number[] = []
  for (let resample = 0; resample < resamples; resample++) {
    let total = 0
    for (let draw = 0; draw < deltas.length; draw++) {
      total += deltas[Math.floor(random() * deltas.length)]!
    }
    means.push(total / deltas.length)
  }
  means.sort((a, b) => a - b)
  const alpha = (1 - confidence) / 2
  return {
    mean,
    lower: quantile(means, alpha),
    upper: quantile(means, 1 - alpha),
    pairs: deltas.length,
  }
}
