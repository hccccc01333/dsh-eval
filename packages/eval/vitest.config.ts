import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    // Several tests spawn headless child processes. Under a fully parallel
    // coverage run on a loaded CI machine, 30s was occasionally too tight and
    // made unrelated tests fail; 60s keeps those checks meaningful.
    testTimeout: 60_000,
    // Regex guards and CLI tests spawn child processes and Workers. On a
    // 4-core machine, one worker per test file oversubscribes them and makes
    // time-boxed assertions flaky (different failures on each run).
    maxWorkers: 4,
    coverage: {
      provider: 'v8',
      // The README advertises 100% on `src`; without thresholds that claim
      // decays silently the next time a branch is added untested.
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
})
