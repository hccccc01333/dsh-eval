/**
 * Judge / script agreement for dsh-eval.
 *
 * A scripted check and an LLM judge are two independent views of the same
 * trial. Observed agreement alone is misleading when one view almost always
 * passes, so we also report Cohen's kappa, which subtracts the agreement
 * expected from the two marginals. The judge signal used here is
 * "no hallucination flagged", paired with scripted `taskSuccess`.
 *
 * @module dsh-eval/agreement
 */

import type { EvalRun } from './types.ts'

/** Agreement statistics over trials carrying both signals. */
export interface AgreementSummary {
  /** Number of trials with a boolean scripted result and a boolean judge verdict. */
  pairs: number
  /** Number of trials where the two signals matched. */
  agreements: number
  /** Observed agreement, agreements / pairs. */
  rate: number
  /** Cohen's kappa: agreement beyond chance; can be negative. */
  kappa: number
  /** Trials where the judge flagged no hallucination. */
  judgePassed: number
  /** Trials where the scripted task check passed. */
  scriptPassed: number
}

/**
 * Compute judge/script agreement for a run.
 * @param run - a persisted run record.
 * @returns the summary, or null when no trial carries both signals.
 */
export function computeAgreement(run: EvalRun): AgreementSummary | null {
  let pairs = 0
  let agreements = 0
  let judgePassed = 0
  let scriptPassed = 0
  for (const result of run.cases) {
    const script = result.grade?.taskSuccess
    const judge = result.judge?.hallucination
    if (script === undefined || script === null || judge === undefined || judge === null) continue
    pairs += 1
    const judgePass = !judge
    if (judgePass) judgePassed += 1
    if (script) scriptPassed += 1
    if (judgePass === script) agreements += 1
  }
  if (pairs === 0) return null
  const rate = agreements / pairs
  const judgeRate = judgePassed / pairs
  const scriptRate = scriptPassed / pairs
  const chance = judgeRate * scriptRate + (1 - judgeRate) * (1 - scriptRate)
  // A degenerate marginal (everyone passes) leaves kappa undefined at 0/0;
  // in that case perfect observed agreement is the only sensible answer.
  const kappa = 1 - chance < Number.EPSILON ? rate : (rate - chance) / (1 - chance)
  return { pairs, agreements, rate, kappa, judgePassed, scriptPassed }
}
