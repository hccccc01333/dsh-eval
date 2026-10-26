# `dsh-eval`

English | [中文](README.zh.md)

Agent evaluation over headless dsh profiles: a benchmark YAML document, one headless dsh subprocess per case x trial, trace harvesting from persisted session logs, automatic metric folding, and JSON/markdown run reports.

The package is a bundle and a command-line app. Install it into a profile and run benchmarks with:

```sh
dsh plugin --profile eval add dsh-eval
dsh eval run benchmark.yaml
dsh eval report eval-run.json
dsh eval compare eval-v1.json eval-v2.json
```

`dsh eval` is a launcher alias for `--profile eval`; the eval profile composes `dsh-base` plus this bundle. Each trial spawns the benchmark-configured `dsh` command (default `dsh`) against the benchmark-configured profile (default `headless`) with a private temp workspace, an isolated `DSH_HOME`, and a patch overlay forcing plain-JSONL persistence and non-interactive workspace-write/never-approval permissions. The harvested primary session log becomes the trial's trace, and subagent child logs under the trial's `DSH_HOME` are merged into it before the metric fold.

Trials are independent — private temp workspace, isolated `DSH_HOME`, own patch overlay — so `concurrency` runs that many of them at once. The run record still lists results in case-then-trial order whatever the interleaving, and `--concurrency` overrides the document. Raising it trades wall time for peak CPU, memory, and concurrent model quota.

## Benchmark document

```yaml
name: skill-regression
model: deepseek-v4
profile: headless
command: [dsh]
trials: 3
timeoutMs: 600000
seed: 42
cases:
  - id: fix-tests-001
    prompt: Fix the failing tests in this workspace.
    workspace: ./fixtures/fix-tests
    expected:
      tool: bash
      check: ./check.sh
pricing:
  deepseek-v4:
    inputUsdPerMTokens: 0.27
    cacheReadUsdPerMTokens: 0.07
    cacheWriteUsdPerMTokens: 0.27
    outputUsdPerMTokens: 1.10
```

| Field | Default | Meaning |
|---|---|---|
| `name` | required | Benchmark name, also the run record's `benchmark` field. |
| `model` | required | Model id for pricing lookup and run reporting. |
| `profile` | `headless` | dsh profile each trial spawns. |
| `command` | `[dsh]` | dsh launcher argv. |
| `trials` | `1` | Trials per case. |
| `concurrency` | `1` | Case x trial executions allowed in flight at once; `1` keeps the run strictly serial. |
| `timeoutMs` | `600000` | Per-trial timeout; the direct child is killed on expiry. |
| `seed` | `0` | Reserved for future deterministic paired comparisons. |
| `cases[].id` | required | Stable case id. |
| `cases[].prompt` / `cases[].promptFile` | exactly one | Task text, inline or relative to the benchmark file. |
| `cases[].workspace` | absent | Workspace tree copied into each trial, relative or absolute. |
| `cases[].expected` | absent | Scripted grading: `tool` is a substring matched against recorded tool-call names; `check` is a command run in the trial workspace after the agent exits (exit 0 = task success). At least one is required when present. |
| `pricing` | absent | Per-million-token USD prices keyed by model id; absent models report `costUsd: null`. |

### Judge

`judge` enables LLM-judge scoring of final answers and hallucination:

