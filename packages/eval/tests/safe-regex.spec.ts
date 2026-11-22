import { describe, expect, it } from 'vitest'
import { safeRegexTest } from '../src/safe-regex.ts'

describe('dsh-eval time-boxed regex', () => {
  it('returns the match result for ordinary patterns', async () => {
    expect(await safeRegexTest('answer\\s+42', 'the answer 42')).toBe(true)
    expect(await safeRegexTest('^done$', 'still running')).toBe(false)
  })

  it('reports invalid patterns without escaping the worker', async () => {
    await expect(safeRegexTest('(', 'text')).rejects.toThrow('regex failed')
  })

  it('terminates a catastrophic backtracking pattern', async () => {
    const started = Date.now()
    await expect(safeRegexTest('(a+)+$', `${'a'.repeat(32)}!`, 200))
      .rejects.toThrow('regex timed out')
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
