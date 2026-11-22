/**
 * Benchmark document loading and validation for dsh-eval. YAML parses with
 * js-yaml's safe loader; zod validates the parsed shape; prompt files and
 * workspaces resolve against the benchmark file's directory.
 *
 * @module dsh-eval/benchmark
 */

import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { load } from 'js-yaml'
import { z } from 'zod'
import { hashBenchmarkInputs } from './digest.ts'
import { caseSegment } from './segments.ts'
import type { Benchmark, BenchmarkCase } from './types.ts'

const judgeSchema = z.object({
  provider: z.string().min(1).default('deepseek'),
  model: z.string().min(1).optional(),
  rubric: z.string().min(1).optional(),
  maxScore: z.number().int().positive().default(10),
}).strict()

const replaySchema = z.object({
  dir: z.string().min(1),
}).strict()

const pricingSchema = z.object({
  inputUsdPerMTokens: z.number().nonnegative(),
  cacheReadUsdPerMTokens: z.number().nonnegative(),
  cacheWriteUsdPerMTokens: z.number().nonnegative(),
  outputUsdPerMTokens: z.number().nonnegative(),
}).strict()

/** A non-empty string that the runtime can compile as a Unicode regular expression. */
function regexSchema(message: string) {
  return z.string().min(1).refine((value) => {
    try {
      new RegExp(value, 'u')
      return true
    } catch {
      return false
    }
  }, { message })
}

const toolRegexSchema = regexSchema('toolRegex is not a valid regular expression')
const answerRegexSchema = regexSchema('answerRegex is not a valid regular expression')

const benchmarkCaseSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1).optional(),
  promptFile: z.string().min(1).optional(),
  workspace: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  expected: z.object({
    tool: z.string().min(1).optional(),
    tools: z.array(z.string().min(1)).min(1).readonly().optional(),
    toolAnyOf: z.array(z.string().min(1)).min(1).readonly().optional(),
    toolRegex: toolRegexSchema.optional(),
    toolNot: z.array(z.string().min(1)).min(1).readonly().optional(),
    check: z.string().min(1).optional(),
    checkArgv: z.array(z.string().min(1)).min(1).readonly().optional(),
    checkShell: z.string().min(1).optional(),
    answer: z.string().min(1).optional(),
    answerRegex: answerRegexSchema.optional(),
  }).strict().refine(
    expectation => expectation.tool !== undefined || expectation.tools !== undefined
      || expectation.toolAnyOf !== undefined || expectation.toolRegex !== undefined
      || expectation.toolNot !== undefined || expectation.check !== undefined
      || expectation.checkArgv !== undefined || expectation.checkShell !== undefined
      || expectation.answer !== undefined || expectation.answerRegex !== undefined,
    {
      message: 'expected needs at least one of tool, tools, toolAnyOf, toolRegex, toolNot, check, checkArgv, checkShell, answer or answerRegex',
    },
  ).refine(
    (expectation) => {
      const commands = [expectation.check, expectation.checkArgv, expectation.checkShell]
        .filter(value => value !== undefined)
      return commands.length <= 1
    },
    { message: 'expected accepts at most one of check, checkArgv or checkShell' },
  ).optional(),
}).strict().refine(
  caseValue => (caseValue.prompt === undefined) !== (caseValue.promptFile === undefined),
  { message: 'each case needs exactly one of prompt or promptFile' },
)

const benchmarkSchema = z.object({
  name: z.string().min(1),
  model: z.string().min(1),
  profile: z.string().min(1).default('headless'),
  command: z.array(z.string().min(1)).default(['dsh']),
  trials: z.number().int().positive().default(1),
  concurrency: z.number().int().positive().default(1),
  timeoutMs: z.number().int().positive().default(600_000),
  allowExternalPaths: z.boolean().default(false),
  seed: z.number().int().default(0),
  cases: z.array(benchmarkCaseSchema).min(1),
  pricing: z.record(z.string().min(1), pricingSchema).optional(),
  judge: judgeSchema.optional(),
  replay: replaySchema.optional(),
}).strict().superRefine((parsed, ctx) => {
  // Every trial's private directory is `<caseSegment(id)>-<trial>`. Distinct
  // ids that normalize to one segment (or a plain duplicate) would otherwise
  // share a workspace and DSH_HOME, leaking session logs and metrics across
  // cases. Compare case-insensitively so Windows' case-folding FS is safe too.
  const seen = new Set<string>()
  parsed.cases.forEach((caseValue, index) => {
    const key = caseSegment(caseValue.id).toLowerCase()
    if (seen.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['cases', index, 'id'],
        message: `case id "${caseValue.id}" collides with an earlier case after directory normalization`,
      })
    } else {
      seen.add(key)
    }
  })
})

