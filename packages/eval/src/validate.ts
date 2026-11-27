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

import { signTestPower } from './stats.ts'
import type { Benchmark } from './types.ts'

/** Structured preflight result, shared by the markdown and JSON renderers. */
export interface BenchmarkSummary {
  name: string
  /** SHA-256 of the benchmark YAML source, when parsed from text. */
  sourceSha256: string | null
  model: string
  profile: string
  command: readonly string[]
  trials: number
  concurrency: number
  timeoutMs: number
  seed: number
  cases: number
  gradedCases: number
  goldAnswers: number
  checks: number
  toolConstraints: number
  /** Cases with a per-case timeout override. */
  caseTimeouts: number
  /** Distinct case tags used for segment analysis. */
  tags: string[]
  judge: { provider: string; model: string; maxScore: number } | null
  replay: string | null
  pricing: boolean
  warnings: string[]
}

/**
 * Derive a structured preflight summary from a validated benchmark.
 * @param benchmark - a parsed benchmark document.
 * @returns counts, configuration and actionable warnings.
 */
export function summarizeBenchmark(benchmark: Benchmark): BenchmarkSummary {
  let checks = 0
  let toolConstraints = 0
  let gradedCases = 0
  let goldAnswers = 0
  let shellChecks = 0
  let caseTimeouts = 0
  const warnings: string[] = []
  const caseIds = new Set<string>()
  const duplicateIds = new Set<string>()
  const tags = new Set<string>()
  for (const item of benchmark.cases) {
    for (const tag of item.tags ?? []) tags.add(tag)
    if (item.timeoutMs !== undefined) caseTimeouts += 1
    if (caseIds.has(item.id)) duplicateIds.add(item.id)
    caseIds.add(item.id)
    const expected = item.expected
    if (expected === undefined) continue
    gradedCases += 1
    if (expected.answer !== undefined) goldAnswers += 1
    if (expected.check !== undefined) checks += 1
    if (expected.checkArgv !== undefined) checks += 1
    const hasCheck = expected.check !== undefined || expected.checkArgv !== undefined
      || expected.checkShell !== undefined
    if (expected.answerRegex !== undefined) {
      if (hasCheck) {
        warnings.push(`case ${item.id} combines a check command with answerRegex — the regex is ignored`)
      } else {
        checks += 1
      }
    }
    if (expected.checkShell !== undefined) {
      checks += 1
      shellChecks += 1
    }
    toolConstraints += [expected.tool, expected.tools, expected.toolAnyOf, expected.toolRegex, expected.toolNot]
      .filter(value => value !== undefined).length
  }
  if (duplicateIds.size > 0) {
    warnings.push(`duplicate case ids (${[...duplicateIds].slice(0, 5).join(', ')}) break pairing and case-input lookup`)
  }
  if (benchmark.trials < 2) {
    warnings.push('one trial per case cannot measure flakiness or pass@k; use at least 2 trials')
  }
  if (gradedCases === 0 && benchmark.judge === undefined) {
    warnings.push('no case has scripted expectations and no judge is configured — the run cannot produce a quality score')
  } else if (gradedCases === 0) {
    warnings.push('no case has scripted expectations — results depend entirely on the judge')
  }
  if (checks === 0 && toolConstraints === 0 && benchmark.judge === undefined) {
    warnings.push('no case checks tool use or task success — the run will produce only cost and latency data')
  }
  if (benchmark.judge !== undefined && goldAnswers === 0) {
    warnings.push('judge is configured but no case supplies a gold answer — score calibration will be weak')
  }
  if (shellChecks > 0) {
    warnings.push(`${shellChecks} shell check(s) need a trusted benchmark file (pipes and redirection are enabled)`)
  }
  const maxPairs = benchmark.cases.length * benchmark.trials
  // Preflight cannot know whether trials will carry step/token metrics, so it
  // assumes the largest inference family the comparison may print.
  const minimumDiscordant = signTestPower(0, benchmark.judge === undefined ? 3 : 4).minimumDiscordant
  if (maxPairs < minimumDiscordant) {
    warnings.push(`at most ${maxPairs} paired trials; a Bonferroni-corrected sign test needs ≥${minimumDiscordant} discordant pairs to reach α=0.05`)
  }
  if (benchmark.replay !== undefined && benchmark.judge === undefined) {
    warnings.push('replay runs have no live judge; use `dsh eval rejudge` after the run if judge scores are needed')
  }
  if (benchmark.replay !== undefined && benchmark.judge !== undefined) {
    warnings.push('judge and replay cannot be combined in one run — `dsh eval run` will reject this benchmark')
  }
  const judge = benchmark.judge
  return {
    name: benchmark.name,
    sourceSha256: benchmark.sourceSha256 ?? null,
    model: benchmark.model,
    profile: benchmark.profile,
    command: benchmark.command,
    trials: benchmark.trials,
    concurrency: benchmark.concurrency,
    timeoutMs: benchmark.timeoutMs,
    seed: benchmark.seed,
    cases: benchmark.cases.length,
    gradedCases,
    goldAnswers,
    checks,
    toolConstraints,
    caseTimeouts,
    tags: [...tags].sort((a, b) => Number(a > b) - Number(a < b)),
    judge: judge === undefined ? null : {
      provider: judge.provider, model: judge.model, maxScore: judge.maxScore,
    },
    replay: benchmark.replay === undefined ? null : benchmark.replay.dir,
    pricing: benchmark.pricing !== undefined,
    warnings,
  }
}

