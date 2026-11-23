/**
 * The eval app's commander program: `run <benchmark.yaml>` executes a
 * benchmark and writes its JSON report; `report <run.json>` renders one as
 * markdown. Parsing follows the cmdline contract: the action publishes an
 * ordinary service, and help or a rejection publishes nothing.
 *
 * @module dsh-eval/command
 */

import { resolve } from 'node:path'
import { splitArgv } from './argv.ts'
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import type { ImportFormat } from './import.ts'
import type { BenchmarkJudge } from './types.ts'

/** What the eval app resolved from its command line. */
export type EvalStartupValues =
  | {
    kind: 'run'
    benchmarkPath: string
    outPath: string
    trials?: number
    concurrency?: number
    dshCommand?: readonly string[]
    profile?: string
    quiet?: boolean
    allowExternalPaths?: boolean
  }
  | {
    kind: 'report'
    runPath: string
    /** Print a compact terminal summary instead of the full markdown report. */
    brief?: boolean
    /** Emit machine-readable JSON instead of markdown. */
    json?: boolean
    /** Optional output path; the report goes to stdout when omitted. */
    outPath?: string
  }
  | {
    kind: 'compare'
    runPathA: string
    runPathB: string
    json?: boolean
    outPath?: string
  }
  | {
    kind: 'export'
    runPath: string
    /** Optional output path; CSV goes to stdout when omitted. */
    outPath?: string
  }
  | {
    kind: 'validate'
    benchmarkPath: string
    json?: boolean
    outPath?: string
    allowExternalPaths?: boolean
  }
  | {
    kind: 'provenance'
    runPath: string
    benchmarkPath: string
    json?: boolean
    outPath?: string
    allowExternalPaths?: boolean
  }
  | {
    kind: 'leaderboard'
    runPaths: readonly string[]
    json?: boolean
    outPath?: string
    metric?: 'taskSuccess' | 'strictPassAt1'
  }
  | {
    kind: 'gate'
    candidatePath: string
    baselinePath: string
    maxDrop: number
    maxCostIncrease?: number
    maxLatencyIncrease?: number
    allowIncomplete: boolean
    requireSignificance?: boolean
    json?: boolean
    outPath?: string
  }
  | {
    kind: 'dashboard'
    runPaths: readonly string[]
    outPath: string
  }
  | {
    kind: 'rejudge'
    runPath: string
    outPath: string
    /** Optional judge configuration overriding the one stored in the run. */
    judge?: BenchmarkJudge
  }
  | {
    kind: 'import'
    format: ImportFormat
    path: string
    outPath: string
    caseId: string
  }

/** Options accepted by `eval run`. */
interface RunCommandOptions {
  out: string
  trials?: number
  concurrency?: number
  dsh?: string
  profile?: string
  quiet?: boolean
  allowExternalPaths?: boolean
}

/** Options accepted by `eval report`. */
interface ReportCommandOptions {
  brief?: boolean
  json?: boolean
  out?: string
}

/** Options accepted by `eval rejudge`. */
interface RejudgeCommandOptions {
  out: string
  judgeModel?: string
  judgeProvider?: string
  judgeRubric?: string
  judgeMaxScore?: number
}

/** Options accepted by `eval import`. */
interface ImportCommandOptions {
  out: string
  caseId: string
}

/** Turn an optional `--out` flag into a strictly optional startup value. */
function optionalOut(options: { out?: string }): { outPath?: string } {
  return options.out === undefined ? {} : { outPath: options.out }
}

/** Split a single `--dsh` value into argv, honoring quotes and escapes. */
function splitCommand(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined
  const command = splitArgv(value)
  return command.length === 0 ? undefined : command
}

/**
 * Build a commander option parser for a positive-integer flag, so `--trials`
 * and `--concurrency` reject the same inputs with the same message shape.
 * @param program - the program to error through.
 * @param flag - the flag name, for the error text.
 * @returns the parser.
 */
function positiveInteger(program: Command, flag: string): (value: string) => number {
  return (value) => {
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed <= 0) program.error(`error: ${flag} must be a positive integer`)
    return parsed
  }
}

