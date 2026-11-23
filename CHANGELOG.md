# Changelog

## Unreleased

### Added

- **Progress ETA.** Trial progress lines add a rough seconds-remaining estimate
  once a run has finished at least one trial; it is omitted on the last trial
  and when no usable timing is available.
- **Brief strict rate.** `report --brief` shows error-inclusive strict pass@1
  beside the graded-only task rate.
- **Gate evidence consistency.** Per-case evidence now uses the metric that
  actually regressed; in significance mode a confirmed case regression also
  fails the gate, so a PASS report cannot advertise one.
- **Gate case evidence.** CI gate output lists family-corrected per-case
  regressions in markdown and `--json`, pointing at the exact cases behind a
  confirmed quality drop.
- **Review follow-up (round 63).** Strict leaderboard ties with unequal trial
  counts are no longer mislabelled as regressions; atomic writes preserve
  symlinked parents and permission bits; p-values near alpha keep four
  decimals; HTML and markdown report the same power notes.
- **Shared atomic output.** Run JSON, Markdown/JSON reports, CSV and HTML
  dashboards all go through one staged-write helper; an interrupted write
  cannot leave a truncated artifact anywhere in the CLI.
- **Dashboard metric flag.** `dashboard --metric strictPassAt1` ranks a 3+ run
  leaderboard page by the error-inclusive rate, matching `leaderboard`.
- **Review follow-up.** Per-case significance reports the family-aware pair
  requirement and true confirmed counts, flags truncated tables, and prints
  tiny p-values as `<0.001` instead of `0.0000`.
- **Dashboard case significance.** The two-run HTML dashboard shows a
  **Confirmed case changes** table alongside the discordant-case list.
- **Per-case paired significance.** `compare` aggregates paired trial outcomes
  by case, runs exact sign tests per case and corrects across the case family;
  confirmed regressions appear in markdown and `--json`.
- **Atomic report writes.** Run JSON is staged in a sibling temporary file and
  renamed into place, so an interrupted write cannot leave a truncated report.
- **Override-aware provenance.** Effective `--trials`, `--concurrency`,
  `--profile` and `--dsh` values are persisted as `benchmarkOverrides` and
  folded into `benchmarkSha256`, so verification detects them.
- **Follow-up review fixes.** Provenance digests use locale-independent sorting,
  follow symlinked fixtures and exclude the run report from `workspace: .`
  trees; strict-ranking verdicts use strict-pass paired evidence; and batched
  regex checks keep per-input isolation.
- **Strict leaderboard ranking.** `leaderboard --metric strictPassAt1` ranks by
  the error-inclusive pass rate so a run with many timeouts cannot top the board
  on graded-only successes; JSON output reports the chosen `rankedBy` metric.
- **Provenance verification.** The new `provenance <run.json> <benchmark.yaml>`
  command re-hashes benchmark inputs and exits 1 on a mismatch or missing
  digest, with `--json` and `--out` support for CI.
- **Documentation consistency.** The module header no longer claims the judge
  and paired inference are deferred; the release checklist points to the root
  changelog; both READMEs list `--quiet` and `--allow-external-paths`.
- **Bugbot review fixes.** The regex worker budget now covers startup under
  high concurrency; `allowExternalPaths` must come from the trusted CLI/API
  rather than the benchmark document; path containment follows symlinks; and
  `workspace: .` remains valid.
- **Batched regex API.** `safeRegexTestAny` keeps a separate budget per input,
  so one pathological tool name cannot consume another name's chance to match.
- **Untrusted-input hardening.** Regex grading runs in a time-boxed worker so
  catastrophic patterns cannot hang the evaluator; benchmark file references are
  contained by default behind an explicit `allowExternalPaths` opt-in; and
  rejudge resolves real paths and refuses drive-root/home temp roots.
- **Gate fail-open fix.** In significance mode, extra errors/timeouts in the
  candidate can no longer hide a strict pass@1 collapse behind survivor-only
  paired evidence.
- **Consistent `unscored` accounting.** Completed-but-ungraded trials now count
  as unscored everywhere, and `pass@k` labels show the observed graded count.
