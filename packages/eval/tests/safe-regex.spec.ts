import { describe, expect, it } from 'vitest'
import { safeRegexTest, safeRegexTestAny } from '../src/safe-regex.ts'

describe('dsh-eval time-boxed regex', () => {
  it('returns the match result for ordinary patterns', async () => {
    // Worker startup can be slow on a saturated CI machine; these are benign
    // patterns, so give them a budget that measures correctness, not load.
    expect(await safeRegexTest('answer\\s+42', 'the answer 42', 5000)).toBe(true)
    expect(await safeRegexTest('^done$', 'still running', 5000)).toBe(false)
  })

  it('tests a batch of inputs in one worker', async () => {
    expect(await safeRegexTestAny('^read_', ['list', 'read_file', 'write_file'], 5000)).toBe(true)
    expect(await safeRegexTestAny('^read_', ['list', 'write_file'], 5000)).toBe(false)
    expect(await safeRegexTestAny('^read_', [], 5000)).toBe(false)
  })

  it('does not let a pathological input hide a later match', async () => {
    const pattern = '^(a+)+b$|read_file'
    // A larger budget and seed keep this deterministic under parallel CI load:
    // the first input still times out, while the later one has startup headroom.
    expect(await safeRegexTestAny(pattern, [`${'a'.repeat(30)}!`, 'read_file'], 1000)).toBe(true)
  })

  it('does not time out benign patterns under high concurrency', async () => {
    const results = await Promise.all(Array.from({ length: 32 }, () =>
      safeRegexTestAny('^read_', ['list', 'read_file'], 5000)))
    expect(results).toHaveLength(32)
    expect(results.every(Boolean)).toBe(true)
  })

  it('reports invalid patterns without escaping the worker', async () => {
    await expect(safeRegexTest('(', 'text')).rejects.toThrow('regex failed')
  })

  it('degrades an invalid batch pattern to no match after per-input fallback', async () => {
    expect(await safeRegexTestAny('(', ['text', 'more'], 200)).toBe(false)
  })

  it('terminates a catastrophic backtracking pattern', async () => {
    const started = Date.now()
    await expect(safeRegexTest('(a+)+$', `${'a'.repeat(32)}!`, 200))
      .rejects.toThrow('regex timed out')
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
