import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { internals as cmdlineInternals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { evalCommand, type EvalStartupValues } from '../src/command.ts'
import { apply, executeEval, internals, resolveJudgeChat } from '../src/index.ts'
import { loadRunReport, writeRunReport } from '../src/report.ts'
import type { EvalRun } from '../src/types.ts'

const FAKE_SCRIPT = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url))
const FIXTURE_LOG = fileURLToPath(new URL('./fixtures/session.jsonl', import.meta.url))

// Coverage instrumentation slows the Loader boot and real child spawns.
vi.setConfig({ testTimeout: 30_000 })

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-eval-command-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  internals.stdout = process.stdout
  internals.stderr = process.stderr
  cmdlineInternals.stdout = process.stdout
  cmdlineInternals.stderr = process.stderr
  vi.restoreAllMocks()
})

function benchmarkYaml(dir: string): string {
  const path = join(dir, 'benchmark.yml')
  writeFileSync(path, [
    'name: command-smoke',
    'model: deepseek-v4',
    'cases:',
    '  - id: hello',
    '    prompt: Say hello.',
    'pricing:',
    '  deepseek-v4:',
    '    inputUsdPerMTokens: 0.27',
    '    cacheReadUsdPerMTokens: 0.07',
    '    cacheWriteUsdPerMTokens: 0.27',
    '    outputUsdPerMTokens: 1.10',
    '',
  ].join('\n'))
  return path
}

interface Observed {
  exits: number[]
  out: string
  err: string
}

/** Mount the real eval plugin over a real Loader with a captured cmdline. */
async function bootEval(args: string[]): Promise<Observed> {
  const dir = tempDir()
  const observed: Observed = { exits: [], out: '', err: '' }
  const capture = { write: (chunk: string) => { observed.out += chunk; return true } }
  const errCapture = { write: (chunk: string) => { observed.err += chunk; return true } }
  internals.stdout = capture
  internals.stderr = errCapture
  cmdlineInternals.stdout = capture
  cmdlineInternals.stderr = errCapture
  writeFileSync(join(dir, 'eval.mjs'), [
    "export const name = 'eval'",
    "export const inject = ['cmdlineArgs']",
    'export const apply = ctx => globalThis.__evalApply(ctx)',
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: eval',
    `  name: ${pathToFileURL(join(dir, 'eval.mjs')).href}`,
    '',
  ].join('\n'))
  const globals = globalThis as unknown as { __evalApply: typeof apply }
  globals.__evalApply = apply
  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: (code) => { observed.exits.push(code) } })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  // The async invocation spawns a real subprocess, so the exit can take far
  // longer than vitest's default polling window under a loaded worker.
  await vi.waitFor(
    () => { expect(observed.exits.length).toBeGreaterThan(0) },
    { timeout: 15_000, interval: 100 },
  )
  await ctx.fiber.dispose()
  return observed
}

