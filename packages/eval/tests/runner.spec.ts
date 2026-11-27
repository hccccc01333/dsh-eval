import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hashBenchmarkOverrides } from '../src/digest.ts'
import { runBenchmark } from '../src/runner.ts'
import type { Benchmark } from '../src/types.ts'

const FAKE_SCRIPT = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url))
const FIXTURE_LOG = fileURLToPath(new URL('./fixtures/session.jsonl', import.meta.url))
const CHECK_OK = fileURLToPath(new URL('./fixtures/check-ok.mjs', import.meta.url))
const CHECK_FAIL = fileURLToPath(new URL('./fixtures/check-fail.mjs', import.meta.url))
const LINGERING_CHECK = fileURLToPath(new URL('./fixtures/check-lingering.mjs', import.meta.url))

// Coverage instrumentation slows the real child spawns enough to exceed the
// default five-second per-test timeout.
vi.setConfig({ testTimeout: 30_000 })

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-eval-runner-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function buildBenchmark(overrides: Partial<Benchmark> = {}): Benchmark {
  return {
    name: 'runner-smoke',
    model: 'deepseek-v4',
    profile: 'headless',
    command: [process.execPath, FAKE_SCRIPT],
    trials: 2,
    concurrency: 1,
    timeoutMs: 30_000,
    seed: 0,
    cases: [{ id: 'hello', prompt: 'Say hello.' }],
    pricing: {
      'deepseek-v4': {
        inputUsdPerMTokens: 0.27,
        cacheReadUsdPerMTokens: 0.07,
        cacheWriteUsdPerMTokens: 0.27,
        outputUsdPerMTokens: 1.10,
      },
    },
    baseDir: process.cwd(),
    ...overrides,
  }
}