/**
 * Resolve one parsed case's prompt and workspace against the benchmark
 * directory. Prompt files are read at load time so a run fails before any
 * trial starts.
 * @param parsed - the zod-validated case document.
 * @param baseDir - absolute directory the benchmark file lives in.
 * @returns the resolved runtime case.
 */
/** Resolve a referenced path without letting a third-party benchmark read outside its directory. */
function resolveInputPath(value: string, baseDir: string, allowExternal: boolean, field: string): string {
  const resolved = resolve(baseDir, value)
  if (allowExternal) return resolved
  const rel = relative(baseDir, resolved)
  if (isAbsolute(value) || rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${field} "${value}" escapes the benchmark directory`)
  }
  return resolved
}

async function resolveCase(
  parsed: z.infer<typeof benchmarkCaseSchema>,
  baseDir: string,
  allowExternalPaths: boolean,
): Promise<BenchmarkCase> {
  const prompt = parsed.prompt
    ?? await readFile(resolveInputPath(parsed.promptFile as string, baseDir, allowExternalPaths, 'promptFile'), 'utf8')
  return {
    id: parsed.id,
    prompt,
    ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
    ...(parsed.workspace !== undefined
      ? { workspace: resolveInputPath(parsed.workspace, baseDir, allowExternalPaths, 'workspace') }
      : {}),
    ...(parsed.expected !== undefined
      ? {
        expected: {
          ...(parsed.expected.tool !== undefined ? { tool: parsed.expected.tool } : {}),
          ...(parsed.expected.tools !== undefined ? { tools: parsed.expected.tools } : {}),
          ...(parsed.expected.toolAnyOf !== undefined ? { toolAnyOf: parsed.expected.toolAnyOf } : {}),
          ...(parsed.expected.toolRegex !== undefined ? { toolRegex: parsed.expected.toolRegex } : {}),
          ...(parsed.expected.toolNot !== undefined ? { toolNot: parsed.expected.toolNot } : {}),
          ...(parsed.expected.check !== undefined ? { check: parsed.expected.check } : {}),
          ...(parsed.expected.checkArgv !== undefined ? { checkArgv: parsed.expected.checkArgv } : {}),
          ...(parsed.expected.checkShell !== undefined ? { checkShell: parsed.expected.checkShell } : {}),
          ...(parsed.expected.answer !== undefined ? { answer: parsed.expected.answer } : {}),
          ...(parsed.expected.answerRegex !== undefined ? { answerRegex: parsed.expected.answerRegex } : {}),
        },
      }
      : {}),
  }
}

/**
 * Parse benchmark YAML text into a validated runtime document.
 * @param text - the benchmark document's YAML source.
 * @param baseDir - absolute directory used to resolve prompt and workspace paths.
 * @returns the validated benchmark.
 */
export async function parseBenchmark(text: string, baseDir: string): Promise<Benchmark> {
  const value = load(text)
  if (typeof value !== 'object' || value === null) {
    throw new Error('benchmark document must be a YAML mapping')
  }
  const parsed = benchmarkSchema.parse(value)
  const cases: BenchmarkCase[] = []
  for (const caseValue of parsed.cases) {
    cases.push(await resolveCase(caseValue, baseDir, parsed.allowExternalPaths))
  }
  const pricing = parsed.pricing
  const judge = parsed.judge
  const replay = parsed.replay
  const benchmark: Benchmark = {
    name: parsed.name,
    model: parsed.model,
    profile: parsed.profile,
    command: parsed.command,
    allowExternalPaths: parsed.allowExternalPaths,
    trials: parsed.trials,
    concurrency: parsed.concurrency,
    timeoutMs: parsed.timeoutMs,
    seed: parsed.seed,
    cases,
    ...(pricing !== undefined ? { pricing } : {}),
    ...(judge !== undefined
      ? { judge: { provider: judge.provider, model: judge.model ?? parsed.model, ...(judge.rubric !== undefined ? { rubric: judge.rubric } : {}), maxScore: judge.maxScore } }
      : {}),
    ...(replay !== undefined
      ? { replay: { dir: resolveInputPath(replay.dir, baseDir, parsed.allowExternalPaths, 'replay.dir') } }
      : {}),
    baseDir,
  }
  return { ...benchmark, sourceSha256: await hashBenchmarkInputs(text, benchmark) }
}

/**
 * Load and validate a benchmark document from disk.
 * @param path - path to the benchmark YAML file.
 * @returns the validated benchmark.
 */
export async function loadBenchmark(path: string): Promise<Benchmark> {
  const absolute = resolve(path)
  return parseBenchmark(await readFile(absolute, 'utf8'), dirname(absolute))
}
