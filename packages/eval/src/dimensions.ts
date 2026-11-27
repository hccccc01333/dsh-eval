/**
 * Dimension-based (tag) aggregation for a run.
 *
 * A benchmark can tag cases — `language:ts`, `difficulty:hard`, `tool:bash` —
 * and every trial carries the tags of its case. This module answers "how did
 * we do on the hard cases?" without re-running anything: it reads only the
 * persisted run, so it works offline on old reports taken after the data was
 * recorded. Trials without tags are ignored; a trial with several tags
 * contributes to each of them.
 *
 * @module dsh-eval/dimensions
 */

import type { EvalRun, EvalTrialResult } from './types.ts'

/** Pooled outcome for one dimension value. */
export interface SegmentStat {
  tag: string
  /** Distinct cases carrying the tag. */
  cases: number
  /** Trials carrying the tag (including repeats of the same case). */
  trials: number
  /** Task-success rate over trials with a scripted verdict; null when ungraded. */
  taskSuccessRate: number | null
  /** Mean judge score over scored trials; null when unjudged. */
  judgeScoreMean: number | null
  /** Hallucination rate over trials with a judge verdict; null when unjudged. */
  hallucinationRate: number | null
}

function rate(flags: readonly boolean[]): number | null {
  if (flags.length === 0) return null
  return flags.filter(Boolean).length / flags.length
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function tagged(result: EvalTrialResult, tag: string): boolean {
  return result.tags?.includes(tag) ?? false
}

/**
 * Aggregate a run by case tags.
 * @param run - a persisted run report; older reports without tags yield [].
 * @returns one stat per tag, sorted by tag in code-unit order.
 */
export function computeSegments(run: EvalRun): SegmentStat[] {
  const tags = new Set<string>()
  for (const result of run.cases) {
    for (const tag of result.tags ?? []) tags.add(tag)
  }
  const stats: SegmentStat[] = []
  for (const tag of tags) {
    const members = run.cases.filter(result => tagged(result, tag))
    const success: boolean[] = []
    const scores: number[] = []
    const hallucinations: boolean[] = []
    for (const result of members) {
      const taskSuccess = result.grade?.taskSuccess
      if (taskSuccess !== null && taskSuccess !== undefined) success.push(taskSuccess)
      const score = result.judge?.finalAnswerScore
      if (score !== null && score !== undefined) scores.push(score)
      const hallucination = result.judge?.hallucination
      if (hallucination !== null && hallucination !== undefined) hallucinations.push(hallucination)
    }
    stats.push({
      tag,
      cases: new Set(members.map(result => result.caseId)).size,
      trials: members.length,
      taskSuccessRate: rate(success),
      judgeScoreMean: mean(scores),
      hallucinationRate: rate(hallucinations),
    })
  }
  return stats.sort((a, b) => Number(a.tag > b.tag) - Number(a.tag < b.tag))
}