- **Dashboard paired inference.** The HTML comparison table now renders the
  sign-test p-values, power and deltas that were previously only in markdown.
- **Leaderboard correction family.** The verdict adjusts the raw p-value by the
  board family only, avoiding a double Bonferroni correction.
- **Documented release procedure.** `RELEASE.md` lists the exact Trusted
  Publisher fields, the manual OIDC identity check and the tag flow.
- **Benchmark input provenance.** The SHA-256 fingerprint covers the YAML plus
  resolved prompt files, workspace trees and replay logs; it is stored on the
  run and shown in reports, preflight summaries and dashboards.
- **`--out` on every renderer.** `report`, `compare`, `validate`, `leaderboard`
  and `gate` now join `export` and `dashboard` in writing to a file (creating
  parent directories) instead of stdout, with exit codes unchanged.
- **Per-case timeout overrides.** A case can set `timeoutMs` to override the
  benchmark default for both the agent child and scripted checks; `validate`
  reports how many cases do so.
- **Strict pass@1 confidence interval.** The precision block now bootstraps
  every trial — errors and timeouts included — so the strict rate carries an
  honest interval instead of silently dropping failed trials. Both the markdown
  report and HTML dashboard show it.
- **Trial-level CSV export.** `dsh eval export run.json [--out trials.csv]`
  flattens verdicts, metrics, cost and the trace digest into one row per trial,
  with CSV quoting and spreadsheet-formula escaping for agent-controlled text.
- **Dashboard leaderboards match CLI leaderboards.** The HTML leaderboard now
  renders the same corrected paired verdict column as `dsh eval leaderboard`.
- **Leaderboard shows paired evidence against the leader.** Each non-leading
  row reports a Bonferroni-corrected sign-test verdict, so a small point-estimate
  gap is no longer mistaken for a real ranking change.
- **Sharper benchmark preflight.** Duplicate case ids and single-trial
  reliability limits now warn before tokens are spent, and a run with neither
  scripted expectations nor a judge is explicitly reported as unable to
  produce any quality score.
- **Trace digest for tamper-evident re-judging.** Each completed trial records
  the SHA-256 of its merged trace, and `rejudge` refuses a stored log that no
  longer matches. The field is optional on older reports, so historical runs
  remain readable.
- **Statistical significance mode for the CI gate.** `dsh eval gate
  --require-significance` adds a paired-sign-test row and only fails quality
  drops the test confirms. Unpaired, underpowered or undecidable comparisons
  fail closed; budget checks remain unconditional.
- **Sign-test power diagnostics.** `compare` now reports the best corrected
  p-value a finite paired sample can ever produce and, when it cannot reach
  alpha, the minimum discordant pairs required. `validate` warns before a run
  whose maximum possible pairs are below that floor, so a `p = 1` is not read
  as evidence of no difference.
- **Deterministic final-answer grading.** `expected.answerRegex` (validated at
  load) matches the final assistant message and sets `taskSuccess` when no
  check command is configured, so a benchmark can grade answers without an LLM
  judge. It is counted as a check in preflight summaries.
- **Structured preflight.** `dsh eval validate --json` emits the same counts,
  configuration and weak-evidence warnings as the markdown summary, so a CI
  lint step can act on them without scraping text.
- **Structured comparison.** `dsh eval compare --json` emits the comparison
  rows, paired inference statistics and classified case outcomes as one JSON
  object, completing the machine-readable read-only command set.
- **Structured reports and leaderboards.** `dsh eval report --json` emits the
  run plus every derived summary block (coverage, reliability, precision,
  agreement, calibration) and raw trials as one JSON object; `dsh eval
  leaderboard --json` emits ranked rows with gaps. Markdown stays the default.
- **Machine-readable gate verdict.** `dsh eval gate ... --json` emits one JSON
  object with the pass flag, thresholds, checks and case regressions, keeping
  the same exit code as the markdown form.
- **Live run progress.** `dsh eval run` now emits one bounded stderr line per
  finished trial (`[eval] n/total case #trial task pass, 1234 ms`), including
  errors, with case ids and messages sanitized against newline injection.
  `--quiet` suppresses the progress while keeping the stdout summary.