describe('dsh-eval benchmark runner', () => {
  it('carries case tags into each trial report', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const run = await runBenchmark(buildBenchmark({
      trials: 1,
      cases: [{ id: 'tagged', prompt: 'p', tags: ['hard', 'ts'] }],
    }), { tempRoot: tempDir() })
    expect(run.cases[0]?.tags).toEqual(['hard', 'ts'])
  })

  it('passes a distinct derived seed to every trial', async () => {
    const dir = tempDir()
    const script = join(dir, 'seed-dsh.mjs')
    writeFileSync(script, [
      "import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      "writeFileSync(join(process.cwd(), 'seed.txt'), process.env.DSH_EVAL_SEED ?? 'missing')",
      "const dir = join(process.env.DSH_HOME, 'sessions', 'project', 'session-1')",
      'mkdirSync(dir, { recursive: true })',
      "copyFileSync(process.env.FAKE_DASH_LOG, join(dir, 'session.jsonl'))",
      '',
    ].join('\n'))
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const run = await runBenchmark(buildBenchmark({
      seed: 41, trials: 3, command: [process.execPath, script],
    }), { tempRoot: tempDir() })
    expect(run.cases.map((_, index) => readFileSync(
      join(run.tempRoot, `hello-${index + 1}`, 'workspace', 'seed.txt'), 'utf8',
    ))).toEqual(['41', '42', '43'])
  })

  it('emits progress for every finished trial', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const events: [string, number, number][] = []
    await runBenchmark(buildBenchmark({ trials: 2 }), {
      tempRoot: tempDir(),
      onProgress: (result, finished, total) => events.push([result.status, finished, total]),
    })
    expect(events).toEqual([['completed', 1, 2], ['completed', 2, 2]])

    process.env.FAKE_DASH_MODE = 'none'
    const errors: string[] = []
    await runBenchmark(buildBenchmark({ trials: 1 }), {
      tempRoot: tempDir(),
      onProgress: result => errors.push(result.status),
    })
    expect(errors).toEqual(['error'])
  })

  it('does not let a failing progress observer abort a run', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const run = await runBenchmark(buildBenchmark({ trials: 2 }), {
      tempRoot: tempDir(),
      onProgress: () => { throw new Error('observer failure') },
    })
    expect(run.cases).toHaveLength(2)

    process.env.FAKE_DASH_MODE = 'log'
    const withAsyncObserver = await runBenchmark(buildBenchmark({ trials: 1 }), {
      tempRoot: tempDir(),
      onProgress: () => Promise.reject(new Error('async observer failure')) as unknown as void,
    })
    expect(withAsyncObserver.cases).toHaveLength(1)
  })

  it('persists case inputs so a stored run can be re-judged', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const run = await runBenchmark(buildBenchmark({
      trials: 1,
      cases: [{ id: 'golden', prompt: 'What is the answer?', expected: { answer: '42' } }],
    }), { tempRoot: tempDir() })
    expect(run.caseInputs).toEqual([{
      caseId: 'golden', prompt: 'What is the answer?', answer: '42',
    }])
  })

  it('persists CLI overrides in the provenance digest', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const base = 'a'.repeat(64)
    const benchmark = buildBenchmark({ trials: 1 })
    benchmark.sourceSha256 = base
    const run = await runBenchmark(benchmark, {
      tempRoot: tempDir(), trials: 2, concurrency: 3, profile: 'custom',
      command: [process.execPath, FAKE_SCRIPT],
    })
    expect(run.benchmarkOverrides).toEqual({
      trials: 2, concurrency: 3, profile: 'custom',
      dshCommand: [process.execPath, FAKE_SCRIPT],
    })
    expect(run.benchmarkSha256).toBe(hashBenchmarkOverrides(base, run.benchmarkOverrides!))
    expect(run.benchmarkSha256).not.toBe(base)
  })

  it('defaults the temp root and pricing, and records a seed override', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const benchmark = buildBenchmark({ trials: 1 })
    delete benchmark.pricing
    // No tempRoot override: the platform temp dir is the fallback.
    const run = await runBenchmark(benchmark, { seed: 7 })
    dirs.push(run.tempRoot)
    expect(run.seed).toBe(7)
    expect(run.benchmarkOverrides).toEqual({ seed: 7 })
    expect(run.pricing).toBeNull()
    expect(run.cases[0]?.status).toBe('completed')
  })

  it('runs every trial, harvests traces, and folds metrics', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const benchmark = buildBenchmark()
    benchmark.sourceSha256 = 'deadbeef'
    const run = await runBenchmark(benchmark, { tempRoot: tempDir() })
    expect(run.benchmark).toBe('runner-smoke')
    expect(run.benchmarkSha256).toBe('deadbeef')
    expect(run.trials).toBe(2)
    expect(run.pricing).not.toBeNull()
    expect(run.cases).toHaveLength(2)
    for (const result of run.cases) {
      expect(result.status).toBe('completed')
      expect(result.exitCode).toBe(0)
      expect(result.timedOut).toBe(false)
      expect(result.tracePath).toBeTruthy()
      expect(result.metrics?.steps).toBe(1)
      expect(result.metrics?.costUsd).toBeCloseTo(5.25e-6, 12)
    }
    expect(run.aggregate?.steps).toBe(1)
    expect(run.aggregate?.toolSuccessRate).toBe(1)
    expect(run.grading).toBeNull()
  })

  it('copies the case workspace into each trial', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const workspace = tempDir()
    writeFileSync(join(workspace, 'seed.txt'), 'seed')
    const tempRoot = tempDir()
    const run = await runBenchmark(buildBenchmark({ cases: [{ id: 'ws', prompt: 'p', workspace }], trials: 1 }), { tempRoot })
    expect(run.cases[0]?.status).toBe('completed')
    expect(existsSync(join(run.tempRoot, 'ws-1', 'workspace', 'seed.txt'))).toBe(true)
  })

  it('applies command, profile, and trials overrides', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const run = await runBenchmark(buildBenchmark(), {
      command: [process.execPath, FAKE_SCRIPT],
      profile: 'custom-profile',
      trials: 1,
      tempRoot: tempDir(),
    })
    expect(run.trials).toBe(1)
    expect(run.cases).toHaveLength(1)
  })

  it('keeps case-then-trial order while running the pool concurrently', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const run = await runBenchmark(buildBenchmark({
      concurrency: 2,
      trials: 2,
      cases: [
        { id: 'alpha', prompt: 'a' },
        { id: 'beta', prompt: 'b' },
        { id: 'gamma', prompt: 'c' },
      ],
    }), { tempRoot: tempDir() })
    expect(run.cases.map(result => `${result.caseId}-${result.trial}`)).toEqual([
      'alpha-1', 'alpha-2', 'beta-1', 'beta-2', 'gamma-1', 'gamma-2',
    ])
    expect(run.cases.every(result => result.status === 'completed')).toBe(true)
  })

  it('overlaps trials when the concurrency override exceeds one', async () => {
    process.env.FAKE_DASH_MODE = 'delay'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    process.env.FAKE_DASH_DELAY_MS = '1200'
    const start = Date.now()
    // The benchmark itself stays serial; the override is what parallelizes it.
    const run = await runBenchmark(buildBenchmark({ trials: 4 }), {
      tempRoot: tempDir(),
      concurrency: 4,
    })
    const elapsed = Date.now() - start
    expect(run.cases).toHaveLength(4)
    expect(run.cases.every(result => result.status === 'completed')).toBe(true)
    // Four serial 1200ms trials need ~4800ms; the threshold still proves real
    // overlap while tolerating a loaded CI runner with coverage instrumentation.
    expect(elapsed).toBeLessThan(4500)
  })

  it('rejects the run when a trial setup throws', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const missing = join(tempDir(), 'does-not-exist')
    await expect(runBenchmark(
      buildBenchmark({ concurrency: 2, cases: [{ id: 'gone', prompt: 'p', workspace: missing }] }),
      { tempRoot: tempDir() },
    )).rejects.toThrow(/ENOENT/u)
  })

  it('reports a missing log as an error trial', async () => {
    process.env.FAKE_DASH_MODE = 'none'
    const run = await runBenchmark(buildBenchmark({ trials: 1 }), { tempRoot: tempDir() })
    expect(run.cases[0]).toMatchObject({ status: 'error', exitCode: 0, timedOut: false })
    expect(run.cases[0]?.error).toContain('no session log found')
    expect(run.aggregate).toBeNull()
  })

  it('includes the child stderr tail in the error', async () => {
    process.env.FAKE_DASH_MODE = 'stderr'
    const run = await runBenchmark(buildBenchmark({ trials: 1 }), { tempRoot: tempDir() })
    expect(run.cases[0]?.error).toContain('fake dsh exploded')
  })

  it('caps oversized child output on both streams', async () => {
    process.env.FAKE_DASH_MODE = 'output'
    const run = await runBenchmark(buildBenchmark({ trials: 1 }), { tempRoot: tempDir() })
    expect(run.cases[0]?.status).toBe('error')
    expect(run.cases[0]?.error).toContain('no session log found')
  })

  it('reports a corrupt trace as an error trial', async () => {
    process.env.FAKE_DASH_MODE = 'badlog'
    const run = await runBenchmark(buildBenchmark({ trials: 1 }), { tempRoot: tempDir() })
    expect(run.cases[0]?.status).toBe('error')
    expect(run.cases[0]?.error).toContain('failed to read trace')
  })

  it('kills a timed-out trial and reports it orthogonally', async () => {
    process.env.FAKE_DASH_MODE = 'sleep'
    const run = await runBenchmark(buildBenchmark({ trials: 1, timeoutMs: 300 }), { tempRoot: tempDir() })
    expect(run.cases[0]).toMatchObject({ status: 'error', timedOut: true, exitCode: null })
    expect(run.cases[0]?.error).toContain('timed out')
  })

  it('applies a per-case timeout over the benchmark default', async () => {
    process.env.FAKE_DASH_MODE = 'sleep'
    const benchmark = buildBenchmark({ trials: 1, timeoutMs: 5000 })
    benchmark.cases[0]!.timeoutMs = 300
    const run = await runBenchmark(benchmark, { tempRoot: tempDir() })
    expect(run.cases[0]).toMatchObject({ status: 'error', timedOut: true, exitCode: null })
  })

  it('rejects invalid run overrides before creating a temp root', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    await expect(runBenchmark(buildBenchmark(), { trials: 0 }))
      .rejects.toThrow('trials must be a positive integer')
    await expect(runBenchmark(buildBenchmark(), { trials: Number.POSITIVE_INFINITY }))
      .rejects.toThrow('trials must be a positive integer')
    await expect(runBenchmark(buildBenchmark(), { concurrency: 0 }))
      .rejects.toThrow('concurrency must be a positive integer')
    await expect(runBenchmark(buildBenchmark(), { seed: 1.5 }))
      .rejects.toThrow('seed must be a safe integer')
    await expect(runBenchmark(buildBenchmark(), { seed: Number.POSITIVE_INFINITY }))
      .rejects.toThrow('seed must be a safe integer')
  })

  it('turns a spawn failure into an error trial', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    const run = await runBenchmark(buildBenchmark({ command: ['dsh-definitely-missing-xyz'], trials: 1 }), { tempRoot: tempDir() })
    expect(run.cases[0]?.status).toBe('error')
    expect(run.cases[0]?.error).toContain('failed to spawn dsh')
  })

  it('rejects an empty command as an error trial', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    const run = await runBenchmark(buildBenchmark({ command: [], trials: 1 }), { tempRoot: tempDir() })
    expect(run.cases[0]?.status).toBe('error')
    expect(run.cases[0]?.error).toContain('failed to spawn dsh')
  })

  it('grades tool selection accuracy from expected tool names', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const matched = await runBenchmark(buildBenchmark({
      trials: 1,
      cases: [{ id: 'matched', prompt: 'p', expected: { tool: 'bash' } }],
    }), { tempRoot: tempDir() })
    expect(matched.cases[0]?.grade).toEqual({ taskSuccess: null, toolSelectionAccuracy: true })
    expect(matched.grading).toEqual({
      taskSuccessRate: null,
      toolSelectionAccuracyRate: 1,
      finalAnswerScore: null,
      hallucinationRate: null,
      judgeFailures: 0,
    })

    const missed = await runBenchmark(buildBenchmark({
      trials: 1,
      cases: [{ id: 'missed', prompt: 'p', expected: { tool: 'web_search' } }],
    }), { tempRoot: tempDir() })
    expect(missed.cases[0]?.grade).toEqual({ taskSuccess: null, toolSelectionAccuracy: false })
    expect(missed.grading?.toolSelectionAccuracyRate).toBe(0)
  })

  it('grades task success from the check command exit code', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const passing = await runBenchmark(buildBenchmark({
      trials: 1,
      cases: [{ id: 'pass', prompt: 'p', expected: { check: `${process.execPath} ${CHECK_OK}` } }],
    }), { tempRoot: tempDir() })
    expect(passing.cases[0]?.grade).toEqual({ taskSuccess: true, toolSelectionAccuracy: null })
    expect(passing.grading?.taskSuccessRate).toBe(1)

    const failing = await runBenchmark(buildBenchmark({
      trials: 1,
      cases: [{ id: 'fail', prompt: 'p', expected: { check: `${process.execPath} ${CHECK_FAIL}` } }],
    }), { tempRoot: tempDir() })
    expect(failing.cases[0]?.grade).toEqual({ taskSuccess: false, toolSelectionAccuracy: null })
    expect(failing.grading?.taskSuccessRate).toBe(0)
  })

  it('grades task success from an answer regex without a check command or judge', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const passing = await runBenchmark(buildBenchmark({
      trials: 1,
      cases: [{ id: 'regex', prompt: 'p', expected: { answerRegex: '^Hi$' } }],
    }), { tempRoot: tempDir() })
    expect(passing.cases[0]?.grade).toEqual({ taskSuccess: true, toolSelectionAccuracy: null })
    expect(passing.grading?.taskSuccessRate).toBe(1)

    const failing = await runBenchmark(buildBenchmark({
      trials: 1,
      cases: [{ id: 'regex', prompt: 'p', expected: { answerRegex: '^Bye$' } }],
    }), { tempRoot: tempDir() })
    expect(failing.cases[0]?.grade).toEqual({ taskSuccess: false, toolSelectionAccuracy: null })

    const malformed = await runBenchmark(buildBenchmark({
      trials: 1,
      cases: [{ id: 'regex', prompt: 'p', expected: { answerRegex: '[' } }],
    }), { tempRoot: tempDir() })
    expect(malformed.cases[0]?.status).toBe('completed')
    expect(malformed.cases[0]?.grade).toEqual({ taskSuccess: false, toolSelectionAccuracy: null })
  })

  it('matches an end-anchored answerRegex past the first 4096 characters', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    // The marker lands beyond the old truncation point, so `DONE$` only matches
    // when the regex sees the complete final assistant answer.
    const longAnswer = `${'x'.repeat(4200)}DONE`
    const log = join(tempDir(), 'session.jsonl')
    writeFileSync(log, readFileSync(FIXTURE_LOG, 'utf8').trim().split('\n').map(line => {
      const record = JSON.parse(line) as {
        type?: string
        data?: { message?: { content?: { type: string; text?: string }[] } }
      }
      if (record.type === 'assistant/message' && record.data?.message?.content !== undefined) {
        record.data.message.content = [{ type: 'text', text: longAnswer }]
        return JSON.stringify(record)
      }
      return line
    }).join('\n') + '\n')
    process.env.FAKE_DASH_LOG = log
    const run = await runBenchmark(buildBenchmark({
      trials: 1,
      cases: [{ id: 'regex', prompt: 'p', expected: { answerRegex: 'DONE$' } }],
    }), { tempRoot: tempDir() })
    expect(run.cases[0]?.grade).toEqual({ taskSuccess: true, toolSelectionAccuracy: null })
    expect(run.grading?.taskSuccessRate).toBe(1)
  })

  it('matches every configured tool expectation', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const grade = async (expected: Record<string, unknown>): Promise<boolean | null> => {
      const run = await runBenchmark(buildBenchmark({
        trials: 1,
        cases: [{ id: 'tools', prompt: 'p', expected }],
      }), { tempRoot: tempDir() })
      return run.cases[0]?.grade?.toolSelectionAccuracy ?? null
    }
    // The fixture records a single `bash` tool call.
    expect(await grade({ tools: ['bash'] })).toBe(true)
    expect(await grade({ tools: ['bash', 'missing'] })).toBe(false)
    expect(await grade({ toolAnyOf: ['missing', 'bash'] })).toBe(true)
    expect(await grade({ toolAnyOf: ['missing', 'other'] })).toBe(false)
    expect(await grade({ toolRegex: '^ba.h$' })).toBe(true)
    expect(await grade({ toolRegex: '^read$' })).toBe(false)
    expect(await grade({ toolNot: ['read'] })).toBe(true)
    expect(await grade({ toolNot: ['bash'] })).toBe(false)
    expect(await grade({
      tool: 'ba', tools: ['bash'], toolAnyOf: ['bash'], toolRegex: 'bash', toolNot: ['read'],
    })).toBe(true)
    // A hand-built benchmark can bypass the schema; invalid regex fails closed.
    expect(await grade({ toolRegex: '[' })).toBe(false)
  })

  it('runs checkArgv verbatim and supports opt-in shell checks', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const argv = await runBenchmark(buildBenchmark({
      trials: 1,
      cases: [{ id: 'argv', prompt: 'p', expected: { checkArgv: [process.execPath, CHECK_OK, 'a b'] } }],
    }), { tempRoot: tempDir() })
    expect(argv.cases[0]?.grade?.taskSuccess).toBe(true)

    const shell = await runBenchmark(buildBenchmark({
      trials: 1,
      cases: [{ id: 'shell', prompt: 'p', expected: { checkShell: `"${process.execPath}" "${CHECK_OK}"` } }],
    }), { tempRoot: tempDir() })
    expect(shell.cases[0]?.grade?.taskSuccess).toBe(true)
  })

  it('kills a hanging detached check at the trial timeout', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const started = Date.now()
    const run = await runBenchmark(buildBenchmark({
      trials: 1,
      timeoutMs: 1000,
      cases: [{
        id: 'hanging', prompt: 'p',
        expected: { checkArgv: [process.execPath, '-e', 'setTimeout(() => {}, 30000)'] },
      }],
    }), { tempRoot: tempDir() })
    expect(Date.now() - started).toBeLessThan(8000)
    expect(run.cases[0]?.grade?.taskSuccess).toBe(false)
  })

  it('does not hang when a check leaves a grandchild holding stdio open', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const started = Date.now()
    const run = await runBenchmark(buildBenchmark({
      trials: 1,
      timeoutMs: 3000,
      cases: [{
        id: 'lingering', prompt: 'p',
        expected: { checkArgv: [process.execPath, LINGERING_CHECK] },
      }],
    }), { tempRoot: tempDir() })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(run.cases[0]?.grade?.taskSuccess).toBe(true)
  })

  it('reads a failing or missing check as task failure', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const run = await runBenchmark(buildBenchmark({
      trials: 1,
      cases: [{ id: 'missing-check', prompt: 'p', expected: { check: 'definitely-missing-check-xyz' } }],
    }), { tempRoot: tempDir() })
    expect(run.cases[0]?.grade?.taskSuccess).toBe(false)
  })

  it('surfaces a check spawn failure as checkError in the grade', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const missing = '/nonexistent/definitely-missing-check'
    const run = await runBenchmark(buildBenchmark({
      trials: 1,
      cases: [{ id: 'spawn-fail', prompt: 'p', expected: { checkArgv: [missing] } }],
    }), { tempRoot: tempDir() })
    expect(run.cases[0]?.status).toBe('completed')
    expect(run.cases[0]?.grade?.taskSuccess).toBe(false)
    // The reason names the missing command (or the spawn ENOENT) and stays one line.
    expect(run.cases[0]?.grade?.checkError).toMatch(/ENOENT|definitely-missing-check/u)
    expect(run.cases[0]?.grade?.checkError).not.toMatch(/[\x00-\x1f\x7f-\x9f]/u)
  })

  it('does not mark a nonzero check exit or an invalid answerRegex as a spawn error', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const failingCheck = await runBenchmark(buildBenchmark({
      trials: 1,
      cases: [{ id: 'fail', prompt: 'p', expected: { checkArgv: [process.execPath, CHECK_FAIL] } }],
    }), { tempRoot: tempDir() })
    expect(failingCheck.cases[0]?.grade?.taskSuccess).toBe(false)
    expect(failingCheck.cases[0]?.grade?.checkError).toBeUndefined()

    const malformedRegex = await runBenchmark(buildBenchmark({
      trials: 1,
      cases: [{ id: 'regex', prompt: 'p', expected: { answerRegex: '[' } }],
    }), { tempRoot: tempDir() })
    expect(malformedRegex.cases[0]?.grade?.taskSuccess).toBe(false)
    expect(malformedRegex.cases[0]?.grade?.checkError).toBeUndefined()
  })

  it('sanitizes case ids for trial directories', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const tempRoot = tempDir()
    const run = await runBenchmark(buildBenchmark({
      trials: 1,
      cases: [{ id: 'bad id/../', prompt: 'p' }, { id: '///', prompt: 'q' }],
    }), { tempRoot })
    expect(run.cases[0]?.status).toBe('completed')
    expect(run.cases[1]?.status).toBe('completed')
    expect(existsSync(join(run.tempRoot, 'bad-id-..-1'))).toBe(true)
    expect(existsSync(join(run.tempRoot, 'case-1'))).toBe(true)
  })

  it('merges child session logs into the trial trace', async () => {
    process.env.FAKE_DASH_MODE = 'merge'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const run = await runBenchmark(buildBenchmark({ trials: 1 }), { tempRoot: tempDir() })
    const result = run.cases[0]
    expect(result?.status).toBe('completed')
    expect(result?.tracePaths).toHaveLength(2)
    expect(result?.traceSha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(result?.metrics?.steps).toBe(2)
    expect(result?.metrics?.toolCalls).toBe(2)
    expect(result?.metrics?.toolResults).toBe(2)
    expect(result?.metrics?.retries).toBe(1)
  })

  it('runs the LLM judge seam and pools verdicts', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const run = await runBenchmark(buildBenchmark({
      trials: 2,
      judge: { provider: 'deepseek', model: 'judge-m', maxScore: 10 },
    }), {
      tempRoot: tempDir(),
      judgeChat: async () => JSON.stringify({ finalAnswerScore: 8, hallucination: false, rationale: 'ok' }),
    })
    expect(run.judge).toEqual({ provider: 'deepseek', model: 'judge-m', maxScore: 10 })
    for (const result of run.cases) {
      expect(result.judge).toEqual({ finalAnswerScore: 8, hallucination: false, rationale: 'ok' })
    }
    expect(run.grading?.finalAnswerScore).toBe(8)
    expect(run.grading?.hallucinationRate).toBe(0)
  })

  it('keeps a trial completed when the judge call fails', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const run = await runBenchmark(buildBenchmark({
      trials: 1,
      judge: { provider: 'deepseek', model: 'judge-m', maxScore: 10 },
    }), {
      tempRoot: tempDir(),
      judgeChat: async () => { throw new Error('judge down') },
    })
    expect(run.cases[0]?.status).toBe('completed')
    expect(run.cases[0]?.judge).toMatchObject({
      finalAnswerScore: null, hallucination: null, judgeError: 'judge down',
    })
    // A failed judge is now visible in the run instead of silently lowering the mean.
    expect(run.grading).toMatchObject({
      finalAnswerScore: null, hallucinationRate: null, judgeFailures: 1,
    })
  })

  it('rejects a judge benchmark without a chat seam', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    await expect(runBenchmark(buildBenchmark({
      trials: 1,
      judge: { provider: 'deepseek', model: 'judge-m', maxScore: 10 },
    }), { tempRoot: tempDir() })).rejects.toThrow('no LLM chat seam')
  })

  it('mounts the keyless replay plugin from recorded logs', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const replayDir = tempDir()
    const fixtureDir = join(replayDir, 'hello-1')
    mkdirSync(fixtureDir, { recursive: true })
    copyFileSync(FIXTURE_LOG, join(fixtureDir, 'session.jsonl'))
    const childDir = join(fixtureDir, 'child')
    mkdirSync(childDir, { recursive: true })
    const childLog = join(childDir, 'session.jsonl')
    copyFileSync(FIXTURE_LOG, childLog)
    utimesSync(childLog, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000))
    const run = await runBenchmark(buildBenchmark({ trials: 1, replay: { dir: replayDir } }), { tempRoot: tempDir() })
    expect(run.cases[0]?.status).toBe('completed')
    const overlay = readFileSync(join(run.tempRoot, 'hello-1', 'eval.cordis.yml'), 'utf8')
    expect(overlay).toContain('llm-replay')
    expect(overlay).toContain(JSON.stringify(join(fixtureDir, 'session.jsonl')))
    expect(overlay).toContain(JSON.stringify([childLog]))
    const childlessReplay = tempDir()
    const singleFixture = join(childlessReplay, 'hello-1')
    mkdirSync(singleFixture, { recursive: true })
    copyFileSync(FIXTURE_LOG, join(singleFixture, 'session.jsonl'))
    const childless = await runBenchmark(
      buildBenchmark({ trials: 1, replay: { dir: childlessReplay } }),
      { tempRoot: tempDir() },
    )
    const childlessOverlay = readFileSync(join(childless.tempRoot, 'hello-1', 'eval.cordis.yml'), 'utf8')
    expect(childlessOverlay).not.toContain('childFiles:')
  })

  it('reports a missing replay fixture as an error trial', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const replayDir = tempDir()
    const run = await runBenchmark(buildBenchmark({ trials: 1, replay: { dir: replayDir } }), { tempRoot: tempDir() })
    expect(run.cases[0]?.status).toBe('error')
    expect(run.cases[0]?.error).toContain('no replay fixture found')
  })

  it('rejects judge and replay in one run', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const replayDir = tempDir()
    await expect(runBenchmark(buildBenchmark({
      trials: 1,
      judge: { provider: 'deepseek', model: 'judge-m', maxScore: 10 },
      replay: { dir: replayDir },
    }), { tempRoot: tempDir(), judgeChat: async () => '{}' })).rejects.toThrow('judge and replay cannot be combined')
  })
})
