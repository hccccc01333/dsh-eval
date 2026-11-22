# dsh-eval roadmap

Prioritized gaps from the reproducibility and scripted-grading audits. Items are
ordered by value / effort; completed work lives in [CHANGELOG.md](CHANGELOG.md).

## P0 — reproducibility

- **Make `seed` reach each trial.** `Benchmark.seed` is currently only stored in
  the run record and used as the bootstrap PRNG seed. It never reaches a child
  process (`packages/eval/src/runner.ts`, spawn env). Pass it as
  `DSH_EVAL_SEED=<seed + trial - 1>` in the trial env — a one-line, backward
  compatible change — and document that harnesses/plugins may read it. An
  argv flag is riskier because unknown flags break harnesses.
- **Persist case inputs.** `EvalRun` stores trial results but not the case
  `prompt` or `expected.answer`. Add an optional `caseInputs` field to the run
  and report schema so a report alone is sufficient for re-judging.

## P1 — offline re-judging

- **`dsh eval rejudge run.json [--out ...]`.** Reuse `loadRunReport`,
  `loadTrace`/`mergeTraces` over `tracePaths`, `tryJudgeTrial`, and the stored
  `run.judge` config; re-aggregate grading and write a new report. This also
  enables a keyless two-phase workflow: replay a run without a judge, then
  re-judge the recorded traces with an LLM seam. Truly offline re-judging
  (no LLM at all) would additionally require recording judge prompts/replies.

## P1 — scripted grading

- **Check invocation modes.** `expected.check` is whitespace-split and spawned
  without a shell, so quotes, pipes, arguments with spaces, `.cmd` files, and
  Windows paths with spaces all fail indistinguishably from a failed agent.
  Add `checkArgv` (exact argv) and `checkShell` (opt-in `shell: true`) while
  keeping the current default. `runCommand` should kill a shell's process
  group on timeout and guard against a lingering grandchild holding stdio open
  forever. The same naive splitter affects `--dsh` in `command.ts`.
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
