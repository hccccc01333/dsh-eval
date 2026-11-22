import { describe, expect, it } from 'vitest'
import { computeAgreement } from '../src/agreement.ts'
import type { EvalRun } from '../src/types.ts'

/** Build a run from [script taskSuccess, judge hallucination] pairs. */
function makeRun(rows: readonly (readonly [boolean | null, boolean | null])[]): EvalRun {
  return {
    benchmark: 'b', model: 'm', createdAt: 1, trials: 1, seed: 0, pricing: null,
    tempRoot: '/tmp',
    cases: rows.map(([task, hallucination], index) => ({
      caseId: `c${index}`, trial: 1, status: 'completed', exitCode: 0, timedOut: false,
      ...(task === null ? {} : { grade: { taskSuccess: task, toolSelectionAccuracy: null } }),
      ...(hallucination === null
        ? {}
        : { judge: { finalAnswerScore: 0, hallucination } }),
    })),
    aggregate: null,
    grading: null,
  }
}

describe('dsh-eval judge/script agreement', () => {
  it('returns null when no trial carries both signals', () => {
    expect(computeAgreement(makeRun([[true, null], [null, false]]))).toBeNull()
  })

  it('reports perfect agreement and its degenerate kappa', () => {
    expect(computeAgreement(makeRun([[true, false], [true, false]]))).toEqual({
      pairs: 2, agreements: 2, rate: 1, kappa: 1, judgePassed: 2, scriptPassed: 2,
    })
    expect(computeAgreement(makeRun([[false, true], [false, true]]))?.kappa).toBe(1)
  })

  it('reports negative kappa for systematic disagreement', () => {
    const summary = computeAgreement(makeRun([[true, true], [false, false]]))
    expect(summary).toMatchObject({ pairs: 2, agreements: 0, rate: 0, kappa: -1 })
  })

  it('subtracts chance agreement from a mixed table', () => {
    const summary = computeAgreement(makeRun([
      [true, false], [true, true], [false, false], [false, true],
    ]))
    expect(summary).toEqual({
      pairs: 4, agreements: 2, rate: 0.5, kappa: 0, judgePassed: 2, scriptPassed: 2,
    })
  })
})
