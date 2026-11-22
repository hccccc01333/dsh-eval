/**
 * Single-run precision for dsh-eval: percentile-bootstrap intervals for graded
 * rates and latency percentiles, derived from the stored trials at render time.
 *
 * A pooled rate alone hides how little evidence a small run carries. Reusing
 * the paired bootstrap machinery on the zero/one trial outcomes gives a
 * distribution-free interval with no extra assumption, and seeding it with the
 * run's `seed` keeps a re-rendered report byte-identical.
 *
 * @module dsh-eval/precision
 */

import { pairedDelta, type BootstrapOptions } from './stats.ts'
import type { EvalRun, EvalTrialResult } from './types.ts'

/** A rate with a seeded percentile-bootstrap interval. */
export interface RateInterval {
  /** Number of graded trials contributing. */
  trials: number
  /** Observed rate over those trials. */
  rate: number
  /** Lower interval bound, or null with a single trial. */
  lower: number | null
  /** Upper interval bound, or null with a single trial. */
  upper: number | null
}

/** Precision figures for one run. */
export interface RunPrecision {
  /** Task-success interval, or null when no trial carried the check. */
  task: RateInterval | null
  /** Tool-selection interval, or null when no trial carried the expectation. */
  toolSelection: RateInterval | null
  /** Strict pass@1 interval over every trial, keeping errors in the denominator. */
  strictPassAt1: RateInterval | null
  /** Median trial latency in milliseconds, or null without metrics. */
  latencyP50: number | null
  /** 95th-percentile trial latency in milliseconds, or null without metrics. */
  latencyP95: number | null
}

/** Interpolated percentile of a sample, sorting a copy so the input stays intact. */
function percentile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * q
  const low = Math.floor(position)
  const weight = position - low
  return sorted[low]! * (1 - weight) + sorted[Math.ceil(position)]! * weight
}

/** Bootstrap a rate interval from the trials that actually carry a grade. */
function rateInterval(
  results: readonly EvalTrialResult[],
  pick: (result: EvalTrialResult) => boolean | null | undefined,
  options: BootstrapOptions,
): RateInterval | null {
  const observed = results.map(pick).filter((value): value is boolean => typeof value === 'boolean')
  if (observed.length === 0) return null
  const bootstrap = pairedDelta(observed.map(value => value ? 1 : 0), options)!
  return { trials: observed.length, rate: bootstrap.mean, lower: bootstrap.lower, upper: bootstrap.upper }
}

/**
 * Derive single-run precision from a persisted run.
 * @param run - the run to summarize.
 * @param options - bootstrap overrides; the run's seed is used by default.
 * @returns the precision figures, all null when no trial carries data.
 */
export function computePrecision(run: EvalRun, options: BootstrapOptions = {}): RunPrecision {
  const completed = run.cases.filter(result => result.status === 'completed')
  const bootstrap = { ...options, seed: options.seed ?? run.seed }
  const latencies = completed
    .map(result => result.metrics?.latencyMs)
    .filter((value): value is number => typeof value === 'number')
  return {
    task: rateInterval(completed, result => result.grade?.taskSuccess, bootstrap),
    toolSelection: rateInterval(completed, result => result.grade?.toolSelectionAccuracy, bootstrap),
    strictPassAt1: completed.some(result => typeof result.grade?.taskSuccess === 'boolean')
      ? rateInterval(run.cases, result =>
        result.status === 'completed' && result.grade?.taskSuccess === true, bootstrap)
      : null,
    latencyP50: latencies.length === 0 ? null : percentile(latencies, 0.5),
    latencyP95: latencies.length === 0 ? null : percentile(latencies, 0.95),
  }
}
