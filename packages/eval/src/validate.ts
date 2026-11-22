/**
 * Benchmark preflight for dsh-eval.
 *
 * A malformed benchmark is best caught before a run spawns agents and spends
 * tokens. Parsing already rejects invalid YAML, regexes and conflicting check
 * modes; this module turns the validated document into a readable summary plus
 * warnings for configurations that run but produce weak evidence.
 *
 * @module dsh-eval/validate
 */

import type { Benchmark } from './types.ts'

/**
 * Render a validated benchmark summary with actionable warnings.
 * @param benchmark - a parsed benchmark document.
 * @returns markdown ending in a newline.
 */
export function renderBenchmarkSummary(benchmark: Benchmark): string {
  let checks = 0
  let toolConstraints = 0
  let gradedCases = 0
  let goldAnswers = 0
  let shellChecks = 0
  for (const item of benchmark.cases) {
    const expected = item.expected
    if (expected === undefined) continue
    gradedCases += 1
    if (expected.answer !== undefined) goldAnswers += 1
    if (expected.check !== undefined) checks += 1
    if (expected.checkArgv !== undefined) checks += 1
    if (expected.checkShell !== undefined) {
      checks += 1
      shellChecks += 1
    }
    toolConstraints += [expected.tool, expected.tools, expected.toolAnyOf, expected.toolRegex, expected.toolNot]
      .filter(value => value !== undefined).length
  }
  const warnings: string[] = []
  if (gradedCases === 0) warnings.push('no case has scripted expectations — results depend entirely on the judge')
  if (checks === 0 && toolConstraints === 0) {
    warnings.push('no case checks tool use or task success — the run will produce only cost and latency data')
  }
  if (benchmark.judge !== undefined && goldAnswers === 0) {
    warnings.push('judge is configured but no case supplies a gold answer — score calibration will be weak')
  }
  if (shellChecks > 0) {
    warnings.push(`${shellChecks} shell check(s) need a trusted benchmark file (pipes and redirection are enabled)`)
  }
  if (benchmark.replay !== undefined && benchmark.judge === undefined) {
    warnings.push('replay runs have no live judge; use `dsh eval rejudge` after the run if judge scores are needed')
  }
  const lines = [
    `# Benchmark: ${benchmark.name}`,
    '',
    `- model: ${benchmark.model}`,
    `- profile: ${benchmark.profile}`,
    `- command: ${benchmark.command.join(' ')}`,
    `- trials per case: ${benchmark.trials}`,
    `- concurrency: ${benchmark.concurrency}`,
    `- timeout: ${benchmark.timeoutMs} ms`,
    `- seed: ${benchmark.seed} (trial n receives DSH_EVAL_SEED = ${benchmark.seed} + n - 1)`,
    `- cases: ${benchmark.cases.length} (${gradedCases} graded, ${goldAnswers} with gold answers)`,
    `- expectations: ${checks} check(s), ${toolConstraints} tool constraint(s)`,
    `- judge: ${benchmark.judge === undefined ? 'none' : `${benchmark.judge.model} on ${benchmark.judge.provider} (max ${benchmark.judge.maxScore})`}`,
    `- replay: ${benchmark.replay === undefined ? 'live' : benchmark.replay.dir}`,
    `- pricing: ${benchmark.pricing === undefined ? 'none' : 'configured'}`,
    '',
    `Validated: ${benchmark.name} is ready to run.`,
    '',
  ]
  if (warnings.length > 0) {
    lines.push('## Warnings', '', ...warnings.map(warning => `- ${warning}`), '')
  }
  return lines.join('\n')
}
