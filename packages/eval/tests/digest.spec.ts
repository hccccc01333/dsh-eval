import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hashBenchmarkInputs, hashBenchmarkOverrides } from '../src/digest.ts'
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
    writeFileSync(join(workspace, 'z.txt'), 'z')
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

  it('follows symlinks so fixture content changes change the digest', async () => {
    const dir = tempDir()
    const workspace = join(dir, 'workspace')
    const target = join(dir, 'target')
    mkdirSync(workspace)
    mkdirSync(target)
    writeFileSync(join(target, 'fixture.txt'), 'original')
    symlinkSync(target, join(workspace, 'link'), 'junction')
    const first = await hashBenchmarkInputs('yaml', benchmark(workspace))
    writeFileSync(join(target, 'fixture.txt'), 'changed')
    expect(await hashBenchmarkInputs('yaml', benchmark(workspace))).not.toBe(first)
  })

  it('excludes output artifacts from the digest', async () => {
    const dir = tempDir()
    const workspace = join(dir, 'workspace')
    mkdirSync(workspace)
    writeFileSync(join(workspace, 'input.txt'), 'input')
    const output = join(workspace, 'run.json')
    const digest = await hashBenchmarkInputs('yaml', benchmark(workspace), { excludePaths: [output] })
    writeFileSync(output, '{"benchmarkSha256":"first"}')
    expect(await hashBenchmarkInputs('yaml', benchmark(workspace), { excludePaths: [output] })).toBe(digest)
    expect(await hashBenchmarkInputs('yaml', benchmark(workspace), {
      excludePaths: [relative(process.cwd(), output)],
    })).toBe(digest)
    expect(await hashBenchmarkInputs('yaml', benchmark(workspace))).not.toBe(digest)
  })

  it('does not recurse forever through a symlink cycle', async () => {
    const dir = tempDir()
    const workspace = join(dir, 'workspace')
    mkdirSync(workspace)
    writeFileSync(join(workspace, 'a.txt'), 'a')
    symlinkSync(workspace, join(workspace, 'loop'), 'junction')
    const digest = await hashBenchmarkInputs('yaml', benchmark(workspace))
    expect(digest).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('hashes missing paths without failing validation', async () => {
    const dir = tempDir()
    const digest = await hashBenchmarkInputs('yaml', benchmark(join(dir, 'absent')))
    expect(digest).toMatch(/^[0-9a-f]{64}$/u)
    expect(await hashBenchmarkInputs('yaml', benchmark(join(dir, 'absent')))).toBe(digest)
  })

  it('keeps pre-seed override digests byte-identical', () => {
    const base = 'b'.repeat(64)
    const legacy = createHash('sha256')
    for (const [label, value] of [
      ['benchmark-sha256', base],
      ['trials', '2'], ['concurrency', '2'], ['profile', 'headless'], ['dshCommand', ''],
    ]) legacy.update(`${label}\0${value}\0`)
    expect(hashBenchmarkOverrides(base, {
      trials: 2, concurrency: 2, profile: 'headless',
    })).toBe(legacy.digest('hex'))
  })

  it('folds CLI overrides into a distinct, deterministic digest', async () => {
    const base = 'a'.repeat(64)
    const first = hashBenchmarkOverrides(base, { trials: 2, concurrency: 2, profile: 'headless' })
    expect(first).toBe(hashBenchmarkOverrides(base, { trials: 2, concurrency: 2, profile: 'headless' }))
    expect(hashBenchmarkOverrides(base, { trials: 3, concurrency: 2, profile: 'headless' })).not.toBe(first)
    expect(hashBenchmarkOverrides(base, { dshCommand: ['dsh'] })).not.toBe(first)
    expect(hashBenchmarkOverrides(base, { seed: 7 })).not.toBe(first)
    expect(hashBenchmarkOverrides(base, { seed: 7 })).toBe(hashBenchmarkOverrides(base, { seed: 7 }))
    expect(hashBenchmarkOverrides(base, {})).not.toBe(first)
  })

  it('separates adjacent fragments so inputs cannot collide by concatenation', async () => {
    expect(await hashBenchmarkInputs('ab', benchmark()))
      .not.toBe(await hashBenchmarkInputs('a', benchmark()))
  })
})
