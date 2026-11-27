/**
 * Reproduce a stored run against its benchmark.
 *
 * A run report records the effective seed, trial count and CLI overrides that
 * produced it. Given the same benchmark file, this module replays that run and
 * checks the benchmark digest first — replaying against a different YAML and
 * calling the result a reproduction would be worse than no reproduction at
 * all. The new run is written to a separate file so the baseline is never
 * overwritten.
 *
 * @module dsh-eval/reproduce
 */

import { hashBenchmarkOverrides } from './digest.ts'
import { runBenchmark, type RunOptions } from './runner.ts'
import type { Benchmark, EvalRun } from './types.ts'

/** Dialects accepted from the caller; the runner owns the actual seams. */
export interface ReproduceOptions {
  judgeChat?: RunOptions['judgeChat']
  onProgress?: RunOptions['onProgress']
  tempRoot?: string
}

/** Side-by-side numbers for a baseline and its replay. */
export interface ReproduceComparison {
  digestMatches: boolean
  baselineCompleted: number
  replayCompleted: number
  baselineTaskSuccessRate: number | null
  replayTaskSuccessRate: number | null
  baselineJudgeScore: number | null
  replayJudgeScore: number | null
  /** Replay minus baseline; null when either run is unjudged. */
  judgeScoreDelta: number | null
}

function completedCount(run: EvalRun): number {
  return run.cases.filter(result => result.status === 'completed').length
}

/**
 * Build a short comparison of the two runs. Rates come from the pooled grading
 * block, so an ungraded run reports null rather than a misleading zero.
 */
export function compareReproduce(baseline: EvalRun, replay: EvalRun): ReproduceComparison {
  const baselineJudgeScore = baseline.grading?.finalAnswerScore ?? null
  const replayJudgeScore = replay.grading?.finalAnswerScore ?? null
  return {
    digestMatches: baseline.benchmarkSha256 === replay.benchmarkSha256,
    baselineCompleted: completedCount(baseline),
    replayCompleted: completedCount(replay),
    baselineTaskSuccessRate: baseline.grading?.taskSuccessRate ?? null,
    replayTaskSuccessRate: replay.grading?.taskSuccessRate ?? null,
    baselineJudgeScore,
    replayJudgeScore,
    judgeScoreDelta: baselineJudgeScore === null || replayJudgeScore === null
      ? null : replayJudgeScore - baselineJudgeScore,
  }
}

/**
 * Check that the benchmark matches the baseline's digest and replay the run
 * with the baseline's effective configuration.
 * @throws when the benchmark file no longer matches the recorded run.
 */
export async function reproduceRun(
  baseline: EvalRun,
  benchmark: Benchmark,
  options: ReproduceOptions = {},
): Promise<EvalRun> {
  const overrides = baseline.benchmarkOverrides
  if (benchmark.sourceSha256 !== undefined && baseline.benchmarkSha256 !== undefined) {
    const expected = overrides === undefined
      ? benchmark.sourceSha256
      : hashBenchmarkOverrides(benchmark.sourceSha256, overrides)
    if (expected !== baseline.benchmarkSha256) {
      throw new Error(
        `reproduce: the benchmark differs from the one used by ${baseline.benchmark} ` +
        `(expected sha256 ${baseline.benchmarkSha256}, got ${expected})`,
      )
    }
  }
  // A run whose judge was configured in the benchmark must not silently
  // become an unjudged replay just because this process has no LLM seam: the
  // comparison would then claim to reproduce a score it never recomputed.
  const baselineScore = baseline.grading?.finalAnswerScore
  const baselineJudged = (baselineScore !== null && baselineScore !== undefined)
    || baseline.cases.some(result => result.judge !== undefined)
  if (baselineJudged && benchmark.judge !== undefined && options.judgeChat === undefined) {
    throw new Error(
      'reproduce: the baseline run used an LLM judge but no LLM chat seam is available — ' +
      'configure the eval profile\'s LLM provider before reproducing',
    )
  }

  // Pass exactly the recorded overrides: adding a "harmless" default here
  // would change the replay's digest and make every reproduction look like a
  // mismatch. The benchmark file itself supplies whatever was not overridden.
  return runBenchmark(benchmark, {
    ...(overrides?.trials === undefined ? {} : { trials: overrides.trials }),
    ...(overrides?.seed === undefined ? {} : { seed: overrides.seed }),
    ...(overrides?.concurrency === undefined ? {} : { concurrency: overrides.concurrency }),
    ...(overrides?.profile === undefined ? {} : { profile: overrides.profile }),
    ...(overrides?.dshCommand === undefined ? {} : { command: overrides.dshCommand }),
    ...(options.judgeChat === undefined ? {} : { judgeChat: options.judgeChat }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    ...(options.tempRoot === undefined ? {} : { tempRoot: options.tempRoot }),
  })
}
