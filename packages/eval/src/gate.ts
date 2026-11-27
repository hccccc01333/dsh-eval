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

import { formatPValue, pairedCaseSignificance, pairedSigns, type PairedMetric } from './compare.ts'
import { compareSegments } from './segment-compare.ts'
import { computeCoverage, computeReliability } from './reliability.ts'
import { signTest, signTestPower } from './stats.ts'
import type { EvalRun } from './types.ts'

/** One gate criterion. */
export interface GateCheck {
  metric: string
  baseline: number | null
  candidate: number | null
  delta: number | null
  passed: boolean
  /** Count checks print integers; rates print percentages; budgets print money/time. */
  unit?: 'count' | 'usd' | 'ms' | 'p'
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
  /** Enabled relative cost budget, if any. */
  maxCostIncrease?: number
  /** Enabled relative latency budget, if any. */
  maxLatencyIncrease?: number
  /** Enabled per-tag quality tolerance, if any. */
  maxSegmentDrop?: number
  /** Cases with a family-corrected, statistically confirmed paired regression. */
  confirmedCaseRegressions?: readonly ConfirmedCaseRegression[]
}

/** A regression that survives per-case multiple-comparison correction. */
export interface ConfirmedCaseRegression {
  caseId: string
  metric: PairedMetric
  adjustedP: number
}

/** Optional resource budgets for a gate run. */
export interface GateBudgets {
  maxCostIncrease?: number | null
  maxLatencyIncrease?: number | null
}

/** Optional significance mode for a gate run. */
export interface GateOptions {
  /**
   * Only treat quality drops as failures when the paired sign test confirms a
   * regression. Insufficient or underpowered evidence fails closed.
   */
  requireSignificance?: boolean
  /** Also fail when a tag shared by both runs drops by more than this ratio. */
  maxSegmentDrop?: number
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
  suppressDrop = false,
): GateCheck {
  if (baseline === null) {
    return { metric, baseline, candidate, delta: null, passed: true, note: 'baseline ungraded' }
  }
  if (candidate === null) {
    return { metric, baseline, candidate, delta: null, passed: false, note: 'candidate ungraded' }
  }
  const delta = candidate - baseline
  if (delta >= -maxDrop) return { metric, baseline, candidate, delta, passed: true }
  if (suppressDrop) {
    return { metric, baseline, candidate, delta, passed: true, note: 'drop not statistically confirmed' }
  }
  return { metric, baseline, candidate, delta, passed: false }
}

/** Compare two resource figures against a relative increase budget. */
function compareBudget(
  metric: string,
  baseline: number | null,
  candidate: number | null,
  maxIncrease: number,
  unit: 'usd' | 'ms',
): GateCheck {
  if (baseline === null) {
    return { metric, baseline, candidate, delta: null, passed: true, unit, note: 'baseline metrics unavailable — check skipped' }
  }
  if (candidate === null) {
    return { metric, baseline, candidate, delta: null, passed: false, unit, note: 'candidate unpriced' }
  }
  const delta = candidate - baseline
  // Floating-point noise at 1e-9 of the baseline must not fail an exact budget.
  const limit = baseline * maxIncrease + Math.abs(baseline) * 1e-9
  return { metric, baseline, candidate, delta, passed: delta <= limit, unit }
}

/**
 * Evaluate a candidate run against a baseline.
 * @param baseline - the trusted reference run.
 * @param candidate - the run under test.
 * @param maxDrop - largest tolerated regression on the 0..1 scale.
 * @param allowIncomplete - skip the trial-coverage checks when true.
 * @param budgets - optional relative cost and latency increase limits.
 * @param options - optional significance mode for quality regressions.
 * @returns the per-metric checks and the overall decision.
 */
