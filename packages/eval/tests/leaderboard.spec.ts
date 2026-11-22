import { describe, expect, it } from 'vitest'
import { buildLeaderboard, renderLeaderboard } from '../src/leaderboard.ts'
import type { EvalRun } from '../src/types.ts'

const METRICS = {
  turns: 1, steps: 1, toolCalls: 1, toolResults: 1, toolSuccess: 1, toolSuccessRate: 1,
  invalidToolCalls: 0, retries: 0,
  tokens: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
  totalTokens: 1, contextTokens: 1, llmMs: 1, toolMs: 2, ttftMs: 3, latencyMs: 120, costUsd: 0.000002,
}

function run(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    benchmark: 'b', model: 'm', createdAt: 1, trials: 1, seed: 0, pricing: null,
    tempRoot: '/tmp', aggregate: null, grading: null,
    cases: [{
      caseId: 'c', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
      metrics: METRICS,
      grade: { taskSuccess: true, toolSelectionAccuracy: true },
      judge: { finalAnswerScore: 8, hallucination: false },
    }],
    ...overrides,
  }
}

function graded(rate: number, model: string): EvalRun {
  return run({
    model,
    judge: { provider: 'p', model: 'j', maxScore: 10 },
    aggregate: { ...METRICS, costUsd: 0.000002, latencyMs: 120 },
    grading: {
      taskSuccessRate: rate, toolSelectionAccuracyRate: rate,
      finalAnswerScore: rate * 10, hallucinationRate: 0,
    },
  })
}

describe('dsh-eval leaderboard', () => {
  it('ranks runs by task success and shows the gap to the leader', () => {
    const rows = buildLeaderboard([
      { label: 'b — weak', run: graded(0.4, 'weak') },
      { label: 'b — strong', run: graded(0.9, 'strong') },
      { label: 'b — middle', run: graded(0.7, 'middle') },
    ])
    expect(rows.map(row => [row.label, row.rank])).toEqual([
      ['b — strong', 1], ['b — middle', 2], ['b — weak', 3],
    ])
    expect(rows[1]!.gapFromBest).toBeCloseTo(0.2)
    const markdown = renderLeaderboard(rows)
    expect(markdown).toContain('| 1 | b — strong | 1/1 | 90.0% | 100.0% | 90.0% | 90.0% | $0.000002 | 120.0 ms | leader |')
    expect(markdown).toContain('| 2 | b — middle | 1/1 | 70.0% | 100.0% | 70.0% | 70.0% | $0.000002 | 120.0 ms | -20.0pp |')
  })

  it('shares a rank for ties and breaks ties deterministically', () => {
    const rows = buildLeaderboard([
      { label: 'z', run: graded(0.8, 'z') },
      { label: 'a', run: graded(0.8, 'a') },
    ])
    expect(rows.map(row => [row.label, row.rank])).toEqual([['a', 1], ['z', 1]])
    expect(renderLeaderboard(rows)).toContain('| 1 | a |')
  })

  it('pushes ungraded runs to the bottom without inventing numbers', () => {
    const rows = buildLeaderboard([
      { label: 'x|bad\nname', run: run() },
      { label: 'graded', run: graded(0.6, 'g') },
      { label: 'also-ungraded', run: run({ model: 'other' }) },
    ])
    expect(rows[0]!.label).toBe('graded')
    expect(rows[1]!.label).toBe('also-ungraded')
    expect(rows[1]!.taskSuccess).toBeNull()
    expect(rows[1]!.gapFromBest).toBeNull()
    expect(rows[2]!.taskSuccess).toBeNull()
    const markdown = renderLeaderboard(rows)
    expect(markdown).toContain('| 3 | x bad name | 1/1 | – | 100.0% | – | – | – | – | – |')
  })

  it('still ranks judge-only runs whose task success is null', () => {
    const rows = buildLeaderboard([
      { label: 'first', run: run({ model: 'a' }) },
      { label: 'second', run: run({ model: 'b' }) },
    ])
    expect(rows.map(row => [row.label, row.rank, row.gapFromBest])).toEqual([
      ['first', 1, null], ['second', 2, null],
    ])
    expect(renderLeaderboard(rows)).toContain('| 1 | first | 1/1 | – | 100.0% | – | – | – | – | – |')
  })

  it('renders an empty leaderboard header', () => {
    expect(buildLeaderboard([])).toEqual([])
    expect(renderLeaderboard([])).toContain('# Leaderboard')
    expect(renderLeaderboard([])).not.toContain('| 1 |')
  })
})
