/**
 * Run-report persistence and markdown rendering for dsh-eval.
 *
 * @module dsh-eval/report
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
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
    ...rateLine('tool selection accuracy', summary.toolSelection),
    ...(summary.latencyP50 === null || summary.latencyP95 === null
      ? []
      : [`- latency p50/p95: ${summary.latencyP50.toFixed(0)} / ${summary.latencyP95.toFixed(0)} ms`]),
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
  if (run.grading?.judgeFailures) lines.push(`- judge failures: ${run.grading.judgeFailures}`)
  return `${lines.join('\n')}\n`
}

/**
 * Render a run report as a markdown table: one row per trial plus the
 * aggregate row, followed by reliability and precision summaries.
 * @param run - the run record to render.
 * @returns the markdown text.
 */
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
  const hasPrecision = precision.task !== null || precision.toolSelection !== null
    || precision.latencyP50 !== null
  const coverageLine = coverage.unscored === 0
    ? `- trials: ${coverage.completed}/${coverage.total} completed`
    : `- trials: ${coverage.completed}/${coverage.total} completed · ${coverage.unscored} unscored (${coverage.timeouts} timeouts, ${coverage.errors} errors)`
  return [
    `# Eval: ${run.benchmark}`,
    '',
    `- model: ${run.model}`,
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
  ].join('\n')
}
