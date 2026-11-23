import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeTextAtomic } from '../src/atomic-write.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-eval-atomic-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('dsh-eval atomic text output', () => {
  it('writes through a symlinked parent without replacing the link', async () => {
    const dir = tempDir()
    const real = join(dir, 'real')
    const alias = join(dir, 'alias')
    mkdirSync(real)
    symlinkSync(real, alias, 'junction')
    const path = join(alias, 'out.txt')
    await writeTextAtomic(path, 'first')
    expect(readFileSync(join(real, 'out.txt'), 'utf8')).toBe('first')
    await writeTextAtomic(path, 'second')
    expect(readFileSync(join(real, 'out.txt'), 'utf8')).toBe('second')
    expect(lstatSync(alias).isSymbolicLink()).toBe(true)
  })
})
