/**
 * Run-report persistence and markdown rendering for dsh-eval.
 *
 * @module dsh-eval/report
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { computeAgreement, type AgreementSummary } from './agreement.ts'
import { computeCalibration, type CalibrationSummary } from './calibration.ts'
import { computePrecision, type RateInterval, type RunPrecision } from './precision.ts'
import { computeCoverage, computeReliability, type ReliabilitySummary } from './reliability.ts'
import type { EvalRun } from './types.ts'

/**
 * Write a run report as indented JSON with a trailing newline.
 * @param run - the run record to persist.
 * @param path - output path; parent directories are created.
 */
export async function writeRunReport(run: EvalRun, path: string): Promise<void> {
  const absolute = resolve(path)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, `${JSON.stringify(run, null, 2)}\n`, 'utf8')
}

const pricingSchema = z.object({
  inputUsdPerMTokens: z.number(),
  cacheReadUsdPerMTokens: z.number(),
  cacheWriteUsdPerMTokens: z.number(),
  outputUsdPerMTokens: z.number(),
})

const tokenUsageSchema = z.object({
  inputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  outputTokens: z.number(),
})

const metricsSchema = z.object({
  turns: z.number(),
  steps: z.number(),
  toolCalls: z.number(),
  toolResults: z.number(),
  toolSuccess: z.number(),
  toolSuccessRate: z.number().nullable(),
  invalidToolCalls: z.number(),
  retries: z.number(),
  tokens: tokenUsageSchema,
  totalTokens: z.number(),
  contextTokens: z.number(),
  llmMs: z.number(),
  toolMs: z.number(),
  ttftMs: z.number(),
  latencyMs: z.number(),
  costUsd: z.number().nullable(),
})

const gradeSchema = z.object({
  taskSuccess: z.boolean().nullable(),
  toolSelectionAccuracy: z.boolean().nullable(),
})

const judgeVerdictSchema = z.object({
  finalAnswerScore: z.number().nullable(),
  hallucination: z.boolean().nullable(),
  rationale: z.string().optional(),
  judgeError: z.string().optional(),
})

const trialSchema = z.object({
  caseId: z.string(),
  trial: z.number(),
  status: z.enum(['completed', 'error']),
  error: z.string().optional(),
  tracePath: z.string().optional(),
  tracePaths: z.array(z.string()).optional(),
  traceSha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  exitCode: z.number().nullable(),
  timedOut: z.boolean(),
  metrics: metricsSchema.optional(),
  grade: gradeSchema.optional(),
  judge: judgeVerdictSchema.optional(),
})

const gradingSchema = z.object({
  taskSuccessRate: z.number().nullable(),
  toolSelectionAccuracyRate: z.number().nullable(),
  finalAnswerScore: z.number().nullable(),
  hallucinationRate: z.number().nullable(),
  judgeFailures: z.number().optional(),
})

const judgeConfigSchema = z.object({
  provider: z.string(),
  model: z.string(),
  rubric: z.string().optional(),
  maxScore: z.number(),
})

/** Keep in step with `EvalRun`: deep validation turns malformed input into a field-path diagnostic instead of a TypeError in the renderer. */
const runReportSchema = z.object({
  benchmark: z.string(),
  model: z.string(),
  createdAt: z.number(),
  trials: z.number(),
  seed: z.number(),
  pricing: pricingSchema.nullable(),
  judge: judgeConfigSchema.optional(),
  tempRoot: z.string(),
  cases: z.array(trialSchema),
  caseInputs: z.array(z.object({
    caseId: z.string(),
    prompt: z.string(),
    answer: z.string().optional(),
  })).optional(),
  aggregate: metricsSchema.nullable(),
  grading: gradingSchema.nullable(),
})

/**
 * Load a persisted run report, validating its full shape before use.
 * @param path - path to the run JSON.
 * @returns the loaded run record.
 * @throws with the offending field path when the document is malformed.
 */
export async function loadRunReport(path: string): Promise<EvalRun> {
  const value: unknown = JSON.parse(await readFile(resolve(path), 'utf8'))
  const parsed = runReportSchema.safeParse(value)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new Error(`${path} is not a dsh-eval run report: ${detail}`)
  }
  return parsed.data as EvalRun
}

/** Render a nullable percentage with a dash placeholder. */
function formatRate(value: number | null): string {
  return value === null ? '–' : `${(value * 100).toFixed(1)}%`
}

