# dsh-eval

**Agent Evaluation Platform for [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).**

[![npm version](https://img.shields.io/npm/v/dsh-eval)](https://www.npmjs.com/package/dsh-eval)
[![license](https://img.shields.io/github/license/hccccc01333/dsh-eval)](LICENSE)

Run benchmarks against headless `dsh` profiles, harvest persisted session logs as traces, fold automatic metrics, grade task success and tool selection, and report or compare runs — one `benchmark.yaml` in, one JSON run + Markdown report out.

> The dsh ecosystem already has observability and debugging tools (`dsh-trace`, `dsh-tps`, `dsh-context-doctor`). dsh-eval fills the missing slot: **an evaluation platform**.

## Highlights

- `dsh eval run benchmark.yaml` — orchestrate one headless `dsh` subprocess per case × trial
- Trace harvesting from persisted session logs (everything a model sees is reconstructable from the log)
- Automatic metrics: task success, tool success, tool-selection accuracy, steps, tokens, latency, cost, retry, invalid tool calls, context usage
- Scripted grading: `expected.tool` (tool-selection accuracy) and `expected.check` (task success)
- LLM judge: final-answer score and hallucination flags from a judge model
- Subagent trace merging: child session logs fold into the trial metrics
- Paired A/B: same-case win/lose/tie statistics across two runs
- Keyless replay: record once with a key, replay in CI from recorded logs
- Cross-harness import: `dsh eval import codex|claude-code <log> --out run.json`
- `dsh eval report run.json` — Markdown report with per-trial scores and pooled rates
- `dsh eval compare v1.json v2.json` — signed `B - A` comparison table

## Status

npm `0.3.0` · 113 tests · 100% branch/line coverage on `src` · typecheck clean.

## Quick start

Install the package directly:

```sh
pnpm add dsh-eval
dsh plugin --profile eval add dsh-eval
```

The npm package targets the official `@deepseek-ai/*` releases (`0.1.0-rc.6` peers). For the source flow, clone this repo and link it to a deepseek-harness checkout:

```sh
git clone https://github.com/hccccc01333/dsh-eval.git
cd dsh-eval
```

Windows (junction):

```powershell
New-Item -ItemType Junction -Path harness -Target D:\path\to\deepseek-harness
```

macOS / Linux (symlink):

```sh
ln -s /path/to/deepseek-harness harness
```

Then:

```sh
pnpm install
pnpm --filter dsh-eval build
pnpm --filter dsh-eval test
```

With a `dsh` launcher from the harness checkout:

```sh
dsh plugin --profile eval add dsh-eval
dsh eval run benchmark.yaml --out eval-run.json
dsh eval report eval-run.json
dsh eval compare eval-v1.json eval-v2.json
dsh eval import codex ~/.codex/sessions/.../session.jsonl --out codex-run.json
```

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

Each trial runs in a private temp workspace with an isolated `DSH_HOME` and non-interactive permissions. The primary session log becomes the trial's trace; scripted grading pools `taskSuccess` and `toolSelectionAccuracy` into run-level rates. See [packages/eval/README.md](packages/eval/README.md) for the full field reference.

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

## CLI

| Command | What it does |
|---|---|
| `dsh eval run benchmark.yaml --out run.json` | Execute the benchmark and write the JSON run |
| `dsh eval report run.json` | Render a run as Markdown |
| `dsh eval compare base.json candidate.json` | Compare two runs with signed `B - A` deltas |
| `dsh eval import codex\|claude-code log.jsonl --out run.json` | Import an external session log as a one-trial run |

## Roadmap

- Per-arm leaderboards and significance testing over paired trials
- Parallel trial execution across cases
- Web UI dashboard for run reports and comparisons

## Repository layout

```
packages/eval/    plugin bundle + CLI app + tests
harness/          local deepseek-harness checkout (gitignored junction/symlink)
```

## License

MIT
