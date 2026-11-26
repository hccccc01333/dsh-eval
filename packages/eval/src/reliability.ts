/**
 * Reliability metrics over repeated trials of the same case.
 *
 * A pooled success rate hides the shape of failure: three trials of one case
 * can all fail while three other cases pass every time, and both report the
 * same 66.7%. `pass@k`, `pass^k`, and the flaky-case list make that shape
 * visible. The metrics are derived at render time from the persisted trials,
 * so reports written before this module existed gain them on next render.
 *
 * @module dsh-eval/reliability
 */

import type { EvalRun, EvalTrialResult } from './types.ts'

/** The grading dimension a reliability summary describes. */
export type ReliabilityDimension = 'task' | 'tool-selection'

/** Trial accounting for one run, including trials that produced no grade. */
export interface RunCoverage {
  /** Every trial in the run, completed or not. */
  total: number
  /** Trials with a harvested trace. */
  completed: number
  /** Trials that failed before producing a usable trace. */
  errors: number
  /** Trials killed by the timeout. */
  timeouts: number
  /** Trials that never produced a grade (`total - completed`). */
  unscored: number
}

/** Reliability of one case across its graded trials. */
export interface CaseReliability {
  /** Benchmark case id. */
  caseId: string
  /** Number of graded trials observed for the case. */
  trials: number
  /** Every trial for the case, including errors and timeouts. */
  total: number
  /** Number of those trials that passed. */
  passes: number
  /** `passes / trials`. */
  rate: number
}

/** Reliability of one grading dimension across the whole run. */
export interface ReliabilitySummary {
  /** Which grade field was summarized. */
  dimension: ReliabilityDimension
  /** Trials per case configured for the run. */
  k: number
  /** Cases with at least one graded trial. */
  cases: number
  /** Every trial in the run, completed or not. */
  total: number
  /** Fraction of all graded trials that passed. */
  passAt1: number
  /** Passes over every trial, including errors and timeouts: the unbiased rate. */
  strictPassAt1: number
  /** Trials that never produced a grade for this dimension. */
  unscored: number
  /** Fraction of cases with at least one passing trial. */
  passAtK: number
  /** Fraction of cases where every graded trial passed. */
  passAllK: number
  /** Cases whose trials disagreed, in case order. */
  flaky: readonly CaseReliability[]
  /** Up to three weakest cases, by pass rate then case id. */
  hardest: readonly CaseReliability[]
}

/** Read the chosen grade, ignoring trials that were not graded on it. */
function readGrade(result: EvalTrialResult, dimension: ReliabilityDimension): boolean | null {
  const grade = result.grade
  if (grade === undefined) return null
  return dimension === 'task' ? grade.taskSuccess : grade.toolSelectionAccuracy
}

/**
 * Count every trial in a run, including those that never produced a grade.
 * A rate computed only over completed trials is biased whenever some trials
 * error or time out, so the denominator must be visible alongside it.
 * @param run - the run to account for.
 * @returns counts whose `unscored` field is the trials missing from all rates.
 */
export function computeCoverage(run: EvalRun): RunCoverage {
  let completed = 0
  let errors = 0
  let timeouts = 0
  let unscored = 0
  for (const result of run.cases) {
    if (result.status === 'completed') completed += 1
    // Timeouts are their own category: counting a timed-out trial here as well
    // would double-count it and make the report look like two unscored trials.
    else if (!result.timedOut) errors += 1
    if (result.timedOut) timeouts += 1
    // A completed trial without a task grade is just as absent from quality
    // rates as an error; keep this identical to computeReliability().unscored.
    if (result.status !== 'completed' || typeof result.grade?.taskSuccess !== 'boolean') unscored += 1
  }
  return {
    total: run.cases.length,
    completed,
    errors,
    timeouts,
    unscored,
  }
}

/**
 * Fold a run's trials into reliability metrics for one grading dimension.
 *
 * Every trial for a case contributes to `total`, even an error or timeout.
 * `passAt1` keeps its historical graded-only denominator; `strictPassAt1`
 * divides by all trials so a model that times out on hard cases cannot look
 * better than one that finishes and fails.
 * @param run - the run to summarize.
 * @param dimension - `task` (default) or `tool-selection` grading.
 * @returns the summary, or null when no trial carried that grade.
 */
export function computeReliability(
  run: EvalRun,
  dimension: ReliabilityDimension = 'task',
): ReliabilitySummary | null {
  const grouped = new Map<string, { total: number; graded: number; passes: number }>()
  for (const result of run.cases) {
    const group = grouped.get(result.caseId) ?? { total: 0, graded: 0, passes: 0 }
    group.total += 1
    if (result.status === 'completed') {
      const passed = readGrade(result, dimension)
      if (passed !== null) {
        group.graded += 1
        if (passed) group.passes += 1
      }
    }
    grouped.set(result.caseId, group)
  }
  const all = [...grouped.values()]
  const cases = [...grouped].filter(([, group]) => group.graded > 0).map(([caseId, group]) => ({
    caseId,
    trials: group.graded,
    total: group.total,
    passes: group.passes,
    rate: group.passes / group.graded,
  }))
  if (cases.length === 0) return null

  const trials = cases.reduce((sum, item) => sum + item.trials, 0)
  const passes = cases.reduce((sum, item) => sum + item.passes, 0)
  const total = all.reduce((sum, group) => sum + group.total, 0)
  const graded = all.reduce((sum, group) => sum + group.graded, 0)
  return {
    dimension,
    k: run.trials,
    cases: cases.length,
    total,
    passAt1: passes / trials,
    strictPassAt1: passes / total,
    unscored: total - graded,
    passAtK: cases.filter(item => item.passes > 0).length / cases.length,
    passAllK: cases.filter(item => item.passes === item.trials).length / cases.length,
    flaky: cases.filter(item => item.passes > 0 && item.passes < item.trials),
    // Case ids are unique map keys, so the tie-break never compares equals.
    hardest: [...cases]
      .sort((a, b) => a.rate - b.rate || (a.caseId < b.caseId ? -1 : 1))
      .slice(0, 3),
  }
}
