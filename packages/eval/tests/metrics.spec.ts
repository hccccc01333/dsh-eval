import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { aggregateMetrics, computeCost, computeMetrics, foldMetrics } from '../src/metrics.ts'
import type { BenchmarkPricing, EvalCaseMetrics, EvalTokenUsage } from '../src/types.ts'

function event(type: SessionEvent['type'], seq: number, time: number, data: unknown): SessionEvent {
  return { seq, type, time, data } as SessionEvent
}

const PRICING: BenchmarkPricing = {
  inputUsdPerMTokens: 0.27,
  cacheReadUsdPerMTokens: 0.07,
  cacheWriteUsdPerMTokens: 0.27,
  outputUsdPerMTokens: 1.10,
}

/** The happy-path trace used by most metric assertions. */
function happyTrace(): SessionEvent[] {
  return [
    event('turn/start', 0, 0, { turn: 0 }),
    event('user/message', 1, 1, { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }),
    event('step/start', 2, 2, { turn: 0, step: 0 }),
    event('assistant/chunk', 3, 12, { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'Hi' } }),
    event('assistant/message', 4, 100, {
      turn: 0,
      step: 0,
      message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Hi' }], source: { kind: 'model' } },
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5 },
    }),
    event('tool/call', 5, 101, { turn: 0, step: 0, callId: 'call-1', name: 'bash', arguments: '{}' }),
    event('tool/result', 6, 200, {
      turn: 0,
      step: 0,
      message: { id: 'm3', role: 'user', content: [{ type: 'tool-result', text: 'ok', isError: false }], source: { kind: 'tool', callId: 'call-1' } },
    }),
    event('llm/retry', 7, 300, { retryId: 'r1', turn: 0, step: 0, retry: 1 }),
    event('step/end', 8, 301, { turn: 0, step: 0 }),
    event('turn/end', 9, 302, { turn: 0, reason: { kind: 'completed' } }),
  ]
}

describe('dsh-eval metric folding', () => {
  it('folds the happy path with cost', () => {
    const metrics = computeMetrics(happyTrace(), PRICING)
    expect(metrics).toMatchObject({
      turns: 1,
      steps: 1,
      toolCalls: 1,
      toolResults: 1,
      toolSuccess: 1,
      toolSuccessRate: 1,
      invalidToolCalls: 0,
      retries: 1,
      llmMs: 98,
      toolMs: 99,
      ttftMs: 10,
      latencyMs: 302,
    })
    expect(metrics.tokens).toEqual({ inputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0, outputTokens: 2 })
    expect(metrics.totalTokens).toBe(17)
    expect(metrics.contextTokens).toBe(15)
    expect(metrics.costUsd).toBeCloseTo(5.25e-6, 12)
  })

  it('returns zeroed metrics without pricing for an empty trace', () => {
    const metrics = foldMetrics([])
    expect(metrics).toMatchObject({
      turns: 0,
      steps: 0,
      toolCalls: 0,
      toolResults: 0,
      toolSuccessRate: null,
      invalidToolCalls: 0,
      retries: 0,
      latencyMs: 0,
      costUsd: null,
    })
    expect(metrics.tokens).toEqual({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 })
  })

  it('counts failed and invalid tool results separately', () => {
    const trace = [
      ...happyTrace().slice(0, 6),
      event('tool/result', 6, 200, {
        turn: 0,
        step: 0,
        message: { id: 'm3', role: 'user', content: [{ type: 'tool-result', text: 'nope', isError: true }], source: { kind: 'tool', callId: 'call-1' } },
        error: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' },
      }),
      ...happyTrace().slice(7),
    ]
    const metrics = computeMetrics(trace, PRICING)
    expect(metrics.toolSuccess).toBe(0)
    expect(metrics.toolSuccessRate).toBe(0)
    expect(metrics.invalidToolCalls).toBe(1)
  })

  it('ignores non-token deltas and mismatched assistant messages', () => {
    const trace = [
      event('turn/start', 0, 0, { turn: 0 }),
      event('step/start', 1, 2, { turn: 0, step: 0 }),
      event('assistant/chunk', 2, 12, { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: '' } }),
      event('assistant/message', 3, 100, {
        turn: 0,
        step: 0,
        message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '' }], source: { kind: 'model' } },
        usage: { inputTokens: 3, outputTokens: 1 },
      }),
      event('assistant/message', 4, 200, {
        turn: 9,
        step: 9,
        message: { id: 'm4', role: 'assistant', content: [{ type: 'text', text: 'stray' }], source: { kind: 'model' } },
        usage: { inputTokens: 99, outputTokens: 99 },
      }),
      event('step/end', 5, 201, { turn: 0, step: 0 }),
      event('turn/end', 6, 202, { turn: 0, reason: { kind: 'completed' } }),
    ]
    const metrics = foldMetrics(trace)
    expect(metrics.ttftMs).toBe(0)
    expect(metrics.llmMs).toBe(98)
    expect(metrics.tokens.inputTokens).toBe(3)
    expect(metrics.steps).toBe(1)
  })

  it('pairs only matched tool calls and drops pending calls at turn end', () => {
    const trace = [
      event('turn/start', 0, 0, { turn: 0 }),
      event('tool/result', 1, 10, {
        turn: 0,
        step: 0,
        message: { id: 'm1', role: 'user', content: [{ type: 'tool-result', text: 'orphan' }], source: { kind: 'tool', callId: 'call-x' }, isError: false },
      }),
      event('tool/call', 2, 20, { turn: 0, step: 0, callId: 'call-y', name: 'bash', arguments: '{}' }),
      event('turn/end', 3, 30, { turn: 0, reason: { kind: 'interrupted' } }),
    ]
    const metrics = foldMetrics(trace)
    expect(metrics.toolResults).toBe(1)
    expect(metrics.toolSuccess).toBe(1)
    expect(metrics.toolCalls).toBe(1)
    expect(metrics.toolMs).toBe(0)
  })

  it('counts multiple closed steps in one turn as a single turn', () => {
    const trace = [
      event('turn/start', 0, 0, { turn: 0 }),
      event('step/start', 1, 1, { turn: 0, step: 0 }),
      event('step/end', 2, 2, { turn: 0, step: 0 }),
      event('step/start', 3, 3, { turn: 0, step: 1 }),
      event('step/end', 4, 4, { turn: 0, step: 1 }),
      event('turn/end', 5, 5, { turn: 0, reason: { kind: 'completed' } }),
    ]
    expect(foldMetrics(trace)).toMatchObject({ turns: 1, steps: 2 })
  })
})

