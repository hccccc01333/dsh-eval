/**
 * Cross-run comparison for dsh-eval: two persisted run reports become a row
 * list of metric values and deltas, rendered as a markdown table.
 *
 * @module dsh-eval/compare
 */

import type { EvalRun, EvalTrialResult } from './types.ts'

/** One compared metric row. */
export interface CompareRow {
  /** Metric label. */
  metric: string
  /** Run A's rendered value. */
  a: string
  /** Run B's rendered value. */
  b: string
  /** Signed delta (`b - a`) for numeric rows, or a dash for text rows. */
  delta: string
}

/** Paired same-case statistics over two runs. */
export interface PairedStats {
  /** Number of case x trial pairs completed in both runs. */
  pairs: number
  /** Pairs where run B beat run A on the primary metric. */
  wins: number
  /** Pairs where run A beat run B on the primary metric. */
  losses: number
  /** Pairs with equal primary-metric outcomes. */
  ties: number
  /** The metric used for win/lose/tie classification. */
  primaryMetric: 'task success' | 'tool selection accuracy' | 'final answer score'
  /** Mean per-pair step delta (`b - a`), or null when no pair is numeric. */
  meanStepsDelta: number | null
  /** Mean per-pair token delta (`b - a`), or null when no pair is numeric. */
  meanTokensDelta: number | null
  /** Mean per-pair judge score delta (`b - a`), or null without judge verdicts. */
  meanScoreDelta: number | null
}

/** Render a nullable number with a dash placeholder. */
function formatNumber(value: number | null, digits = 1): string {
  return value === null ? '–' : value.toFixed(digits)
}

/** Render a nullable rate as percent with a dash placeholder. */
function formatRate(value: number | null): string {
  return value === null ? '–' : `${(value * 100).toFixed(1)}%`
}

