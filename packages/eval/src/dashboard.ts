/**
 * Self-contained HTML dashboard for a persisted eval run.
 *
 * The output has no external assets or scripts, so it can be opened from a CI
 * artifact, a local temp directory, or an offline machine. Every value that
 * came from the benchmark or the agent is HTML-escaped: a benchmark id or an
 * error string is data, never markup.
 *
 * @module dsh-eval/dashboard
 */

import { writeTextAtomic } from './atomic-write.ts'
import { computeAgreement } from './agreement.ts'
import { computeAnomalies } from './anomalies.ts'
import { computeCalibration } from './calibration.ts'
import { clusterFailures, type FailureCluster } from './clusters.ts'
import { computeSegments } from './dimensions.ts'
import { compareSegments } from './segment-compare.ts'
import { compareRuns, formatCaseValue, formatPValue, pairedCases, pairedCaseSignificance, pairedCompare } from './compare.ts'
import { buildLeaderboard, formatLeaderboardSignificance, type LeaderboardMetric } from './leaderboard.ts'
import type { RateInterval } from './precision.ts'
import type { PairedDelta } from './stats.ts'
import { computePrecision } from './precision.ts'
import { computeCoverage, computeReliability } from './reliability.ts'
import type { EvalRun } from './types.ts'

/** Shared inline stylesheet; the page has no external assets. */
const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#1d2430;--muted:#667085;--line:#e3e7ed;--card:#fff;--accent:#2563eb;--bad:#b42318;--good:#067647}
@media(prefers-color-scheme:dark){:root{--bg:#11151c;--fg:#e6eaf0;--muted:#98a2b3;--line:#2b3442;--card:#1a202a;--accent:#7aa2ff;--bad:#f97066;--good:#6ce9a6}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:32px 20px 64px}h1{font-size:26px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 12px}
.sub{color:var(--muted);margin:0 0 24px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:4px}
.card .label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.05em}.card strong{font-size:24px;font-variant-numeric:tabular-nums}
.note,.muted{color:var(--muted);font-size:12px}table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
tr:last-child td{border-bottom:0}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.pill{border-radius:999px;padding:2px 8px;font-size:12px}
.pill.completed{background:rgba(6,118,71,.12);color:var(--good)}.pill.error{background:rgba(180,35,24,.12);color:var(--bad)}
.detail{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}
.table-wrapper{overflow:auto;max-inline-size:100%;max-block-size:min(500px,80vh);container-type:inline-size;border-radius:12px}
.table-wrapper table{border-radius:0}.table-wrapper thead{position:sticky;inset-block-start:0;z-index:1;background:var(--card)}
.forest{display:block;max-width:100%}.forest-zero{stroke:var(--muted);stroke-width:1;stroke-dasharray:3 3}
.forest-ci{stroke:var(--accent);stroke-width:3;stroke-linecap:round}.forest-estimate{fill:var(--accent)}
footer{margin-top:32px;color:var(--muted);font-size:12px}
`

/**
 * Write the dashboard as a standalone HTML file, creating parent directories.
 * @param runs - one run, two for a comparison table, or three+ for a leaderboard.
 * @param path - output path.
 */
export async function writeDashboard(
  runs: readonly EvalRun[],
  path: string,
  metric: LeaderboardMetric = 'taskSuccess',
): Promise<void> {
  await writeTextAtomic(path, renderDashboard(runs, metric))
}

/** Escape text for interpolation into HTML. */
function esc(value: string): string {
  // The HTML file may be opened in a terminal-rendered viewer or copy/pasted
  // into one, so control bytes must not survive the HTML escaping either.
  return value.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ').replace(/[&<>"']/gu, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!)
}

/** Format a rate, or a dash when the metric is ungraded. */
function rate(value: number | null): string {
  return value === null ? '–' : `${(value * 100).toFixed(1)}%`
}

/** Format a judge score, or a dash when the run has no judge verdicts. */
function scoreOrDash(value: number | null): string {
  return value === null ? '–' : value.toFixed(1)
}

/** Format a signed delta, or a dash when either side had no verdict. */
function signedOrDash(value: number | null, scale = 1, suffix = ''): string {
  if (value === null) return '–'
  const scaled = value * scale
  return `${scaled >= 0 ? '+' : ''}${scaled.toFixed(1)}${suffix}`
}

/** Format a USD price, or a dash when pricing was not configured. */
function cost(value: number | null): string {
  return value === null ? '–' : `$${value.toFixed(6)}`
}

/** Render a metric as a summary card. */
function card(label: string, value: string, note: string): string {
  return `<div class="card"><span class="label">${esc(label)}</span><strong>${esc(value)}</strong><span class="note">${esc(note)}</span></div>`
}

/** Render a confidence interval cell. */
function interval(value: RateInterval): string {
  const range = value.lower === null || value.upper === null
    ? ''
    : ` <span class="note">[${rate(value.lower)}, ${rate(value.upper)}]</span>`
  return `${rate(value.rate)}${range} <span class="note">n=${value.trials}</span>`
}

/** Geometry of one forest plot; fixed viewBox keeps identical input byte-identical output. */
const FOREST_WIDTH = 180
const FOREST_HEIGHT = 34
const FOREST_PAD = 12

/**
 * Render a paired delta as a self-contained inline SVG forest plot: a segment
 * spanning the bootstrap interval, a dot at the point estimate, and a dashed
 * vertical zero reference. The scale is centred on the finite min/max of the
 * plotted values, so a zero-width interval, an extreme magnitude or a
 * non-finite input can never put NaN/Infinity into an SVG coordinate. Returns
 * an empty string when the interval is unavailable (too few pairs).
 */
function deltaForestPlot(delta: PairedDelta, context: string): string {
  const { lower, upper, mean } = delta
  if (lower === null || upper === null) return ''
  if (![lower, upper, mean].every(Number.isFinite)) return ''
  const lo = Math.min(lower, upper, mean, 0)
  const hi = Math.max(lower, upper, mean, 0)
  // lo/2 + hi/2 cannot overflow, unlike (lo + hi) / 2, for opposite extremes.
  const mid = lo / 2 + hi / 2
  const radius = Math.max(hi - mid, mid - lo)
  const centre = FOREST_WIDTH / 2
  const half = (FOREST_WIDTH - 2 * FOREST_PAD) / 2
  const x = (value: number): string => {
    const scaled = radius === 0 ? centre : centre + ((value - mid) / radius) * half
    return Math.min(FOREST_WIDTH, Math.max(0, scaled)).toFixed(2)
  }
  const y = FOREST_HEIGHT / 2
  const description = `${context} bootstrap interval with zero reference`
  return `<svg class="forest" viewBox="0 0 ${FOREST_WIDTH} ${FOREST_HEIGHT}" width="${FOREST_WIDTH}" height="${FOREST_HEIGHT}" role="img" aria-label="${esc(description)}">`
    + `<title>${esc(description)}</title>`
    + `<line class="forest-zero" x1="${x(0)}" y1="4" x2="${x(0)}" y2="${FOREST_HEIGHT - 4}"/>`
    + `<line class="forest-ci" x1="${x(lower)}" y1="${y}" x2="${x(upper)}" y2="${y}"/>`
    + `<circle class="forest-estimate" cx="${x(mean)}" cy="${y}" r="4"/>`
    + '</svg>'
}

/** Render up to five escaped case references for a cluster, then a `+N more` marker. */
function clusterCases(cluster: FailureCluster): string {
  const shown = cluster.cases.slice(0, 5)
    .map(item => `<code>${esc(item.caseId)}</code>#${item.trial}`)
  const remaining = cluster.count - shown.length
  return `${shown.join(' · ')}${remaining > 0 ? ` · +${remaining} more` : ''}`
}

