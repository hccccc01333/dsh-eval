/**
 * LLM-judge scoring for dsh-eval: builds a judging prompt from the case and
 * its trace, calls an injected chat seam, and parses the model's strict-JSON
 * verdict into a final-answer score and hallucination flag. The production
 * seam wraps the dsh-llm stream API; tests inject a fake so the suite stays
 * keyless.
 *
 * @module dsh-eval/judge
 */

import { BlockAssembler, createMessage, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { BenchmarkCase, BenchmarkJudge, EvalJudgeVerdict, EvalTrace } from './types.ts'

/** One judge chat call: system instructions plus the single task prompt. */
export interface JudgeChatRequest {
  /** Provider route, e.g. `deepseek`. */
  provider: string
  /** Judge model id. */
  model: string
  /** System instructions demanding strict JSON output. */
  system: string
  /** The task and trace summary to judge. */
  prompt: string
}

/** The injected chat seam; returns the model's raw text reply. */
export type JudgeChat = (request: JudgeChatRequest) => Promise<string>

/** Concatenate one message's text blocks. */
function blockText(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/**
 * Summarize a trace for the judge: final assistant answer, the distinct tool
 * names called, and the failure counters a hallucination call needs.
 * @param trace - the merged trial trace.
 * @returns a compact human-readable summary.
 */
export function summarizeTrace(trace: EvalTrace): string {
  let finalAnswer = ''
  const toolNames: string[] = []
  let invalidToolCalls = 0
  let retries = 0
  for (const event of trace.events) {
    if (event.type === 'assistant/message') finalAnswer = blockText(event.data.message.content)
    if (event.type === 'tool/call') {
      if (!toolNames.includes(event.data.name)) toolNames.push(event.data.name)
    }
    if (event.type === 'tool/result' && event.data.error !== undefined) invalidToolCalls += 1
    if (event.type === 'llm/retry') retries += 1
  }
  return [
    `final answer: ${finalAnswer === '' ? '(none)' : finalAnswer}`,
    `tools called: ${toolNames.length === 0 ? '(none)' : toolNames.join(', ')}`,
    `invalid tool calls: ${invalidToolCalls}`,
    `llm retries: ${retries}`,
  ].join('\n')
}

/**
 * Build the judge's system instructions and task prompt.
 * @param caseValue - the benchmark case being judged.
 * @param trace - the merged trial trace.
 * @param judge - the judge configuration.
 * @returns the system and prompt texts.
 */
export function buildJudgePrompt(
  caseValue: BenchmarkCase,
  trace: EvalTrace,
  judge: BenchmarkJudge,
): { system: string; prompt: string } {
  const system = [
    'You are an impartial evaluation judge for agent task completion.',
    `Score the agent's final answer from 0 to ${judge.maxScore} against the task,`,
    'and set "hallucination" to true only when the final answer asserts facts',
    'not supported by the task or the trace.',
    'Return STRICT JSON with exactly these fields:',
    `{"finalAnswerScore": <integer 0..${judge.maxScore}>, "hallucination": <true|false>, "rationale": "<one short sentence>"}`,
    ...(judge.rubric !== undefined ? ['Rubric:', judge.rubric] : []),
  ].join('\n')
  const prompt = [
    `Task id: ${caseValue.id}`,
    `Task: ${caseValue.prompt}`,
    'Trace summary:',
    summarizeTrace(trace),
  ].join('\n')
  return { system, prompt }
}

/** Extract the JSON object from a model reply, accepting fenced output. */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.trim()
  const fenced = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u)
  const candidate = fenced?.[1] ?? cleaned
  try {
    const value: unknown = JSON.parse(candidate)
    return typeof value === 'object' && value !== null
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/**
 * Parse the judge model's strict-JSON reply into a verdict. Unusable output
 * yields null fields, never a fabricated verdict.
 * @param text - the raw model reply.
 * @param maxScore - the configured maximum score.
 * @returns the parsed verdict.
 */
export function parseJudgeVerdict(text: string, maxScore: number): EvalJudgeVerdict {
  const value = parseJsonObject(text)
  if (value === null) return { finalAnswerScore: null, hallucination: null }
  const score = value.finalAnswerScore
  const hallucination = value.hallucination
  const rationale = value.rationale
  const finalAnswerScore = typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= maxScore
    ? score
    : null
  const parsedHallucination = typeof hallucination === 'boolean' ? hallucination : null
  const parsedRationale = typeof rationale === 'string' && rationale.trim() !== '' ? rationale : undefined
  return {
    finalAnswerScore,
    hallucination: parsedHallucination,
    ...(parsedRationale !== undefined ? { rationale: parsedRationale } : {}),
  }
}

/**
 * Judge one trial through the chat seam.
 * @param caseValue - the benchmark case being judged.
 * @param trace - the merged trial trace.
 * @param judge - the judge configuration.
 * @param chat - the injected chat seam.
 * @returns the parsed verdict; a chat failure rejects.
 */
export async function judgeTrial(
  caseValue: BenchmarkCase,
  trace: EvalTrace,
  judge: BenchmarkJudge,
  chat: JudgeChat,
): Promise<EvalJudgeVerdict> {
  const { system, prompt } = buildJudgePrompt(caseValue, trace, judge)
  return parseJudgeVerdict(await chat({ provider: judge.provider, model: judge.model, system, prompt }), judge.maxScore)
}

/**
 * Judge one trial, converting a chat failure into an all-null verdict so a
 * judge outage reads as unjudged rather than a failed trial.
 * @param caseValue - the benchmark case being judged.
 * @param trace - the merged trial trace.
 * @param judge - the judge configuration.
 * @param chat - the injected chat seam.
 * @returns the parsed verdict, or all-null when the chat call threw.
 */
export async function tryJudgeTrial(
  caseValue: BenchmarkCase,
  trace: EvalTrace,
  judge: BenchmarkJudge,
  chat: JudgeChat,
): Promise<EvalJudgeVerdict> {
  try {
    return await judgeTrial(caseValue, trace, judge, chat)
  } catch {
    return { finalAnswerScore: null, hallucination: null }
  }
}

/**
 * Build the production chat seam over a dsh-llm stream: one user turn, zero
 * temperature, and text-block assembly of the reply.
 * @param stream - the llm service's stream method.
 * @returns a chat seam reading only text blocks from the stream.
 */
export function llmJudgeChat(stream: LlmRuntime['stream']): JudgeChat {
  return async (request) => {
    const assembler = new BlockAssembler()
    for await (const chunk of stream({
      provider: request.provider,
      model: request.model,
      system: request.system,
      messages: [createMessage({
        role: 'user',
        content: [{ type: 'text', text: request.prompt }],
        source: { kind: 'user' },
      })],
      temperature: 0,
    })) {
      assembler.push(chunk)
    }
    return assembler.message().content
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('')
  }
}
