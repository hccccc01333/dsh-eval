/**
 * Cross-run comparison for dsh-eval: two persisted run reports become a row
 * list of metric values and deltas, rendered as a markdown table.
 *
 * @module @deepseek-ai/dsh-eval/compare
 */

import type { EvalRun } from './types.ts'

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
  return [
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
