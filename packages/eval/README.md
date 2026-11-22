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
| `seed` | `0` | Base seed: trial n receives `DSH_EVAL_SEED=seed+n-1` in its environment, and the value also seeds report bootstraps. A harness must read that variable for deterministic sampling. |
| `cases[].id` | required | Stable case id. |
| `cases[].prompt` / `cases[].promptFile` | exactly one | Task text, inline or relative to the benchmark file. |
| `cases[].workspace` | absent | Workspace tree copied into each trial, relative or absolute. |
| `cases[].expected` | absent | Scripted grading: `tool` (legacy substring), `tools` (all listed substrings), `toolAnyOf` (at least one), `toolRegex` (validated at load) and `toolNot` (none) all combine against recorded tool-call names; `checkArgv` (preferred), `check` (legacy string, quotes supported), or `checkShell` (explicit opt-in, pipes/redirection) runs in the trial workspace after the agent exits (exit 0 = task success); `answer` is a gold answer passed to the judge. At least one field is required, and at most one check mode. Check processes are detached and killed as a group at the trial timeout. |
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

When a case sets `expected.answer`, the judge receives it as the reference answer and is instructed to score factual agreement with it rather than fluency. If a judge call fails or returns an unusable reply, the verdict carries `judgeError` and the run's `grading.judgeFailures` counts it; the report prints the count instead of silently dropping the score from the mean.

The judge builds a strict-JSON prompt from the case and the merged trace. A
trial carries its verdict (`finalAnswerScore`, `hallucination`, `rationale`)
when the reply parses; unusable output or a chat failure reads as null verdict
fields, never as a failed trial. A run with a configured judge fails before
starting when the host exposes no LLM chat seam.

## Metrics

The metric fold computes the automatic metrics directly from the session log: `turns`, `steps`, `toolCalls`, `toolResults`, `toolSuccess` plus `toolSuccessRate`, `invalidToolCalls` (results carrying an internal failure identity), `retries` (`llm/retry`), disjoint token buckets and totals, billed context tokens, `llmMs`/`toolMs`/`ttftMs`/`latencyMs`, and `costUsd` when pricing is configured. Scripted grading adds per-trial `taskSuccess` (check-command exit 0) and `toolSelectionAccuracy` (all configured tool constraints hold) and pools them into run-level rates. `checkArgv` avoids shell interpretation entirely; `checkShell` is for trusted benchmark files that need pipes or redirection. A hung check is terminated with its whole process group at the trial timeout, so one bad verifier cannot stall a run.

Child session logs under the trial's DSH_HOME are merged into the trial trace
before the fold, so delegated subagent work counts toward steps, tokens, tool
calls, retries, and latency. LLM-judge verdicts add per-trial
`finalAnswerScore` and `hallucination` and pool into run-level mean score and
hallucination rate.

## Run report

`dsh eval run benchmark.yaml --out run.json` writes one JSON document per run: benchmark and model identity, per-trial outcomes with absolute trace paths, aggregate metrics (means for counts and wall times, pooled success rate), and pooled grading rates. `dsh eval report run.json` renders the run as markdown. Trial workspaces and traces stay under the run's `tempRoot` (a private temp directory) and are not deleted; remove them when the run is no longer needed.

The markdown report appends a **Reliability** block for each graded dimension (task success and tool-selection accuracy). A pooled rate cannot tell a benchmark where every case is 66% stable from one where two cases always pass and a third always fails; the block therefore reports `pass@1` (trial-level), `pass@k` (cases with at least one pass), and `pass^k` (cases that pass every trial), plus the flaky cases whose trials disagreed and the hardest cases by pass rate. The header also shows trial coverage (`completed / total`, unscored, timeouts) and the Reliability block prints **strict pass@1** beside the graded-only figure: an error or timeout stays in the denominator, so a model that times out on hard cases cannot outrank one that finishes and fails. All of it is computed from the stored trials at render time, so reports written before this feature gain the new view without being regenerated. `dsh eval run` exits nonzero if *any* trial fails, not only when every trial does.

`dsh eval report run.json --brief` prints a compact terminal summary instead: trial coverage, per-trial tool/step/token/cost figures, the task rate with pass@k/pass^k, the bootstrap interval, and the judge-failure count. The per-trial table is omitted so a hundred-trial run still fits on one screen.

`dsh eval dashboard a.json [b.json] --out report.html` writes a standalone HTML view:
summary cards for coverage, pass@1/pass@k, latency p95 and cost, followed by
reliability, precision, judge/script agreement and a per-trial table. It has no
external CSS, fonts or scripts, respects the OS light/dark preference, and
HTML-escapes benchmark ids, case ids and error strings — an agent-produced
error message cannot inject markup into the page. Supplying a second run adds a
comparison table built from the same rows as `dsh eval compare`, including
signed `B − A` deltas and the Bonferroni-corrected paired inference rows.