describe('dsh-eval command composition', () => {
  it('runs a benchmark through the real Loader and exits 0', async () => {
    const dir = tempDir()
    const benchmarkPath = benchmarkYaml(dir)
    const outPath = join(dir, 'out', 'run.json')
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const observed = await bootEval([
      'run', benchmarkPath, '--out', outPath,
      '--dsh', `${process.execPath} ${FAKE_SCRIPT}`,
      '--trials', '1',
      '--profile', 'headless',
    ])
    expect(observed.exits).toEqual([0])
    expect(observed.out).toContain(`Wrote ${outPath} (1/1 completed, tool success 100.0%, 1.0 steps/trial)`)
    expect(existsSync(outPath)).toBe(true)
  })

  it('includes judge score in the run summary through the chat seam', async () => {
    const dir = tempDir()
    const benchmarkPath = join(dir, 'judged.yml')
    writeFileSync(benchmarkPath, [
      'name: judged-smoke',
      'model: deepseek-v4',
      'judge:',
      '  provider: deepseek',
      '  model: judge-m',
      'cases:',
      '  - id: hello',
      '    prompt: Say hello.',
      '',
    ].join('\n'))
    const outPath = join(dir, 'judged-run.json')
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const out: string[] = []
    const io = {
      stdout: { write: (chunk: string) => { out.push(chunk); return true } },
      stderr: { write: (chunk: string) => { out.push(chunk); return true } },
    }
    const code = await executeEval(
      { kind: 'run', benchmarkPath, outPath, dshCommand: [process.execPath, FAKE_SCRIPT], trials: 1, profile: 'headless' },
      io,
      { judgeChat: async () => JSON.stringify({ finalAnswerScore: 8, hallucination: false }) },
    )
    expect(code).toBe(0)
    expect(out.join('')).toContain('judge score 8.0')
  })

  it('resolves the judge chat seam only when llm is mounted', () => {
    const withoutLlm = { get: () => undefined } as unknown as Context
    expect(resolveJudgeChat(withoutLlm)).toBeUndefined()
    const withLlm = {
      get: (key: string) => key === 'llm' ? { stream: () => [] } : undefined,
    } as unknown as Context
    expect(resolveJudgeChat(withLlm)).toBeTypeOf('function')
  })

  it('imports an external session log through the real Loader', async () => {
    const dir = tempDir()
    const path = join(dir, 'codex.jsonl')
    writeFileSync(path, [
      '{"timestamp":"2026-08-14T00:00:00Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Hi"}]}}',
      '{"timestamp":"2026-08-14T00:00:01Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello"}]}}',
      '',
    ].join('\n'))
    const outPath = join(dir, 'imported-run.json')
    const observed = await bootEval(['import', 'codex', path, '--out', outPath])
    expect(observed.exits).toEqual([0])
    expect(observed.out).toContain('Wrote')
    expect(existsSync(outPath)).toBe(true)
  })

  it('rejects an unknown import format', async () => {
    const observed = await bootEval(['import', 'bogus', 'x.jsonl'])
    expect(observed.exits).toEqual([1])
    expect(observed.err).toContain('import format must be codex or claude-code')
  })

  it('renders a persisted run with the report subcommand', async () => {
    const dir = tempDir()
    const runPath = join(dir, 'run.json')
    const run: EvalRun = {
      benchmark: 'reported', model: 'm', createdAt: 1, trials: 1, seed: 0,
      pricing: null, tempRoot: '/tmp', cases: [], aggregate: null, grading: null,
    }
    await writeRunReport(run, runPath)
    const observed = await bootEval(['report', runPath])
    expect(observed.exits).toEqual([0])
    expect(observed.out).toContain('# Eval: reported')
    const brief = await bootEval(['report', runPath, '--brief'])
    expect(brief.exits).toEqual([0])
    expect(brief.out).toBe('# reported — m\n- trials: 0/0 completed\n')
  })

  it('rejudges a stored run through the CLI', async () => {
    const dir = tempDir()
    const runPath = join(dir, 'run.json')
    const outPath = join(dir, 'rejudged.json')
    const run: EvalRun = {
      benchmark: 'rj', model: 'm', createdAt: 1, trials: 1, seed: 0, pricing: null,
      judge: { provider: 'p', model: 'j', maxScore: 10 },
      tempRoot: dirname(FIXTURE_LOG),
      caseInputs: [{ caseId: 'c', prompt: 'Solve.' }],
      cases: [{ caseId: 'c', trial: 1, status: 'completed', exitCode: 0, timedOut: false, tracePaths: [FIXTURE_LOG] }],
      aggregate: null,
      grading: null,
    }
    await writeRunReport(run, runPath)
    const out: string[] = []
    const io = { stdout: { write: (chunk: string) => { out.push(chunk); return true } }, stderr: { write: () => {} } }
    const code = await executeEval(
      { kind: 'rejudge', runPath, outPath }, io,
      { judgeChat: async () => '{"finalAnswerScore": 7, "hallucination": false}' },
    )
    expect(code).toBe(0)
    expect(out.join('')).toContain('Wrote ' + outPath + ' (1/1 judged)')
    const rejudged = await loadRunReport(outPath)
    expect(rejudged.cases[0]?.judge?.finalAnswerScore).toBe(7)
    expect(rejudged.grading?.finalAnswerScore).toBe(7)

    const noSeam = await executeEval({ kind: 'rejudge', runPath, outPath }, io)
    expect(noSeam).toBe(1)
    expect(existsSync(outPath)).toBe(true)

    const inPlace = await bootEval(['rejudge', runPath, '--out', runPath])
    expect(inPlace.exits).toEqual([1])
    expect(inPlace.err).toContain('--out must differ')

    // The subcommand publishes through the real CLI path; without an LLM
    // service the app must fail with a diagnostic rather than silently pass.
    const noLlm = await bootEval(['rejudge', runPath, '--out', outPath])
    expect(noLlm.exits).toEqual([1])
    expect(noLlm.err).toContain('no LLM chat seam')
  })

  it('gates a candidate run through the CLI', async () => {
    const dir = tempDir()
    const baselinePath = join(dir, 'base.json')
    const candidatePath = join(dir, 'candidate.json')
    const regressedPath = join(dir, 'regressed.json')
    const grading = {
      taskSuccessRate: 1, toolSelectionAccuracyRate: null,
      finalAnswerScore: null, hallucinationRate: null,
    }
    const run = {
      benchmark: 'b', model: 'm', createdAt: 1, trials: 1, seed: 0, pricing: null,
      tempRoot: '/tmp', cases: [], aggregate: null, grading,
    }
    await writeRunReport(run, baselinePath)
    await writeRunReport(run, candidatePath)
    await writeRunReport({ ...run, grading: { ...grading, taskSuccessRate: 0 } }, regressedPath)
    const out: string[] = []
    const io = { stdout: { write: (chunk: string) => { out.push(chunk); return true } }, stderr: { write: () => {} } }
    expect(await executeEval({
      kind: 'gate', candidatePath, baselinePath, maxDrop: 0, allowIncomplete: false,
    }, io)).toBe(0)
    expect(out.join('')).toContain('# Gate: PASS')
    expect(await executeEval({
      kind: 'gate', candidatePath: regressedPath, baselinePath, maxDrop: 0, allowIncomplete: false,
    }, io)).toBe(1)

    expect((await bootEval(['gate', candidatePath])).err).toContain('--baseline')
    expect((await bootEval(['gate', candidatePath, '--baseline', baselinePath, '--max-drop', '2'])).err)
      .toContain('between 0 and 1')
    expect((await bootEval(['gate', candidatePath, '--baseline', baselinePath])).exits).toEqual([0])
    expect((await bootEval(['gate', candidatePath, '--baseline', baselinePath, '--max-drop', '0.05'])).exits)
      .toEqual([0])
    expect((await bootEval(['gate', candidatePath, '--baseline', baselinePath, '--allow-incomplete'])).exits)
      .toEqual([0])
  })

  it('renders an HTML dashboard through the CLI', async () => {
    const dir = tempDir()
    const runPath = join(dir, 'run.json')
    const outPath = join(dir, 'nested', 'dashboard.html')
    await writeRunReport({
      benchmark: 'dash', model: 'm', createdAt: 1, trials: 1, seed: 0, pricing: null,
      tempRoot: '/tmp', cases: [], aggregate: null, grading: null,
    }, runPath)
    const out: string[] = []
    const io = { stdout: { write: (chunk: string) => { out.push(chunk); return true } }, stderr: { write: () => {} } }
    const code = await executeEval({ kind: 'dashboard', runPaths: [runPath], outPath }, io)
    expect(code).toBe(0)
    expect(out.join('')).toContain(`Wrote ${outPath}`)
    expect(readFileSync(outPath, 'utf8')).toContain('<title>dash — m</title>')

    const parsed = await bootEval(['dashboard', runPath, '--out', outPath])
    expect(parsed.exits).toEqual([0])
    expect(existsSync(outPath)).toBe(true)

    const compared = await bootEval(['dashboard', runPath, runPath, '--out', outPath])
    expect(compared.exits).toEqual([0])
    expect(readFileSync(outPath, 'utf8')).toContain('<h2>Run comparison</h2>')

    const leaderboarded = await bootEval(['dashboard', runPath, runPath, runPath, '--out', outPath])
    expect(leaderboarded.exits).toEqual([0])
    expect(readFileSync(outPath, 'utf8')).toContain('<h1>Leaderboard</h1>')
  })

  it('parses judge override flags for rejudge', async () => {
    const published: EvalStartupValues[] = []
    const program = evalCommand(value => published.push(value))
    await program.parseAsync([
      'node', 'dsh', 'rejudge', 'run.json',
      '--judge-model', 'judge-v2', '--judge-provider', 'openai',
      '--judge-rubric', 'Be strict.', '--judge-max-score', '20',
    ])
    expect(published[0]).toMatchObject({
      kind: 'rejudge',
      runPath: 'run.json',
      judge: { model: 'judge-v2', provider: 'openai', rubric: 'Be strict.', maxScore: 20 },
    })

    await program.parseAsync(['node', 'dsh', 'rejudge', 'run.json', '--judge-model', 'judge-v3'])
    expect(published[1]).toMatchObject({
      kind: 'rejudge',
      judge: { model: 'judge-v3', provider: 'deepseek', maxScore: 10 },
    })
    expect((published[1] as { judge?: { rubric?: string } }).judge?.rubric).toBeUndefined()
  })

  it('prints help and exits 0 without running', async () => {
    const observed = await bootEval(['--help'])
    expect(observed.exits).toEqual([0])
    expect(observed.out).toContain('dsh --profile eval')
  })

  it('rejects a bare invocation', async () => {
    const observed = await bootEval([])
    expect(observed.exits).toEqual([1])
    expect(observed.err).toContain('needs a subcommand')
  })

  it('rejects an invalid trials override', async () => {
    const benchmarkPath = benchmarkYaml(tempDir())
    const observed = await bootEval(['run', benchmarkPath, '--trials', '0'])
    expect(observed.exits).toEqual([1])
    expect(observed.err).toContain('--trials must be a positive integer')
  })

  it('runs a benchmark through a concurrency override', async () => {
    const dir = tempDir()
    const benchmarkPath = benchmarkYaml(dir)
    const outPath = join(dir, 'pooled.json')
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const observed = await bootEval([
      'run', benchmarkPath, '--out', outPath,
      '--dsh', `${process.execPath} ${FAKE_SCRIPT}`,
      '--trials', '2',
      '--concurrency', '2',
    ])
    expect(observed.exits).toEqual([0])
    expect(existsSync(outPath)).toBe(true)
  })

  it('rejects an invalid concurrency override', async () => {
    const benchmarkPath = benchmarkYaml(tempDir())
    const observed = await bootEval(['run', benchmarkPath, '--concurrency', '1.5'])
    expect(observed.exits).toEqual([1])
    expect(observed.err).toContain('--concurrency must be a positive integer')
  })

  it('rejects an unterminated quote in --dsh', async () => {
    const dir = tempDir()
    const benchmarkPath = benchmarkYaml(dir)
    const observed = await bootEval(['run', benchmarkPath, '--dsh', '"unclosed'])
    expect(observed.exits).toEqual([1])
    expect(observed.err).toContain('unterminated quote')
  })

  it('exits 1 when a run has no completed trials', async () => {
    const dir = tempDir()
    const benchmarkPath = benchmarkYaml(dir)
    const outPath = join(dir, 'run.json')
    process.env.FAKE_DASH_MODE = 'none'
    const observed = await bootEval(['run', benchmarkPath, '--out', outPath, '--dsh', `${process.execPath} ${FAKE_SCRIPT}`])
    expect(observed.exits).toEqual([1])
    expect(observed.out).toContain('no completed trials')
    expect(observed.err).toContain('trial(s) failed')
    expect(observed.err).toContain('no session log found')
  })

  it('rejects a whitespace-only --dsh override instead of silently using the default', async () => {
    const dir = tempDir()
    const benchmarkPath = benchmarkYaml(dir)
    const outPath = join(dir, 'run.json')
    const observed = await bootEval(['run', benchmarkPath, '--out', outPath, '--dsh', '   '])
    expect(observed.exits).toEqual([1])
    expect(observed.err).toContain('--dsh must contain a command')
    expect(existsSync(outPath)).toBe(false)
  })

  it('fails loudly for a missing benchmark file', async () => {
    const observed = await bootEval(['run', join(tempDir(), 'missing.yml')])
    expect(observed.exits).toEqual([1])
    expect(observed.err).toContain('dsh eval:')
  })

  it('compares two persisted runs through the real Loader', async () => {
    const dir = tempDir()
    const runA: EvalRun = {
      benchmark: 'base', model: 'm', createdAt: 1, trials: 1, seed: 0,
      pricing: null, tempRoot: '/tmp', aggregate: null, grading: null,
      cases: [{
        caseId: 'c', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
        grade: { taskSuccess: true, toolSelectionAccuracy: true },
      }],
    }
    const runB: EvalRun = {
      benchmark: 'candidate', model: 'm', createdAt: 2, trials: 1, seed: 0,
      pricing: null, tempRoot: '/tmp', aggregate: null, grading: null,
      cases: [{
        caseId: 'c', trial: 1, status: 'completed', exitCode: 0, timedOut: false,
        grade: { taskSuccess: false, toolSelectionAccuracy: true },
      }],
    }
    const pathA = join(dir, 'a.json')
    const pathB = join(dir, 'b.json')
    await writeRunReport(runA, pathA)
    await writeRunReport(runB, pathB)
    const observed = await bootEval(['compare', pathA, pathB])
    expect(observed.exits).toEqual([0])
    expect(observed.out).toContain('# Compare')
    expect(observed.out).toContain('| benchmark | base | candidate | – |')
    expect(observed.out).toContain('## Paired case outcomes')
    expect(observed.out).toContain('| c | 1 | pass | fail | A better |')

    const emptyA = join(dir, 'empty-a.json')
    const emptyB = join(dir, 'empty-b.json')
    await writeRunReport({ ...runA, cases: [] }, emptyA)
    await writeRunReport({ ...runB, cases: [] }, emptyB)
    const unpaired = await bootEval(['compare', emptyA, emptyB])
    expect(unpaired.exits).toEqual([0])
    expect(unpaired.out).not.toContain('Paired case outcomes')
  })

  it('ranks several persisted runs through the CLI', async () => {
    const dir = tempDir()
    const make = (model: string, rate: number): EvalRun => ({
      benchmark: 'b', model, createdAt: 1, trials: 1, seed: 0, pricing: null,
      tempRoot: '/tmp', cases: [], aggregate: null,
      grading: {
        taskSuccessRate: rate, toolSelectionAccuracyRate: null,
        finalAnswerScore: null, hallucinationRate: null,
      },
    })
    const paths = [
      join(dir, 'weak.json'), join(dir, 'strong.json'), join(dir, 'middle.json'),
    ]
    const runs = [make('weak', 0.2), make('strong', 0.9), make('middle', 0.5)]
    for (let index = 0; index < paths.length; index += 1) {
      await writeRunReport(runs[index]!, paths[index]!)
    }
    const observed = await bootEval(['leaderboard', ...paths])
    expect(observed.exits).toEqual([0])
    expect(observed.out).toContain('# Leaderboard')
    expect(observed.out.indexOf('strong')).toBeLessThan(observed.out.indexOf('middle'))
    expect(observed.out.indexOf('middle')).toBeLessThan(observed.out.indexOf('weak'))
  })

  it('validates a benchmark through the CLI', async () => {
    const dir = tempDir()
    const benchmarkPath = benchmarkYaml(dir)
    const observed = await bootEval(['validate', benchmarkPath])
    expect(observed.exits).toEqual([0])
    expect(observed.out).toContain('# Benchmark: command-smoke')
    expect(observed.out).toContain('Validated: command-smoke is ready to run.')

    const invalidPath = join(dir, 'invalid.yml')
    writeFileSync(invalidPath, 'name: bad\nmodel: m\ncases:\n  - id: a\n    prompt: p\n    expected:\n      check: "a"\n      checkShell: "b"\n')
    const invalid = await bootEval(['validate', invalidPath])
    expect(invalid.exits).toEqual([1])
    expect(invalid.err).toContain('at most one of check')
  })

  it('fails loudly for a missing compare input', async () => {
    const dir = tempDir()
    const pathA = join(dir, 'a.json')
    await writeRunReport({
      benchmark: 'a', model: 'm', createdAt: 1, trials: 1, seed: 0,
      pricing: null, tempRoot: '/tmp', cases: [], aggregate: null, grading: null,
    }, pathA)
    const observed = await bootEval(['compare', pathA, join(dir, 'missing.json')])
    expect(observed.exits).toEqual([1])
    expect(observed.err).toContain('dsh eval:')
  })
})

