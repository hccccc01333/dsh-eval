import { describe, expect, it } from 'vitest'
import { compareRuns, pairedCases, pairedCompare, renderCompareJson, renderCompareMarkdown, renderPairedCases } from '../src/compare.ts'
import type { EvalRun, EvalTrialResult } from '../src/types.ts'

function buildRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    benchmark: 'b',
    model: 'm',
    createdAt: 1,
    trials: 1,
    seed: 0,
    pricing: null,
    tempRoot: '/tmp',
    cases: [],
    aggregate: null,
    grading: null,
    ...overrides,
  }
}

const METRICS = {
  turns: 1,
  steps: 2,
  toolCalls: 1,
  toolResults: 1,
  toolSuccess: 1,
  toolSuccessRate: 1,
  invalidToolCalls: 0,
  retries: 1,
  tokens: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
  totalTokens: 10,
  contextTokens: 10,
  llmMs: 1,
  toolMs: 2,
  ttftMs: 3,
  latencyMs: 4,
  costUsd: 0.000001,
}

describe('dsh-eval comparison', () => {
  it('builds numeric, rate, and text rows with signed deltas', () => {
    const a = buildRun({
      benchmark: 'base',
      model: 'm1',
      cases: [{ caseId: 'c', trial: 1, status: 'completed', exitCode: 0, timedOut: false, metrics: METRICS }],
      aggregate: { ...METRICS, toolSuccessRate: 1, steps: 2, totalTokens: 10, costUsd: 0.000001, latencyMs: 4 },
      grading: { taskSuccessRate: 0.5, toolSelectionAccuracyRate: 0.8, finalAnswerScore: null, hallucinationRate: null },
    })
    const b = buildRun({
      benchmark: 'candidate',
      model: 'm2',
      cases: [
        { caseId: 'c', trial: 1, status: 'completed', exitCode: 0, timedOut: false, metrics: METRICS },
        { caseId: 'c', trial: 2, status: 'completed', exitCode: 0, timedOut: false, metrics: METRICS },
      ],
      aggregate: { ...METRICS, toolSuccessRate: 0.9, steps: 4, totalTokens: 20, costUsd: 0.000002, latencyMs: 8 },
      grading: { taskSuccessRate: 0.75, toolSelectionAccuracyRate: 0.6, finalAnswerScore: null, hallucinationRate: null },
    })
    const rows = compareRuns(a, b)
    const byMetric = new Map(rows.map(row => [row.metric, row]))
    expect(byMetric.get('benchmark')).toEqual({ metric: 'benchmark', a: 'base', b: 'candidate', delta: '–' })
    expect(byMetric.get('completed trials')).toEqual({ metric: 'completed trials', a: '1', b: '2', delta: '+1' })
    expect(byMetric.get('steps/trial')).toEqual({ metric: 'steps/trial', a: '2.0', b: '4.0', delta: '+2.0' })
    expect(byMetric.get('tool success')).toEqual({ metric: 'tool success', a: '100.0%', b: '90.0%', delta: '-10.0pp' })
    expect(byMetric.get('task success')).toEqual({ metric: 'task success', a: '50.0%', b: '75.0%', delta: '+25.0pp' })
    expect(byMetric.get('cost/trial (USD)')).toEqual({
      metric: 'cost/trial (USD)', a: '$0.000001', b: '$0.000002', delta: '+$0.000001',
    })
    expect(compareRuns(b, a).find(row => row.metric === 'cost/trial (USD)')?.delta).toBe('-$0.000001')
    const markdown = renderCompareMarkdown(rows)
    expect(markdown).toContain('# Compare')
    expect(markdown).toContain('| benchmark | base | candidate | – |')
    expect(markdown).toContain('| task success | 50.0% | 75.0% | +25.0pp |')
  })

  it('renders dashes when either run lacks a value', () => {
    const a = buildRun()
    const b = buildRun({ aggregate: null, grading: null })
    const rows = compareRuns(a, b)
    expect(rows.find(row => row.metric === 'task success')?.delta).toBe('–')
    expect(rows.find(row => row.metric === 'steps/trial')?.a).toBe('–')
  })

  function trial(
    caseId: string,
    trialNo: number,
    taskSuccess: boolean,
    steps: number,
    totalTokens: number,
    score?: number,
  ): EvalTrialResult {
    return {
      caseId,
      trial: trialNo,
      status: 'completed',
      exitCode: 0,
      timedOut: false,
      grade: { taskSuccess, toolSelectionAccuracy: null },
      ...(score !== undefined ? { judge: { finalAnswerScore: score, hallucination: false } } : {}),
      metrics: { ...METRICS, steps, totalTokens },
    }
  }

  it('computes paired win/lose/tie statistics and mean deltas', () => {
    const a = buildRun({
      cases: [
        trial('c', 1, false, 2, 10, 5),
        trial('c', 2, true, 4, 20, 6),
        trial('c', 3, true, 1, 5, 8),
      ],
    })
    const b = buildRun({
      cases: [
        trial('c', 1, true, 3, 15, 7),
        trial('c', 2, false, 3, 18, 4),
        trial('c', 3, true, 2, 8, 8),
      ],
    })
    const paired = pairedCompare(a, b)
    expect(paired?.pairs).toBe(3)
    expect(paired?.wins).toBe(1)
    expect(paired?.losses).toBe(1)
    expect(paired?.ties).toBe(1)
    expect(paired?.primaryMetric).toBe('task success')
    expect(paired?.stepsDelta?.mean).toBeCloseTo(1 / 3, 10)
    expect(paired?.tokensDelta?.mean).toBeCloseTo(2, 10)
    expect(paired?.scoreDelta?.mean).toBeCloseTo(0, 10)
    // One p-value plus three populated intervals: family size four at alpha 0.05.
    expect(paired?.correction).toEqual({
      comparisons: 4,
      alpha: 0.05,
      adjustedPValue: Math.min(1, paired!.test.pValue * 4),
      intervalConfidence: 0.9875,
    })
  })

  it('renders a machine-readable comparison with paired inference and cases', () => {
    const a = buildRun({ benchmark: 'base', cases: [trial('c', 1, true, 2, 10, 5)] })
    const b = buildRun({ benchmark: 'candidate', cases: [trial('c', 1, false, 3, 12, 4)] })
    const parsed = JSON.parse(renderCompareJson(a, b)) as {
      baseline: { benchmark: string }; candidate: { benchmark: string }
      rows: { metric: string }[]; paired: { pairs: number } | null
      cases: { outcome: string }[]
    }
    expect(parsed.baseline.benchmark).toBe('base')
    expect(parsed.candidate.benchmark).toBe('candidate')
    expect(parsed.rows.map(row => row.metric)).toContain('benchmark')
    expect(parsed.paired?.pairs).toBe(1)
    expect(parsed.cases.map(item => item.outcome)).toEqual(['A better'])
    const unpaired = JSON.parse(renderCompareJson(buildRun(), buildRun())) as {
      paired: unknown; cases: unknown[]
    }
    expect(unpaired.paired).toBeNull()
    expect(unpaired.cases).toEqual([])
  })

  it('classifies and renders the paired cases behind the sign test', () => {
    const a = buildRun({
      cases: [trial('c', 1, false, 2, 10, 5), trial('c', 2, true, 2, 10, 5), trial('c', 3, true, 2, 10, 5)],
    })
    const b = buildRun({
      cases: [trial('c', 1, true, 2, 10, 5), trial('c', 2, false, 2, 10, 5), trial('c', 3, true, 2, 10, 5)],
    })
    const cases = pairedCases(a, b)!
    expect(cases.map(item => [item.caseId, item.outcome])).toEqual([
      ['c', 'B better'], ['c', 'A better'], ['c', 'tie'],
    ])
    const markdown = renderPairedCases(cases)
    expect(markdown).toContain('1 candidate wins · 1 candidate losses · 1 ties')
    expect(markdown).toContain('| c | 1 | fail | pass | B better |')
    expect(pairedCases(buildRun(), b)).toBeNull()
    expect(renderPairedCases([])).toContain('0 candidate wins · 0 candidate losses · 0 ties')

    const manyA = buildRun({ cases: Array.from({ length: 21 }, (_, i) => trial(`m${i}`, 1, false, 2, 10, 5)) })
    const manyB = buildRun({ cases: Array.from({ length: 21 }, (_, i) => trial(`m${i}`, 1, true, 2, 10, 5)) })
    expect(renderPairedCases(pairedCases(manyA, manyB)!)).toContain('showing 20 of 21 discordant pairs')
  })

  it('does not call unmeasured pairs ties', () => {
    const bare = (label: string): EvalRun => buildRun({
      model: label,
      cases: [{
        caseId: 'c', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
      }],
    })
    expect(pairedCases(bare('a'), bare('b'))).toBeNull()
    expect(pairedCompare(bare('a'), bare('b'))?.ties).toBe(1)
  })

  it('falls back to judge scores for case outcomes and sanitizes case ids', () => {
    const a = buildRun({
      cases: [{
        caseId: 'n|bad\nnext', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
        judge: { finalAnswerScore: 2, hallucination: false },
      }],
    })
    const b = buildRun({
      cases: [{
        caseId: 'n|bad\nnext', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
        judge: { finalAnswerScore: 5, hallucination: false },
      }],
    })
    expect(renderPairedCases(pairedCases(a, b)!)).toContain('| n bad next | 1 | 2 | 5 | B better |')
    expect(renderPairedCases([{ caseId: 'n', trial: 1, a: null, b: null, outcome: 'B better' }]))
      .toContain('| n | 1 | – | – | B better |')
  })

  it('includes paired rows when both runs share completed trials', () => {
    const a = buildRun({ cases: [trial('c', 1, true, 2, 10)] })
    const b = buildRun({ cases: [trial('c', 1, false, 3, 15)] })
    const rows = compareRuns(a, b)
    const byMetric = new Map(rows.map(row => [row.metric, row]))
    expect(byMetric.get('paired trials')).toEqual({ metric: 'paired trials', a: '1', b: '1', delta: '–' })
    expect(byMetric.get('paired task success (B/A/ties)')).toEqual({
      metric: 'paired task success (B/A/ties)',
      a: '0/1/0',
      b: '–',
      delta: '–',
    })
    expect(byMetric.get('paired steps delta (B-A)')).toEqual({
      metric: 'paired steps delta (B-A)',
      a: '–',
      b: '–',
      delta: '–',
      inference: '+1.0',
    })
  })

  it('renders inference in its own table instead of the delta column', () => {
    const a = buildRun({ cases: [trial('c', 1, true, 2, 10)] })
    const b = buildRun({ cases: [trial('c', 1, false, 3, 15)] })
    const markdown = renderCompareMarkdown(compareRuns(a, b))
    expect(markdown).toContain('| metric | run A | run B | delta (B - A) |')
    expect(markdown).toContain('## Paired inference')
    expect(markdown).toContain('| quantity | value |')
    expect(markdown).toMatch(/\| paired steps delta \(B-A\) \| \+1\.0 \|/u)
    expect(markdown).not.toContain('| paired steps delta (B-A) | – | – | +1.0 |')
    // Runs without a paired sample have no inference section at all.
    expect(renderCompareMarkdown(compareRuns(buildRun(), buildRun()))).not.toContain('Paired inference')
  })

  it('falls back to judge scores for paired win/lose/tie', () => {
    const scored = (caseId: string, trialNo: number, score: number): EvalTrialResult => ({
      caseId,
      trial: trialNo,
      status: 'completed',
      exitCode: 0,
      timedOut: false,
      judge: { finalAnswerScore: score, hallucination: false },
      metrics: METRICS,
    })
    const a = buildRun({
      cases: [scored('c', 1, 5), scored('c', 2, 6), scored('c', 3, 8)],
    })
    const b = buildRun({
      cases: [scored('c', 1, 7), scored('c', 2, 4), scored('c', 3, 8)],
    })
    const paired = pairedCompare(a, b)
    expect(paired?.primaryMetric).toBe('final answer score')
    expect(paired?.wins).toBe(1)
    expect(paired?.losses).toBe(1)
    expect(paired?.ties).toBe(1)
    const rows = compareRuns(a, b)
    const scoreRow = rows.find(row => row.metric === 'paired final-answer delta (B-A)')
    expect(scoreRow?.a).toBe('–')
    // Three pairs carry enough data for a bootstrap interval, widened to 98.8%
    // because the report also prints the p-value and two other intervals.
    expect(scoreRow?.inference).toMatch(/^\+0\.0 \[98\.8% CI -\d\.\d, \+\d\.\d\]$/u)
    // Three pairs, one win and one loss: the sign test has nothing to separate them.
    expect(rows.find(row => row.metric === 'paired final answer score p (sign test, Bonferroni ×4)')).toEqual({
      metric: 'paired final answer score p (sign test, Bonferroni ×4)',
      a: '–',
      b: '–',
      delta: '–',
      inference: '1.000 (n=2)',
    })
  })

  it('prints an exact sign-test p-value and collapses tiny ones', () => {
    const wins = (caseId: string, trialNo: number): EvalTrialResult => ({
      caseId,
      trial: trialNo,
      status: 'completed',
      exitCode: 0,
      timedOut: false,
      grade: { taskSuccess: true, toolSelectionAccuracy: null },
      metrics: METRICS,
    })
    const noWins = buildRun({
      cases: Array.from({ length: 6 }, (_, index) => ({
        caseId: 'c',
        trial: index + 1,
        status: 'completed' as const,
        exitCode: 0,
        timedOut: false,
        grade: { taskSuccess: false, toolSelectionAccuracy: null },
        metrics: METRICS,
      })),
    })
    const allWins = buildRun({
      cases: Array.from({ length: 6 }, (_, index) => wins('c', index + 1)),
    })
    // Six discordant pairs, all one way: raw p = 2 / 2^6 = 0.031. Only the
    // steps and token intervals exist (no judge), so Bonferroni ×3 applies.
    const pRow = compareRuns(noWins, allWins)
      .find(row => row.metric === 'paired task success p (sign test, Bonferroni ×3)')
    expect(pRow?.inference).toBe('0.094 (n=6)')

    const twelve = buildRun({
      cases: Array.from({ length: 12 }, (_, index) => ({
        caseId: 'c',
        trial: index + 1,
        status: 'completed' as const,
        exitCode: 0,
        timedOut: false,
        grade: { taskSuccess: false, toolSelectionAccuracy: null },
        metrics: METRICS,
      })),
    })
    const twelveWins = buildRun({
      cases: Array.from({ length: 12 }, (_, index) => wins('c', index + 1)),
    })
    // Raw 2 / 2^12 is below the print precision, but ×3 is not.
    expect(
      compareRuns(twelve, twelveWins)
        .find(row => row.metric === 'paired task success p (sign test, Bonferroni ×3)')?.inference,
    ).toBe('0.001 (n=12)')

    // Twenty clean sweeps stay below the precision even after ×3.
    const twenty = buildRun({
      cases: Array.from({ length: 20 }, (_, index) => ({
        caseId: 'c', trial: index + 1, status: 'completed' as const,
        exitCode: 0, timedOut: false,
        grade: { taskSuccess: false, toolSelectionAccuracy: null }, metrics: METRICS,
      })),
    })
    const twentyWins = buildRun({
      cases: Array.from({ length: 20 }, (_, index) => wins('c', index + 1)),
    })
    expect(
      compareRuns(twenty, twentyWins)
        .find(row => row.metric === 'paired task success p (sign test, Bonferroni ×3)')?.inference,
    ).toBe('<0.001 (n=20)')
  })

  it('handles unmatched and unmeasured paired trials', () => {
    const plain = (caseId: string, trialNo: number): EvalTrialResult => ({
      caseId,
      trial: trialNo,
      status: 'completed',
      exitCode: 0,
      timedOut: false,
    })
    const a = buildRun({
      cases: [
        plain('c', 1),
        { caseId: 'c', trial: 2, status: 'error', error: 'boom', exitCode: 1, timedOut: false },
        plain('c', 3),
        plain('c', 5),
      ],
    })
    const b = buildRun({
      cases: [
        plain('c', 1),
        plain('c', 3),
        { caseId: 'c', trial: 4, status: 'error', error: 'boom', exitCode: 1, timedOut: false },
      ],
    })
    const paired = pairedCompare(a, b)
    expect(paired?.pairs).toBe(2)
    expect(paired?.stepsDelta).toBeNull()
    const rows = compareRuns(a, b)
    expect(rows.find(row => row.metric === 'paired steps delta (B-A)')).toBeUndefined()
  })

  it('compares pass@k and pass^k derived from the trials', () => {
    const graded = (caseId: string, trialNo: number, passed: boolean): EvalTrialResult => ({
      caseId, trial: trialNo, status: 'completed', exitCode: 0, timedOut: false,
      grade: { taskSuccess: passed, toolSelectionAccuracy: null }, metrics: METRICS,
    })
    const a = buildRun({
      trials: 2,
      cases: [graded('c', 1, true), graded('c', 2, true), graded('d', 1, true), graded('d', 2, true)],
    })
    const b = buildRun({
      trials: 2,
      cases: [graded('c', 1, true), graded('c', 2, false), graded('d', 1, false), graded('d', 2, false)],
    })
    const rows = compareRuns(a, b)
    const byMetric = new Map(rows.map(row => [row.metric, row]))
    expect(byMetric.get('pass@k (task)')).toEqual({
      metric: 'pass@k (task)', a: '100.0%', b: '50.0%', delta: '-50.0pp',
    })
    expect(byMetric.get('pass^k (task)')).toEqual({
      metric: 'pass^k (task)', a: '100.0%', b: '0.0%', delta: '-100.0pp',
    })
    expect(byMetric.get('pass@k (tool-selection)')?.a).toBe('–')
    expect(byMetric.get('judge failures')?.a).toBe('–')
  })

  it('compares judge failure counts when a judge was configured', () => {
    const withJudge = (failures: number) => buildRun({
      judge: { provider: 'p', model: 'j', maxScore: 10 },
      grading: {
        taskSuccessRate: null, toolSelectionAccuracyRate: null,
        finalAnswerScore: 7, hallucinationRate: null, judgeFailures: failures,
      },
    })
    const rows = compareRuns(withJudge(2), withJudge(0))
    expect(rows.find(row => row.metric === 'judge failures')).toEqual({
      metric: 'judge failures', a: '2.0', b: '0.0', delta: '-2.0',
    })
  })
})
