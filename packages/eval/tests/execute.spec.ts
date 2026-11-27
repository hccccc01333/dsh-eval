import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadBenchmark } from '../src/benchmark.ts'
import { executeEval } from '../src/index.ts'
import { writeRunReport } from '../src/report.ts'
import { runBenchmark } from '../src/runner.ts'
import type { EvalRun, EvalRunGrading, EvalTrialResult } from '../src/types.ts'

vi.mock('../src/runner.ts', () => ({
  runBenchmark: vi.fn(async () => {
    throw 'boom'
  }),
}))

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-eval-execute-'))
  dirs.push(dir)
  return dir
}

function benchmarkYaml(dir: string): string {
  const path = join(dir, 'benchmark.yml')
  writeFileSync(path, 'name: n\nmodel: m\ncases:\n  - id: a\n    prompt: p\n')
  return path
}

function grading(taskSuccessRate: number | null): EvalRunGrading {
  return {
    taskSuccessRate,
    toolSelectionAccuracyRate: null,
    finalAnswerScore: null,
    hallucinationRate: null,
  }
}

function completedAggregate(): EvalRun['aggregate'] {
  return {
    turns: 1, steps: 1, toolCalls: 0, toolResults: 0, toolSuccess: 0, toolSuccessRate: null,
    invalidToolCalls: 0, retries: 0,
    tokens: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    totalTokens: 0, contextTokens: 0, llmMs: 0, toolMs: 0, ttftMs: 0, latencyMs: 0, costUsd: null,
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  const mock = vi.mocked(runBenchmark)
  mock.mockReset()
  mock.mockImplementation(async () => { throw 'boom' })
})

describe('dsh-eval non-Error failures', () => {
  it('renders a non-Error rejection into the stderr diagnostic', async () => {
    const dir = tempDir()
    const benchmarkPath = benchmarkYaml(dir)
    const stdout: string[] = []
    const stderr: string[] = []
    const code = await executeEval(
      { kind: 'run', benchmarkPath, outPath: join(dir, 'run.json') },
      {
        stdout: { write: (chunk) => { stdout.push(chunk); return true } },
        stderr: { write: (chunk) => { stderr.push(chunk); return true } },
      },
    )
    expect(code).toBe(1)
    expect(stderr.join('')).toBe('dsh eval: boom\n')
    // A rejected run never wrote a report, so it must not suggest one.
    expect(stdout.join('')).toBe('')
  })
})

describe('dsh-eval failure-summary sanitization', () => {
  it('strips ANSI/control characters and injected newlines from case ids and errors', async () => {
    const dir = tempDir()
    const benchmarkPath = benchmarkYaml(dir)
    const run: EvalRun = {
      benchmark: 'n',
      model: 'm',
      createdAt: 0,
      trials: 1,
      seed: 0,
      pricing: null,
      tempRoot: dir,
      cases: [{
        caseId: 'ev\u001b[2Jil\nx',
        trial: 1,
        status: 'error',
        error: 'boom\u001b]0;title\u0007\nforged log line',
        exitCode: 1,
        timedOut: false,
      }],
      aggregate: null,
      grading: null,
    }
    vi.mocked(runBenchmark).mockResolvedValueOnce(run)
    const stdout: string[] = []
    const stderr: string[] = []
    const code = await executeEval(
      { kind: 'run', benchmarkPath, outPath: join(dir, 'run.json') },
      {
        stdout: { write: (chunk) => { stdout.push(chunk); return true } },
        stderr: { write: (chunk) => { stderr.push(chunk); return true } },
      },
    )
    expect(code).toBe(1)
    // A failed run still points to the report that holds the per-trial detail.
    expect(stdout.join('')).toContain(`Next: dsh eval report ${join(dir, 'run.json')} --brief`)
    const err = stderr.join('')
    // Exactly two lines: the fixed header and one sanitized sample. No ANSI
    // escape, BEL, or forged newline survived from the case id or the error.
    expect(err).toBe('dsh eval: 1 trial(s) failed:\nevil x#1: boom forged log line\n')
    expect(err).not.toMatch(/\u001b/)
  })

  it('warns about check configuration errors on completed trials', async () => {
    const dir = tempDir()
    const benchmarkPath = benchmarkYaml(dir)
    const run: EvalRun = {
      benchmark: 'n',
      model: 'm',
      createdAt: 0,
      trials: 1,
      seed: 0,
      pricing: null,
      tempRoot: dir,
      cases: [{
        caseId: 'c\u001b[2J',
        trial: 1,
        status: 'completed',
        exitCode: 0,
        timedOut: false,
        grade: {
          taskSuccess: false,
          toolSelectionAccuracy: null,
          checkError: 'spawn ./check.sh ENOENT\u0007',
        },
      }],
      aggregate: null,
      grading: null,
    }
    vi.mocked(runBenchmark).mockResolvedValueOnce(run)
    const stdout: string[] = []
    const stderr: string[] = []
    await executeEval(
      { kind: 'run', benchmarkPath, outPath: join(dir, 'run.json') },
      {
        stdout: { write: (chunk) => { stdout.push(chunk); return true } },
        stderr: { write: (chunk) => { stderr.push(chunk); return true } },
      },
    )
    // A checkError lives on a completed trial; stderr explains it and stdout
    // points to the report, in one line each.
    expect(stdout.join('')).toContain(`Next: dsh eval report ${join(dir, 'run.json')} --brief`)
    const err = stderr.join('')
    expect(err).toContain('1 trial(s) had check configuration errors (not model failures)')
    expect(err).toContain('c#1: spawn ./check.sh ENOENT')
    expect(err).not.toMatch(/[\u001b\u0007]/u)
  })
})

