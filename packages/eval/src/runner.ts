/**
 * Benchmark runner for dsh-eval: one fresh subprocess per case x trial.
 *
 * Each trial owns a private temp directory with a copied workspace, an
 * isolated DSH_HOME, and a patch overlay that forces plain-JSONL persistence
 * and non-interactive workspace-scoped permissions. The spawned command is
 * the same trusted dsh harness (credentials flow through deliberately: the
 * child must reach the real model API, and the session log never stores
 * them), so the defensive scrubbed-env rule's leak concern does not apply to
 * this child. Timeout kills the direct child and reports timed-out orthogonally
 * from its exit code; Windows descendants of a killed process may survive.
 *
 * @module @deepseek-ai/dsh-eval/runner
 */

import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Benchmark, EvalRun, EvalTrialResult } from './types.ts'
import type { EvalGrade, EvalRunGrading } from './types.ts'
import { aggregateMetrics, computeMetrics } from './metrics.ts'
import { findPrimarySessionLog, loadTrace } from './trace.ts'

/** Overlay forcing the harvested log to plain JSONL and the run to be non-interactive. */
const EVAL_OVERLAY = `- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('sessions')
    packChunks: false
    compression: none
- id: sandbox-policy
  config:
    mode: workspace-write
    workspaceRoot: !!js process.cwd()
- id: approval
  config:
    policy: never
`

/** Cap per-stream child output so a runaway trial cannot exhaust memory. */
const MAX_OUTPUT_BYTES = 512 * 1024

/** Runtime overrides applied to a loaded benchmark. */
export interface RunOptions {
  /** Override the benchmark's dsh command argv. */
  command?: readonly string[]
  /** Override the benchmark's spawned profile. */
  profile?: string
  /** Override the benchmark's trials per case. */
  trials?: number
  /** Root for trial directories; defaults to the platform temp dir. */
  tempRoot?: string
}

/** One child process's orthogonal outcome facts. */
interface SpawnOutcome {
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
}

/** The child's trailing diagnostic for failed harvests. */
function diagnostic(outcome: SpawnOutcome): string {
  const tail = outcome.stderr.slice(-2000)
  const status = outcome.timedOut ? 'timed out' : `exited with code ${String(outcome.exitCode)}`
  return tail === '' ? `no session log found; dsh ${status}` : `no session log found; dsh ${status}: ${tail}`
}

/** Human-readable error text. */
function message(error: unknown): string {
  /* v8 ignore next 3 -- every call site passes a node:fs or spawn Error; a non-Error rejection is impossible through the public API. */
  return error instanceof Error ? error.message : String(error)
}

/** Reduce a case id to one safe temp-directory segment. */
function sanitizeSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/gu, '-').replace(/^-+|-+$/gu, '')
  return safe === '' ? 'case' : safe
}

/** Split a single command string into argv on whitespace. */
function splitWords(value: string): string[] {
  return value.trim().split(/\s+/u).filter(part => part !== '')
}

/**
 * Grade one trial against its expectations: the expected tool is matched
 * against recorded tool-call names, and the check command runs in the trial
 * workspace with the same timeout as the agent. A spawn failure or timeout
 * reads as task failure, never as an aborted run.
 * @param caseValue - the case being graded.
 * @param trace - the harvested trace.
 * @param workspace - the trial's workspace, where the check runs.
 * @param timeoutMs - check timeout, matching the trial timeout.
 * @returns the grading outcome; unconfigured fields stay null.
 */
async function gradeTrial(
  caseValue: Benchmark['cases'][number],
  trace: Awaited<ReturnType<typeof loadTrace>>,
  workspace: string,
  timeoutMs: number,
): Promise<EvalGrade> {
  const expected = caseValue.expected
  if (expected === undefined) return { taskSuccess: null, toolSelectionAccuracy: null }
  const expectedTool = expected.tool
  const toolSelectionAccuracy = expectedTool === undefined
    ? null
    : trace.events.some(event => event.type === 'tool/call' && event.data.name.includes(expectedTool))
  let taskSuccess: boolean | null = null
  if (expected.check !== undefined) {
    try {
      const outcome = await runCommand(splitWords(expected.check), [], workspace, { ...process.env }, timeoutMs)
      taskSuccess = !outcome.timedOut && outcome.exitCode === 0
    } catch {
      taskSuccess = false
    }
  }
  return { taskSuccess, toolSelectionAccuracy }
}

/** Pool one nullable boolean across graded trials into a rate, or null. */
function pooledRate(items: readonly EvalTrialResult[], select: (grade: EvalGrade | undefined) => boolean | null): number | null {
  const values = items
    .map(result => select(result.grade))
    .filter((value): value is boolean => value !== null)
  return values.length === 0 ? null : values.filter(value => value).length / values.length
}

/** Reduce completed trials' grades into pooled run-level rates. */
function gradingOf(results: readonly EvalTrialResult[]): EvalRunGrading | null {
  const taskSuccessRate = pooledRate(results, grade => grade?.taskSuccess ?? null)
  const toolSelectionAccuracyRate = pooledRate(results, grade => grade?.toolSelectionAccuracy ?? null)
  return taskSuccessRate === null && toolSelectionAccuracyRate === null
    ? null
    : { taskSuccessRate, toolSelectionAccuracyRate }
}

