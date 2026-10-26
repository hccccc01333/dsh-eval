/**
 * dsh-eval — agent evaluation over headless dsh profiles.
 *
 * The eval bundle mounts this command-line plugin over dsh-base. It parses
 * `dsh --profile eval run <benchmark.yaml>` / `report <run.json>`, spawns one
 * headless dsh subprocess per case x trial, harvests each persisted session
 * log as a trace, folds automatic metrics, scripted grading (task success,
 * tool-selection accuracy), and cross-run comparison, and writes a JSON run
 * report. LLM-judge metrics (final-answer score, hallucination) and paired
 * same-seed trials are deferred to later milestones.
 *
 * @module dsh-eval
 */

import type { Context } from '@deepseek-ai/cordis'
import { loadBenchmark } from './benchmark.ts'
import { applyEval, type EvalStartupValues } from './command.ts'
import { compareRuns, renderCompareMarkdown } from './compare.ts'
import { importTraceFile } from './import.ts'
import { llmJudgeChat, type JudgeChat } from './judge.ts'
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

/**
 * Resolve the production judge chat seam from the mounted llm service, or
 * undefined when the composition carries no llm service.
 * @param ctx - the plugin context.
 * @returns a chat seam over the llm stream, or undefined without llm.
 */
export function resolveJudgeChat(ctx: Context): JudgeChat | undefined {
  const llm = ctx.get('llm')
  return llm === undefined ? undefined : llmJudgeChat(llm.stream)
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
  const judgeScore = run.grading?.finalAnswerScore
  const score = judgeScore === null || judgeScore === undefined
    ? ''
    : `, judge score ${judgeScore.toFixed(1)}`
  return `tool success ${rate}${task}${score}, ${aggregate.steps.toFixed(1)} steps/trial`
}

/**
 * Execute one eval invocation to completion.
 * @param values - the resolved command-line invocation.
 * @param io - output streams for the report and diagnostics.
 * @param services - injected runtime seams, e.g. the LLM-judge chat.
 * @returns the process exit code; nonzero for any failure or a run with no
 *   completed trials.
 */
export async function executeEval(
  values: EvalStartupValues,
  io: EvalIo,
  services: { judgeChat?: JudgeChat | undefined } = {},
): Promise<number> {
  try {
    if (values.kind === 'import') {
      const run = await importTraceFile(values.format, values.path, values.caseId)
      await writeRunReport(run, values.outPath)
      io.stdout.write(`Wrote ${values.outPath} (1 imported trial, ${summary(run)})\n`)
      return 0
    }
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
      ...(values.concurrency !== undefined ? { concurrency: values.concurrency } : {}),
      ...(values.dshCommand !== undefined ? { command: values.dshCommand } : {}),
      ...(values.profile !== undefined ? { profile: values.profile } : {}),
      ...(services.judgeChat !== undefined ? { judgeChat: services.judgeChat } : {}),
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
  const judgeChat = resolveJudgeChat(ctx)
  const values = applyEval(ctx)
  if (values === undefined) return
  void executeEval(values, internals, { judgeChat }).then((code) => { exit(code) })
}
