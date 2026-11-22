/**
 * Offline re-judging for dsh-eval: rebuild judge verdicts from a stored run's
 * harvested traces and persisted case inputs, then re-aggregate grading.
 *
 * This enables a keyless two-phase workflow: record a run with replay (which
 * cannot coexist with a live judge), then judge the recorded traces later with
 * an LLM seam. Only the judge verdicts and the grading summary change; metrics,
 * scripted grades, and trial outcomes are preserved.
 *
 * @module dsh-eval/rejudge
 */

import { extname, isAbsolute, resolve, sep } from 'node:path'
import { tryJudgeTrial, type JudgeChat } from './judge.ts'
import { aggregateGrading } from './runner.ts'
import { loadTrace, mergeTraces } from './trace.ts'
import type { BenchmarkCase, BenchmarkJudge, EvalRun, EvalTrialResult } from './types.ts'

/**
 * Re-judge every completed trial of a persisted run.
 * @param run - a validated run report carrying `caseInputs`.
 * @param judgeChat - the injected chat seam for the judge model.
 * @param judgeOverride - judge config to use instead of the one stored in the run.
 * @returns a new run with fresh verdicts and a re-aggregated grading summary.
 * @throws when the report lacks the data a judge prompt needs.
 */
export async function rejudgeRun(
  run: EvalRun,
  judgeChat: JudgeChat,
  judgeOverride?: BenchmarkJudge,
): Promise<EvalRun> {
  const judge = judgeOverride ?? run.judge
  if (judge === undefined) {
    throw new Error('rejudge: no judge configuration; pass --judge-model to supply one')
  }
  if (run.caseInputs === undefined) {
    throw new Error('rejudge: the run has no caseInputs; re-run with a version that persists prompts')
  }
  const inputs = new Map(run.caseInputs.map(input => [input.caseId, input]))
  // A report is data, not code: a hand-edited tracePaths entry must not be able
  // to make the judge read and ship an arbitrary local file to an LLM.
  const root = resolve(run.tempRoot)
  const insideRoot = (path: string): boolean =>
    isAbsolute(path) && extname(path) === '.jsonl'
      && (path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))
  const cases: EvalTrialResult[] = []
  for (const result of run.cases) {
    if (result.status !== 'completed') {
      cases.push(result)
      continue
    }
    const input = inputs.get(result.caseId)
    if (input === undefined) {
      throw new Error(`rejudge: no case input for "${result.caseId}"`)
    }
    const paths = result.tracePaths ?? (result.tracePath === undefined ? [] : [result.tracePath])
    if (paths.length === 0) {
      throw new Error(`rejudge: trial ${result.caseId}#${result.trial} has no harvested trace`)
    }
    for (const path of paths) {
      if (!insideRoot(path)) {
        throw new Error(`rejudge: trace path "${path}" is outside the run's tempRoot or not a .jsonl log`)
      }
    }
    const loaded = await Promise.all(paths.map(async path => ({ path, trace: await loadTrace(path) })))
    loaded.sort((a, b) => a.trace.createdAt - b.trace.createdAt)
    const caseValue: BenchmarkCase = {
      id: input.caseId,
      prompt: input.prompt,
      ...(input.answer !== undefined ? { expected: { answer: input.answer } } : {}),
    }
    const verdict = await tryJudgeTrial(caseValue, mergeTraces(loaded.map(entry => entry.trace)), judge, judgeChat)
    const previous = result.judge
    // A flaky judge must not erase an already usable score. Keep the old one,
    // but leave the failure visible next to it in the report.
    const keepPrevious = verdict.judgeError !== undefined && previous?.finalAnswerScore != null
    cases.push({
      ...result,
      judge: keepPrevious
        ? { ...previous!, judgeError: `${verdict.judgeError} (previous verdict kept)` }
        : verdict,
    })
  }
  // Grading depends on grade/judge fields, not on metrics, so do not require a
  // metric fold here — imported or hand-edited reports may legitimately omit it.
  const completed = cases.filter(result => result.status === 'completed')
  // Record the judge actually used, including a CLI override.
  return { ...run, judge, cases, grading: aggregateGrading(completed) }
}