/**
 * Spawn one command and collect its output, enforcing the timeout with a
 * direct kill. The four outcome facts (exit code, timeout, stdout, stderr)
 * are reported independently so a trapped or killed child cannot read as a
 * clean success.
 * @param command - the executable and its fixed argv.
 * @param args - invocation args appended after `command`.
 * @param cwd - the child's working directory.
 * @param env - the child's environment.
 * @param timeoutMs - kill the child after this many milliseconds.
 * @returns the orthogonal outcome facts.
 */
function runCommand(
  command: readonly string[],
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<SpawnOutcome> {
  const executable = command[0]
  if (executable === undefined) {
    return Promise.reject(new Error('eval: dsh command must not be empty'))
  }
  return new Promise((resolveOutcome, reject) => {
    const child = spawn(executable, [...command.slice(1), ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const cap = (current: string, chunk: Buffer): string => (
      current.length >= MAX_OUTPUT_BYTES
        ? current
        : current + chunk.toString('utf8').slice(0, MAX_OUTPUT_BYTES - current.length)
    )
    child.stdout.on('data', (chunk: Buffer) => { stdout = cap(stdout, chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = cap(stderr, chunk) })
    const timer = setTimeout(() => {
      /* v8 ignore next 3 -- close clears the timer; only a same-tick close/kill race reaches here. */
      if (settled) return
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      /* v8 ignore next 3 -- spawn emits one error before close; the guard covers only an impossible duplicate error event. */
      if (settled) return
      settled = true
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      resolveOutcome({ exitCode: code, timedOut, stdout, stderr })
    })
  })
}

/**
 * Run one case x trial in its private temp directory and harvest its trace.
 * @param benchmark - the loaded benchmark.
 * @param caseValue - the case to run.
 * @param trial - 1-based trial index.
 * @param root - this run's temp root.
 * @returns the trial result; a failed subprocess with no log is an `error` trial.
 */
async function runCaseTrial(
  benchmark: Benchmark,
  caseValue: Benchmark['cases'][number],
  trial: number,
  root: string,
): Promise<EvalTrialResult> {
  const trialDir = join(root, `${sanitizeSegment(caseValue.id)}-${trial}`)
  const workspace = join(trialDir, 'workspace')
  const dshHome = join(trialDir, 'dsh-home')
  await mkdir(workspace, { recursive: true })
  await mkdir(dshHome, { recursive: true, mode: 0o700 })
  if (caseValue.workspace !== undefined) await cp(caseValue.workspace, workspace, { recursive: true })
  const overlayPath = join(trialDir, 'eval.cordis.yml')
  await writeFile(overlayPath, EVAL_OVERLAY, 'utf8')
  let outcome: SpawnOutcome
  try {
    outcome = await runCommand(
      benchmark.command,
      ['--profile', benchmark.profile, '--patch', overlayPath, caseValue.prompt],
      workspace,
      { ...process.env, DSH_HOME: dshHome },
      benchmark.timeoutMs,
    )
  } catch (error) {
    return {
      caseId: caseValue.id,
      trial,
      status: 'error',
      error: `failed to spawn dsh: ${message(error)}`,
      exitCode: null,
      timedOut: false,
    }
  }
  const tracePath = await findPrimarySessionLog(dshHome)
  if (tracePath === null) {
    return {
      caseId: caseValue.id,
      trial,
      status: 'error',
      error: diagnostic(outcome),
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
    }
  }
  try {
    const trace = await loadTrace(tracePath)
    const pricing = benchmark.pricing?.[benchmark.model]
    const metrics = computeMetrics(trace.events, pricing)
    const grade = await gradeTrial(caseValue, trace, workspace, benchmark.timeoutMs)
    return {
      caseId: caseValue.id,
      trial,
      status: 'completed',
      tracePath,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      metrics,
      ...(grade.taskSuccess !== null || grade.toolSelectionAccuracy !== null ? { grade } : {}),
    }
  } catch (error) {
    return {
      caseId: caseValue.id,
      trial,
      status: 'error',
      error: `failed to read trace ${tracePath}: ${message(error)}`,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
    }
  }
}

/**
 * Run every case x trial sequentially and aggregate the completed trials.
 * @param benchmark - the loaded benchmark.
 * @param options - runtime overrides and test seams.
 * @returns the completed run record, written by the caller.
 */
export async function runBenchmark(benchmark: Benchmark, options: RunOptions = {}): Promise<EvalRun> {
  const root = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'dsh-eval-'))
  const trials = options.trials ?? benchmark.trials
  const effective: Benchmark = {
    ...benchmark,
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    ...(options.command !== undefined ? { command: options.command } : {}),
  }
  const results: EvalTrialResult[] = []
  for (const caseValue of effective.cases) {
    for (let trial = 1; trial <= trials; trial++) {
      results.push(await runCaseTrial(effective, caseValue, trial, root))
    }
  }
  const completed = results.filter(
    (result): result is EvalTrialResult & { metrics: NonNullable<EvalTrialResult['metrics']> } =>
      result.status === 'completed' && result.metrics !== undefined,
  )
  return {
    benchmark: benchmark.name,
    model: benchmark.model,
    createdAt: Date.now(),
    trials,
    seed: benchmark.seed,
    pricing: benchmark.pricing?.[benchmark.model] ?? null,
    tempRoot: root,
    cases: results,
    aggregate: aggregateMetrics(completed.map(result => result.metrics)),
    grading: gradingOf(completed),
  }
}