A **Precision** block follows Reliability in the full report. It bootstraps the observed task/tool rates over the graded trials with the run's `seed` (2000 seeded resamples by default), printing a 95% percentile interval beside each rate and a `n=` count. A single trial reports the rate without an interval, since no resample can create uncertainty from one observation. The block also prints latency `p50/p95` from the trial metrics. This makes a three-trial smoke run look like the weak evidence it is instead of a precise-looking percentage.

The **Judge / script agreement** block pairs scripted `taskSuccess` with the
judge's "no hallucination" verdict on trials carrying both. It prints observed
agreement and Cohen's kappa, which subtracts the agreement expected from the two
marginals — an LLM judge that passes everything can otherwise look impressive
when the scripted checks pass everything too. Trials with an unusable verdict or
no check are excluded, and the block is omitted when no trial has both signals.
The same one-line statistic appears in `--brief` output.

## Comparison

`dsh eval compare run-v1.json run-v2.json` renders both runs as a markdown table: benchmark/model identity, completed trials, steps, tool/task/tool-selection rates, pass@k and pass^k for both grading dimensions, invalid calls, retries, tokens, cost, and latency, with signed `B - A` deltas. When both runs complete the same case x trial keys, the table appends paired statistics: trial count, win/lose/tie on the first available metric (task success, tool selection accuracy, or final-answer score), and mean `B - A` deltas for steps, tokens, and judge score. Each run's `seed` is both recorded provenance and injected into every trial as `DSH_EVAL_SEED`; determinism still depends on the harness reading that variable.

Because a paired eval sample is small and its deltas are not normal, the paired block also carries inference rather than point estimates alone: an exact two-sided **sign test** over the discordant pairs (ties drop out, as the test requires) for the primary metric, and a seeded **bootstrap interval** beside each mean delta. Nothing is assumed about the shape of the delta distribution, and the PRNG seed is fixed, so re-running `compare` on the same reports prints a byte-identical table. The sign-test p-value and every printed interval form one inference family, corrected together by **Bonferroni** at family-wise `alpha = 0.05`: the p row is labelled with the family size it was multiplied by, and each interval is widened to `1 - 0.05/k` confidence (for example, 98.8% when the p-value and three intervals are all present). A sign test still needs discordant pairs to say anything — when every pair ties it reports `p = 1`.

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
runs require a source-mode harness checkout. Trace paths are re-read from the
report during re-judging and must be absolute `.jsonl` files inside `tempRoot`,
so an edited report cannot make the judge ship an arbitrary local file to an
LLM.

## Offline re-judging

Because `judge` and `replay` cannot share a run, judge a recorded run in a
second phase:

```sh
dsh eval rejudge recorded-run.json --out judged-run.json
```

`rejudge` loads the run's harvested traces and its persisted `caseInputs`,
rebuilds each verdict through the injected judge seam, and re-aggregates the
grading summary. Metrics, scripted grades, trial outcomes, and error details are
untouched; only `judge` verdicts and `grading` change. The input report is never
overwritten (`--out` must differ). Reports written before `caseInputs` existed
are rejected with a field-specific diagnostic rather than silently judged with
an empty prompt.

A judge can be supplied or replaced at re-judge time, which is what makes the
replay workflow usable (a replay run has no stored judge config):

```sh
dsh eval rejudge recorded-run.json --out judged.json \
  --judge-model deepseek-v4 --judge-provider deepseek \
  --judge-rubric "Prefer concise, correct fixes." --judge-max-score 10
```

Only `--judge-model` is required to override; the other flags default to
`deepseek`, `10`, and no rubric. The effective config is written into the new
report. If a judge call fails, an already usable verdict is kept with a
`judgeError` marker instead of being erased by an outage.

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

- **Judge output is best-effort but no longer silent** — a failed or unparsable verdict carries `judgeError` and is counted in `grading.judgeFailures`; judge calls consume model quota outside the trial's measured cost.
- **Paired comparison pairs as-is** — trials pair by case id and trial index; `seed` is passed to each trial as `DSH_EVAL_SEED` and recorded as provenance, but determinism depends on the harness honoring it; per-arm leaderboards are not rendered.
- **Bonferroni is conservative** — it controls the family-wise error rate across the printed sign test and intervals without assuming independence, at the cost of wider intervals; a sign test also needs discordant pairs to say anything, so a run where every pair ties reports `p = 1`.
- **Replay binds by first-call order** — the replay plugin keys recorded scripts to live sessions by first-call order, so concurrent subagents replay non-deterministically.
- **Imported traces lack token usage** — Codex and Claude Code logs do not record provider usage, so imported runs report zero tokens and no cost.
- **Direct-child timeout only** — a timed-out trial kills the direct dsh process; on Windows its descendants may survive.
- **Windows launcher commands** — the spawned command runs without a shell, so `.cmd`/`.bat` shims need a direct executable or `node <path>` override (`--dsh "node C:/.../apps/cli/lib/bin.js"`).
- **No atomic report write** — the run JSON is written in place; a crash mid-write can truncate the report.