- **Resource budgets in the CI gate.** `dsh eval gate` now accepts
  `--max-cost-increase` and `--max-latency-increase` as relative limits, so a
  candidate that preserves quality but costs more still fails the build. The
  markdown table shows absolute values with relative deltas; unpriced baselines
  skip the budget and unpriced candidates fail closed.
- **HTML leaderboard page.** `dsh eval dashboard a.json b.json c.json` now
  accepts three or more runs and writes a standalone leaderboard page with the
  same ranking, rates and gap-to-leader column as `dsh eval leaderboard`. The
  CSS is shared across all dashboard variants, keeping the page self-contained.
- **Benchmark preflight.** `dsh eval validate benchmark.yaml` parses a
  benchmark with the run loader, prints a readable summary and warns about
  weak-evidence configurations before any tokens are spent.
- **Multi-run leaderboard.** `dsh eval leaderboard a.json b.json ...` ranks any
  number of runs by pooled task success with deterministic tie-breaking, a
  gap-to-leader column and cost/latency figures, while pointing to `compare`
  for paired inference.
- **Case-level paired outcomes.** `compare` lists the concrete case x trials
  behind its sign test (candidate wins first, capped at 20 rows), and the
  two-run dashboard shows the same discordant cases under "Changed cases".
- **Judge calibration diagnostics.** Report mean normalized judge scores for
  scripted passes and failures, their separation, an AUC-style ranking accuracy
  and up to five disagreement cases with ids. Rendered in full reports, the
  HTML dashboard and a one-line `--brief` summary. The score (>= 0.5 of
  maxScore) drives the verdict; the hallucination flag is only a fallback for
  missing scores, and verdicts with neither signal are excluded from `pairs`.
- **CI quality gate.** `dsh eval gate candidate.json --baseline base.json
  --max-drop 0.05` checks coverage, task success, tool selection, strict pass@1
  and normalized judge score, prints a PASS/FAIL table and exits nonzero on
  regressions. Paired case x trials that flipped to failure are named in the
  output (ids sanitized for markdown). Candidate-side missing metrics fail closed;
  `--allow-incomplete` relaxes the coverage checks.
- **Standalone HTML dashboard.** `dsh eval dashboard a.json [b.json] --out report.html`
  renders coverage, pass@1/pass@k, latency and cost cards plus reliability,
  precision, agreement and per-trial tables into one self-contained page. It
  follows the OS light/dark preference and escapes all agent-controlled text.
  A second run path adds a comparison table with the same rows and signed
  deltas as `dsh eval compare`.
- **Judge/script agreement.** The full report now pairs scripted task success
  with the judge's no-hallucination verdict and reports observed agreement plus
  Cohen's kappa, so an over-permissive proxy judge cannot hide behind a high
  raw agreement rate. `--brief` includes the same statistic on one line.
- **Richer tool expectations.** `tools` (all), `toolAnyOf` (at least one),
  `toolRegex` (compiled and validated at benchmark load) and `toolNot` (none)
  join the legacy `tool` substring match. All constraints combine into one
  boolean `toolSelectionAccuracy`, so a benchmark can require a specific tool
  set without forbidding others by accident.
- **Reliable scripted checks.** `expected.checkArgv` passes exact argv without
  shell interpretation, `expected.checkShell` opts into pipes/redirection for
  trusted benchmark files, and legacy `check` strings now honor quotes and
  escapes via a splitter shared with `--dsh`. Check processes are detached and
  killed as a process group at the trial timeout so a hung verifier cannot
  stall a run. The schema rejects multiple simultaneous check modes.
- **`dsh eval rejudge`.** Re-judge a stored run from its harvested traces and
  persisted case inputs without re-running the agent. `--judge-model` (plus
  optional provider, rubric, and max-score flags) supplies or replaces the judge
  config, which makes the keyless replay-then-judge workflow usable. Only judge
  verdicts and grading change. A failed call keeps an already usable verdict
  with a `judgeError` marker, and trace paths are validated to stay inside the
  run's `tempRoot` so an edited report cannot send arbitrary local files to the
  judge model.
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