```yaml
judge:
  provider: deepseek
  model: deepseek-v4
  rubric: Prefer correct, concise fixes.
  maxScore: 10
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | `deepseek` | LLM provider route for the judge call. |
| `model` | benchmark `model` | Judge model id. |
| `rubric` | absent | Task rubric appended to the judging prompt. |
| `maxScore` | `10` | Maximum final-answer score. |

The judge builds a strict-JSON prompt from the case and the merged trace. A
trial carries its verdict (`finalAnswerScore`, `hallucination`, `rationale`)
when the reply parses; unusable output or a chat failure reads as null verdict
fields, never as a failed trial. A run with a configured judge fails before
starting when the host exposes no LLM chat seam.

## Metrics

The metric fold computes the automatic metrics directly from the session log: `turns`, `steps`, `toolCalls`, `toolResults`, `toolSuccess` plus `toolSuccessRate`, `invalidToolCalls` (results carrying an internal failure identity), `retries` (`llm/retry`), disjoint token buckets and totals, billed context tokens, `llmMs`/`toolMs`/`ttftMs`/`latencyMs`, and `costUsd` when pricing is configured. Scripted grading adds per-trial `taskSuccess` (check-command exit 0) and `toolSelectionAccuracy` (expected-tool match) and pools them into run-level rates.

Child session logs under the trial's DSH_HOME are merged into the trial trace
before the fold, so delegated subagent work counts toward steps, tokens, tool
calls, retries, and latency. LLM-judge verdicts add per-trial
`finalAnswerScore` and `hallucination` and pool into run-level mean score and
hallucination rate.

## Run report

`dsh eval run --out run.json` writes one JSON document per run: benchmark and model identity, per-trial outcomes with absolute trace paths, aggregate metrics (means for counts and wall times, pooled success rate), and pooled grading rates. `dsh eval report run.json` renders the run as markdown. Trial workspaces and traces stay under the run's `tempRoot` (a private temp directory) and are not deleted; remove them when the run is no longer needed.

## Comparison

`dsh eval compare run-v1.json run-v2.json` renders both runs as a markdown table: benchmark/model identity, completed trials, steps, tool/task/tool-selection rates, invalid calls, retries, tokens, cost, and latency, with signed `B - A` deltas. When both runs complete the same case x trial keys, the table appends paired statistics: trial count, win/lose/tie on the first available metric (task success, tool selection accuracy, or final-answer score), and mean `B - A` deltas for steps, tokens, and judge score. The runs' `seed` is recorded provenance for the pairing, not a guarantee of identical model output.

Because a paired eval sample is small and its deltas are not normal, the paired block also carries inference rather than point estimates alone: an exact two-sided **sign test** over the discordant pairs (ties drop out, as the test requires) for the primary metric, and a seeded **bootstrap 95% interval** beside each mean delta. Nothing is assumed about the shape of the delta distribution, and the PRNG seed is fixed, so re-running `compare` on the same reports prints a byte-identical table. Read those p-values as per-metric and unadjusted for multiple comparisons: with three metrics shown, one p just under 0.05 is weak evidence.

## Replay (keyless CI)

A keyed run records every trial's session log under its `tempRoot`. Copy the
recorded trial trees into a `replay.dir` and rerun without credentials: the
spawned harness mounts `@deepseek-ai/dsh-llm-replay`, which reconstructs each
model stream from the recorded `assistant/chunk` events.

```yaml
replay:
  dir: ./recorded
```

The directory holds one tree per trial named `<caseId>-<trial>/`, with child
logs riding alongside: `recorded/fix-tests-001-1/session.jsonl`. A missing
fixture fails that trial, and `judge` cannot be combined with `replay` in one
run. The npm release of the replay plugin lags the source workspace, so replay
runs require a source-mode harness checkout.

## Importing external traces

`dsh eval import codex|claude-code <session.jsonl> --out run.json` imports a
Codex or Claude Code session log as a one-trial run with folded metrics:

- one synthesized turn (and step) per user message;
- assistant text, tool calls, and tool results mapped into the trace vocabulary;
- token usage is not part of either external format, so token and cost metrics stay zero.

The imported run drops into the same `report`/`compare` pipeline.

## Extension points

The runner is the only consumer today: `runBenchmark` takes a loaded benchmark and returns the run record, and the report module persists and renders it. The judge chat seam is injected by the host (a dsh-llm stream) and stubbed in tests, keeping the suite keyless.

## Model Experience

None, as the benchmark runner reads persisted session logs and spawns headless subprocesses without registering prompt sections, tool schemas, or any other model-facing behavior of its own.

#### KV Cache effect

None; this package neither assembles nor sends a provider request, so no request prefix exists for it to preserve or invalidate.

## Known Limitations and Deferred Work

- **Judge output is best-effort** — a judge chat failure or unparsable reply yields null verdict fields, and judge calls consume model quota outside the trial's measured cost.
- **Paired comparison pairs as-is** — trials pair by case id and trial index; `seed` is recorded provenance, not a deterministic guarantee of identical model output, and per-arm leaderboards are not rendered.
- **Paired inference is unadjusted** — the sign test and bootstrap intervals are per metric, with no correction across the metrics a run prints, and a sign test needs discordant pairs to say anything: a run where every pair ties reports `p = 1`.
- **Replay binds by first-call order** — the replay plugin keys recorded scripts to live sessions by first-call order, so concurrent subagents replay non-deterministically.
- **Imported traces lack token usage** — Codex and Claude Code logs do not record provider usage, so imported runs report zero tokens and no cost.
- **Direct-child timeout only** — a timed-out trial kills the direct dsh process; on Windows its descendants may survive.
- **Windows launcher commands** — the spawned command runs without a shell, so `.cmd`/`.bat` shims need a direct executable or `node <path>` override (`--dsh "node C:/.../apps/cli/lib/bin.js"`).
- **No atomic report write** — the run JSON is written in place; a crash mid-write can truncate the report.
