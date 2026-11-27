/**
 * Flat trial-level CSV export for dsh-eval runs.
 *
 * Reports are the source of truth for aggregate analysis, but spreadsheet and
 * notebook workflows usually want one row per trial. This module derives that
 * view without changing the persisted JSON, and escapes every agent-controlled
 * string so a case id or error message cannot inject a spreadsheet formula.
 *
 * @module dsh-eval/export
 */

import { computeAnomalies } from './anomalies.ts'
import { clusterFailures } from './clusters.ts'
import type { EvalRun, EvalTrialResult } from './types.ts'

/** Column order of the exported CSV. */
const COLUMNS = [
  'caseId', 'trial', 'status', 'exitCode', 'timedOut', 'error',
  'taskSuccess', 'toolSelectionAccuracy', 'judgeScore', 'hallucination',
  'judgeError', 'steps', 'toolCalls', 'toolSuccess', 'invalidToolCalls', 'retries',
  'inputTokens', 'outputTokens', 'totalTokens', 'costUsd', 'latencyMs',
  'llmMs', 'toolMs', 'ttftMs', 'traceSha256', 'tags', 'anomalies', 'failureCluster',
  // Appended rather than inserted so positional consumers keep their indices.
  'turns', 'toolSuccessRate', 'cacheReadTokens', 'contextTokens',
] as const

type CellValue = string | number | boolean | null | undefined

/** Render one CSV cell, guarding string cells against spreadsheet formulas. */
function cell(value: CellValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value !== 'string') return String(value)
  const safe = /^[=+\-@\t\r\n ]/u.test(value) ? `'${value}` : value
  return /[",\r\n]/u.test(safe) ? `"${safe.replace(/"/gu, '""')}"` : safe
}

/** Convert one trial into a flat row aligned with {@link COLUMNS}. */
function row(
  result: EvalTrialResult,
  anomalies: readonly string[] | undefined,
  failureCluster: string | undefined,
): CellValue[] {
  const metrics = result.metrics
  return [
    result.caseId, result.trial, result.status, result.exitCode, result.timedOut,
    result.error, result.grade?.taskSuccess, result.grade?.toolSelectionAccuracy,
    result.judge?.finalAnswerScore ?? null, result.judge?.hallucination ?? null,
    result.judge?.judgeError, metrics?.steps, metrics?.toolCalls, metrics?.toolSuccess,
    metrics?.invalidToolCalls, metrics?.retries, metrics?.tokens.inputTokens,
    metrics?.tokens.outputTokens, metrics?.totalTokens, metrics?.costUsd,
    metrics?.latencyMs, metrics?.llmMs, metrics?.toolMs, metrics?.ttftMs,
    result.traceSha256,
    // JSON arrays keep comma-bearing values unambiguous and round-trippable.
    result.tags === undefined ? null : JSON.stringify(result.tags),
    anomalies === undefined ? null : JSON.stringify(anomalies),
    failureCluster ?? null,
    metrics?.turns, metrics?.toolSuccessRate,
    metrics?.tokens.cacheReadTokens, metrics?.contextTokens,
  ]
}

/** Stable map key for one case x trial. */
function trialKey(caseId: string, trial: number): string {
  return `${caseId}\u0000${trial}`
}

/**
 * Render a persisted run as trial-level CSV.
 * @param run - a validated run report.
 * @returns CSV text ending in a newline, with a header row even for empty runs.
 */
export function renderTrialsCsv(run: EvalRun): string {
  const anomalyMap = new Map<string, string[]>()
  for (const item of computeAnomalies(run)) {
    const key = trialKey(item.caseId, item.trial)
    const detail = `${item.metric}: ${item.why}`
    const existing = anomalyMap.get(key)
    if (existing === undefined) anomalyMap.set(key, [detail])
    else existing.push(detail)
  }
  const clusterMap = new Map<string, string>()
  // Each failing trial has exactly one primary cause, so a key appears once.
  for (const cluster of clusterFailures(run)) {
    for (const ref of cluster.cases) {
      clusterMap.set(trialKey(ref.caseId, ref.trial), cluster.pattern)
    }
  }
  const lines = [COLUMNS.join(','), ...run.cases.map(result => {
    const key = trialKey(result.caseId, result.trial)
    return row(result, anomalyMap.get(key), clusterMap.get(key)).map(cell).join(',')
  })]
  return `${lines.join('\r\n')}\r\n`
}
