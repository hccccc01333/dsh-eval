/**
 * Benchmark document loading and validation for dsh-eval. YAML parses with
 * js-yaml's safe loader; zod validates the parsed shape; prompt files and
 * workspaces resolve against the benchmark file's directory.
 *
 * @module @deepseek-ai/dsh-eval/benchmark
 */

import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { load } from 'js-yaml'
import { z } from 'zod'
import type { Benchmark, BenchmarkCase } from './types.ts'

const pricingSchema = z.object({
  inputUsdPerMTokens: z.number().nonnegative(),
  cacheReadUsdPerMTokens: z.number().nonnegative(),
  cacheWriteUsdPerMTokens: z.number().nonnegative(),
  outputUsdPerMTokens: z.number().nonnegative(),
}).strict()

const benchmarkCaseSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1).optional(),
  promptFile: z.string().min(1).optional(),
  workspace: z.string().min(1).optional(),
  expected: z.object({
    tool: z.string().min(1).optional(),
    check: z.string().min(1).optional(),
  }).strict().refine(
    expectation => expectation.tool !== undefined || expectation.check !== undefined,
    { message: 'expected needs at least one of tool or check' },
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
  timeoutMs: z.number().int().positive().default(600_000),
  seed: z.number().int().default(0),
  cases: z.array(benchmarkCaseSchema).min(1),
  pricing: z.record(z.string().min(1), pricingSchema).optional(),
}).strict()

/**
 * Resolve one parsed case's prompt and workspace against the benchmark
 * directory. Prompt files are read at load time so a run fails before any
 * trial starts.
 * @param parsed - the zod-validated case document.
 * @param baseDir - absolute directory the benchmark file lives in.
 * @returns the resolved runtime case.
 */
async function resolveCase(
  parsed: z.infer<typeof benchmarkCaseSchema>,
  baseDir: string,
): Promise<BenchmarkCase> {
  const prompt = parsed.prompt
    ?? await readFile(resolve(baseDir, parsed.promptFile as string), 'utf8')
  return {
    id: parsed.id,
    prompt,
    ...(parsed.workspace !== undefined
      ? { workspace: isAbsolute(parsed.workspace) ? parsed.workspace : resolve(baseDir, parsed.workspace) }
      : {}),
    ...(parsed.expected !== undefined
      ? {
        expected: {
          ...(parsed.expected.tool !== undefined ? { tool: parsed.expected.tool } : {}),
          ...(parsed.expected.check !== undefined ? { check: parsed.expected.check } : {}),
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
    cases.push(await resolveCase(caseValue, baseDir))
  }
  const pricing = parsed.pricing
  return {
    name: parsed.name,
    model: parsed.model,
    profile: parsed.profile,
    command: parsed.command,
    trials: parsed.trials,
    timeoutMs: parsed.timeoutMs,
    seed: parsed.seed,
    cases,
    ...(pricing !== undefined ? { pricing } : {}),
    baseDir,
  }
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
