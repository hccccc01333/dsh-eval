import { describe, expect, it } from 'vitest'
import { buildLeaderboard, renderLeaderboard, renderLeaderboardJson } from '../src/leaderboard.ts'
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
    expect(markdown).toContain('| 1 | b — strong | 1/1 | 90.0% | 100.0% | 90.0% | 90.0% | $0.000002 | 120.0 ms | leader | leader |')
    expect(markdown).toContain('| 2 | b — middle | 1/1 | 70.0% | 100.0% | 70.0% | 70.0% | $0.000002 | 120.0 ms | -20.0pp | underpowered (p=1.000, task success) |')
  })

  it('can rank by strict pass@1 so mass errors cannot top the board', () => {
    const many = (gradedPasses: number, errors: number): EvalRun => run({
      model: `g${gradedPasses}e${errors}`,
      trials: gradedPasses + errors,
      grading: {
        taskSuccessRate: gradedPasses === 0 ? null : 1,
        toolSelectionAccuracyRate: null,
        finalAnswerScore: null, hallucinationRate: null,
      },
      cases: [
        ...Array.from({ length: gradedPasses }, (_, index) => ({
          caseId: `p${index}`, trial: 1, status: 'completed' as const, exitCode: 0, timedOut: false,
          grade: { taskSuccess: true, toolSelectionAccuracy: null }, metrics: METRICS,
        })),
        ...Array.from({ length: errors }, (_, index) => ({
          caseId: `e${index}`, trial: 1, status: 'error' as const, error: 'boom', exitCode: 1, timedOut: false,
        })),
      ],
    })
    const errored = many(1, 99)
    const honest = run({
      model: 'honest',
      trials: 10,
      grading: {
        taskSuccessRate: 0.9, toolSelectionAccuracyRate: null,
        finalAnswerScore: null, hallucinationRate: null,
      },
      cases: Array.from({ length: 10 }, (_, index) => ({
        caseId: `h${index}`, trial: 1, status: 'completed' as const, exitCode: 0, timedOut: false,
        grade: { taskSuccess: index < 9, toolSelectionAccuracy: null }, metrics: METRICS,
      })),
    })
    const byTask = buildLeaderboard([
      { label: 'errored', run: errored }, { label: 'honest', run: honest },
    ])
    expect(byTask.map(row => row.label)).toEqual(['errored', 'honest'])
    const rows = buildLeaderboard([
      { label: 'errored', run: errored }, { label: 'honest', run: honest },
    ], 'strictPassAt1')
    expect(rows.map(row => [row.label, row.rank])).toEqual([['honest', 1], ['errored', 2]])
    expect(rows[1]!.gapFromBest).toBeCloseTo(0.89)
    expect(renderLeaderboard(rows, 'strictPassAt1')).toContain('ranked by strict pass@1')
    expect(JSON.parse(renderLeaderboardJson(rows, 'strictPassAt1')) as { rankedBy: string })
      .toMatchObject({ rankedBy: 'strictPassAt1' })
  })

  it('does not call a strict-rate tie a regression when trial counts differ', () => {
    const make = (model: string, extra: number): EvalRun => run({
      model, trials: 10 + extra,
      grading: {
        taskSuccessRate: 0.5, toolSelectionAccuracyRate: null,
        finalAnswerScore: null, hallucinationRate: null,
      },
      cases: Array.from({ length: 10 + extra }, (_, index) => ({
        caseId: `c${index}`, trial: 1, status: 'completed' as const,
        exitCode: 0, timedOut: false,
        grade: { taskSuccess: index % 2 === 0, toolSelectionAccuracy: null }, metrics: METRICS,
      })),
    })
    const rows = buildLeaderboard([
      { label: 'leader', run: make('leader', 0) },
      { label: 'row', run: make('row', 14) },
    ], 'strictPassAt1')
    expect(rows[1]!.significance).toMatchObject({
      worse: false, verdict: 'ahead-or-tied',
    })
  })

  it('uses strict-pass evidence for the verdict when ranking strictly', () => {
    const allPass = run({
      model: 'leader', trials: 10,
      grading: {
        taskSuccessRate: 1, toolSelectionAccuracyRate: null,
        finalAnswerScore: null, hallucinationRate: null,
      },
      cases: Array.from({ length: 10 }, (_, index) => ({
        caseId: `c${index}`, trial: 1, status: 'completed' as const,
        exitCode: 0, timedOut: false,
        grade: { taskSuccess: true, toolSelectionAccuracy: null }, metrics: METRICS,
      })),
    })
    const withError = run({
      model: 'row', trials: 10,
      grading: {
        taskSuccessRate: 1, toolSelectionAccuracyRate: null,
        finalAnswerScore: null, hallucinationRate: null,
      },
      cases: Array.from({ length: 10 }, (_, index) => index === 9
        ? {
          caseId: `c${index}`, trial: 1, status: 'error' as const,
          error: 'boom', exitCode: 1, timedOut: false,
        }
        : {
          caseId: `c${index}`, trial: 1, status: 'completed' as const,
          exitCode: 0, timedOut: false,
          grade: { taskSuccess: true, toolSelectionAccuracy: null }, metrics: METRICS,
        }),
    })
    const rows = buildLeaderboard([
      { label: 'leader', run: allPass }, { label: 'row', run: withError },
    ], 'strictPassAt1')
    expect(rows[1]!.significance).toMatchObject({
      worse: true, primaryMetric: 'strict pass@1 (task)',
    })
  })

  it('classifies strict verdicts with strict-pass evidence', () => {
    const pass = (caseId: string): EvalRun['cases'][number] => ({
      caseId, trial: 1, status: 'completed', exitCode: 0, timedOut: false,
      grade: { taskSuccess: true, toolSelectionAccuracy: null }, metrics: METRICS,
    })
    const fail = (caseId: string): EvalRun['cases'][number] => ({
      caseId, trial: 1, status: 'completed', exitCode: 0, timedOut: false,
      grade: { taskSuccess: false, toolSelectionAccuracy: null }, metrics: METRICS,
    })
    const error = (caseId: string): EvalRun['cases'][number] => ({
      caseId, trial: 1, status: 'error', exitCode: 1, timedOut: false, error: 'boom',
    })
    const grading = (rate: number | null) => ({
      taskSuccessRate: rate, toolSelectionAccuracyRate: null,
      finalAnswerScore: null, hallucinationRate: null,
    })
    const make = (model: string, cases: EvalRun['cases']): EvalRun => run({
      model, trials: cases.length, grading: grading(null), cases,
    })
    const rows = buildLeaderboard([
      { label: 'strong', run: make('strong', Array.from({ length: 7 }, (_, i) => pass(`s${i}`))) },
      { label: 'weak', run: make('weak', Array.from({ length: 7 }, (_, i) => error(`s${i}`))) },
      { label: 'mixed-leader', run: make('mixed-leader', [
        ...Array.from({ length: 3 }, (_, i) => fail(`m${i}`)),
        ...Array.from({ length: 4 }, (_, i) => pass(`m${i + 3}`)),
      ]) },
      { label: 'mixed-row', run: make('mixed-row', [
        ...Array.from({ length: 3 }, (_, i) => pass(`m${i}`)),
        ...Array.from({ length: 4 }, (_, i) => error(`m${i + 3}`)),
      ]) },
    ], 'strictPassAt1')
    expect(rows.find(row => row.label === 'weak')?.significance?.verdict)
      .toBe('significantly-behind')
    expect(rows.find(row => row.label === 'mixed-row')?.significance?.verdict)
      .toBe('behind-not-significant')
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
    expect(markdown).toContain('| 3 | x bad name | 1/1 | – | 100.0% | – | – | – | – | – | underpowered (p=1.000, task success) |')
  })

  it('still ranks judge-only runs whose task success is null', () => {
    const rows = buildLeaderboard([
      { label: 'first', run: run({ model: 'a' }) },
      { label: 'second', run: run({ model: 'b' }) },
    ])
    expect(rows.map(row => [row.label, row.rank, row.gapFromBest])).toEqual([
      ['first', 1, null], ['second', 2, null],
    ])
    expect(renderLeaderboard(rows)).toContain('| 1 | first | 1/1 | – | 100.0% | – | – | – | – | – | leader |')
  })

  it('renders a machine-readable leaderboard', () => {
    const rows = buildLeaderboard([
      { label: 'b — strong', run: graded(0.9, 'strong') },
      { label: 'b — weak', run: graded(0.4, 'weak') },
    ])
    const parsed = JSON.parse(renderLeaderboardJson(rows)) as {
      rankedBy: string; rows: { rank: number; label: string; gapFromBest: number | null }[]
    }
    expect(parsed.rankedBy).toBe('taskSuccess')
    expect(rows[0]).toMatchObject({ benchmark: 'b', model: 'strong' })
    expect(parsed.rows.map(row => row.label)).toEqual(['b — strong', 'b — weak'])
    expect(parsed.rows[1]!.gapFromBest).toBeCloseTo(0.5)
  })

  it('labels paired evidence against the leader', () => {
    const pairedRun = (task: readonly boolean[], model: string): EvalRun => run({
      model,
      grading: {
        taskSuccessRate: task.filter(Boolean).length / task.length,
        toolSelectionAccuracyRate: null, finalAnswerScore: null, hallucinationRate: null,
      },
      cases: task.map((success, index) => ({
        caseId: `c${index + 1}`, trial: 1, status: 'completed' as const,
        exitCode: 0, timedOut: false,
        grade: { taskSuccess: success, toolSelectionAccuracy: null },
      })),
    })
    const allTrue = pairedRun(Array(8).fill(true) as boolean[], 'strong')
    const allFalse = pairedRun(Array(8).fill(false) as boolean[], 'weak')
    const rows = buildLeaderboard([
      { label: 'strong', run: allTrue }, { label: 'weak', run: allFalse },
    ])
    expect(rows[0]!.significance).toBeNull()
    expect(rows[1]!.significance).toMatchObject({
      verdict: 'significantly-behind', worse: true, detectable: true,
    })
    expect(renderLeaderboard(rows)).toContain('significantly-behind (p=0.0078, task success)')

    const mixed = pairedRun([true, true, true, true, true, false, false, false], 'mixed')
    const reverse = pairedRun([false, false, false, false, false, true, true, true], 'reverse')
    const noisy = buildLeaderboard([
      { label: 'mixed', run: mixed }, { label: 'reverse', run: reverse },
    ])
    expect(noisy[1]!.significance?.verdict).toBe('behind-not-significant')

    const judgeLeader = run({
      model: 'judge-leader',
      grading: {
        taskSuccessRate: 0.9, toolSelectionAccuracyRate: null,
        finalAnswerScore: 2, hallucinationRate: 0,
      },
      cases: Array.from({ length: 8 }, (_, index) => ({
        caseId: `c${index + 1}`, trial: 1, status: 'completed' as const,
        exitCode: 0, timedOut: false,
        grade: { taskSuccess: index < 7, toolSelectionAccuracy: null },
        judge: { finalAnswerScore: 2, hallucination: false },
      })),
    })
    const judgeChallenger = run({
      model: 'judge-challenger',
      grading: {
        taskSuccessRate: 0.6, toolSelectionAccuracyRate: null,
        finalAnswerScore: 8, hallucinationRate: 0,
      },
      cases: Array.from({ length: 8 }, (_, index) => ({
        caseId: `c${index + 1}`, trial: 1, status: 'completed' as const,
        exitCode: 0, timedOut: false,
        grade: { taskSuccess: null, toolSelectionAccuracy: null },
        judge: { finalAnswerScore: 8, hallucination: false },
      })),
    })
    const ahead = buildLeaderboard([
      { label: 'judge-leader', run: judgeLeader },
      { label: 'judge-challenger', run: judgeChallenger },
    ])
    expect(ahead[0]!.label).toBe('judge-leader')
    expect(ahead[1]!.significance?.verdict).toBe('ahead-or-tied')

    const unpaired = buildLeaderboard([
      { label: 'strong', run: allTrue },
      { label: 'other', run: run({ model: 'other', cases: [] }) },
    ])
    expect(unpaired[1]!.significance?.verdict).toBe('unpaired')
    expect(renderLeaderboard(unpaired)).toContain('| unpaired |')
  })

  it('marks the cost-quality frontier only when cost data exists', () => {
    const priced = (rate: number, costUsd: number, model: string): EvalRun => run({
      model,
      aggregate: { ...METRICS, costUsd },
      grading: {
        taskSuccessRate: rate, toolSelectionAccuracyRate: rate,
        finalAnswerScore: rate * 10, hallucinationRate: 0,
      },
    })
    const rows = buildLeaderboard([
      { label: 'cheap-strong', run: priced(0.9, 0.000001, 'cs') },
      { label: 'costly-weak', run: priced(0.7, 0.000002, 'cw') },
      { label: 'no-cost', run: run({
        model: 'nc',
        grading: {
          taskSuccessRate: 0.8, toolSelectionAccuracyRate: null,
          finalAnswerScore: null, hallucinationRate: null,
        },
      }) },
      { label: 'no-quality', run: run({
        model: 'nq', aggregate: { ...METRICS, costUsd: 0.000001 },
      }) },
      { label: 'no-data', run: run({ model: 'nd' }) },
    ])
    const byLabel = new Map(rows.map(row => [row.label, row]))
    expect(byLabel.get('cheap-strong')?.pareto).toBe('on-frontier')
    expect(byLabel.get('costly-weak')?.pareto).toBe('dominated')
    expect(byLabel.get('no-cost')?.pareto).toBeUndefined()
    expect(byLabel.get('no-quality')?.pareto).toBeUndefined()
    expect(byLabel.get('no-data')?.pareto).toBeUndefined()
    const markdown = renderLeaderboard(rows)
    expect(markdown).toContain('| pareto |')
    expect(markdown).toMatch(/\|\s*1 \| cheap-strong \|[^\n]*\| ★ \|/)
    expect(markdown).toMatch(/\| costly-weak \|[^\n]*\| dominated \|/)
    const parsed = JSON.parse(renderLeaderboardJson(rows)) as {
      rows: { label: string; pareto?: string }[]
    }
    expect(parsed.rows.find(row => row.label === 'cheap-strong')?.pareto).toBe('on-frontier')
    expect(parsed.rows.find(row => row.label === 'costly-weak')?.pareto).toBe('dominated')
    expect('pareto' in parsed.rows.find(row => row.label === 'no-cost')!).toBe(false)
  })

  it('omits Pareto markers and column when no run has cost data', () => {
    const unpriced = (rate: number, model: string): EvalRun => run({
      model,
      grading: {
        taskSuccessRate: rate, toolSelectionAccuracyRate: null,
        finalAnswerScore: null, hallucinationRate: null,
      },
    })
    const rows = buildLeaderboard([
      { label: 'a', run: unpriced(0.9, 'a') },
      { label: 'b', run: unpriced(0.5, 'b') },
    ])
    expect(rows.every(row => row.pareto === undefined)).toBe(true)
    expect(renderLeaderboard(rows)).not.toContain('| pareto |')
    expect(renderLeaderboard(rows)).not.toContain('★')
    const parsed = JSON.parse(renderLeaderboardJson(rows)) as { rows: object[] }
    expect(parsed.rows.every(row => !('pareto' in row))).toBe(true)
  })

  it('renders an empty leaderboard header', () => {
    expect(buildLeaderboard([])).toEqual([])
    expect(renderLeaderboard([])).toContain('# Leaderboard')
    expect(renderLeaderboard([])).not.toContain('| 1 |')
  })
})
