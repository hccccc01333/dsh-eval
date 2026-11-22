import { describe, expect, it } from 'vitest'
import { evaluateGate, renderGate, renderGateJson, type GateResult } from '../src/gate.ts'
import type { EvalRun } from '../src/types.ts'

function buildRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    benchmark: 'b', model: 'm', createdAt: 1, trials: 1, seed: 0, pricing: null,
    judge: { provider: 'p', model: 'j', maxScore: 10 },
    tempRoot: '/tmp',
    cases: [{
      caseId: 'c', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
      grade: { taskSuccess: true, toolSelectionAccuracy: true },
      judge: { finalAnswerScore: 8, hallucination: false },
    }],
    aggregate: null,
    grading: {
      taskSuccessRate: 1, toolSelectionAccuracyRate: 1,
      finalAnswerScore: 8, hallucinationRate: 0,
    },
    ...overrides,
  }
}

const METRICS = {
  turns: 1, steps: 1, toolCalls: 1, toolResults: 1, toolSuccess: 1, toolSuccessRate: 1,
  invalidToolCalls: 0, retries: 0,
  tokens: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
  totalTokens: 1, contextTokens: 1, llmMs: 1, toolMs: 1, ttftMs: 1,
  latencyMs: 100, costUsd: 0.000002,
}

