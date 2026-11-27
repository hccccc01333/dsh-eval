import { describe, expect, it } from 'vitest'
import {
  compareSegments, renderSegmentComparison, renderSegmentComparisonJson,
} from '../src/segment-compare.ts'
import type { EvalRun, EvalTrialResult } from '../src/types.ts'

function run(cases: EvalTrialResult[]): EvalRun {
  return {
    benchmark: 'b', model: 'm', createdAt: 1, trials: cases.length, seed: 0,
    pricing: null, tempRoot: '/tmp', cases, aggregate: null, grading: null,
  }
}

function trial(id: string, overrides: Partial<EvalTrialResult>): EvalTrialResult {
  return { caseId: id, trial: 1, status: 'completed', exitCode: 0, timedOut: false, ...overrides }
}

function scored(tags: string[], taskSuccess: boolean, judgeScore: number): EvalTrialResult {
  return trial(tags.join('-'), {
    tags,
    grade: { taskSuccess, toolSelectionAccuracy: null },
    judge: { finalAnswerScore: judgeScore, hallucination: false },
  })
}

describe('compareSegments', () => {
  it('returns no rows when neither run carries tags', () => {
    expect(compareSegments(run([trial('a', {})]), run([trial('b', {})]))).toEqual([])
  })

  it('aligns tags and computes positive, negative and zero deltas', () => {
    const before = run([
      scored(['hard', 'ts'], false, 4),
      scored(['easy'], true, 9),
    ])
    const after = run([
      scored(['hard', 'ts'], true, 6),
      scored(['easy'], true, 9),
    ])
    const deltas = compareSegments(before, after)
    expect(deltas.map(item => item.tag)).toEqual(['easy', 'hard', 'ts'])
    expect(deltas[0]?.taskSuccessDelta).toBe(0)
    expect(deltas[0]?.judgeScoreDelta).toBe(0)
    expect(deltas[1]?.taskSuccessDelta).toBe(1)
    expect(deltas[1]?.judgeScoreDelta).toBe(2)
  })

  it('keeps tags present in only one run with null deltas', () => {
    const before = run([scored(['old'], true, 5)])
    const after = run([scored(['new'], false, 3)])
    const deltas = compareSegments(before, after)
    expect(deltas.map(item => item.tag)).toEqual(['new', 'old'])
    expect(deltas[0]?.baseline).toBeNull()
    expect(deltas[0]?.taskSuccessDelta).toBeNull()
    expect(deltas[1]?.candidate).toBeNull()
    expect(deltas[1]?.judgeScoreDelta).toBeNull()
  })

  it('reports null deltas for dimensions without verdicts', () => {
    const deltas = compareSegments(
      run([trial('a', { tags: ['x'] })]),
      run([trial('b', { tags: ['x'] })]),
    )
    expect(deltas[0]?.taskSuccessDelta).toBeNull()
    expect(deltas[0]?.judgeScoreDelta).toBeNull()
  })
})

describe('renderSegmentComparison', () => {
  it('renders a markdown table with signed deltas and escaped tags', () => {
    const deltas = compareSegments(
      run([trial('a|`b\n`', { tags: ['hard|`evil\n'], grade: { taskSuccess: false, toolSelectionAccuracy: null } })]),
      run([trial('a', { tags: ['hard|`evil\n'], grade: { taskSuccess: true, toolSelectionAccuracy: null } })]),
    )
    const markdown = renderSegmentComparison(deltas)
    expect(markdown).toContain('## Segment comparison')
    expect(markdown).toContain('| hard  evil  | 0.0% | 100.0% | +100.0pp | – | – | – | – |')
  })

  it('strips terminal control bytes from hostile tags', () => {
    const tag = 'hard\u001b[2Jevil'
    const deltas = compareSegments(
      run([scored([tag], true, 5)]), run([scored([tag], true, 5)]),
    )
    const markdown = renderSegmentComparison(deltas)
    expect(markdown).toContain('hard ')
    // Table line breaks are the only control bytes in the rendered text.
    expect(markdown.replace(/\n/gu, '')).not.toMatch(/[\u001b\u0000-\u001f]/u)
  })

  it('renders dashes for dimensions missing from one side', () => {
    const deltas = compareSegments(
      run([scored(['only-before'], true, 7)]),
      run([scored(['only-after'], false, 2)]),
    )
    const markdown = renderSegmentComparison(deltas)
    expect(markdown).toContain('| only-after | – | 0.0% | – | – | 2.0 | – | – |')
    expect(markdown).toContain('| only-before | 100.0% | – | – | 7.0 | – | – | – |')
  })

  it('renders negative score deltas and machine-readable JSON', () => {
    const deltas = compareSegments(
      run([scored(['hard'], true, 8)]),
      run([scored(['hard'], false, 5)]),
    )
    const markdown = renderSegmentComparison(deltas)
    expect(markdown).toContain('-100.0pp')
    expect(markdown).toContain('-3.0 |')
    const json = JSON.parse(renderSegmentComparisonJson(deltas))
    expect(json[0]).toMatchObject({
      tag: 'hard', taskSuccessDelta: -1, judgeScoreDelta: -3, judgeScoreRateDelta: null,
    })
  })

  it('reports normalized score deltas when both runs record a judge scale', () => {
    const before = run([scored(['hard'], true, 8)])
    const after = run([scored(['hard'], true, 60)])
    before.judge = { provider: 'p', model: 'j1', maxScore: 10 }
    after.judge = { provider: 'p', model: 'j2', maxScore: 100 }
    const deltas = compareSegments(before, after)
    expect(deltas[0]?.judgeScoreDelta).toBe(52)
    expect(deltas[0]?.judgeScoreRateDelta).toBeCloseTo(-0.2, 10)
    expect(renderSegmentComparison(deltas)).toContain('-20.0pp')
  })
})