describe('dsh-eval cost and aggregation', () => {
  it('computes cost from disjoint token buckets', () => {
    const tokens: EvalTokenUsage = { inputTokens: 1000, cacheReadTokens: 2000, cacheWriteTokens: 500, outputTokens: 3000 }
    expect(computeCost(tokens, PRICING)).toBeCloseTo(0.003845, 12)
  })

  it('returns null when aggregating no trials', () => {
    expect(aggregateMetrics([])).toBeNull()
  })

  it('averages counts, pools rates, and drops cost when any trial lacks it', () => {
    const a: EvalCaseMetrics = {
      turns: 1, steps: 1, toolCalls: 2, toolResults: 2, toolSuccess: 2, toolSuccessRate: 1,
      invalidToolCalls: 0, retries: 0, tokens: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      totalTokens: 10, contextTokens: 10, llmMs: 1, toolMs: 2, ttftMs: 3, latencyMs: 4, costUsd: 2,
    }
    const b: EvalCaseMetrics = {
      turns: 1, steps: 3, toolCalls: 1, toolResults: 1, toolSuccess: 0, toolSuccessRate: 0,
      invalidToolCalls: 1, retries: 2, tokens: { inputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      totalTokens: 30, contextTokens: 30, llmMs: 10, toolMs: 20, ttftMs: 30, latencyMs: 40, costUsd: null,
    }
    const aggregate = aggregateMetrics([a, b])
    expect(aggregate).toMatchObject({
      steps: 2,
      toolResults: 3,
      toolSuccess: 2,
      toolSuccessRate: 2 / 3,
      invalidToolCalls: 0.5,
      retries: 1,
      latencyMs: 22,
      costUsd: null,
    })
    expect(aggregate?.tokens.inputTokens).toBe(20)
  })

  it('averages cost when every trial has it', () => {
    const a = foldMetrics(happyTrace())
    const aggregate = aggregateMetrics([a, a])
    expect(aggregate?.costUsd).toBeNull()
    expect(aggregateMetrics([{ ...a, costUsd: 1 }, { ...a, costUsd: 3 }])?.costUsd).toBe(2)
  })
})
