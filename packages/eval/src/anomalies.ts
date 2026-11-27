/**
 * Post-run outlier detection for trials whose resource use or latency is far
 * from the rest of the run. A single trial with a token/step explosion can
 * dominate a small-sample mean without showing up in the pass rate; this module
 * makes those trials visible without changing any collected evidence.
 *
 * @module dsh-eval/anomalies
 */

import type { EvalRun, EvalTrialResult } from './types.ts'

/** Resource metrics that can be checked for outliers. */
export type AnomalyMetric = 'latencyMs' | 'totalTokens' | 'steps' | 'retries'

/** One trial whose metric falls outside the run's Tukey fence. */
export interface TrialAnomaly {
  caseId: string
  trial: number
  metric: AnomalyMetric
  value: number
  /** Human-readable reason including the fence that was exceeded. */
  why: string
}

const METRICS: readonly AnomalyMetric[] = ['latencyMs', 'totalTokens', 'steps', 'retries']

/** Read one metric from a completed trial, or null when it was not recorded. */
function metricOf(result: EvalTrialResult, metric: AnomalyMetric): number | null {
  const metrics = result.metrics
  if (metrics === undefined) return null
  switch (metric) {
    case 'latencyMs': return metrics.latencyMs
    case 'totalTokens': return metrics.totalTokens
    case 'steps': return metrics.steps
    case 'retries': return metrics.retries
  }
}

/** Linear-interpolation quantile of an already sorted, non-empty array. */
function quantile(sorted: readonly number[], q: number): number {
  const position = (sorted.length - 1) * q
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]!
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
}

/**
 * Find trials whose resource use is far from the rest of the run via Tukey's
 * 1.5×IQR fence. Fewer than five samples, or a degenerate (zero) IQR, produce
 * no findings: with little spread there is no defensible notion of an outlier.
 * Output is sorted by case id, trial and metric so reports are deterministic.
 * @param run - a persisted run report.
 * @returns anomalies from every metric, possibly empty.
 */
export function computeAnomalies(run: EvalRun): TrialAnomaly[] {
  const completed = run.cases.filter(result =>
    result.status === 'completed' && result.metrics !== undefined)
  const anomalies: TrialAnomaly[] = []
  for (const metric of METRICS) {
    const values = completed
      .map(result => metricOf(result, metric))
      .filter((value): value is number => value !== null)
    if (values.length < 5) continue
    const sorted = [...values].sort((a, b) => a - b)
    const q1 = quantile(sorted, 0.25)
    const q3 = quantile(sorted, 0.75)
    const iqr = q3 - q1
    if (iqr <= 0) continue
    const lower = q1 - 1.5 * iqr
    const upper = q3 + 1.5 * iqr
    for (const result of completed) {
      const value = metricOf(result, metric)
      if (value === null || (value >= lower && value <= upper)) continue
      anomalies.push({
        caseId: result.caseId,
        trial: result.trial,
        metric,
        value,
        why: `${metric} ${value} outside [${lower.toFixed(0)}, ${upper.toFixed(0)}]`,
      })
    }
  }
  // Code-unit comparison, not localeCompare: the same run must render in the
  // same order on every machine and locale.
  const byText = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0
  return anomalies.sort((a, b) =>
    byText(a.caseId, b.caseId) || a.trial - b.trial || byText(a.metric, b.metric))
}
