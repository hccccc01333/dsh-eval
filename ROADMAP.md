# dsh-eval roadmap

Prioritized gaps from the reproducibility and scripted-grading audits. Items are
ordered by value / effort; completed work lives in [CHANGELOG.md](CHANGELOG.md).

## P0 — reproducibility

- ✅ **Make `seed` reach each trial** (done). Trial n now receives
  `DSH_EVAL_SEED = seed + n - 1` in its environment (`runner.ts` spawn env);
  the same base seed drives report bootstraps. Harnesses must read the variable
  for deterministic sampling.
- ✅ **Persist case inputs** (done). `EvalRun.caseInputs` and the report schema
  store each case's `prompt` and optional `answer`, so a report alone carries
  the data `buildJudgePrompt` needs.

## P1 — offline re-judging

- ✅ **`dsh eval rejudge run.json --out ...`** (done). Rebuilds verdicts from
  stored traces, accepts `--judge-model`/`--judge-provider`/`--judge-rubric`/
  `--judge-max-score` overrides (needed because replay runs have no judge
  config), preserves usable prior verdicts on judge outages, and validates
  trace paths stay inside `tempRoot`. Truly offline re-judging with no LLM at
  all would still require recording judge prompts/replies.

## P1 — scripted grading

- ✅ **Check invocation modes** (done). `checkArgv` passes exact argv without a
  shell, `checkShell` is an explicit opt-in for pipes/redirection, and legacy
  `check` now uses a quote-aware splitter shared with `--dsh`. Check processes
  are detached and terminated as a group on timeout. A lingering grandchild
  holding stdio open after its parent exits is now bounded: the runner resolves from `exit` after a short drain grace period instead of waiting for `close` forever.
- ✅ **Richer tool expectations** (done). `tool` stays a substring match;
  `tools` (all), `toolAnyOf`, `toolRegex` (validated at load) and `toolNot`
  combine conjunctively into the same boolean `EvalGrade.toolSelectionAccuracy`.

## Beyond the original audit

- ✅ **Benchmark preflight** (`dsh eval validate`). Parses a benchmark with the
  same loader as `run`, prints a readable summary and warns about configurations
  that would produce weak evidence before any tokens are spent.
- ✅ **Multi-run leaderboard** (`dsh eval leaderboard`). Ranks any number of
  runs by pooled task success with deterministic tie-breaking, gap to leader
  and cost/latency columns; explicitly a screening view before paired
  `compare`.
- ✅ **Case-level paired outcomes.** `compare` and the two-run dashboard name
  the concrete case x trials behind a significant sign test, using the same
  primary metric and capped output for large benchmarks.
- ✅ **Judge calibration diagnostics.** Full reports and the dashboard now show
  normalized score means for scripted passes/failures, their separation, an
  AUC-style ranking accuracy, and up to five concrete disagreement cases —
  turning a single kappa into an actionable rubric-improvement list.
- ✅ **CI quality gate** (`dsh eval gate`). Compares a candidate against a
  baseline on coverage, task/tool rates, strict pass@1 and normalized judge
  score with one `--max-drop` tolerance; exits nonzero on regressions. Missing
  candidate metrics fail closed; `--allow-incomplete` relaxes coverage checks.

## P2 — polish

- ✅ Judge/script agreement metric (done). Observed agreement plus Cohen's kappa
  over trials with both a scripted task result and a judge verdict, rendered in
  the full report and as one line in `--brief`.
- ✅ HTML dashboard (single-run and two-run comparison). `dsh eval dashboard
  a.json [b.json]` writes a standalone, escaped, theme-aware page with summary
  cards, all report blocks, and a comparison table reusing `dsh eval compare`
  rows.
- Release: configure npm Trusted Publisher for `dsh-eval` at
  <https://www.npmjs.com/package/dsh-eval/access> — GitHub Actions, owner
  `hccccc01333`, repo `dsh-eval`, workflow `release.yml`, no environment.
  Until then the OIDC publish step in `release.yml` cannot succeed.
