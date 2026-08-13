/**
 * Pure types of the dsh-eval domain: benchmark configuration, harvested
 * traces, per-trial metrics, and the persisted run record. This file contains
 * no runtime code.
 *
 * @module @deepseek-ai/dsh-eval/types
 */

import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

/** One model arm's per-million-token pricing, in USD. */
export interface BenchmarkPricing {
  /** Billed uncached input tokens. */
  inputUsdPerMTokens: number
  /** Billed cache-read input tokens. */
  cacheReadUsdPerMTokens: number
  /** Billed cache-write input tokens. */
  cacheWriteUsdPerMTokens: number
  /** Billed output tokens. */
  outputUsdPerMTokens: number
}

/** One benchmark task: a prompt and an optional workspace copied per trial. */
export interface BenchmarkCase {
  /** Stable case id, used in run output and trial directory names. */
  id: string
  /** The task text handed to the headless agent. */
  prompt: string
  /** Absolute path to a workspace tree copied into each trial, when provided. */
  workspace?: string
  /** Scripted grading annotations, when the case is graded. */
  expected?: BenchmarkExpectation
}

/** Expected-tool and check-command annotations for scripted grading. */
export interface BenchmarkExpectation {
  /** Substring matched against every recorded tool call name. */
  tool?: string
  /** Command run in the trial workspace after the agent exits; exit 0 means task success. */
  check?: string
}

/** A validated benchmark document. */
export interface Benchmark {
  /** Benchmark name; also the run record's `benchmark` field. */
  name: string
  /** Model id used for pricing lookup and reported per run. */
  model: string
  /** dsh profile spawned per trial; defaults to `headless`. */
  profile: string
  /** Command that launches dsh, as argv. */
  command: readonly string[]
  /** Trials per case. */
  trials: number
  /** Per-trial timeout in milliseconds. */
  timeoutMs: number
  /** Reserved deterministic seed for future paired comparisons. */
  seed: number
  /** The benchmark's cases, in order. */
  cases: readonly BenchmarkCase[]
  /** Pricing keyed by model id; an absent model reports `costUsd: null`. */
  pricing?: Readonly<Record<string, BenchmarkPricing>>
  /** Directory the benchmark document was loaded from; relative paths resolve against it. */
  baseDir: string
}

/**
 * One harvested session log. v0.1 carries the durable dsh session event
 * vocabulary directly; neutral importers for other harness formats are
 * deferred to the comparison milestone.
 */
export interface EvalTrace {
  /** Session id from the persisted log header. */
  sessionId: SessionId
  /** Session creation time from the persisted log header, epoch milliseconds. */
  createdAt: number
  /** Durable events in log order. */
  events: readonly SessionEvent[]
}

/** Disjoint provider-reported token buckets over one run. */
export interface EvalTokenUsage {
  /** Uncached input tokens. */
  inputTokens: number
  /** Cache-read input tokens. */
  cacheReadTokens: number
  /** Cache-write input tokens. */
  cacheWriteTokens: number
  /** Output tokens. */
  outputTokens: number
}

/** Automatic metrics folded from one session trace. */
export interface EvalCaseMetrics {
  /** Distinct turns carrying at least one closed step. */
  turns: number
  /** Closed `step/end` events, completed and failed alike. */
  steps: number
  /** Recorded `tool/call` events. */
  toolCalls: number
  /** Recorded `tool/result` events. */
  toolResults: number
  /** Results whose model-facing `isError` flag is false. */
  toolSuccess: number
  /** `toolSuccess / toolResults`, or null when no result landed. */
  toolSuccessRate: number | null
  /** Results carrying an internal failure identity (`tool/result.error`). */
  invalidToolCalls: number
  /** Durable `llm/retry` decisions. */
  retries: number
  /** Summed provider usage buckets. */
  tokens: EvalTokenUsage
  /** Sum of all four token buckets. */
  totalTokens: number
  /** Billed input (`input + cacheRead + cacheWrite`). */
  contextTokens: number
  /** Summed model wall time, `step/start` to `assistant/message`, milliseconds. */
  llmMs: number
  /** Summed tool wall time over matched `tool/call` to `tool/result`, milliseconds. */
  toolMs: number
  /** Summed first-token latency, `step/start` to the first token delta, milliseconds. */
  ttftMs: number
  /** Wall time from the first to the last recorded event, milliseconds. */
  latencyMs: number
  /** Estimated USD cost from the benchmark pricing table, or null without one. */
  costUsd: number | null
}

/** Outcome of one case x trial. */
export interface EvalTrialResult {
  /** Benchmark case id. */
  caseId: string
  /** 1-based trial index. */
  trial: number
  /** `completed` when a persisted trace was harvested; `error` otherwise. */
  status: 'completed' | 'error'
  /** Human-readable failure detail for `error` trials. */
  error?: string
  /** Absolute path of the harvested primary session log. */
  tracePath?: string
  /** The child process's exit code, or null when it was killed. */
  exitCode: number | null
  /** Whether the trial hit its timeout and killed the child. */
  timedOut: boolean
  /** Folded metrics for `completed` trials. */
  metrics?: EvalCaseMetrics
  /** Scripted grading outcome for `completed` trials with expectations. */
  grade?: EvalGrade
}

/** Scripted grading outcome for one trial. */
export interface EvalGrade {
  /** Whether the check command exited 0, or null when no check is configured. */
  taskSuccess: boolean | null
  /** Whether an expected tool was called, or null when no tool is configured. */
  toolSelectionAccuracy: boolean | null
}

/** Pooled grading rates over completed trials. */
export interface EvalRunGrading {
  /** Pooled task-success rate, or null when no trial carried a check. */
  taskSuccessRate: number | null
  /** Pooled tool-selection-accuracy rate, or null when no trial carried an expected tool. */
  toolSelectionAccuracyRate: number | null
}

/** A persisted eval run. */
export interface EvalRun {
  /** Benchmark name. */
  benchmark: string
  /** Model id the benchmark targeted. */
  model: string
  /** Run creation time, epoch milliseconds. */
  createdAt: number
  /** Trials per case actually executed. */
  trials: number
  /** Benchmark seed. */
  seed: number
  /** Resolved pricing for the benchmark model, or null without one. */
  pricing: BenchmarkPricing | null
  /** Root holding every trial's workspace, overlay, and harvested trace. */
  tempRoot: string
  /** Per-trial outcomes in execution order. */
  cases: readonly EvalTrialResult[]
  /** Mean/pooled metrics over completed trials, or null when none completed. */
  aggregate: EvalCaseMetrics | null
  /** Pooled scripted-grading rates over completed trials, or null when ungraded. */
  grading: EvalRunGrading | null
}