/** Render a nullable USD cost with a dash placeholder. */
function formatUsd(value: number | null): string {
  return value === null ? '–' : `$${value.toFixed(6)}`
}

/** Render a nullable grading boolean with a dash placeholder. */
function formatGrade(value: boolean | null): string {
  return value === null ? '–' : value ? 'yes' : 'no'
}

/** Render a nullable score as `value/max` with a dash placeholder. */
function formatScore(value: number | null, maxScore: number): string {
  return value === null ? '–' : `${value.toFixed(1)}/${maxScore}`
}

/** Render one reliability block; callers pass only a non-null summary. */
function renderReliability(summary: ReliabilitySummary): string[] {
  const label = summary.dimension === 'task' ? 'task success' : 'tool selection accuracy'
  const lines = [
    `## Reliability: ${label}`,
    '',
    `- cases: ${summary.cases} · trials/case: ${summary.k}`,
    `- pass@1: ${(summary.passAt1 * 100).toFixed(1)}% · pass@${summary.k}: ${(summary.passAtK * 100).toFixed(1)}% · pass^${summary.k}: ${(summary.passAllK * 100).toFixed(1)}%`,
    ...(summary.unscored === 0 ? [] : [
      `- strict pass@1: ${(summary.strictPassAt1 * 100).toFixed(1)}% over all ${summary.total} trials (${summary.unscored} unscored)`,
    ]),
    `- hardest cases: ${summary.hardest.map(item => `\`${item.caseId}\` ${item.passes}/${item.trials}`).join(' · ')}`,
  ]
  if (summary.flaky.length > 0) {
    lines.push(`- flaky cases (${summary.flaky.length}): ${summary.flaky.map(item => `\`${item.caseId}\` ${item.passes}/${item.trials}`).join(' · ')}`)
  }
  return [...lines, '']
}

/** Render the single-run precision block; callers pass only a populated summary. */
function renderPrecision(summary: RunPrecision): string[] {
  const rateLine = (label: string, interval: RateInterval | null): string[] => {
    if (interval === null) return []
    const uncertainty = interval.lower === null || interval.upper === null
      ? ''
      : ` [95% CI ${(interval.lower * 100).toFixed(1)}%, ${(interval.upper * 100).toFixed(1)}%]`
    return [`- ${label}: ${(interval.rate * 100).toFixed(1)}%${uncertainty} (n=${interval.trials})`]
  }
  return [
    '## Precision',
    '',
    ...rateLine('task success', summary.task),
    ...rateLine('strict pass@1 (all trials)', summary.strictPassAt1),
    ...rateLine('tool selection accuracy', summary.toolSelection),
    ...(summary.latencyP50 === null || summary.latencyP95 === null
      ? []
      : [`- latency p50/p95: ${summary.latencyP50.toFixed(0)} / ${summary.latencyP95.toFixed(0)} ms`]),
    '',
  ]
}

/** Render the judge/script agreement block; callers pass only a populated summary. */
function renderAgreement(summary: AgreementSummary): string[] {
  const judgeRate = summary.judgePassed / summary.pairs
  const scriptRate = summary.scriptPassed / summary.pairs
  return [
    '## Judge / script agreement',
    '',
    `- pairs: ${summary.pairs} trial(s) with both a scripted task result and a judge verdict`,
    `- observed agreement: ${(summary.rate * 100).toFixed(1)}% (${summary.agreements}/${summary.pairs})`,
    `- Cohen's kappa: ${summary.kappa.toFixed(2)}`,
    `- pass rates: judge no-hallucination ${(judgeRate * 100).toFixed(1)}% · script task success ${(scriptRate * 100).toFixed(1)}%`,
    '',
  ]
}

/**
 * Render a compact terminal summary of a run. Unlike the markdown report this
 * omits the per-trial table, so a hundred-trial run still fits on one screen.
 * @param run - the run record to summarize.
 * @returns a short markdown fragment ending in a newline.
 */
