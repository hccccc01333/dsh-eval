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
  holding stdio open after its parent exits remains an edge case.
- **Richer tool expectations.** Keep `tool` as a substring match for
  compatibility; add `tools` (all), `toolAnyOf`, `toolRegex` (validated at load)
  and `toolNot`. All remain booleans in `EvalGrade`.

## P2 — polish

- Judge/Script agreement metric (where a check and a judge both grade a trial).
- HTML dashboard for browseable run comparison.
- Release: configure npm Trusted Publisher for `dsh-eval` at
  <https://www.npmjs.com/package/dsh-eval/access> — GitHub Actions, owner
  `hccccc01333`, repo `dsh-eval`, workflow `release.yml`, no environment.
  Until then the OIDC publish step in `release.yml` cannot succeed.
