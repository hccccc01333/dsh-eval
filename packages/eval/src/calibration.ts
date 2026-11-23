/**
 * Judge calibration diagnostics for dsh-eval.
 *
 * Agreement and kappa say whether the judge and the scripted check reach the
 * same verdict, but a judge can be perfectly calibrated on an all-pass run and
 * still useless for ranking. This module also measures how well the judge's
 * numeric score separates scripted passes from failures, and surfaces the
 * concrete cases where the two views disagree so a rubric can be improved.
 * A normalized score >= 0.5 counts as a judge pass; the hallucination flag is
 * only a fallback for trials whose score is missing, so the disagreement list
 * can explain the score-based separation and ranking figures.
 *
 * @module dsh-eval/calibration
 */

import type { EvalRun } from './types.ts'

/** A case x trial where the judge and the scripted check disagree. */
export interface CalibrationDisagreement {
  caseId: string
  trial: number
  scriptPassed: boolean
  score: number | null
  hallucination: boolean | null
}

/** Calibration statistics over trials carrying both signals. */
export interface CalibrationSummary {
  pairs: number
  /** Mean normalized judge score on scripted passes, or null when none. */
  passedMean: number | null
  /** Mean normalized judge score on scripted failures, or null when none. */
  failedMean: number | null
  /** passedMean - failedMean; positive means the judge ranks passes higher. */
  separation: number | null
  /** P(random pass scores above random fail), ties count as half. Null when one side is empty. */
  rankingAccuracy: number | null
  /** Mean squared error of normalized score against the scripted verdict; lower is better. */
  brier: number | null
  /** Up to five disagreements, ordered by case id and trial. */
  disagreements: readonly CalibrationDisagreement[]
}

/** Normalize a judge score to 0..1 using its run's maxScore when available. */
function normalizedScore(score: number | null | undefined, maxScore: number | undefined): number | null {
  if (score === null || score === undefined || !Number.isFinite(score)) return null
  if (maxScore === undefined || maxScore <= 0) return null
  return Math.max(0, Math.min(1, score / maxScore))
}

/**
 * Compute judge calibration for a run.
 * @param run - a persisted run record.
 * @returns the summary, or null when no trial has both a scripted result and a usable judge verdict.
 */
export function computeCalibration(run: EvalRun): CalibrationSummary | null {
  const maxScore = run.judge?.maxScore
  const passed: number[] = []
  const failed: number[] = []
  const disagreements: CalibrationDisagreement[] = []
  let withBoth = 0
  let brierSum = 0
  let brierCount = 0
  for (const result of run.cases) {
    const script = result.grade?.taskSuccess
    const judge = result.judge
    if (script === undefined || script === null || judge === undefined) continue
    const score = normalizedScore(judge.finalAnswerScore, maxScore)
    const hallucination = judge.hallucination ?? null
    // A verdict with neither signal is ungraded, not evidence of agreement.
    if (score === null && hallucination === null) continue
    withBoth += 1
    if (score !== null) {
      if (script) passed.push(score)
      else failed.push(score)
      const error = score - (script ? 1 : 0)
      brierSum += error * error
      brierCount += 1
    }
    // The score drives calibration; the hallucination flag is a fallback.
    const judgePass = score !== null ? score >= 0.5 : !hallucination
    if (judgePass !== script) {
      disagreements.push({
        caseId: result.caseId, trial: result.trial, scriptPassed: script,
        score: judge.finalAnswerScore ?? null, hallucination,
      })
    }
  }
  disagreements.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.trial - b.trial)
  disagreements.length = Math.min(disagreements.length, 5)
  if (withBoth === 0) return null
  const mean = (values: readonly number[]): number | null =>
    values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
  const passedMean = mean(passed)
  const failedMean = mean(failed)
  let rankingAccuracy: number | null = null
  if (passed.length > 0 && failed.length > 0) {
    let wins = 0
    for (const high of passed) {
      for (const low of failed) wins += high > low ? 1 : high === low ? 0.5 : 0
    }
    rankingAccuracy = wins / (passed.length * failed.length)
  }
  return {
    pairs: withBoth,
    passedMean,
    failedMean,
    separation: passedMean === null || failedMean === null ? null : passedMean - failedMean,
    rankingAccuracy,
    brier: brierCount === 0 ? null : brierSum / brierCount,
    disagreements,
  }
}
