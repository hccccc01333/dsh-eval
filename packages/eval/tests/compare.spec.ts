import { describe, expect, it } from 'vitest'
import { compareRuns, pairedCompare, renderCompareMarkdown } from '../src/compare.ts'
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
    expect(byMetric.get('completed trials')).toEqual({ metric: 'completed trials', a: '1.0', b: '2.0', delta: '+1.0' })
    expect(byMetric.get('steps/trial')).toEqual({ metric: 'steps/trial', a: '2.0', b: '4.0', delta: '+2.0' })
    expect(byMetric.get('tool success')).toEqual({ metric: 'tool success', a: '100.0%', b: '90.0%', delta: '-10.0pp' })
    expect(byMetric.get('task success')).toEqual({ metric: 'task success', a: '50.0%', b: '75.0%', delta: '+25.0pp' })
    expect(byMetric.get('cost/trial (USD)')).toEqual({ metric: 'cost/trial (USD)', a: '0.0', b: '0.0', delta: '+0.0' })
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
    expect(paired?.meanStepsDelta).toBeCloseTo(1 / 3, 10)
    expect(paired?.meanTokensDelta).toBeCloseTo(2, 10)
    expect(paired?.meanScoreDelta).toBeCloseTo(0, 10)
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
      delta: '+1.0',
    })
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
    expect(rows.find(row => row.metric === 'paired final-answer delta (B-A)')).toEqual({
      metric: 'paired final-answer delta (B-A)',
      a: '–',
      b: '–',
      delta: '+0.0',
    })
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
    expect(paired?.meanStepsDelta).toBeNull()
    const rows = compareRuns(a, b)
    expect(rows.find(row => row.metric === 'paired steps delta (B-A)')).toBeUndefined()
  })
})