export function evaluateGate(
  baseline: EvalRun,
  candidate: EvalRun,
  maxDrop: number,
  allowIncomplete = false,
  budgets: GateBudgets = {},
  options: GateOptions = {},
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
  // Significance is assessed per quality metric: a clean task-success result
  // must never hide a real tool-selection or judge-score regression.
  const suppressByMetric = new Map<string, boolean>()
  if (options.requireSignificance === true) {
    const qualityMetrics = [
      { metric: 'task success', paired: 'task success', a: baseline.grading?.taskSuccessRate ?? null, b: candidate.grading?.taskSuccessRate ?? null },
      { metric: 'tool selection', paired: 'tool selection accuracy', a: baseline.grading?.toolSelectionAccuracyRate ?? null, b: candidate.grading?.toolSelectionAccuracyRate ?? null },
      { metric: 'strict pass@1 (task)', paired: 'task success', a: baseTask?.strictPassAt1 ?? null, b: candTask?.strictPassAt1 ?? null },
      { metric: 'judge score', paired: 'final answer score', a: scoreRate(baseline), b: scoreRate(candidate) },
    ] as const satisfies readonly { metric: string; paired: PairedMetric; a: number | null; b: number | null }[]
    let undecidable = false
    let bestFloor = 1
    let worstObserved = 0
    const assessed = qualityMetrics.filter(item => item.a !== null || item.b !== null)
    // task success and strict pass@1 share one sign test, and ungraded metrics
    // are not tested at all; correcting for all four rows would be too lax.
    const pairedMetrics = [...new Set(assessed.map(item => item.paired))]
    const family = pairedMetrics.length
    const verdicts = new Map<PairedMetric, boolean>()
    for (const pairedMetric of pairedMetrics) {
      const counts = pairedSigns(baseline, candidate, pairedMetric)
      const discordant = counts.wins + counts.losses
      const power = signTestPower(discordant, family)
      const observed = Math.min(1, signTest(counts.wins, counts.losses).pValue * family)
      const worse = counts.losses > counts.wins
      const informative = discordant > 0 && power.detectable
      const confirmed = informative && worse && observed <= power.alpha
      const clear = informative && !confirmed && (observed > power.alpha || !worse)
      verdicts.set(pairedMetric, clear)
      if (!informative || (!confirmed && !clear)) undecidable = true
      bestFloor = Math.min(bestFloor, power.bestAdjustedP)
      worstObserved = Math.max(worstObserved, observed)
    }
    for (const item of assessed) {
      suppressByMetric.set(item.metric, verdicts.get(item.paired) === true)
    }
    // The strict pass@1 rate keeps errors and timeouts in its denominator, but
    // pairedSigns only sees completed trials. A candidate with more unscored
    // trials must not get its strict drop excused by survivor-only evidence.
    if (computeCoverage(candidate).unscored > computeCoverage(baseline).unscored) {
      suppressByMetric.set('strict pass@1 (task)', false)
    }
    checks.push({
      metric: 'paired significance',
      baseline: bestFloor,
      candidate: worstObserved,
      delta: worstObserved - bestFloor,
      passed: !undecidable,
      unit: 'p',
      note: undecidable ? 'some quality metrics lack conclusive paired evidence'
        : 'all quality metrics assessed independently',
    })
  }
  checks.push(
    compareRate('task success', baseline.grading?.taskSuccessRate ?? null,
      candidate.grading?.taskSuccessRate ?? null, maxDrop, suppressByMetric.get('task success')),
    compareRate('tool selection', baseline.grading?.toolSelectionAccuracyRate ?? null,
      candidate.grading?.toolSelectionAccuracyRate ?? null, maxDrop,
      suppressByMetric.get('tool selection')),
    compareRate('strict pass@1 (task)', baseTask?.strictPassAt1 ?? null,
      candTask?.strictPassAt1 ?? null, maxDrop, suppressByMetric.get('strict pass@1 (task)')),
    compareRate('judge score', scoreRate(baseline), scoreRate(candidate), maxDrop,
      suppressByMetric.get('judge score')),
  )
  if (options.maxSegmentDrop !== undefined) {
    // A flat pooled rate can hide a regression concentrated in one tag. Only
    // tags present on both sides are checked: a new or retired dimension is
    // not a drop, and compareSegments already keeps its deltas null.
    for (const segment of compareSegments(baseline, candidate)) {
      if (!segment.baseline || !segment.candidate) continue
      checks.push(compareRate(
        `tag:${segment.tag} task success`,
        segment.baseline.taskSuccessRate, segment.candidate.taskSuccessRate,
        options.maxSegmentDrop,
      ))
      // Prefer the scale-normalized rate: raw judge means are not comparable
      // when the two runs were scored with different maxScore values. Older
      // reports without a recorded judge scale fall back to the raw mean.
      checks.push(compareRate(
        `tag:${segment.tag} judge score`,
        segment.baseline.judgeScoreRate ?? segment.baseline.judgeScoreMean,
        segment.candidate.judgeScoreRate ?? segment.candidate.judgeScoreMean,
        options.maxSegmentDrop,
      ))
    }
  }
  if (budgets.maxCostIncrease !== undefined && budgets.maxCostIncrease !== null) {
    checks.push(compareBudget('cost/trial', baseline.aggregate?.costUsd ?? null,
      candidate.aggregate?.costUsd ?? null, budgets.maxCostIncrease, 'usd'))
  }
  if (budgets.maxLatencyIncrease !== undefined && budgets.maxLatencyIncrease !== null) {
    checks.push(compareBudget('latency/trial', baseline.aggregate?.latencyMs ?? null,
      candidate.aggregate?.latencyMs ?? null, budgets.maxLatencyIncrease, 'ms'))
  }
  // Per-case evidence uses each quality metric's own paired trials; the
  // default metric chosen by pickMetric() would miss tool/judge-only drops.
  const confirmedCaseRegressions = (['task success', 'tool selection accuracy', 'final answer score'] as const)
    .flatMap(metric => (pairedCaseSignificance(baseline, candidate, metric) ?? [])
      .filter(row => row.verdict === 'significantly-worse')
      .map(row => ({ caseId: row.caseId, metric, adjustedP: row.adjustedP })))
  if (options.requireSignificance === true && confirmedCaseRegressions.length > 0) {
    checks.push({
      metric: 'confirmed case regressions',
      baseline: 0, candidate: confirmedCaseRegressions.length,
      delta: confirmedCaseRegressions.length, passed: false, unit: 'count',
      note: 'family-corrected per-case regression',
    })
  }
  return {
    checks,
    passed: checks.every(check => check.passed),
    maxDrop,
    ...(budgets.maxCostIncrease === undefined || budgets.maxCostIncrease === null
      ? {} : { maxCostIncrease: budgets.maxCostIncrease }),
    ...(budgets.maxLatencyIncrease === undefined || budgets.maxLatencyIncrease === null
      ? {} : { maxLatencyIncrease: budgets.maxLatencyIncrease }),
    ...(options.maxSegmentDrop === undefined ? {} : { maxSegmentDrop: options.maxSegmentDrop }),
    regressions: findRegressions(baseline, candidate, maxDrop)
      .filter(regression => suppressByMetric.get(regression.metric) !== true),
    confirmedCaseRegressions,
  }
}

