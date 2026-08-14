import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runBenchmark } from '../src/runner.ts'
import type { Benchmark } from '../src/types.ts'

const FAKE_SCRIPT = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url))
const FIXTURE_LOG = fileURLToPath(new URL('./fixtures/session.jsonl', import.meta.url))
const CHECK_OK = fileURLToPath(new URL('./fixtures/check-ok.mjs', import.meta.url))
const CHECK_FAIL = fileURLToPath(new URL('./fixtures/check-fail.mjs', import.meta.url))

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
  it('runs every trial, harvests traces, and folds metrics', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const run = await runBenchmark(buildBenchmark(), { tempRoot: tempDir() })
    expect(run.benchmark).toBe('runner-smoke')
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

  it('reads a failing or missing check as task failure', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const run = await runBenchmark(buildBenchmark({
      trials: 1,
      cases: [{ id: 'missing-check', prompt: 'p', expected: { check: 'definitely-missing-check-xyz' } }],
    }), { tempRoot: tempDir() })
    expect(run.cases[0]?.grade?.taskSuccess).toBe(false)
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
    expect(run.cases[0]?.judge).toEqual({ finalAnswerScore: null, hallucination: null })
    expect(run.grading).toBeNull()
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
