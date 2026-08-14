/**
 * Cross-harness trace import: Codex and Claude Code session JSONL become the
 * eval trace vocabulary so report and compare can fold metrics over runs
 * recorded by other agents. Each importer synthesizes one turn (and one step)
 * per user message, preserving assistant text and tool calls/results; model
 * token usage is not part of either external format, so token metrics stay
 * zero.
 *
 * @module dsh-eval/import
 */

import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { computeMetrics } from './metrics.ts'
import { parseSessionLog } from './trace.ts'
import type { EvalRun, EvalTrace } from './types.ts'

/** Synthetic event-time spacing keeps imported metrics deterministic. */
const STEP_MS = 1000
/** Epoch base for imported traces without a real timestamp. */
const BASE_MS = 1_700_000_000_000

/** A pending event row before seq/time assignment. */
interface ParsedEvent {
  type: string
  data: unknown
}

/** Join an external-log line's timestamp (ISO or epoch) with a synthetic offset. */
function eventTime(lineIndex: number): number {
  return BASE_MS + lineIndex * STEP_MS
}

/** Extract display text from a string, a text block, or a block array. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.flatMap((block) => {
      if (typeof block !== 'object' || block === null) return []
      const text = (block as Record<string, unknown>).text
      return typeof text === 'string' ? [text] : []
    }).join('')
  }
  return ''
}

/** Stable synthetic session id from the source filename. */
function sessionIdFrom(source: string): string {
  const safe = basename(source).replace(/[^A-Za-z0-9._-]/gu, '-').replace(/^-+|-+$/gu, '')
  return safe === '' ? 'imported' : safe
}

/** Assemble parsed events into a validated trace with contiguous seqs. */
function assembleTrace(events: readonly ParsedEvent[], id: string): EvalTrace {
  const lines = [
    JSON.stringify({ type: 'session', version: 0, id, createdAt: eventTime(0), delegationDepth: 0 }),
    ...events.map((event, index) => JSON.stringify({ seq: index, time: eventTime(index + 1), type: event.type, data: event.data })),
    '',
  ]
  return parseSessionLog(lines.join('\n'))
}

/** Close the current synthesized turn with step/end and turn/end. */
function closeTurn(
  events: ParsedEvent[],
  turn: number,
  step: number,
  open: boolean,
): boolean {
  if (!open) return false
  events.push({ type: 'step/end', data: { turn, step } })
  events.push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  return true
}

/**
 * Import a Codex session JSONL (lines of `response_item` records) as a trace.
 * @param text - the Codex log's UTF-8 text.
 * @param source - the source file path, used for the synthetic session id.
 * @returns the imported trace; non-`response_item` lines are skipped.
 */
export function importCodexLog(text: string, source: string): EvalTrace {
  const events: ParsedEvent[] = []
  let turn = 0
  let step = 0
  let open = false
  let callCounter = 0
  let messageCounter = 0
  const close = (): void => {
    open = closeTurn(events, turn, step, open)
  }
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '') continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof record !== 'object' || record === null) continue
    const row = record as Record<string, unknown>
    if (row.type !== 'response_item' || typeof row.payload !== 'object' || row.payload === null) continue
    const payload = row.payload as Record<string, unknown>
    if (payload.type === 'message' && payload.role === 'user') {
      close()
      turn += 1
      step = 0
      open = true
      messageCounter += 1
      events.push({ type: 'turn/start', data: { turn } })
      events.push({
        type: 'user/message',
        data: {
          id: `user-${messageCounter}`,
          role: 'user',
          content: [{ type: 'text', text: textOf(payload.content) }],
          source: { kind: 'user' },
        },
      })
      events.push({ type: 'step/start', data: { turn, step } })
    } else if (payload.type === 'message' && payload.role === 'assistant') {
      messageCounter += 1
      events.push({
        type: 'assistant/message',
        data: {
          turn,
          step,
          message: {
            id: `assistant-${messageCounter}`,
            role: 'assistant',
            content: [{ type: 'text', text: textOf(payload.content) }],
            source: { kind: 'model' },
          },
        },
      })
    } else if (payload.type === 'function_call') {
      callCounter += 1
      const callId = typeof payload.call_id === 'string' ? payload.call_id : `codex-call-${callCounter}`
      const name = typeof payload.name === 'string' ? payload.name : 'tool'
      const argumentsText = typeof payload.arguments === 'string' ? payload.arguments : '{}'
      events.push({ type: 'tool/call', data: { turn, step, callId, name, arguments: argumentsText } })
    } else if (payload.type === 'function_call_output') {
      callCounter += 1
      const callId = typeof payload.call_id === 'string' ? payload.call_id : `codex-call-${callCounter}`
      const output = textOf(payload.output ?? payload.content)
      events.push({
        type: 'tool/result',
        data: {
          turn,
          step,
          message: {
            id: `tool-result-${callCounter}`,
            role: 'user',
            content: [{ type: 'tool-result', text: output, isError: payload.is_error === true }],
            source: { kind: 'tool', callId },
          },
        },
      })
    }
  }
  close()
  return assembleTrace(events, sessionIdFrom(source))
}

