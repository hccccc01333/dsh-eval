# Changelog

## Unreleased

### Added

- **Reproducible trial seeds and re-judgeable reports.** Trial n now receives
  `DSH_EVAL_SEED = seed + n - 1` in its child environment, so harnesses that
  read it can sample deterministically; the base seed still drives report
  bootstraps. Runs also persist `caseInputs` (case id, prompt, optional gold
  answer) in the JSON report, which is the data the judge prompt needs for a
  future offline re-judge command. Both additions are backward compatible.
- **Compact `--brief` report mode.** `dsh eval report run.json --brief` prints
  trial coverage, per-trial tool/step/token/cost figures, the task rate with
  pass@k/pass^k, the seeded interval, and the judge-failure count without the
  per-trial markdown table, so large runs remain readable in a terminal.
- **Single-run precision.** The report gained a Precision block: seeded
  percentile-bootstrap 95% intervals for task/tool pass rates (2000 resamples by
  default, seeded from the run) with an `n=` count, plus latency p50/p95. A
  one-trial run prints the rate without an interval rather than implying false
  precision. Derived from stored trials at render time, so old reports gain it
  too.
- **Gold answers and visible judge failures.** A case can set
  `expected.answer`; the judge prompt now includes it and instructs the model to
  score factual agreement rather than fluency. A failed chat call or an
  unparsable reply no longer vanishes into a null score: the verdict carries
  `judgeError`, `grading.judgeFailures` counts it, and both the Markdown report
  (`- judge failures: N`) and `compare` show it. A run where every judge call
  failed is still reported rather than collapsing to a null grading.
- **Trial coverage and survivor-bias-free pass rates.** Reports now show
  `completed / total` trials with unscored and timeout counts, and the
  Reliability block adds `strict pass@1` (passes over every trial, including
  errors and timeouts) beside the graded-only figure. `compare` gained
  `unscored trials` and `strict pass@1 (task)` rows. A model that times out on
  hard cases can no longer look better simply because those trials vanished
  from the denominator. Derived at render time, so old reports benefit too.
- **Reliability metrics over repeated trials.** A new `reliability` module folds
  a run's per-trial grades into `pass@1`, `pass@k` (cases with at least one
  passing trial), and `pass^k` (cases passing every trial), plus the flaky cases
  whose trials disagreed and the hardest cases by pass rate. Both grading
  dimensions are reported. `dsh eval report` appends a Reliability block and
  `dsh eval compare` adds four comparison rows. Everything is derived from the
  stored trials at render time, so reports written by earlier versions gain the
  new view without being rewritten.
- **Family-wise correction on paired inference.** `dsh eval compare` prints a
  sign-test p-value beside up to three bootstrap delta intervals. Those are now
  treated as one inference family and corrected together with Bonferroni at
  `alpha = 0.05`: the p-value row is labelled with the family size it was
  multiplied by, and each interval is widened to `1 - 0.05/k` confidence (98.8%
  when all four quantities are present). The family size adapts to which
  intervals actually have data, so a run without a judge is corrected over
  three quantities rather than four. `stats.ts` exports `bonferroni` for reuse.

### Changed

- **Paired inference now lives in its own table.** `compare` previously put the
  sign-test p-value and bootstrap intervals in the `delta (B - A)` column, where
  they read as run-level differences rather than evidence about the paired
  sample. `CompareRow` gained an optional `inference` field and the renderer
  emits a `## Paired inference` table (`quantity | value`) for those rows,
  leaving the delta column strictly for signed differences.

### Fixed

- **`dsh eval run` exits nonzero when any trial fails.** Previously a single
  surviving trial made the command exit 0 even if the rest errored, so a
  `run && next-step` CI chain could go green on a broken benchmark. The stdout
  count now reads `completed/total` and the failing trials are still listed on
  stderr.
- **Comparison cost is no longer rounded to zero.** `cost/trial (USD)` used a
  one-decimal formatter, turning real micro-dollar costs into `0.0`; it now
  prints six decimals with a sign-aware delta. Count rows print as integers.
- **`dsh eval run` docs include the required benchmark argument.** Copying
  `dsh eval run --out run.json` from the run-report section failed with a
  missing-argument error.
- **Case ids that collapse onto the same trial directory are now rejected.** A
  trial's private directory is `<caseSegment(id)>-<trial>`, so ids like `a/b`
  and `a b` (or a plain duplicate, or `Case`/`case` on a case-folding
  filesystem) used to share a workspace and `DSH_HOME`; the second case could
  then harvest the first one's session log as its own trace. `parseBenchmark`
  now rejects such ids before any trial starts, using the same normalization
  function the runner uses for directory names.
- **A child that exits just before its timeout is no longer misreported as
  timed out.** The timer checks for an already-observed exit code or signal
  before marking the trial as timed out. A second-stage SIGKILL now escalates a
  child that ignores SIGTERM, so a run cannot hang forever.
- **Invalid `runBenchmark` overrides are rejected before a temp root is made.**
  `trials` and `concurrency` must be finite positive integers; previously `0`
  produced a `TypeError` and `Infinity` could loop forever.
