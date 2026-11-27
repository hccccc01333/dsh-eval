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
    benchmark: 'suite', model: 'model', benchmarkSha256: 'f'.repeat(64),
    createdAt: 1, trials: 2, seed: 7, pricing: null,
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
    const html = renderDashboard([buildRun({
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
    })])
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
    expect(html).toContain('source ffffffff')
    expect(html).toContain('task success')
    expect(html).toContain('<td>strict pass@1 (all trials)</td>')
    expect(html).toContain('tool selection')
    expect(html).toContain('Judge / script agreement</h2>')
    expect(html).toContain('Judge calibration</h2>')
    expect(html).toContain('+60.0pp')
    expect(html).toContain('<th scope="col">Brier</th>')
    expect(html).toContain('class="table-wrapper" role="region"')
    expect(html).toContain('aria-label="Judge calibration"')
    expect(html).toContain('aria-label="Trials"')
    expect(html).toContain('Trials</h2>')
    expect(html).toContain('<span class="pill completed">completed</span>')
    expect(html).toContain('<span class="pill error">error</span>')
    expect(html).toContain('boom')
    expect(html).toContain('run seed 7')
    expect(html).not.toContain('<script')
  })

  it('shows negative and unavailable calibration figures', () => {
    const judge = { provider: 'p', model: 'j', maxScore: 10 }
    const html = renderDashboard([buildRun({
      judge,
      cases: [
        {
          caseId: 'low-pass', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
          grade: { taskSuccess: true, toolSelectionAccuracy: true },
          judge: { finalAnswerScore: 2, hallucination: false },
        },
        {
          caseId: 'high-fail', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
          grade: { taskSuccess: false, toolSelectionAccuracy: true },
          judge: { finalAnswerScore: 8, hallucination: false },
        },
        {
          caseId: 'unscored', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
          grade: { taskSuccess: true, toolSelectionAccuracy: true },
          judge: { finalAnswerScore: null, hallucination: true },
        },
      ],
    })])
    expect(html).toContain('-60.0pp')
    expect(html).toContain('Review: high-fail #1')
    expect(html).toContain('unscored #1')

    const { judge: _judge, ...noJudge } = buildRun()
    const sparse = renderDashboard([{ ...noJudge, cases: [], grading: null }])
    expect(sparse).not.toContain('Judge calibration</h2>')
  })

  it('escapes benchmark, case and error strings', () => {
    const html = renderDashboard([buildRun({
      benchmark: '<img src=x onerror=alert(1)>\u001b[2J',
      cases: [{
        caseId: '</code><b>x</b>', trial: 1, status: 'error', error: '&<>"\'',
        exitCode: 1, timedOut: false,
      }],
    })])
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>x</b>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; [2J')
    expect(html).not.toContain('\u001b')
    expect(html).toContain('&lt;/code&gt;&lt;b&gt;x&lt;/b&gt;')
    expect(html).toContain('&amp;&lt;&gt;&quot;&#39;')
  })

  it('omits optional blocks for sparse runs', () => {
    const { judge: _judge, ...sparse } = buildRun()
    const html = renderDashboard([{ ...sparse, cases: [], aggregate: null, grading: null }])
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
    const html = renderDashboard([run])
    expect(html).toContain('<td>tool selection</td>')
    expect(html).not.toContain('<td>task success</td><td>')
    // A single trial has no bootstrap interval, only the rate and n.
    expect(html).toContain('n=1')
    expect(html).not.toContain('[')
  })

  it('renders a side-by-side comparison when two runs are supplied', () => {
    const html = renderDashboard([
      buildRun({ benchmark: 'baseline', model: 'v1' }),
      buildRun({ benchmark: 'candidate', model: 'v2' }),
    ])
    expect(html).toContain('<title>baseline — v1 vs candidate — v2</title>')
    expect(html).toContain('<h2>Run comparison</h2>')
    expect(html).toContain('<th scope="col">B − A</th>')
    expect(html).toContain('<h2>Paired inference</h2>')
    expect(html).toContain('<th scope="col">Interval plot</th>')
    expect(html).toContain('baseline')
    expect(html).toContain('candidate')
    expect(html).not.toContain('Changed cases</h2>')
  })

  it('renders a leaderboard page for three or more runs', () => {
    const first = buildRun({ benchmark: 'first' })
    const second = buildRun({ benchmark: 'second' })
    const third = buildRun({ benchmark: 'third' })
    const html = renderDashboard([first, second, third])
    expect(html).toContain('<h1>Leaderboard</h1>')
    expect(html).toContain('<th scope="col">Strict pass@1</th>')
    expect(html).toContain('<th scope="col">Hallucination</th>')
    expect(html).toContain('<td>first — model</td>')
    expect(html).toContain('<th scope="col">vs leader</th>')
    expect(html).toContain('Bonferroni-corrected paired sign-test verdict')
    expect(html).not.toContain('<h2>Trials</h2>')
  })

  it('ranks the leaderboard page by the requested metric', () => {
    const html = renderDashboard([
      buildRun({ benchmark: 'first' }),
      buildRun({ benchmark: 'second' }),
      buildRun({ benchmark: 'third' }),
    ], 'strictPassAt1')
    expect(html).toContain('ranked by strict pass@1')
    expect(html).not.toContain('ranked by pooled task success')
  })

  it('shows signed gaps in the leaderboard page', () => {
    const graded = (benchmark: string, rate: number): EvalRun => buildRun({
      benchmark,
      grading: {
        taskSuccessRate: rate, toolSelectionAccuracyRate: null,
        finalAnswerScore: null, hallucinationRate: null,
      },
    })
    const html = renderDashboard([graded('top', 0.9), graded('mid', 0.6), graded('low', 0.3)])
    expect(html).toContain('<td>leader</td>')
    expect(html).toContain('<td>-30.0pp</td>')
    expect(html).toContain('<td>-60.0pp</td>')
  })

  it('lists changed cases in the two-run comparison', () => {
    const passed = buildRun({ benchmark: 'base' })
    const failed = buildRun({
      benchmark: 'candidate',
      cases: [{
        caseId: 'c', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
        grade: { taskSuccess: false, toolSelectionAccuracy: true },
        judge: { finalAnswerScore: 2, hallucination: false },
      }],
    })
    const html = renderDashboard([passed, failed])
    expect(html).toContain('Changed cases</h2>')
    expect(html).toContain('<td>A better</td>')
    expect(html).toContain('<td>c</td>')
  })

  it('renders confirmed case changes in the two-run comparison', () => {
    const make = (pass: boolean): ReturnType<typeof buildRun> => buildRun({
      cases: [
        ...Array.from({ length: 8 }, (_, index) => ({
          caseId: 'stable', trial: index + 1, status: 'completed' as const,
          exitCode: 0, timedOut: false,
          grade: { taskSuccess: pass, toolSelectionAccuracy: true },
          judge: { finalAnswerScore: pass ? 5 : 2, hallucination: false },
        })),
        {
          caseId: 'weak', trial: 1, status: 'completed' as const,
          exitCode: 0, timedOut: false,
          grade: { taskSuccess: true, toolSelectionAccuracy: true },
          judge: { finalAnswerScore: 5, hallucination: false },
        },
      ],
    })
    const html = renderDashboard([make(false), make(true)])
    expect(html).toContain('Confirmed case changes</h2>')
    expect(html).toContain('<td>significantly-better</td>')
    expect(html).toContain('2 cases · Bonferroni family = 2 · 1 confirmed')
    expect(html).toMatch(/1 underpowered cases need at least \d+ discordant pairs/u)
  })

  it('shows power notes even when no case is confirmed', () => {
    const make = (pass: boolean): ReturnType<typeof buildRun> => buildRun({
      cases: Array.from({ length: 3 }, (_, index) => ({
        caseId: `weak${index}`, trial: 1, status: 'completed' as const,
        exitCode: 0, timedOut: false,
        grade: { taskSuccess: pass, toolSelectionAccuracy: true },
      })),
    })
    const html = renderDashboard([make(true), make(false)])
    expect(html).not.toContain('Confirmed case changes</h2>')
    expect(html).toMatch(/3 underpowered cases need at least \d+ discordant pairs/u)
  })

  it('notes when the confirmed-case table is truncated', () => {
    const make = (pass: boolean): ReturnType<typeof buildRun> => buildRun({
      cases: Array.from({ length: 12 }, (_, caseIndex) =>
        Array.from({ length: 12 }, (_, trialIndex) => ({
          caseId: `c${caseIndex}`, trial: trialIndex + 1, status: 'completed' as const,
          exitCode: 0, timedOut: false,
          grade: { taskSuccess: pass, toolSelectionAccuracy: true },
          judge: { finalAnswerScore: pass ? 5 : 2, hallucination: false },
        }))).flat(),
    })
    const html = renderDashboard([make(false), make(true)])
    expect(html).toContain('showing 10 of 12 confirmed changes')
    expect(html).toContain('12 confirmed</p>')
  })

  it('writes a standalone file through nested directories', async () => {
    const path = join(tempDir(), 'nested', 'dashboard.html')
    await writeDashboard([buildRun()], path)
    expect(readFileSync(path, 'utf8')).toContain('<!doctype html>')
  })

  it('renders an Anomalies section with escaped case ids', () => {
    const outlierId = '</code><b>x</b>'
    const latencies = [100, 110, 120, 130, 140, 1000]
    const html = renderDashboard([buildRun({
      cases: latencies.map((latencyMs, index) => ({
        caseId: index === latencies.length - 1 ? outlierId : `normal-${index}`,
        trial: 1, status: 'completed' as const, exitCode: 0, timedOut: false,
        metrics: { ...METRICS, latencyMs },
      })),
    })])
    expect(html).toContain('<h2>Anomalies</h2>')
    const block = html.slice(html.indexOf('<h2>Anomalies</h2>'), html.indexOf('<h2>Trials</h2>'))
    expect(block).toContain('aria-label="Anomalies"')
    expect(block).toContain('<th scope="col">Metric</th>')
    expect(block).toContain('<td>latencyMs</td>')
    expect(block).toContain('<td>1000</td>')
    expect(block).toContain('&lt;/code&gt;&lt;b&gt;x&lt;/b&gt;')
    expect(block).not.toContain('<b>x</b>')
    const baseline = renderDashboard([buildRun()])
    expect(baseline).not.toContain('<h2>Anomalies</h2>')
  })

  it('omits paired inference and case evidence when two runs share no measured trials', () => {
    const ungraded = (benchmark: string): EvalRun => buildRun({
      benchmark, cases: [], aggregate: null, grading: null,
    })
    const html = renderDashboard([ungraded('baseline'), ungraded('candidate')])
    expect(html).toContain('<h2>Run comparison</h2>')
    expect(html).not.toContain('<h2>Paired inference</h2>')
    expect(html).not.toContain('Changed cases</h2>')
    expect(html).not.toContain('Confirmed case changes</h2>')
  })

  it('renders dash placeholders for leaderboard rows without metrics', () => {
    const sparse = (benchmark: string): EvalRun => buildRun({
      benchmark, cases: [], aggregate: null, grading: null,
    })
    const html = renderDashboard([sparse('first'), sparse('second'), sparse('third')])
    expect(html).toContain('<h1>Leaderboard</h1>')
    expect(html).toContain('<td>–</td>')
  })

  it('omits the source label when the run has no benchmark hash', () => {
    const { benchmarkSha256: _hash, ...withoutHash } = buildRun()
    expect(renderDashboard([withoutHash])).not.toContain('source ffffffff')
  })

  it('renders a configuration-error warning with escaped case ids and messages', () => {
    const html = renderDashboard([buildRun({
      cases: [{
        caseId: 'c<tag>', trial: 3, status: 'completed', exitCode: 0, timedOut: false,
        grade: { taskSuccess: null, toolSelectionAccuracy: null, checkError: '<script>alert(1)</script>' },
      }],
    })])
    expect(html).toContain('<h2>Configuration errors</h2>')
    const block = html.slice(html.indexOf('<h2>Configuration errors</h2>'), html.indexOf('<h2>Trials</h2>'))
    expect(block).toContain('Fix the benchmark check configuration')
    expect(block).toContain('<code>c&lt;tag&gt;</code>#3: &lt;script&gt;alert(1)&lt;/script&gt;')
    expect(block).not.toContain('<script>')
    const baseline = renderDashboard([buildRun()])
    expect(baseline).not.toContain('<h2>Configuration errors</h2>')
  })

  it('renders a judge-error summary with escaped text and a truncation marker', () => {
    const cases = Array.from({ length: 11 }, (_, index) => ({
      caseId: `c|bad\u001b[2J${index}`, trial: index + 1,
      status: 'completed' as const, exitCode: 0, timedOut: false,
      judge: { finalAnswerScore: null, hallucination: null, judgeError: `boom|${index}\n` },
    }))
    const html = renderDashboard([buildRun({ cases })])
    expect(html).toContain('<h2>Judge errors</h2>')
    const block = html.slice(html.indexOf('<h2>Judge errors</h2>'), html.indexOf('<h2>Trials</h2>'))
    expect(block).toContain('<code>c|bad [2J0</code>#1: boom|0 ')
    expect(block).toContain('+1 more')
    expect(html).not.toContain('\u001b')
    const single = renderDashboard([buildRun({ cases: [cases[0]!] })])
    expect(single).toContain('<h2>Judge errors</h2>')
    expect(single).not.toContain('+1 more')
    expect(renderDashboard([buildRun()])).not.toContain('<h2>Judge errors</h2>')
  })

  it('renders a failure-cluster table with escaped text and a truncation marker', () => {
    const hostileId = '</code><b>x</b>'
    const html = renderDashboard([buildRun({
      cases: [
        ...[1, 2, 3, 4, 5, 6].map(index => ({
          caseId: `c${index}`, trial: 1, status: 'completed' as const,
          exitCode: 0, timedOut: false,
          grade: { taskSuccess: false, toolSelectionAccuracy: null },
        })),
        {
          caseId: hostileId, trial: 2, status: 'error' as const,
          error: 'bad|<tag>', exitCode: 1, timedOut: false,
        },
        {
          caseId: 'cfg', trial: 3, status: 'completed' as const,
          exitCode: 0, timedOut: false,
          grade: {
            taskSuccess: null, toolSelectionAccuracy: null,
            checkError: '<script>alert(1)</script>',
          },
        },
      ],
    })])
    expect(html).toContain('<h2>Failure clusters</h2>')
    const block = html.slice(html.indexOf('<h2>Failure clusters</h2>'), html.indexOf('<h2>Trials</h2>'))
    expect(block).toContain('aria-label="Failure clusters"')
    expect(block).toContain('<th scope="col">Pattern</th>')
    expect(block).toContain('<td><code>task-check</code></td>')
    expect(block).toContain('<td>Task check or answer regex did not pass</td>')
    expect(block).toContain('<td>6</td>')
    expect(block).toContain('<code>c1</code>#1 · <code>c2</code>#1 · <code>c3</code>#1 · <code>c4</code>#1 · <code>c5</code>#1 · +1 more')
    expect(block).toContain('<td>Trial error: bad|&lt;tag&gt;</td>')
    expect(block).toContain('<code>&lt;/code&gt;&lt;b&gt;x&lt;/b&gt;</code>#2')
    expect(block).toContain('<td>Check command could not start (configuration error)</td>')
    expect(block).not.toContain('<b>x</b>')
    expect(block).not.toContain('<tag>')
    // The existing configuration-error warning is still present and escaped.
    expect(html).toContain('<h2>Configuration errors</h2>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('omits the failure-cluster table when no trial failed', () => {
    const html = renderDashboard([buildRun({ cases: [{
      caseId: 'ok', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
      grade: { taskSuccess: true, toolSelectionAccuracy: true },
    }] })])
    expect(html).not.toContain('<h2>Failure clusters</h2>')
  })

  // Forest-plot fixtures: two completed, paired trials with varied values so
  // the bootstrap interval has a non-zero width.
  function forestPlots(html: string): string[] {
    return html.match(/<svg class="forest"[\s\S]*?<\/svg>/gu) ?? []
  }

  function pairedTrial(trialIndex: number, steps: number, tokens: number, score: number) {
    return {
      caseId: 'c', trial: trialIndex, status: 'completed' as const, exitCode: 0, timedOut: false,
      metrics: { ...METRICS, steps, totalTokens: tokens },
      grade: { taskSuccess: true, toolSelectionAccuracy: true },
      judge: { finalAnswerScore: score, hallucination: false },
    }
  }

  function attribute(plot: string, pattern: RegExp): number {
    const match = plot.match(pattern)
    if (match === null) throw new Error(`missing SVG attribute: ${String(pattern)}`)
    return Number(match[1])
  }

  it('adds a self-contained forest plot beside each paired delta text value', () => {
    const baseline = buildRun({ benchmark: 'base', model: 'v1', cases: [
      pairedTrial(1, 10, 100, 4), pairedTrial(2, 12, 120, 6),
    ] })
    const candidate = buildRun({ benchmark: 'cand', model: 'v2', cases: [
      pairedTrial(1, 14, 130, 5), pairedTrial(2, 20, 160, 9),
    ] })
    const html = renderDashboard([baseline, candidate])
    // Original text output is still there, including the numeric interval.
    expect(html).toContain('paired steps delta (B-A)')
    expect(html).toContain('paired tokens delta (B-A)')
    expect(html).toContain('paired final-answer delta (B-A)')
    expect(html).toMatch(/\d+(\.\d+)?% CI/u)
    const plots = forestPlots(html)
    expect(plots).toHaveLength(3)
    for (const plot of plots) {
      expect(plot).toContain('viewBox="0 0 180 34"')
      expect(plot).toContain('role="img"')
      expect(plot).toContain('class="forest-zero"')
      expect(plot).toContain('class="forest-ci"')
      expect(plot).toContain('class="forest-estimate"')
      expect(plot).not.toMatch(/NaN|Infinity/u)
      for (const value of plot.match(/(?:x1|x2|cx|cy)="[^"]+"/gu) ?? []) {
        expect(value).toMatch(/^(?:x1|x2|cx|cy)="\d+(?:\.\d+)?"$/u)
      }
    }
  })

  it('draws a zero reference line and places the estimate inside the interval', () => {
    const baseline = buildRun({ cases: [pairedTrial(1, 10, 100, 4), pairedTrial(2, 12, 120, 6)] })
    const candidate = buildRun({ cases: [pairedTrial(1, 14, 130, 5), pairedTrial(2, 20, 160, 9)] })
    const plots = forestPlots(renderDashboard([baseline, candidate]))
    expect(plots).toHaveLength(3)
    const plot = plots[0]!
    const zero = attribute(plot, /class="forest-zero" x1="([\d.]+)"/u)
    const zeroEnd = attribute(plot, /class="forest-zero"[\s\S]*?x2="([\d.]+)"/u)
    const low = attribute(plot, /class="forest-ci" x1="([\d.]+)"/u)
    const high = attribute(plot, /class="forest-ci"[\s\S]*?x2="([\d.]+)"/u)
    const point = attribute(plot, /class="forest-estimate" cx="([\d.]+)"/u)
    expect(zero).toBe(zeroEnd)
    expect(zero).toBeLessThanOrEqual(low)
    expect(low).toBeLessThan(high)
    expect(point).toBeGreaterThanOrEqual(low)
    expect(point).toBeLessThanOrEqual(high)
  })

  it('renders zero-width intervals without NaN or Infinity', () => {
    const trials = [pairedTrial(1, 10, 100, 5), pairedTrial(2, 10, 100, 5)]
    const identical = buildRun({ cases: trials })
    const plots = forestPlots(renderDashboard([identical, identical]))
    expect(plots).toHaveLength(3)
    for (const plot of plots) {
      expect(plot).toContain('cx="90.00"')
      expect(plot).toContain('class="forest-zero" x1="90.00"')
      expect(attribute(plot, /class="forest-ci" x1="([\d.]+)"/u))
        .toBe(attribute(plot, /class="forest-ci"[\s\S]*?x2="([\d.]+)"/u))
      expect(plot).not.toMatch(/NaN|Infinity/u)
    }
  })

  it('omits the plot when the interval is unavailable but keeps the text', () => {
    const onePair = buildRun({ cases: [pairedTrial(1, 10, 100, 5)] })
    const html = renderDashboard([onePair, onePair])
    expect(html).toContain('<h2>Paired inference</h2>')
    expect(html).toContain('paired steps delta (B-A)')
    expect(forestPlots(html)).toHaveLength(0)
  })

  it('omits plots for deltas with no paired measurements', () => {
    const unjudged = (steps: number): EvalRun => buildRun({ cases: [{
      caseId: 'c', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
      metrics: { ...METRICS, steps },
      grade: { taskSuccess: true, toolSelectionAccuracy: true },
    }, {
      caseId: 'c', trial: 2, status: 'completed', exitCode: 0, timedOut: false,
      metrics: { ...METRICS, steps: steps + 2 },
      grade: { taskSuccess: true, toolSelectionAccuracy: true },
    }] })
    const html = renderDashboard([unjudged(1), unjudged(3)])
    expect(html).not.toContain('paired final-answer delta (B-A)')
    expect(forestPlots(html)).toHaveLength(2)
  })

  it('keeps extreme finite bounds inside a valid finite viewBox', () => {
    const runWith = (steps: number): EvalRun => buildRun({ cases: [
      pairedTrial(1, steps, 100, 4), pairedTrial(2, steps, 100, 6),
    ] })
    const plots = forestPlots(renderDashboard([runWith(0), runWith(1e300)]))
    expect(plots).toHaveLength(3)
    for (const plot of plots) {
      expect(plot).not.toMatch(/NaN|Infinity/u)
      for (const value of plot.match(/(?:x1|x2|cx|cy)="[^"]+"/gu) ?? []) {
        expect(value).toMatch(/^(?:x1|x2|cx|cy)="\d+(?:\.\d+)?"$/u)
      }
    }
  })

  it('never writes non-finite values into SVG coordinates', () => {
    const runWith = (steps: number): EvalRun => buildRun({ cases: [
      pairedTrial(1, steps, 100, 4), pairedTrial(2, steps, 100, 6),
    ] })
    const plots = forestPlots(renderDashboard([runWith(0), runWith(Number.POSITIVE_INFINITY)]))
    // Only the steps delta is non-finite; tokens and score plots still render.
    expect(plots).toHaveLength(2)
    for (const plot of plots) {
      expect(plot).not.toMatch(/NaN|Infinity/u)
      for (const value of plot.match(/(?:x1|x2|cx|cy)="[^"]+"/gu) ?? []) {
        expect(value).toMatch(/^(?:x1|x2|cx|cy)="\d+(?:\.\d+)?"$/u)
      }
    }
  })

  it('escapes run strings interpolated into the forest plot', () => {
    const hostile = '<img src=x onerror=alert(1)>'
    const baseline = buildRun({ benchmark: hostile, cases: [
      pairedTrial(1, 10, 100, 4), pairedTrial(2, 12, 120, 6),
    ] })
    const candidate = buildRun({ benchmark: 'cand', cases: [
      pairedTrial(1, 14, 130, 5), pairedTrial(2, 20, 160, 9),
    ] })
    const html = renderDashboard([baseline, candidate])
    expect(html).not.toContain('<img')
    const plots = forestPlots(html)
    expect(plots).toHaveLength(3)
    for (const plot of plots) {
      expect(plot).toContain('&lt;img src=x onerror=alert(1)&gt;')
      expect(plot).not.toContain('<img')
    }
  })

  it('renders identical forest plots for identical inputs', () => {
    const baseline = buildRun({ cases: [pairedTrial(1, 10, 100, 4), pairedTrial(2, 12, 120, 6)] })
    const candidate = buildRun({ cases: [pairedTrial(1, 14, 130, 5), pairedTrial(2, 20, 160, 9)] })
    expect(renderDashboard([baseline, candidate])).toBe(renderDashboard([baseline, candidate]))
  })

  it('renders a segments table for multiple tags on the single-run page', () => {
    const html = renderDashboard([buildRun({
      judge: { provider: 'p', model: 'j', maxScore: 10 },
      cases: [
        {
          caseId: 'a', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
          tags: ['difficulty:hard', 'language:ts'],
          grade: { taskSuccess: true, toolSelectionAccuracy: true },
          judge: { finalAnswerScore: 8, hallucination: false },
        },
        {
          caseId: 'a', trial: 2, status: 'completed', exitCode: 0, timedOut: false,
          tags: ['difficulty:hard', 'language:ts'],
          grade: { taskSuccess: false, toolSelectionAccuracy: false },
          judge: { finalAnswerScore: 4, hallucination: true },
        },
        {
          caseId: 'b', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
          tags: ['difficulty:easy'],
          grade: { taskSuccess: true, toolSelectionAccuracy: true },
          judge: { finalAnswerScore: 6, hallucination: false },
        },
      ],
    })])
    expect(html).toContain('<h2>Segments</h2>')
    const block = html.slice(html.indexOf('<h2>Segments</h2>'), html.indexOf('<h2>Trials</h2>'))
    expect(block).toContain('aria-label="Segments"')
    expect(block).toContain('<th scope="col">Tag</th>')
    expect(block).toContain('<th scope="col">Judge score</th>')
    expect(block).toContain('<th scope="col">Judge score %</th>')
    expect(block).toContain('<th scope="col">Cost/trial</th>')
    expect(block).toContain('<td>difficulty:easy</td><td>1</td><td>1</td><td>100.0%</td><td>6.0</td><td>60.0%</td><td>0.0%</td><td>100.0%</td><td>–</td><td>–</td>')
    expect(block).toContain('<td>difficulty:hard</td><td>1</td><td>2</td><td>50.0%</td><td>6.0</td><td>60.0%</td><td>50.0%</td><td>50.0%</td><td>–</td><td>–</td>')
    expect(block).toContain('<td>language:ts</td><td>1</td><td>2</td><td>50.0%</td><td>6.0</td><td>60.0%</td><td>50.0%</td><td>50.0%</td><td>–</td><td>–</td>')
    // Existing sections survive the new block.
    expect(html).toContain('<h2>Reliability</h2>')
    expect(html).toContain('<h2>Judge calibration</h2>')
    expect(html).toContain('<h2>Failure clusters</h2>')
    expect(html.indexOf('<h2>Segments</h2>')).toBeGreaterThan(html.indexOf('<h2>Judge calibration</h2>'))
    expect(renderDashboard([buildRun()])).not.toContain('<h2>Segments</h2>')
  })

  it('renders recorded segment cost and latency when metrics are present', () => {
    const html = renderDashboard([buildRun({ cases: [{
      caseId: 'p', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
      tags: ['priced'], metrics: METRICS,
    }] })])
    const block = html.slice(html.indexOf('<h2>Segments</h2>'), html.indexOf('<h2>Trials</h2>'))
    expect(block).toContain('<td>$0.000001</td><td>120.0 ms</td>')
  })

  it('renders dash placeholders for judge-only and ungraded single tags', () => {
    const html = renderDashboard([buildRun({
      judge: { provider: 'p', model: 'j', maxScore: 10 },
      cases: [
        {
          caseId: 'j', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
          tags: ['only'], judge: { finalAnswerScore: 7, hallucination: false },
        },
        {
          caseId: 'j', trial: 2, status: 'completed', exitCode: 0, timedOut: false,
          tags: ['only'], judge: { finalAnswerScore: 3, hallucination: true },
        },
        {
          caseId: 'u', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
          tags: ['ungraded'],
        },
      ],
    })])
    const block = html.slice(html.indexOf('<h2>Segments</h2>'), html.indexOf('<h2>Trials</h2>'))
    expect(block).toContain('<td>only</td><td>1</td><td>2</td><td>–</td><td>5.0</td><td>50.0%</td><td>50.0%</td>')
    expect(block).toContain('<td>ungraded</td><td>1</td><td>1</td><td>–</td><td>–</td><td>–</td><td>–</td>')
  })

  it('escapes hostile tags and omits the segments table for untagged runs', () => {
    const html = renderDashboard([buildRun({ cases: [{
      caseId: 'c', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
      tags: ['<b>x</b>&'], grade: { taskSuccess: true, toolSelectionAccuracy: true },
    }] })])
    expect(html).toContain('<td>&lt;b&gt;x&lt;/b&gt;&amp;</td>')
    expect(html).not.toContain('<b>x</b>')
    expect(renderDashboard([buildRun()])).not.toContain('<h2>Segments</h2>')
    expect(renderDashboard([buildRun(), buildRun({ benchmark: 'second' })])).not.toContain('<h2>Segments</h2>')
  })

  it('renders per-tag deltas in two-run comparisons', () => {
    const baseline = buildRun({ cases: [
      { caseId: 'a', trial: 1, status: 'completed', exitCode: 0, timedOut: false, tags: ['hard'],
        grade: { taskSuccess: false, toolSelectionAccuracy: null },
        judge: { finalAnswerScore: 4, hallucination: false } },
      { caseId: 'b', trial: 1, status: 'completed', exitCode: 0, timedOut: false, tags: ['old'],
        grade: { taskSuccess: true, toolSelectionAccuracy: null } },
      { caseId: 'c', trial: 1, status: 'completed', exitCode: 0, timedOut: false, tags: ['slipped'],
        grade: { taskSuccess: true, toolSelectionAccuracy: null },
        judge: { finalAnswerScore: 8, hallucination: false } },
    ] })
    const candidate = buildRun({ cases: [
      { caseId: 'a', trial: 1, status: 'completed', exitCode: 0, timedOut: false, tags: ['hard'],
        grade: { taskSuccess: true, toolSelectionAccuracy: null },
        judge: { finalAnswerScore: 6, hallucination: false } },
      { caseId: 'd', trial: 1, status: 'completed', exitCode: 0, timedOut: false, tags: ['new'],
        grade: { taskSuccess: false, toolSelectionAccuracy: null },
        judge: { finalAnswerScore: 2, hallucination: false } },
      { caseId: 'c', trial: 1, status: 'completed', exitCode: 0, timedOut: false, tags: ['slipped'],
        grade: { taskSuccess: false, toolSelectionAccuracy: null },
        judge: { finalAnswerScore: 5, hallucination: false } },
    ] })
    const html = renderDashboard([baseline, candidate])
    const block = html.slice(html.indexOf('<h2>Segment deltas</h2>'))
    expect(block).toContain('<td>hard</td><td>0.0%</td><td>100.0%</td><td>+100.0pp</td><td>4.0</td><td>6.0</td><td>+2.0</td><td>–</td>')
    expect(block).toContain('<td>new</td><td>–</td><td>0.0%</td><td>–</td><td>–</td><td>2.0</td><td>–</td><td>–</td>')
    expect(block).toContain('<td>old</td><td>100.0%</td><td>–</td><td>–</td><td>–</td><td>–</td><td>–</td><td>–</td>')
    expect(block).toContain('<td>slipped</td><td>100.0%</td><td>0.0%</td><td>-100.0pp</td><td>8.0</td><td>5.0</td><td>-3.0</td><td>–</td>')
  })

  it('renders normalized segment judge deltas when both scales are recorded', () => {
    const trial = (score: number) => ({
      caseId: 'c', trial: 1, status: 'completed' as const, exitCode: 0, timedOut: false,
      tags: ['x'],
      judge: { finalAnswerScore: score, hallucination: false },
    })
    const before = buildRun({
      judge: { provider: 'p', model: 'j1', maxScore: 10 }, cases: [trial(8)],
    })
    const after = buildRun({
      judge: { provider: 'p', model: 'j2', maxScore: 100 }, cases: [trial(60)],
    })
    const html = renderDashboard([before, after])
    expect(html).toContain('Δ score %')
    expect(html).toContain('<td>8.0</td><td>60.0</td><td>+52.0</td><td>-20.0pp</td>')
  })
})
