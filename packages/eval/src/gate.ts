/**
 * CI quality gate for dsh-eval: compare a candidate run against a baseline and
 * fail when a quality metric regresses beyond an allowed tolerance.
 *
 * All quality metrics are expressed on a 0..1 scale, so one `--max-drop`
 * threshold applies uniformly to pass rates and judge scores. Judge scores are
 * normalized by each run's configured `maxScore` before comparison.
 *
 * @module dsh-eval/gate
 */

import { computeCoverage, computeReliability } from './reliability.ts'
import type { EvalRun } from './types.ts'

/** One gate criterion. */
export interface GateCheck {
  metric: string
  baseline: number | null
  candidate: number | null
  delta: number | null
  passed: boolean
  /** Count checks print integers; the default is a 0..1 rate. */
  unit?: 'count'
  note?: string
}

/** A single case x trial that got worse between the two runs. */
export interface CaseRegression {
  caseId: string
  trial: number
  metric: 'task success' | 'tool selection' | 'judge score'
  before: number
  after: number
}

/** Aggregated gate decision. */
export interface GateResult {
  checks: readonly GateCheck[]
  passed: boolean
  maxDrop: number
  /** Optional for callers that only need the aggregate verdict. */
  regressions?: readonly CaseRegression[]
}

/** Normalized judge score for a run, or null when ungraded. */
function scoreRate(run: EvalRun): number | null {
  const score = run.grading?.finalAnswerScore
  if (score === null || score === undefined) return null
  const maxScore = run.judge?.maxScore
  return maxScore === undefined || maxScore <= 0 ? null : score / maxScore
}

/** Normalized per-case judge score for one trial. */
function caseScore(run: EvalRun, result: EvalRun['cases'][number]): number | null {
  const verdict = result.judge
  if (verdict === undefined) return null
  const score = verdict.finalAnswerScore
  const maxScore = run.judge?.maxScore
  if (score === null || maxScore === undefined || maxScore <= 0) return null
  return Math.max(0, Math.min(1, score / maxScore))
}

/** Find paired case x trials that regressed, for actionable CI output. */
function findRegressions(
  baseline: EvalRun,
  candidate: EvalRun,
  maxDrop: number,
): CaseRegression[] {
  const byKey = new Map<string, EvalRun['cases'][number]>()
  for (const result of baseline.cases) byKey.set(`${result.caseId}\u0000${result.trial}`, result)
  const regressions: CaseRegression[] = []
  for (const result of candidate.cases) {
    const before = byKey.get(`${result.caseId}\u0000${result.trial}`)
    if (before === undefined) continue
    for (const [metric, previous, current] of [
      ['task success', before.grade?.taskSuccess, result.grade?.taskSuccess],
      ['tool selection', before.grade?.toolSelectionAccuracy, result.grade?.toolSelectionAccuracy],
    ] as const) {
      if (previous === true && current === false) {
        regressions.push({ caseId: result.caseId, trial: result.trial, metric, before: 1, after: 0 })
      }
    }
    const previousScore = caseScore(baseline, before)
    const currentScore = caseScore(candidate, result)
    if (previousScore !== null && currentScore !== null && currentScore < previousScore - maxDrop) {
      regressions.push({
        caseId: result.caseId, trial: result.trial, metric: 'judge score',
        before: previousScore, after: currentScore,
      })
    }
  }
  return regressions
}

/** Compare two nullable rates, allowing a drop of at most `maxDrop`. */
function compareRate(
  metric: string,
  baseline: number | null,
  candidate: number | null,
  maxDrop: number,
): GateCheck {
  if (baseline === null) {
    return { metric, baseline, candidate, delta: null, passed: true, note: 'baseline ungraded' }
  }
  if (candidate === null) {
    return { metric, baseline, candidate, delta: null, passed: false, note: 'candidate ungraded' }
  }
  const delta = candidate - baseline
  return { metric, baseline, candidate, delta, passed: delta >= -maxDrop }
}