/**
 * Render a validated benchmark summary with actionable warnings.
 * @param benchmark - a parsed benchmark document.
 * @returns markdown ending in a newline.
 */
/** Benchmark-controlled text printed to a terminal must not carry control bytes. */
function terminalSafe(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
}

export function renderBenchmarkSummary(benchmark: Benchmark): string {
  const summary = summarizeBenchmark(benchmark)
  const lines = [
    `# Benchmark: ${terminalSafe(summary.name)}`,
    '',
    `- model: ${terminalSafe(summary.model)}`,
    ...(summary.sourceSha256 === null ? [] : [`- source sha256: ${summary.sourceSha256}`]),
    `- profile: ${terminalSafe(summary.profile)}`,
    `- command: ${terminalSafe(summary.command.join(' '))}`,
    `- trials per case: ${summary.trials}`,
    `- concurrency: ${summary.concurrency}`,
    `- timeout: ${summary.timeoutMs} ms${summary.caseTimeouts === 0 ? '' : ` (${summary.caseTimeouts} per-case override(s))`}`,
    `- seed: ${summary.seed} (trial n receives DSH_EVAL_SEED = ${summary.seed} + n - 1)`,
    `- cases: ${summary.cases} (${summary.gradedCases} graded, ${summary.goldAnswers} with gold answers)`,
    ...(summary.tags.length === 0 ? [] : [
      `- tags: ${summary.tags.map(terminalSafe).join(', ')}`,
    ]),
    `- expectations: ${summary.checks} check(s), ${summary.toolConstraints} tool constraint(s)`,
    `- judge: ${summary.judge === null ? 'none' : `${terminalSafe(summary.judge.model)} on ${terminalSafe(summary.judge.provider)} (max ${summary.judge.maxScore})`}`,
    `- replay: ${summary.replay === null ? 'live' : terminalSafe(summary.replay)}`,
    `- pricing: ${summary.pricing ? 'configured' : 'none'}`,
    '',
    `Validated: ${terminalSafe(summary.name)} is ready to run.`,
    '',
  ]
  if (summary.warnings.length > 0) {
    lines.push('## Warnings', '', ...summary.warnings.map(warning => `- ${terminalSafe(warning)}`), '')
  }
  return lines.join('\n')
}

/**
 * Render a preflight summary as machine-readable JSON.
 * @param benchmark - a parsed benchmark document.
 * @returns a JSON string ending in a newline.
 */
export function renderBenchmarkJson(benchmark: Benchmark): string {
  return `${JSON.stringify(summarizeBenchmark(benchmark))}\n`
}