/** Format a gate value as a percentage, a count, or a dash. */
function format(value: number | null, check: GateCheck): string {
  if (value === null) return '–'
  if (check.unit === 'count') return String(value)
  if (check.unit === 'usd') return `$${value.toFixed(6)}`
  if (check.unit === 'ms') return `${value.toFixed(1)} ms`
  if (check.unit === 'p') return value.toFixed(4)
  return `${(value * 100).toFixed(1)}%`
}

/** Format a signed delta with the check's unit. */
function formatDelta(value: number | null, check: GateCheck): string {
  if (value === null) return '–'
  const sign = value >= 0 ? '+' : ''
  if (check.unit === 'count') return `${sign}${value}`
  if (check.unit === 'p') return `${sign}${value.toFixed(4)}`
  if (check.unit === 'usd' || check.unit === 'ms') {
    const relative = check.baseline === null || check.baseline === 0
      ? null : (value / check.baseline) * 100
    return relative === null ? `${sign}${value.toFixed(2)}` : `${sign}${relative.toFixed(1)}%`
  }
  return `${sign}${(value * 100).toFixed(1)}pp`
}

/**
 * Render a gate decision as machine-readable JSON for CI consumers.
 * @param result - the evaluated gate.
 * @returns a JSON string ending in a newline.
 */
export function renderGateJson(result: GateResult): string {
  return `${JSON.stringify({
    passed: result.passed,
    maxDrop: result.maxDrop,
    ...(result.maxCostIncrease === undefined ? {} : { maxCostIncrease: result.maxCostIncrease }),
    ...(result.maxLatencyIncrease === undefined ? {} : { maxLatencyIncrease: result.maxLatencyIncrease }),
    ...(result.maxSegmentDrop === undefined ? {} : { maxSegmentDrop: result.maxSegmentDrop }),
    checks: result.checks,
    regressions: result.regressions ?? [],
    confirmedCaseRegressions: result.confirmedCaseRegressions ?? [],
  })}\n`
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
    const caseId = item.caseId.replace(/[\u0000-\u001f\u007f-\u009f|]+/gu, ' ')
    const before = `${(item.before * 100).toFixed(1)}%`
    const after = `${(item.after * 100).toFixed(1)}%`
    return `  - ${caseId} #${item.trial}: ${item.metric} ${before} → ${after}`
  })
  const confirmed = (result.confirmedCaseRegressions ?? []).slice(0, 5).map(item => {
    const caseId = item.caseId.replace(/[\u0000-\u001f\u007f-\u009f|]+/gu, ' ')
    return `  - ${caseId}: ${item.metric}, adjusted p ${formatPValue(item.adjustedP)}`
  })
  return [
    `# Gate: ${result.passed ? 'PASS' : 'FAIL'}`,
    '',
    `- max tolerated drop: ${(result.maxDrop * 100).toFixed(1)} percentage points`,
    ...(result.maxCostIncrease === undefined ? [] : [`- max tolerated cost increase: ${(result.maxCostIncrease * 100).toFixed(1)}%`]),
    ...(result.maxLatencyIncrease === undefined ? [] : [`- max tolerated latency increase: ${(result.maxLatencyIncrease * 100).toFixed(1)}%`]),
    '',
    '| check | baseline | candidate | Δ | result |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    ...(regressions.length === 0 ? [] : [
      `- case regressions: ${result.regressions!.length} paired trial(s) got worse (showing up to 5)`,
      ...regressions,
    ]),
    ...(confirmed.length === 0 ? [] : [
      `- confirmed case regressions: ${result.confirmedCaseRegressions!.length} case(s) survived family correction (showing up to 5)`,
      ...confirmed,
    ]),
    ...(regressions.length === 0 && confirmed.length === 0 ? [] : ['']),
  ].join('\n')
}
