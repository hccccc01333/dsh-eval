/**
 * Cross-run comparison for dsh-eval: two persisted run reports become a row
 * list of metric values and deltas, rendered as a markdown table.
 *
 * @module dsh-eval/compare
 */

import type { EvalRun, EvalTrialResult } from './types.ts'
import { computeCoverage, computeReliability } from './reliability.ts'
import {
  bonferroni,
  pairedDelta,
  signTest,
  signTestPower,
  type FamilyWiseCorrection,
  type PairedDelta,
  type SignTestOutcome,
  type SignTestPower,
} from './stats.ts'

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
  /** Inference about a paired comparison, rendered in a separate table. */
  inference?: string
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
  /** Exact two-sided sign test over the discordant pairs of the primary metric (raw p-value). */
  test: SignTestOutcome
  /** Bonferroni correction shared by the printed p-value and delta intervals. */
  correction: FamilyWiseCorrection
  /** Whether the discordant sample can reach the corrected alpha at all. */
  power: SignTestPower
  /** Paired step delta (`b - a`) with its bootstrap interval, or null when no pair is numeric. */
  stepsDelta: PairedDelta | null
  /** Paired token delta (`b - a`) with its bootstrap interval, or null when no pair is numeric. */
  tokensDelta: PairedDelta | null
  /** Paired judge-score delta (`b - a`) with its bootstrap interval, or null without verdicts. */
  scoreDelta: PairedDelta | null
}

/** Render a nullable number with a dash placeholder. */
function formatNumber(value: number | null, digits = 1): string {
  return value === null ? '–' : value.toFixed(digits)
}

/** Render a nullable rate as percent with a dash placeholder. */
function formatRate(value: number | null): string {
  return value === null ? '–' : `${(value * 100).toFixed(1)}%`
}

/** Render USD at micro-dollar precision — one decimal rounds every real cost to zero. */
function formatUsd(value: number | null): string {
  return value === null ? '–' : `$${value.toFixed(6)}`
}

/** Render a signed USD delta at micro-dollar precision. */
function formatUsdDelta(a: number | null, b: number | null): string {
  if (a === null || b === null) return '–'
  const delta = b - a
  return `${delta >= 0 ? '+' : '-'}$${Math.abs(delta).toFixed(6)}`
}

/** Render a signed delta between two counts without decimal noise. */
function formatCountDelta(a: number, b: number): string {
  const delta = b - a
  return `${delta >= 0 ? '+' : ''}${delta}`
}