export function renderBriefReport(run: EvalRun): string {
  const coverage = computeCoverage(run)
  const aggregate = run.aggregate
  const reliability = computeReliability(run, 'task')
  const interval = computePrecision(run).task
  const agreement = computeAgreement(run)
  const lines = [
    `# ${run.benchmark} — ${run.model}`,
    `- trials: ${coverage.completed}/${coverage.total} completed${coverage.unscored === 0
      ? ''
      : ` · ${coverage.unscored} unscored (${coverage.timeouts} timeouts, ${coverage.errors} errors)`}`,
  ]
  if (aggregate !== null) {
    lines.push(
      `- tool success: ${formatRate(aggregate.toolSuccessRate)}`,
      `- steps / tokens / cost per trial: ${aggregate.steps.toFixed(1)} / ${aggregate.totalTokens.toFixed(0)} / ${aggregate.costUsd === null ? '–' : `$${aggregate.costUsd.toFixed(6)}`}`,
    )
  }
  if (reliability !== null) {
    lines.push(`- task success: ${(reliability.passAt1 * 100).toFixed(1)}% · pass@${reliability.k}: ${(reliability.passAtK * 100).toFixed(1)}% · pass^${reliability.k}: ${(reliability.passAllK * 100).toFixed(1)}%`)
  }
  if (interval !== null && interval.lower !== null && interval.upper !== null) {
    lines.push(`- task precision: ${(interval.rate * 100).toFixed(1)}% [95% CI ${(interval.lower * 100).toFixed(1)}%, ${(interval.upper * 100).toFixed(1)}%]`)
  }
  if (agreement !== null) {
    lines.push(`- judge/script agreement: ${(agreement.rate * 100).toFixed(1)}% (n=${agreement.pairs}) · kappa ${agreement.kappa.toFixed(2)}`)
  }
  const calibration = computeCalibration(run)
  if (calibration !== null && calibration.separation !== null) {
    // A non-null separation implies scores on both sides, so ranking is present too.
    lines.push(`- judge separation: ${calibration.separation >= 0 ? '+' : ''}${(calibration.separation * 100).toFixed(1)}pp · ranking ${(calibration.rankingAccuracy! * 100).toFixed(1)}%`)
  }
  if (run.grading?.judgeFailures) lines.push(`- judge failures: ${run.grading.judgeFailures}`)
  return `${lines.join('\n')}\n`
}

/**
 * Render a run report as a markdown table: one row per trial plus the
 * aggregate row, followed by reliability and precision summaries.
 * @param run - the run record to render.
 * @returns the markdown text.
 */
/** Render the judge calibration block; callers pass only a populated summary. */
function renderCalibration(summary: CalibrationSummary): string[] {
  const lines = [
    '## Judge calibration',
    '',
    `- pairs: ${summary.pairs} trial(s) with a scripted task result and a usable judge verdict`,
    `- mean normalized score: passed ${summary.passedMean === null ? 'n/a' : `${(summary.passedMean * 100).toFixed(1)}%`} · failed ${summary.failedMean === null ? 'n/a' : `${(summary.failedMean * 100).toFixed(1)}%`}`,
    `- separation (passed − failed): ${summary.separation === null ? 'n/a' : `${summary.separation >= 0 ? '+' : ''}${(summary.separation * 100).toFixed(1)}pp`}`,
    `- ranking accuracy: ${summary.rankingAccuracy === null ? 'n/a' : `${(summary.rankingAccuracy * 100).toFixed(1)}% (ties count as half)`}`,
  ]
  if (summary.disagreements.length > 0) {
    lines.push('- disagreements to review:',
      ...summary.disagreements.map(item => `  - ${item.caseId} trial ${item.trial}: script ${item.scriptPassed ? 'pass' : 'fail'} · judge score ${item.score ?? 'n/a'}${item.hallucination === true ? ' · hallucination' : ''}`))
  }
  lines.push('')
  return lines
}

/**
 * Render a run as machine-readable JSON, including every derived block shown
 * in the markdown report. Raw trial results are kept so consumers can drill
 * into a single case without parsing another file.
 * @param run - the run record.
 * @returns a JSON string ending in a newline.
 */
export function renderReportJson(run: EvalRun): string {
  return `${JSON.stringify({
    benchmark: run.benchmark,
    model: run.model,
    createdAt: run.createdAt,
    trials: run.trials,
    seed: run.seed,
    tempRoot: run.tempRoot,
    judge: run.judge ?? null,
    pricing: run.pricing ?? null,
    grading: run.grading ?? null,
    aggregate: run.aggregate ?? null,
    caseInputs: run.caseInputs ?? [],
    coverage: computeCoverage(run),
    reliability: {
      task: computeReliability(run, 'task'),
      toolSelection: computeReliability(run, 'tool-selection'),
    },
    precision: computePrecision(run),
    agreement: computeAgreement(run),
    calibration: computeCalibration(run),
    cases: run.cases,
  })}\n`
}

