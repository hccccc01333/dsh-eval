# dsh-eval

English | [中文](README.zh.md)

**Agent Evaluation Platform for [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).**

[![npm version](https://img.shields.io/npm/v/dsh-eval)](https://www.npmjs.com/package/dsh-eval)
[![CI](https://github.com/hccccc01333/dsh-eval/actions/workflows/ci.yml/badge.svg)](https://github.com/hccccc01333/dsh-eval/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/hccccc01333/dsh-eval)](LICENSE)

![dsh-eval — evidence-grade agent evaluation](https://raw.githubusercontent.com/hccccc01333/dsh-eval/master/assets/hero.png)

Run benchmarks against headless `dsh` profiles, harvest persisted session logs as traces, fold automatic metrics, grade task success and tool selection, and report or compare runs — one `benchmark.yaml` in, one JSON run + Markdown report out.

> **Why this exists:** an accuracy number without its uncertainty, paired evidence and provenance is a guess. dsh-eval makes every claim in a report auditable down to the trial, the prompt and the benchmark file hash.

> The dsh ecosystem already has observability and debugging tools (`dsh-trace`, `dsh-tps`, `dsh-context-doctor`). dsh-eval fills the missing slot: **an evaluation platform**.

## Highlights

- `dsh eval run benchmark.yaml` — orchestrate one headless `dsh` subprocess per case × trial
- Trace harvesting from persisted session logs (everything a model sees is reconstructable from the log)
- Automatic metrics: task success, tool success, tool-selection accuracy, steps, tokens, latency, cost, retry, invalid tool calls, context usage
- Scripted grading: tool constraints (`tool`/`tools`/`toolAnyOf`/`toolRegex`/`toolNot`), check commands (`check`/`checkArgv`/`checkShell`), and `answerRegex` final-answer checks without an LLM judge
- LLM judge: final-answer score and hallucination flags, with optional gold answers and visible judge failures
- Subagent trace merging: child session logs fold into the trial metrics
- Paired A/B: same-case win/lose/tie statistics across two runs
- Paired inference: exact sign test with power/MDE floor, seeded bootstrap intervals on every mean delta, Bonferroni-corrected across the printed family, plus per-case significance to locate confirmed regressions
- Reliability: per-case pass@1 / pass@k / pass^k, flaky-case detection, hardest-case ranking, and a strict rate that keeps timed-out/error trials in the denominator
- Precision: seeded bootstrap intervals for single-run rates (including strict pass@1 over all trials) plus latency p50/p95, so small runs show their uncertainty
- Agreement: judge/script concordance and Cohen's kappa, so a proxy judge can be checked against real checks
- Parallel trials: `concurrency` / `--concurrency` runs several case × trial executions at once, results still ordered
- Keyless replay: record once with a key, replay in CI from recorded logs
- Cross-harness import: `dsh eval import codex|claude-code <log> --out run.json`
- `dsh eval report run.json` — Markdown report with per-trial scores, pooled rates, reliability and precision blocks; `--brief` prints a compact terminal summary, `--json` emits all derived blocks as structured data
- `dsh eval export run.json [--out trials.csv]` — flat trial-level CSV for spreadsheets and notebooks, with formula injection and quoting safely escaped
- `dsh eval dashboard a.json [b.json ...] --out report.html` — standalone dark-mode-aware HTML dashboard: one run, two-run comparison (paired inference and confirmed case changes), or a leaderboard for three or more (`--metric strictPassAt1` supported, including the paired verdict against the leader), no external assets
- `dsh eval validate benchmark.yaml [--json]` — preflight a benchmark and warn about weak evidence before spending tokens
- `dsh eval provenance run.json benchmark.yaml [--json]` — verify the stored benchmark digest against the current YAML, prompts, workspaces and replay inputs; a mismatch or missing digest exits 1
- `dsh eval leaderboard a.json b.json c.json` — rank any number of runs by task success with gap-to-leader and a Bonferroni-corrected paired verdict against the leader; `--metric strictPassAt1` ranks by the error-inclusive rate instead, and `--json` supports automation
- `dsh eval gate candidate.json --baseline base.json --max-drop 0.05 [--max-segment-drop 0.02] [--require-significance] [--json]` — CI quality and resource-budget gate; significance mode only fails on statistically confirmed regressions, and `--max-segment-drop` catches a regression concentrated in one case tag even when the pooled rate is flat
- `dsh eval compare v1.json v2.json` — signed `B - A` table plus paired inference; `--json` for structured output
- `dsh eval rejudge run.json --out rejudged.json` — re-judge stored traces with a new judge model or rubric, without re-running the agent; a recorded SHA-256 trace digest rejects tampered logs
- `dsh eval reproduce run.json benchmark.yaml --out replay.json` — replay a recorded run with its seed and overrides, refuse a changed benchmark digest, and print before/after completion and success rates; `--json` emits the comparison for automation
- `dsh eval segments base.json candidate.json` — per-tag deltas for task success and judge score across two runs; `--json` and `--out` supported

## Why dsh-eval instead of an ad-hoc script

| Concern | Ad-hoc loop | dsh-eval |
|---|---|---|
| A model times out | Dropped from the average | Counted in strict pass@1 |
| "Model B is better" | One pooled number | Paired sign test, power floor, bootstrap intervals |
| Many cases compared | P-hacking by cherry-picking | Bonferroni-corrected per-case evidence |
| Different config, same report | Easy to mislabel | Digest folds YAML, prompts, workspaces and CLI overrides |
| CI regression check | Brittle threshold | Hard budgets + optional significance gate |
| Judge quality | Assumed reliable | Agreement, kappa, separation, ranking accuracy, Brier |
| Share results | Screenshots of a terminal | Self-contained HTML, JSON, CSV |

## What it looks like

### Standalone HTML dashboard

![Standalone dashboard with summary cards, paired comparison, confirmed case changes and calibration](https://raw.githubusercontent.com/hccccc01333/dsh-eval/master/assets/dashboard.png)

`dsh eval dashboard a.json b.json --out report.html` produces one self-contained file: no CDN, no runtime fetch, no external CSS. The two-run view pairs trials by `caseId`, shows bootstrap intervals, and highlights only the case changes that survive Bonferroni correction.

### Multi-run leaderboard

![Leaderboard ranked by strict pass@1 with paired verdicts against the leader](https://raw.githubusercontent.com/hccccc01333/dsh-eval/master/assets/leaderboard.png)

With three or more runs, the same dashboard becomes a leaderboard. `--metric strictPassAt1` ranks by the error-inclusive rate so a model that times out on hard cases cannot win on a survivor-only average; the last column reports the family-corrected paired verdict against the leader.

### CI gate and terminal output

![CLI progress lines and a passing CI gate with confirmed case regressions](https://raw.githubusercontent.com/hccccc01333/dsh-eval/master/assets/cli.png)

Progress lines are bounded and control-character safe, every command refuses an `--out` path that names one of its inputs, and `dsh eval gate` turns a comparison into a PASS/FAIL build step with hard resource budgets. In significance mode a confirmed case regression also fails the gate, so a green build never advertises a known regression.

## Status

`dsh-eval@0.5.17` · 444 tests · 100% statement/branch/function/line coverage on `src` · typecheck clean · CI on Linux and Windows.

Installable since `0.3.1`: the `0.3.0` tarball omitted the runtime modules its entry imports, so every install failed with `ERR_MODULE_NOT_FOUND`. See [CHANGELOG.md](CHANGELOG.md).

## Quick start

Install the package directly:

```sh
pnpm add dsh-eval
dsh plugin --profile eval add dsh-eval
```

The npm package targets the official `@deepseek-ai/*` releases (`0.1.0-rc.6` peers), and this workspace resolves the same versions, so a clone builds against exactly what consumers install — no harness checkout to link:

```sh
git clone https://github.com/hccccc01333/dsh-eval.git
cd dsh-eval
pnpm install
pnpm --filter dsh-eval build
pnpm --filter dsh-eval test
```

Running benchmarks needs a `dsh` launcher; `pnpm test` does not (the suite is keyless, with a fake `dsh` and recorded session-log fixtures):

```sh
dsh plugin --profile eval add dsh-eval
cp examples/minimal-benchmark.yaml benchmark.yaml  # self-contained, no fixtures needed
dsh eval validate benchmark.yaml
dsh eval run benchmark.yaml --out run-v1.json
dsh eval report run-v1.json --brief
dsh eval run benchmark.yaml --out run-v2.json
dsh eval compare run-v1.json run-v2.json
dsh eval import codex ~/.codex/sessions/.../session.jsonl --out codex-run.json
```

## Benchmark document

```yaml
name: quickstart
model: deepseek-v4
cases:
  - id: hello
    prompt: Reply with exactly "pong".
    expected:
      answerRegex: '^pong$'
pricing:
  deepseek-v4:
    inputUsdPerMTokens: 0.27
    cacheReadUsdPerMTokens: 0.07
    cacheWriteUsdPerMTokens: 0.27
    outputUsdPerMTokens: 1.10
```

This example is self-contained: `answerRegex` grades the final answer without a
workspace or check script. The copyable file is
[examples/minimal-benchmark.yaml](examples/minimal-benchmark.yaml). Each trial
runs in a private temp workspace with an isolated `DSH_HOME` and non-interactive
permissions; the primary session log becomes the trial's trace. For scripted
grading (`checkArgv`/`checkShell`, tool matching), `workspace`, `trials`, `seed`
and other fields, see [packages/eval/README.md](packages/eval/README.md).

## Metrics

| Metric | Source |
|---|---|
| Task success | `expected.check` exit 0 |
| Tool success / rate | tool results in the session log |
| Tool-selection accuracy | `expected.tool` substring match |
| Steps / turns | session log turns and tool events |
| Tokens / context usage | disjoint token buckets + billed context |
| Latency | `llmMs` / `toolMs` / `ttftMs` / `latencyMs` |
| Cost | per-model pricing table (`pricing`) |
| Retry | `llm/retry` events |
| Invalid tool call | tool results carrying an internal failure identity |
| Final answer score / hallucination | LLM judge verdict from `judge` config |

Benchmarks are fingerprinted with SHA-256 over the YAML source plus every
resolved input — prompt files, workspace trees and replay logs. The digest is
stored in each run and shown by `report`, `validate` and the HTML dashboard, so
fixture edits cannot silently change what a result means. CLI option overrides
are recorded separately in the run's option fields.

## CLI

| Command | What it does |
|---|---|
| `dsh eval run benchmark.yaml --out run.json [--trials N] [--concurrency N] [--seed N]` | Execute the benchmark, stream progress to stderr, write the JSON run; overrides are folded into provenance |
| `dsh eval report run.json` | Render a run as Markdown |
| `dsh eval report run.json --brief` | Print a compact terminal summary without the per-trial table |
| `dsh eval report run.json --json` | Emit the run and all derived blocks as JSON |
| `dsh eval report run.json [--out report.md]` | Write any report variant to a file instead of stdout |
| `dsh eval export run.json [--out trials.csv]` | Flatten trials into a safely escaped CSV |
| `dsh eval dashboard a.json [b.json ...] --out report.html [--metric strictPassAt1]` | Write a standalone HTML dashboard or multi-run leaderboard (`--metric` affects 3+ runs only) |
| `dsh eval validate benchmark.yaml [--json] [--out file]` | Preflight a benchmark with evidence warnings |
| `dsh eval provenance run.json benchmark.yaml [--json] [--out file]` | Verify the run's benchmark SHA-256 against the current inputs; mismatches exit 1 |
| `dsh eval leaderboard a.json b.json ... [--metric taskSuccess\|strictPassAt1] [--json] [--out file]` | Rank runs by pooled or error-inclusive success |
| `dsh eval gate candidate.json --baseline base.json [--max-drop 0.05] [--max-segment-drop 0.02] [--json] [--out file]` | Fail CI on regressions; `--max-drop` is the tolerated fractional drop (default `0` = any drop fails), `--max-segment-drop` also gates each shared case tag, `--json` emits a machine-readable verdict |
| `dsh eval compare base.json candidate.json [--json] [--out file]` | Compare two runs with deltas and paired inference |
| `dsh eval rejudge run.json --out rejudged.json` | Re-judge stored traces offline and write a new report |
| `dsh eval reproduce run.json benchmark.yaml [--out replay.json] [--json]` | Replay with the baseline's recorded settings; a changed benchmark digest is rejected |
| `dsh eval segments base.json candidate.json [--json] [--out file]` | Compare two runs by case tag with signed deltas |
| `dsh eval import codex\|claude-code log.jsonl --out run.json` | Import an external session log as a one-trial run |

Every read-only renderer (`report`, `compare`, `validate`, `leaderboard`, `gate`,
`export`) accepts `--out <file>` and creates parent directories; without it the
output goes to stdout.

## Roadmap

- Per-arm leaderboards over paired trials
- Web UI dashboard for run reports and comparisons

Both are open ideas; completed work is in [CHANGELOG.md](CHANGELOG.md) and the
prioritized gap list is in [ROADMAP.md](ROADMAP.md).

## Repository layout

```
packages/eval/    plugin bundle + CLI app + tests
scripts/          harness-closure.mjs — optional local-harness workspace closure
```

`dsh eval run` also takes `--trials`, `--concurrency`, `--dsh`, `--profile`, `--quiet` and `--allow-external-paths`; `dsh eval validate` accepts `--allow-external-paths` too, and `dsh eval import` takes `--case-id`. Third-party benchmarks are path-contained unless the trusted operator passes `--allow-external-paths`. Replay runs need a `dsh` built from harness source; everything else runs against the released peers.

## Releasing

Bump `version` in `packages/eval/package.json` and add a CHANGELOG section, then push a matching tag:

```sh
git tag v0.5.17 && git push origin v0.5.17
```

`.github/workflows/release.yml` re-runs the gates and publishes to npm through **trusted publishing (OIDC)** with a provenance statement — no token on any machine. The npm Trusted Publisher entry (GitHub Actions, workflow `release.yml`) is already configured; every release from `0.5.0` onward has shipped this way. The account's second factor is a security key, so a long-lived token is neither stored nor needed.

See [RELEASE.md](RELEASE.md) for the full release checklist, the exact Trusted
Publisher fields (needed again only if the publishing account or repository
changes), and the manual OIDC identity check.

## License

MIT