/** Build a parser for the leaderboard primary metric flag. */
function leaderboardMetric(program: Command, flag: string): (value: string) => 'taskSuccess' | 'strictPassAt1' {
  return (value) => {
    if (value !== 'taskSuccess' && value !== 'strictPassAt1') {
      program.error(`error: ${flag} must be taskSuccess or strictPassAt1`)
    }
    return value
  }
}

/** Build a parser for a 0..1 tolerance flag. */
function unitRatio(program: Command, flag: string): (value: string) => number {
  return (value) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      program.error(`error: ${flag} must be between 0 and 1`)
    }
    return parsed
  }
}

/**
 * Build a fresh eval commander program. The root action rejects a bare
 * invocation; the `run` and `report` actions hand the resolved values to the
 * publish callback. The callback, not a Cordis service, carries the values
 * because the plugin's own fiber is not yet active when the parse action runs
 * and a strict `ctx.get` would miss a just-provided service.
 * @param publish - receives the resolved invocation once a subcommand runs.
 * @returns the configured program.
 */
export function evalCommand(publish: (values: EvalStartupValues) => void): Command {
  const program = new Command()
    .name('dsh --profile eval')
    .description('Run agent evaluations over headless dsh profiles and report trace-based metrics.')
    .helpOption('-h, --help', 'show this help')
    .addHelpText('after', `
Examples:
  dsh --profile eval validate benchmark.yaml
  dsh --profile eval run benchmark.yaml --out run.json
  dsh --profile eval provenance run.json benchmark.yaml
  dsh --profile eval report run.json --brief
  dsh --profile eval export run.json --out trials.csv
  dsh --profile eval compare base.json candidate.json
  dsh --profile eval dashboard base.json candidate.json --out eval.html
  dsh --profile eval gate candidate.json --baseline base.json --max-drop 0.05
  dsh --profile eval gate candidate.json --baseline base.json --require-significance --json
`)
    .action(() => {
      program.error('error: eval needs a subcommand: run <benchmark.yaml>, validate <benchmark.yaml>, provenance <run.json> <benchmark.yaml>, report <run.json>, compare <a.json> <b.json>, export <run.json>, rejudge <run.json>, dashboard <run.json>, leaderboard <run.json>..., gate <candidate.json>, or import <format> <log.jsonl>')
    })
  const run = program.command('run').description('run a benchmark and write its JSON report')
  run
    .argument('<benchmark.yaml>', 'path to the benchmark document')
    .option('--out <path>', 'output run JSON path', 'eval-run.json')
    .option('--trials <n>', 'override the benchmark trials count', positiveInteger(program, '--trials'))
    .option('--concurrency <n>', 'override the in-flight trial limit', positiveInteger(program, '--concurrency'))
    .option('--dsh <cmd>', 'override the dsh launcher command, space-separated')
    .option('--profile <name>', 'override the spawned dsh profile')
    .option('--quiet', 'suppress per-trial progress lines')
    .option('--allow-external-paths', 'allow benchmark-referenced files outside the benchmark directory (trusted benchmarks only)')
    .action((benchmarkPath: string, options: RunCommandOptions) => {
      let dshCommand: readonly string[] | undefined
      try {
        dshCommand = splitCommand(options.dsh)
      } catch (error) {
        /* v8 ignore next -- splitArgv only throws Error instances. */
        const detail = error instanceof Error ? error.message : String(error)
        program.error(`error: --dsh: ${detail}`)
      }
      // An explicitly supplied but empty launcher is a typo, not "use the
      // default": silently falling back hides the mistake behind a run whose
      // only symptom is an empty stderr and failed trials.
      if (options.dsh !== undefined && dshCommand === undefined) {
        program.error('error: --dsh must contain a command')
      }
      publish({
        kind: 'run',
        benchmarkPath,
        outPath: options.out,
        ...(options.trials !== undefined ? { trials: options.trials } : {}),
        ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
        ...(dshCommand !== undefined ? { dshCommand } : {}),
        ...(options.profile !== undefined ? { profile: options.profile } : {}),
        quiet: options.quiet === true,
        allowExternalPaths: options.allowExternalPaths === true,
      })
    })
  const report = program.command('report').description('render a persisted run JSON as markdown or JSON')
  report
    .argument('<run.json>', 'path to a run report')
    .option('--brief', 'print a compact terminal summary instead of the full report')
    .option('--json', 'emit machine-readable JSON instead of markdown')
    .option('--out <path>', 'write the report to a file instead of stdout')
    .action((runPath: string, options: ReportCommandOptions) => {
      publish({
        kind: 'report',
        runPath,
        ...(options.brief ? { brief: true } : {}),
        json: options.json === true,
        ...(options.out === undefined ? {} : { outPath: options.out }),
      })
    })
  const compare = program.command('compare').description('compare two persisted run reports as markdown or JSON')
  compare
    .argument('<run-a.json>', 'baseline run report')
    .argument('<run-b.json>', 'candidate run report')
    .option('--json', 'emit a machine-readable JSON comparison')
    .option('--out <path>', 'write the comparison to a file instead of stdout')
    .action((runPathA: string, runPathB: string, options: { json?: boolean; out?: string }) => {
      publish({ kind: 'compare', runPathA, runPathB, json: options.json === true, ...optionalOut(options) })
    })
  const exporter = program.command('export').description('export a run report as trial-level CSV')
  exporter
    .argument('<run.json>', 'path to a run report')
    .option('--out <path>', 'write CSV to a file instead of stdout')
    .action((runPath: string, options: { out?: string }) => {
      publish({ kind: 'export', runPath, ...(options.out === undefined ? {} : { outPath: options.out }) })
    })
  const validate = program.command('validate').description('validate a benchmark file and print a preflight summary')
  validate
    .argument('<benchmark.yaml>', 'path to a benchmark document')
    .option('--json', 'emit a machine-readable preflight summary')
    .option('--out <path>', 'write the preflight summary to a file instead of stdout')
    .option('--allow-external-paths', 'allow benchmark-referenced files outside the benchmark directory (trusted benchmarks only)')
    .action((benchmarkPath: string, options: { json?: boolean; out?: string; allowExternalPaths?: boolean }) => {
      publish({
        kind: 'validate', benchmarkPath, json: options.json === true,
        allowExternalPaths: options.allowExternalPaths === true,
        ...optionalOut(options),
      })
    })
  const provenance = program.command('provenance').description('verify a run report against its benchmark inputs')
  provenance
    .argument('<run.json>', 'path to a persisted run report')
    .argument('<benchmark.yaml>', 'path to the benchmark document')
    .option('--json', 'emit a machine-readable verification result')
    .option('--out <path>', 'write the verification result to a file instead of stdout')
    .option('--allow-external-paths', 'allow referenced files outside the benchmark directory (trusted benchmarks only)')
    .action((runPath: string, benchmarkPath: string,
      options: { json?: boolean; out?: string; allowExternalPaths?: boolean }) => {
      publish({
        kind: 'provenance', runPath, benchmarkPath,
        json: options.json === true,
        allowExternalPaths: options.allowExternalPaths === true,
        ...optionalOut(options),
      })
    })
  const leaderboard = program.command('leaderboard').description('rank persisted runs by pooled task success')
  leaderboard
    .argument('<run.json...>', 'paths to run reports')
    .option('--json', 'emit a machine-readable JSON leaderboard')
    .option('--out <path>', 'write the leaderboard to a file instead of stdout')
    .option('--metric <name>', 'primary ranking metric: taskSuccess (default) or strictPassAt1',
      leaderboardMetric(program, '--metric'))
    .action((runPaths: string[], options: { json?: boolean; out?: string; metric?: 'taskSuccess' | 'strictPassAt1' }) => {
      publish({
        kind: 'leaderboard', runPaths, json: options.json === true,
        ...(options.metric === undefined ? {} : { metric: options.metric }),
        ...optionalOut(options),
      })
    })
  const gate = program.command('gate').description('fail a CI build when a candidate run regresses against a baseline')
  gate
    .argument('<candidate.json>', 'path to the candidate run report')
    .option('--baseline <path>', 'path to the trusted baseline run report')
    .option('--max-drop <ratio>', 'largest tolerated quality regression, 0..1', unitRatio(program, '--max-drop'), 0)
    .option('--max-cost-increase <ratio>', 'largest tolerated cost/trial increase over baseline, 0..1', unitRatio(program, '--max-cost-increase'))
    .option('--max-latency-increase <ratio>', 'largest tolerated latency/trial increase over baseline, 0..1', unitRatio(program, '--max-latency-increase'))
    .option('--allow-incomplete', 'do not fail on extra unscored trials')
    .option('--require-significance', 'only fail quality drops confirmed by a paired sign test')
    .option('--json', 'emit a machine-readable JSON verdict instead of markdown')
    .option('--out <path>', 'write the verdict to a file instead of stdout')
    .action((candidatePath: string, options: {
      baseline?: string
      maxDrop: number
      maxCostIncrease?: number
      maxLatencyIncrease?: number
      allowIncomplete?: boolean
      requireSignificance?: boolean
      json?: boolean
      out?: string
    }) => {
      if (options.baseline === undefined) program.error('error: gate needs --baseline <path>')
      publish({
        kind: 'gate',
        candidatePath,
        baselinePath: options.baseline!,
        maxDrop: options.maxDrop,
        ...(options.maxCostIncrease === undefined ? {} : { maxCostIncrease: options.maxCostIncrease }),
        ...(options.maxLatencyIncrease === undefined ? {} : { maxLatencyIncrease: options.maxLatencyIncrease }),
        allowIncomplete: options.allowIncomplete === true,
        requireSignificance: options.requireSignificance === true,
        json: options.json === true,
        ...optionalOut(options),
      })
    })
  const dashboard = program.command('dashboard').description('render persisted runs as a standalone HTML dashboard or leaderboard')
  dashboard
    .argument('<run.json...>', 'one run, two to compare, or three+ for a leaderboard')
    .option('--out <path>', 'output HTML path', 'eval-dashboard.html')
    .action((runPaths: string[], options: { out: string }) => {
      publish({ kind: 'dashboard', runPaths, outPath: options.out })
    })
  const rejudge = program.command('rejudge').description('re-judge a stored run from its traces without re-running the agent')
  rejudge
    .argument('<run.json>', 'path to a run report with judge config and case inputs')
    .option('--out <path>', 'output run JSON path; must differ from the input', 'rejudged-run.json')
    .option('--judge-model <id>', 'judge model id; also enables overriding the stored judge config')
    .option('--judge-provider <name>', 'judge provider route, default deepseek')
    .option('--judge-rubric <text>', 'rubric appended to the judge prompt')
    .option('--judge-max-score <n>', 'maximum judge score', positiveInteger(program, '--judge-max-score'))
    .action((runPath: string, options: RejudgeCommandOptions) => {
      const samePath = resolve(runPath).toLowerCase() === resolve(options.out).toLowerCase()
      if (samePath) {
        program.error('error: --out must differ from the input run report')
      }
      publish({
        kind: 'rejudge',
        runPath,
        outPath: options.out,
        ...(options.judgeModel === undefined ? {} : {
          judge: {
            provider: options.judgeProvider ?? 'deepseek',
            model: options.judgeModel,
            maxScore: options.judgeMaxScore ?? 10,
            ...(options.judgeRubric === undefined ? {} : { rubric: options.judgeRubric }),
          },
        }),
      })
    })
  const importer = program.command('import').description('import an external harness session log as a run report')
  importer
    .argument('<format>', 'external harness format: codex or claude-code')
    .argument('<session.jsonl>', 'path to the external session log')
    .option('--out <path>', 'output run JSON path', 'imported-run.json')
    .option('--case-id <id>', 'case id for the imported trial', 'imported')
    .action((format: string, path: string, options: ImportCommandOptions) => {
      if (format !== 'codex' && format !== 'claude-code') {
        program.error('error: import format must be codex or claude-code')
        return
      }
      publish({ kind: 'import', format, path, outPath: options.out, caseId: options.caseId })
    })
  return program
}

/**
 * Parse the launcher's inner arguments with the eval program and return what
 * the invoked command published.
 * @param ctx - plugin context carrying `cmdlineArgs` and `appExit`.
 * @returns the resolved invocation, or undefined when help or an error exited.
 */
export function applyEval(ctx: Context): EvalStartupValues | undefined {
  let resolved: EvalStartupValues | undefined
  const program = evalCommand((values) => { resolved = values })
  parseCmdline(ctx, program)
  return resolved
}
