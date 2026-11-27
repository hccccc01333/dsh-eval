import { describe, expect, it } from 'vitest'
import { clusterFailures } from '../src/clusters.ts'
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

describe('clusterFailures', () => {
  it('returns no clusters for a clean run', () => {
    expect(clusterFailures(buildRun([trial('a'), trial('b')]))).toEqual([])
  })

  it('groups repeated check configuration errors into one cluster', () => {
    const run = buildRun([
      trial('a', { grade: { taskSuccess: false, toolSelectionAccuracy: null, checkError: 'spawn missing ENOENT' } }),
      trial('b', { grade: { taskSuccess: false, toolSelectionAccuracy: null, checkError: 'spawn missing ENOENT' } }),
    ])
    expect(clusterFailures(run)).toEqual([{
      pattern: 'check-config',
      label: 'Check command could not start (configuration error)',
      count: 2,
      cases: [{ caseId: 'a', trial: 1 }, { caseId: 'b', trial: 1 }],
    }])
  })

  it('classifies every primary cause with a readable label', () => {
    const run = buildRun([
      trial('err', { status: 'error', error: 'boom\u0007 for\nx' }),
      trial('err-unknown', { status: 'error' }),
      trial('timeout', { timedOut: true }),
      trial('exit', { exitCode: 7 }),
      trial('hallu', { judge: { finalAnswerScore: 3, hallucination: true, } }),
      trial('check', { grade: { taskSuccess: false, toolSelectionAccuracy: null } }),
    ])
    const clusters = clusterFailures(run)
    // All clusters have count 1 here, so pattern order decides.
    expect(clusters.map(item => item.pattern)).toEqual([
      'hallucination', 'nonzero-exit', 'task-check', 'timeout', 'trial-error', 'trial-error',
    ])
    expect(clusters[4]?.label).toBe('Trial error: boom for x')
    expect(clusters[5]?.label).toBe('Trial error: unknown error')
  })

  it('clusters judge call failures while keeping a scripted failure primary', () => {
    const failedJudge = (judgeError: string) => ({ finalAnswerScore: null, hallucination: null, judgeError })
    const run = buildRun([
      trial('j1', { judge: failedJudge('rate limit\u0007') }),
      trial('j2', { judge: failedJudge('rate limit') }),
      trial('j3', {
        grade: { taskSuccess: false, toolSelectionAccuracy: null },
        judge: failedJudge('rate limit'),
      }),
    ])
    expect(clusterFailures(run)).toEqual([
      {
        pattern: 'judge-error', label: 'Judge call failed: rate limit',
        count: 2, cases: [{ caseId: 'j1', trial: 1 }, { caseId: 'j2', trial: 1 }],
      },
      {
        pattern: 'task-check', label: 'Task check or answer regex did not pass',
        count: 1, cases: [{ caseId: 'j3', trial: 1 }],
      },
    ])
  })

  it('uses a fixed priority when several causes apply to one trial', () => {
    const run = buildRun([trial('all', {
      status: 'error',
      error: 'crashed',
      timedOut: true,
      exitCode: 9,
      grade: { taskSuccess: false, toolSelectionAccuracy: null, checkError: 'spawn bad' },
      judge: { finalAnswerScore: 0, hallucination: true, },
    })])
    const clusters = clusterFailures(run)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]?.pattern).toBe('trial-error')
    expect(clusters[0]?.count).toBe(1)
  })

  it('caps long normalized error text at 100 characters', () => {
    const run = buildRun([trial('long', { status: 'error', error: 'x'.repeat(300) })])
    expect(clusterFailures(run)[0]?.label).toBe(`Trial error: ${'x'.repeat(100)}`)
  })

  it('sorts by descending count, then pattern, then label', () => {
    const run = buildRun([
      trial('t1', { timedOut: true }),
      trial('t2', { timedOut: true }),
      trial('h', { judge: { finalAnswerScore: 1, hallucination: true, } }),
      trial('e1', { exitCode: 2 }),
      trial('e2', { exitCode: 3 }),
    ])
    // Timeout (count 2) first; the rest are count 1, ordered by pattern.
    expect(clusterFailures(run).map(item => item.pattern)).toEqual([
      'timeout', 'hallucination', 'nonzero-exit', 'nonzero-exit',
    ])
  })
})
