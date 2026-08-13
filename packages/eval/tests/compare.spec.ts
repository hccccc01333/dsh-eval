import { describe, expect, it } from 'vitest'
import { compareRuns, renderCompareMarkdown } from '../src/compare.ts'
import type { EvalRun } from '../src/types.ts'

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

describe('@deepseek-ai/dsh-eval comparison', () => {
  it('builds numeric, rate, and text rows with signed deltas', () => {
    const a = buildRun({
      benchmark: 'base',
      model: 'm1',
      cases: [{ caseId: 'c', trial: 1, status: 'completed', exitCode: 0, timedOut: false, metrics: METRICS }],
      aggregate: { ...METRICS, toolSuccessRate: 1, steps: 2, totalTokens: 10, costUsd: 0.000001, latencyMs: 4 },
      grading: { taskSuccessRate: 0.5, toolSelectionAccuracyRate: 0.8 },
    })
    const b = buildRun({
      benchmark: 'candidate',
      model: 'm2',
      cases: [
        { caseId: 'c', trial: 1, status: 'completed', exitCode: 0, timedOut: false, metrics: METRICS },
        { caseId: 'c', trial: 2, status: 'completed', exitCode: 0, timedOut: false, metrics: METRICS },
      ],
      aggregate: { ...METRICS, toolSuccessRate: 0.9, steps: 4, totalTokens: 20, costUsd: 0.000002, latencyMs: 8 },
      grading: { taskSuccessRate: 0.75, toolSelectionAccuracyRate: 0.6 },
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
})
