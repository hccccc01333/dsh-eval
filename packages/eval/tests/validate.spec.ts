import { describe, expect, it } from 'vitest'
import type { Benchmark } from '../src/types.ts'
import { renderBenchmarkJson, renderBenchmarkSummary, summarizeBenchmark } from '../src/validate.ts'

function benchmark(overrides: Partial<Benchmark> = {}): Benchmark {
  return {
    name: 'smoke', model: 'm', profile: 'headless',
    command: ['dsh'], trials: 1, concurrency: 1, timeoutMs: 1000, seed: 7,
    cases: [{
      id: 'c', prompt: 'p',
      expected: {
        tools: ['bash'], checkArgv: ['true'], answer: '42',
      },
      },
      { id: 'legacy', prompt: 'p', expected: { check: 'true' } },
    ],
    baseDir: '/tmp',
    ...overrides,
  }
}

describe('dsh-eval benchmark preflight', () => {
  it('summarizes a fully configured benchmark without warnings', () => {
    const summary = renderBenchmarkSummary(benchmark({
      judge: { provider: 'p', model: 'j', maxScore: 10 },
      pricing: { m: { inputUsdPerMTokens: 1, cacheReadUsdPerMTokens: 1, cacheWriteUsdPerMTokens: 1, outputUsdPerMTokens: 1 } },
    }))
    expect(summary).toContain('# Benchmark: smoke')
    expect(summary).toContain('- profile: headless')
    expect(summary).toContain('- timeout: 1000 ms')
    expect(summary).toContain('- seed: 7 (trial n receives DSH_EVAL_SEED = 7 + n - 1)')
    expect(summary).toContain('- cases: 2 (2 graded, 1 with gold answers)')
    expect(summary).toContain('- expectations: 2 check(s), 1 tool constraint(s)')
    expect(summary).toContain('- judge: j on p (max 10)')
    expect(summary).toContain('- replay: live')
    expect(summary).toContain('- pricing: configured')
    expect(summary).toContain('Validated: smoke is ready to run.')
    expect(summary).not.toContain('## Warnings')
  })

  it('warns about weak evidence and unsafe shell checks', () => {
    const summary = renderBenchmarkSummary(benchmark({
      judge: { provider: 'p', model: 'j', maxScore: 10 },
      replay: { dir: '/tmp/replay' },
      cases: [{ id: 'raw', prompt: 'p' }, {
        id: 'shell', prompt: 'p', expected: { checkShell: 'echo ok | grep ok' },
      }],
    }))
    expect(summary).toContain('- cases: 2 (1 graded, 0 with gold answers)')
    expect(summary).toContain('- expectations: 1 check(s), 0 tool constraint(s)')
    expect(summary).toContain('- replay: /tmp/replay')
    expect(summary).toContain('## Warnings')
    expect(summary).toContain('- judge is configured but no case supplies a gold answer')
    expect(summary).toContain('- 1 shell check(s) need a trusted benchmark file')
  })

  it('exposes the same preflight facts and warnings as JSON', () => {
    const parsed = JSON.parse(renderBenchmarkJson(benchmark({
      judge: { provider: 'p', model: 'j', maxScore: 10 },
      cases: [{ id: 'raw', prompt: 'p' }, {
        id: 'shell', prompt: 'p', expected: { checkShell: 'echo ok | grep ok' },
      }],
    }))) as {
      name: string; cases: number; checks: number
      judge: { provider: string; model: string; maxScore: number } | null
      replay: string | null; pricing: boolean; warnings: string[]
    }
    expect(parsed.name).toBe('smoke')
    expect(parsed.cases).toBe(2)
    expect(parsed.checks).toBe(1)
    expect(parsed.judge).toEqual({ provider: 'p', model: 'j', maxScore: 10 })
    expect(parsed.replay).toBeNull()
    expect(parsed.pricing).toBe(false)
    expect(parsed.warnings).toContain('judge is configured but no case supplies a gold answer — score calibration will be weak')
    expect(summarizeBenchmark(benchmark({ cases: [{ id: 'raw', prompt: 'p' }] })).warnings.length)
      .toBeGreaterThan(0)
    const withRegex = summarizeBenchmark(benchmark({
      cases: [{ id: 'answer', prompt: 'p', expected: { answerRegex: '^42$' } }],
    }))
    expect(withRegex.gradedCases).toBe(1)
    expect(withRegex.checks).toBe(1)
  })

  it('warns that replay runs need rejudging for judge scores', () => {
    const summary = renderBenchmarkSummary(benchmark({ replay: { dir: '/tmp/replay' } }))
    expect(summary).toContain('- replay runs have no live judge; use `dsh eval rejudge`')
  })

  it('warns when a benchmark has no scripted grading at all', () => {
    const summary = renderBenchmarkSummary(benchmark({ cases: [{ id: 'raw', prompt: 'p' }] }))
    expect(summary).toContain('- judge: none')
    expect(summary).toContain('- pricing: none')
    expect(summary).toContain('- no case has scripted expectations')
    expect(summary).toContain('- no case checks tool use or task success')
  })
})
