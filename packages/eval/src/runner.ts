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
 * @module dsh-eval/runner
 */

import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitArgv } from './argv.ts'
import type { Benchmark, EvalRun, EvalTrialResult } from './types.ts'
import type { EvalGrade, EvalRunGrading } from './types.ts'
import { tryJudgeTrial, type JudgeChat } from './judge.ts'
import { caseSegment } from './segments.ts'
import { aggregateMetrics, computeMetrics } from './metrics.ts'
import { findSessionLogs, loadTrace, mergeTraces } from './trace.ts'

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
  /** Override the benchmark's in-flight trial limit. */
  concurrency?: number
  /** Root for trial directories; defaults to the platform temp dir. */
  tempRoot?: string
  /** LLM-judge chat seam; required when the benchmark configures a judge. */
  judgeChat?: JudgeChat
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

/**
 * Build the per-trial overlay: plain-JSONL persistence, non-interactive
 * permissions, and the keyless replay plugin when recorded logs exist.
 * @param replay - the replay primary log and child logs, or undefined.
 * @returns the overlay YAML text.
 */
function evalOverlay(replay: { file: string; childFiles: readonly string[] } | undefined): string {
  const lines = [
    '- id: session-persistence-jsonl',
    '  config:',
    "    root: !!js dshHomePath('sessions')",
    '    packChunks: false',
    '    compression: none',
    '- id: sandbox-policy',
    '  config:',
    '    mode: workspace-write',
    '    workspaceRoot: !!js process.cwd()',
    '- id: approval',
    '  config:',
    '    policy: never',
  ]
  if (replay !== undefined) {
    lines.push(
      '- id: llm-replay',
      "  name: '@deepseek-ai/dsh-llm-replay'",
      '  config:',
      `    file: ${JSON.stringify(replay.file)}`,
      ...(replay.childFiles.length === 0 ? [] : [`    childFiles: ${JSON.stringify(replay.childFiles)}`]),
    )
  }
  return `${lines.join('\n')}\n`
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
  const shell = expected.checkShell !== undefined
  const checkArgv = expected.checkArgv !== undefined
    ? [...expected.checkArgv]
    : shell ? [expected.checkShell!] : undefined
  if (checkArgv !== undefined || expected.check !== undefined) {
    try {
      const command = checkArgv ?? splitArgv(expected.check!)
      const outcome = await runCommand(command, [], workspace, { ...process.env }, timeoutMs, {
        shell,
        // A shell check can spawn grandchildren; kill the whole group on timeouts.
        detached: true,
      })
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
export function aggregateGrading(results: readonly EvalTrialResult[]): EvalRunGrading | null {
  const taskSuccessRate = pooledRate(results, grade => grade?.taskSuccess ?? null)
  const toolSelectionAccuracyRate = pooledRate(results, grade => grade?.toolSelectionAccuracy ?? null)
  const finalScores = results
    .map(result => result.judge?.finalAnswerScore ?? null)
    .filter((value): value is number => value !== null)
  const finalAnswerScore = finalScores.length === 0
    ? null
    : finalScores.reduce((total, value) => total + value, 0) / finalScores.length
  const hallucinated = results
    .map(result => result.judge?.hallucination ?? null)
    .filter((value): value is boolean => value !== null)
  const hallucinationRate = hallucinated.length === 0
    ? null
    : hallucinated.filter(value => value).length / hallucinated.length
  const judgeFailures = results.filter(result => result.judge?.judgeError !== undefined).length
  return taskSuccessRate === null && toolSelectionAccuracyRate === null
      && finalAnswerScore === null && hallucinationRate === null && judgeFailures === 0
    ? null
    : { taskSuccessRate, toolSelectionAccuracyRate, finalAnswerScore, hallucinationRate, judgeFailures }
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
 * @param options - opt-in shell interpretation and detached process-group kill.
 * @returns the orthogonal outcome facts.
 */
function runCommand(
  command: readonly string[],
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  options: { shell?: boolean; detached?: boolean } = {},
): Promise<SpawnOutcome> {
  const executable = command[0]
  if (executable === undefined) {
    return Promise.reject(new Error('eval: dsh command must not be empty'))
  }
  return new Promise((resolveOutcome, reject) => {
    const child = spawn(executable, options.shell === true ? [] : [...command.slice(1), ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: options.shell === true,
      detached: options.detached === true,
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
    let escalation: NodeJS.Timeout | undefined
    const timer = setTimeout(() => {
      /* v8 ignore next 2 -- close clears the timer; only a same-tick close/kill race reaches here. */
      if (settled) return
      // `close` arrives after stdio drains, so a child that has already exited
      // but is still draining its pipes must not be reported as timed out.
      /* v8 ignore next 2 -- exit-before-close is a narrow event-loop window no fixture can force deterministically. */
      if (child.exitCode !== null || child.signalCode !== null) return
      const terminate = (signal: NodeJS.Signals): void => {
        /* v8 ignore next 5 -- POSIX process-group kill; on Windows child.kill below kills the detached group. */
        if (options.detached === true && process.platform !== 'win32' && child.pid !== undefined) {
          try { process.kill(-child.pid, signal) } catch { /* the group is already gone */ }
        }
        child.kill(signal)
      }
      timedOut = true
      terminate('SIGTERM')
      /* v8 ignore next 5 -- escalation needs a child that ignores SIGTERM; the timeout fixture exits on the first signal. */
      escalation = setTimeout(() => {
        if (!settled && child.exitCode === null && child.signalCode === null) terminate('SIGKILL')
      }, 1000)
      escalation.unref()
    }, timeoutMs)
    const clearTimers = (): void => {
      clearTimeout(timer)
      if (escalation !== undefined) clearTimeout(escalation)
    }
    child.on('error', (error) => {
      clearTimers()
      /* v8 ignore next 3 -- spawn emits one error before close; the guard covers only an impossible duplicate error event. */
      if (settled) return
      settled = true
      reject(error)
    })
    child.on('close', (code) => {
      clearTimers()
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
  judgeChat: JudgeChat | undefined,
): Promise<EvalTrialResult> {
  const trialDir = join(root, `${caseSegment(caseValue.id)}-${trial}`)
  const workspace = join(trialDir, 'workspace')
  const dshHome = join(trialDir, 'dsh-home')
  await mkdir(workspace, { recursive: true })
  await mkdir(dshHome, { recursive: true, mode: 0o700 })
  if (caseValue.workspace !== undefined) await cp(caseValue.workspace, workspace, { recursive: true })
  const replayFixture = benchmark.replay === undefined
    ? undefined
    : join(benchmark.replay.dir, `${caseSegment(caseValue.id)}-${trial}`)
  let replay: { file: string; childFiles: string[] } | undefined
  if (replayFixture !== undefined) {
    const logs = await findSessionLogs(replayFixture)
    if (logs.length === 0) {
      return {
        caseId: caseValue.id,
        trial,
        status: 'error',
        error: `no replay fixture found at ${replayFixture}`,
        exitCode: null,
        timedOut: false,
      }
    }
    const primary = logs[0]!
    replay = { file: primary, childFiles: logs.slice(1) }
  }
  const overlayPath = join(trialDir, 'eval.cordis.yml')
  await writeFile(overlayPath, evalOverlay(replay), 'utf8')
  let outcome: SpawnOutcome
  try {
    outcome = await runCommand(
      benchmark.command,
      ['--profile', benchmark.profile, '--patch', overlayPath, caseValue.prompt],
      workspace,
      {
        ...process.env,
        DSH_HOME: dshHome,
        // Trial n gets a deterministic, distinct seed derived from the run's
        // base seed. An env var is ignored by harnesses that do not read it,
        // unlike an unknown CLI flag which would break them.
        DSH_EVAL_SEED: String(benchmark.seed + trial - 1),
      },
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
  const tracePaths = await findSessionLogs(dshHome)
  if (tracePaths.length === 0) {
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
    const loaded: { path: string; trace: Awaited<ReturnType<typeof loadTrace>> }[] = []
    for (const path of tracePaths) loaded.push({ path, trace: await loadTrace(path) })
    loaded.sort((a, b) => a.trace.createdAt - b.trace.createdAt)
    // tracePaths.length > 0 above guarantees a non-empty loaded list.
    const primaryPath = loaded[0]!.path
    const trace = mergeTraces(loaded.map(entry => entry.trace))
    const pricing = benchmark.pricing?.[benchmark.model]
    const metrics = computeMetrics(trace.events, pricing)
    const grade = await gradeTrial(caseValue, trace, workspace, benchmark.timeoutMs)
    const judge = benchmark.judge === undefined || judgeChat === undefined
      ? undefined
      : await tryJudgeTrial(caseValue, trace, benchmark.judge, judgeChat)
    return {
      caseId: caseValue.id,
      trial,
      status: 'completed',
      tracePath: primaryPath,
      tracePaths: loaded.map(entry => entry.path),
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      metrics,
      ...(grade.taskSuccess !== null || grade.toolSelectionAccuracy !== null ? { grade } : {}),
      ...(judge !== undefined ? { judge } : {}),
    }
  } catch (error) {
    return {
      caseId: caseValue.id,
      trial,
      status: 'error',
      error: `failed to read trace: ${message(error)}`,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
    }
  }
}

/**
 * Run every case x trial through a bounded worker pool and aggregate the
 * completed trials.
 *
 * Trials are independent by construction — each owns a private temp directory,
 * workspace copy, and DSH_HOME — so the only thing serial execution buys is
 * determinism. The pool keeps that anyway: results land at their task index, so
 * the run record stays in case-then-trial order no matter how the workers
 * interleave. The first failure to escape `runCaseTrial` stops the remaining
 * workers and rejects the run, which is the same contract as the serial loop.
 *
 * @param benchmark - the loaded benchmark.
 * @param options - runtime overrides and test seams.
 * @returns the completed run record, written by the caller.
 */
export async function runBenchmark(benchmark: Benchmark, options: RunOptions = {}): Promise<EvalRun> {
  if (benchmark.judge !== undefined && options.judgeChat === undefined) {
    throw new Error('eval: benchmark configures a judge but no LLM chat seam is available')
  }
  if (benchmark.judge !== undefined && benchmark.replay !== undefined) {
    throw new Error('eval: judge and replay cannot be combined in one run')
  }
  const trials = options.trials ?? benchmark.trials
  const concurrency = options.concurrency ?? benchmark.concurrency
  // `runBenchmark` is a documented extension point: runtime overrides need the
  // same positive-integer guarantee the YAML schema gives a loaded document.
  if (!Number.isSafeInteger(trials) || trials < 1) {
    throw new Error('eval: trials must be a positive integer')
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error('eval: concurrency must be a positive integer')
  }
  // Created only after validation, so a bad override leaves no temp directory.
  const root = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'dsh-eval-'))
  const effective: Benchmark = {
    ...benchmark,
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    ...(options.command !== undefined ? { command: options.command } : {}),
    concurrency,
  }
  const tasks: { caseValue: Benchmark['cases'][number]; trial: number }[] = []
  for (const caseValue of effective.cases) {
    for (let trial = 1; trial <= trials; trial++) tasks.push({ caseValue, trial })
  }
  const results: EvalTrialResult[] = Array.from({ length: tasks.length })
  let failure: { error: unknown } | undefined
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      const index = cursor++
      const task = tasks[index]
      if (task === undefined) return
      try {
        results[index] = await runCaseTrial(effective, task.caseValue, task.trial, root, options.judgeChat)
      } catch (error) {
        failure = { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(effective.concurrency, tasks.length) }, worker))
  if (failure !== undefined) throw failure.error
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
    ...(benchmark.judge !== undefined ? { judge: benchmark.judge } : {}),
    tempRoot: root,
    cases: results,
    caseInputs: benchmark.cases.map(caseValue => ({
      caseId: caseValue.id,
      prompt: caseValue.prompt,
      ...(caseValue.expected?.answer !== undefined ? { answer: caseValue.expected.answer } : {}),
    })),
    aggregate: aggregateMetrics(completed.map(result => result.metrics)),
    grading: aggregateGrading(completed),
  }
}