/** Whether a Claude Code user message carries only tool results (not a new turn). */
function isToolResultUser(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  return content.every(block =>
    typeof block === 'object' && block !== null && (block as Record<string, unknown>).type === 'tool_result')
}

/**
 * Import a Claude Code session JSONL (lines of `user`/`assistant` records) as
 * a trace.
 * @param text - the Claude Code log's UTF-8 text.
 * @param source - the source file path, used for the synthetic session id.
 * @returns the imported trace; non-user/assistant lines are skipped.
 */
export function importClaudeLog(text: string, source: string): EvalTrace {
  const events: ParsedEvent[] = []
  let turn = 0
  let step = 0
  let open = false
  let messageCounter = 0
  const close = (): void => {
    open = closeTurn(events, turn, step, open)
  }
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '') continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof record !== 'object' || record === null) continue
    const row = record as Record<string, unknown>
    if ((row.type !== 'user' && row.type !== 'assistant')
      || typeof row.message !== 'object' || row.message === null) continue
    const message = row.message as Record<string, unknown>
    const content = message.content
    if (row.type === 'user' && !isToolResultUser(content)) {
      close()
      turn += 1
      step = 0
      open = true
      messageCounter += 1
      events.push({ type: 'turn/start', data: { turn } })
      events.push({
        type: 'user/message',
        data: {
          id: `user-${messageCounter}`,
          role: 'user',
          content: [{ type: 'text', text: textOf(content) }],
          source: { kind: 'user' },
        },
      })
      events.push({ type: 'step/start', data: { turn, step } })
      continue
    }
    if (row.type === 'assistant') {
      if (typeof content === 'string') {
        messageCounter += 1
        events.push({
          type: 'assistant/message',
          data: {
            turn,
            step,
            message: {
              id: `assistant-${messageCounter}`,
              role: 'assistant',
              content: [{ type: 'text', text: content }],
              source: { kind: 'model' },
            },
          },
        })
      } else {
        for (const block of Array.isArray(content) ? content : []) {
          if (typeof block !== 'object' || block === null) continue
          const item = block as Record<string, unknown>
          if (item.type === 'text') {
            messageCounter += 1
            events.push({
              type: 'assistant/message',
              data: {
                turn,
                step,
                message: {
                  id: `assistant-${messageCounter}`,
                  role: 'assistant',
                  content: [{ type: 'text', text: typeof item.text === 'string' ? item.text : '' }],
                  source: { kind: 'model' },
                },
              },
            })
          } else if (item.type === 'tool_use') {
            const callId = typeof item.id === 'string' ? item.id : `claude-call-${messageCounter}`
            const name = typeof item.name === 'string' ? item.name : 'tool'
            const argumentsText = JSON.stringify(item.input ?? {})
            events.push({ type: 'tool/call', data: { turn, step, callId, name, arguments: argumentsText } })
          }
        }
      }
      continue
    }
    // Reaching here means a tool-result user message: the plain-user branch
    // above already excluded non-tool-result content.
    const blocks = content as readonly Record<string, unknown>[]
    for (const item of blocks) {
      const callId = typeof item.tool_use_id === 'string' ? item.tool_use_id : `claude-call-${messageCounter}`
      events.push({
        type: 'tool/result',
        data: {
          turn,
          step,
          message: {
            id: `tool-result-${messageCounter}`,
            role: 'user',
            content: [{ type: 'tool-result', text: textOf(item.content), isError: item.is_error === true }],
            source: { kind: 'tool', callId },
          },
        },
      })
    }
  }
  close()
  return assembleTrace(events, sessionIdFrom(source))
}

/** Import formats the CLI accepts. */
export type ImportFormat = 'codex' | 'claude-code'

/**
 * Load an external session log and build a one-trial run record from it.
 * @param format - the external harness format.
 * @param path - the session JSONL path.
 * @param caseId - the imported trial's case id.
 * @returns the run record with one completed trial.
 */
export async function importTraceFile(format: ImportFormat, path: string, caseId: string): Promise<EvalRun> {
  const absolute = resolve(path)
  const text = await readFile(absolute, 'utf8')
  const trace = format === 'codex'
    ? importCodexLog(text, absolute)
    : importClaudeLog(text, absolute)
  const metrics = computeMetrics(trace.events, undefined)
  return {
    benchmark: `import:${format}`,
    model: 'imported',
    createdAt: Date.now(),
    trials: 1,
    seed: 0,
    pricing: null,
    tempRoot: dirname(absolute),
    cases: [{
      caseId,
      trial: 1,
      status: 'completed',
      tracePath: absolute,
      exitCode: null,
      timedOut: false,
      metrics,
    }],
    aggregate: metrics,
    grading: null,
  }
}