/** Render a signed delta between two nullable numbers. */
function formatDelta(a: number | null, b: number | null, unit: 'pp' | '' = ''): string {
  if (a === null || b === null) return '–'
  const delta = unit === 'pp' ? (b - a) * 100 : b - a
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}${unit}`
}

/** Render a paired delta with its bootstrap interval at the given confidence. */
function formatPairedDelta(delta: PairedDelta, intervalConfidence: number): string {
  const mean = formatDelta(0, delta.mean)
  return delta.lower === null || delta.upper === null
    ? mean
    : `${mean} [${(intervalConfidence * 100).toFixed(1)}% CI ${formatDelta(0, delta.lower)}, ${formatDelta(0, delta.upper)}]`
}

/** Render an exact p-value, collapsing anything below the print precision. */
export function formatPValue(pValue: number): string {
  if (pValue < 0.001) return '<0.001'
  // Four decimals near alpha keep a significant 0.0496 from printing 0.050.
  return pValue < 0.06 ? pValue.toFixed(4) : pValue.toFixed(3)
}

/** A metric that can classify a paired winner. */
export type PairedMetric = 'task success' | 'tool selection accuracy' | 'final answer score'

/** Read one trial's primary-metric outcome, or null when the trial lacks it. */
function metricOutcome(result: EvalTrialResult, metric: PairedMetric): boolean | number | null {
  if (metric === 'task success') return result.grade?.taskSuccess ?? null
  if (metric === 'tool selection accuracy') return result.grade?.toolSelectionAccuracy ?? null
  return result.judge?.finalAnswerScore ?? null
}

/**
 * Pick the metric with the most usable pairs, preferring earlier metrics on a
 * tie. Requiring a metric in *every* pair silently discarded paired inference
 * as soon as one trial was ungraded, even when many other pairs carried the
 * metric. pairedCases and pairedSigns skip missing pairs; do the same here.
 * Return null only when no metric has a single usable pair.
 */
function pickMetric(
  pairs: readonly { a: EvalTrialResult; b: EvalTrialResult }[],
): PairedMetric | null {
  let best: PairedMetric | null = null
  let bestCount = 0
  for (const metric of ['task success', 'tool selection accuracy', 'final answer score'] as const) {
    let count = 0
    for (const pair of pairs) {
      if (metricOutcome(pair.a, metric) !== null && metricOutcome(pair.b, metric) !== null) {
        count += 1
      }
    }
    if (count > bestCount) {
      best = metric
      bestCount = count
    }
  }
  return best
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

/** Win/loss/tie counts for one metric over completed, paired trials. */
export interface PairedSignCounts {
  /** Pairs with both outcomes present for the metric. */
  pairs: number
  wins: number
  losses: number
  ties: number
}

/**
 * Count paired wins/losses/ties for one metric, ignoring pairs missing it.
 * @param a - the baseline run.
 * @param b - the candidate run.
 * @param metric - the metric to classify.
 * @returns paired sign counts for that metric alone.
 */
export function pairedSigns(a: EvalRun, b: EvalRun, metric: PairedMetric): PairedSignCounts {
  const counts: PairedSignCounts = { pairs: 0, wins: 0, losses: 0, ties: 0 }
  for (const pair of pairedTrials(a, b)) {
    const sign = pairSign(metricOutcome(pair.a, metric), metricOutcome(pair.b, metric))
    if (metricOutcome(pair.a, metric) === null || metricOutcome(pair.b, metric) === null) continue
    counts.pairs += 1
    if (sign > 0) counts.wins += 1
    else if (sign < 0) counts.losses += 1
    else counts.ties += 1
  }
  return counts
}

/** Pair completed trials from both runs by case id and trial index. */
function pairedTrials(a: EvalRun, b: EvalRun): { a: EvalTrialResult; b: EvalTrialResult }[] {
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
  return pairs
}

/**
 * Pair both runs' trials by case id and trial index and compute win/lose/tie
 * plus mean deltas. Trials are paired as-is; the runs' `seed` is recorded
 * provenance for the pairing, not a guarantee of identical model output.
 * @param a - the baseline run.
 * @param b - the candidate run.
 * @returns paired statistics, or null when no trial is completed in both runs
 * or no primary metric is measured on any pair.
 */
/**
 * The sign-test part of a paired comparison, shared by the full comparison
 * (which adds bootstrap intervals) and the lightweight leaderboard path.
 */
interface PairedCore {
  pairs: { a: EvalTrialResult; b: EvalTrialResult }[]
  primaryMetric: PairedMetric
  measuredPairs: number
  wins: number
  losses: number
  ties: number
  test: SignTestOutcome
}

function pairedCore(a: EvalRun, b: EvalRun): PairedCore | null {
  const pairs = pairedTrials(a, b)
  if (pairs.length === 0) return null
  const primaryMetric = pickMetric(pairs)
  if (primaryMetric === null) return null
  let wins = 0
  let losses = 0
  let ties = 0
  let measuredPairs = 0
  for (const pair of pairs) {
    const aOutcome = metricOutcome(pair.a, primaryMetric)
    const bOutcome = metricOutcome(pair.b, primaryMetric)
    if (aOutcome !== null && bOutcome !== null) {
      measuredPairs += 1
      const sign = pairSign(aOutcome, bOutcome)
      if (sign > 0) wins += 1
      else if (sign < 0) losses += 1
      else ties += 1
    }
  }
  return { pairs, primaryMetric, measuredPairs, wins, losses, ties, test: signTest(wins, losses) }
}

/**
 * Lightweight paired verdict for leaderboards: sign counts, p-value and the
 * single-comparison alpha, without the three bootstrap intervals that
 * {@link pairedCompare} computes but a leaderboard never displays. Skipping
 * those resamples avoids ~3 × 2000 × pairs wasted iterations per board row.
 */
export interface PairedSignals {
  pairs: number
  wins: number
  losses: number
  ties: number
  primaryMetric: PairedMetric
  pValue: number
  /** Matches the default alpha of the Bonferroni correction in `pairedCompare`. */
  alpha: number
}

export function pairedSignals(a: EvalRun, b: EvalRun): PairedSignals | null {
  const core = pairedCore(a, b)
  if (core === null) return null
  return {
    pairs: core.measuredPairs,
    wins: core.wins,
    losses: core.losses,
    ties: core.ties,
    primaryMetric: core.primaryMetric,
    pValue: core.test.pValue,
    alpha: 0.05,
  }
}

export function pairedCompare(a: EvalRun, b: EvalRun): PairedStats | null {
  const core = pairedCore(a, b)
  if (core === null) return null
  const { pairs, primaryMetric, measuredPairs, wins, losses, ties, test } = core
  const stepDeltas: number[] = []
  const tokenDeltas: number[] = []
  const scoreDeltas: number[] = []
  for (const pair of pairs) {
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
  // The printed p-value and each non-null interval are tested as one family.
  const comparisons = 1 + [stepDeltas, tokenDeltas, scoreDeltas].filter(deltas => deltas.length > 0).length
  const correction = bonferroni(test.pValue, comparisons)
  return {
    pairs: measuredPairs,
    wins,
    losses,
    ties,
    primaryMetric,
    test,
    correction,
    power: signTestPower(test.discordant, comparisons, correction.alpha),
    stepsDelta: pairedDelta(stepDeltas, { confidence: correction.intervalConfidence }),
    tokensDelta: pairedDelta(tokenDeltas, { confidence: correction.intervalConfidence }),
    scoreDelta: pairedDelta(scoreDeltas, { confidence: correction.intervalConfidence }),
  }
}

/** One paired case x trial classified on the same primary metric as the sign test. */
export interface PairedCase {
  caseId: string
  trial: number
  a: boolean | number | null
  b: boolean | number | null
  outcome: 'B better' | 'A better' | 'tie'
}

/**
 * Classify every paired case x trial, using the same metric selection as
 * {@link pairedCompare} so the case list explains its win/lose/tie counts.
 * @param a - the baseline run.
 * @param b - the candidate run.
 * @returns one row per completed pair with a measured value, or null when
 * there are no comparable pairs. Ungraded pairs must not inflate the per-case
 * Bonferroni family.
 */
export function pairedCases(a: EvalRun, b: EvalRun, metricOverride?: PairedMetric): PairedCase[] | null {
  const pairs = pairedTrials(a, b)
  if (pairs.length === 0) return null
  const metric = metricOverride ?? pickMetric(pairs)
  if (metric === null) return null
  const measured = pairs.filter(pair =>
    metricOutcome(pair.a, metric) !== null && metricOutcome(pair.b, metric) !== null)
  if (measured.length === 0) return null
  return measured.map(pair => {
    const aValue = metricOutcome(pair.a, metric)!
    const bValue = metricOutcome(pair.b, metric)!
    const sign = pairSign(aValue, bValue)
    return {
      caseId: pair.a.caseId,
      trial: pair.a.trial,
      a: aValue,
      b: bValue,
      outcome: sign > 0 ? 'B better' : sign < 0 ? 'A better' : 'tie',
    }
  })
}

/** Aggregated paired evidence for one case across its trial pairs. */
export interface CaseSignificance {
  caseId: string
  pairs: number
  wins: number
  losses: number
  ties: number
  adjustedP: number
  detectable: boolean
  /** Discordant pairs needed to clear this case's family-wise threshold. */
  requiredPairs: number
  verdict: 'significantly-better' | 'significantly-worse' | 'not-significant' | 'underpowered'
}

/**
 * Per-case exact sign tests with Bonferroni correction across the cases.
 * This is a separate inference family from the pooled paired metrics.
 */
export function pairedCaseSignificance(
  a: EvalRun,
  b: EvalRun,
  metricOverride?: PairedMetric,
): CaseSignificance[] | null {
  const cases = pairedCases(a, b, metricOverride)
  if (cases === null) return null
  const grouped = new Map<string, { pairs: number; wins: number; losses: number; ties: number }>()
  for (const item of cases) {
    const row = grouped.get(item.caseId) ?? { pairs: 0, wins: 0, losses: 0, ties: 0 }
    row.pairs += 1
    if (item.outcome === 'B better') row.wins += 1
    else if (item.outcome === 'A better') row.losses += 1
    else row.ties += 1
    grouped.set(item.caseId, row)
  }
  const family = Math.max(1, grouped.size)
  const alpha = bonferroni(1, family).alpha
  return [...grouped.entries()]
    .map(([caseId, counts]) => {
      const test = signTest(counts.wins, counts.losses)
      const adjustedP = Math.min(1, test.pValue * family)
      const power = signTestPower(counts.wins + counts.losses, family, alpha)
      const detectable = power.detectable
      const better = counts.wins > counts.losses
      const worse = counts.losses > counts.wins
      return {
        caseId,
        ...counts,
        adjustedP,
        detectable,
        requiredPairs: power.minimumDiscordant,
        verdict: !detectable ? 'underpowered' as const
          : better && adjustedP <= alpha ? 'significantly-better' as const
            : worse && adjustedP <= alpha ? 'significantly-worse' as const
              : 'not-significant' as const,
      }
    })
    .sort((left, right) => left.adjustedP - right.adjustedP
      /* v8 ignore next -- case-id tie direction depends on engine sort order. */
      || (left.caseId < right.caseId ? -1 : 1))
}

/** Render per-case paired significance as a markdown block. */
export function renderCaseSignificance(rows: readonly CaseSignificance[]): string {
  if (rows.length === 0) {
    return '## Per-case paired significance\n\n- no paired case evidence\n'
  }
  const confirmed = rows.filter(row =>
    row.verdict === 'significantly-better' || row.verdict === 'significantly-worse')
  const shown = confirmed.slice(0, 20)
  const lines = [
    '## Per-case paired significance',
    '',
    `- ${rows.length} cases · Bonferroni family = ${rows.length} · ${confirmed.length} confirmed changes`,
  ]
  if (shown.length < confirmed.length) {
    lines.push(`- showing ${shown.length} of ${confirmed.length} confirmed changes`)
  }
  const underpowered = rows.filter(row => row.verdict === 'underpowered')
  if (underpowered.length > 0) {
    lines.push(`- ${underpowered.length} underpowered cases need at least ${Math.max(...underpowered.map(row => row.requiredPairs))} discordant pairs for this family`)
  }
  if (shown.length > 0) {
    lines.push('', '| case | pairs | B wins | A wins | adjusted p | result |', '|---|---|---|---|---|---|')
    for (const row of shown) {
      const caseId = row.caseId.replace(/[\u0000-\u001f\u007f-\u009f|]+/gu, ' ')
      lines.push(`| ${caseId} | ${row.pairs} | ${row.wins} | ${row.losses} | ${formatPValue(row.adjustedP)} | ${row.verdict} |`)
    }
  }
  return `${lines.join('\n')}\n`
}

/** Format a paired case value for reports and dashboards. */
export function formatCaseValue(value: boolean | number | null): string {
  if (value === null) return '–'
  if (typeof value === 'boolean') return value ? 'pass' : 'fail'
  return String(value)
}

/**
 * Render the most actionable paired case outcomes: candidate wins first, then
 * candidate losses, capped at 20 rows so a large benchmark still fits a screen.
 * @param cases - rows from {@link pairedCases}.
 * @returns a markdown block ending in a newline.
 */
export function renderPairedCases(cases: readonly PairedCase[]): string {
  const wins = cases.filter(item => item.outcome === 'B better')
  const losses = cases.filter(item => item.outcome === 'A better')
  const ties = cases.length - wins.length - losses.length
  const shown = [...wins, ...losses].slice(0, 20)
  const lines = [
    '## Paired case outcomes',
    '',
    `- ${wins.length} candidate wins · ${losses.length} candidate losses · ${ties} ties`,
  ]
  if (shown.length < wins.length + losses.length) {
    lines.push(`- showing ${shown.length} of ${wins.length + losses.length} discordant pairs`)
  }
  if (shown.length > 0) {
    lines.push('', '| case | trial | A | B | result |', '|---|---|---|---|---|')
    for (const item of shown) {
      const caseId = item.caseId.replace(/[\u0000-\u001f\u007f-\u009f|]+/gu, ' ')
      lines.push(`| ${caseId} | ${item.trial} | ${formatCaseValue(item.a)} | ${formatCaseValue(item.b)} | ${item.outcome} |`)
    }
  }
  return `${lines.join('\n')}\n`
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
  const counts = (count: (run: EvalRun) => number, label: string): CompareRow => ({
    metric: label,
    a: String(count(a)),
    b: String(count(b)),
    delta: formatCountDelta(count(a), count(b)),
  })
  const usd = (selector: RunSelector, label: string): CompareRow => {
    const aValue = selector(a)
    const bValue = selector(b)
    return { metric: label, a: formatUsd(aValue), b: formatUsd(bValue), delta: formatUsdDelta(aValue, bValue) }
  }
  const rows: CompareRow[] = [
    { metric: 'benchmark', a: a.benchmark, b: b.benchmark, delta: '–' },
    { metric: 'model', a: a.model, b: b.model, delta: '–' },
    counts(completed, 'completed trials'),
    numeric(run => run.aggregate?.steps ?? null, 'steps/trial'),
    rates(run => run.aggregate?.toolSuccessRate ?? null, 'tool success', 'pp'),
    rates(run => run.grading?.taskSuccessRate ?? null, 'task success', 'pp'),
    rates(run => run.grading?.toolSelectionAccuracyRate ?? null, 'tool selection accuracy', 'pp'),
    numeric(run => run.grading?.judgeFailures ?? null, 'judge failures'),
    ...(a.judge === undefined && b.judge === undefined ? [] : [{
      metric: 'judge config (model/maxScore)',
      a: a.judge === undefined ? 'none' : `${a.judge.model}/${a.judge.maxScore}`,
      b: b.judge === undefined ? 'none' : `${b.judge.model}/${b.judge.maxScore}`,
      delta: a.judge === undefined || b.judge === undefined
        ? '–'
        : a.judge.maxScore === b.judge.maxScore ? '–' : 'scale mismatch',
    }]),
    numeric(run => run.aggregate?.invalidToolCalls ?? null, 'invalid tool calls/trial'),
    numeric(run => run.aggregate?.retries ?? null, 'retries/trial'),
    numeric(run => run.aggregate?.totalTokens ?? null, 'tokens/trial'),
    usd(run => run.aggregate?.costUsd ?? null, 'cost/trial (USD)'),
    numeric(run => run.aggregate?.latencyMs ?? null, 'latency/trial (ms)'),
  ]
  // Reliability is derived from the trials rather than stored, so older run
  // reports gain these rows on the next `compare` without being rewritten.
  rows.push(
    counts(run => computeCoverage(run).unscored, 'unscored trials'),
    rates(run => computeReliability(run, 'task')?.strictPassAt1 ?? null, 'strict pass@1 (task)', 'pp'),
    rates(run => computeReliability(run, 'task')?.passAtK ?? null, 'pass@k (task)', 'pp'),
    rates(run => computeReliability(run, 'task')?.passAllK ?? null, 'pass^k (task)', 'pp'),
    rates(run => computeReliability(run, 'tool-selection')?.passAtK ?? null, 'pass@k (tool-selection)', 'pp'),
    rates(run => computeReliability(run, 'tool-selection')?.passAllK ?? null, 'pass^k (tool-selection)', 'pp'),
  )
  const paired = pairedCompare(a, b)
  if (paired !== null) {
    // A p-value or a confidence interval is evidence about the pairing, not a
    // signed difference between two run-level numbers. Keep it out of the
    // `delta (B - A)` column so that column only ever contains real differences.
    const inference = (metric: string, value: string): CompareRow => ({
      metric, a: '–', b: '–', delta: '–', inference: value,
    })
    rows.push(
      { metric: 'paired trials', a: String(paired.pairs), b: String(paired.pairs), delta: '–' },
      {
        metric: `paired ${paired.primaryMetric} (B/A/ties)`,
        a: `${paired.wins}/${paired.losses}/${paired.ties}`,
        b: '–',
        delta: '–',
      },
      inference(
        `paired ${paired.primaryMetric} p (sign test, Bonferroni ×${paired.correction.comparisons})`,
        `${formatPValue(paired.correction.adjustedPValue)} (n=${paired.test.discordant})`,
      ),
      inference(
        `paired sign-test power (α=${paired.power.alpha})`,
        paired.power.detectable
          ? `best p ${formatPValue(paired.power.bestAdjustedP)}; needs ${paired.power.minimumWins}/${paired.power.discordant} wins`
          : `unreachable: best p ${formatPValue(paired.power.bestAdjustedP)}; need ≥${paired.power.minimumDiscordant} discordant pairs`,
      ),
      ...(paired.stepsDelta === null ? [] : [inference(
        'paired steps delta (B-A)',
        formatPairedDelta(paired.stepsDelta, paired.correction.intervalConfidence),
      )]),
      ...(paired.tokensDelta === null ? [] : [inference(
        'paired tokens delta (B-A)',
        formatPairedDelta(paired.tokensDelta, paired.correction.intervalConfidence),
      )]),
      ...(paired.scoreDelta === null ? [] : [inference(
        'paired final-answer delta (B-A)',
        formatPairedDelta(paired.scoreDelta, paired.correction.intervalConfidence),
      )]),
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
  const metrics = rows.filter(row => row.inference === undefined)
  const inference = rows.filter(row => row.inference !== undefined)
  return [
    '# Compare',
    '',
    '| metric | run A | run B | delta (B - A) |',
    '|---|---|---|---|',
    ...metrics.map(row => `| ${row.metric} | ${row.a} | ${row.b} | ${row.delta} |`),
    '',
    ...(inference.length === 0 ? [] : [
      '## Paired inference',
      '',
      'Values below describe the paired sample, not a run-level difference.',
      '',
      '| quantity | value |',
      '|---|---|',
      ...inference.map(row => `| ${row.metric} | ${row.inference} |`),
      '',
    ]),
  ].join('\n')
}

/**
 * Render a two-run comparison as machine-readable JSON.
 * @param a - the baseline run.
 * @param b - the candidate run.
 * @returns a JSON string ending in a newline.
 */
export function renderCompareJson(a: EvalRun, b: EvalRun): string {
  const completed = (run: EvalRun): number => run.cases.filter(result => result.status === 'completed').length
  const cases = pairedCases(a, b)
  return `${JSON.stringify({
    baseline: { benchmark: a.benchmark, model: a.model },
    candidate: { benchmark: b.benchmark, model: b.model },
    // `rows` keeps the formatted table for parity with the CLI; `metrics`
    // carries raw numbers so automation never parses a display string.
    rows: compareRuns(a, b),
    metrics: {
      completedTrials: { a: completed(a), b: completed(b) },
      unscoredTrials: {
        a: computeCoverage(a).unscored,
        b: computeCoverage(b).unscored,
      },
      aggregate: ['steps', 'toolSuccessRate', 'invalidToolCalls', 'retries',
        'totalTokens', 'costUsd', 'latencyMs'].reduce<Record<string, { a: number | null; b: number | null }>>(
        (out, key) => {
          const field = key as 'steps' | 'toolSuccessRate' | 'invalidToolCalls'
            | 'retries' | 'totalTokens' | 'costUsd' | 'latencyMs'
          out[key] = {
            a: a.aggregate?.[field] ?? null,
            b: b.aggregate?.[field] ?? null,
          }
          return out
        }, {},
      ),
      grading: ['taskSuccessRate', 'toolSelectionAccuracyRate', 'judgeFailures'].reduce<Record<string, { a: number | null; b: number | null }>>(
        (out, key) => {
          const field = key as keyof NonNullable<EvalRun['grading']>
          out[key] = {
            a: a.grading?.[field] ?? null,
            b: b.grading?.[field] ?? null,
          }
          return out
        }, {},
      ),
      reliability: {
        taskStrictPassAt1: {
          a: computeReliability(a, 'task')?.strictPassAt1 ?? null,
          b: computeReliability(b, 'task')?.strictPassAt1 ?? null,
        },
        taskPassAtK: {
          a: computeReliability(a, 'task')?.passAtK ?? null,
          b: computeReliability(b, 'task')?.passAtK ?? null,
        },
      },
    },
    paired: pairedCompare(a, b),
    caseOutcomesMeasured: cases !== null,
    cases,
    caseSignificance: pairedCaseSignificance(a, b),
  })}\n`
}
