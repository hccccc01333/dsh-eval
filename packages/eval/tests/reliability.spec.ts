import { describe, expect, it } from 'vitest'
import { computeCoverage, computeReliability } from '../src/reliability.ts'
import type { EvalRun, EvalTrialResult } from '../src/types.ts'

function trial(caseId: string, index: number, task: boolean | null, tool: boolean | null): EvalTrialResult {
  return {
    caseId,
    trial: index,
    status: 'completed',
    exitCode: 0,
    timedOut: false,
    grade: { taskSuccess: task, toolSelectionAccuracy: tool },
  }
}

function run(cases: readonly EvalTrialResult[], trials = 3): EvalRun {
  return {
    benchmark: 'b',
    model: 'm',
    createdAt: 1,
    trials,
    seed: 0,
    pricing: null,
    tempRoot: '/tmp',
    cases,
    aggregate: null,
    grading: null,
  }
}

describe('dsh-eval reliability', () => {
  it('returns null when no trial carries the requested grade', () => {
    expect(computeReliability(run([]))).toBeNull()
    expect(computeReliability(run([
      { caseId: 'c', trial: 1, status: 'error', error: 'boom', exitCode: 1, timedOut: false },
    ]))).toBeNull()
    expect(computeReliability(run([{
      caseId: 'c', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
    }]))).toBeNull()
    expect(computeReliability(run([trial('c', 1, null, null)]))).toBeNull()
    expect(computeCoverage(run([
      { caseId: 'c', trial: 1, status: 'error', error: 'timeout', exitCode: null, timedOut: true },
    ]))).toEqual({ total: 1, completed: 0, errors: 1, timeouts: 1, unscored: 1 })
  })

  it('keeps errors and timeouts in the strict denominator', () => {
    const withFailures = run([
      trial('a', 1, true, null), trial('a', 2, true, null),
      { caseId: 'a', trial: 3, status: 'error', error: 'timeout', exitCode: null, timedOut: true },
      { caseId: 'b', trial: 1, status: 'error', error: 'boom', exitCode: 1, timedOut: false },
    ])
    const summary = computeReliability(withFailures)!
    expect(summary.total).toBe(4)
    expect(summary.unscored).toBe(2)
    expect(summary.passAt1).toBe(1)
    expect(summary.strictPassAt1).toBe(0.5)
    expect(summary.cases).toBe(1)
    expect(summary.hardest[0]).toMatchObject({ caseId: 'a', trials: 2, total: 3 })
    // The error-only case is unscored but still belongs in the denominator.
    expect(summary.hardest.map(item => item.caseId)).toEqual(['a'])
    expect(computeCoverage(withFailures)).toEqual({
      total: 4, completed: 2, errors: 2, timeouts: 1, unscored: 2,
    })
    expect(computeCoverage(run([trial('a', 1, true, null)]))).toEqual({
      total: 1, completed: 1, errors: 0, timeouts: 0, unscored: 0,
    })
    // Completed but ungraded trials are unscored too, matching reliability.
    expect(computeCoverage(run([{
      caseId: 'a', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
    }]))).toEqual({ total: 1, completed: 1, errors: 0, timeouts: 0, unscored: 1 })
  })

  it('separates pass@k from pass^k and surfaces flaky cases', () => {
    const mixed = run([
      ...[1, 2, 3].map(index => trial('a', index, true, true)),
      trial('b', 1, true, false), trial('b', 2, false, false), trial('b', 3, false, false),
      ...[1, 2, 3].map(index => trial('c', index, false, null)),
      trial('d', 1, true, true), trial('d', 2, true, false),
    ])
    const task = computeReliability(mixed)
    expect(task).toMatchObject({
      dimension: 'task', k: 3, cases: 4,
      passAt1: 6 / 11, passAtK: 0.75, passAllK: 0.5,
    })
    expect(task!.flaky.map(item => item.caseId)).toEqual(['b'])
    // c fails every trial, b is flaky, and a/d tie at 100% broken by case id.
    expect(task!.hardest.map(item => item.caseId)).toEqual(['c', 'b', 'a'])

    const tool = computeReliability(mixed, 'tool-selection')
    expect(tool).toMatchObject({
      dimension: 'tool-selection', k: 3, cases: 3,
      passAt1: 0.5, passAtK: 2 / 3, passAllK: 1 / 3,
    })
    // c has null tool grades, so it is skipped for that dimension.
    expect(tool!.flaky.map(item => item.caseId)).toEqual(['d'])
  })

  it('keeps flaky empty when every graded case is stable', () => {
    const stable = computeReliability(run([
      trial('a', 1, true, true), trial('a', 2, true, true),
      trial('z', 1, false, false), trial('z', 2, false, false),
    ]))
    expect(stable!.flaky).toEqual([])
    // Equal pass rates are ordered by case id in both directions.
    expect(computeReliability(run([
      trial('z', 1, true, null), trial('a', 1, true, null),
    ]))!.hardest.map(item => item.caseId)).toEqual(['a', 'z'])
  })
})
