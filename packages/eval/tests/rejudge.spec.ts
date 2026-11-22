import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, parse, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { rejudgeRun } from '../src/rejudge.ts'
import { loadTrace, mergeTraces, traceDigest } from '../src/trace.ts'
import type { EvalRun, EvalTrialResult } from '../src/types.ts'

const FIXTURE_LOG = fileURLToPath(new URL('./fixtures/session.jsonl', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'dsh-eval-rejudge-'))
const source = readFileSync(FIXTURE_LOG, 'utf8')
const earlyLog = join(root, 'early.jsonl')
const lateLog = join(root, 'late.jsonl')
writeFileSync(earlyLog, source.replace('1700000000000', '1600000000000'))
writeFileSync(lateLog, source)
afterAll(() => rmSync(root, { recursive: true, force: true }))

const METRICS = {
  turns: 1, steps: 2, toolCalls: 1, toolResults: 1, toolSuccess: 1, toolSuccessRate: 1,
  invalidToolCalls: 0, retries: 0,
  tokens: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
  totalTokens: 10, contextTokens: 10, llmMs: 1, toolMs: 1, ttftMs: 1,
  latencyMs: 100, costUsd: null,
}

function buildRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    benchmark: 'b', model: 'm', createdAt: 1, trials: 1, seed: 0, pricing: null,
    judge: { provider: 'deepseek', model: 'judge-m', maxScore: 10 },
    tempRoot: root,
    caseInputs: [{ caseId: 'c', prompt: 'Solve the task.', answer: '42' }],
    cases: [
      {
        caseId: 'c', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
        tracePaths: [lateLog, earlyLog], metrics: METRICS,
        grade: { taskSuccess: true, toolSelectionAccuracy: null },
        judge: { finalAnswerScore: 0, hallucination: false },
      },
      { caseId: 'c', trial: 2, status: 'error', error: 'boom', exitCode: 1, timedOut: false },
    ],
    aggregate: METRICS,
    grading: {
      taskSuccessRate: 1, toolSelectionAccuracyRate: null,
      finalAnswerScore: 0, hallucinationRate: 0,
    },
    ...overrides,
  }
}

/** Omit an optional key instead of assigning `undefined` (exactOptionalPropertyTypes). */
function omit<T extends object, K extends keyof T>(value: T, key: K): T {
  const copy: Partial<T> = { ...value }
  delete copy[key]
  return copy as T
}

function withCase(run: EvalRun, index: number, result: EvalTrialResult): EvalRun {
  const cases = [...run.cases]
  cases[index] = result
  return { ...run, cases }
}

