import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderDashboard, writeDashboard } from '../src/dashboard.ts'
import type { EvalRun } from '../src/types.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-eval-dashboard-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const METRICS = {
  turns: 1, steps: 2, toolCalls: 1, toolResults: 1, toolSuccess: 1, toolSuccessRate: 1,
  invalidToolCalls: 0, retries: 0,
  tokens: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
  totalTokens: 10, contextTokens: 10, llmMs: 1, toolMs: 1, ttftMs: 1,
  latencyMs: 120, costUsd: 0.000001,
}

function buildRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    benchmark: 'suite', model: 'model', createdAt: 1, trials: 2, seed: 7, pricing: null,
    tempRoot: '/tmp/t',
    cases: [
      {
        caseId: 'c', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
        metrics: METRICS,
        grade: { taskSuccess: true, toolSelectionAccuracy: true },
        judge: { finalAnswerScore: 8, hallucination: false },
      },
      {
        caseId: 'c', trial: 2, status: 'error', error: 'boom', exitCode: 1, timedOut: false,
      },
    ],
    aggregate: METRICS,
    grading: {
      taskSuccessRate: 1, toolSelectionAccuracyRate: 1,
      finalAnswerScore: 8, hallucinationRate: 0,
    },
    ...overrides,
  }
}

describe('dsh-eval HTML dashboard', () => {
  it('renders a standalone document with the main statistics', () => {
    const html = renderDashboard(buildRun({
      judge: { provider: 'p', model: 'judge-m', maxScore: 10 },
      cases: [
        {
          caseId: 'c', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
          metrics: METRICS,
          grade: { taskSuccess: true, toolSelectionAccuracy: true },
          judge: { finalAnswerScore: 8, hallucination: false },
        },
        {
          caseId: 'c', trial: 2, status: 'completed', exitCode: 0, timedOut: false,
          metrics: METRICS,
          grade: { taskSuccess: false, toolSelectionAccuracy: false },
          judge: { finalAnswerScore: 2, hallucination: false },
        },
        { caseId: 'c', trial: 3, status: 'error', error: 'boom', exitCode: 1, timedOut: false },
      ],
    }))
    expect(html).toMatch(/^<!doctype html>/u)
    expect(html).toContain('<title>suite — model</title>')
    expect(html).toContain('judge judge-m')
    expect(html).toContain('Completed')
    expect(html).toContain('2/3')
    expect(html).toContain('strict 33.3%')
    expect(html).toContain('Latency p95')
    expect(html).toContain('$0.000001')
    expect(html).toContain('Reliability</h2>')
    expect(html).toContain('Flaky cases:')
    expect(html).toContain('Hardest cases:')
    expect(html).toContain('Precision</h2>')
    expect(html).toContain('task success')
    expect(html).toContain('tool selection')
    expect(html).toContain('Judge / script agreement</h2>')
    expect(html).toContain('Trials</h2>')
    expect(html).toContain('<span class="pill completed">completed</span>')
    expect(html).toContain('<span class="pill error">error</span>')
    expect(html).toContain('boom')
    expect(html).toContain('run seed 7')
    expect(html).not.toContain('<script')
  })

  it('escapes benchmark, case and error strings', () => {
    const html = renderDashboard(buildRun({
      benchmark: '<img src=x onerror=alert(1)>',
      cases: [{
        caseId: '</code><b>x</b>', trial: 1, status: 'error', error: '&<>"\'',
        exitCode: 1, timedOut: false,
      }],
    }))
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>x</b>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&lt;/code&gt;&lt;b&gt;x&lt;/b&gt;')
    expect(html).toContain('&amp;&lt;&gt;&quot;&#39;')
  })

  it('omits optional blocks for sparse runs', () => {
    const { judge: _judge, ...sparse } = buildRun()
    const html = renderDashboard({ ...sparse, cases: [], aggregate: null, grading: null })
    expect(html).toContain('no judge')
    expect(html).toContain('no metrics')
    expect(html).toContain('–')
    expect(html).not.toContain('Judge / script agreement')
    expect(html).not.toContain('Precision</h2>')
    expect(html).not.toContain('Flaky cases:')
    expect(html).not.toContain('Hardest cases:')
  })

  it('labels a tool-only precision interval correctly', () => {
    const run = buildRun({ cases: [{
      caseId: 'c', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
      grade: { taskSuccess: null, toolSelectionAccuracy: true },
    }] })
    const html = renderDashboard(run)
    expect(html).toContain('<td>tool selection</td>')
    expect(html).not.toContain('<td>task success</td><td>')
    // A single trial has no bootstrap interval, only the rate and n.
    expect(html).toContain('n=1')
    expect(html).not.toContain('[')
  })

  it('writes a standalone file through nested directories', async () => {
    const path = join(tempDir(), 'nested', 'dashboard.html')
    await writeDashboard(buildRun(), path)
    expect(readFileSync(path, 'utf8')).toContain('<!doctype html>')
  })
})
