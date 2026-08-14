import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { importClaudeLog, importCodexLog, importTraceFile } from '../src/import.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-eval-import-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const CODEX_LOG = [
  '{"timestamp":"2026-08-14T00:00:00Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Fix the bug"}]}}',
  '{"timestamp":"2026-08-14T00:00:01Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Let me look"}]}}',
  '{"timestamp":"2026-08-14T00:00:02Z","type":"response_item","payload":{"type":"function_call","call_id":"call_1","name":"bash","arguments":"{\\"command\\":\\"pwd\\"}"}}',
  '{"timestamp":"2026-08-14T00:00:03Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_1","output":"/repo"}}',
  '{"timestamp":"2026-08-14T00:00:04Z","type":"response_item","payload":{"type":"message","role":"assistant","content":{"type":"output_text","text":"Fixed"}}}',
  '{"timestamp":"2026-08-14T00:00:05Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Thanks"}]}}',
  '{"timestamp":"2026-08-14T00:00:06Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Welcome"}]}}',
  '{"type":"event_msg","payload":{"level":"info","message":"skip me"}}',
  'this line is not json',
  '',
].join('\n')

const CLAUDE_LOG = [
  '{"type":"user","message":{"role":"user","content":"Fix the bug"}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Checking"},{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"pwd"}}]}}',
  '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"/repo","is_error":false}]}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Fixed"}]}}',
  '{"type":"user","message":{"role":"user","content":"Thanks"}}',
  '{"type":"summary","summary":"ignored"}',
  'this line is not json',
  '',
].join('\n')

const CODEX_EDGE_LOG = [
  '42',
  '"bare string"',
  '{"timestamp":"2026-08-14T00:00:00Z","type":"response_item","payload":{"type":"message","role":"user","content":"x"}}',
  '{"timestamp":"2026-08-14T00:00:01Z","type":"response_item","payload":{"type":"message","role":"assistant","content":["plain string",{"type":"output_text"},{"type":"output_text","text":"hi"}]}}',
  '{"timestamp":"2026-08-14T00:00:02Z","type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"think"}]}}',
  '{"timestamp":"2026-08-14T00:00:03Z","type":"response_item","payload":{"type":"function_call"}}',
  '{"timestamp":"2026-08-14T00:00:04Z","type":"response_item","payload":{"type":"function_call_output","content":"out"}}',
  '',
].join('\n')

const CLAUDE_EDGE_LOG = [
  '42',
  '{"type":"user","message":{"role":"user","content":"hi"}}',
  '{"type":"assistant","message":{"role":"assistant","content":"plain string"}}',
  '{"type":"assistant","message":{"role":"assistant","content":{"type":"text","text":"obj"}}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},"raw string",{"type":"tool_use"},{"type":"text"}]}}',
  '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}',
  '',
].join('\n')

describe('dsh-eval cross-harness import', () => {
  it('imports a Codex session log with turns, tools, and latency', () => {
    const trace = importCodexLog(CODEX_LOG, 'session.jsonl')
    const metrics = trace.events.reduce(
      (acc, event) => {
        if (event.type === 'tool/call') acc.calls += 1
        if (event.type === 'tool/result') acc.results += 1
        return acc
      },
      { calls: 0, results: 0 },
    )
    expect(String(trace.sessionId)).toBe('session.jsonl')
    expect(trace.events.filter(event => event.type === 'step/end')).toHaveLength(2)
    expect(trace.events.filter(event => event.type === 'user/message')).toHaveLength(2)
    expect(metrics.calls).toBe(1)
    expect(metrics.results).toBe(1)
  })

  it('imports a Claude Code session log with tool_use/tool_result pairing', () => {
    const trace = importClaudeLog(CLAUDE_LOG, 'claude.jsonl')
    const calls = trace.events.filter(event => event.type === 'tool/call')
    const results = trace.events.filter(event => event.type === 'tool/result')
    expect(String(trace.sessionId)).toBe('claude.jsonl')
    expect(calls).toHaveLength(1)
    expect(results).toHaveLength(1)
    expect(calls[0]?.data.name).toBe('Bash')
    expect(trace.events.filter(event => event.type === 'assistant/message')).toHaveLength(2)
  })

  it('builds a one-trial run with folded metrics from a file', async () => {
    const dir = tempDir()
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, CODEX_LOG)
    const run = await importTraceFile('codex', path, 'case-imported')
    expect(run.benchmark).toBe('import:codex')
    expect(run.cases).toHaveLength(1)
    expect(run.cases[0]?.status).toBe('completed')
    expect(run.cases[0]?.metrics?.toolSuccessRate).toBe(1)
    expect(run.aggregate?.steps).toBe(2)
    expect(run.aggregate?.latencyMs).toBeGreaterThan(0)
  })

  it('handles malformed and partial Codex records', () => {
    const trace = importCodexLog(CODEX_EDGE_LOG, 'session.jsonl')
    expect(trace.events.filter(event => event.type === 'user/message')).toHaveLength(1)
    expect(trace.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
    const calls = trace.events.filter(event => event.type === 'tool/call')
    const results = trace.events.filter(event => event.type === 'tool/result')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.data.name).toBe('tool')
    expect(results).toHaveLength(1)
    expect(String(results[0]?.data.message.source.callId)).toBe('codex-call-2')
  })

  it('handles malformed and partial Claude records', () => {
    const trace = importClaudeLog(CLAUDE_EDGE_LOG, 'claude.jsonl')
    expect(trace.events.filter(event => event.type === 'tool/call')).toHaveLength(1)
    expect(trace.events.filter(event => event.type === 'tool/result')).toHaveLength(1)
    expect(trace.events.filter(event => event.type === 'assistant/message')).toHaveLength(2)
  })

  it('falls back to a stable synthetic session id', () => {
    const trace = importCodexLog('{"type":"response_item","payload":{"type":"message","role":"user","content":"x"}}', '---')
    expect(String(trace.sessionId)).toBe('imported')
  })

  it('imports a Claude Code log through the file importer', async () => {
    const dir = tempDir()
    const path = join(dir, 'claude.jsonl')
    writeFileSync(path, CLAUDE_LOG)
    const run = await importTraceFile('claude-code', path, 'case-claude')
    expect(run.benchmark).toBe('import:claude-code')
    expect(run.cases[0]?.metrics?.toolSuccessRate).toBe(1)
  })
})
