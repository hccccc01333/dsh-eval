import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, parse, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import type { JudgeChat } from '../src/judge.ts'
import { rejudgeRun } from '../src/rejudge.ts'
import { loadTrace, mergeTraces, traceDigest } from '../src/trace.ts'
import type { BenchmarkJudge, EvalRun, EvalTrialResult } from '../src/types.ts'

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

/** Additive report metadata returned for reports without a trace digest. */
type Rejudged = EvalRun & { rejudgeWarnings?: string[] }

/** Fixture logs live in tmpdir, so authorize that tree explicitly for legacy cases. */
function rejudge(run: EvalRun, chat: JudgeChat, override?: BenchmarkJudge): Promise<EvalRun> {
  return rejudgeRun(run, chat, override, { allowedRoot: root })
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
    expect((await rejudge(matching, chat)).cases[0]?.judge?.finalAnswerScore).toBe(8)
    const tampered = withCase(buildRun(), 0, {
      ...buildRun().cases[0]!, traceSha256: '0'.repeat(64),
    })
    await expect(rejudge(tampered, chat)).rejects.toThrow('differs from the recorded digest')
  })

  it('rebuilds verdicts from traces without touching other run data', async () => {
    const original = buildRun()
    const prompts: string[] = []
    const rejudged = await rejudge(original, async (request) => {
      prompts.push(request.prompt)
      return '{"finalAnswerScore": 8, "hallucination": false, "rationale": "matches reference"}'
    })
    expect(rejudged.cases[0]?.judge).toEqual({
      finalAnswerScore: 8, hallucination: false, rationale: 'matches reference',
    })
    expect(rejudged.cases[1]).toEqual(original.cases[1])
    expect(rejudged.grading?.finalAnswerScore).toBe(8)
    expect(prompts[0]).toContain('Reference answer: 42')
    expect(prompts[0]).toContain('Trace summary')
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
    const rejudged = await rejudge(buildRun(), async () => { throw new Error('judge down') })
    expect(rejudged.cases[0]?.judge).toMatchObject({
      finalAnswerScore: 0, judgeError: 'judge down (previous verdict kept)',
    })
    expect(rejudged.grading).toMatchObject({ taskSuccessRate: 1, finalAnswerScore: 0, judgeFailures: 1 })
    // A trial with no prior verdict has nothing to preserve.
    const fresh = withCase(buildRun(), 0, omit(buildRun().cases[0]!, 'judge'))
    const noPrior = await rejudge(fresh, async () => { throw new Error('judge down') })
    expect(noPrior.cases[0]?.judge?.finalAnswerScore).toBeNull()
    expect(noPrior.cases[0]?.judge?.judgeError).toBe('judge down')
  })

  it('uses and records a judge override, including a new rubric', async () => {
    const systems: string[] = []
    const rejudged = await rejudge(
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
    const rejudged = await rejudge(run, async () => '{"finalAnswerScore": 5, "hallucination": true}')
    expect(rejudged.cases[0]?.judge?.finalAnswerScore).toBe(5)
  })

  it('rejects reports that cannot support a judge prompt', async () => {
    const chat = async () => '{"finalAnswerScore": 1, "hallucination": false}'
    await expect(rejudge(omit(buildRun(), 'judge'), chat)).rejects.toThrow('no judge configuration')
    await expect(rejudge(omit(buildRun(), 'caseInputs'), chat)).rejects.toThrow('no caseInputs')
    await expect(rejudge(buildRun({ caseInputs: [{ caseId: 'other', prompt: 'p' }] }), chat))
      .rejects.toThrow('no case input for "c"')
    const emptyPaths = withCase(buildRun(), 0, {
      ...omit(buildRun().cases[0]!, 'tracePath'), tracePaths: [],
    })
    await expect(rejudge(emptyPaths, chat)).rejects.toThrow('has no harvested trace')
    const noTrace = withCase(buildRun(), 0, omit(omit(buildRun().cases[0]!, 'tracePath'), 'tracePaths'))
    await expect(rejudge(noTrace, chat)).rejects.toThrow('has no harvested trace')
  })

  it('accepts a trailing separator in tempRoot', async () => {
    const run = buildRun({ tempRoot: `${root}${sep}` })
    const result = await rejudge(run, async () => '{"finalAnswerScore": 5, "hallucination": false}')
    expect(result.cases[0]?.judge?.finalAnswerScore).toBe(5)
  })

  it('refuses a filesystem root or home directory as tempRoot', async () => {
    const chat = async () => '{"finalAnswerScore": 1, "hallucination": false}'
    for (const options of [undefined, { allowedRoot: root }]) {
      await expect(rejudgeRun(buildRun({ tempRoot: parse(root).root }), chat, undefined, options))
        .rejects.toThrow('dedicated run directory')
      await expect(rejudgeRun(buildRun({ tempRoot: homedir() }), chat, undefined, options))
        .rejects.toThrow('dedicated run directory')
    }
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
      await expect(rejudge(run, async () => '{"finalAnswerScore": 1, "hallucination": false}'))
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
      await expect(rejudge(run, chat)).rejects.toThrow('outside the run')
    }
  })

  it('rejudges a run whose tempRoot is a mkdtemp run directory in tmpdir with no explicit option', async () => {
    // Mirrors runner.ts: mkdtemp(join(tmpdir(), 'dsh-eval-')) and the CLI call
    // at index.ts, which passes no options. The default must not reject this.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-eval-'))
    try {
      const log = join(dir, 'session.jsonl')
      writeFileSync(log, source)
      const prompts: string[] = []
      const run = buildRun({
        tempRoot: dir,
        caseInputs: [{ caseId: 'c', prompt: 'Solve the task.' }],
        cases: [{ ...buildRun().cases[0]!, tracePaths: [log] }],
      })
      const result = await rejudgeRun(run, async (request) => {
        prompts.push(request.prompt)
        return '{"finalAnswerScore": 7, "hallucination": false}'
      })
      expect(result.cases[0]?.judge?.finalAnswerScore).toBe(7)
      expect(result.cases[0]?.judge?.hallucination).toBe(false)
      expect(prompts[0]).not.toContain('Reference answer:')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses an arbitrary tmpdir subdirectory as tempRoot by default', async () => {
    // tmpdir is shared: only mkdtemp run directories are a legitimate default.
    const foreign = mkdtempSync(join(tmpdir(), 'logs-'))
    try {
      const secret = join(foreign, 'secret.jsonl')
      writeFileSync(secret, source)
      const forged = buildRun({
        tempRoot: foreign,
        cases: [{ ...buildRun().cases[0]!, tracePaths: [secret] }],
      })
      await expect(rejudgeRun(forged, async () => '{"finalAnswerScore": 9, "hallucination": false}'))
        .rejects.toThrow('outside the allowed directory')
    } finally {
      rmSync(foreign, { recursive: true, force: true })
    }
  })

  it('refuses a forged tempRoot outside the caller-allowed directory', async () => {
    const chat = async () => '{"finalAnswerScore": 9, "hallucination": false}'
    const victim = mkdtempSync(join(tmpdir(), 'dsh-eval-rejudge-victim-'))
    try {
      const secret = join(victim, 'victim.jsonl')
      writeFileSync(secret, source)
      const forged = buildRun({
        tempRoot: victim,
        cases: [{ ...buildRun().cases[0]!, tracePaths: [secret] }],
      })
      // A report cannot escape a caller-authorized tree by editing tempRoot.
      await expect(rejudgeRun(forged, chat, undefined, { allowedRoot: root }))
        .rejects.toThrow('outside the allowed directory')
      // A symlink inside the report cannot widen the boundary either.
      const link = join(root, 'forged-link')
      symlinkSync(victim, link, 'junction')
      try {
        const throughLink = buildRun({ tempRoot: link })
        await expect(rejudgeRun(throughLink, chat, undefined, { allowedRoot: root }))
          .rejects.toThrow('outside the allowed directory')
      } finally {
        rmSync(link, { recursive: true, force: true })
      }
      // A missing path fails realpath before any report data can be trusted.
      const missing = buildRun({ tempRoot: join(root, 'no-such-dir') })
      await expect(rejudgeRun(missing, chat)).rejects.toThrow()
    } finally {
      rmSync(victim, { recursive: true, force: true })
    }
  })

  it('honors an explicitly authorized tmpdir subdirectory even without the run prefix', async () => {
    const foreign = mkdtempSync(join(tmpdir(), 'logs-'))
    try {
      const secret = join(foreign, 'secret.jsonl')
      writeFileSync(secret, source)
      const run = buildRun({
        tempRoot: foreign,
        cases: [{ ...buildRun().cases[0]!, tracePaths: [secret] }],
      })
      const result = await rejudgeRun(run, async () => '{"finalAnswerScore": 4, "hallucination": false}',
        undefined, { allowedRoot: foreign })
      expect(result.cases[0]?.judge?.finalAnswerScore).toBe(4)
    } finally {
      rmSync(foreign, { recursive: true, force: true })
    }
  })

  it('accepts a tempRoot nested inside cwd with no explicit option', async () => {
    const cwdRoot = mkdtempSync(join(process.cwd(), 'dsh-eval-rejudge-cwd-'))
    try {
      const log = join(cwdRoot, 'trial.jsonl')
      writeFileSync(log, source)
      const run = buildRun({
        tempRoot: cwdRoot,
        cases: [{ ...buildRun().cases[0]!, tracePaths: [log] }],
      })
      const result = await rejudgeRun(run, async () => '{"finalAnswerScore": 7, "hallucination": false}')
      expect(result.cases[0]?.judge?.finalAnswerScore).toBe(7)
      // The allowed root itself is also inside the boundary.
      const exact = buildRun({
        tempRoot: cwdRoot,
        cases: [{ ...buildRun().cases[0]!, tracePaths: [log] }],
      })
      const exactResult = await rejudgeRun(exact, async () => '{"finalAnswerScore": 7, "hallucination": false}',
        undefined, { allowedRoot: cwdRoot })
      expect(exactResult.cases[0]?.judge?.finalAnswerScore).toBe(7)
    } finally {
      rmSync(cwdRoot, { recursive: true, force: true })
    }
  })

  it('honors a caller-chosen allowedRoot, including a parent tree and a drive root', async () => {
    const chat = async () => '{"finalAnswerScore": 4, "hallucination": false}'
    const nested = await rejudgeRun(buildRun(), chat, undefined, { allowedRoot: dirname(root) })
    expect(nested.cases[0]?.judge?.finalAnswerScore).toBe(4)
    const widened = await rejudgeRun(buildRun(), chat, undefined, { allowedRoot: parse(root).root })
    expect(widened.cases[0]?.judge?.finalAnswerScore).toBe(4)
  })

  it('refuses a sibling whose name merely starts with the allowed directory', async () => {
    const sibling = mkdtempSync(`${root}-sibling`)
    try {
      const secret = join(sibling, 'secret.jsonl')
      writeFileSync(secret, source)
      const forged = buildRun({ tempRoot: sibling })
      const chat = async () => '{"finalAnswerScore": 1, "hallucination": false}'
      await expect(rejudgeRun(forged, chat, undefined, { allowedRoot: root }))
        .rejects.toThrow('outside the allowed directory')
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })

  it('keeps older reports working but flags evidence without a digest', async () => {
    const chat = async () => '{"finalAnswerScore": 6, "hallucination": false}'
    const unverified = await rejudge(buildRun(), chat)
    expect(unverified.cases[0]?.judge?.finalAnswerScore).toBe(6)
    expect((unverified as Rejudged).rejudgeWarnings?.[0]).toContain('no recorded traceSha256')
    const loaded = await Promise.all([earlyLog, lateLog].map(path => loadTrace(path)))
    loaded.sort((a, b) => a.createdAt - b.createdAt)
    const digest = traceDigest(mergeTraces(loaded))
    const verified = withCase(buildRun(), 0, { ...buildRun().cases[0]!, traceSha256: digest })
    const result = await rejudge(verified, chat)
    expect((result as Rejudged).rejudgeWarnings).toBeUndefined()
  })
})
