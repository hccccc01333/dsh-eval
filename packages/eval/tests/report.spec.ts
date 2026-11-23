import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadRunReport, renderBriefReport, renderMarkdownReport, renderReportJson, writeRunReport } from '../src/report.ts'
import type { EvalRun } from '../src/types.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-eval-report-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function buildRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    benchmark: 'b',
    model: 'm',
    createdAt: 1,
    trials: 1,
    seed: 0,
    pricing: null,
    tempRoot: '/tmp/t',
    cases: [],
    aggregate: null,
    grading: null,
    ...overrides,
  }
}

describe('dsh-eval report persistence and rendering', () => {
  it('writes and loads a run report, creating parent directories', async () => {
    const dir = tempDir()
    const path = join(dir, 'nested', 'run.json')
    const run = buildRun({
      benchmark: 'roundtrip',
      benchmarkSha256: 'c'.repeat(64),
      caseInputs: [{ caseId: 'c', prompt: 'p', answer: '42' }],
    })
    await writeRunReport(run, path)
    expect(readFileSync(path, 'utf8')).toMatch(/"benchmark": "roundtrip"/u)
    const loaded = await loadRunReport(path)
    expect(loaded).toEqual(run)
    expect(renderMarkdownReport(loaded)).toContain(`- benchmark sha256: ${'c'.repeat(64)}`)
    expect(JSON.parse(renderReportJson(loaded)) as { benchmarkSha256: string })
      .toMatchObject({ benchmarkSha256: 'c'.repeat(64) })
  })

  it('replaces reports atomically without leaving staged files', async () => {
    const dir = tempDir()
    const path = join(dir, 'run.json')
    writeFileSync(path, 'old')
    await writeRunReport(buildRun({ benchmark: 'atomic' }), path)
    expect(readFileSync(path, 'utf8')).toContain('"benchmark": "atomic"')
    expect(readdirSync(dir)).toEqual(['run.json'])
  })

  it('removes the staged file when replacement fails', async () => {
    const dir = tempDir()
    const target = join(dir, 'target')
    mkdirSync(target)
    await expect(writeRunReport(buildRun(), target)).rejects.toThrow()
    expect(readdirSync(dir)).toEqual(['target'])
  })

  it('rejects invalid JSON and non-report JSON', async () => {
    const dir = tempDir()
    const invalid = join(dir, 'invalid.json')
    writeFileSync(invalid, '{not json')
    await expect(loadRunReport(invalid)).rejects.toThrow()
    const wrong = join(dir, 'wrong.json')
    writeFileSync(wrong, '{"cases": "nope"}')
    await expect(loadRunReport(wrong)).rejects.toThrow('is not a dsh-eval run report')
  })

  it('diagnoses the offending field path in a malformed report', async () => {
    const dir = tempDir()
    const aggregate = join(dir, 'bad-aggregate.json')
    writeFileSync(aggregate, JSON.stringify({ ...buildRun(), aggregate: {} }))
    await expect(loadRunReport(aggregate)).rejects.toThrow('aggregate.steps')
    const cases = join(dir, 'bad-cases.json')
    writeFileSync(cases, JSON.stringify({ ...buildRun(), cases: [null] }))
    await expect(loadRunReport(cases)).rejects.toThrow('cases.0')
    const root = join(dir, 'bad-root.json')
    writeFileSync(root, '[]')
    await expect(loadRunReport(root)).rejects.toThrow('(root)')
  })

  it('renders a machine-readable report with the same derived blocks', () => {
    const run = buildRun({
      benchmark: 'structured',
      caseInputs: [{ caseId: 'c', prompt: 'p', answer: '42' }],
    })
    const parsed = JSON.parse(renderReportJson(run)) as {
      benchmark: string; seed: number; coverage: { completed: number }
      reliability: { task: unknown }; precision: unknown
      agreement: unknown; calibration: unknown; cases: unknown[]
      caseInputs: { caseId: string }[]
    }
    expect(parsed.caseInputs).toEqual([{ caseId: 'c', prompt: 'p', answer: '42' }])
    expect(parsed.benchmark).toBe('structured')
    expect(parsed.seed).toBe(run.seed)
    expect(parsed.coverage.completed).toBeGreaterThanOrEqual(0)
    expect(parsed.reliability.task).toBeDefined()
    expect(parsed.precision).toBeDefined()
    expect(parsed.agreement).toBeDefined()
    expect(parsed.calibration).toBeDefined()
    expect(parsed.cases).toHaveLength(run.cases.length)
  })

  it('renders completed and failed trials plus the aggregate row', () => {
    const run = buildRun({
      benchmark: 'render-me',
      benchmarkSha256: 'a'.repeat(64),
      pricing: { inputUsdPerMTokens: 1, cacheReadUsdPerMTokens: 1, cacheWriteUsdPerMTokens: 1, outputUsdPerMTokens: 1 },
      cases: [
        {
          caseId: 'ok',
          trial: 1,
          status: 'completed',
          tracePath: '/tmp/t/ok-1/dsh-home/sessions/p/s/session.jsonl',
          exitCode: 0,
          timedOut: false,
          metrics: {
            turns: 1, steps: 1, toolCalls: 1, toolResults: 1, toolSuccess: 1, toolSuccessRate: 1,
            invalidToolCalls: 0, retries: 0,
            tokens: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
            totalTokens: 1, contextTokens: 1, llmMs: 1, toolMs: 2, ttftMs: 3, latencyMs: 4, costUsd: 0.000001,
          },
        },
        { caseId: 'bad', trial: 1, status: 'error', error: 'boom', exitCode: 1, timedOut: false },
      ],
      aggregate: {
        turns: 1, steps: 1, toolCalls: 1, toolResults: 1, toolSuccess: 1, toolSuccessRate: 1,
        invalidToolCalls: 0, retries: 0,
        tokens: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
        totalTokens: 1, contextTokens: 1, llmMs: 1, toolMs: 2, ttftMs: 3, latencyMs: 4, costUsd: 0.000001,
      },
    })
    const markdown = renderMarkdownReport(run)
    expect(markdown).toContain('# Eval: render-me')
    expect(markdown).toContain(`- benchmark sha256: ${'a'.repeat(64)}`)
    expect(markdown).toContain('| ok | 1 | completed | 1 | 1 | 100.0% | 0 | 0 | 1 | $0.000001 | 4 | – | – |')
    expect(markdown).toContain('| bad | 1 | error | – | – | – | – | – | – | – | – | – | – |')
    expect(markdown).toContain('| aggregate | – | completed |')
    expect(markdown).toContain('- traces: /tmp/t')
  })

  it('renders dash placeholders for null rates, costs, and an empty aggregate', () => {
    const run = buildRun({
      cases: [{
        caseId: 'empty',
        trial: 1,
        status: 'completed',
        exitCode: 0,
        timedOut: false,
        metrics: {
          turns: 0, steps: 0, toolCalls: 0, toolResults: 0, toolSuccess: 0, toolSuccessRate: null,
          invalidToolCalls: 0, retries: 0,
          tokens: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
          totalTokens: 0, contextTokens: 0, llmMs: 0, toolMs: 0, ttftMs: 0, latencyMs: 0, costUsd: null,
        },
      }],
    })
    const markdown = renderMarkdownReport(run)
    expect(markdown).toContain('| empty | 1 | completed | 0 | 0 | – | 0 | 0 | 0 | – | 0 | – | – |')
    expect(markdown).toContain('| aggregate | – | no completed trials | – | – | – | – | – | – | – | – | – | – |')
  })

  it('renders scripted grading columns and pooled rates', () => {
    const run = buildRun({
      cases: [{
        caseId: 'graded',
        trial: 1,
        status: 'completed',
        exitCode: 0,
        timedOut: false,
        grade: { taskSuccess: true, toolSelectionAccuracy: true },
        metrics: {
          turns: 1, steps: 1, toolCalls: 1, toolResults: 1, toolSuccess: 1, toolSuccessRate: 1,
          invalidToolCalls: 0, retries: 0,
          tokens: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
          totalTokens: 1, contextTokens: 1, llmMs: 1, toolMs: 2, ttftMs: 3, latencyMs: 4, costUsd: null,
        },
      }, {
        caseId: 'failed-grade',
        trial: 1,
        status: 'completed',
        exitCode: 0,
        timedOut: false,
        grade: { taskSuccess: false, toolSelectionAccuracy: false },
        metrics: {
          turns: 1, steps: 1, toolCalls: 1, toolResults: 1, toolSuccess: 1, toolSuccessRate: 1,
          invalidToolCalls: 0, retries: 0,
          tokens: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
          totalTokens: 1, contextTokens: 1, llmMs: 1, toolMs: 2, ttftMs: 3, latencyMs: 4, costUsd: null,
        },
      }],
      grading: { taskSuccessRate: 1, toolSelectionAccuracyRate: 1, finalAnswerScore: null, hallucinationRate: null },
      aggregate: {
        turns: 1, steps: 1, toolCalls: 1, toolResults: 1, toolSuccess: 1, toolSuccessRate: 1,
        invalidToolCalls: 0, retries: 0,
        tokens: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
        totalTokens: 1, contextTokens: 1, llmMs: 1, toolMs: 2, ttftMs: 3, latencyMs: 4, costUsd: null,
      },
    })
    const markdown = renderMarkdownReport(run)
    expect(markdown).toContain('| graded | 1 | completed | 1 | 1 | 100.0% | 0 | 0 | 1 | – | 4 | yes | yes |')
    expect(markdown).toContain('| failed-grade | 1 | completed | 1 | 1 | 100.0% | 0 | 0 | 1 | – | 4 | no | no |')
    expect(markdown).toContain('| aggregate | – | completed | 1.0 | 1.0 | 100.0% | 0.0 | 0.0 | 1.0 | – | 4.0 | 100.0% | 100.0% |')
  })

  it('renders judge columns and pooled judge rates', () => {
    const run = buildRun({
      judge: { provider: 'deepseek', model: 'judge-m', maxScore: 10 },
      cases: [{
        caseId: 'judged',
        trial: 1,
        status: 'completed',
        exitCode: 0,
        timedOut: false,
        judge: { finalAnswerScore: 8, hallucination: false, rationale: 'ok' },
        metrics: {
          turns: 1, steps: 1, toolCalls: 1, toolResults: 1, toolSuccess: 1, toolSuccessRate: 1,
          invalidToolCalls: 0, retries: 0,
          tokens: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
          totalTokens: 1, contextTokens: 1, llmMs: 1, toolMs: 2, ttftMs: 3, latencyMs: 4, costUsd: null,
        },
      }, {
        caseId: 'unjudged',
        trial: 1,
        status: 'completed',
        exitCode: 0,
        timedOut: false,
        judge: { finalAnswerScore: null, hallucination: null },
        metrics: {
          turns: 1, steps: 1, toolCalls: 1, toolResults: 1, toolSuccess: 1, toolSuccessRate: 1,
          invalidToolCalls: 0, retries: 0,
          tokens: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
          totalTokens: 1, contextTokens: 1, llmMs: 1, toolMs: 2, ttftMs: 3, latencyMs: 4, costUsd: null,
        },
      }],
      grading: {
        taskSuccessRate: null,
        toolSelectionAccuracyRate: null,
        finalAnswerScore: 8,
        hallucinationRate: 0,
      },
      aggregate: {
        turns: 1, steps: 1, toolCalls: 1, toolResults: 1, toolSuccess: 1, toolSuccessRate: 1,
        invalidToolCalls: 0, retries: 0,
        tokens: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
        totalTokens: 1, contextTokens: 1, llmMs: 1, toolMs: 2, ttftMs: 3, latencyMs: 4, costUsd: null,
      },
    })
    const markdown = renderMarkdownReport(run)
    expect(markdown).toContain('- judge: judge-m')
    expect(markdown).toContain('| score | halluc |')
    expect(markdown).toContain('| judged | 1 | completed | 1 | 1 | 100.0% | 0 | 0 | 1 | – | 4 | – | – | 8.0/10 | no |')
    expect(markdown).toContain('| unjudged | 1 | completed | 1 | 1 | 100.0% | 0 | 0 | 1 | – | 4 | – | – | – | – |')
    expect(markdown).toContain('8.0/10 | 0.0% |')
  })

  it('renders judge/script agreement when both signals exist', () => {
    const run = buildRun({
      judge: { provider: 'deepseek', model: 'judge-m', maxScore: 10 },
      cases: [
        {
          caseId: 'agree', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
          grade: { taskSuccess: true, toolSelectionAccuracy: null },
          judge: { finalAnswerScore: 8, hallucination: false },
        },
        {
          caseId: 'disagree', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
          grade: { taskSuccess: false, toolSelectionAccuracy: null },
          judge: { finalAnswerScore: 2, hallucination: false },
        },
      ],
    })
    const markdown = renderMarkdownReport(run)
    expect(markdown).toContain('## Judge / script agreement')
    expect(markdown).toContain('- pairs: 2 trial(s)')
    expect(markdown).toContain('- observed agreement: 50.0% (1/2)')
    expect(markdown).toContain("- Cohen's kappa: 0.00")
    expect(markdown).toContain('judge no-hallucination 100.0% · script task success 50.0%')
    expect(renderBriefReport(run)).toContain('- judge/script agreement: 50.0% (n=2) · kappa 0.00')
    expect(renderMarkdownReport(buildRun())).not.toContain('Judge / script agreement')
    expect(markdown).toContain('## Judge calibration')
    expect(markdown).toContain('- separation (passed − failed): +60.0pp')
    expect(markdown).toContain('- ranking accuracy: 100.0% (ties count as half)')
    expect(renderBriefReport(run)).toContain('- judge separation: +60.0pp · ranking 100.0%')
  })

  it('renders judge dashes when verdicts are missing', () => {
    const run = buildRun({
      judge: { provider: 'deepseek', model: 'judge-m', maxScore: 10 },
      cases: [{
        caseId: 'miss',
        trial: 1,
        status: 'completed',
        exitCode: 0,
        timedOut: false,
        judge: { finalAnswerScore: null, hallucination: null },
        metrics: {
          turns: 1, steps: 1, toolCalls: 1, toolResults: 1, toolSuccess: 1, toolSuccessRate: 1,
          invalidToolCalls: 0, retries: 0,
          tokens: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
          totalTokens: 1, contextTokens: 1, llmMs: 1, toolMs: 2, ttftMs: 3, latencyMs: 4, costUsd: null,
        },
      }],
    })
    const markdown = renderMarkdownReport(run)
    const dashes = ['–', '–', '–', '–', '–', '–', '–', '–', '–', '–', '–', '–'].join(' | ')
    expect(markdown).toContain(`| aggregate | – | no completed trials | ${dashes} |`)
  })

  it('appends reliability blocks for both graded dimensions', () => {
    const graded = (caseId: string, index: number, task: boolean, tool: boolean) => ({
      caseId, trial: index, status: 'completed' as const, exitCode: 0, timedOut: false,
      grade: { taskSuccess: task, toolSelectionAccuracy: tool },
    })
    const markdown = renderMarkdownReport(buildRun({
      trials: 3,
      cases: [
        graded('ok', 1, true, true), graded('ok', 2, true, true), graded('ok', 3, true, true),
        graded('flaky', 1, true, false), graded('flaky', 2, false, false), graded('flaky', 3, false, false),
      ],
    }))
    expect(markdown).toContain('## Reliability: task success')
    expect(markdown).toContain('- cases: 2 · trials/case: 3')
    expect(markdown).toContain('- pass@1: 66.7% · pass@k (6 graded): 100.0% · pass^k: 50.0%')
    expect(markdown).toContain('- hardest cases: `flaky` 1/3 · `ok` 3/3')
    expect(markdown).toContain('- flaky cases (1): `flaky` 1/3')
    expect(markdown).toContain('## Reliability: tool selection accuracy')
    expect(markdown).toContain('- pass@1: 50.0% · pass@k (6 graded): 50.0% · pass^k: 50.0%')
    // A stable tool-selection dimension prints no flaky line.
    expect(markdown.match(/flaky cases/gu)).toHaveLength(1)
  })

  it('renders a reversed and partially unscored calibration without hiding the gaps', () => {
    const judge = { provider: 'deepseek', model: 'judge-m', maxScore: 10 }
    const reversed = buildRun({
      judge,
      cases: [
        {
          caseId: 'low-pass', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
          grade: { taskSuccess: true, toolSelectionAccuracy: null },
          judge: { finalAnswerScore: 2, hallucination: false },
        },
        {
          caseId: 'high-fail', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
          grade: { taskSuccess: false, toolSelectionAccuracy: null },
          judge: { finalAnswerScore: 8, hallucination: false },
        },
        {
          caseId: 'unscored', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
          grade: { taskSuccess: true, toolSelectionAccuracy: null },
          judge: { finalAnswerScore: null, hallucination: true },
        },
      ],
    })
    const markdown = renderMarkdownReport(reversed)
    expect(markdown).toContain('- separation (passed − failed): -60.0pp')
    expect(markdown).toContain('- ranking accuracy: 0.0% (ties count as half)')
    expect(markdown).toContain('  - high-fail trial 1: script fail · judge score 8')
    expect(markdown).toContain('  - low-pass trial 1: script pass · judge score 2')
    expect(markdown).toContain('  - unscored trial 1: script pass · judge score n/a · hallucination')
    expect(renderBriefReport(reversed)).toContain('- judge separation: -60.0pp · ranking 0.0%')

    const noScores = buildRun({
      judge,
      cases: [{
        caseId: 'no-score', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
        grade: { taskSuccess: true, toolSelectionAccuracy: null },
        judge: { finalAnswerScore: null, hallucination: false },
      }],
    })
    const sparse = renderMarkdownReport(noScores)
    expect(sparse).toContain('- mean normalized score: passed n/a · failed n/a')
    expect(sparse).toContain('- separation (passed − failed): n/a')
    expect(sparse).toContain('- ranking accuracy: n/a')
  })

  it('reports judge failures instead of silently dropping the scores', () => {
    const markdown = renderMarkdownReport(buildRun({
      judge: { provider: 'p', model: 'judge-m', maxScore: 10 },
      grading: {
        taskSuccessRate: null, toolSelectionAccuracyRate: null,
        finalAnswerScore: null, hallucinationRate: null, judgeFailures: 2,
      },
    }))
    expect(markdown).toContain('- judge: judge-m')
    expect(markdown).toContain('- judge failures: 2')
  })

  it('renders a compact brief summary for the terminal', () => {
    const metrics = {
      turns: 1, steps: 2, toolCalls: 1, toolResults: 1, toolSuccess: 1, toolSuccessRate: 1,
      invalidToolCalls: 0, retries: 0,
      tokens: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      totalTokens: 10, contextTokens: 10, llmMs: 1, toolMs: 1, ttftMs: 1,
      latencyMs: 100, costUsd: 0.000001,
    }
    const brief = renderBriefReport(buildRun({
      benchmark: 'suite', model: 'm2',
      benchmarkSha256: 'd'.repeat(64),
      seed: 7,
      aggregate: { ...metrics },
      grading: {
        taskSuccessRate: 0.5, toolSelectionAccuracyRate: null,
        finalAnswerScore: null, hallucinationRate: null, judgeFailures: 2,
      },
      cases: [
        ...[1, 2, 3].map(trialNo => ({
          caseId: 'c', trial: trialNo, status: 'completed' as const, exitCode: 0, timedOut: false,
          grade: { taskSuccess: trialNo !== 2, toolSelectionAccuracy: null }, metrics,
        })),
        { caseId: 'c', trial: 4, status: 'error' as const, error: 'boom', exitCode: 1, timedOut: false },
      ],
    }))
    expect(brief).toContain('# suite — m2')
    expect(brief).toContain('- source: dddddddddddd')
    expect(brief).toContain('- trials: 3/4 completed · 1 unscored (0 timeouts, 1 errors)')
    expect(brief).toContain('- tool success: 100.0%')
    expect(brief).toContain('- steps / tokens / cost per trial: 2.0 / 10 / $0.000001')
    expect(brief).toContain('- task success: 66.7%')
    expect(brief).toContain('- strict pass@1 (all 4 trials): 50.0%')
    expect(brief).toMatch(/- task precision: 66\.7% \[95% CI .*\]/u)
    expect(brief).toContain('- judge failures: 2')
    expect(brief.split('\n').length).toBeLessThan(12)
    const unpriced = renderBriefReport(buildRun({
      aggregate: { ...metrics, costUsd: null },
    }))
    expect(unpriced).toContain('2.0 / 10 / –')
  })

  it('keeps the brief report short when data is missing', () => {
    const empty = renderBriefReport(buildRun())
    expect(empty).toBe('# b — m\n- trials: 0/0 completed\n')
    const single = renderBriefReport(buildRun({
      cases: [{
        caseId: 'c', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
        grade: { taskSuccess: true, toolSelectionAccuracy: null },
      }],
    }))
    expect(single).toContain('- task success: 100.0%')
    expect(single).not.toContain('95% CI')
  })

  it('prints single-run intervals and latency percentiles', () => {
    const metrics = {
      turns: 1, steps: 1, toolCalls: 0, toolResults: 0, toolSuccess: 0, toolSuccessRate: null,
      invalidToolCalls: 0, retries: 0,
      tokens: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      totalTokens: 0, contextTokens: 0, llmMs: 0, toolMs: 0, ttftMs: 0,
      latencyMs: 100, costUsd: null,
    }
    const markdown = renderMarkdownReport(buildRun({
      cases: [1, 2, 3].map(trialNo => ({
        caseId: 'c', trial: trialNo, status: 'completed' as const, exitCode: 0, timedOut: false,
        grade: { taskSuccess: trialNo !== 2, toolSelectionAccuracy: null },
        metrics: { ...metrics, latencyMs: trialNo * 100 },
      })),
    }))
    expect(markdown).toContain('## Precision')
    expect(markdown).toMatch(/- task success: 66\.7% \[95% CI .*\] \(n=3\)/u)
    expect(markdown).toContain('- latency p50/p95: 200 / 290 ms')
    // One trial cannot support an interval; the rate still prints without one.
    const single = renderMarkdownReport(buildRun({
      cases: [{
        caseId: 'c', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
        grade: { taskSuccess: true, toolSelectionAccuracy: null }, metrics,
      }],
    }))
    expect(single).toContain('- task success: 100.0% (n=1)')
    expect(single).not.toContain('95% CI')
    // A run with no trials has no precision section at all.
    expect(renderMarkdownReport(buildRun())).not.toContain('## Precision')
  })

  it('shows the unscored denominator and the strict rate', () => {
    const markdown = renderMarkdownReport(buildRun({
      trials: 3,
      cases: [
        { caseId: 'a', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
          grade: { taskSuccess: true, toolSelectionAccuracy: null } },
        { caseId: 'a', trial: 2, status: 'completed', exitCode: 0, timedOut: false,
          grade: { taskSuccess: false, toolSelectionAccuracy: null } },
        { caseId: 'a', trial: 3, status: 'error', error: 'timeout', exitCode: null, timedOut: true },
      ],
    }))
    expect(markdown).toContain('- trials: 2/3 completed · 1 unscored (1 timeouts, 1 errors)')
    expect(markdown).toContain('- strict pass@1: 33.3% over all 3 trials (1 unscored)')
  })
})
