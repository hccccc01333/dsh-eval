import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  it('loads the documented minimal example without any fixture files', async () => {
    const benchmark = await loadBenchmark(join(import.meta.dirname, '..', '..', '..', 'examples', 'minimal-benchmark.yaml'))
    expect(benchmark.name).toBe('quickstart')
    expect(benchmark.cases).toHaveLength(1)
    expect(benchmark.cases[0]?.expected?.answerRegex).toBe('^pong$')
    expect(benchmark.cases[0]?.workspace).toBeUndefined()
  })

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
    const originalDigest = benchmark.sourceSha256
    expect(originalDigest).toMatch(/^[0-9a-f]{64}$/u)
    writeFileSync(join(dir, 'prompt.md'), 'Fix the tests. Changed.')
    const changed = await loadBenchmark(join(dir, 'benchmark.yml'))
    expect(changed.sourceSha256).not.toBe(originalDigest)
    expect(benchmark.model).toBe('deepseek-v4')
    expect(benchmark.profile).toBe('headless')
    expect(benchmark.command).toEqual(['dsh'])
    expect(benchmark.trials).toBe(1)
    expect(benchmark.concurrency).toBe(1)
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

  it('loads per-case timeout overrides', async () => {
    const benchmark = await parseBenchmark([
      'name: timeouts',
      'model: m',
      'timeoutMs: 5000',
      'cases:',
      '  - id: slow',
      '    prompt: p',
      '    timeoutMs: 1200',
      '  - id: normal',
      '    prompt: q',
    ].join('\n'), tempDir())
    expect(benchmark.timeoutMs).toBe(5000)
    expect(benchmark.cases[0]?.timeoutMs).toBe(1200)
    expect(benchmark.cases[1]?.timeoutMs).toBeUndefined()
    await expect(parseBenchmark([
      'name: bad',
      'model: m',
      'cases:',
      '  - id: slow',
      '    prompt: p',
      '    timeoutMs: 0',
    ].join('\n'), tempDir())).rejects.toThrow()
  })

  it('loads richer tool expectations and rejects invalid regexes', async () => {
    const benchmark = await parseBenchmark([
      'name: tools',
      'model: m',
      'cases:',
      '  - id: all',
      '    prompt: p',
      '    expected:',
      '      tools: [bash, read]',
      '      toolAnyOf: [bash, edit]',
      '      toolRegex: "^(bash|read)$"',
      '      toolNot: [danger]',
    ].join('\n'), tempDir())
    expect(benchmark.cases[0]?.expected).toEqual({
      tools: ['bash', 'read'],
      toolAnyOf: ['bash', 'edit'],
      toolRegex: '^(bash|read)$',
      toolNot: ['danger'],
    })
    await expect(parseBenchmark([
      'name: tools',
      'model: m',
      'cases:',
      '  - id: bad',
      '    prompt: p',
      '    expected:',
      '      toolRegex: "["',
    ].join('\n'), tempDir())).rejects.toThrow('toolRegex is not a valid regular expression')
  })

  it('validates and preserves a deterministic answer regex', async () => {
    const benchmark = await parseBenchmark([
      'name: answers',
      'model: m',
      'cases:',
      '  - id: good',
      '    prompt: p',
      '    expected:',
      '      answerRegex: "^42$"',
    ].join('\n'), tempDir())
    expect(benchmark.cases[0]?.expected?.answerRegex).toBe('^42$')
    await expect(parseBenchmark([
      'name: answers',
      'model: m',
      'cases:',
      '  - id: bad',
      '    prompt: p',
      '    expected:',
      '      answerRegex: "["',
    ].join('\n'), tempDir())).rejects.toThrow('answerRegex is not a valid regular expression')
  })

  it('preserves structured and shell check modes', async () => {
    const benchmark = await parseBenchmark([
      'name: checks',
      'model: m',
      'cases:',
      '  - id: argv',
      '    prompt: p',
      '    expected:',
      '      checkArgv: [node, check.mjs, "a b"]',
      '  - id: shell',
      '    prompt: q',
      '    expected:',
      '      checkShell: "npm test > result.txt"',
    ].join('\n'), tempDir())
    expect(benchmark.cases[0]?.expected).toEqual({ checkArgv: ['node', 'check.mjs', 'a b'] })
    expect(benchmark.cases[1]?.expected).toEqual({ checkShell: 'npm test > result.txt' })
  })

  it('rejects referenced paths that escape the benchmark directory', async () => {
    const dir = tempDir()
    const base = [
      'name: escape',
      'model: m',
      'cases:',
      '  - id: a',
      '    prompt: inline',
      `    workspace: ${join(dir, '..', 'outside')}`,
      '',
    ].join('\n')
    await expect(parseBenchmark(base, dir)).rejects.toThrow('escapes the benchmark directory')
    await expect(parseBenchmark(base.replace('workspace:', 'promptFile:').replace('    prompt: inline\n', ''), dir))
      .rejects.toThrow('escapes the benchmark directory')
    await expect(parseBenchmark([
      'name: escape',
      'model: m',
      'replay:',
      `  dir: ${join(dir, '..', 'outside')}`,
      'cases:',
      '  - id: a',
      '    prompt: p',
      '',
    ].join('\n'), dir)).rejects.toThrow('escapes the benchmark directory')
    await expect(parseBenchmark(base, dir)).rejects.toThrow('--allow-external-paths')
  })

  it('ignores an external-path opt-in embedded in the benchmark document', async () => {
    const dir = tempDir()
    const benchmark = [
      'name: escape',
      'model: m',
      'allowExternalPaths: true',
      'cases:',
      '  - id: a',
      '    prompt: inline',
      `    workspace: ${join(dir, '..', 'outside')}`,
      '',
    ].join('\n')
    await expect(parseBenchmark(benchmark, dir))
      .rejects.toThrow('escapes the benchmark directory')
  })

  it('accepts the benchmark directory itself as a workspace', async () => {
    const dir = tempDir()
    const benchmark = await parseBenchmark([
      'name: local',
      'model: m',
      'cases:',
      '  - id: a',
      '    prompt: p',
      '    workspace: .',
      '',
    ].join('\n'), dir)
    expect(benchmark.cases[0]?.workspace).toBe(dir)
  })

  it('rejects prompt files reached through a symlink outside the directory', async () => {
    const dir = tempDir()
    const outside = tempDir()
    writeFileSync(join(outside, 'secret.md'), 'classified')
    symlinkSync(outside, join(dir, 'link'), 'junction')
    await expect(parseBenchmark([
      'name: escape',
      'model: m',
      'cases:',
      '  - id: a',
      '    promptFile: link/secret.md',
      '',
    ].join('\n'), dir)).rejects.toThrow('escapes the benchmark directory')
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
      'concurrency: 4',
      `cases:\n  - id: a\n    prompt: inline\n    workspace: ${absolute}`,
      '',
    ].join('\n'), dir, { allowExternalPaths: true })
    expect(benchmark.profile).toBe('custom')
    expect(benchmark.command).toEqual(['pnpm', 'dsh'])
    expect(benchmark.trials).toBe(3)
    expect(benchmark.concurrency).toBe(4)
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
    const answerOnly = await parseBenchmark([
      'name: answer-only',
      'model: m',
      'cases:',
      '  - id: a',
      '    prompt: p',
      '    expected:',
      '      answer: "42"',
      '',
    ].join('\n'), dir)
    expect(answerOnly.cases[0]?.expected).toEqual({ answer: '42' })
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
    ].join('\n'), dir, { allowExternalPaths: true })
    expect(benchmark.replay).toEqual({ dir: absolute })
  })

  it.each([
    { name: 'empty', text: '', message: 'must be a YAML mapping' },
    { name: 'missing name', text: 'model: m\ncases:\n  - id: a\n    prompt: p\n', message: '' },
    { name: 'both prompt sources', text: 'name: n\nmodel: m\ncases:\n  - id: a\n    prompt: p\n    promptFile: x.md\n', message: 'exactly one of prompt or promptFile' },
    { name: 'unknown key', text: 'name: n\nmodel: m\nbogus: 1\ncases:\n  - id: a\n    prompt: p\n', message: '' },
    { name: 'no cases', text: 'name: n\nmodel: m\ncases: []\n', message: '' },
    { name: 'empty expected', text: 'name: n\nmodel: m\ncases:\n  - id: a\n    prompt: p\n    expected: {}\n', message: 'expected needs at least one of tool, tools, toolAnyOf, toolRegex, toolNot, check, checkArgv, checkShell, answer or answerRegex' },
     { name: 'multiple check modes', text: 'name: n\nmodel: m\ncases:\n  - id: a\n    prompt: p\n    expected:\n      check: echo hi\n      checkShell: echo hi\n', message: 'at most one of check, checkArgv or checkShell' },
    { name: 'zero concurrency', text: 'name: n\nmodel: m\nconcurrency: 0\ncases:\n  - id: a\n    prompt: p\n', message: '' },
    { name: 'fractional concurrency', text: 'name: n\nmodel: m\nconcurrency: 1.5\ncases:\n  - id: a\n    prompt: p\n', message: '' },
    { name: 'duplicate ids', text: 'name: n\nmodel: m\ncases:\n  - id: a\n    prompt: p\n  - id: a\n    prompt: q\n', message: 'collides with an earlier case' },
    { name: 'ids colliding after normalization', text: 'name: n\nmodel: m\ncases:\n  - id: a/b\n    prompt: p\n  - id: a b\n    prompt: q\n', message: 'collides with an earlier case' },
    { name: 'ids colliding on case-folding filesystems', text: 'name: n\nmodel: m\ncases:\n  - id: Case\n    prompt: p\n  - id: case\n    prompt: q\n', message: 'collides with an earlier case' },
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

  it('omits excluded artifacts from the provenance digest', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'fixture.txt'), 'fixture')
    const text = [
      'name: digest',
      'model: m',
      'cases:',
      '  - id: a',
      '    prompt: p',
      '    workspace: .',
      '',
    ].join('\n')
    const included = await parseBenchmark(text, dir)
    const excluded = await parseBenchmark(text, dir, { excludeFromDigest: [join(dir, 'fixture.txt')] })
    expect(excluded.sourceSha256).not.toBe(included.sourceSha256)
  })

  it('rejects a missing benchmark file', async () => {
    await expect(loadBenchmark(join(tempDir(), 'missing.yml'))).rejects.toThrow()
  })
})

