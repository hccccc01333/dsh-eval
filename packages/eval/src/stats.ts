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

/** Power ceiling of an exact sign test with a finite number of discordant pairs. */
export interface SignTestPower {
  /** Discordant pairs the test actually has. */
  discordant: number
  /** Number of quantities in the printed inference family. */
  comparisons: number
  /** Family-wise error rate the family controls. */
  alpha: number
  /** Smallest raw p-value any outcome with this sample could produce. */
  bestRawP: number
  /** Smallest Bonferroni-adjusted p-value any outcome could produce. */
  bestAdjustedP: number
  /** Wins in the favoured direction needed for significance, or null when impossible. */
  minimumWins: number | null
  /** Smallest discordant sample that could reach the corrected alpha. */
  minimumDiscordant: number
  /** Whether the current sample can reach the corrected alpha at all. */
  detectable: boolean
}

/**
 * Coerce a paired-comparison tally to a non-negative integer. Wins and losses
 * come from counting cases, so negatives, fractions, NaN and infinities are
 * invalid; treating them as zero keeps the binomial sum well-defined instead
 * of feeding a negative or fractional index into the pmf.
 */
function countOf(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * Lower binomial tails `sum_{i=0}^{k} C(n,i) / 2^n` for every `k` in `0..limit`,
 * built in one O(limit) pass.
 *
 * The log coefficient accumulates the same `ln(n-i) - ln(i+1)` term, in the same
 * order, that the old per-index `logChoose` recomputation used, and the running
 * sums add the same pmf values in the same order. Every entry is therefore
 * bit-for-bit identical to the previous implementation, without the old O(n²)
 * (signTest) and O(n³) (signTestPower) recomputation.
 */
function lowerTailSums(n: number, limit: number): number[] {
  const halfPow = n * Math.log(2)
  const sums: number[] = []
  let logCoeff = 0
  let cumulative = 0
  for (let index = 0; index <= limit; index++) {
    if (index > 0) logCoeff += Math.log(n - (index - 1)) - Math.log(index)
    cumulative += Math.exp(logCoeff - halfPow)
    sums.push(cumulative)
  }
  return sums
}

/**
 * Report how much a finite paired sample can ever say under an exact sign test.
 *
 * With `n` discordant pairs the strongest evidence is a clean sweep, whose
 * two-sided p-value is `2^(1-n)`; the printed Bonferroni family multiplies it.
 * Below that floor no observed outcome can reach alpha, so a non-significant
 * result is uninformative rather than evidence of no difference.
 * @param discordant - number of win/loss pairs; ties drop out.
 * @param comparisons - size of the inference family, at least one.
 * @param alpha - family-wise error rate, default `0.05`.
 * @returns the achievable p-value floor, required wins and minimum sample size.
 */
export function signTestPower(
  discordant: number,
  comparisons: number,
  alpha = 0.05,
): SignTestPower {
  const floor = (n: number): number => n === 0 ? 1 : Math.min(1, 2 ** (1 - n))
  const bestRawP = floor(discordant)
  const bestAdjustedP = Math.min(1, bestRawP * comparisons)
  // Compute every candidate tail in one pass instead of re-deriving each
  // cumulative pmf from scratch; 2 ** (1 - n) underflows to 0 for large n, and
  // Math.min already caps the floor at 1, so no extra overflow handling is
  // needed here.
  const limit = Math.floor(discordant / 2)
  const tails = lowerTailSums(discordant, limit)
  // Walk from the largest significant tail down, so the reported win count is
  // the minimum that still reaches alpha rather than a clean sweep.
  let minimumWins: number | null = null
  for (let tail = limit; tail >= 0; tail--) {
    const adjusted = Math.min(1, Math.min(1, 2 * tails[tail]!) * comparisons)
    if (adjusted <= alpha) {
      minimumWins = discordant - tail
      break
    }
  }
  let minimumDiscordant = 0
  while (Math.min(1, floor(minimumDiscordant) * comparisons) > alpha) minimumDiscordant += 1
  return {
    discordant,
    comparisons,
    alpha,
    bestRawP,
    bestAdjustedP,
    minimumWins,
    minimumDiscordant,
    detectable: bestAdjustedP <= alpha,
  }
}

/** Bonferroni family-wise correction shared by a p-value and its sibling intervals. */
export interface FamilyWiseCorrection {
  /** Number of inference quantities in the family (the p-value plus intervals). */
  comparisons: number
  /** Family-wise error rate the family controls. */
  alpha: number
  /** Adjusted p-value: raw p times the family size, capped at 1. */
  adjustedPValue: number
  /** Per-interval confidence that keeps family-wise coverage at `1 - alpha`. */
  intervalConfidence: number
}

/**
 * Apply a Bonferroni correction across a family of inference quantities.
 *
 * A comparison report prints a sign-test p-value alongside several paired
 * intervals. Testing each at 5% inflates the chance that at least one is a
 * false discovery; dividing the error rate by the family size keeps that
 * chance at `alpha` without any distributional assumption.
 * @param pValue - raw p-value of the family's primary test.
 * @param comparisons - number of quantities in the family; at least one.
 * @param alpha - family-wise error rate, default `0.05`.
 * @returns the adjusted p-value and the confidence each interval must use.
 */
export function bonferroni(
  pValue: number,
  comparisons: number,
  alpha = 0.05,
): FamilyWiseCorrection {
  if (!Number.isInteger(comparisons) || comparisons < 1) {
    throw new Error('bonferroni: comparisons must be a positive integer')
  }
  return {
    comparisons,
    alpha,
    adjustedPValue: Math.min(1, pValue * comparisons),
    intervalConfidence: 1 - alpha / comparisons,
  }
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
 * Exact two-sided sign test. Under the null hypothesis a discordant pair is a
 * win or a loss with equal probability, so the win count is Binomial(n, 1/2)
 * and the p-value doubles the smaller tail. Invalid tallies (negative,
 * fractional, non-finite) are treated as zero so the binomial indices stay
 * well-defined.
 * @param wins - pairs where B beat A.
 * @param losses - pairs where A beat B.
 * @returns the discordant count and the exact p-value in `[0, 1]`.
 */
export function signTest(wins: number, losses: number): SignTestOutcome {
  const positiveWins = countOf(wins)
  const positiveLosses = countOf(losses)
  const discordant = positiveWins + positiveLosses
  if (discordant === 0) return { discordant, pValue: 1 }
  const tail = Math.min(positiveWins, positiveLosses)
  const cumulative = lowerTailSums(discordant, tail)[tail]!
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
