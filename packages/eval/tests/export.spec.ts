import { describe, expect, it } from 'vitest'
import { renderTrialsCsv } from '../src/export.ts'
import type { EvalRun } from '../src/types.ts'

const METRICS = {
  turns: 1, steps: 2, toolCalls: 3, toolResults: 3, toolSuccess: 2, toolSuccessRate: 2 / 3,
  invalidToolCalls: 0, retries: 1,
  tokens: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 4 },
  totalTokens: 14, contextTokens: 1000, llmMs: 20, toolMs: 30, ttftMs: 5,
  latencyMs: 55, costUsd: 0.000123,
}

function run(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    benchmark: 'b', model: 'm', createdAt: 1, trials: 1, seed: 0, pricing: null,
    tempRoot: '/tmp', cases: [], aggregate: null, grading: null,
    ...overrides,
  }
}

describe('dsh-eval trial export', () => {
  it('emits a header and one escaped row per trial', () => {
    const csv = renderTrialsCsv(run({
      cases: [{
        caseId: 'a,"quoted"\nnext', trial: 2, status: 'completed', exitCode: 0, timedOut: false,
        metrics: METRICS,
        grade: { taskSuccess: true, toolSelectionAccuracy: false },
        judge: { finalAnswerScore: 8, hallucination: false, judgeError: 'boom, again' },
        traceSha256: 'f'.repeat(64),
      }],
    }))
    const lines = csv.trimEnd().split('\r\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('caseId,trial,status')
    expect(lines[0]).toContain('traceSha256')
    expect(lines[0]!.endsWith(',tags')).toBe(true)
    expect(lines[1]).toContain('"a,""quoted""\nnext"')
    expect(lines[1]).toContain('"boom, again"')
    expect(lines[1]).toContain(',2,completed,0,false,')
    expect(lines[1]).toContain(',true,false,8,false,')
    expect(lines[1]).toContain(',2,3,2,0,1,10,4,14,0.000123,55,20,30,5,')
    expect(lines[1]!.endsWith(`${'f'.repeat(64)},`)).toBe(true)
  })

  it('serializes case tags as a parseable JSON array', () => {
    const csv = renderTrialsCsv(run({
      cases: [{
        caseId: 'tagged', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
        tags: ['hard', 'ts'],
      }],
    }))
    expect(csv).toContain('"[""hard"",""ts""]"')
  })

  it('neutralizes spreadsheet formulas in agent-controlled strings', () => {
    const csv = renderTrialsCsv(run({
      cases: [{
        caseId: '=HYPERLINK("http://evil")', trial: 1, status: 'error',
        error: '+cmd|calc', exitCode: 1, timedOut: false,
      }, {
        caseId: 'second', trial: 2, status: 'error',
        error: '\n=1+1', exitCode: 1, timedOut: false,
      }],
    }))
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`)
    expect(csv).toContain(`,'+cmd|calc,`)
    expect(csv).toContain("\"'\n=1+1\"")
  })

  it('writes an empty header for a run without trials', () => {
    expect(renderTrialsCsv(run()).trim()).toBe(
      renderTrialsCsv(run()).trim().split('\r\n')[0],
    )
  })
})
