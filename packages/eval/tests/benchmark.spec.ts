import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadBenchmark, parseBenchmark } from '../src/benchmark.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-eval-benchmark-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('dsh-eval benchmark loading', () => {
  it('loads a document with defaults and resolves relative paths', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'prompt.md'), 'Fix the tests.')
    writeFileSync(join(dir, 'seed.txt'), 'seed')
    writeFileSync(join(dir, 'benchmark.yml'), [
      'name: skill-regression',
      'model: deepseek-v4',
      'cases:',
      '  - id: fix-tests-001',
      '    promptFile: prompt.md',
      '    workspace: seed.txt',
      '    expected:',
      '      tool: bash',
      '      check: ./check.sh',
      'pricing:',
      '  deepseek-v4:',
      '    inputUsdPerMTokens: 0.27',
      '    cacheReadUsdPerMTokens: 0.07',
      '    cacheWriteUsdPerMTokens: 0.27',
      '    outputUsdPerMTokens: 1.10',
      '',
    ].join('\n'))
    const benchmark = await loadBenchmark(join(dir, 'benchmark.yml'))
    expect(benchmark.name).toBe('skill-regression')
    expect(benchmark.model).toBe('deepseek-v4')
    expect(benchmark.profile).toBe('headless')
    expect(benchmark.command).toEqual(['dsh'])
    expect(benchmark.trials).toBe(1)
    expect(benchmark.timeoutMs).toBe(600_000)
    expect(benchmark.seed).toBe(0)
    expect(benchmark.baseDir).toBe(dir)
    expect(benchmark.cases).toEqual([
      {
        id: 'fix-tests-001',
        prompt: 'Fix the tests.',
        workspace: join(dir, 'seed.txt'),
        expected: { tool: 'bash', check: './check.sh' },
      },
    ])
    expect(benchmark.pricing?.['deepseek-v4']).toEqual({
      inputUsdPerMTokens: 0.27,
      cacheReadUsdPerMTokens: 0.07,
      cacheWriteUsdPerMTokens: 0.27,
      outputUsdPerMTokens: 1.10,
    })
  })

  it('keeps absolute workspace paths and inline prompts as-is', async () => {
    const dir = tempDir()
    const absolute = join(dir, 'abs')
    const benchmark = await parseBenchmark([
      'name: abs',
      'model: m',
      'trials: 3',
      'timeoutMs: 500',
      'seed: 7',
      'profile: custom',
      'command: [pnpm, dsh]',
      `cases:\n  - id: a\n    prompt: inline\n    workspace: ${absolute}`,
      '',
    ].join('\n'), dir)
    expect(benchmark.profile).toBe('custom')
    expect(benchmark.command).toEqual(['pnpm', 'dsh'])
    expect(benchmark.trials).toBe(3)
    expect(benchmark.timeoutMs).toBe(500)
    expect(benchmark.seed).toBe(7)
    expect(benchmark.cases[0]).toEqual({ id: 'a', prompt: 'inline', workspace: absolute })
  })

  it('keeps tool-only and check-only expectations', async () => {
    const dir = tempDir()
    const toolOnly = await parseBenchmark([
      'name: tool-only',
      'model: m',
      'cases:',
      '  - id: a',
      '    prompt: p',
      '    expected:',
      '      tool: bash',
      '',
    ].join('\n'), dir)
    expect(toolOnly.cases[0]?.expected).toEqual({ tool: 'bash' })
    const checkOnly = await parseBenchmark([
      'name: check-only',
      'model: m',
      'cases:',
      '  - id: a',
      '    prompt: p',
      '    expected:',
      '      check: ./check.sh',
      '',
    ].join('\n'), dir)
    expect(checkOnly.cases[0]?.expected).toEqual({ check: './check.sh' })
  })

  it('parses judge configuration with defaults', async () => {
    const benchmark = await parseBenchmark([
      'name: judged',
      'model: deepseek-v4',
      'judge:',
      '  rubric: Be strict.',
      '  maxScore: 5',
      'cases:',
      '  - id: a',
      '    prompt: p',
      '',
    ].join('\n'), tempDir())
    expect(benchmark.judge).toEqual({
      provider: 'deepseek',
      model: 'deepseek-v4',
      rubric: 'Be strict.',
      maxScore: 5,
    })
  })

  it('keeps explicit judge provider and model', async () => {
    const benchmark = await parseBenchmark([
      'name: judged',
      'model: deepseek-v4',
      'judge:',
      '  provider: other',
      '  model: judge-x',
      'cases:',
      '  - id: a',
      '    prompt: p',
      '',
    ].join('\n'), tempDir())
    expect(benchmark.judge).toEqual({ provider: 'other', model: 'judge-x', maxScore: 10 })
  })

  it('rejects an invalid judge maxScore', async () => {
    await expect(parseBenchmark([
      'name: judged',
      'model: m',
      'judge:',
      '  maxScore: 0',
      'cases:',
      '  - id: a',
      '    prompt: p',
      '',
    ].join('\n'), tempDir())).rejects.toThrow()
  })

  it('parses replay configuration and resolves its directory', async () => {
    const dir = tempDir()
    const benchmark = await parseBenchmark([
      'name: replayed',
      'model: m',
      'replay:',
      '  dir: ./replays',
      'cases:',
      '  - id: a',
      '    prompt: p',
      '',
    ].join('\n'), dir)
    expect(benchmark.replay).toEqual({ dir: join(dir, 'replays') })
  })

  it('keeps an absolute replay directory as-is', async () => {
    const dir = tempDir()
    const absolute = join(dir, 'replays')
    const benchmark = await parseBenchmark([
      'name: replayed',
      'model: m',
      'replay:',
      `  dir: ${absolute}`,
      'cases:',
      '  - id: a',
      '    prompt: p',
      '',
    ].join('\n'), dir)
    expect(benchmark.replay).toEqual({ dir: absolute })
  })

  it.each([
    { name: 'empty', text: '', message: 'must be a YAML mapping' },
    { name: 'missing name', text: 'model: m\ncases:\n  - id: a\n    prompt: p\n', message: '' },
    { name: 'both prompt sources', text: 'name: n\nmodel: m\ncases:\n  - id: a\n    prompt: p\n    promptFile: x.md\n', message: 'exactly one of prompt or promptFile' },
    { name: 'unknown key', text: 'name: n\nmodel: m\nbogus: 1\ncases:\n  - id: a\n    prompt: p\n', message: '' },
    { name: 'no cases', text: 'name: n\nmodel: m\ncases: []\n', message: '' },
    { name: 'empty expected', text: 'name: n\nmodel: m\ncases:\n  - id: a\n    prompt: p\n    expected: {}\n', message: 'expected needs at least one of tool or check' },
  ])('rejects an invalid document ($name)', async ({ text, message }) => {
    if (message === '') {
      await expect(parseBenchmark(text, tempDir())).rejects.toThrow()
    } else {
      await expect(parseBenchmark(text, tempDir())).rejects.toThrow(message)
    }
  })

  it('rejects missing prompt files and invalid YAML', async () => {
    const dir = tempDir()
    await expect(parseBenchmark('name: n\nmodel: m\ncases:\n  - id: a\n    promptFile: nope.md\n', dir))
      .rejects.toThrow()
    await expect(parseBenchmark('name: n\nmodel: m\ncases:\n  - id: a\n    prompt: [unclosed\n', dir))
      .rejects.toThrow()
  })

  it('rejects a missing benchmark file', async () => {
    await expect(loadBenchmark(join(tempDir(), 'missing.yml'))).rejects.toThrow()
  })
})