describe('dsh-eval execution entry', () => {
  it('requires appExit before parsing', () => {
    const ctx = new Context()
    ctx.provide('cmdlineArgs', { get: () => [] })
    expect(() => { apply(ctx) }).toThrow('appExit')
  })

  it('returns 1 for an invalid report file', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'bad.json'), '{not json')
    const stderr: string[] = []
    const code = await executeEval({ kind: 'report', runPath: join(dir, 'bad.json') }, {
      stdout: { write: () => {} },
      stderr: { write: (chunk) => { stderr.push(chunk); return true } },
    })
    expect(code).toBe(1)
    expect(stderr.join('')).toContain('dsh eval:')
  })

  it('exits 1 when a run completes without any completed trials', async () => {
    const dir = tempDir()
    const benchmarkPath = join(dir, 'benchmark.yml')
    writeFileSync(benchmarkPath, 'name: noprice\nmodel: m\ncases:\n  - id: a\n    prompt: p\n')
    const outPath = join(dir, 'run.json')
    process.env.FAKE_DASH_MODE = 'none'
    const code = await executeEval(
      { kind: 'run', benchmarkPath, outPath, dshCommand: [process.execPath, FAKE_SCRIPT] },
      { stdout: { write: () => {} }, stderr: { write: () => {} } },
    )
    expect(code).toBe(1)
    expect(existsSync(outPath)).toBe(true)
  })

  it('reports n/a success and exits 0 for a completed run with no tool results', async () => {
    const dir = tempDir()
    const benchmarkPath = join(dir, 'benchmark.yml')
    writeFileSync(benchmarkPath, 'name: notools\nmodel: m\ncases:\n  - id: a\n    prompt: p\n')
    const logPath = join(dir, 'session.jsonl')
    writeFileSync(logPath, [
      '{"type":"session","version":0,"id":"s","createdAt":1,"delegationDepth":0}',
      '{"seq":0,"type":"turn/start","time":0,"data":{"turn":0}}',
      '{"seq":1,"type":"step/start","time":1,"data":{"turn":0,"step":0}}',
      '{"seq":2,"type":"assistant/message","time":10,"data":{"turn":0,"step":0,"message":{"id":"m","role":"assistant","content":[{"type":"text","text":"ok"}],"source":{"kind":"model"}}}}',
      '{"seq":3,"type":"step/end","time":11,"data":{"turn":0,"step":0}}',
      '{"seq":4,"type":"turn/end","time":12,"data":{"turn":0,"reason":{"kind":"completed"}}}',
      '',
    ].join('\n'))
    const outPath = join(dir, 'run.json')
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = logPath
    const out: string[] = []
    const code = await executeEval(
      { kind: 'run', benchmarkPath, outPath, dshCommand: [process.execPath, FAKE_SCRIPT] },
      { stdout: { write: (chunk) => { out.push(chunk); return true } }, stderr: { write: () => {} } },
    )
    expect(code).toBe(0)
    expect(out.join('')).toContain('tool success n/a')
    expect(existsSync(outPath)).toBe(true)
  })

  it('reports pooled task success in the summary for a graded run', async () => {
    const dir = tempDir()
    const checkPath = fileURLToPath(new URL('./fixtures/check-ok.mjs', import.meta.url))
    const benchmarkPath = join(dir, 'benchmark.yml')
    writeFileSync(benchmarkPath, [
      'name: graded',
      'model: m',
      'cases:',
      '  - id: a',
      '    prompt: p',
      '    expected:',
      `      check: ${JSON.stringify(`${process.execPath} ${checkPath}`)}`,
      '',
    ].join('\n'))
    const outPath = join(dir, 'run.json')
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const out: string[] = []
    const code = await executeEval(
      { kind: 'run', benchmarkPath, outPath, dshCommand: [process.execPath, FAKE_SCRIPT] },
      { stdout: { write: (chunk) => { out.push(chunk); return true } }, stderr: { write: () => {} } },
    )
    expect(code).toBe(0)
    expect(out.join('')).toContain(', task success 100.0%')
    expect(out.join('')).toContain(', pass@1 100.0% / pass^1 100.0%')
    expect(existsSync(outPath)).toBe(true)
  })

  it('exits 1 when only some trials fail, so CI cannot misread a green run', async () => {
    const dir = tempDir()
    const script = join(dir, 'partial-dsh.mjs')
    writeFileSync(script, [
      "import { copyFileSync, mkdirSync } from 'node:fs'",
      "import { join } from 'node:path'",
      "if (!process.cwd().includes('bad')) {",
      "  const dir = join(process.env.DSH_HOME, 'sessions', 'project', 'session-1')",
      '  mkdirSync(dir, { recursive: true })',
      "  copyFileSync(process.env.FAKE_DASH_LOG, join(dir, 'session.jsonl'))",
      '}',
      '',
    ].join('\n'))
    const benchmarkPath = join(dir, 'partial.yml')
    writeFileSync(benchmarkPath, [
      'name: partial',
      'model: m',
      'cases:',
      '  - id: good',
      '    prompt: p',
      '  - id: bad',
      '    prompt: p',
      '',
    ].join('\n'))
    const outPath = join(dir, 'run.json')
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const out: string[] = []
    const code = await executeEval(
      { kind: 'run', benchmarkPath, outPath, dshCommand: [process.execPath, script] },
      { stdout: { write: (chunk) => { out.push(chunk); return true } }, stderr: { write: () => {} } },
    )
    expect(code).toBe(1)
    expect(out.join('')).toContain('(1/2 completed,')
    expect(out.join('')).toContain('1 unscored')
  })
})