/**
 * Evaluate a candidate run against a baseline.
 * @param baseline - the trusted reference run.
 * @param candidate - the run under test.
 * @param maxDrop - largest tolerated regression on the 0..1 scale.
 * @param allowIncomplete - skip the trial-coverage checks when true.
 * @returns the per-metric checks and the overall decision.
 */
export function evaluateGate(
  baseline: EvalRun,
  candidate: EvalRun,
  maxDrop: number,
  allowIncomplete = false,
): GateResult {
  const baseCoverage = computeCoverage(baseline)
  const candCoverage = computeCoverage(candidate)
  const baseTask = computeReliability(baseline, 'task')
  const candTask = computeReliability(candidate, 'task')
  const checks: GateCheck[] = []
  if (!allowIncomplete) {
    for (const [metric, value, limit, comparison] of [
      ['completed trials', candCoverage.completed, baseCoverage.completed, 'at least'],
      ['unscored trials', candCoverage.unscored, baseCoverage.unscored, 'at most'],
    ] as const) {
      const passed = comparison === 'at least' ? value >= limit : value <= limit
      checks.push({
        metric, baseline: limit, candidate: value,
        delta: value - limit, passed, unit: 'count',
        ...(passed ? {} : { note: `expected ${comparison} ${limit}` }),
      })
    }
  }
  checks.push(
    compareRate('task success', baseline.grading?.taskSuccessRate ?? null,
      candidate.grading?.taskSuccessRate ?? null, maxDrop),
    compareRate('tool selection', baseline.grading?.toolSelectionAccuracyRate ?? null,
      candidate.grading?.toolSelectionAccuracyRate ?? null, maxDrop),
    compareRate('strict pass@1 (task)', baseTask?.strictPassAt1 ?? null,
      candTask?.strictPassAt1 ?? null, maxDrop),
    compareRate('judge score', scoreRate(baseline), scoreRate(candidate), maxDrop),
  )
  return {
    checks,
    passed: checks.every(check => check.passed),
    maxDrop,
    regressions: findRegressions(baseline, candidate, maxDrop),
  }
}

/** Format a gate value as a percentage, a count, or a dash. */
function format(value: number | null, check: GateCheck): string {
  if (value === null) return '–'
  if (check.unit === 'count') return String(value)
  return `${(value * 100).toFixed(1)}%`
}

/** Format a signed delta with the check's unit. */
function formatDelta(value: number | null, check: GateCheck): string {
  if (value === null) return '–'
  const sign = value >= 0 ? '+' : ''
  return check.unit === 'count'
    ? `${sign}${value}`
    : `${sign}${(value * 100).toFixed(1)}pp`
}

/**
 * Render a gate decision as markdown.
 * @param result - the evaluated gate.
 * @returns a compact table ending in a newline.
 */
export function renderGate(result: GateResult): string {
  const rows = result.checks.map(check => `| ${check.metric} | ${format(check.baseline, check)} | ${format(check.candidate, check)} | ${formatDelta(check.delta, check)} | ${check.passed ? 'PASS' : 'FAIL'}${check.note === undefined ? '' : ` (${check.note})`} |`)
  const regressions = (result.regressions ?? []).slice(0, 5).map(item => {
    // Case ids come from benchmark files; keep them from breaking markdown lines.
    const caseId = item.caseId.replace(/[\r\n|]/gu, ' ')
    const before = `${(item.before * 100).toFixed(1)}%`
    const after = `${(item.after * 100).toFixed(1)}%`
    return `  - ${caseId} #${item.trial}: ${item.metric} ${before} → ${after}`
  })
  return [
    `# Gate: ${result.passed ? 'PASS' : 'FAIL'}`,
    '',
    `- max tolerated drop: ${(result.maxDrop * 100).toFixed(1)} percentage points`,
    '',
    '| check | baseline | candidate | Δ | result |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    ...(regressions.length === 0 ? [] : [
      `- case regressions: ${result.regressions!.length} paired trial(s) got worse (showing up to 5)`,
      ...regressions,
      '',
    ]),
  ].join('\n')
}