/** Render a table from a header and already-escaped row fragments. */
function table(headers: readonly string[], rows: readonly string[], label = 'Evaluation data'): string {
  return [
    `<div class="table-wrapper" role="region" tabindex="0" aria-label="${esc(label)}">`,
    '<table><thead><tr>',
    ...headers.map(header => `<th scope="col">${esc(header)}</th>`),
    '</tr></thead><tbody>',
    ...rows.map(row => `<tr>${row}</tr>`),
    '</tbody></table></div>',
  ].join('')
}

/** Render the two-run comparison table from the same rows the markdown report uses. */
function renderComparison(a: EvalRun, b: EvalRun): string {
  const compared = compareRuns(a, b)
  const rows = compared.filter(row => row.inference === undefined)
    .map(row => [row.metric, row.a, row.b, row.delta]
      .map(value => `<td>${esc(value)}</td>`).join(''))
  // The paired inference rows keep their original text values. Alongside them
  // we render a small self-contained forest plot for each non-null bootstrap
  // interval; a delta with no interval (one pair) simply has an empty cell.
  const paired = pairedCompare(a, b)
  const plots = new Map<string, string>()
  if (paired !== null) {
    const context = `${a.benchmark} → ${b.benchmark}`
    const deltas: readonly (readonly [string, PairedDelta | null])[] = [
      ['paired steps delta (B-A)', paired.stepsDelta],
      ['paired tokens delta (B-A)', paired.tokensDelta],
      ['paired final-answer delta (B-A)', paired.scoreDelta],
    ]
    for (const [label, delta] of deltas) {
      if (delta !== null) plots.set(label, deltaForestPlot(delta, `${context} ${label}`))
    }
  }
  const inferenceRows = compared.filter(row => row.inference !== undefined)
    .map(row => `<td>${esc(row.metric)}</td><td>${esc(row.inference!)}</td><td>${plots.get(row.metric) ?? ''}</td>`)
  const cases = pairedCases(a, b) ?? []
  const discordant = cases.filter(item => item.outcome !== 'tie').slice(0, 10)
  const caseRows = discordant.map(item => [item.caseId, String(item.trial),
    formatCaseValue(item.a), formatCaseValue(item.b), item.outcome]
    .map(value => `<td>${esc(value)}</td>`).join(''))
  const caseBlock = discordant.length === 0 ? '' : `<h2>Changed cases</h2>${table(
    ['Case', 'Trial', 'A', 'B', 'Result'], caseRows, 'Changed cases',
  )}`
  const significance = pairedCaseSignificance(a, b) ?? []
  const confirmed = significance.filter(row =>
    row.verdict === 'significantly-better' || row.verdict === 'significantly-worse')
  const shown = confirmed.slice(0, 10)
  const significanceRows = shown.map(row => [row.caseId, String(row.pairs),
    String(row.wins), String(row.losses), formatPValue(row.adjustedP), row.verdict]
    .map(value => `<td>${esc(value)}</td>`).join(''))
  const truncation = shown.length < confirmed.length
    ? `<p class="sub">showing ${shown.length} of ${confirmed.length} confirmed changes</p>` : ''
  const underpowered = significance.filter(row => row.verdict === 'underpowered')
  const powerNote = underpowered.length === 0 ? ''
    : `<p class="sub">${underpowered.length} underpowered cases need at least ${Math.max(...underpowered.map(row => row.requiredPairs))} discordant pairs for this family</p>`
  const significanceBlock = confirmed.length === 0 ? '' : `<h2>Confirmed case changes</h2>`
    + `<p class="sub">${significance.length} cases · Bonferroni family = ${significance.length} · ${confirmed.length} confirmed</p>`
    + truncation
    + table(['Case', 'Pairs', 'B wins', 'A wins', 'Adjusted p', 'Result'], significanceRows,
      'Confirmed case changes')
  const segmentRows = compareSegments(a, b).map(item => [
    item.tag,
    rate(item.baseline?.taskSuccessRate ?? null),
    rate(item.candidate?.taskSuccessRate ?? null),
    signedOrDash(item.taskSuccessDelta, 100, 'pp'),
    scoreOrDash(item.baseline?.judgeScoreMean ?? null),
    scoreOrDash(item.candidate?.judgeScoreMean ?? null),
    signedOrDash(item.judgeScoreDelta),
    signedOrDash(item.judgeScoreRateDelta, 100, 'pp'),
  ].map(value => `<td>${esc(value)}</td>`).join(''))
  const segmentDeltaBlock = segmentRows.length === 0 ? ''
    : `<h2>Segment deltas</h2>${table(
      ['Tag', 'A task', 'B task', 'Δ task', 'A score', 'B score', 'Δ score', 'Δ score %'],
      segmentRows, 'Segment deltas',
    )}`
  return `<h2>Run comparison</h2>${table(['Metric', 'A', 'B', 'B − A'], rows, 'Run comparison')}`
    + (inferenceRows.length === 0 ? '' : `<h2>Paired inference</h2>${table(['Test', 'Result', 'Interval plot'], inferenceRows, 'Paired inference')}`)
    + caseBlock + significanceBlock + powerNote + segmentDeltaBlock
}

