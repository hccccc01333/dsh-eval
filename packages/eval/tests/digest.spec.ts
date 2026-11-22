import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hashBenchmarkInputs } from '../src/digest.ts'
import type { Benchmark } from '../src/types.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-eval-digest-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function benchmark(workspace?: string): Benchmark {
  return {
    name: 'b', model: 'm', profile: 'headless', command: ['dsh'],
    trials: 1, concurrency: 1, timeoutMs: 1000, seed: 0,
    cases: [{ id: 'c', prompt: 'p', ...(workspace === undefined ? {} : { workspace }) }],
    baseDir: '/tmp',
  }
}

describe('dsh-eval benchmark input digest', () => {
  it('is deterministic across directory entry order', async () => {
    const dir = tempDir()
    const workspace = join(dir, 'workspace')
    mkdirSync(join(workspace, 'nested'), { recursive: true })
    writeFileSync(join(workspace, 'b.txt'), 'b')
    writeFileSync(join(workspace, 'a.txt'), 'a')
    writeFileSync(join(workspace, 'nested', 'c.txt'), 'c')
    const first = await hashBenchmarkInputs('yaml', benchmark(workspace))
    const again = await hashBenchmarkInputs('yaml', benchmark(workspace))
    expect(first).toBe(again)
    writeFileSync(join(workspace, 'nested', 'c.txt'), 'changed')
    expect(await hashBenchmarkInputs('yaml', benchmark(workspace))).not.toBe(first)
  })

  it('hashes symlink targets without following them', async () => {
    const dir = tempDir()
    const workspace = join(dir, 'workspace')
    mkdirSync(workspace)
    mkdirSync(join(dir, 'target'))
    symlinkSync(join(dir, 'target'), join(workspace, 'link'), 'junction')
    const withLink = await hashBenchmarkInputs('yaml', benchmark(workspace))
    rmSync(join(workspace, 'link'), { recursive: true, force: true })
    writeFileSync(join(workspace, 'link'), 'plain file')
    expect(await hashBenchmarkInputs('yaml', benchmark(workspace))).not.toBe(withLink)
  })

  it('hashes missing paths without failing validation', async () => {
    const dir = tempDir()
    const digest = await hashBenchmarkInputs('yaml', benchmark(join(dir, 'absent')))
    expect(digest).toMatch(/^[0-9a-f]{64}$/u)
    expect(await hashBenchmarkInputs('yaml', benchmark(join(dir, 'absent')))).toBe(digest)
  })

  it('separates adjacent fragments so inputs cannot collide by concatenation', async () => {
    expect(await hashBenchmarkInputs('ab', benchmark()))
      .not.toBe(await hashBenchmarkInputs('a', benchmark()))
  })
})