- **`loadRunReport` validates the whole run document.** A truncated or
  hand-edited report now fails with a field-path diagnostic (for example
  `aggregate.steps: Required`) instead of a `TypeError` in the renderer.
- **External logs with a leading UTF-8 BOM import correctly.** The BOM is
  stripped in both the dsh trace parser and the Codex/Claude importers; before,
  the importers silently dropped the first line and its user turn.
- **Malformed session-log headers now report `invalid header at line 1`**
  instead of leaking a raw JSON or zod error.
- **Codex logs missing `call_id` now pair calls with their results.** Fallback
  ids are assigned by occurrence order on each side, so tool latency is folded
  instead of dropped. A single content object is also recognized as message
  text, not only a block array.
- **A whitespace-only `--dsh` is rejected at parse time** instead of silently
  falling back to the default launcher. A run with failed trials now also writes
  the first failure reasons to stderr, rather than exiting with only a bare
  "no completed trials" line on stdout.
- **The bare-invocation hint lists all four subcommands** (`run`, `report`,
  `compare`, `import`), not just the first two.
- **`test:pack` now verifies wildcard exports.** `./src/*` is expanded to the
  source tree and every file must be packed; previously removing
  `src/**/*.ts` from `files` passed the smoke test unnoticed.
- **Documentation matches the tree.** Both READMEs report 137 tests, and a
  session-log discovery test is renamed for the behavior it actually asserts.

## 0.4.0 — 2026-10-26

### Added

- **Concurrent trials.** `concurrency` in the benchmark document and
  `--concurrency` on `dsh eval run` set how many case x trial executions are in
  flight at once; default `1` keeps the previous serial behavior. Each trial
  already owned a private temp directory, workspace copy, and `DSH_HOME`, so the
  pool changes only scheduling: results are written at their task index, so the
  run record keeps case-then-trial order whatever the interleaving, and the
  first error to escape a trial still stops the pool and rejects the run.
- **Paired inference in `compare`.** The paired block no longer stops at point
  estimates. It runs an exact two-sided sign test over the discordant pairs of
  the primary metric (printed with `n`, its discordant count) and reports a
  seeded bootstrap 95% interval beside each paired mean delta of steps, tokens,
  and judge score. Both are distribution-free: a paired eval sample is small and
  its deltas are not normal, so a t-interval would be unjustified. Ties drop out
  of the sign test, as it requires. The bootstrap PRNG is seeded, so re-running
  `compare` on the same reports prints a byte-identical table.

### Changed

- The paired fields on the internal `PairedStats` shape became
  `stepsDelta`/`tokensDelta`/`scoreDelta` (mean plus interval) instead of bare
  `mean*Delta` numbers, and `test` carries the sign-test outcome.

## 0.3.1 — 2026-10-26

### Fixed

- **The published `0.3.0` tarball could not be imported.** `files` is a
  whitelist and listed only `lib/index.js` and `lib/invariant.js`, while
  `lib/index.js` statically imports seven sibling modules
  (`benchmark`, `command`, `judge`, `metrics`, `report`, `runner`, `trace`).
  Those were built but never packed, so every install failed at link time:

  ```
  ERR_MODULE_NOT_FOUND: Cannot find module '.../lib/benchmark.js'
    imported from '.../lib/index.js'
  ```

  `files` now ships `lib/**/*.js` and `lib/**/*.d.ts`. Two related fixes ride
  along: `lib/types/**/*.js` was a pattern that could never match (the build
  emits declarations only into `lib/types`), and `exports["./types"].default`
  pointed at `./lib/types/types.js`, a file that does not exist — the
  type-only module's runtime entry is `./lib/types.js`.

- **Packaging is now verified, not assumed.** `pnpm test:pack`
  (`scripts/pack-smoke.mjs`) packs the package the way npm does and asserts
  that every relative import in the packed JS and every relative declaration
  import resolves inside the packed file set, that every `exports`/`main`/`types`
  target is packed, and finally imports the entry through the real `exports`
  map. `vitest` exercises `src/` and structurally cannot catch this class of
  defect.

### Changed

- The workspace resolves `@deepseek-ai/*` devDependencies from the published
  releases instead of a local harness checkout, matching the peer versions the
  published package declares. A clone installs with `pnpm install` alone.
- CI (`.github/workflows/ci.yml`) runs typecheck, coverage, build, and the pack
  smoke test on Linux and Windows.
- Coverage thresholds (100% statements/branches/functions/lines on `src`) are
  enforced by `vitest.config.ts`.
- Documentation: the Chinese READMEs and both package READMEs were rewritten
  against the implemented behavior — LLM judge, keyless replay, paired
  comparison, and subagent trace merging had all shipped while the docs still
  listed them as deferred.

## 0.3.0

- Packaged as the unscoped `dsh-eval`; peers aligned to `@deepseek-ai/*`
  `0.1.0-rc.6`. **Not installable** — see 0.3.1.

## 0.2.0

- Scripted grading (`expected.tool`, `expected.check`), run comparison.

## 0.1.0-rc.6

- First release: benchmark YAML, headless run orchestration, trace-based
  metrics, JSON/Markdown reports.
