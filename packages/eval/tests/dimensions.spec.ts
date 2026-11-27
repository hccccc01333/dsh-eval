import { describe, expect, it } from 'vitest'
import { computeSegments } from '../src/dimensions.ts'
import type { EvalRun, EvalTrialResult } from '../src/types.ts'

function buildRun(cases: EvalTrialResult[]): EvalRun {
  return {
    benchmark: 'b',
    model: 'm',
    createdAt: 1,
    trials: cases.length,
    seed: 0,
    pricing: null,
    tempRoot: '/tmp',
    cases,
    aggregate: null,
    grading: null,
  }
}

function trial(id: string, overrides: Partial<EvalTrialResult> = {}): EvalTrialResult {
  return {
    caseId: id,
    trial: 1,
    status: 'completed',
    exitCode: 0,
    timedOut: false,
    ...overrides,
  }
}

describe('computeSegments', () => {
  it('returns no segments for reports without tags', () => {
    expect(computeSegments(buildRun([trial('a'), trial('b')]))).toEqual([])
  })

  it('aggregates task success, judge score and hallucination rate per tag', () => {
    const run = buildRun([
      trial('a', {
        tags: ['hard', 'ts'],
        grade: { taskSuccess: true, toolSelectionAccuracy: null },
        judge: { finalAnswerScore: 8, hallucination: false },
      }),
      trial('a', {
        trial: 2,
        tags: ['hard', 'ts'],
        grade: { taskSuccess: false, toolSelectionAccuracy: null },
        judge: { finalAnswerScore: 4, hallucination: true },
      }),
      trial('b', {
        tags: ['easy'],
        grade: { taskSuccess: true, toolSelectionAccuracy: null },
        judge: { finalAnswerScore: 10, hallucination: false },
      }),
    ])
    expect(computeSegments(run)).toEqual([
      {
        tag: 'easy', cases: 1, trials: 1,
        taskSuccessRate: 1, judgeScoreMean: 10, judgeScoreRate: null, hallucinationRate: 0,
      },
      {
        tag: 'hard', cases: 1, trials: 2,
        taskSuccessRate: 0.5, judgeScoreMean: 6, judgeScoreRate: null, hallucinationRate: 0.5,
      },
      {
        tag: 'ts', cases: 1, trials: 2,
        taskSuccessRate: 0.5, judgeScoreMean: 6, judgeScoreRate: null, hallucinationRate: 0.5,
      },
    ])
  })

  it('normalizes judge means by the run scale and clamps out-of-range scores', () => {
    const run = buildRun([
      trial('a', { tags: ['x'], judge: { finalAnswerScore: 8, hallucination: false } }),
      trial('b', { tags: ['x'], judge: { finalAnswerScore: 12, hallucination: false } }),
    ])
    run.judge = { provider: 'p', model: 'j', maxScore: 20 }
    expect(computeSegments(run)[0]).toMatchObject({ judgeScoreMean: 10, judgeScoreRate: 0.5 })
    run.judge.maxScore = 5
    expect(computeSegments(run)[0]?.judgeScoreRate).toBe(1)
    run.judge.maxScore = 0
    expect(computeSegments(run)[0]?.judgeScoreRate).toBeNull()
  })

  it('counts distinct cases separately from trials', () => {
    const run = buildRun([
      trial('a', { tags: ['x'] }),
      trial('a', { trial: 2, tags: ['x'] }),
      trial('b', { tags: ['x'] }),
      trial('untagged'),
    ])
    const segment = computeSegments(run)[0]
    expect(segment?.cases).toBe(2)
    expect(segment?.trials).toBe(3)
    expect(segment?.taskSuccessRate).toBeNull()
    expect(segment?.judgeScoreMean).toBeNull()
    expect(segment?.hallucinationRate).toBeNull()
  })

  it('ignores null and undefined verdict fields', () => {
    const run = buildRun([
      trial('a', {
        tags: ['mixed'],
        grade: { taskSuccess: true, toolSelectionAccuracy: null },
        judge: { finalAnswerScore: null, hallucination: null },
      }),
      trial('b', { tags: ['mixed'] }),
    ])
    expect(computeSegments(run)[0]).toMatchObject({
      taskSuccessRate: 1,
      judgeScoreMean: null,
      hallucinationRate: null,
    })
  })
})
