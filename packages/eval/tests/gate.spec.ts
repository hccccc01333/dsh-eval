import { describe, expect, it } from 'vitest'
import { evaluateGate, renderGate, type GateResult } from '../src/gate.ts'
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

  it('renders a null delta and negative integer deltas', () => {
    const result: GateResult = {
      passed: false,
      maxDrop: 0.05,
      checks: [
        { metric: 'n/a', baseline: null, candidate: null, delta: null, passed: true },
        { metric: 'fewer', baseline: 3, candidate: 1, delta: -2, passed: true, unit: 'count' },
      ],
    }
    const markdown = renderGate(result)
    expect(markdown).toContain('| n/a | – | – | – | PASS |')
    expect(markdown).toContain('| fewer | 3 | 1 | -2 | PASS |')
  })
})
