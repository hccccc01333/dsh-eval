import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hashBenchmarkOverrides } from '../src/digest.ts'
import { compareReproduce, replayJudge, reproduceRun } from '../src/reproduce.ts'
import type { Benchmark, EvalRun } from '../src/types.ts'

const FAKE_SCRIPT = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url))
const FIXTURE_LOG = fileURLToPath(new URL('./fixtures/session.jsonl', import.meta.url))

vi.setConfig({ testTimeout: 30_000 })

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-eval-reproduce-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const SHA = 'a'.repeat(64)

function buildBenchmark(overrides: Partial<Benchmark> = {}): Benchmark {
  return {
    name: 'repro',
    model: 'deepseek-v4',
    profile: 'headless',
    command: [process.execPath, FAKE_SCRIPT],
    trials: 1,
    concurrency: 1,
    timeoutMs: 30_000,
    seed: 0,
    cases: [{ id: 'a', prompt: 'Say hello.' }],
    pricing: {},
    baseDir: process.cwd(),
    sourceSha256: SHA,
    ...overrides,
  }
}

function buildRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    benchmark: 'repro',
    model: 'deepseek-v4',
    createdAt: 1,
    trials: 1,
    seed: 0,
    pricing: null,
    tempRoot: '/tmp',
    cases: [],
    aggregate: null,
    grading: null,
    ...overrides,
  }
}

describe('reproduceRun', () => {
  it('replays a run with the same effective digest when no overrides were recorded', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const benchmark = buildBenchmark()
    const baseline = buildRun({ benchmarkSha256: SHA })
    const replay = await reproduceRun(baseline, benchmark, { tempRoot: tempDir() })
    expect(replay.benchmarkSha256).toBe(SHA)
    expect(replay.seed).toBe(0)
    expect(replay.trials).toBe(1)
  })

  it('rejects a benchmark that no longer matches the recorded digest', async () => {
    const benchmark = buildBenchmark()
    const baseline = buildRun({ benchmarkSha256: 'b'.repeat(64) })
    await expect(reproduceRun(baseline, benchmark)).rejects.toThrow('benchmark differs')
  })

  it('skips the digest check for older reports without one', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const benchmark = buildBenchmark()
    delete benchmark.sourceSha256
    const replay = await reproduceRun(buildRun(), benchmark, { tempRoot: tempDir() })
    expect(replay.benchmarkSha256).toBeUndefined()
  })

  it('passes every recorded override through to the runner', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const overrides = {
      trials: 1, seed: 0, concurrency: 1, profile: 'headless',
      dshCommand: [process.execPath, FAKE_SCRIPT],
    }
    const benchmark = buildBenchmark()
    const baseline = buildRun({
      benchmarkSha256: hashBenchmarkOverrides(SHA, overrides),
      benchmarkOverrides: overrides,
    })
    const replay = await reproduceRun(baseline, benchmark, { tempRoot: tempDir() })
    expect(replay.benchmarkSha256).toBe(baseline.benchmarkSha256)
    expect(replay.trials).toBe(1)
  })

  it('refuses to replay a judged run without a judge seam', async () => {
    const benchmark = buildBenchmark({
      judge: { provider: 'deepseek', model: 'judge', maxScore: 10 },
    })
    const baseline = buildRun({
      grading: {
        taskSuccessRate: null, toolSelectionAccuracyRate: null,
        finalAnswerScore: 8, hallucinationRate: null,
      },
    })
    await expect(reproduceRun(baseline, benchmark)).rejects.toThrow('no LLM chat seam is available')
  })

  it('replays a judged baseline when a judge seam is supplied', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const benchmark = buildBenchmark({
      judge: { provider: 'deepseek', model: 'judge', maxScore: 10 },
    })
    const baseline = buildRun({
      grading: {
        taskSuccessRate: null, toolSelectionAccuracyRate: null,
        finalAnswerScore: null, hallucinationRate: null,
      },
      cases: [{
        caseId: 'a', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
        judge: { finalAnswerScore: 8, hallucination: false },
      }],
    })
    const replay = await reproduceRun(baseline, benchmark, { judgeChat: async () => '{}' })
    expect(replay.cases).toHaveLength(1)
  })

  it('replays a re-judged baseline with the judge config recorded in it', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const benchmarkJudge = { provider: 'deepseek', model: 'original', maxScore: 10 }
    const baselineJudge = {
      provider: 'deepseek', model: 'rejudged', maxScore: 20, rubric: 'Prefer brevity.',
    }
    const benchmark = buildBenchmark({ judge: benchmarkJudge })
    const baseline = buildRun({
      judge: baselineJudge,
      grading: {
        taskSuccessRate: null, toolSelectionAccuracyRate: null,
        finalAnswerScore: null, hallucinationRate: null,
      },
      cases: [{
        caseId: 'a', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
        judge: { finalAnswerScore: 16, hallucination: false },
      }],
    })
    expect(replayJudge(baseline, benchmark)).toEqual(baselineJudge)
    expect(replayJudge(buildRun(), benchmark)).toBe(benchmarkJudge)
    const replay = await reproduceRun(baseline, benchmark, { judgeChat: async () => '{}' })
    expect(replay.judge).toEqual(baselineJudge)
    expect(replay.benchmarkSha256).toBe(SHA)
  })

  it('forwards the judge seam and progress observer', async () => {
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const judgeChat = async () => '{}'
    const onProgress = vi.fn()
    const replay = await reproduceRun(buildRun(), buildBenchmark(), { judgeChat, onProgress })
    expect(replay.cases).toHaveLength(1)
    expect(onProgress).toHaveBeenCalledOnce()
  })
})

