import { describe, expect, it } from 'vitest'
import { splitArgv } from '../src/argv.ts'

describe('splitArgv', () => {
  it('handles whitespace, quotes, escapes and empty values', () => {
    expect(splitArgv('  node   "my script.mjs"  --flag "a b"  '))
      .toEqual(['node', 'my script.mjs', '--flag', 'a b'])
    expect(splitArgv("cmd 'single quoted'")).toEqual(['cmd', 'single quoted'])
    expect(splitArgv('cmd a\\ b')).toEqual(['cmd', 'a b'])
    expect(splitArgv('cmd "say \\"hi\\""')).toEqual(['cmd', 'say "hi"'])
    expect(splitArgv('   ')).toEqual([])
    expect(splitArgv('')).toEqual([])
  })

  it('rejects an unterminated quote', () => {
    expect(() => splitArgv('cmd "open')).toThrow('unterminated quote')
  })
})
