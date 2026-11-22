import { describe, expect, it } from 'vitest'
import { computePrecision } from '../src/precision.ts'
import type { EvalRun, EvalTrialResult } from '../src/types.ts'

const METRICS = {
  turns: 1,
  steps: 2,
  toolCalls: 1,
  toolResults: 1,
  toolSuccess: 1,
  toolSuccessRate: 1,
  invalidToolCalls: 0,
  retries: 0,
  tokens: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
  totalTokens: 10,
  contextTokens: 10,
  llmMs: 1,
  toolMs: 2,
  ttftMs: 3,
  latencyMs: 100,
  costUsd: null,
}

function trial(
  trialNo: number,
  taskSuccess: boolean | null,
  toolSelection: boolean | null,
  latencyMs?: number,
): EvalTrialResult {
  return {
    caseId: 'c',
    trial: trialNo,
    status: 'completed',
    exitCode: 0,
    timedOut: false,
    ...(taskSuccess === null ? {} : { grade: { taskSuccess, toolSelectionAccuracy: toolSelection } }),
    metrics: { ...METRICS, ...(latencyMs === undefined ? {} : { latencyMs }) },
  }
}

function run(cases: readonly EvalTrialResult[], seed = 0): EvalRun {
  return {
    benchmark: 'b', model: 'm', createdAt: 1, trials: cases.length, seed,
    pricing: null, tempRoot: '/tmp', cases: [...cases], aggregate: null, grading: null,
  }
}

describe('dsh-eval single-run precision', () => {
  it('bootstraps graded rates and reports latency percentiles', () => {
    const summary = computePrecision(run([
      trial(1, true, true, 100), trial(2, false, true, 200),
      trial(3, true, false, 300), trial(4, true, true, 400),
    ]))
    expect(summary.task).toMatchObject({ trials: 4, rate: 0.75 })
    expect(summary.task?.lower).toBeGreaterThanOrEqual(0.25)
    expect(summary.task?.upper).toBeLessThanOrEqual(1)
    expect(summary.toolSelection).toMatchObject({ trials: 4, rate: 0.75 })
    expect(summary.strictPassAt1).toMatchObject({ trials: 4, rate: 0.75 })
    expect(summary.latencyP50).toBe(250)
    expect(summary.latencyP95).toBeCloseTo(385, 5)
  })

  it('leaves intervals open for a single trial and omits absent data', () => {
    const single = computePrecision(run([trial(1, true, null, 50)]))
    expect(single.task).toEqual({ trials: 1, rate: 1, lower: null, upper: null })
    expect(single.toolSelection).toBeNull()
    expect(single.strictPassAt1).toEqual({ trials: 1, rate: 1, lower: null, upper: null })
    expect(single.latencyP50).toBe(50)
    const empty = computePrecision(run([]))
    expect(empty).toEqual({
      task: null, toolSelection: null, strictPassAt1: null, latencyP50: null, latencyP95: null,
    })
    const unmeasured = computePrecision(run([{
      caseId: 'c', trial: 1, status: 'error', error: 'boom', exitCode: 1, timedOut: false,
    }]))
    expect(unmeasured).toEqual({
      task: null, toolSelection: null, strictPassAt1: null, latencyP50: null, latencyP95: null,
    })
  })

  it('seeds the interval from the run and honours an override', () => {
    const trials = [trial(1, true, true), trial(2, false, false), trial(3, true, false)]
    const first = computePrecision(run(trials, 42))
    const again = computePrecision(run(trials, 42))
    expect(first.task).toEqual(again.task)
    // An explicit override replaces the run seed rather than compounding it.
    expect(computePrecision(run(trials, 42), { seed: 7 }).task)
      .toEqual(computePrecision(run(trials, 7)).task)
  })
})
