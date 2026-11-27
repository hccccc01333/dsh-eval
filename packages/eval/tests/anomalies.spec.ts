import { describe, expect, it } from 'vitest'
import { computeAnomalies } from '../src/anomalies.ts'
import type { TrialAnomaly } from '../src/anomalies.ts'
import type { EvalCaseMetrics, EvalRun, EvalTrialResult } from '../src/types.ts'

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

/** All required EvalCaseMetrics fields, with neutral values for every anomaly metric. */
const BASE_METRICS: EvalCaseMetrics = {
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
  latencyMs: 100,
  costUsd: 0.000001,
}

function measure(overrides: Partial<EvalCaseMetrics> = {}): EvalCaseMetrics {
  return { ...BASE_METRICS, ...overrides }
}

function trial(
  caseId: string,
  trialNo: number,
  overrides: Partial<EvalCaseMetrics> = {},
): EvalTrialResult {
  return {
    caseId,
    trial: trialNo,
    status: 'completed',
    exitCode: 0,
    timedOut: false,
    metrics: measure(overrides),
  }
}

/** Six evenly spread values keep Q1/Q3 non-integer so quantile interpolation runs. */
const SPREAD = [100, 110, 120, 130, 140, 160]

describe('dsh-eval anomaly detection', () => {
  it('returns no findings when a larger sample sits inside every fence', () => {
    const run = buildRun({
      cases: SPREAD.map((latencyMs, index) => trial('c', index + 1, { latencyMs })),
    })
    expect(computeAnomalies(run)).toEqual([])
  })

  it('flags a single trial far above the upper fence and reports the fence in why', () => {
    const run = buildRun({
      cases: [100, 110, 120, 130, 140, 5000]
        .map((latencyMs, index) => trial('c', index + 1, { latencyMs })),
    })
    expect(computeAnomalies(run)).toEqual([{
      caseId: 'c', trial: 6, metric: 'latencyMs', value: 5000,
      why: 'latencyMs 5000 outside [75, 175]',
    }])
    const [anomaly] = computeAnomalies(run)
    expect(anomaly?.why).toContain('latencyMs')
    expect(anomaly?.why).toContain('175')
  })

  it('flags a value below the lower fence', () => {
    const run = buildRun({
      cases: [10, 11, 12, 13, 14, 0]
        .map((retries, index) => trial('c', index + 1, { retries })),
    })
    expect(computeAnomalies(run)).toEqual([{
      caseId: 'c', trial: 6, metric: 'retries', value: 0,
      why: 'retries 0 outside [7, 17]',
    }])
  })

  it('reports several metrics at once, sorted by case id, trial and metric', () => {
    const run = buildRun({
      cases: [
        // Same case and trial with two anomalous metrics: exercises metric ordering.
        trial('b', 2, { latencyMs: 5000, totalTokens: 90000, retries: 2 }),
        // Same case, different trial: exercises trial ordering. Metrics after a
        // "b" anomaly also force the ascending case-id comparison path.
        trial('a', 1, { latencyMs: 100, totalTokens: 10, steps: 500, retries: 1 }),
        trial('a', 2, { latencyMs: 110, totalTokens: 11, retries: 100 }),
        trial('c', 1, { latencyMs: 120, totalTokens: 12, retries: 3 }),
        trial('c', 2, { latencyMs: 130, totalTokens: 13, steps: 3, retries: 4 }),
        trial('c', 3, { latencyMs: 140, totalTokens: 14, retries: 5 }),
      ],
    })
    const anomalies = computeAnomalies(run)
    expect(anomalies.map(item => [item.caseId, item.trial, item.metric])).toEqual([
      ['a', 1, 'steps'],
      ['a', 2, 'retries'],
      ['b', 2, 'latencyMs'],
      ['b', 2, 'totalTokens'],
    ])
    expect(anomalies.every(item => item.why.includes(item.metric))).toBe(true)
  })

  it('produces nothing with fewer than five usable samples', () => {
    const run = buildRun({
      cases: [100, 110, 120, 130].map((latencyMs, index) => trial('c', index + 1, { latencyMs })),
    })
    expect(computeAnomalies(run)).toEqual([])
  })

  it('produces nothing when every value is identical (zero IQR)', () => {
    const run = buildRun({
      cases: Array.from({ length: 5 }, (_, index) => trial('c', index + 1)),
    })
    expect(computeAnomalies(run)).toEqual([])
  })

  it('ignores error trials and completed trials that carry no metrics', () => {
    const run = buildRun({
      cases: [
        ...[100, 110, 120, 130, 140].map((latencyMs, index) => trial('c', index + 1, { latencyMs })),
        { caseId: 'c', trial: 6, status: 'error', error: 'boom', exitCode: 1, timedOut: false,
          metrics: measure({ latencyMs: 99999 }) },
        { caseId: 'c', trial: 7, status: 'completed', exitCode: 0, timedOut: false },
      ],
    })
    expect(computeAnomalies(run)).toEqual([])
  })

  it('treats values exactly on either fence as inliers', () => {
    const run = buildRun({
      cases: [7, 10, 11, 12, 15]
        .map((latencyMs, index) => trial('c', index + 1, { latencyMs })),
    })
    // Q1 = 10, Q3 = 12, IQR = 2, so the fences are [7, 15] exactly.
    expect(computeAnomalies(run)).toEqual([])
  })

  it('tolerates a completed trial whose metrics vanish after the initial filter', () => {
    // metricOf's defensive null branch cannot be reached with plain objects:
    // computeAnomalies filters out results without metrics first. A getter that
    // stops returning metrics after the filter exercises that guard directly.
    const flaky: EvalTrialResult = {
      caseId: 'c', trial: 6, status: 'completed', exitCode: 0, timedOut: false,
      metrics: measure(),
    }
    let reads = 0
    Object.defineProperty(flaky, 'metrics', {
      configurable: true,
      get: () => (++reads === 1 ? measure() : undefined),
    })
    const run = buildRun({
      cases: [
        ...[100, 110, 120, 130, 140].map((latencyMs, index) => trial('c', index + 1, { latencyMs })),
        flaky,
      ],
    })
    expect(computeAnomalies(run)).toEqual([])
    expect(reads).toBeGreaterThan(1)
  })

  it('is deterministic across repeated calls with the same input', () => {
    const run = buildRun({
      cases: [
        trial('b', 2, { latencyMs: 5000 }),
        trial('a', 2, { steps: 500 }),
        trial('a', 1, { totalTokens: 90000 }),
        trial('c', 1, { latencyMs: 110 }),
        trial('c', 2, { latencyMs: 120 }),
        trial('c', 3, { latencyMs: 130 }),
      ],
    })
    const first: TrialAnomaly[] = computeAnomalies(run)
    const second: TrialAnomaly[] = computeAnomalies(run)
    expect(first.length).toBeGreaterThan(0)
    expect(second).toEqual(first)
  })
})
