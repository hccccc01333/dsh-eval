/**
 * Pure types of the dsh-eval domain: benchmark configuration, harvested
 * traces, per-trial metrics, and the persisted run record. This file contains
 * no runtime code.
 *
 * @module dsh-eval/types
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
  /** Legacy substring matched against every recorded tool call name. */
  tool?: string
  /** Every listed substring must appear in at least one tool call name. */
  tools?: readonly string[]
  /** At least one listed substring must appear in a tool call name. */
  toolAnyOf?: readonly string[]
  /** A validated regular expression that must match at least one tool call name. */
  toolRegex?: string
  /** None of the listed substrings may appear in any tool call name. */
  toolNot?: readonly string[]
  /** Legacy command string split on whitespace (and quotes) into argv; exit 0 means task success. */
  check?: string
  /** Preferred structured argv for a check command; no shell interpretation. */
  checkArgv?: readonly string[]
  /** Opt-in shell command for checks needing pipes/redirection; benchmark files must be trusted. */
  checkShell?: string
  /** Known-correct final answer handed to the LLM judge, when the task has one. */
  answer?: string
  /** Regex the final assistant answer must match; sets task success when no check command is configured. */
  answerRegex?: string
}

/** LLM-judge configuration: scores final answers and flags hallucinations. */
export interface BenchmarkJudge {
  /** Provider route for the judge call, e.g. `deepseek`. */
  provider: string
  /** Judge model id; defaults to the benchmark model when unset. */
  model: string
  /** Optional task rubric appended to the default judging instructions. */
  rubric?: string
  /** Maximum final-answer score; defaults to 10. */
  maxScore: number
}

/** Keyless replay configuration: recorded session logs replayed instead of live model calls. */
export interface BenchmarkReplay {
  /**
   * Directory holding one recorded-log tree per trial, named
   * `<caseId>-<trial>/session.jsonl` (child logs ride alongside). A run with
   * a key records these under its `tempRoot`.
   */
  dir: string
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
  /** Case x trial executions allowed in flight at once; defaults to 1 (serial). */
  concurrency: number
  /** Per-trial timeout in milliseconds. */
  timeoutMs: number
  /** Deterministic seed; trial n receives `DSH_EVAL_SEED = seed + n - 1`. */
  seed: number
  /** The benchmark's cases, in order. */
  cases: readonly BenchmarkCase[]
  /** Pricing keyed by model id; an absent model reports `costUsd: null`. */
  pricing?: Readonly<Record<string, BenchmarkPricing>>
  /** LLM-judge configuration, when final-answer scoring is enabled. */
  judge?: BenchmarkJudge
  /** Keyless replay configuration, when model calls replay from recorded logs. */
  replay?: BenchmarkReplay
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
  /** Absolute paths of every harvested session log, primary first. */
  tracePaths?: readonly string[]
  /** SHA-256 of the merged trace; lets offline re-judging detect altered logs. */
  traceSha256?: string
  /** The child process's exit code, or null when it was killed. */
  exitCode: number | null
  /** Whether the trial hit its timeout and killed the child. */
  timedOut: boolean
  /** Folded metrics for `completed` trials. */
  metrics?: EvalCaseMetrics
  /** Scripted grading outcome for `completed` trials with expectations. */
  grade?: EvalGrade
  /** LLM-judge verdict for `completed` trials with a configured judge. */
  judge?: EvalJudgeVerdict
}

/** Scripted grading outcome for one trial. */
export interface EvalGrade {
  /** Whether the check command exited 0 or the answer regex matched; null when neither is configured. */
  taskSuccess: boolean | null
  /** Whether an expected tool was called, or null when no tool is configured. */
  toolSelectionAccuracy: boolean | null
}

/** LLM-judge verdict for one trial. */
export interface EvalJudgeVerdict {
  /** Final-answer score within the benchmark's `maxScore`, or null when the judge output was unusable. */
  finalAnswerScore: number | null
  /** Whether the judge flagged hallucinated content, or null when the judge output was unusable. */
  hallucination: boolean | null
  /** Judge rationale, when the model returned one. */
  rationale?: string
  /** Why this verdict is unusable — a failed call or an unparsable reply. */
  judgeError?: string
}

/** Pooled grading rates over completed trials. */
export interface EvalRunGrading {
  /** Pooled task-success rate, or null when no trial carried a check or answer regex. */
  taskSuccessRate: number | null
  /** Pooled tool-selection-accuracy rate, or null when no trial carried an expected tool. */
  toolSelectionAccuracyRate: number | null
  /** Mean final-answer score over judged trials, or null when nothing was judged. */
  finalAnswerScore: number | null
  /** Pooled hallucination rate over judged trials, or null when nothing was judged. */
  hallucinationRate: number | null
  /** Judge calls that failed or returned unusable output, when a judge was configured. */
  judgeFailures?: number
}

/** Minimal case input needed to re-judge a stored trial without the benchmark file. */
export interface EvalCaseInput {
  /** Case id matching the trial results. */
  caseId: string
  /** Task text handed to the agent and the judge. */
  prompt: string
  /** Gold answer handed to the judge, when the case had one. */
  answer?: string
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
  /** Benchmark seed; also the base for per-trial `DSH_EVAL_SEED` values. */
  seed: number
  /** Resolved pricing for the benchmark model, or null without one. */
  pricing: BenchmarkPricing | null
  /** The judge configuration the run used, when one was configured. */
  judge?: BenchmarkJudge
  /** Root holding every trial's workspace, overlay, and harvested trace. */
  tempRoot: string
  /** Per-trial outcomes in execution order. */
  cases: readonly EvalTrialResult[]
  /** Case prompts and gold answers, so a stored run can be re-judged. */
  caseInputs?: readonly EvalCaseInput[]
  /** Mean/pooled metrics over completed trials, or null when none completed. */
  aggregate: EvalCaseMetrics | null
  /** Pooled scripted-grading rates over completed trials, or null when ungraded. */
  grading: EvalRunGrading | null
}
