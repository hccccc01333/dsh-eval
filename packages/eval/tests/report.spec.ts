import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadRunReport, renderBriefReport, renderMarkdownReport, renderReportJson, writeRunReport } from '../src/report.ts'
import type { EvalRun, EvalTrialResult } from '../src/types.ts'

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

  it('strips terminal control bytes from hostile report fields', () => {
    const markdown = renderMarkdownReport(buildRun({
      benchmark: 'b\u001b[2Jm', model: 'm\u001b[1A',
      cases: [{
        caseId: 'c\u001b[2J', trial: 1, status: 'error',
        error: 'x\u001b[2J', exitCode: null, timedOut: false,
      }],
    }))
    expect(markdown).toContain('b [2Jm')
    // Markdown's own line breaks are the only control bytes left.
    expect(markdown.replace(/\n/gu, '')).not.toMatch(/[\u001b\u0000-\u001f]/u)
  })

  it('includes anomaly, failure-cluster and segment analytics in JSON', () => {
    const parsed = JSON.parse(renderReportJson(buildRun({
      cases: [{
        caseId: 'tag-a', trial: 1, status: 'error', error: 'boom',
        exitCode: null, timedOut: false, tags: ['hard'],
      }],
    }))) as {
      anomalies: unknown[]
      failureClusters: { pattern: string; count: number }[]
      segments: { tag: string; trials: number }[]
    }
    expect(parsed.anomalies).toEqual([])
    expect(parsed.failureClusters).toMatchObject([{ pattern: 'trial-error', count: 1 }])
    expect(parsed.segments).toMatchObject([{ tag: 'hard', trials: 1 }])
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
    // Omitted optional inputs are rendered as an empty array, not dropped.
    expect((JSON.parse(renderReportJson(buildRun())) as { caseInputs: unknown[] }).caseInputs).toEqual([])
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
    expect(renderBriefReport(run)).toContain('- judge separation: +60.0pp · ranking 100.0% · Brier')
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
    expect(renderBriefReport(reversed)).toContain('- judge separation: -60.0pp · ranking 0.0% · Brier')

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

  it('lists judge failures with escaped ids and bounds the brief summary', () => {
    const cases = Array.from({ length: 11 }, (_, index) => ({
      caseId: `c|bad\u001b[2J${index}`, trial: index + 1,
      status: 'completed' as const, exitCode: 0, timedOut: false,
      judge: { finalAnswerScore: null, hallucination: null, judgeError: `boom|${index}\n` },
    }))
    const run = buildRun({
      judge: { provider: 'p', model: 'judge-m', maxScore: 10 },
      grading: {
        taskSuccessRate: null, toolSelectionAccuracyRate: null,
        finalAnswerScore: null, hallucinationRate: null, judgeFailures: 11,
      },
      cases,
    })
    const markdown = renderMarkdownReport(run)
    expect(markdown).toContain('## Judge errors')
    expect(markdown).toContain('- `c bad [2J0`#1: boom 0')
    expect(markdown).toContain('- +1 more')
    expect(markdown).not.toContain('\u001b')
    const brief = renderBriefReport(run)
    expect(brief).toContain('- judge errors: `c bad [2J0`#1: boom 0')
    expect(brief).toContain('+6 more')
  })

  it('lists a single judge failure without a truncation marker', () => {
    const run = buildRun({
      cases: [{
        caseId: 'solo', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
        judge: { finalAnswerScore: null, hallucination: null, judgeError: 'timeout' },
      }],
    })
    expect(renderMarkdownReport(run)).toContain('- `solo`#1: timeout')
    expect(renderMarkdownReport(run)).not.toContain(' more')
    expect(renderBriefReport(run)).toContain('- judge errors: `solo`#1: timeout')
    expect(renderBriefReport(run)).not.toContain(' more')
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

  it('prints Brier in brief output even when a one-sided score has no separation', () => {
    const brief = renderBriefReport(buildRun({
      judge: { provider: 'p', model: 'j', maxScore: 5 },
      cases: [5, 3, 1].map((score, index) => ({
        caseId: 'c', trial: index + 1, status: 'completed' as const,
        exitCode: 0, timedOut: false,
        grade: { taskSuccess: true, toolSelectionAccuracy: null },
        judge: { finalAnswerScore: score, hallucination: false },
      })),
    }))
    expect(brief).not.toContain('judge separation')
    expect(brief).toContain('judge Brier: 0.267')
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
    expect(markdown).toContain('- trials: 2/3 completed · 1 unscored (1 timeouts, 0 errors)')
    expect(markdown).toContain('- strict pass@1: 33.3% over all 3 trials (1 unscored)')
  })

  it('escapes untrusted case ids and headers before they enter markdown', () => {
    const caseId = 'a|b\nc`d'
    const markdown = renderMarkdownReport(buildRun({
      benchmark: 'bench|mark\nx`y',
      model: 'mod|el\nz`w',
      cases: [{
        caseId, trial: 1, status: 'error', error: 'boom', exitCode: 1, timedOut: false,
      }],
    }))
    const rows = markdown.split('\n').filter(line => line.startsWith('|'))
    // header + separator + case row + aggregate row: no row was forged by a
    // newline and no cell was split by a pipe from the raw identifier.
    expect(rows).toHaveLength(4)
    expect(rows.every(line => (line.match(/\|/gu) ?? []).length === 14)).toBe(true)
    expect(markdown).toContain('| a b c d | 1 | error |')
    expect(markdown).toContain('# Eval: bench mark x y')
    expect(markdown).toContain('- model: mod el z w')
    expect(markdown).not.toContain(caseId)
    expect(markdown).not.toContain('bench|mark')
    expect(markdown).not.toContain('mod|el')
    expect(renderBriefReport(buildRun({
      benchmark: 'bench|mark\nx`y', model: 'mod|el\nz`w',
    }))).toContain('# bench mark x y — mod el z w')
  })

  it('escapes case ids in reliability and calibration detail lists', () => {
    const caseId = 'fl|aky\nq`case'
    const markdown = renderMarkdownReport(buildRun({
      judge: { provider: 'p', model: 'ju|dge`m', maxScore: 10 },
      cases: [
        {
          caseId, trial: 1, status: 'completed', exitCode: 0, timedOut: false,
          grade: { taskSuccess: true, toolSelectionAccuracy: null },
          judge: { finalAnswerScore: 2, hallucination: false },
        },
        {
          caseId, trial: 2, status: 'completed', exitCode: 0, timedOut: false,
          grade: { taskSuccess: false, toolSelectionAccuracy: null },
          judge: { finalAnswerScore: 8, hallucination: false },
        },
      ],
    }))
    expect(markdown).toContain('- judge: ju dge m')
    expect(markdown).toContain('- hardest cases: `fl aky q case` 1/2')
    expect(markdown).toContain('- flaky cases (1): `fl aky q case` 1/2')
    expect(markdown).toContain('  - fl aky q case trial 1: script pass · judge score 2')
    expect(markdown).toContain('  - fl aky q case trial 2: script fail · judge score 8')
    expect(markdown).not.toContain('fl|aky')
    expect(markdown).not.toContain('ju|dge')
  })

  it('renders an Anomalies block for outlier trials and escapes the case id', () => {
    const outlierId = 'an|om\n`aly'
    const latencies = [100, 110, 120, 130, 140, 1000]
    const metrics = (latencyMs: number) => ({
      turns: 1, steps: 1, toolCalls: 0, toolResults: 0, toolSuccess: 0, toolSuccessRate: null,
      invalidToolCalls: 0, retries: 0,
      tokens: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      totalTokens: 10, contextTokens: 10, llmMs: 1, toolMs: 1, ttftMs: 1, latencyMs, costUsd: null,
    })
    const run = buildRun({
      cases: latencies.map((latencyMs, index) => ({
        caseId: index === latencies.length - 1 ? outlierId : `normal-${index}`,
        trial: 1, status: 'completed' as const, exitCode: 0, timedOut: false,
        metrics: metrics(latencyMs),
      })),
    })
    const markdown = renderMarkdownReport(run)
    expect(markdown).toContain('## Anomalies')
    expect(markdown).toContain('- `an om  aly` trial 1: metric latencyMs, value 1000 — latencyMs 1000 outside [75, 175]')
    expect(markdown).not.toContain('an|om')
    expect(markdown).not.toContain('`aly')
    const brief = renderBriefReport(run)
    expect(brief).toContain('- anomalies: `an om  aly` #1 latencyMs=1000')
    expect(brief).not.toContain('an|om')
    // A run with no outlier keeps its baseline output verbatim.
    const baseline = buildRun()
    expect(renderMarkdownReport(baseline)).not.toContain('## Anomalies')
    expect(renderBriefReport(baseline)).not.toContain('- anomalies:')
    expect(renderBriefReport(baseline)).toBe('# b — m\n- trials: 0/0 completed\n')
  })

  it('warns about check-command configuration errors and escapes case ids and messages', () => {
    const run = buildRun({
      cases: [{
        caseId: 'ch|eck`1', trial: 2, status: 'completed', exitCode: 0, timedOut: false,
        grade: { taskSuccess: null, toolSelectionAccuracy: null, checkError: 'bad|cfg\nline' },
      }],
    })
    const markdown = renderMarkdownReport(run)
    expect(markdown).toContain('## Configuration errors')
    expect(markdown).toContain('Fix the benchmark check configuration (`check` / `checkArgv` / `checkShell`')
    expect(markdown).toContain('- `ch eck 1`#2: bad cfg line')
    expect(markdown).not.toContain('ch|eck')
    expect(markdown).not.toContain('bad|cfg')
    const brief = renderBriefReport(run)
    expect(brief).toContain('- WARNING: check command could not be started; fix check/checkArgv/checkShell and rerun: `ch eck 1`#2: bad cfg line')
    expect(brief).not.toContain('bad|cfg')
    // No checkError means no warning and unchanged baseline output.
    const baseline = buildRun()
    expect(renderMarkdownReport(baseline)).not.toContain('## Configuration errors')
    expect(renderBriefReport(baseline)).not.toContain('WARNING:')
    expect(renderBriefReport(baseline)).toBe('# b — m\n- trials: 0/0 completed\n')
  })

  it('renders failure clusters in sorted order with escaped text and a truncation marker', () => {
    const hostileId = 'e|rr\nx`y'
    const taskFail = (caseId: string): EvalTrialResult => ({
      caseId, trial: 1, status: 'completed', exitCode: 0, timedOut: false,
      grade: { taskSuccess: false, toolSelectionAccuracy: null },
    })
    const run = buildRun({
      cases: [
        ...[1, 2, 3, 4, 5, 6].map(index => taskFail(`case${index}`)),
        {
          caseId: hostileId, trial: 1, status: 'error', error: 'bad|cfg\nboom`x',
          exitCode: 1, timedOut: false,
        },
        {
          caseId: hostileId, trial: 2, status: 'error', error: 'bad|cfg\nboom`x',
          exitCode: 1, timedOut: false,
        },
        {
          caseId: 'cfg', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
          grade: { taskSuccess: null, toolSelectionAccuracy: null, checkError: 'oops' },
        },
        { caseId: 'timed', trial: 1, status: 'completed', exitCode: null, timedOut: true },
      ],
    })

    const brief = renderBriefReport(run)
    expect(brief).toContain('- failure clusters: task-check(6) · trial-error(2) · check-config(1) · timeout(1)')
    expect(brief).not.toContain('bad|cfg')

    const markdown = renderMarkdownReport(run)
    expect(markdown).toContain('## Failure clusters')
    expect(markdown).toContain('- Task check or answer regex did not pass (6): `case1`#1 · `case2`#1 · `case3`#1 · `case4`#1 · `case5`#1 · +1 more')
    expect(markdown).toContain('- Trial error: bad cfg boom x (2): `e rr x y`#1 · `e rr x y`#2')
    expect(markdown).toContain('- Check command could not start (configuration error) (1): `cfg`#1')
    expect(markdown).toContain('- Trial timed out (1): `timed`#1')
    expect(markdown).not.toContain('bad|cfg')
    expect(markdown).not.toContain(hostileId)
    // The pre-existing failure summaries are untouched by the new block.
    expect(markdown).toContain('## Configuration errors')
    expect(markdown).toContain('- `cfg`#1: oops')
  })

  it('keeps failure-cluster output out of runs with no failures', () => {
    const run = buildRun({ cases: [{
      caseId: 'ok', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
      grade: { taskSuccess: true, toolSelectionAccuracy: null },
    }] })
    expect(renderMarkdownReport(run)).not.toContain('## Failure clusters')
    expect(renderBriefReport(run)).not.toContain('- failure clusters:')
    // The empty-run baseline stays byte-for-byte identical.
    expect(renderBriefReport(buildRun())).toBe('# b — m\n- trials: 0/0 completed\n')
  })

  it('renders segment summaries for multiple tags in both reports', () => {
    const run = buildRun({
      judge: { provider: 'p', model: 'j', maxScore: 10 },
      cases: [
        {
          caseId: 'a', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
          tags: ['difficulty:hard', 'language:ts'],
          grade: { taskSuccess: true, toolSelectionAccuracy: null },
          judge: { finalAnswerScore: 8, hallucination: false },
        },
        {
          caseId: 'a', trial: 2, status: 'completed', exitCode: 0, timedOut: false,
          tags: ['difficulty:hard', 'language:ts'],
          grade: { taskSuccess: false, toolSelectionAccuracy: null },
          judge: { finalAnswerScore: 4, hallucination: true },
        },
        {
          caseId: 'b', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
          tags: ['difficulty:easy'],
          grade: { taskSuccess: true, toolSelectionAccuracy: null },
          judge: { finalAnswerScore: 6, hallucination: false },
        },
        // An untagged trial contributes to no segment.
        {
          caseId: 'c', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
          grade: { taskSuccess: true, toolSelectionAccuracy: null },
        },
      ],
    })
    const brief = renderBriefReport(run)
    expect(brief).toContain('- segments: difficulty:easy 100.0% · difficulty:hard 50.0% · language:ts 50.0%')
    expect(brief).toContain('- trials: 4/4 completed')

    const markdown = renderMarkdownReport(run)
    expect(markdown).toContain('## Segments')
    expect(markdown).toContain('| tag | cases | trials | task success | judge score | hallucination |')
    expect(markdown).toContain('| difficulty:easy | 1 | 1 | 100.0% | 6.0 | 0.0% |')
    expect(markdown).toContain('| difficulty:hard | 1 | 2 | 50.0% | 6.0 | 50.0% |')
    expect(markdown).toContain('| language:ts | 1 | 2 | 50.0% | 6.0 | 50.0% |')
    // Existing blocks are still present and Segments slots in after calibration.
    expect(markdown).toContain('## Reliability: task success')
    expect(markdown).toContain('## Judge calibration')
    expect(markdown.indexOf('## Segments')).toBeGreaterThan(markdown.indexOf('## Judge calibration'))

    // Untagged runs keep their exact baseline output.
    expect(renderBriefReport(buildRun())).toBe('# b — m\n- trials: 0/0 completed\n')
    expect(renderMarkdownReport(buildRun())).not.toContain('## Segments')
    expect(renderBriefReport(buildRun())).not.toContain('- segments:')
  })

  it('prints n/a and dashes for single tags without a scripted grade or judge', () => {
    const judged = buildRun({
      judge: { provider: 'p', model: 'j', maxScore: 10 },
      cases: [7, 3].map((score, index) => ({
        caseId: 'j', trial: index + 1, status: 'completed' as const,
        exitCode: 0, timedOut: false, tags: ['judge-only'],
        judge: { finalAnswerScore: score, hallucination: index === 1 },
      })),
    })
    expect(renderBriefReport(judged)).toContain('- segments: judge-only n/a')
    expect(renderMarkdownReport(judged)).toContain('| judge-only | 1 | 2 | – | 5.0 | 50.0% |')

    const ungraded = buildRun({ cases: [{
      caseId: 'u', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
      tags: ['ungraded'],
    }] })
    expect(renderBriefReport(ungraded)).toContain('- segments: ungraded n/a')
    expect(renderMarkdownReport(ungraded)).toContain('| ungraded | 1 | 1 | – | – | – |')
  })

  it('escapes hostile tag strings before they enter segments output', () => {
    const tag = 'ta|g\nx`y'
    const run = buildRun({ cases: [{
      caseId: 'c', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
      tags: [tag], grade: { taskSuccess: true, toolSelectionAccuracy: null },
    }] })
    const brief = renderBriefReport(run)
    const markdown = renderMarkdownReport(run)
    expect(brief).toContain('- segments: ta g x y 100.0%')
    expect(brief).not.toContain(tag)
    expect(markdown).toContain('| ta g x y | 1 | 1 | 100.0% | – | – |')
    expect(markdown).not.toContain(tag)
    // No raw newline or pipe from the tag may forge or split a table row.
    const rows = markdown.split('\n').filter(line => line.startsWith('|'))
    expect(rows).toHaveLength(7)
  })
})
