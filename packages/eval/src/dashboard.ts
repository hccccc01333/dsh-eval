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

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { computeAgreement } from './agreement.ts'
import { computeCalibration } from './calibration.ts'
import { compareRuns, formatCaseValue, formatPValue, pairedCases, pairedCaseSignificance } from './compare.ts'
import { buildLeaderboard, formatLeaderboardSignificance, type LeaderboardMetric } from './leaderboard.ts'
import type { RateInterval } from './precision.ts'
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
  const absolute = resolve(path)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, renderDashboard(runs, metric), 'utf8')
}

/** Escape text for interpolation into HTML. */
function esc(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!)
}

/** Format a rate, or a dash when the metric is ungraded. */
function rate(value: number | null): string {
  return value === null ? '–' : `${(value * 100).toFixed(1)}%`
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

/** Render a table from a header and already-escaped row fragments. */
function table(headers: readonly string[], rows: readonly string[]): string {
  return [
    '<table><thead><tr>',
    ...headers.map(header => `<th>${esc(header)}</th>`),
    '</tr></thead><tbody>',
    ...rows.map(row => `<tr>${row}</tr>`),
    '</tbody></table>',
  ].join('')
}

/** Render the two-run comparison table from the same rows the markdown report uses. */
function renderComparison(a: EvalRun, b: EvalRun): string {
  const compared = compareRuns(a, b)
  const rows = compared.filter(row => row.inference === undefined)
    .map(row => [row.metric, row.a, row.b, row.delta]
      .map(value => `<td>${esc(value)}</td>`).join(''))
  const inferenceRows = compared.filter(row => row.inference !== undefined)
    .map(row => `<td>${esc(row.metric)}</td><td>${esc(row.inference!)}</td>`)
  const cases = pairedCases(a, b) ?? []
  const discordant = cases.filter(item => item.outcome !== 'tie').slice(0, 10)
  const caseRows = discordant.map(item => [item.caseId, String(item.trial),
    formatCaseValue(item.a), formatCaseValue(item.b), item.outcome]
    .map(value => `<td>${esc(value)}</td>`).join(''))
  const caseBlock = discordant.length === 0 ? '' : `<h2>Changed cases</h2>${table(
    ['Case', 'Trial', 'A', 'B', 'Result'], caseRows,
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
  const significanceBlock = confirmed.length === 0 ? '' : `<h2>Confirmed case changes</h2>`
    + `<p class="sub">${significance.length} cases · Bonferroni family = ${significance.length} · ${confirmed.length} confirmed</p>`
    + truncation
    + table(['Case', 'Pairs', 'B wins', 'A wins', 'Adjusted p', 'Result'], significanceRows)
  return `<h2>Run comparison</h2>${table(['Metric', 'A', 'B', 'B − A'], rows)}`
    + (inferenceRows.length === 0 ? '' : `<h2>Paired inference</h2>${table(['Test', 'Result'], inferenceRows)}`)
    + caseBlock + significanceBlock
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
    rate(entry.judgeScore), cost(entry.costUsd),
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
${table(['Rank', 'Run', 'Completed', 'Task', 'Strict pass@1', 'Tool', 'Judge', 'Cost/trial', 'Latency/trial', 'Δ best', 'vs leader'], rows)}
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
    : `<h2>Precision</h2>${table(['Metric', 'Bootstrap interval'], precisionRows)}`

  const agreementBlock = agreement === null ? '' : `
    <h2>Judge / script agreement</h2>
    ${table(['Pairs', 'Observed', "Cohen's kappa", 'Judge pass', 'Script pass'], [
      [agreement.pairs, rate(agreement.rate), agreement.kappa.toFixed(2),
        rate(agreement.judgePassed / agreement.pairs), rate(agreement.scriptPassed / agreement.pairs)]
        .map(value => `<td>${esc(String(value))}</td>`).join(''),
    ])}`

  const calibrationBlock = calibration === null ? '' : `
    <h2>Judge calibration</h2>
    ${table(['Passed mean', 'Failed mean', 'Separation', 'Ranking accuracy'], [[
      rate(calibration.passedMean), rate(calibration.failedMean),
      calibration.separation === null ? '–' : `${calibration.separation >= 0 ? '+' : ''}${(calibration.separation * 100).toFixed(1)}pp`,
      rate(calibration.rankingAccuracy),
    ].map(value => `<td>${esc(value)}</td>`).join('')])}
    ${calibration.disagreements.length === 0 ? '' : `<p class="note">Review: ${calibration.disagreements
      .map(item => `${esc(item.caseId)} #${item.trial} (script ${item.scriptPassed ? 'pass' : 'fail'}, score ${item.score ?? 'n/a'})`)
      .join(' · ')}</p>`}`

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
${table(['Dimension', 'pass@1', 'strict', 'pass@k', 'pass^k', 'Flaky', 'Unscored'], reliabilityRows)}
${flaky}${hardest}
${precisionBlock}
${agreementBlock}
${calibrationBlock}
<h2>Trials</h2>
${table(['Case', 'Trial', 'Status', 'Steps', 'Tokens', 'Latency', 'Task', 'Tool', 'Score', 'Detail'], trialRows)}
<footer>Generated by dsh-eval · run seed ${run.seed}</footer>
</main></body>
</html>
`
}
