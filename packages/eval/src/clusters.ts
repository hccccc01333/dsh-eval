/**
 * Failure clustering for a completed run.
 *
 * A long list of failing trials is hard to read: the same timeout or path typo
 * repeated across cases looks like many unrelated problems. This module groups
 * failures by their primary cause so a report can say "12 trials hit the same
 * check configuration error" instead of listing twelve identical rows.
 *
 * Each trial is assigned exactly one primary cause, in a fixed priority order,
 * so counts always add up to the number of failing trials. Cluster labels are
 * single-line and control-character free; renderers still escape them.
 *
 * @module dsh-eval/clusters
 */

import type { EvalRun, EvalTrialResult } from './types.ts'

/** Reference to one failing case x trial. */
export interface FailureCaseRef {
  caseId: string
  trial: number
}

/** A group of trials sharing one primary failure cause. */
export interface FailureCluster {
  /** Stable machine-readable cause id. */
  pattern: string
  /** Single-line human-readable label. */
  label: string
  count: number
  cases: FailureCaseRef[]
}

type Cause = { pattern: string; label: string }

/** Collapse control characters and runs of whitespace; cap the length. */
function oneLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 100)
}

/** Classify one trial by its primary cause, or null when it did not fail. */
function causeOf(result: EvalTrialResult): Cause | null {
  if (result.status === 'error') {
    const detail = oneLine(result.error ?? 'unknown error')
    return { pattern: 'trial-error', label: `Trial error: ${detail}` }
  }
  if (result.timedOut) return { pattern: 'timeout', label: 'Trial timed out' }
  if (result.grade?.checkError !== undefined) {
    return { pattern: 'check-config', label: 'Check command could not start (configuration error)' }
  }
  if (result.exitCode !== null && result.exitCode !== 0) {
    return { pattern: 'nonzero-exit', label: `Process exited with code ${result.exitCode}` }
  }
  if (result.judge?.hallucination === true) {
    return { pattern: 'hallucination', label: 'Judge flagged hallucination' }
  }
  if (result.grade?.taskSuccess === false) {
    return { pattern: 'task-check', label: 'Task check or answer regex did not pass' }
  }
  // A scripted pass can still be unusable when the judge call failed; keep the
  // scripted verdict primary when both happened.
  if (result.judge?.judgeError !== undefined) {
    return { pattern: 'judge-error', label: `Judge call failed: ${oneLine(result.judge.judgeError)}` }
  }
  return null
}

/**
 * Group a run's failing trials by primary cause.
 * @param run - a persisted run report.
 * @returns clusters sorted by descending count, then by pattern id, then label.
 */
export function clusterFailures(run: EvalRun): FailureCluster[] {
  const groups = new Map<string, FailureCluster>()
  for (const result of run.cases) {
    const cause = causeOf(result)
    if (cause === null) continue
    const key = `${cause.pattern}\u0000${cause.label}`
    let cluster = groups.get(key)
    if (cluster === undefined) {
      cluster = { pattern: cause.pattern, label: cause.label, count: 0, cases: [] }
      groups.set(key, cluster)
    }
    cluster.count += 1
    cluster.cases.push({ caseId: result.caseId, trial: result.trial })
  }
  // Code-unit comparison, not localeCompare: identical runs must sort
  // identically on every machine and locale.
  const byText = (left: string, right: string): number =>
    Number(left > right) - Number(left < right)
  return [...groups.values()].sort((a, b) =>
    b.count - a.count || byText(a.pattern, b.pattern) || byText(a.label, b.label))
}
