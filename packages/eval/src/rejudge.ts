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

import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, isAbsolute, parse, relative, resolve, sep } from 'node:path'
import { tryJudgeTrial, type JudgeChat } from './judge.ts'
import { aggregateGrading } from './runner.ts'
import { loadTrace, mergeTraces, traceDigest } from './trace.ts'
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
  const root = await realpath(resolve(run.tempRoot))
  // A hand-edited report must not promote a drive root or home directory to
  // the "allowed" root; that would make every local log reachable by design.
  if (root === parse(root).root || root === resolve(homedir())
    || relative(parse(root).root, root).split(sep).filter(Boolean).length === 0) {
    throw new Error('rejudge: tempRoot must be a dedicated run directory')
  }
  const insideRoot = async (path: string): Promise<boolean> => {
    if (!isAbsolute(path)) return false
    // realpath resolves `..` and symlinks before comparing, so neither a
    // traversal prefix nor a symlink to another run's log escapes the check.
    let resolved: string
    try {
      resolved = await realpath(path)
    } catch {
      return false
    }
    const rel = relative(root, resolved)
    return extname(resolved) === '.jsonl'
      && rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  }
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
      if (!await insideRoot(path)) {
        throw new Error(`rejudge: trace path "${path}" is outside the run's tempRoot or not a .jsonl log`)
      }
    }
    const loaded = await Promise.all(paths.map(async path => ({ path, trace: await loadTrace(path) })))
    loaded.sort((a, b) => a.trace.createdAt - b.trace.createdAt)
    const merged = mergeTraces(loaded.map(entry => entry.trace))
    if (result.traceSha256 !== undefined && traceDigest(merged) !== result.traceSha256) {
      throw new Error(`rejudge: trace for ${result.caseId}#${result.trial} differs from the recorded digest`)
    }
    const caseValue: BenchmarkCase = {
      id: input.caseId,
      prompt: input.prompt,
      ...(input.answer !== undefined ? { expected: { answer: input.answer } } : {}),
    }
    const verdict = await tryJudgeTrial(caseValue, merged, judge, judgeChat)
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
