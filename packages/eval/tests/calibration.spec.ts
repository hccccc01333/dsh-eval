import { describe, expect, it } from 'vitest'
import { computeCalibration } from '../src/calibration.ts'
import type { EvalRun } from '../src/types.ts'

function trial(
  caseId: string,
  script: boolean | null,
  score: number | null,
  hallucination: boolean | null = false,
): EvalRun['cases'][number] {
  return {
    caseId, trial: 1, status: 'completed', exitCode: 0, timedOut: false,
    ...(script === null ? {} : { grade: { taskSuccess: script, toolSelectionAccuracy: null } }),
    ...(score === null && hallucination === null
      ? {}
      : { judge: { finalAnswerScore: score, hallucination } }),
  }
}

function run(cases: EvalRun['cases'], judge?: EvalRun['judge']): EvalRun {
  return {
    benchmark: 'b', model: 'm', createdAt: 1, trials: 1, seed: 0, pricing: null,
    tempRoot: '/tmp', cases: [...cases], aggregate: null, grading: null,
    ...(judge === undefined ? {} : { judge }),
  }
}

const JUDGE = { provider: 'p', model: 'j', maxScore: 10 }

describe('dsh-eval judge calibration', () => {
  it('measures score separation, ranking and disagreements', () => {
    const result = computeCalibration(run([
      trial('good', true, 9),
      trial('bad', false, 2),
      trial('wrong-penalized', true, 3),
    ], JUDGE))
    expect(result).toMatchObject({ pairs: 3, passedMean: 0.6, failedMean: 0.2 })
    expect(result!.separation).toBeCloseTo(0.4)
    // 2 passes x 1 fail, both pairs rank correctly.
    expect(result!.rankingAccuracy).toBe(1)
    expect(result!.disagreements).toEqual([{
      caseId: 'wrong-penalized', trial: 1, scriptPassed: true, score: 3, hallucination: false,
    }])
  })

  it('counts ties as half and reverses when the judge ranks failures higher', () => {
    const result = computeCalibration(run([
      trial('pass', true, 5), trial('fail', false, 8),
    ], JUDGE))!
    expect(result.rankingAccuracy).toBe(0)
    expect(result.separation).toBeLessThan(0)
    const tied = computeCalibration(run([
      trial('pass', true, 5), trial('fail', false, 5),
    ], JUDGE))!
    expect(tied.rankingAccuracy).toBe(0.5)
  })

  it('falls back to the score midpoint when hallucination is unknown', () => {
    const result = computeCalibration(run([
      trial('above', true, 8, null), trial('below', false, 3, null),
    ], JUDGE))!
    expect(result.disagreements).toEqual([])
    const flagged = computeCalibration(run([
      trial('flagged', true, null, true),
    ], JUDGE))!
    expect(flagged.disagreements[0]).toMatchObject({ caseId: 'flagged', hallucination: true })
  })

  it('returns null without paired signals and handles one-sided or unscored runs', () => {
    expect(computeCalibration(run([trial('none', null, null)], JUDGE))).toBeNull()
    const onlyPassed = computeCalibration(run([trial('pass', true, 8)], JUDGE))!
    expect(onlyPassed.failedMean).toBeNull()
    expect(onlyPassed.separation).toBeNull()
    expect(onlyPassed.rankingAccuracy).toBeNull()
    const noMax = computeCalibration(run([trial('pass', true, 8)], {
      provider: 'p', model: 'j', maxScore: 0,
    }))!
    expect(noMax.passedMean).toBeNull()
    expect(noMax.pairs).toBe(1)
  })

  it('keeps non-finite and missing scores as n/a rather than skewing means', () => {
    const result = computeCalibration(run([
      trial('infinite', true, Number.POSITIVE_INFINITY),
      trial('missing', true, null, true),
      {
        caseId: 'empty-verdict', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
        grade: { taskSuccess: true, toolSelectionAccuracy: null },
        judge: { finalAnswerScore: null, hallucination: null },
      },
    ], JUDGE))!
    expect(result.passedMean).toBeNull()
    expect(result.disagreements[0]).toMatchObject({ score: null, hallucination: true })
  })

  it('orders equal case ids by trial', () => {
    const first = trial('same', true, 1, true)
    const second = { ...first, trial: 2 }
    const result = computeCalibration(run([second, first], JUDGE))!
    expect(result.disagreements.map(item => item.trial)).toEqual([1, 2])
  })

  it('sorts disagreements and caps the list at five entries', () => {
    const cases = Array.from({ length: 7 }, (_, index) => trial(`case-${6 - index}`, true, 1, true))
    const result = computeCalibration(run(cases, JUDGE))!
    expect(result.disagreements).toHaveLength(5)
    expect(result.disagreements.map(item => item.caseId)).toEqual([
      'case-0', 'case-1', 'case-2', 'case-3', 'case-4',
    ])
  })
})