export function renderMarkdownReport(run: EvalRun): string {
  const judge = run.judge
  const judged = judge !== undefined
  const header = judged
    ? [
      '| case | trial | status | steps | tools | success | invalid | retries | tokens | cost | latency ms | task | tool-acc | score | halluc |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ]
    : [
      '| case | trial | status | steps | tools | success | invalid | retries | tokens | cost | latency ms | task | tool-acc |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ]
  const rows = run.cases.map((result) => {
    const metrics = result.metrics
    const base = metrics === undefined
      ? ['–', '–', '–', '–', '–', '–', '–', '–', '–', '–']
      : [
        String(metrics.steps),
        String(metrics.toolCalls),
        formatRate(metrics.toolSuccessRate),
        String(metrics.invalidToolCalls),
        String(metrics.retries),
        String(metrics.totalTokens),
        formatUsd(metrics.costUsd),
        String(metrics.latencyMs),
        formatGrade(result.grade?.taskSuccess ?? null),
        formatGrade(result.grade?.toolSelectionAccuracy ?? null),
      ]
    const judgeCells = judged
      ? [
        formatScore(result.judge?.finalAnswerScore ?? null, judge.maxScore),
        formatGrade(result.judge?.hallucination ?? null),
      ]
      : []
    return `| ${result.caseId} | ${result.trial} | ${result.status} | ${[...base, ...judgeCells].join(' | ')} |`
  })
  const aggregate = run.aggregate
  const aggregateJudgeCells = judged
    ? [
      formatScore(run.grading?.finalAnswerScore ?? null, judge.maxScore),
      formatRate(run.grading?.hallucinationRate ?? null),
    ]
    : []
  const aggregateCells = aggregate === null
    ? ['no completed trials', '–', '–', '–', '–', '–', '–', '–', '–', '–', '–']
    : [
      'completed',
      aggregate.steps.toFixed(1),
      aggregate.toolCalls.toFixed(1),
      formatRate(aggregate.toolSuccessRate),
      aggregate.invalidToolCalls.toFixed(1),
      aggregate.retries.toFixed(1),
      aggregate.totalTokens.toFixed(1),
      formatUsd(aggregate.costUsd),
      aggregate.latencyMs.toFixed(1),
      formatRate(run.grading?.taskSuccessRate ?? null),
      formatRate(run.grading?.toolSelectionAccuracyRate ?? null),
    ]
  const aggregateRow = `| aggregate | – | ${[...aggregateCells, ...aggregateJudgeCells].join(' | ')} |`
  const taskReliability = computeReliability(run, 'task')
  const toolReliability = computeReliability(run, 'tool-selection')
  const coverage = computeCoverage(run)
  const precision = computePrecision(run)
  const agreement = computeAgreement(run)
  const calibration = computeCalibration(run)
  const hasPrecision = precision.task !== null || precision.toolSelection !== null
    || precision.strictPassAt1 !== null || precision.latencyP50 !== null
  const coverageLine = coverage.unscored === 0
    ? `- trials: ${coverage.completed}/${coverage.total} completed`
    : `- trials: ${coverage.completed}/${coverage.total} completed · ${coverage.unscored} unscored (${coverage.timeouts} timeouts, ${coverage.errors} errors)`
  return [
    `# Eval: ${run.benchmark}`,
    '',
    `- model: ${run.model}`,
    ...(run.benchmarkSha256 === undefined ? [] : [`- benchmark sha256: ${run.benchmarkSha256}`]),
    ...(judged ? [`- judge: ${judge.model}`] : []),
    ...(run.grading?.judgeFailures ? [`- judge failures: ${run.grading.judgeFailures}`] : []),
    `- trials per case: ${run.trials}`,
    `- created: ${new Date(run.createdAt).toISOString()}`,
    `- traces: ${run.tempRoot}`,
    coverageLine,
    '',
    ...header,
    ...rows,
    aggregateRow,
    '',
    ...(taskReliability === null ? [] : renderReliability(taskReliability)),
    ...(toolReliability === null ? [] : renderReliability(toolReliability)),
    ...(hasPrecision ? renderPrecision(precision) : []),
    ...(agreement === null ? [] : renderAgreement(agreement)),
    ...(calibration === null ? [] : renderCalibration(calibration)),
  ].join('\n')
}
