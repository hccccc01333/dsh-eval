# dsh-eval roadmap

Prioritized gaps from the reproducibility and scripted-grading audits. Items are
ordered by value / effort; completed work lives in [CHANGELOG.md](CHANGELOG.md).

## Open

- Per-arm leaderboards over paired trials.
- Web UI dashboard for run reports and comparisons (the standalone HTML
  dashboard is the current, dependency-free answer).

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
- ✅ **Deterministic answer grading** (done). `answerRegex` grades the final
  assistant message without a check command or an LLM judge, and is validated
  at load like `toolRegex`.
- ✅ **Structured preflight** (`dsh eval validate --json`).
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
- ✅ **Tamper-evident traces.** Recorded SHA-256 digests let offline re-judging
  prove it reads the same evidence the original run harvested.
- ✅ **Significance-gated CI.** `dsh eval gate --require-significance` only
  fails confirmed regressions and closes the gate when evidence is missing or
  underpowered.
- ✅ **Paired statistical power.** `compare` reports the attainable p-value
  floor and required discordant sample size; `validate` warns when a benchmark
  cannot produce enough pairs for a corrected sign test.
- ✅ **Trial-level CSV export.** `dsh eval export` flattens a persisted run for
  spreadsheet and notebook analysis with safe cell escaping.
- ✅ **Statistically guarded leaderboards.** Non-leading rows carry a
  Bonferroni-corrected paired verdict against the leader, separating real gaps
  from ranking noise.
- ✅ **Judge calibration diagnostics.** Full reports and the dashboard now show
  normalized score means for scripted passes/failures, their separation, an
  AUC-style ranking accuracy, and up to five concrete disagreement cases —
  turning a single kappa into an actionable rubric-improvement list.
- ✅ **CI quality gate** (`dsh eval gate`). Compares a candidate against a
  baseline on coverage, task/tool rates, strict pass@1 and normalized judge
  score with one `--max-drop` tolerance; exits nonzero on regressions. Optional
  `--max-cost-increase` / `--max-latency-increase` add relative resource budgets
  so a more expensive candidate also fails. Missing candidate metrics fail
  closed; `--allow-incomplete` relaxes coverage checks.

## P2 — polish

- ✅ Judge/script agreement metric (done). Observed agreement plus Cohen's kappa
  over trials with both a scripted task result and a judge verdict, rendered in
  the full report and as one line in `--brief`.
- ✅ Structured JSON output (done). `validate --json`, `report --json`,
  `compare --json`, `leaderboard --json` and `gate --json` expose the same data and
  verdicts in machine-readable form while markdown/HTML remain human defaults.
- ✅ Live run progress (done). Each finished trial writes one sanitized stderr
  line with 1-based progress, case id, task result and latency; `--quiet`
  keeps scripts that only parse stdout quiet.
- ✅ HTML dashboard (single-run, two-run comparison and multi-run leaderboard).
  `dsh eval dashboard a.json [b.json ...]` writes a standalone, escaped,
  theme-aware page with summary cards, all report blocks, and either a
  comparison table reusing `dsh eval compare` rows or a leaderboard page.
- ✅ **npm Trusted Publishing** (done). `dsh-eval` is configured for GitHub
  Actions OIDC at <https://www.npmjs.com/package/dsh-eval/access> — owner
  `hccccc01333`, repo `dsh-eval`, workflow `release.yml`, no environment.
  Tag pushes publish with SLSA provenance; `0.5.0` and `0.5.1` shipped this way.
