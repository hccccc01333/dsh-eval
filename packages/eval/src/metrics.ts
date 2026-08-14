/**
 * Pure metric folding for dsh-eval: one pass over a session trace produces
 * the automatic metric set, and pricing converts provider token buckets into
 * USD. The fold mirrors session-stats wall-time semantics and adds the
 * eval-owned failure and retry counters.
 *
 * @module dsh-eval/metrics
 */

import { isTokenDelta } from '@deepseek-ai/dsh-llm/message'
// Type-only import carries the llm-retry session-event augmentation into the
// fold's switch; the retry event is durable but plugin-merged.
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { BenchmarkPricing, EvalCaseMetrics, EvalTokenUsage } from './types.ts'

/** Structural provider usage record, independent of the llm package's type. */
interface ProviderUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** Accumulated token buckets during the fold. */
interface TokenTotals {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

/** The fold's mutable state; every field defaults to zero or null. */
interface FoldState {
  turns: number
  lastTurn: number | null
  steps: number
  toolCalls: number
  toolResults: number
  toolSuccess: number
  invalidToolCalls: number
  retries: number
  tokens: TokenTotals
  llmMs: number
  toolMs: number
  ttftMs: number
  openStep: { turn: number; step: number; start: number; firstToken: number | null } | null
  pendingCalls: Map<string, number>
  firstTime: number | null
  lastTime: number | null
}

function initialState(): FoldState {
  return {
    turns: 0,
    lastTurn: null,
    steps: 0,
    toolCalls: 0,
    toolResults: 0,
    toolSuccess: 0,
    invalidToolCalls: 0,
    retries: 0,
    tokens: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    openStep: null,
    pendingCalls: new Map(),
    firstTime: null,
    lastTime: null,
  }
}

/** Add one message's provider usage to the totals, defaulting absent cache buckets. */
function addUsage(totals: TokenTotals, usage: ProviderUsage): void {
  totals.inputTokens += usage.inputTokens
  totals.outputTokens += usage.outputTokens
  totals.cacheReadTokens += usage.cacheReadTokens ?? 0
  totals.cacheWriteTokens += usage.cacheWriteTokens ?? 0
}

/**
 * Fold a session trace into automatic metrics without pricing.
 * @param events - the trace's durable events in log order.
 * @returns the folded metrics with `costUsd: null`.
 */
export function foldMetrics(events: readonly SessionEvent[]): EvalCaseMetrics {
  const state = initialState()
  for (const event of events) {
    switch (event.type) {
      case 'step/start':
        state.openStep = {
          turn: event.data.turn,
          step: event.data.step,
          start: event.time,
          firstToken: null,
        }
        break
      case 'assistant/chunk': {
        const open = state.openStep
        if (open === null || open.turn !== event.data.turn || open.step !== event.data.step
          || open.firstToken !== null || !isTokenDelta(event.data.chunk)) break
        state.openStep = { ...open, firstToken: event.time }
        break
      }
      case 'assistant/message': {
        const open = state.openStep
        if (open === null || open.turn !== event.data.turn || open.step !== event.data.step) break
        state.llmMs += Math.max(0, event.time - open.start)
        if (open.firstToken !== null) state.ttftMs += Math.max(0, open.firstToken - open.start)
        if (event.data.usage !== undefined) addUsage(state.tokens, event.data.usage)
        state.openStep = null
        break
      }
      case 'tool/call':
        state.toolCalls += 1
        state.pendingCalls.set(String(event.data.callId), event.time)
        break
      case 'tool/result': {
        state.toolResults += 1
        if (event.data.message.content.at(0)?.isError !== true) state.toolSuccess += 1
        if (event.data.error !== undefined) state.invalidToolCalls += 1
        const dispatched = state.pendingCalls.get(String(event.data.message.source.callId))
        if (dispatched !== undefined) {
          state.toolMs += Math.max(0, event.time - dispatched)
          state.pendingCalls.delete(String(event.data.message.source.callId))
        }
        break
      }
      case 'step/end':
        state.steps += 1
        if (state.lastTurn !== event.data.turn) {
          state.turns += 1
          state.lastTurn = event.data.turn
        }
        state.openStep = null
        break
      case 'turn/end':
        state.pendingCalls.clear()
        break
      case 'llm/retry':
        state.retries += 1
        break
      default:
        break
    }
    state.firstTime = state.firstTime === null ? event.time : Math.min(state.firstTime, event.time)
    state.lastTime = state.lastTime === null ? event.time : Math.max(state.lastTime, event.time)
  }
  const tokens: EvalTokenUsage = { ...state.tokens }
  return {
    turns: state.turns,
    steps: state.steps,
    toolCalls: state.toolCalls,
    toolResults: state.toolResults,
    toolSuccess: state.toolSuccess,
    toolSuccessRate: state.toolResults > 0 ? state.toolSuccess / state.toolResults : null,
    invalidToolCalls: state.invalidToolCalls,
    retries: state.retries,
    tokens,
    totalTokens: tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens + tokens.outputTokens,
    contextTokens: tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens,
    llmMs: state.llmMs,
    toolMs: state.toolMs,
    ttftMs: state.ttftMs,
    latencyMs: state.firstTime !== null && state.lastTime !== null
      ? Math.max(0, state.lastTime - state.firstTime)
      : 0,
    costUsd: null,
  }
}

/**
 * Convert token buckets into USD using per-million-token prices.
 * @param tokens - summed token buckets.
 * @param pricing - per-million-token USD prices.
 * @returns the estimated cost in USD.
 */
export function computeCost(tokens: EvalTokenUsage, pricing: BenchmarkPricing): number {
  return (
    tokens.inputTokens * pricing.inputUsdPerMTokens
    + tokens.cacheReadTokens * pricing.cacheReadUsdPerMTokens
    + tokens.cacheWriteTokens * pricing.cacheWriteUsdPerMTokens
    + tokens.outputTokens * pricing.outputUsdPerMTokens
  ) / 1_000_000
}

/**
 * Fold metrics and attach cost when a pricing table entry exists.
 * @param events - the trace's durable events in log order.
 * @param pricing - the benchmark model's pricing, or undefined for no cost.
 * @returns the folded metrics.
 */
export function computeMetrics(
  events: readonly SessionEvent[],
  pricing: BenchmarkPricing | undefined,
): EvalCaseMetrics {
  const metrics = foldMetrics(events)
  return pricing === undefined ? metrics : { ...metrics, costUsd: computeCost(metrics.tokens, pricing) }
}

/**
 * Aggregate per-trial metrics: arithmetic means for counts and wall times,
 * pooled success rate, and the mean cost when every trial priced it.
 * @param items - completed trials' metrics.
 * @returns the aggregate, or null when no trial is included.
 */
export function aggregateMetrics(items: readonly EvalCaseMetrics[]): EvalCaseMetrics | null {
  if (items.length === 0) return null
  const mean = (select: (metrics: EvalCaseMetrics) => number): number =>
    items.reduce((total, metrics) => total + select(metrics), 0) / items.length
  const toolResults = items.reduce((total, metrics) => total + metrics.toolResults, 0)
  const toolSuccess = items.reduce((total, metrics) => total + metrics.toolSuccess, 0)
  const costValues = items
    .map(metrics => metrics.costUsd)
    .filter((value): value is number => value !== null)
  const tokens: EvalTokenUsage = {
    inputTokens: mean(metrics => metrics.tokens.inputTokens),
    cacheReadTokens: mean(metrics => metrics.tokens.cacheReadTokens),
    cacheWriteTokens: mean(metrics => metrics.tokens.cacheWriteTokens),
    outputTokens: mean(metrics => metrics.tokens.outputTokens),
  }
  return {
    turns: mean(metrics => metrics.turns),
    steps: mean(metrics => metrics.steps),
    toolCalls: mean(metrics => metrics.toolCalls),
    toolResults,
    toolSuccess,
    toolSuccessRate: toolResults > 0 ? toolSuccess / toolResults : null,
    invalidToolCalls: mean(metrics => metrics.invalidToolCalls),
    retries: mean(metrics => metrics.retries),
    tokens,
    totalTokens: mean(metrics => metrics.totalTokens),
    contextTokens: mean(metrics => metrics.contextTokens),
    llmMs: mean(metrics => metrics.llmMs),
    toolMs: mean(metrics => metrics.toolMs),
    ttftMs: mean(metrics => metrics.ttftMs),
    latencyMs: mean(metrics => metrics.latencyMs),
    costUsd: costValues.length === items.length
      ? costValues.reduce((total, value) => total + value, 0) / items.length
      : null,
  }
}