describe('dsh-eval reproduce execution', () => {
  it('replays a baseline and reports both completion counts and task-success rates', async () => {
    const dir = tempDir()
    const benchmarkPath = benchmarkYaml(dir)
    const runPath = join(dir, 'baseline.json')
    const outPath = join(dir, 'replay.json')
    const benchmark = await loadBenchmark(benchmarkPath, { excludeFromDigest: [outPath] })
    await writeRunReport({
      benchmark: 'n', model: 'm', createdAt: 1, trials: 1, seed: 0, pricing: null,
      ...(benchmark.sourceSha256 === undefined ? {} : { benchmarkSha256: benchmark.sourceSha256 }),
      tempRoot: dir,
      cases: [{ caseId: 'a', trial: 1, status: 'completed', exitCode: 0, timedOut: false }],
      aggregate: null, grading: { ...grading(0.5), finalAnswerScore: 7 },
    }, runPath)
    const replay: EvalRun = {
      benchmark: 'n', model: 'm', createdAt: 2, trials: 1, seed: 0, pricing: null,
      tempRoot: dir,
      cases: [{ caseId: 'a', trial: 1, status: 'completed', exitCode: 0, timedOut: false }],
      aggregate: completedAggregate(), grading: { ...grading(0.75), finalAnswerScore: 9 },
    }
    vi.mocked(runBenchmark).mockImplementation(async (_benchmark, options) => {
      options?.onProgress?.(
        { caseId: 'a', trial: 1, status: 'completed', exitCode: 0, timedOut: false }, 1, 1,
      )
      return replay
    })
    const stdout: string[] = []
    const stderr: string[] = []
    const judgeChat = vi.fn(async () => '{}')
    const code = await executeEval(
      { kind: 'reproduce', runPath, benchmarkPath, outPath },
      {
        stdout: { write: (chunk) => { stdout.push(chunk); return true } },
        stderr: { write: (chunk) => { stderr.push(chunk); return true } },
      },
      { judgeChat },
    )
    expect(code).toBe(0)
    expect(stdout.join('')).toBe(
      `Wrote ${outPath} (baseline 1/1 completed, 50.0% → replay 1/1 completed, 75.0%, judge 7.0 → 9.0 (+2.0); digest not verifiable (legacy report))\n`
      + `Next: dsh eval report ${outPath} --brief\n`,
    )
    expect(stderr.join('')).toBe('[eval] 1/1 a #1 task n/a, ? ms\n')

    // A replay carrying a digest makes the same human line omit the caveat.
    vi.mocked(runBenchmark).mockImplementation(async () => ({
      ...replay,
      ...(benchmark.sourceSha256 === undefined ? {} : { benchmarkSha256: benchmark.sourceSha256 }),
    }))
    const verified: string[] = []
    const verifiedCode = await executeEval(
      { kind: 'reproduce', runPath, benchmarkPath, outPath },
      {
        stdout: { write: (chunk) => { verified.push(chunk); return true } },
        stderr: { write: () => true },
      },
      { judgeChat },
    )
    expect(verifiedCode).toBe(0)
    expect(verified.join('')).not.toContain('digest not verifiable')
    expect(vi.mocked(runBenchmark).mock.calls[0]?.[1]?.judgeChat).toBe(judgeChat)
    expect(existsSync(outPath)).toBe(true)
  })

  it('suppresses progress lines in quiet mode', async () => {
    const dir = tempDir()
    const benchmarkPath = benchmarkYaml(dir)
    const runPath = join(dir, 'baseline.json')
    const outPath = join(dir, 'replay.json')
    const benchmark = await loadBenchmark(benchmarkPath, { excludeFromDigest: [outPath] })
    await writeRunReport({
      benchmark: 'n', model: 'm', createdAt: 1, trials: 1, seed: 0, pricing: null,
      ...(benchmark.sourceSha256 === undefined ? {} : { benchmarkSha256: benchmark.sourceSha256 }),
      tempRoot: dir,
      cases: [{ caseId: 'a', trial: 1, status: 'completed', exitCode: 0, timedOut: false }],
      aggregate: null, grading: grading(0.5),
    }, runPath)
    vi.mocked(runBenchmark).mockImplementation(async () => ({
      benchmark: 'n', model: 'm', createdAt: 2, trials: 1, seed: 0, pricing: null,
      tempRoot: dir,
      cases: [{ caseId: 'a', trial: 1, status: 'completed', exitCode: 0, timedOut: false }],
      aggregate: completedAggregate(), grading: grading(0.75),
    }))
    const stderr: string[] = []
    const code = await executeEval(
      { kind: 'reproduce', runPath, benchmarkPath, outPath, quiet: true },
      {
        stdout: { write: () => true },
        stderr: { write: (chunk) => { stderr.push(chunk); return true } },
      },
      {},
    )
    expect(code).toBe(0)
    expect(stderr.join('')).toBe('')
  })

  it('emits only machine-readable JSON in reproduce --json mode', async () => {
    const dir = tempDir()
    const benchmarkPath = benchmarkYaml(dir)
    const runPath = join(dir, 'baseline.json')
    const outPath = join(dir, 'replay.json')
    const benchmark = await loadBenchmark(benchmarkPath, { excludeFromDigest: [outPath] })
    await writeRunReport({
      benchmark: 'n', model: 'm', createdAt: 1, trials: 1, seed: 0, pricing: null,
      ...(benchmark.sourceSha256 === undefined ? {} : { benchmarkSha256: benchmark.sourceSha256 }),
      tempRoot: dir,
      cases: [{ caseId: 'a', trial: 1, status: 'completed', exitCode: 0, timedOut: false }],
      aggregate: null, grading: grading(0.5),
    }, runPath)
    vi.mocked(runBenchmark).mockImplementation(async () => ({
      benchmark: 'n', model: 'm', createdAt: 2, trials: 1, seed: 0, pricing: null,
      tempRoot: dir,
      cases: [{ caseId: 'a', trial: 1, status: 'completed', exitCode: 0, timedOut: false }],
      aggregate: completedAggregate(), grading: grading(0.75),
    }))
    const stdout: string[] = []
    const stderr: string[] = []
    const code = await executeEval(
      { kind: 'reproduce', runPath, benchmarkPath, outPath, json: true },
      {
        stdout: { write: (chunk) => { stdout.push(chunk); return true } },
        stderr: { write: (chunk) => { stderr.push(chunk); return true } },
      },
    )
    expect(code).toBe(0)
    expect(stderr.join('')).toBe('')
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      baselineCompleted: 1, replayCompleted: 1,
      baselineTaskSuccessRate: 0.5, replayTaskSuccessRate: 0.75,
      digestChecked: false,
    })
    expect(stdout.join('')).not.toContain('Next:')
  })

  it('propagates a digest mismatch with a sanitized benchmark name', async () => {
    const dir = tempDir()
    const benchmarkPath = benchmarkYaml(dir)
    const runPath = join(dir, 'baseline.json')
    const outPath = join(dir, 'replay.json')
    await writeRunReport({
      benchmark: 'ev\u001b[2Jil\nx', model: 'm', createdAt: 1, trials: 1, seed: 0, pricing: null,
      benchmarkSha256: 'b'.repeat(64),
      tempRoot: dir, cases: [], aggregate: null, grading: null,
    }, runPath)
    const stdout: string[] = []
    const stderr: string[] = []
    const code = await executeEval(
      { kind: 'reproduce', runPath, benchmarkPath, outPath },
      {
        stdout: { write: (chunk) => { stdout.push(chunk); return true } },
        stderr: { write: (chunk) => { stderr.push(chunk); return true } },
      },
    )
    expect(code).toBe(1)
    expect(stdout.join('')).toBe('')
    const err = stderr.join('')
    expect(err).toContain('dsh eval: reproduce: the benchmark differs')
    expect(err).toContain('evil x')
    // The only control byte is the single newline this module appends itself.
    expect(err.slice(0, -1)).not.toMatch(/[\u001b\u0000-\u001f]/u)
    expect(existsSync(outPath)).toBe(false)
    expect(runBenchmark).not.toHaveBeenCalled()
  })

  it('returns 1 for a failed replay trial and for a replay with no aggregate', async () => {
    const dir = tempDir()
    const benchmarkPath = benchmarkYaml(dir)
    const runPath = join(dir, 'baseline.json')
    const outPath = join(dir, 'replay.json')
    const benchmark = await loadBenchmark(benchmarkPath, { excludeFromDigest: [outPath] })
    await writeRunReport({
      benchmark: 'n', model: 'm', createdAt: 1, trials: 1, seed: 0, pricing: null,
      ...(benchmark.sourceSha256 === undefined ? {} : { benchmarkSha256: benchmark.sourceSha256 }),
      tempRoot: dir,
      cases: [{ caseId: 'a', trial: 1, status: 'completed', exitCode: 0, timedOut: false }],
      aggregate: null, grading: null,
    }, runPath)
    const failed: EvalTrialResult = {
      caseId: 'a', trial: 1, status: 'error', error: 'boom', exitCode: 1, timedOut: false,
    }
    const failedReplay: EvalRun = {
      benchmark: 'n', model: 'm', createdAt: 2, trials: 1, seed: 0, pricing: null,
      tempRoot: dir, cases: [failed], aggregate: null, grading: null,
    }
    vi.mocked(runBenchmark).mockImplementation(async (_benchmark, options) => {
      options?.onProgress?.(failed, 1, 1)
      return failedReplay
    })
    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      stdout: { write: (chunk: string) => { stdout.push(chunk); return true } },
      stderr: { write: (chunk: string) => { stderr.push(chunk); return true } },
    }
    expect(await executeEval({ kind: 'reproduce', runPath, benchmarkPath, outPath }, io)).toBe(1)
    expect(stdout.join('')).toContain('baseline 1/1 completed, n/a → replay 0/1 completed, n/a')
    expect(stdout.join('')).toContain(`Next: dsh eval report ${outPath} --brief`)
    expect(stderr.join('')).toBe('[eval] 1/1 a #1 ERROR boom\n')

    // A replay whose trials all completed still fails when no aggregate was
    // produced, so an empty run cannot be mistaken for a green reproduction.
    vi.mocked(runBenchmark).mockImplementation(async () => ({
      benchmark: 'n', model: 'm', createdAt: 3, trials: 1, seed: 0, pricing: null,
      tempRoot: dir,
      cases: [{ caseId: 'a', trial: 1, status: 'completed', exitCode: 0, timedOut: false }],
      aggregate: null, grading: null,
    }))
    expect(await executeEval({ kind: 'reproduce', runPath, benchmarkPath, outPath }, io)).toBe(1)
  })
})

