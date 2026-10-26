# Changelog

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
