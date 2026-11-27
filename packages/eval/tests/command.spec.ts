import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { internals as cmdlineInternals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadBenchmark } from '../src/benchmark.ts'
import { hashBenchmarkOverrides } from '../src/digest.ts'
import { evalCommand, type EvalStartupValues } from '../src/command.ts'
import { apply, executeEval, internals, renderProgress, resolveJudgeChat } from '../src/index.ts'
import { loadRunReport, writeRunReport } from '../src/report.ts'
import type { Benchmark, EvalRun } from '../src/types.ts'
import { renderBenchmarkSummary } from '../src/validate.ts'

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
    expect(observed.out).toContain(`Wrote ${outPath} (1/1 completed, tool success 100.0%, 1 unscored, 1.0 steps/trial)`)
    expect(observed.out).toContain(`Next: dsh eval report ${outPath} --brief`)
    expect(existsSync(outPath)).toBe(true)
    expect(observed.err).toContain('[eval] 1/1 hello #1 task n/a, ')

    const quietOut = join(dir, 'quiet', 'run.json')
    const quiet = await bootEval([
      'run', benchmarkPath, '--out', quietOut, '--quiet',
      '--dsh', `${process.execPath} ${FAKE_SCRIPT}`,
      '--trials', '1',
    ])
    expect(quiet.exits).toEqual([0])
    expect(quiet.err).not.toContain('[eval] ')
  })

  it('formats bounded progress lines for pass, fail, ungraded and error trials', () => {
    const base = {
      caseId: 'c', trial: 2, status: 'completed' as const, exitCode: 0, timedOut: false,
    }
    expect(renderProgress({
      ...base, grade: { taskSuccess: true, toolSelectionAccuracy: true },
      metrics: { latencyMs: 123 } as never,
    }, 1, 3)).toBe('[eval] 1/3 c #2 task pass, 123 ms\n')
    expect(renderProgress({
      ...base, grade: { taskSuccess: false, toolSelectionAccuracy: false },
    }, 2, 3)).toBe('[eval] 2/3 c #2 task fail, ? ms\n')
    expect(renderProgress(base, 3, 3)).toBe('[eval] 3/3 c #2 task n/a, ? ms\n')
    expect(renderProgress({
      caseId: 'x\ny', trial: 1, status: 'error', exitCode: 1, timedOut: false,
      error: 'boom\nmore',
    }, 1, 1)).toBe('[eval] 1/1 x y #1 ERROR boom more\n')
    expect(renderProgress({
      caseId: 'z', trial: 1, status: 'error', exitCode: 1, timedOut: false,
    }, 1, 1)).toBe('[eval] 1/1 z #1 ERROR unknown error\n')
    expect(renderProgress({
      caseId: 'a\u001b[31mred\u001b[0m', trial: 1, status: 'error', exitCode: 1,
      timedOut: false, error: `\u001b]0;title\u0007${'x'.repeat(400)}`,
    }, 1, 1)).toBe(`[eval] 1/1 ared #1 ERROR ${'x'.repeat(200)}\n`)
    expect(renderProgress(base, 1, 3, 1000, 11000))
      .toBe('[eval] 1/3 c #2 task n/a, ? ms, eta 20s\n')
    expect(renderProgress(base, 3, 3, 1000, 11000)).not.toContain('eta')
    expect(renderProgress(base, 0, 3, 1000, 11000)).not.toContain('eta')
    expect(renderProgress(base, 1, 3, 11000, 10000)).not.toContain('eta')
    expect(renderProgress(base, 1, 3, Number.NaN, 10000)).not.toContain('eta')
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
    const structured = await bootEval(['report', runPath, '--json'])
    expect(structured.exits).toEqual([0])
    expect(JSON.parse(structured.out) as { benchmark: string }).toMatchObject({ benchmark: 'reported' })
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

    // An explicitly authorized trace root is forwarded through the CLI too.
    const explicitCode = await executeEval(
      { kind: 'rejudge', runPath, outPath, allowedRoot: dirname(FIXTURE_LOG) }, io,
      { judgeChat: async () => '{"finalAnswerScore": 7, "hallucination": false}' },
    )
    expect(explicitCode).toBe(0)

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

    const published: EvalStartupValues[] = []
    const parser = evalCommand(value => published.push(value))
    await parser.parseAsync([
      'node', 'eval', 'gate', candidatePath, '--baseline', baselinePath,
      '--max-cost-increase', '0.1', '--max-latency-increase', '0.2',
    ])
    expect(published.at(-1)).toMatchObject({ maxCostIncrease: 0.1, maxLatencyIncrease: 0.2 })
    await parser.parseAsync([
      'node', 'eval', 'gate', candidatePath, '--baseline', baselinePath, '--require-significance',
    ])
    expect(published.at(-1)).toMatchObject({ requireSignificance: true })
    const significant = await bootEval([
      'gate', candidatePath, '--baseline', baselinePath, '--require-significance', '--json',
    ])
    expect(significant.exits).toEqual([1])
    expect(JSON.parse(significant.out) as { passed: boolean }).toMatchObject({ passed: false })
    expect((await bootEval([
      'gate', candidatePath, '--baseline', baselinePath, '--max-cost-increase', '2',
    ])).err).toContain('between 0 and 1')

    const exportDir = mkdtempSync(join(tmpdir(), 'dsh-eval-export-'))
    try {
      const exportPath = join(exportDir, 'run.json')
      const csvPath = join(exportDir, 'nested', 'trials.csv')
      await writeRunReport(run, exportPath)
      const exported: EvalStartupValues[] = []
      await evalCommand(value => exported.push(value)).parseAsync([
        'node', 'eval', 'export', exportPath, '--out', csvPath,
      ])
      expect(exported.at(-1)).toMatchObject({ kind: 'export', outPath: csvPath })
      await evalCommand(value => exported.push(value)).parseAsync([
        'node', 'eval', 'export', exportPath,
      ])
      expect(exported.at(-1)).toMatchObject({ kind: 'export', runPath: exportPath })
      expect(exported.at(-1)).not.toHaveProperty('outPath')
      const out: string[] = []
      const io = { stdout: { write: (chunk: string) => { out.push(chunk); return true } }, stderr: { write: () => {} } }
      expect(await executeEval(exported[0]!, io)).toBe(0)
      expect(readFileSync(csvPath, 'utf8')).toContain('caseId,trial,status')
      expect(out.join('')).toContain('Wrote ')
      const stdoutOut: string[] = []
      const stdoutIo = { stdout: { write: (chunk: string) => { stdoutOut.push(chunk); return true } }, stderr: { write: () => {} } }
      expect(await executeEval({ kind: 'export', runPath: exportPath }, stdoutIo)).toBe(0)
      expect(stdoutOut.join('')).toContain('caseId,trial,status')
    } finally {
      rmSync(exportDir, { recursive: true, force: true })
    }

    const reportDir = mkdtempSync(join(tmpdir(), 'dsh-eval-report-out-'))
    try {
      const reportRunPath = join(reportDir, 'run.json')
      const reportPath = join(reportDir, 'nested', 'report.md')
      await writeRunReport(run, reportRunPath)
      const published: EvalStartupValues[] = []
      await evalCommand(value => published.push(value)).parseAsync([
        'node', 'eval', 'report', reportRunPath, '--out', reportPath,
      ])
      expect(published.at(-1)).toMatchObject({ kind: 'report', outPath: reportPath })
      const out: string[] = []
      const io = { stdout: { write: (chunk: string) => { out.push(chunk); return true } }, stderr: { write: () => {} } }
      expect(await executeEval(published.at(-1)!, io)).toBe(0)
      expect(readFileSync(reportPath, 'utf8')).toContain('# Eval: b')
      expect(out.join('')).toContain('Wrote ')
    } finally {
      rmSync(reportDir, { recursive: true, force: true })
    }

    expect((await bootEval([
      'gate', candidatePath, '--baseline', baselinePath,
      '--max-cost-increase', '0.1', '--max-latency-increase', '0.2',
    ])).exits).toEqual([0])
    const json = await bootEval(['gate', candidatePath, '--baseline', baselinePath, '--json'])
    expect(json.exits).toEqual([0])
    expect(JSON.parse(json.out) as { passed: boolean }).toMatchObject({ passed: true })
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

    const strict = await bootEval(['dashboard', runPath, runPath, runPath,
      '--metric', 'strictPassAt1', '--out', outPath])
    expect(strict.exits).toEqual([0])
    expect(readFileSync(outPath, 'utf8')).toContain('ranked by strict pass@1')
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

  it('parses --allowed-root for rejudge and omits it when absent', async () => {
    const published: EvalStartupValues[] = []
    const program = evalCommand(value => published.push(value))
    await program.parseAsync(['node', 'dsh', 'rejudge', 'run.json', '--allowed-root', '/trusted/traces'])
    expect(published[0]).toMatchObject({ kind: 'rejudge', allowedRoot: '/trusted/traces' })

    await program.parseAsync(['node', 'dsh', 'rejudge', 'run.json'])
    expect((published[1] as { allowedRoot?: string }).allowedRoot).toBeUndefined()
  })

  it('parses reproduce with its default and explicit --out and rejects the input path', async () => {
    const dir = tempDir()
    const runPath = join(dir, 'run.json')
    const benchmarkPath = benchmarkYaml(dir)
    const published: EvalStartupValues[] = []
    const program = evalCommand(value => published.push(value))
    await program.parseAsync(['node', 'dsh', 'reproduce', runPath, benchmarkPath])
    expect(published[0]).toEqual({
      kind: 'reproduce', runPath, benchmarkPath, outPath: 'reproduced-run.json',
    })

    const outPath = join(dir, 'replay.json')
    await program.parseAsync(['node', 'dsh', 'reproduce', runPath, benchmarkPath, '--out', outPath])
    expect(published[1]).toEqual({ kind: 'reproduce', runPath, benchmarkPath, outPath })

    // Like rejudge, the comparison resolves both paths and ignores case, so a
    // case-only difference cannot silently overwrite the baseline report.
    const inPlace = await bootEval(['reproduce', runPath, benchmarkPath, '--out', runPath])
    expect(inPlace.exits).toEqual([1])
    expect(inPlace.err).toContain('error: --out must differ from the input run report')
    const sameName = await bootEval(['reproduce', runPath, benchmarkPath, '--out', runPath.toUpperCase()])
    expect(sameName.exits).toEqual([1])
    expect(sameName.err).toContain('--out must differ')
  })

  it('prints help and exits 0 without running', async () => {
    const observed = await bootEval(['--help'])
    expect(observed.exits).toEqual([0])
    expect(observed.out).toContain('dsh --profile eval')
    expect(observed.out).toContain('Examples:')
    expect(observed.out).toContain('validate benchmark.yaml')
    expect(observed.out).toContain('reproduce run.json benchmark.yaml --out replay.json')
    expect(observed.out).toContain('gate candidate.json --baseline base.json')
  })

  it('rejects a bare invocation', async () => {
    const observed = await bootEval([])
    expect(observed.exits).toEqual([1])
    expect(observed.err).toContain('needs a subcommand')
    expect(observed.err).toContain('reproduce <run.json> <benchmark.yaml>')
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

  it('runs with a seed override and records it in provenance', async () => {
    const dir = tempDir()
    const benchmarkPath = benchmarkYaml(dir)
    const outPath = join(dir, 'seeded.json')
    process.env.FAKE_DASH_MODE = 'log'
    process.env.FAKE_DASH_LOG = FIXTURE_LOG
    const observed = await bootEval([
      'run', benchmarkPath, '--out', outPath,
      '--dsh', `${process.execPath} ${FAKE_SCRIPT}`,
      '--trials', '1', '--seed', '-7',
    ])
    expect(observed.exits).toEqual([0])
    const report = JSON.parse(readFileSync(outPath, 'utf8')) as {
      seed: number
      benchmarkOverrides: { seed: number }
    }
    expect(report.seed).toBe(-7)
    expect(report.benchmarkOverrides.seed).toBe(-7)
    const provenance = await bootEval(['provenance', outPath, benchmarkPath])
    expect(provenance.out).toContain('Provenance: match')
  })

  it('rejects an invalid seed override', async () => {
    const benchmarkPath = benchmarkYaml(tempDir())
    const observed = await bootEval(['run', benchmarkPath, '--seed', '1.5'])
    expect(observed.exits).toEqual([1])
    expect(observed.err).toContain('--seed must be an integer')
    const hex = await bootEval(['run', benchmarkPath, '--seed', '0x10'])
    expect(hex.exits).toEqual([1])
    expect(hex.err).toContain('--seed must be an integer')
    const unsafe = await bootEval(['run', benchmarkPath, '--seed', '9007199254740992'])
    expect(unsafe.exits).toEqual([1])
    expect(unsafe.err).toContain('--seed must be an integer')
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
    expect(observed.out).toContain('## Per-case paired significance')

    const emptyA = join(dir, 'empty-a.json')
    const emptyB = join(dir, 'empty-b.json')
    await writeRunReport({ ...runA, cases: [] }, emptyA)
    await writeRunReport({ ...runB, cases: [] }, emptyB)
    const unpaired = await bootEval(['compare', emptyA, emptyB])
    expect(unpaired.exits).toEqual([0])
    expect(unpaired.out).not.toContain('Paired case outcomes')

    const structured = await bootEval(['compare', pathA, pathB, '--json'])
    expect(structured.exits).toEqual([0])
    const parsed = JSON.parse(structured.out) as {
      baseline: { benchmark: string }
      caseSignificance: { caseId: string; verdict: string }[]
    }
    expect(parsed.baseline.benchmark).toBe('base')
    expect(parsed.caseSignificance[0]).toMatchObject({ caseId: 'c', verdict: 'underpowered' })
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

    const structured = await bootEval(['leaderboard', ...paths, '--json'])
    expect(structured.exits).toEqual([0])
    const parsed = JSON.parse(structured.out) as { rows: { label: string; rank: number }[] }
    expect(parsed.rows.map(row => row.label)).toEqual(['b — strong', 'b — middle', 'b — weak'])

    const strict = await bootEval(['leaderboard', ...paths, '--metric', 'strictPassAt1', '--json'])
    expect(strict.exits).toEqual([0])
    expect(JSON.parse(strict.out) as { rankedBy: string }).toMatchObject({ rankedBy: 'strictPassAt1' })
  })

  it('validates a benchmark through the CLI', async () => {
    const dir = tempDir()
    const benchmarkPath = benchmarkYaml(dir)
    const observed = await bootEval(['validate', benchmarkPath])
    expect(observed.exits).toEqual([0])
    expect(observed.out).toContain('# Benchmark: command-smoke')
    expect(observed.out).toContain('Validated: command-smoke is ready to run.')
    expect(observed.out).toContain(`Next: dsh eval run ${benchmarkPath}`)
    const structured = await bootEval(['validate', benchmarkPath, '--json'])
    expect(structured.exits).toEqual([0])
    // The signpost must not corrupt machine-readable JSON stdout.
    expect(structured.out).not.toContain('Next:')
    expect(JSON.parse(structured.out) as { name: string }).toMatchObject({ name: 'command-smoke' })

    const invalidPath = join(dir, 'invalid.yml')
    writeFileSync(invalidPath, 'name: bad\nmodel: m\ncases:\n  - id: a\n    prompt: p\n    expected:\n      check: "a"\n      checkShell: "b"\n')
    const invalid = await bootEval(['validate', invalidPath])
    expect(invalid.exits).toEqual([1])
    expect(invalid.err).toContain('at most one of check')
  })

  it('covers every preflight warning branch in the targeted coverage run', () => {
    // validate.spec.ts owns these renderers in the full suite, but the targeted
    // verification command loads only this file and execute.spec.ts while still
    // enforcing 100% coverage on src/validate.ts. Keep the branch coverage here
    // so both the targeted and the full runs stay green.
    const base = {
      name: 'rich', model: 'm', profile: 'headless', command: ['dsh'] as const,
      trials: 3, concurrency: 1, timeoutMs: 1000, seed: 0, baseDir: '/tmp',
    }
    const rich: Benchmark = {
      ...base,
      // No sourceSha256: exercises the null side of the digest field.
      cases: [
        {
          id: 'dup', prompt: 'p', timeoutMs: 500,
          expected: { tool: 'bash', check: 'true', answer: '42', answerRegex: '42' },
        },
        { id: 'dup', prompt: 'p', expected: { checkArgv: ['true'], answerRegex: 'x' } },
        { id: 'shell', prompt: 'p', expected: { checkShell: 'echo ok | grep ok', tools: ['bash'] } },
        { id: 'regex-only', prompt: 'p', expected: { answerRegex: 'z' } },
      ],
      judge: { provider: 'p', model: 'j', maxScore: 10 },
      replay: { dir: '/tmp/replay' },
      pricing: {
        m: {
          inputUsdPerMTokens: 1, cacheReadUsdPerMTokens: 1,
          cacheWriteUsdPerMTokens: 1, outputUsdPerMTokens: 1,
        },
      },
    }
    const richText = renderBenchmarkSummary(rich)
    expect(richText).toContain('# Benchmark: rich')
    expect(richText).toContain('- timeout: 1000 ms (1 per-case override(s))')
    expect(richText).toContain('- cases: 4 (4 graded, 1 with gold answers)')
    expect(richText).toContain('- expectations: 4 check(s), 2 tool constraint(s)')
    expect(richText).toContain('- judge: j on p (max 10)')
    expect(richText).toContain('- replay: /tmp/replay')
    expect(richText).toContain('- pricing: configured')
    expect(richText).not.toContain('- source sha256:')
    expect(richText).toContain('duplicate case ids (dup)')
    expect(richText).toContain('case dup combines a check command with answerRegex')
    expect(richText).toContain('1 shell check(s) need a trusted benchmark file')
    expect(richText).not.toContain('at most 12 paired trials')

    const judgedWithoutGold: Benchmark = {
      ...base,
      trials: 1,
      cases: [{ id: 'raw', prompt: 'p' }],
      sourceSha256: 'b'.repeat(64),
      judge: { provider: 'p', model: 'j', maxScore: 10 },
    }
    const judgedText = renderBenchmarkSummary(judgedWithoutGold)
    expect(judgedText).toContain('- source sha256: ' + 'b'.repeat(64))
    expect(judgedText).toContain('no case has scripted expectations — results depend entirely on the judge')
    expect(judgedText).toContain('judge is configured but no case supplies a gold answer')

    const replayWithoutJudge: Benchmark = {
      ...base,
      trials: 1,
      cases: [{ id: 'raw', prompt: 'p' }],
      sourceSha256: 'c'.repeat(64),
      replay: { dir: '/tmp/replay' },
    }
    expect(renderBenchmarkSummary(replayWithoutJudge))
      .toContain('replay runs have no live judge; use `dsh eval rejudge`')

    // The only warning-free shape: a judge, gold answers, enough pairs and no
    // shell checks — covers the `warnings.length > 0 === false` side.
    const clean: Benchmark = {
      ...base,
      trials: 8,
      cases: [{ id: 'ok', prompt: 'p', expected: { tools: ['bash'], checkArgv: ['true'], answer: '42' } }],
      sourceSha256: 'd'.repeat(64),
      judge: { provider: 'p', model: 'j', maxScore: 10 },
    }
    expect(renderBenchmarkSummary(clean)).not.toContain('## Warnings')
  })

  it('rejects an unknown leaderboard metric', async () => {
    const dir = tempDir()
    const path = join(dir, 'run.json')
    await writeRunReport({
      benchmark: 'b', model: 'm', createdAt: 1, trials: 1, seed: 0,
      pricing: null, tempRoot: dir, cases: [], aggregate: null, grading: null,
    }, path)
    const observed = await bootEval(['leaderboard', path, '--metric', 'nope'])
    expect(observed.exits).toEqual([1])
    expect(observed.err).toContain('--metric must be taskSuccess or strictPassAt1')
  })

  it('verifies benchmark provenance through the CLI', async () => {
    const dir = tempDir()
    const benchmarkPath = benchmarkYaml(dir)
    const benchmark = await loadBenchmark(benchmarkPath)
    const runPath = join(dir, 'run.json')
    const base = {
      benchmark: 'command-smoke', model: 'm', createdAt: 1, trials: 1, seed: 0,
      pricing: null, tempRoot: dir, cases: [], aggregate: null, grading: null,
    }
    await writeRunReport({
      ...base,
      ...(benchmark.sourceSha256 !== undefined ? { benchmarkSha256: benchmark.sourceSha256 } : {}),
    }, runPath)
    const observed = await bootEval(['provenance', runPath, benchmarkPath])
    expect(observed.exits).toEqual([0])
    expect(observed.out).toContain('Provenance: match')
    const structured = await bootEval(['provenance', runPath, benchmarkPath, '--json'])
    expect(JSON.parse(structured.out) as { status: string }).toMatchObject({ status: 'match' })

    const overrides = { trials: 3, profile: 'custom', dshCommand: ['dsh', 'run'] }
    await writeRunReport({
      ...base,
      benchmarkSha256: hashBenchmarkOverrides(benchmark.sourceSha256!, overrides),
      benchmarkOverrides: overrides,
    }, runPath)
    const overridden = await bootEval(['provenance', runPath, benchmarkPath])
    expect(overridden.exits).toEqual([0])
    expect(overridden.out).toContain('Provenance: match')

    await writeRunReport(base, runPath)
    const missing = await bootEval(['provenance', runPath, benchmarkPath])
    expect(missing.exits).toEqual([1])
    expect(missing.out).toContain('Provenance: missing')

    await writeRunReport({ ...base, benchmarkSha256: 'a'.repeat(64) }, runPath)
    const mismatch = await bootEval(['provenance', runPath, benchmarkPath, '--json'])
    expect(mismatch.exits).toEqual([1])
    expect(JSON.parse(mismatch.out) as { status: string }).toMatchObject({ status: 'mismatch' })
    expect(mismatch.out).toContain('benchmarkSha256')

    const localPath = join(dir, 'local.yml')
    writeFileSync(localPath, [
      'name: local', 'model: m', 'cases:', '  - id: a', '    prompt: p',
      '    workspace: .', '',
    ].join('\n'))
    const local = await loadBenchmark(localPath, { excludeFromDigest: [runPath] })
    await writeRunReport({
      ...base,
      ...(local.sourceSha256 !== undefined ? { benchmarkSha256: local.sourceSha256 } : {}),
    }, runPath)
    const localObserved = await bootEval(['provenance', runPath, localPath])
    expect(localObserved.exits).toEqual([0])
    expect(localObserved.out).toContain('Provenance: match')
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

  it('accepts --out on every read-only renderer', async () => {
    const dir = tempDir()
    const benchmarkPath = benchmarkYaml(dir)
    const runPath = join(dir, 'run.json')
    const plainRun: EvalRun = {
      benchmark: 'b', model: 'm', createdAt: 1, trials: 1, seed: 0, pricing: null,
      tempRoot: '/tmp', cases: [], aggregate: null, grading: null,
    }
    await writeRunReport(plainRun, runPath)
    const outPath = join(dir, 'derived.txt')
    const published: EvalStartupValues[] = []
    const parser = evalCommand(value => published.push(value))
    const invocations: string[][] = [
      ['node', 'eval', 'compare', runPath, runPath, '--out', outPath],
      ['node', 'eval', 'validate', benchmarkPath, '--out', outPath],
      ['node', 'eval', 'leaderboard', runPath, runPath, '--out', outPath],
      ['node', 'eval', 'gate', runPath, '--baseline', runPath, '--out', outPath],
    ]
    for (const invocation of invocations) await parser.parseAsync(invocation)
    expect(published.map(value => value.kind)).toEqual(['compare', 'validate', 'leaderboard', 'gate'])
    for (const value of published) expect(value).toMatchObject({ outPath })
    const out: string[] = []
    const io = { stdout: { write: (chunk: string) => { out.push(chunk); return true } }, stderr: { write: () => {} } }
    for (const value of published) expect(await executeEval(value, io)).toBe(0)
    expect(out.filter(line => line.startsWith('Wrote '))).toHaveLength(4)
    expect(readFileSync(outPath, 'utf8')).toContain('# Gate: PASS')
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
    expect(out.join('')).toContain('2 unscored')
  })
})