describe('dsh-eval benchmark validation diagnostics', () => {
  it('reports a missing required field with a file label, path and readable hint', async () => {
    const invalid = parseBenchmark('model: m\ncases:\n  - id: a\n    prompt: p\n', tempDir())
    await expect(invalid).rejects.toBeInstanceOf(Error)
    await expect(invalid).rejects.toMatchObject({
      message: expect.stringContaining('benchmark.yaml: name:'),
    })
    await expect(invalid).rejects.toMatchObject({
      message: expect.stringMatching(/required/u),
    })
    await expect(invalid).rejects.toMatchObject({
      message: expect.not.stringContaining('issue'),
    })
    await expect(invalid).rejects.toMatchObject({
      message: expect.not.stringContaining('{'),
    })
    await expect(invalid).rejects.not.toHaveProperty('issues')
  })

  it('points a missing case prompt at the nested case path', async () => {
    const invalid = parseBenchmark('name: n\nmodel: m\ncases:\n  - id: a\n', tempDir())
    await expect(invalid).rejects.toMatchObject({
      message: expect.stringContaining('benchmark.yaml: cases.0.prompt:'),
    })
    await expect(invalid).rejects.toMatchObject({
      message: expect.stringContaining('exactly one of prompt or promptFile'),
    })
    await expect(invalid).rejects.toMatchObject({
      message: expect.not.stringContaining('issue'),
    })
  })

  it('explains unknown fields with a spelling hint instead of raw issue codes', async () => {
    const invalid = parseBenchmark('name: n\nmodel: m\nbogus: 1\ncases:\n  - id: a\n    prompt: p\n', tempDir())
    await expect(invalid).rejects.toMatchObject({
      message: expect.stringContaining('benchmark.yaml: (root): unknown field(s): `bogus`'),
    })
    await expect(invalid).rejects.toMatchObject({
      message: expect.stringContaining('check spelling / see field reference'),
    })
    await expect(invalid).rejects.toMatchObject({
      message: expect.not.stringContaining('issue'),
    })
    await expect(invalid).rejects.toMatchObject({
      message: expect.not.stringContaining('unrecognized_keys'),
    })
  })

  it('formats nested paths and joins several problems into one message', async () => {
    const invalid = parseBenchmark([
      'name: n',
      'model: m',
      'cases:',
      '  - id: a',
      '    prompt: p',
      '    timeoutMs: -1',
      '    expected:',
      '      mistyped: true',
      '',
    ].join('\n'), tempDir())
    await expect(invalid).rejects.toMatchObject({
      message: expect.stringContaining('benchmark.yaml: cases.0.timeoutMs:'),
    })
    await expect(invalid).rejects.toMatchObject({
      message: expect.stringContaining('benchmark.yaml: cases.0.expected: unknown field(s): `mistyped`'),
    })
    await expect(invalid).rejects.toMatchObject({
      message: expect.stringContaining('; benchmark.yaml:'),
    })
    await expect(invalid).rejects.toMatchObject({
      message: expect.not.stringContaining('issue'),
    })
  })

  it('keeps readable diagnostics for a wrong value type', async () => {
    const invalid = parseBenchmark('name: 42\nmodel: m\ncases:\n  - id: a\n    prompt: p\n', tempDir())
    await expect(invalid).rejects.toMatchObject({
      message: expect.stringContaining('benchmark.yaml: name:'),
    })
    await expect(invalid).rejects.toMatchObject({
      message: expect.not.stringContaining('issue'),
    })
  })

  it('labels loadBenchmark errors with the file path the caller supplied', async () => {
    const dir = tempDir()
    const file = join(dir, 'benchmark.yaml')
    writeFileSync(file, 'model: m\ncases:\n  - id: a\n    prompt: p\n')
    await expect(loadBenchmark(file)).rejects.toMatchObject({
      message: expect.stringContaining(`${file}: name:`),
    })
  })
})
