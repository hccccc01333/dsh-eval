/**
 * @deepseek-ai/dsh-eval 鈥?agent evaluation over headless dsh profiles.
 *
 * The eval bundle mounts this command-line plugin over dsh-base. It parses
 * `dsh --profile eval run <benchmark.yaml>` / `report <run.json>`, spawns one
 * headless dsh subprocess per case x trial, harvests each persisted session
 * log as a trace, folds automatic metrics, scripted grading (task success,
 * tool-selection accuracy), and cross-run comparison, and writes a JSON run
 * report. LLM-judge metrics (final-answer score, hallucination) and paired
 * same-seed trials are deferred to later milestones.
 *
 * @module @deepseek-ai/dsh-eval
 */

import type { Context } from '@deepseek-ai/cordis'
import { loadBenchmark } from './benchmark.ts'
import { applyEval, type EvalStartupValues } from './command.ts'
import { compareRuns, renderCompareMarkdown } from './compare.ts'
import { renderMarkdownReport, writeRunReport, loadRunReport } from './report.ts'
import { runBenchmark } from './runner.ts'

/** Stable Cordis plugin name. */
export const name = 'eval'
/** The launcher-provided command line is the only required service. */
export const inject = ['cmdlineArgs']

/** Process-facing output streams; tests substitute captures. */
export interface EvalIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
}

/** The process streams the eval app writes to; tests substitute captures. */
export const internals: EvalIo = {
  stdout: process.stdout,
  stderr: process.stderr,
}

/** Aggregate-success sentence for the run summary line. */
function summary(run: Awaited<ReturnType<typeof runBenchmark>>): string {
  const aggregate = run.aggregate
  if (aggregate === null) return 'no completed trials'
  const rate = aggregate.toolSuccessRate === null ? 'n/a' : `${(aggregate.toolSuccessRate * 100).toFixed(1)}%`
  const taskRate = run.grading?.taskSuccessRate
  const task = taskRate === null || taskRate === undefined
    ? ''
    : `, task success ${(taskRate * 100).toFixed(1)}%`
  return `tool success ${rate}${task}, ${aggregate.steps.toFixed(1)} steps/trial`
}

/**
 * Execute one eval invocation to completion.
 * @param values - the resolved command-line invocation.
 * @param io - output streams for the report and diagnostics.
 * @returns the process exit code; nonzero for any failure or a run with no
 *   completed trials.
 */
export async function executeEval(values: EvalStartupValues, io: EvalIo): Promise<number> {
  try {
    if (values.kind === 'report') {
      const run = await loadRunReport(values.runPath)
      io.stdout.write(renderMarkdownReport(run))
      return 0
    }
    if (values.kind === 'compare') {
      const a = await loadRunReport(values.runPathA)
      const b = await loadRunReport(values.runPathB)
      io.stdout.write(renderCompareMarkdown(compareRuns(a, b)))
      return 0
    }
    const benchmark = await loadBenchmark(values.benchmarkPath)
    const run = await runBenchmark(benchmark, {
      ...(values.trials !== undefined ? { trials: values.trials } : {}),
      ...(values.dshCommand !== undefined ? { command: values.dshCommand } : {}),
      ...(values.profile !== undefined ? { profile: values.profile } : {}),
    })
    await writeRunReport(run, values.outPath)
    io.stdout.write(`Wrote ${values.outPath} (${run.cases.length} trials, ${summary(run)})\n`)
    return run.aggregate === null ? 1 : 0
  } catch (error) {
    io.stderr.write(`dsh eval: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

/**
 * Mount the eval command-line app: parse the invocation, run it asynchronously,
 * and request launcher exit with the result code.
 * @param ctx - plugin context carrying the command line and launcher exit.
 */
export function apply(ctx: Context): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('eval: the launcher must provide ctx.appExit before the tree mounts')
  const values = applyEval(ctx)
  if (values === undefined) return
  void executeEval(values, internals).then((code) => { exit(code) })
}
