import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadRunReport, renderMarkdownReport, writeRunReport } from '../src/report.ts'
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
    const run = buildRun({ benchmark: 'roundtrip' })
    await writeRunReport(run, path)
    expect(readFileSync(path, 'utf8')).toMatch(/"benchmark": "roundtrip"/u)
    expect(await loadRunReport(path)).toEqual(run)
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

  it('renders completed and failed trials plus the aggregate row', () => {
    const run = buildRun({
      benchmark: 'render-me',
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
})
