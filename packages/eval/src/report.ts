/**
 * Run-report persistence and markdown rendering for dsh-eval.
 *
 * @module dsh-eval/report
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
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

/**
 * Load a persisted run report, rejecting anything without the required surface.
 * @param path - path to the run JSON.
 * @returns the loaded run record.
 */
export async function loadRunReport(path: string): Promise<EvalRun> {
  const value: unknown = JSON.parse(await readFile(resolve(path), 'utf8'))
  if (typeof value !== 'object' || value === null
    || !Array.isArray((value as { cases?: unknown }).cases)) {
    throw new Error(`${path} is not a dsh-eval run report`)
  }
  return value as EvalRun
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

/**
 * Render a run report as a markdown table: one row per trial plus the
 * aggregate row.
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
  return [
    `# Eval: ${run.benchmark}`,
    '',
    `- model: ${run.model}`,
    ...(judged ? [`- judge: ${judge.model}`] : []),
    `- trials per case: ${run.trials}`,
    `- created: ${new Date(run.createdAt).toISOString()}`,
    `- traces: ${run.tempRoot}`,
    '',
    ...header,
    ...rows,
    aggregateRow,
    '',
  ].join('\n')
}
