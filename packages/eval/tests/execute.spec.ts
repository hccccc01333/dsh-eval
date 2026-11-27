import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeEval } from '../src/index.ts'
import { runBenchmark } from '../src/runner.ts'
import type { EvalRun } from '../src/types.ts'

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