describe('compareReproduce', () => {
  it('reports completed counts, rates and digest equality', () => {
    const grading = {
      taskSuccessRate: 0.75, toolSelectionAccuracyRate: null,
      finalAnswerScore: null, hallucinationRate: null,
    }
    const baseline = buildRun({
      benchmarkSha256: SHA,
      grading,
      cases: [{ caseId: 'a', trial: 1, status: 'completed', exitCode: 0, timedOut: false }],
    })
    const replay = buildRun({
      benchmarkSha256: 'b'.repeat(64),
      grading: { ...grading, taskSuccessRate: 0.5 },
      cases: [
        { caseId: 'a', trial: 1, status: 'completed', exitCode: 0, timedOut: false },
        { caseId: 'a', trial: 2, status: 'error', exitCode: null, timedOut: false },
      ],
    })
    expect(compareReproduce(baseline, replay)).toEqual({
      digestMatches: false,
      baselineCompleted: 1,
      replayCompleted: 1,
      baselineTaskSuccessRate: 0.75,
      replayTaskSuccessRate: 0.5,
      baselineJudgeScore: null,
      replayJudgeScore: null,
      judgeScoreDelta: null,
    })
  })

  it('reports the signed judge-score delta for judged runs', () => {
    const graded = (score: number) => buildRun({
      grading: {
        taskSuccessRate: 0.5, toolSelectionAccuracyRate: null,
        finalAnswerScore: score, hallucinationRate: null,
      },
    })
    expect(compareReproduce(graded(7), graded(9)).judgeScoreDelta).toBe(2)
    const dropped = compareReproduce(graded(9), graded(7))
    expect(dropped.baselineJudgeScore).toBe(9)
    expect(dropped.replayJudgeScore).toBe(7)
    expect(dropped.judgeScoreDelta).toBe(-2)
  })

  it('reports null rates for ungraded runs with no digest', () => {
    expect(compareReproduce(buildRun(), buildRun())).toEqual({
      digestMatches: true,
      baselineCompleted: 0,
      replayCompleted: 0,
      baselineTaskSuccessRate: null,
      replayTaskSuccessRate: null,
      baselineJudgeScore: null,
      replayJudgeScore: null,
      judgeScoreDelta: null,
    })
  })
})