describe('dsh-eval output path safety', () => {
  it('refuses to overwrite a source file through --out', async () => {
    const dir = tempDir()
    const runPath = join(dir, 'run.json')
    const stderr: string[] = []
    const io = {
      stdout: { write: () => true },
      stderr: { write: (chunk: string) => { stderr.push(chunk); return true } },
    }
    expect(await executeEval({ kind: 'report', runPath, outPath: runPath }, io)).toBe(1)
    expect(stderr.join('')).toContain('--out must differ from the input file')

    // A case-only difference names the same file on Windows.
    stderr.length = 0
    expect(await executeEval({
      kind: 'report', runPath, outPath: runPath.toUpperCase(),
    }, io)).toBe(1)
    expect(stderr.join('')).toContain('--out must differ')
  })

  it('guards both provenance inputs against the output path', async () => {
    const dir = tempDir()
    const stderr: string[] = []
    const io = {
      stdout: { write: () => true },
      stderr: { write: (chunk: string) => { stderr.push(chunk); return true } },
    }
    expect(await executeEval({
      kind: 'provenance', runPath: join(dir, 'b.yaml'),
      benchmarkPath: join(dir, 'run.json'), outPath: join(dir, 'run.json'),
    }, io)).toBe(1)
    expect(stderr.join('')).toContain('--out must differ from the input file')
  })
})