/** Render a signed delta between two nullable numbers. */
function formatDelta(a: number | null, b: number | null, unit: 'pp' | '' = ''): string {
  if (a === null || b === null) return '–'
  const delta = unit === 'pp' ? (b - a) * 100 : b - a
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}${unit}`
}

/** A metric that can classify a paired winner. */
type PairedMetric = 'task success' | 'tool selection accuracy' | 'final answer score'

/** Read one trial's primary-metric outcome, or null when the trial lacks it. */
function metricOutcome(result: EvalTrialResult, metric: PairedMetric): boolean | number | null {
  if (metric === 'task success') return result.grade?.taskSuccess ?? null
  if (metric === 'tool selection accuracy') return result.grade?.toolSelectionAccuracy ?? null
  return result.judge?.finalAnswerScore ?? null
}

/** Pick the first metric with data in every paired trial of a run. */
function pickMetric(
  pairs: readonly { a: EvalTrialResult; b: EvalTrialResult }[],
): PairedMetric {
  for (const metric of ['task success', 'tool selection accuracy', 'final answer score'] as const) {
    if (pairs.every(pair => metricOutcome(pair.a, metric) !== null && metricOutcome(pair.b, metric) !== null)) {
      return metric
    }
  }
  return 'final answer score'
}

/** Classify one pair: 1 for a B win, -1 for an A win, 0 for a tie. */
function pairSign(aValue: boolean | number | null, bValue: boolean | number | null): number {
  if (aValue === null || bValue === null) return 0
  if (typeof aValue === 'boolean' || typeof bValue === 'boolean') {
    const aBool = aValue === true
    const bBool = bValue === true
    return bBool === aBool ? 0 : (bBool ? 1 : -1)
  }
  return bValue > aValue ? 1 : (bValue < aValue ? -1 : 0)
}

/**
 * Pair both runs' trials by case id and trial index and compute win/lose/tie
 * plus mean deltas. Trials are paired as-is; the runs' `seed` is recorded
 * provenance for the pairing, not a guarantee of identical model output.
 * @param a - the baseline run.
 * @param b - the candidate run.
 * @returns paired statistics, or null when no trial is completed in both runs.
 */
export function pairedCompare(a: EvalRun, b: EvalRun): PairedStats | null {
  const byKey = new Map<string, EvalTrialResult>()
  for (const result of b.cases) {
    if (result.status === 'completed') byKey.set(`${result.caseId}\u0000${result.trial}`, result)
  }
  const pairs: { a: EvalTrialResult; b: EvalTrialResult }[] = []
  for (const result of a.cases) {
    if (result.status !== 'completed') continue
    const match = byKey.get(`${result.caseId}\u0000${result.trial}`)
    if (match !== undefined) pairs.push({ a: result, b: match })
  }
  if (pairs.length === 0) return null
  const primaryMetric = pickMetric(pairs)
  let wins = 0
  let losses = 0
  let ties = 0
  const stepDeltas: number[] = []
  const tokenDeltas: number[] = []
  const scoreDeltas: number[] = []
  for (const pair of pairs) {
    const sign = pairSign(metricOutcome(pair.a, primaryMetric), metricOutcome(pair.b, primaryMetric))
    if (sign > 0) wins += 1
    else if (sign < 0) losses += 1
    else ties += 1
    const aMetrics = pair.a.metrics
    const bMetrics = pair.b.metrics
    if (aMetrics !== undefined && bMetrics !== undefined) {
      stepDeltas.push(bMetrics.steps - aMetrics.steps)
      tokenDeltas.push(bMetrics.totalTokens - aMetrics.totalTokens)
    }
    const aScore = pair.a.judge?.finalAnswerScore
    const bScore = pair.b.judge?.finalAnswerScore
    if (aScore !== null && aScore !== undefined && bScore !== null && bScore !== undefined) {
      scoreDeltas.push(bScore - aScore)
    }
  }
  const mean = (values: readonly number[]): number | null =>
    values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length
  return {
    pairs: pairs.length,
    wins,
    losses,
    ties,
    primaryMetric,
    meanStepsDelta: mean(stepDeltas),
    meanTokensDelta: mean(tokenDeltas),
    meanScoreDelta: mean(scoreDeltas),
  }
}

/** Pull one nullable numeric value from a run for comparison. */
type RunSelector = (run: EvalRun) => number | null

/**
 * Build the comparison rows between two runs.
 * @param a - the baseline run.
 * @param b - the candidate run.
 * @returns the row list in display order.
 */
export function compareRuns(a: EvalRun, b: EvalRun): CompareRow[] {
  const completed = (run: EvalRun): number => run.cases.filter(result => result.status === 'completed').length
  const rates = (selector: RunSelector, label: string, unit: 'pp' | ''): CompareRow => {
    const aValue = selector(a)
    const bValue = selector(b)
    return {
      metric: label,
      a: unit === 'pp' ? formatRate(aValue) : formatNumber(aValue),
      b: unit === 'pp' ? formatRate(bValue) : formatNumber(bValue),
      delta: unit === 'pp' ? formatDelta(aValue, bValue, 'pp') : formatDelta(aValue, bValue),
    }
  }
  const numeric = (selector: RunSelector, label: string): CompareRow => rates(selector, label, '')
  const rows: CompareRow[] = [
    { metric: 'benchmark', a: a.benchmark, b: b.benchmark, delta: '–' },
    { metric: 'model', a: a.model, b: b.model, delta: '–' },
    numeric(run => completed(run), 'completed trials'),
    numeric(run => run.aggregate?.steps ?? null, 'steps/trial'),
    rates(run => run.aggregate?.toolSuccessRate ?? null, 'tool success', 'pp'),
    rates(run => run.grading?.taskSuccessRate ?? null, 'task success', 'pp'),
    rates(run => run.grading?.toolSelectionAccuracyRate ?? null, 'tool selection accuracy', 'pp'),
    numeric(run => run.aggregate?.invalidToolCalls ?? null, 'invalid tool calls/trial'),
    numeric(run => run.aggregate?.retries ?? null, 'retries/trial'),
    numeric(run => run.aggregate?.totalTokens ?? null, 'tokens/trial'),
    numeric(run => run.aggregate?.costUsd ?? null, 'cost/trial (USD)'),
    numeric(run => run.aggregate?.latencyMs ?? null, 'latency/trial (ms)'),
  ]
  const paired = pairedCompare(a, b)
  if (paired !== null) {
    rows.push(
      { metric: 'paired trials', a: String(paired.pairs), b: String(paired.pairs), delta: '–' },
      {
        metric: `paired ${paired.primaryMetric} (B/A/ties)`,
        a: `${paired.wins}/${paired.losses}/${paired.ties}`,
        b: '–',
        delta: '–',
      },
      ...(paired.meanStepsDelta === null ? [] : [{
        metric: 'paired steps delta (B-A)', a: '–', b: '–', delta: formatDelta(0, paired.meanStepsDelta),
      }]),
      ...(paired.meanTokensDelta === null ? [] : [{
        metric: 'paired tokens delta (B-A)', a: '–', b: '–', delta: formatDelta(0, paired.meanTokensDelta),
      }]),
      ...(paired.meanScoreDelta === null ? [] : [{
        metric: 'paired final-answer delta (B-A)', a: '–', b: '–', delta: formatDelta(0, paired.meanScoreDelta),
      }]),
    )
  }
  return rows
}

/**
 * Render comparison rows as a markdown table.
 * @param rows - the rows from {@link compareRuns}.
 * @returns the markdown text.
 */
export function renderCompareMarkdown(rows: readonly CompareRow[]): string {
  return [
    '# Compare',
    '',
    '| metric | run A | run B | delta (B - A) |',
    '|---|---|---|---|',
    ...rows.map(row => `| ${row.metric} | ${row.a} | ${row.b} | ${row.delta} |`),
    '',
  ].join('\n')
}
