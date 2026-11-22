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

/** Reliability of one case across its graded trials. */
export interface CaseReliability {
  /** Benchmark case id. */
  caseId: string
  /** Number of graded trials observed for the case. */
  trials: number
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
  /** Fraction of all graded trials that passed. */
  passAt1: number
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
 * Fold a run's trials into reliability metrics for one grading dimension.
 * @param run - the run to summarize.
 * @param dimension - `task` (default) or `tool-selection` grading.
 * @returns the summary, or null when no trial carried that grade.
 */
export function computeReliability(
  run: EvalRun,
  dimension: ReliabilityDimension = 'task',
): ReliabilitySummary | null {
  const grouped = new Map<string, { trials: number; passes: number }>()
  for (const result of run.cases) {
    if (result.status !== 'completed') continue
    const passed = readGrade(result, dimension)
    if (passed === null) continue
    const group = grouped.get(result.caseId) ?? { trials: 0, passes: 0 }
    group.trials += 1
    if (passed) group.passes += 1
    grouped.set(result.caseId, group)
  }
  if (grouped.size === 0) return null

  const cases = [...grouped].map(([caseId, group]) => ({
    caseId,
    trials: group.trials,
    passes: group.passes,
    rate: group.passes / group.trials,
  }))
  const trials = cases.reduce((sum, item) => sum + item.trials, 0)
  const passes = cases.reduce((sum, item) => sum + item.passes, 0)
  return {
    dimension,
    k: run.trials,
    cases: cases.length,
    passAt1: passes / trials,
    passAtK: cases.filter(item => item.passes > 0).length / cases.length,
    passAllK: cases.filter(item => item.passes === item.trials).length / cases.length,
    flaky: cases.filter(item => item.passes > 0 && item.passes < item.trials),
    // Case ids are unique map keys, so the tie-break never compares equals.
    hardest: [...cases]
      .sort((a, b) => a.rate - b.rate || (a.caseId < b.caseId ? -1 : 1))
      .slice(0, 3),
  }
}