describe('dsh-eval CI gate', () => {
  it('passes an identical candidate and renders a readable table', () => {
    const result = evaluateGate(buildRun(), buildRun(), 0)
    expect(result.passed).toBe(true)
    expect(result.checks).toHaveLength(6)
    const markdown = renderGate(result)
    expect(markdown).toContain('# Gate: PASS')
    expect(markdown).toContain('| task success | 100.0% | 100.0% | +0.0pp | PASS |')
    expect(markdown).toContain('| completed trials | 1 | 1 | +0 | PASS |')
    expect(markdown).toContain('- max tolerated drop: 0.0 percentage points')
  })

  it('checks relative cost and latency budgets when enabled', () => {
    const baseline = buildRun({ aggregate: METRICS })
    const candidate = buildRun({
      aggregate: { ...METRICS, costUsd: 0.0000022, latencyMs: 110 },
    })
    const result = evaluateGate(baseline, candidate, 0, false, {
      maxCostIncrease: 0.1, maxLatencyIncrease: 0.1,
    })
    expect(result.passed).toBe(true)
    expect(result.checks).toHaveLength(8)
    expect(result.maxCostIncrease).toBe(0.1)
    expect(result.maxLatencyIncrease).toBe(0.1)
    const markdown = renderGate(result)
    expect(markdown).toContain('- max tolerated cost increase: 10.0%')
    expect(markdown).toContain('- max tolerated latency increase: 10.0%')
    expect(markdown).toContain('| cost/trial | $0.000002 | $0.000002 | +10.0% | PASS |')
    expect(markdown).toContain('| latency/trial | 100.0 ms | 110.0 ms | +10.0% | PASS |')
  })

  it('fails when a resource budget is exceeded', () => {
    const result = evaluateGate(
      buildRun({ aggregate: METRICS }),
      buildRun({ aggregate: { ...METRICS, costUsd: 0.000004 } }),
      0, false, { maxCostIncrease: 0.1 },
    )
    expect(result.passed).toBe(false)
    expect(result.checks.at(-1)).toMatchObject({ metric: 'cost/trial', passed: false })
    expect(renderGate(result)).toContain('+100.0% | FAIL |')
  })

  it('skips a budget when the baseline is unpriced and fails when the candidate is', () => {
    const skipped = evaluateGate(buildRun(), buildRun({ aggregate: METRICS }), 0, false, {
      maxCostIncrease: 0.1,
    })
    expect(skipped.passed).toBe(true)
    expect(skipped.checks.at(-1)).toMatchObject({ note: 'baseline metrics unavailable — check skipped', passed: true })
    const failed = evaluateGate(buildRun({ aggregate: METRICS }), buildRun(), 0, false, {
      maxCostIncrease: 0.1,
    })
    expect(failed.passed).toBe(false)
    expect(failed.checks.at(-1)).toMatchObject({ note: 'candidate unpriced', passed: false })
  })

  it('skips a latency budget when the baseline has no metrics', () => {
    const result = evaluateGate(buildRun(), buildRun({ aggregate: METRICS }), 0, false, {
      maxLatencyIncrease: 0.1,
    })
    expect(result.checks.at(-1)).toMatchObject({
      metric: 'latency/trial', note: 'baseline metrics unavailable — check skipped', passed: true,
    })
  })

  it('renders absolute deltas when a zero baseline has no relative value', () => {
    const result = evaluateGate(
      buildRun({ aggregate: { ...METRICS, latencyMs: 0 } }),
      buildRun({ aggregate: { ...METRICS, latencyMs: 0 } }),
      0, false, { maxLatencyIncrease: 0.1 },
    )
    expect(result.passed).toBe(true)
    expect(renderGate(result)).toContain('| 0.0 ms | 0.0 ms | +0.00 | PASS |')
  })

  it('keeps budget checks disabled for null or omitted values', () => {
    const result = evaluateGate(buildRun(), buildRun(), 0, false, {
      maxCostIncrease: null, maxLatencyIncrease: null,
    })
    expect(result.checks).toHaveLength(6)
    expect(result.maxCostIncrease).toBeUndefined()
    expect(result.maxLatencyIncrease).toBeUndefined()
    expect(renderGate(result)).not.toContain('max tolerated cost increase')
  })

  it('confirms a regression only when the paired sign test supports it', () => {
    const cases = (success: boolean) => Array.from({ length: 8 }, (_, index) => ({
      caseId: `c${index + 1}`, trial: 1, status: 'completed' as const,
      exitCode: 0, timedOut: false,
      grade: { taskSuccess: success, toolSelectionAccuracy: null },
    }))
    const grading = (rate: number) => ({
      taskSuccessRate: rate, toolSelectionAccuracyRate: null,
      finalAnswerScore: null, hallucinationRate: null,
    })
    const baseline = buildRun({ cases: cases(true), grading: grading(1) })
    const candidate = buildRun({ cases: cases(false), grading: grading(0) })
    const confirmed = evaluateGate(baseline, candidate, 0.1, false, {}, { requireSignificance: true })
    expect(confirmed.passed).toBe(false)
    expect(confirmed.checks.find(check => check.metric === 'paired significance'))
      .toMatchObject({ passed: true, note: 'all quality metrics assessed independently' })
    expect(confirmed.regressions).toHaveLength(8)

    const baselineMixed = cases(true).map((item, index) => index < 2
      ? { ...item, grade: { taskSuccess: false, toolSelectionAccuracy: null } } : item)
    const candidateWithWins = cases(false).map((item, index) => index < 2
      ? { ...item, grade: { taskSuccess: true, toolSelectionAccuracy: null } } : item)
    const noisy = evaluateGate(
      buildRun({ cases: baselineMixed, grading: grading(6 / 8) }),
      buildRun({ cases: candidateWithWins, grading: grading(2 / 8) }),
      0.1, false, {}, { requireSignificance: true })
    expect(noisy.passed).toBe(true)
    expect(noisy.checks.find(check => check.metric === 'paired significance'))
      .toMatchObject({ passed: true, note: 'all quality metrics assessed independently' })
    expect(noisy.checks.find(check => check.metric === 'task success'))
      .toMatchObject({ passed: true, note: 'drop not statistically confirmed' })
    expect(noisy.regressions).toEqual([])
    expect(renderGate(noisy)).toContain('0.2891')
  })

  it('treats a significant improvement as conclusive non-regression', () => {
    const improved = Array.from({ length: 8 }, (_, index) => ({
      caseId: `i${index + 1}`, trial: 1, status: 'completed' as const,
      exitCode: 0, timedOut: false,
      grade: { taskSuccess: true, toolSelectionAccuracy: null },
    }))
    const regressed = improved.map(item => ({
      ...item, grade: { taskSuccess: false, toolSelectionAccuracy: null },
    }))
    const grading = (rate: number) => ({
      taskSuccessRate: rate, toolSelectionAccuracyRate: null,
      finalAnswerScore: null, hallucinationRate: null,
    })
    const result = evaluateGate(
      buildRun({ cases: regressed, grading: grading(0) }),
      buildRun({ cases: improved, grading: grading(1) }),
      0.1, false, {}, { requireSignificance: true },
    )
    expect(result.passed).toBe(true)
    expect(result.checks.find(check => check.metric === 'paired significance'))
      .toMatchObject({ passed: true, note: 'all quality metrics assessed independently' })
    expect(result.checks.find(check => check.metric === 'task success')?.passed).toBe(true)
  })

  it('does not inflate the correction family with duplicate or ungraded metrics', () => {
    const baseCases = Array.from({ length: 9 }, (_, index) => ({
      caseId: `n${index + 1}`, trial: 1, status: 'completed' as const,
      exitCode: 0, timedOut: false,
      grade: { taskSuccess: true, toolSelectionAccuracy: null },
    }))
    const flipped = baseCases.map((item, index) => index < 8
      ? { ...item, grade: { taskSuccess: false, toolSelectionAccuracy: null } }
      : { ...item, grade: { taskSuccess: true, toolSelectionAccuracy: null } })
    const baselineCases = baseCases.map((item, index) => index < 8
      ? item : { ...item, grade: { taskSuccess: false, toolSelectionAccuracy: null } })
    const grading = (rate: number) => ({
      taskSuccessRate: rate, toolSelectionAccuracyRate: null,
      finalAnswerScore: null, hallucinationRate: null,
    })
    const result = evaluateGate(
      buildRun({ cases: baselineCases, grading: grading(8 / 9) }),
      buildRun({ cases: flipped, grading: grading(1 / 9) }),
      0.1, false, {}, { requireSignificance: true },
    )
    expect(result.passed).toBe(false)
    expect(result.checks.find(check => check.metric === 'paired significance'))
      .toMatchObject({ passed: true, note: 'all quality metrics assessed independently' })
    expect(result.checks.find(check => check.metric === 'task success')?.passed).toBe(false)
  })

  it('fails closed when paired trials have no discordant outcomes', () => {
    const tied = Array.from({ length: 8 }, (_, index) => ({
      caseId: `t${index + 1}`, trial: 1, status: 'completed' as const,
      exitCode: 0, timedOut: false,
      grade: { taskSuccess: true, toolSelectionAccuracy: null },
    }))
    const grading = (rate: number) => ({
      taskSuccessRate: rate, toolSelectionAccuracyRate: null,
      finalAnswerScore: null, hallucinationRate: null,
    })
    const result = evaluateGate(
      buildRun({ cases: tied, grading: grading(1) }),
      buildRun({ cases: tied, grading: grading(0.5) }),
      0.1, false, {}, { requireSignificance: true },
    )
    expect(result.passed).toBe(false)
    expect(result.checks.find(check => check.metric === 'paired significance'))
      .toMatchObject({ passed: false, note: 'some quality metrics lack conclusive paired evidence' })
  })

  it('assesses each quality metric independently under significance mode', () => {
    const cases = (tool: boolean, score: number) => Array.from({ length: 10 }, (_, index) => ({
      caseId: `c${index + 1}`, trial: 1, status: 'completed' as const,
      exitCode: 0, timedOut: false,
      grade: { taskSuccess: true, toolSelectionAccuracy: tool },
      judge: { finalAnswerScore: score, hallucination: false },
    }))
    const grading = (toolRate: number, score: number) => ({
      taskSuccessRate: 1, toolSelectionAccuracyRate: toolRate,
      finalAnswerScore: score, hallucinationRate: 0,
    })
    const result = evaluateGate(
      buildRun({ cases: cases(true, 8), grading: grading(1, 8) }),
      buildRun({ cases: cases(false, 2), grading: grading(0.2, 2) }),
      0.1, false, {}, { requireSignificance: true },
    )
    expect(result.passed).toBe(false)
    expect(result.checks.find(check => check.metric === 'task success')?.passed).toBe(true)
    expect(result.checks.find(check => check.metric === 'tool selection')?.passed).toBe(false)
    expect(result.checks.find(check => check.metric === 'judge score')?.passed).toBe(false)
    expect((result.regressions ?? []).map(regression => regression.metric)).toEqual(
      expect.arrayContaining(['tool selection', 'judge score']),
    )
  })

  it('fails closed when significance cannot be established', () => {
    const grading = (rate: number) => ({
      taskSuccessRate: rate, toolSelectionAccuracyRate: null,
      finalAnswerScore: null, hallucinationRate: null,
    })
    const one = buildRun({
      cases: [{
        caseId: 'a', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
        grade: { taskSuccess: true, toolSelectionAccuracy: null },
      }], grading: grading(1),
    })
    const other = buildRun({
      ...one, cases: [{
        caseId: 'b', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
        grade: { taskSuccess: false, toolSelectionAccuracy: null },
      }], grading: grading(0),
    })
    const unpaired = evaluateGate(one, other, 0.1, false, {}, { requireSignificance: true })
    expect(unpaired.checks.find(check => check.metric === 'paired significance'))
      .toMatchObject({ passed: false, note: 'some quality metrics lack conclusive paired evidence' })

    const four = (success: boolean) => Array.from({ length: 4 }, (_, index) => ({
      caseId: `c${index + 1}`, trial: 1, status: 'completed' as const,
      exitCode: 0, timedOut: false,
      grade: { taskSuccess: success, toolSelectionAccuracy: null },
    }))
    const underpowered = evaluateGate(
      buildRun({ cases: four(true), grading: grading(1) }),
      buildRun({ cases: four(false), grading: grading(0) }),
      0.1, false, {}, { requireSignificance: true },
    )
    expect(underpowered.checks.find(check => check.metric === 'paired significance'))
      .toMatchObject({ passed: false, note: 'some quality metrics lack conclusive paired evidence' })

    const ungraded = evaluateGate(buildRun({ grading: null, cases: [] }),
      buildRun({ grading: null, cases: [] }),
      0.1, false, {}, { requireSignificance: true })
    expect(ungraded.checks.find(check => check.metric === 'paired significance')?.passed).toBe(true)
  })

  it('does not let survivor-only evidence excuse a strict pass@1 collapse', () => {
    const grading = (rate: number) => ({
      taskSuccessRate: rate, toolSelectionAccuracyRate: null,
      finalAnswerScore: null, hallucinationRate: null,
    })
    const baseline = buildRun({
      trials: 108,
      cases: Array.from({ length: 108 }, (_, index) => ({
        caseId: `c${index + 1}`, trial: 1, status: 'completed' as const,
        exitCode: 0, timedOut: false,
        grade: { taskSuccess: true, toolSelectionAccuracy: null },
      })),
      grading: grading(1),
    })
    const candidate = buildRun({
      trials: 108,
      cases: [
        ...Array.from({ length: 8 }, (_, index) => ({
          caseId: `c${index + 1}`, trial: 1, status: 'completed' as const,
          exitCode: 0, timedOut: false,
          grade: { taskSuccess: true, toolSelectionAccuracy: null },
        })),
        ...Array.from({ length: 100 }, (_, index) => ({
          caseId: `c${index + 9}`, trial: 1, status: 'error' as const,
          exitCode: 1, timedOut: false, error: 'boom',
        })),
      ],
      grading: grading(1),
    })
    const result = evaluateGate(baseline, candidate, 0.005, true, {}, { requireSignificance: true })
    expect(result.checks.find(check => check.metric === 'strict pass@1 (task)'))
      .toMatchObject({ passed: false })
    expect(result.passed).toBe(false)
  })

  it('emits a machine-readable verdict with the same numbers', () => {
    const result = evaluateGate(
      buildRun({ aggregate: METRICS }),
      buildRun({ aggregate: { ...METRICS, costUsd: 0.000004 } }),
      0.05, false, { maxCostIncrease: 0.1, maxLatencyIncrease: 0.2 },
    )
    const parsed = JSON.parse(renderGateJson(result)) as {
      passed: boolean; maxDrop: number; maxCostIncrease?: number; maxLatencyIncrease?: number
      checks: { metric: string }[]; regressions: unknown[]
    }
    expect(parsed.passed).toBe(false)
    expect(parsed.maxDrop).toBe(0.05)
    expect(parsed.maxCostIncrease).toBe(0.1)
    expect(parsed.maxLatencyIncrease).toBe(0.2)
    expect(parsed.checks.map(check => check.metric)).toContain('cost/trial')
    expect(parsed.regressions).toEqual([])
    const plain = JSON.parse(renderGateJson(evaluateGate(buildRun(), buildRun(), 0))) as Record<string, unknown>
    expect(plain.maxCostIncrease).toBeUndefined()
    expect(plain.maxLatencyIncrease).toBeUndefined()
    const minimal = JSON.parse(renderGateJson({ passed: true, maxDrop: 0, checks: [] })) as {
      regressions: unknown[]
    }
    expect(minimal.regressions).toEqual([])
  })

  it('fails when a rate drops beyond the tolerance', () => {
    const candidate = buildRun({
      cases: [{
        caseId: 'c', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
        grade: { taskSuccess: false, toolSelectionAccuracy: false },
        judge: { finalAnswerScore: 6, hallucination: false },
      }],
      grading: {
        taskSuccessRate: 0.8, toolSelectionAccuracyRate: 0.5,
        finalAnswerScore: 6, hallucinationRate: 0,
      },
    })
    const result = evaluateGate(buildRun(), candidate, 0.1)
    expect(result.passed).toBe(false)
    expect(result.checks.map(check => [check.metric, check.passed])).toEqual([
      ['completed trials', true], ['unscored trials', true],
      ['task success', false], ['tool selection', false],
      ['strict pass@1 (task)', false], ['judge score', false],
    ])
    expect(renderGate(result)).toContain('# Gate: FAIL')
  })

  it('tolerates a drop within the tolerance', () => {
    const candidate = buildRun({
      grading: {
        taskSuccessRate: 0.95, toolSelectionAccuracyRate: 1,
        finalAnswerScore: 7.5, hallucinationRate: 0,
      },
    })
    expect(evaluateGate(buildRun(), candidate, 0.1).passed).toBe(true)
  })

  it('treats missing grades explicitly instead of guessing', () => {
    const { judge: _judge, ...ungraded } = buildRun({ grading: null })
    const fromNull = evaluateGate(ungraded, buildRun(), 0)
    expect(fromNull.checks[2]).toMatchObject({ passed: true, note: 'baseline ungraded' })
    const toNull = evaluateGate(buildRun(), ungraded, 0)
    expect(toNull.checks[2]).toMatchObject({ passed: false, note: 'candidate ungraded' })
    expect(toNull.checks[5]).toMatchObject({ passed: false, note: 'candidate ungraded' })
    expect(renderGate(toNull)).toContain('candidate ungraded')
    // A judge score without a maxScore cannot be normalized.
    const noMax = buildRun({ judge: { provider: 'p', model: 'j', maxScore: 0 } })
    expect(evaluateGate(noMax, noMax, 0).checks[5]!.note).toBe('baseline ungraded')
  })

  it('flags extra unscored trials unless explicitly allowed', () => {
    const incomplete = buildRun({
      cases: [{ caseId: 'c', trial: 1, status: 'error', error: 'boom', exitCode: 1, timedOut: false }],
      grading: null,
    })
    const strict = evaluateGate(buildRun(), incomplete, 0)
    expect(strict.checks[0]!).toMatchObject({ passed: false, note: 'expected at least 1' })
    expect(strict.checks[1]!).toMatchObject({ passed: false, note: 'expected at most 0' })
    const relaxed = evaluateGate(buildRun(), incomplete, 0, true)
    expect(relaxed.checks).toHaveLength(4)
    expect(relaxed.checks[0]!.metric).toBe('task success')
  })

  it('names the paired cases that got worse', () => {
    const grading = {
      taskSuccessRate: 1, toolSelectionAccuracyRate: 1,
      finalAnswerScore: 8, hallucinationRate: 0,
    }
    const baseline = buildRun({
      grading,
      cases: [{
        caseId: 'c|x\nnext', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
        grade: { taskSuccess: true, toolSelectionAccuracy: true },
        judge: { finalAnswerScore: 8, hallucination: false },
      }],
    })
    const candidate = buildRun({
      grading,
      cases: [{
        caseId: 'c|x\nnext', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
        grade: { taskSuccess: false, toolSelectionAccuracy: false },
        judge: { finalAnswerScore: 3, hallucination: false },
      }, {
        caseId: 'unpaired', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
        grade: { taskSuccess: false, toolSelectionAccuracy: false },
        judge: { finalAnswerScore: 0, hallucination: false },
      }],
    })
    const result = evaluateGate(baseline, candidate, 0.1, true)
    expect(result.regressions!.map(item => item.metric)).toEqual([
      'task success', 'tool selection', 'judge score',
    ])
    const markdown = renderGate(result)
    expect(markdown).toContain('- case regressions: 3 paired trial(s) got worse (showing up to 5)')
    expect(markdown).toContain('c x next #1: task success 100.0% → 0.0%')
    expect(markdown).toContain('c x next #1: judge score 80.0% → 30.0%')
    expect(markdown).not.toContain('unpaired #1')
    // Score drops inside the tolerance are not regressions; null scores are skipped.
    const tinyDrop = buildRun({
      grading,
      cases: [
        {
          caseId: 'c|x\nnext', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
          grade: { taskSuccess: true, toolSelectionAccuracy: true },
          judge: { finalAnswerScore: 7.5, hallucination: false },
        },
        {
          caseId: 'c|x\nnext', trial: 2, status: 'completed', exitCode: 0, timedOut: false,
          grade: { taskSuccess: true, toolSelectionAccuracy: true },
          judge: { finalAnswerScore: null, hallucination: null },
        },
      ],
    })
    const withTrialTwo = buildRun({
      grading,
      cases: [...baseline.cases, {
        caseId: 'c|x\nnext', trial: 2, status: 'completed', exitCode: 0, timedOut: false,
        grade: { taskSuccess: true, toolSelectionAccuracy: true },
        judge: { finalAnswerScore: 8, hallucination: false },
      }],
    })
    expect(evaluateGate(withTrialTwo, tinyDrop, 0.1, true).regressions).toEqual([])

    // A run without a judge configuration cannot normalize per-case scores.
    const { judge: _judge, ...unconfigured } = withTrialTwo
    const withoutVerdicts = {
      ...unconfigured,
      cases: unconfigured.cases.map(({ judge: _verdict, ...rest }) => rest),
    }
    expect(evaluateGate(withoutVerdicts, withoutVerdicts, 0.1, true).regressions).toEqual([])
    const zeroMax = buildRun({ judge: { provider: 'p', model: 'j', maxScore: 0 }, grading })
    expect(evaluateGate(zeroMax, zeroMax, 0.1, true).regressions).toEqual([])
  })

  it('renders a null delta and negative integer deltas', () => {
    const result: GateResult = {
      passed: false,
      maxDrop: 0.05,
      regressions: [],
      checks: [
        { metric: 'n/a', baseline: null, candidate: null, delta: null, passed: true },
        { metric: 'fewer', baseline: 3, candidate: 1, delta: -2, passed: true, unit: 'count' },
      ],
    }
    const markdown = renderGate(result)
    expect(markdown).toContain('| n/a | – | – | – | PASS |')
    expect(markdown).toContain('| fewer | 3 | 1 | -2 | PASS |')
    expect(renderGate({ passed: true, maxDrop: 0, checks: [] })).not.toContain('case regressions')
  })
})