describe('dsh-eval segment comparison execution', () => {
  function io() {
    const stdout: string[] = []
    const stderr: string[] = []
    return {
      stdout: { write: (chunk: string) => { stdout.push(chunk); return true } },
      stderr: { write: (chunk: string) => { stderr.push(chunk); return true } },
      stdoutText: () => stdout.join(''),
      stderrText: () => stderr.join(''),
    }
  }

  async function writeTaggedRuns(dir: string): Promise<[string, string]> {
    const baselinePath = join(dir, 'baseline.json')
    const candidatePath = join(dir, 'candidate.json')
    const base: EvalRun = {
      benchmark: 'n', model: 'm', createdAt: 1, trials: 1, seed: 0, pricing: null,
      tempRoot: dir,
      cases: [{
        caseId: 'a', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
        tags: ['hard'], grade: { taskSuccess: false, toolSelectionAccuracy: null },
      }],
      aggregate: null, grading: null,
    }
    await writeRunReport(base, baselinePath)
    await writeRunReport({
      ...base, createdAt: 2,
      cases: [{
        ...base.cases[0]!,
        grade: { taskSuccess: true, toolSelectionAccuracy: null },
      }],
    }, candidatePath)
    return [baselinePath, candidatePath]
  }

  it('renders a markdown delta table to stdout', async () => {
    const dir = tempDir()
    const [baselinePath, candidatePath] = await writeTaggedRuns(dir)
    const output = io()
    expect(await executeEval({ kind: 'segments', baselinePath, candidatePath }, output)).toBe(0)
    expect(output.stdoutText()).toContain('## Segment comparison')
    expect(output.stdoutText()).toContain('+100.0pp')
    expect(output.stderrText()).toBe('')
  })

  it('emits JSON and supports --out', async () => {
    const dir = tempDir()
    const [baselinePath, candidatePath] = await writeTaggedRuns(dir)
    const jsonOutput = io()
    expect(await executeEval({ kind: 'segments', baselinePath, candidatePath, json: true }, jsonOutput)).toBe(0)
    expect(JSON.parse(jsonOutput.stdoutText())[0]).toMatchObject({
      tag: 'hard', taskSuccessDelta: 1,
    })

    const outPath = join(dir, 'segments.md')
    const fileOutput = io()
    expect(await executeEval({ kind: 'segments', baselinePath, candidatePath, outPath }, fileOutput)).toBe(0)
    expect(fileOutput.stdoutText()).toBe(`Wrote ${outPath}\n`)
    expect(existsSync(outPath)).toBe(true)
  })

  it('propagates a missing run report with a nonzero exit', async () => {
    const dir = tempDir()
    const output = io()
    expect(await executeEval({
      kind: 'segments', baselinePath: join(dir, 'missing.json'), candidatePath: join(dir, 'missing-2.json'),
    }, output)).toBe(1)
    expect(output.stderrText()).toContain('dsh eval:')
  })
})
