import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { findPrimarySessionLog, findSessionLogs, loadTrace, mergeTraces, parseSessionLog } from '../src/trace.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-eval-trace-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const FIXTURE = fileURLToPath(new URL('./fixtures/session.jsonl', import.meta.url))

const HEADER = '{"type":"session","version":0,"id":"session-t","createdAt":1,"delegationDepth":0}'

describe('dsh-eval trace parsing', () => {
  it('parses the fixture log into a trace with contiguous events', async () => {
    const trace = await loadTrace(FIXTURE)
    expect(String(trace.sessionId)).toBe('session-eval-fixture')
    expect(trace.createdAt).toBe(1700000000000)
    expect(trace.events).toHaveLength(10)
    expect(trace.events.map(event => event.type)).toEqual([
      'turn/start', 'user/message', 'step/start', 'assistant/chunk', 'assistant/message',
      'tool/call', 'tool/result', 'llm/retry', 'step/end', 'turn/end',
    ])
  })

  it('expands packed chunk rows through the storage decoder', () => {
    const packed = '{"type":"text-chunks","seq0":0,"time0":10,'
      + '"data":{"turn":0,"step":0,"index":0,"dt":[2],"texts":["Hi","!"]}}'
    const trace = parseSessionLog(`${HEADER}\n${packed}\n`)
    expect(trace.events).toEqual([
      { seq: 0, type: 'assistant/chunk', time: 10, data: { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'Hi' } } },
      { seq: 1, type: 'assistant/chunk', time: 12, data: { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: '!' } } },
    ])
  })

  it('rejects an empty log', () => {
    expect(() => parseSessionLog('')).toThrow('empty session log')
  })

  it('rejects a malformed header', () => {
    expect(() => parseSessionLog('{"type":"nope"}\n')).toThrow()
  })

  it('rejects an unparsable event row', () => {
    expect(() => parseSessionLog(`${HEADER}\nnot json\n`)).toThrow('invalid JSON at line 2')
  })

  it('rejects a seq gap', () => {
    const row = '{"seq":5,"type":"step/end","time":2,"data":{"turn":0,"step":0}}'
    expect(() => parseSessionLog(`${HEADER}\n${row}\n`)).toThrow('seq gap at line 2 (expected 0, got 5)')
  })
})

describe('dsh-eval primary-log discovery', () => {
  it('returns null for a missing or empty root', async () => {
    expect(await findPrimarySessionLog(join(tempDir(), 'absent'))).toBeNull()
    expect(await findPrimarySessionLog(tempDir())).toBeNull()
  })

  it('finds the newest primary log in a nested tree', async () => {
    const root = tempDir()
    const newestDir = join(root, 'a')
    const olderDir = join(root, 'b')
    const emptyDir = join(root, 'c')
    mkdirSync(newestDir, { recursive: true })
    mkdirSync(olderDir, { recursive: true })
    mkdirSync(emptyDir, { recursive: true })
    writeFileSync(join(root, 'stray.txt'), 'not a log')
    const newest = join(newestDir, 'session.jsonl')
    const older = join(olderDir, 'session.jsonl')
    writeFileSync(newest, `${HEADER}\n`)
    writeFileSync(older, `${HEADER}\n`)
    // Alphabetical iteration visits a (newest) before b (older), exercising the
    // keep-existing branch; c has no log and stray.txt is not a primary log.
    utimesSync(newest, new Date(3000), new Date(3000))
    utimesSync(older, new Date(1000), new Date(1000))
    expect(await findPrimarySessionLog(root)).toBe(newest)
  })

  it('keeps an existing top-level log when a newer log is nested', async () => {
    const root = tempDir()
    const nestedDir = join(root, 'a')
    mkdirSync(nestedDir, { recursive: true })
    const nested = join(nestedDir, 'session.jsonl')
    const top = join(root, 'session.jsonl')
    writeFileSync(nested, `${HEADER}\n`)
    writeFileSync(top, `${HEADER}\n`)
    // readdir visits the nested directory before the top-level file, so the
    // file comparison must keep the newer nested log.
    utimesSync(nested, new Date(3000), new Date(3000))
    utimesSync(top, new Date(1000), new Date(1000))
    expect(await findPrimarySessionLog(root)).toBe(nested)
  })
})

describe('dsh-eval session-log merging', () => {
  it('finds every session log in ascending mtime order', async () => {
    expect(await findSessionLogs(join(tempDir(), 'absent'))).toEqual([])
    const root = tempDir()
    const firstDir = join(root, 'a')
    const secondDir = join(root, 'b')
    mkdirSync(firstDir, { recursive: true })
    mkdirSync(secondDir, { recursive: true })
    const first = join(firstDir, 'session.jsonl')
    const second = join(secondDir, 'session.jsonl')
    writeFileSync(first, `${HEADER}\n`)
    writeFileSync(second, `${HEADER}\n`)
    writeFileSync(join(root, 'stray.txt'), 'not a log')
    utimesSync(first, new Date(1000), new Date(1000))
    utimesSync(second, new Date(3000), new Date(3000))
    expect(await findSessionLogs(root)).toEqual([first, second])
  })

  it('finds a flat top-level log', async () => {
    const root = tempDir()
    const top = join(root, 'session.jsonl')
    writeFileSync(top, `${HEADER}\n`)
    expect(await findSessionLogs(root)).toEqual([top])
  })

  it('merges traces into one timeline sorted by event time', () => {
    const primary = parseSessionLog(
      `${HEADER}\n{"seq":0,"type":"step/end","time":10,"data":{"turn":0,"step":0}}\n`,
    )
    const child = parseSessionLog(
      '{"type":"session","version":0,"id":"child","createdAt":5,"delegationDepth":1}\n'
      + '{"seq":0,"type":"step/end","time":20,"data":{"turn":0,"step":0}}\n',
    )
    const merged = mergeTraces([primary, child])
    expect(String(merged.sessionId)).toBe('session-t')
    expect(merged.createdAt).toBe(1)
    expect(merged.events.map(event => event.time)).toEqual([10, 20])
  })

  it('breaks event-time ties by source order', () => {
    const primary = parseSessionLog(
      `${HEADER}\n{"seq":0,"type":"step/end","time":10,"data":{"turn":0,"step":0}}\n`,
    )
    const child = parseSessionLog(
      '{"type":"session","version":0,"id":"child","createdAt":5,"delegationDepth":1}\n'
      + '{"seq":0,"type":"step/end","time":10,"data":{"turn":1,"step":0}}\n',
    )
    const merged = mergeTraces([primary, child])
    expect(merged.events.filter(event => event.type === 'step/end').map(event => event.data.turn)).toEqual([0, 1])
  })

  it('rejects merging zero traces', () => {
    expect(() => mergeTraces([])).toThrow('requires at least one trace')
  })
})
