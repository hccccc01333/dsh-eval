import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { executeEval } from '../src/index.ts'

vi.mock('../src/runner.ts', () => ({
  runBenchmark: vi.fn(async () => {
    throw 'boom'
  }),
}))

describe('dsh-eval non-Error failures', () => {
  it('renders a non-Error rejection into the stderr diagnostic', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-eval-execute-'))
    const benchmarkPath = join(dir, 'benchmark.yml')
    writeFileSync(benchmarkPath, 'name: n\nmodel: m\ncases:\n  - id: a\n    prompt: p\n')
    const stderr: string[] = []
    const code = await executeEval(
      { kind: 'run', benchmarkPath, outPath: join(dir, 'run.json') },
      { stdout: { write: () => {} }, stderr: { write: (chunk) => { stderr.push(chunk); return true } } },
    )
    expect(code).toBe(1)
    expect(stderr.join('')).toBe('dsh eval: boom\n')
    rmSync(dir, { recursive: true, force: true })
  })
})