- **Significance mode assesses every quality metric separately.** A clean
  task-success pairing can no longer mask significant tool-selection or judge
  score regressions; each check has its own Bonferroni-corrected sign test,
  and case regressions are filtered per metric.
- **Power rows report the true minimum winning margin.** `minimumWins` now
  counts the smallest majority that still reaches alpha, not a clean sweep.
  Preflight derives its sample-size warning from `signTestPower` with a
  conservative inference family instead of hardcoded thresholds.
- **Answer regex grading degrades safely.** A malformed hand-built
  `answerRegex` now fails the case instead of erroring the trial, input is
  capped at 4096 characters to avoid stalling the event loop, and preflight
  warns (without double-counting) when a check command makes the regex unused.
- **CLI help shows a workflow.** `dsh --profile eval --help` now ends with
  copyable examples from validate through the CI gate.
- **Structured JSON keeps raw numbers and complete runs.** `compare --json`
  now includes a `metrics` object with numeric values alongside the formatted
  `rows`; `report --json` includes `caseInputs`, so its output can feed
  `rejudge`. `cases` is null (with `caseOutcomesMeasured: false`) when a paired
  comparison has no measured primary metric, instead of contradicting the
  aggregate tie count. Leaderboard rows also carry `benchmark` and `model`
  separately rather than only a formatted label.
- **Progress observers cannot abort a run.** A throwing or rejecting
  `onProgress` callback is now isolated from trial execution, so completed
  results and the run report survive a broken observer. Progress text also
  strips ANSI/control sequences and is length-capped before reaching a terminal.
- **Skipped budget checks no longer claim a baseline is "unpriced".** The note
  now says metrics are unavailable, which is accurate for both cost and latency.
- **Leaderboards with no task-success data no longer print rank 0.** Runs whose
  grading lacks `taskSuccessRate` now receive distinct ranks, and the
  gap-to-leader column shows `–` instead of a bogus "leader" label.
- **Unmeasured pairs are no longer reported as ties.** `pairedCases` returns no
  case outcomes when every pair lacks the chosen primary metric, while the
  aggregate sign test keeps its historical all-ties behaviour.
- **Grandchild-held stdio no longer keeps the CLI alive.** The 200 ms exit
  drain guard now clears timers and releases inherited streams after resolving.
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
- **The bare-invocation hint lists every subcommand** (`run`, `report`,
  `compare`, `export`, `validate`, `leaderboard`, `gate`, `dashboard`,
  `rejudge`, `import`), not just the first two.
- **`test:pack` now verifies wildcard exports.** `./src/*` is expanded to the
  source tree and every file must be packed; previously removing
  `src/**/*.ts` from `files` passed the smoke test unnoticed.
- **Documentation matches the tree.** Both READMEs report 300 tests, and a
  session-log discovery test is renamed for the behavior it actually asserts.

### Fixed

- **CSV and export command hardening.** Leading newlines/spaces are neutralized
  as spreadsheet formula markers, `--out` creates parent directories, and the
  usage hint lists every subcommand.
- **Strict pass@1 precision aligns with reliability.** A run with no graded
  task trial now reports no interval instead of a misleading 0%.
- **Benchmark digests survive the report loader.** `benchmarkSha256` is now part
  of the validated run schema and appears in markdown, brief, JSON and dashboard
  output; rejudged reports keep the field.
- **CSV export keeps its trial-count confirmation** after the shared `--out`
  writer refactor.
- **Rejudge trace paths are resolved before the tempRoot check.** A hand-edited
  report can no longer use `root/../outside.jsonl` to make the judge read and
  ship an arbitrary local `.jsonl` file.
- **Significance mode counts the real correction family.** Duplicate sign
  tests and ungraded metrics no longer inflate the family and suppress genuine
  regressions; all-tied pairs are treated as inconclusive and fail closed.
- **Paired comparisons ignore unmeasured pairs.** Missing metric outcomes are
  no longer invented as ties in `compare` or in leaderboard verdicts, which
  also report their attainable floor at the correct family size and name the
  metric they tested.
- **A detached grandchild can no longer hang a check forever.** The runner now
  resolves from the child's `exit` event after a short stdio drain grace period
  even when `close` never arrives because an inherited pipe stays open.

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