/** Render a standalone overview page for three or more runs. */
function renderLeaderboardDashboard(runs: readonly EvalRun[], metric: LeaderboardMetric): string {
  const entries = buildLeaderboard(runs.map(run => ({
    label: `${run.benchmark} — ${run.model}`,
    run,
  })), metric)
  const rows = entries.map(entry => [
    String(entry.rank), entry.label, `${entry.completed}/${entry.total}`,
    rate(entry.taskSuccess), rate(entry.strictPassAt1), rate(entry.toolSelection),
    rate(entry.judgeScore), rate(entry.hallucinationRate), cost(entry.costUsd),
    entry.latencyMs === null ? '–' : `${entry.latencyMs.toFixed(1)} ms`,
    entry.rank === 1 ? 'leader' : entry.gapFromBest === null ? '–' : `-${(entry.gapFromBest * 100).toFixed(1)}pp`,
    formatLeaderboardSignificance(entry.significance),
  ].map(value => `<td>${esc(value)}</td>`).join(''))
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-eval leaderboard</title>
<style>${STYLE}</style>
</head>
<body><main>
<h1>Leaderboard</h1>
<p class="sub">${entries.length} runs · ranked by ${metric === 'strictPassAt1' ? 'strict pass@1' : 'pooled task success'} · vs leader is a Bonferroni-corrected paired sign-test verdict</p>
${table(['Rank', 'Run', 'Completed', 'Task', 'Strict pass@1', 'Tool', 'Judge', 'Hallucination', 'Cost/trial', 'Latency/trial', 'Δ best', 'vs leader'], rows, 'Leaderboard')}
<footer>Generated by dsh-eval · self-contained page, no external assets</footer>
</main></body>
</html>
`
}

/**
 * Render a standalone HTML dashboard for one, two, or three+ runs.
 * @param runs - one run, two for a comparison table, or three+ for a leaderboard.
 * @returns a complete HTML document.
 */
export function renderDashboard(runs: readonly EvalRun[], metric: LeaderboardMetric = 'taskSuccess'): string {
  if (runs.length > 2) return renderLeaderboardDashboard(runs, metric)
  const run = runs[0]!
  const coverage = computeCoverage(run)
  const task = computeReliability(run, 'task')
  const tool = computeReliability(run, 'tool-selection')
  const precision = computePrecision(run)
  const agreement = computeAgreement(run)
  const calibration = computeCalibration(run)
  const anomalies = computeAnomalies(run)
  const checkErrors = run.cases.flatMap(result => {
    const error = result.grade?.checkError
    return error === undefined ? [] : [{ caseId: result.caseId, trial: result.trial, error }]
  })
  const judgeErrors = run.cases.flatMap(result => {
    const error = result.judge?.judgeError
    return error === undefined ? [] : [{ caseId: result.caseId, trial: result.trial, error }]
  })
  const aggregate = run.aggregate
  const judge = run.judge
  const cards = [
    card('Completed', `${coverage.completed}/${coverage.total}`, coverage.unscored === 0
      ? 'all trials graded'
      : `${coverage.unscored} unscored · ${coverage.timeouts} timeouts · ${coverage.errors} errors`),
    ...(task === null ? [] : [
      card('pass@1', rate(task.passAt1), `strict ${rate(task.strictPassAt1)}`),
      card('pass@k', rate(task.passAtK), `${run.cases.filter(result => typeof result.grade?.taskSuccess === 'boolean').length} graded · ${task.cases} cases`),
    ]),
    ...(precision.latencyP95 === null ? [] : [
      // computePrecision produces p50 and p95 together.
      card('Latency p95', `${precision.latencyP95.toFixed(0)} ms`, `p50 ${precision.latencyP50!.toFixed(0)} ms`),
    ]),
    card('Cost', cost(aggregate?.costUsd ?? null), aggregate === null ? 'no metrics' : 'total billed USD'),
  ].join('')

  const reliabilityRows = [task, tool]
    .filter((summary): summary is NonNullable<typeof summary> => summary !== null)
    .map(summary => [
      `<td>${esc(summary.dimension)}</td>`,
      `<td>${rate(summary.passAt1)}</td>`,
      `<td>${rate(summary.strictPassAt1)}</td>`,
      `<td>${rate(summary.passAtK)}</td>`,
      `<td>${rate(summary.passAllK)}</td>`,
      `<td>${summary.flaky.length}</td>`,
      `<td>${summary.unscored}</td>`,
    ].join(''))
  const flaky = task === null || task.flaky.length === 0
    ? ''
    : `<p class="muted">Flaky cases: ${task.flaky.map(item => `<code>${esc(item.caseId)}</code> ${item.passes}/${item.total}`).join(' · ')}</p>`
  const hardest = task === null || task.hardest.length === 0
    ? ''
    : `<p class="muted">Hardest cases: ${task.hardest.map(item => `<code>${esc(item.caseId)}</code> ${rate(item.rate)}`).join(' · ')}</p>`

  const precisionRows = [
    ...(precision.task === null ? [] : [`<td>task success</td><td>${interval(precision.task)}</td>`]),
    ...(precision.strictPassAt1 === null ? [] :
      [`<td>strict pass@1 (all trials)</td><td>${interval(precision.strictPassAt1)}</td>`]),
    ...(precision.toolSelection === null ? [] : [`<td>tool selection</td><td>${interval(precision.toolSelection)}</td>`]),
  ]
  const precisionBlock = precisionRows.length === 0 && precision.latencyP50 === null
    ? ''
    : `<h2>Precision</h2>${table(['Metric', 'Bootstrap interval'], precisionRows, 'Precision intervals')}`

  const agreementBlock = agreement === null ? '' : `
    <h2>Judge / script agreement</h2>
    ${table(['Pairs', 'Observed', "Cohen's kappa", 'Judge pass', 'Script pass'], [
      [agreement.pairs, rate(agreement.rate), agreement.kappa.toFixed(2),
        rate(agreement.judgePassed / agreement.pairs), rate(agreement.scriptPassed / agreement.pairs)]
        .map(value => `<td>${esc(String(value))}</td>`).join(''),
    ], 'Judge / script agreement')}`

  const calibrationBlock = calibration === null ? '' : `
    <h2>Judge calibration</h2>
    ${table(['Passed mean', 'Failed mean', 'Separation', 'Ranking accuracy', 'Brier'], [[
      rate(calibration.passedMean), rate(calibration.failedMean),
      calibration.separation === null ? '–' : `${calibration.separation >= 0 ? '+' : ''}${(calibration.separation * 100).toFixed(1)}pp`,
      rate(calibration.rankingAccuracy),
      calibration.brier === null ? '–' : calibration.brier.toFixed(3),
    ].map(value => `<td>${esc(value)}</td>`).join('')], 'Judge calibration')}
    ${calibration.disagreements.length === 0 ? '' : `<p class="note">Review: ${calibration.disagreements
      .map(item => `${esc(item.caseId)} #${item.trial} (script ${item.scriptPassed ? 'pass' : 'fail'}, score ${item.score ?? 'n/a'})`)
      .join(' · ')}</p>`}`

  const anomaliesBlock = anomalies.length === 0 ? '' : `<h2>Anomalies</h2>${table(
    ['Case', 'Trial', 'Metric', 'Value', 'Why'],
    anomalies.map(item => [
      `<td><code>${esc(item.caseId)}</code></td>`,
      `<td>${item.trial}</td>`,
      `<td>${esc(item.metric)}</td>`,
      `<td>${item.value}</td>`,
      `<td>${esc(item.why)}</td>`,
    ].join('')),
    'Anomalies',
  )}`
  const checkErrorBlock = checkErrors.length === 0 ? '' : `<h2>Configuration errors</h2>`
    + `<p class="note">WARNING: a scripted check command could not be started. Fix the benchmark check configuration (check / checkArgv / checkShell: executable present and valid working directory) and rerun; graded results are unreliable.</p>`
    + `<ul>${checkErrors.map(item => `<li><code>${esc(item.caseId)}</code>#${item.trial}: ${esc(item.error)}</li>`).join('')}</ul>`
  const judgeErrorBlock = judgeErrors.length === 0 ? '' : `<h2>Judge errors</h2>`
    + `<ul>${judgeErrors.slice(0, 10).map(item =>
      `<li><code>${esc(item.caseId)}</code>#${item.trial}: ${esc(item.error)}</li>`).join('')}</ul>`
    + (judgeErrors.length > 10 ? `<p class="note">+${judgeErrors.length - 10} more</p>` : '')
  const clusters = clusterFailures(run)
  const clusterBlock = clusters.length === 0 ? '' : `<h2>Failure clusters</h2>${table(
    ['Pattern', 'Label', 'Count', 'Cases'],
    clusters.map(cluster => [
      `<td><code>${esc(cluster.pattern)}</code></td>`,
      `<td>${esc(cluster.label)}</td>`,
      `<td>${cluster.count}</td>`,
      `<td>${clusterCases(cluster)}</td>`,
    ].join('')),
    'Failure clusters',
  )}`
  const segments = computeSegments(run)
  const segmentRows = segments.map(segment => [
    `<td>${esc(segment.tag)}</td>`,
    `<td>${segment.cases}</td>`,
    `<td>${segment.trials}</td>`,
    `<td>${rate(segment.taskSuccessRate)}</td>`,
    `<td>${segment.judgeScoreMean === null ? '–' : segment.judgeScoreMean.toFixed(1)}</td>`,
    `<td>${rate(segment.judgeScoreRate)}</td>`,
    `<td>${rate(segment.hallucinationRate)}</td>`,
    `<td>${rate(segment.toolSelectionAccuracyRate)}</td>`,
    `<td>${segment.costUsdMean === null ? '–' : `$${segment.costUsdMean.toFixed(6)}`}</td>`,
    `<td>${segment.latencyMsMean === null ? '–' : `${segment.latencyMsMean.toFixed(1)} ms`}</td>`,
  ].join(''))
  // Keep the untagged page byte-for-byte identical: the newline is part of the
  // block, not of the surrounding template.
  const segmentBlock = segmentRows.length === 0 ? ''
    : `\n<h2>Segments</h2>${table(['Tag', 'Cases', 'Trials', 'Task success', 'Judge score', 'Judge score %', 'Hallucination', 'Tool selection', 'Cost/trial', 'Latency/trial'], segmentRows, 'Segments')}`

  const trialRows = run.cases.map(result => [
    `<td><code>${esc(result.caseId)}</code></td>`,
    `<td>${result.trial}</td>`,
    `<td><span class="pill ${esc(result.status)}">${esc(result.status)}</span></td>`,
    `<td>${result.metrics?.steps ?? '–'}</td>`,
    `<td>${result.metrics?.totalTokens ?? '–'}</td>`,
    `<td>${result.metrics?.latencyMs.toFixed(0) ?? '–'}</td>`,
    `<td>${rate(result.grade?.taskSuccess === null || result.grade === undefined
      ? null : result.grade.taskSuccess ? 1 : 0)}</td>`,
    `<td>${rate(result.grade?.toolSelectionAccuracy === null || result.grade === undefined
      ? null : result.grade.toolSelectionAccuracy ? 1 : 0)}</td>`,
    `<td>${result.judge?.finalAnswerScore === null || result.judge === undefined
      ? '–' : result.judge.finalAnswerScore.toFixed(1)}</td>`,
    `<td class="detail">${esc(result.error ?? result.judge?.judgeError ?? '')}</td>`,
  ].join(''))

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(runs.map(item => `${item.benchmark} — ${item.model}`).join(' vs '))}</title>
<style>
${STYLE}</style>
</head>
<body><main>
<h1>${esc(run.benchmark)}</h1>
<p class="sub">${esc(run.model)} · ${new Date(run.createdAt).toISOString()} · ${judge === undefined ? 'no judge' : `judge ${esc(judge.model)}`}${run.benchmarkSha256 === undefined ? '' : ` · source ${esc(run.benchmarkSha256.slice(0, 12))}`}</p>
${runs.length === 2 ? renderComparison(runs[0]!, runs[1]!) : ''}
<section class="cards">${cards}</section>
<h2>Reliability</h2>
${table(['Dimension', 'pass@1', 'strict', 'pass@k', 'pass^k', 'Flaky', 'Unscored'], reliabilityRows, 'Reliability')}
${flaky}${hardest}
${precisionBlock}
${agreementBlock}
${calibrationBlock}${segmentBlock}
${anomaliesBlock}
${checkErrorBlock}
${judgeErrorBlock}
${clusterBlock}
<h2>Trials</h2>
${table(['Case', 'Trial', 'Status', 'Steps', 'Tokens', 'Latency', 'Task', 'Tool', 'Score', 'Detail'], trialRows, 'Trials')}
<footer>Generated by dsh-eval · run seed ${run.seed}</footer>
</main></body>
</html>
`
}
