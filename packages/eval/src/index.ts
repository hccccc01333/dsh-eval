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
import { compareRuns, pairedCases, renderCompareMarkdown, renderPairedCases } from './compare.ts'
import { writeDashboard } from './dashboard.ts'
import { evaluateGate, renderGate, renderGateJson } from './gate.ts'
import { importTraceFile } from './import.ts'
import { buildLeaderboard, renderLeaderboard, renderLeaderboardJson } from './leaderboard.ts'
import { llmJudgeChat, type JudgeChat } from './judge.ts'
import { computeCoverage, computeReliability } from './reliability.ts'
import { rejudgeRun } from './rejudge.ts'
import { renderBenchmarkSummary } from './validate.ts'
import { renderBriefReport, renderMarkdownReport, renderReportJson, writeRunReport, loadRunReport } from './report.ts'
import { runBenchmark } from './runner.ts'
import type { EvalTrialResult } from './types.ts'

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

/** One bounded progress line; agent-controlled text must not inject newlines or terminal control codes. */
export function renderProgress(result: EvalTrialResult, finished: number, total: number): string {
  const clean = (value: string): string => value
    // CSI / OSC sequences first, then every remaining C0/C1 control byte.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .slice(0, 200)
  const label = `${clean(result.caseId)} #${result.trial}`
  if (result.status === 'error') {
    return `[eval] ${finished}/${total} ${label} ERROR ${clean(result.error ?? 'unknown error')}\n`
  }
  const task = result.grade?.taskSuccess === undefined || result.grade.taskSuccess === null
    ? 'n/a' : result.grade.taskSuccess ? 'pass' : 'fail'
  const latency = result.metrics?.latencyMs === undefined ? '?' : result.metrics.latencyMs.toFixed(0)
  return `[eval] ${finished}/${total} ${label} task ${task}, ${latency} ms\n`
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
  const reliability = computeReliability(run, 'task')
  const passes = reliability === null
    ? ''
    : `, pass@${reliability.k} ${(reliability.passAtK * 100).toFixed(1)}% / pass^${reliability.k} ${(reliability.passAllK * 100).toFixed(1)}%`
  const coverage = computeCoverage(run)
  const unscored = coverage.unscored === 0 ? '' : `, ${coverage.unscored} unscored`
  return `tool success ${rate}${task}${score}${passes}${unscored}, ${aggregate.steps.toFixed(1)} steps/trial`
}

/**
 * Execute one eval invocation to completion.
 * @param values - the resolved command-line invocation.
 * @param io - output streams for the report and diagnostics.
 * @param services - injected runtime seams, e.g. the LLM-judge chat.
 * @returns the process exit code; nonzero when any trial failed or no trial
 *   completed, so a partially failing run cannot be mistaken for a green CI.
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
      io.stdout.write(values.json === true
        ? renderReportJson(run)
        : values.brief ? renderBriefReport(run) : renderMarkdownReport(run))
      return 0
    }
    if (values.kind === 'compare') {
      const a = await loadRunReport(values.runPathA)
      const b = await loadRunReport(values.runPathB)
      io.stdout.write(renderCompareMarkdown(compareRuns(a, b)))
      const cases = pairedCases(a, b)
      if (cases !== null) io.stdout.write(renderPairedCases(cases))
      return 0
    }
    if (values.kind === 'validate') {
      io.stdout.write(renderBenchmarkSummary(await loadBenchmark(values.benchmarkPath)))
      return 0
    }
    if (values.kind === 'leaderboard') {
      const runs = await Promise.all(values.runPaths.map(async path => loadRunReport(path)))
      const entries = buildLeaderboard(runs.map(run => ({
        label: `${run.benchmark} — ${run.model}`,
        run,
      })))
      io.stdout.write(values.json === true ? renderLeaderboardJson(entries) : renderLeaderboard(entries))
      return 0
    }
    if (values.kind === 'gate') {
      const [candidate, baseline] = await Promise.all([
        loadRunReport(values.candidatePath),
        loadRunReport(values.baselinePath),
      ])
      const budgets = {
        ...(values.maxCostIncrease === undefined ? {} : { maxCostIncrease: values.maxCostIncrease }),
        ...(values.maxLatencyIncrease === undefined ? {} : { maxLatencyIncrease: values.maxLatencyIncrease }),
      }
      const result = evaluateGate(baseline, candidate, values.maxDrop, values.allowIncomplete, budgets)
      io.stdout.write(values.json === true ? renderGateJson(result) : renderGate(result))
      return result.passed ? 0 : 1
    }
    if (values.kind === 'dashboard') {
      const runs = await Promise.all(values.runPaths.map(async path => loadRunReport(path)))
      await writeDashboard(runs, values.outPath)
      io.stdout.write(`Wrote ${values.outPath}\n`)
      return 0
    }
    if (values.kind === 'rejudge') {
      if (services.judgeChat === undefined) throw new Error('rejudge: no LLM chat seam is available')
      const run = await loadRunReport(values.runPath)
      const rejudged = await rejudgeRun(run, services.judgeChat, values.judge)
      await writeRunReport(rejudged, values.outPath)
      const judgedCount = rejudged.cases.filter(result =>
        result.judge?.finalAnswerScore !== null && result.judge?.finalAnswerScore !== undefined,
      ).length
      io.stdout.write(`Wrote ${values.outPath} (${judgedCount}/${rejudged.cases.length} judged)\n`)
      return 0
    }
    const benchmark = await loadBenchmark(values.benchmarkPath)
    const run = await runBenchmark(benchmark, {
      ...(values.trials !== undefined ? { trials: values.trials } : {}),
      ...(values.concurrency !== undefined ? { concurrency: values.concurrency } : {}),
      ...(values.dshCommand !== undefined ? { command: values.dshCommand } : {}),
      ...(values.profile !== undefined ? { profile: values.profile } : {}),
      ...(services.judgeChat !== undefined ? { judgeChat: services.judgeChat } : {}),
      ...(values.quiet === true ? {} : {
        onProgress: (result: EvalTrialResult, finished: number, total: number) => {
          io.stderr.write(renderProgress(result, finished, total))
        },
      }),
    })
    await writeRunReport(run, values.outPath)
    const failed = run.cases.filter(result => result.status === 'error')
    const completed = run.cases.length - failed.length
    io.stdout.write(`Wrote ${values.outPath} (${completed}/${run.cases.length} completed, ${summary(run)})\n`)
    // A failed trial lives in the JSON report, but a CLI run must also say why
    // on stderr — otherwise an empty stdout/stderr looks like a clean failure.
    if (failed.length > 0) {
      const sample = failed.slice(0, 3).map((result) => {
        /* v8 ignore next 2 -- runner always sets `error` on error trials; the fallback guards hand-edited reports. */
        const detail = result.error ?? 'unknown error'
        return `${result.caseId}#${result.trial}: ${detail}`
      }).join('\n')
      io.stderr.write(`dsh eval: ${failed.length} trial(s) failed:\n${sample}\n`)
    }
    return failed.length > 0 || run.aggregate === null ? 1 : 0
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
