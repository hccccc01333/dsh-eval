# `@deepseek-ai/dsh-eval`

English | [中文](README.zh.md)

Agent evaluation over headless dsh profiles: a benchmark YAML document, one headless dsh subprocess per case x trial, trace harvesting from persisted session logs, automatic metric folding, and JSON/markdown run reports.

The package is a bundle and a command-line app. Install it into a profile and run benchmarks with:

```sh
dsh plugin --profile eval add @deepseek-ai/dsh-eval
dsh eval run benchmark.yaml
dsh eval report eval-run.json
dsh eval compare eval-v1.json eval-v2.json
```

`dsh eval` is a launcher alias for `--profile eval`; the eval profile composes `dsh-base` plus this bundle. Each trial spawns the benchmark-configured `dsh` command (default `dsh`) against the benchmark-configured profile (default `headless`) with a private temp workspace, an isolated `DSH_HOME`, and a patch overlay forcing plain-JSONL persistence and non-interactive workspace-write/never-approval permissions. The harvested primary session log becomes the trial's trace; subagent child logs are not yet included.

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
| `timeoutMs` | `600000` | Per-trial timeout; the direct child is killed on expiry. |
| `seed` | `0` | Reserved for future deterministic paired comparisons. |
| `cases[].id` | required | Stable case id. |
| `cases[].prompt` / `cases[].promptFile` | exactly one | Task text, inline or relative to the benchmark file. |
| `cases[].workspace` | absent | Workspace tree copied into each trial, relative or absolute. |
| `cases[].expected` | absent | Scripted grading: `tool` is a substring matched against recorded tool-call names; `check` is a command run in the trial workspace after the agent exits (exit 0 = task success). At least one is required when present. |
| `pricing` | absent | Per-million-token USD prices keyed by model id; absent models report `costUsd: null`. |

## Metrics

The metric fold computes the automatic metrics directly from the session log: `turns`, `steps`, `toolCalls`, `toolResults`, `toolSuccess` plus `toolSuccessRate`, `invalidToolCalls` (results carrying an internal failure identity), `retries` (`llm/retry`), disjoint token buckets and totals, billed context tokens, `llmMs`/`toolMs`/`ttftMs`/`latencyMs`, and `costUsd` when pricing is configured. Scripted grading adds per-trial `taskSuccess` (check-command exit 0) and `toolSelectionAccuracy` (expected-tool match) and pools them into run-level rates. LLM-judge metrics (final-answer score, hallucination) are deferred.

## Run report

`dsh eval run --out run.json` writes one JSON document per run: benchmark and model identity, per-trial outcomes with absolute trace paths, aggregate metrics (means for counts and wall times, pooled success rate), and pooled grading rates. `dsh eval report run.json` renders the run as markdown. Trial workspaces and traces stay under the run's `tempRoot` (a private temp directory) and are not deleted; remove them when the run is no longer needed.

## Comparison

`dsh eval compare run-v1.json run-v2.json` renders both runs as a markdown table: benchmark/model identity, completed trials, steps, tool/task/tool-selection rates, invalid calls, retries, tokens, cost, and latency, with signed `B - A` deltas. Comparison is read-only over persisted runs; paired same-seed trials remain deferred.

## Extension points

The runner is the only consumer today: `runBenchmark` takes a loaded benchmark and returns the run record, and the report module persists and renders it. Grader and comparison seams are deliberately deferred until a second consumer exists.

## Model Experience

None, as the benchmark runner reads persisted session logs and spawns headless subprocesses without registering prompt sections, tool schemas, or any other model-facing behavior of its own.

#### KV Cache effect

None; this package neither assembles nor sends a provider request, so no request prefix exists for it to preserve or invalidate.

## Known Limitations and Deferred Work

- **LLM-judge metrics are deferred** — final-answer score and hallucination need an LLM judge provider; scripted task success and tool-selection accuracy are implemented.
- **Paired comparison is deferred** — `dsh eval compare` compares persisted runs as-is; `seed` is validated but not yet used for deterministic paired trials, and per-arm leaderboards are not rendered.
- **Primary session only** — child subagent logs under `session.<n>.jsonl` are not harvested; aggregate numbers omit delegated work.
- **Replay mode is deferred** — real runs need the model credentials the spawned harness resolves; llm-replay wiring for keyless CI is a later step.
- **Direct-child timeout only** — a timed-out trial kills the direct dsh process; on Windows its descendants may survive.
- **Windows launcher commands** — the spawned command runs without a shell, so `.cmd`/`.bat` shims need a direct executable or `node <path>` override (`--dsh "node C:/.../apps/cli/lib/bin.js"`).
- **No atomic report write** — the run JSON is written in place; a crash mid-write can truncate the report.