describe('dsh-eval offline re-judging', () => {
  it('accepts a matching recorded trace digest and rejects a tampered trace', async () => {
    const loaded = await Promise.all([earlyLog, lateLog].map(path => loadTrace(path)))
    loaded.sort((a, b) => a.createdAt - b.createdAt)
    const digest = traceDigest(mergeTraces(loaded))
    const chat = async () => '{"finalAnswerScore": 8, "hallucination": false}'
    const matching = withCase(buildRun(), 0, { ...buildRun().cases[0]!, traceSha256: digest })
    expect((await rejudgeRun(matching, chat)).cases[0]?.judge?.finalAnswerScore).toBe(8)
    const tampered = withCase(buildRun(), 0, {
      ...buildRun().cases[0]!, traceSha256: '0'.repeat(64),
    })
    await expect(rejudgeRun(tampered, chat)).rejects.toThrow('differs from the recorded digest')
  })

  it('rebuilds verdicts from traces without touching other run data', async () => {
    const original = buildRun()
    const prompts: string[] = []
    const rejudged = await rejudgeRun(original, async (request) => {
      prompts.push(request.prompt)
      return '{"finalAnswerScore": 8, "hallucination": false, "rationale": "matches reference"}'
    })
    expect(rejudged.cases[0]?.judge).toEqual({
      finalAnswerScore: 8, hallucination: false, rationale: 'matches reference',
    })
    expect(rejudged.cases[1]).toEqual(original.cases[1])
    expect(rejudged.grading?.finalAnswerScore).toBe(8)
    expect(prompts[0]).toContain('Reference answer: 42')
    expect(prompts[0]).toContain('Trace summary:')
    expect({
      grade: rejudged.cases[0]?.grade, metrics: rejudged.cases[0]?.metrics,
      aggregate: rejudged.aggregate, caseInputs: rejudged.caseInputs,
      tempRoot: rejudged.tempRoot, judge: rejudged.judge,
    }).toEqual({
      grade: original.cases[0]?.grade, metrics: original.cases[0]?.metrics,
      aggregate: original.aggregate, caseInputs: original.caseInputs,
      tempRoot: original.tempRoot, judge: original.judge,
    })
    // The original run is untouched.
    expect(original.cases[0]?.judge?.finalAnswerScore).toBe(0)
  })

  it('keeps a usable previous verdict when the new judge call fails', async () => {
    const rejudged = await rejudgeRun(buildRun(), async () => { throw new Error('judge down') })
    expect(rejudged.cases[0]?.judge).toMatchObject({
      finalAnswerScore: 0, judgeError: 'judge down (previous verdict kept)',
    })
    expect(rejudged.grading).toMatchObject({ taskSuccessRate: 1, finalAnswerScore: 0, judgeFailures: 1 })
    // A trial with no prior verdict has nothing to preserve.
    const fresh = withCase(buildRun(), 0, omit(buildRun().cases[0]!, 'judge'))
    const noPrior = await rejudgeRun(fresh, async () => { throw new Error('judge down') })
    expect(noPrior.cases[0]?.judge?.finalAnswerScore).toBeNull()
    expect(noPrior.cases[0]?.judge?.judgeError).toBe('judge down')
  })

  it('uses and records a judge override, including a new rubric', async () => {
    const systems: string[] = []
    const rejudged = await rejudgeRun(
      omit(buildRun(), 'judge'),
      async (request) => { systems.push(request.system); return '{"finalAnswerScore": 5, "hallucination": true}' },
      { provider: 'openai', model: 'judge-v2', maxScore: 20, rubric: 'Be strict.' },
    )
    expect(systems[0]).toContain('Be strict.')
    expect(systems[0]).toContain('0..20')
    expect(rejudged.judge).toEqual({
      provider: 'openai', model: 'judge-v2', maxScore: 20, rubric: 'Be strict.',
    })
    expect(rejudged.cases[0]?.judge?.finalAnswerScore).toBe(5)
  })

  it('falls back to a single tracePath', async () => {
    const run = withCase(buildRun(), 0, {
      ...omit(buildRun().cases[0]!, 'tracePaths'), tracePath: lateLog,
    })
    const rejudged = await rejudgeRun(run, async () => '{"finalAnswerScore": 5, "hallucination": true}')
    expect(rejudged.cases[0]?.judge?.finalAnswerScore).toBe(5)
  })

  it('rejects reports that cannot support a judge prompt', async () => {
    const chat = async () => '{"finalAnswerScore": 1, "hallucination": false}'
    await expect(rejudgeRun(omit(buildRun(), 'judge'), chat)).rejects.toThrow('no judge configuration')
    await expect(rejudgeRun(omit(buildRun(), 'caseInputs'), chat)).rejects.toThrow('no caseInputs')
    await expect(rejudgeRun(buildRun({ caseInputs: [{ caseId: 'other', prompt: 'p' }] }), chat))
      .rejects.toThrow('no case input for "c"')
    const emptyPaths = withCase(buildRun(), 0, {
      ...omit(buildRun().cases[0]!, 'tracePath'), tracePaths: [],
    })
    await expect(rejudgeRun(emptyPaths, chat)).rejects.toThrow('has no harvested trace')
    const noTrace = withCase(buildRun(), 0, omit(omit(buildRun().cases[0]!, 'tracePath'), 'tracePaths'))
    await expect(rejudgeRun(noTrace, chat)).rejects.toThrow('has no harvested trace')
  })

  it('accepts a trailing separator in tempRoot', async () => {
    const run = buildRun({ tempRoot: `${root}${sep}` })
    const result = await rejudgeRun(run, async () => '{"finalAnswerScore": 5, "hallucination": false}')
    expect(result.cases[0]?.judge?.finalAnswerScore).toBe(5)
  })

  it('refuses a filesystem root or home directory as tempRoot', async () => {
    const chat = async () => '{"finalAnswerScore": 1, "hallucination": false}'
    await expect(rejudgeRun(buildRun({ tempRoot: parse(root).root }), chat))
      .rejects.toThrow('dedicated run directory')
    await expect(rejudgeRun(buildRun({ tempRoot: homedir() }), chat))
      .rejects.toThrow('dedicated run directory')
  })

  it('refuses trace paths reached through a symlink outside the root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'dsh-eval-rejudge-outside-'))
    try {
      const secret = join(outside, 'secret.jsonl')
      writeFileSync(secret, source)
      const link = join(root, 'escape-link')
      symlinkSync(outside, link, 'junction')
      const run = withCase(buildRun(), 0, {
        ...buildRun().cases[0]!, tracePaths: [join(link, 'secret.jsonl')],
      })
      await expect(rejudgeRun(run, async () => '{"finalAnswerScore": 1, "hallucination": false}'))
        .rejects.toThrow('outside the run')
    } finally {
      rmSync(join(root, 'escape-link'), { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses trace paths outside the run root', async () => {
    const chat = async () => '{"finalAnswerScore": 1, "hallucination": false}'
    const traversal = join(root, '..', `${root.split(/[\\/]/u).at(-1)}--escape`, 'secret.jsonl')
    for (const paths of [[FIXTURE_LOG], ['relative.jsonl'], [join(root, 'notes.txt')], [traversal]]) {
      const run = withCase(buildRun(), 0, { ...buildRun().cases[0]!, tracePaths: paths })
      await expect(rejudgeRun(run, chat)).rejects.toThrow('outside the run')
    }
  })
})
