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
}

function completedCount(run: EvalRun): number {
  return run.cases.filter(result => result.status === 'completed').length
}

/**
 * Build a short comparison of the two runs. Rates come from the pooled grading
 * block, so an ungraded run reports null rather than a misleading zero.
 */
export function compareReproduce(baseline: EvalRun, replay: EvalRun): ReproduceComparison {
  return {
    digestMatches: baseline.benchmarkSha256 === replay.benchmarkSha256,
    baselineCompleted: completedCount(baseline),
    replayCompleted: completedCount(replay),
    baselineTaskSuccessRate: baseline.grading?.taskSuccessRate ?? null,
    replayTaskSuccessRate: replay.grading?.taskSuccessRate ?? null,
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
