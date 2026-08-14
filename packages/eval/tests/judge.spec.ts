import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  buildJudgePrompt,
  judgeTrial,
  llmJudgeChat,
  parseJudgeVerdict,
  summarizeTrace,
} from '../src/judge.ts'
import { parseSessionLog } from '../src/trace.ts'
import type { BenchmarkCase, BenchmarkJudge, EvalTrace } from '../src/types.ts'

const TRACE_TEXT = [
  '{"type":"session","version":0,"id":"s","createdAt":1,"delegationDepth":0}',
  '{"seq":0,"type":"user/message","time":1,"data":{"id":"u","role":"user","content":[{"type":"text","text":"task"}]}}',
  '{"seq":1,"type":"assistant/message","time":2,"data":{"turn":0,"step":0,"message":{"id":"a","role":"assistant","content":[{"type":"text","text":"final answer here"}],"source":{"kind":"model"}}}}',
  '{"seq":2,"type":"tool/call","time":3,"data":{"turn":0,"step":0,"callId":"c1","name":"bash","arguments":"{}"}}',
  '{"seq":3,"type":"tool/result","time":4,"data":{"turn":0,"step":0,"message":{"id":"r","role":"user","content":[{"type":"tool-result","text":"x","isError":false}],"source":{"kind":"tool","callId":"c1"}}}}',
  '',
].join('\n')

function trace(): EvalTrace {
  return parseSessionLog(TRACE_TEXT)
}

function emptyTrace(): EvalTrace {
  return parseSessionLog([
    '{"type":"session","version":0,"id":"s","createdAt":1,"delegationDepth":0}',
    '{"seq":0,"type":"user/message","time":1,"data":{"id":"u","role":"user","content":[{"type":"text","text":"task"}]}}',
    '{"seq":1,"type":"turn/end","time":2,"data":{"turn":0,"reason":{"kind":"completed"}}}',
    '',
  ].join('\n'))
}

function failureTrace(): EvalTrace {
  return parseSessionLog([
    '{"type":"session","version":0,"id":"s","createdAt":1,"delegationDepth":0}',
    '{"seq":0,"type":"tool/call","time":1,"data":{"turn":0,"step":0,"callId":"c1","name":"web_search","arguments":"{}"}}',
    '{"seq":1,"type":"tool/result","time":2,"data":{"turn":0,"step":0,"message":{"id":"r","role":"user","content":[{"type":"tool-result","text":"x","isError":true}],"source":{"kind":"tool","callId":"c1"}},"error":{"code":"INTERNAL"}}}',
    '{"seq":2,"type":"llm/retry","time":3,"data":{"retryId":"r1","turn":0,"step":0,"retry":1,"provider":"deepseek","failure":{"code":"RATE_LIMITED"}}}',
    '',
  ].join('\n'))
}

function duplicateToolsTrace(): EvalTrace {
  return parseSessionLog([
    '{"type":"session","version":0,"id":"s","createdAt":1,"delegationDepth":0}',
    '{"seq":0,"type":"tool/call","time":1,"data":{"turn":0,"step":0,"callId":"c1","name":"bash","arguments":"{}"}}',
    '{"seq":1,"type":"tool/call","time":2,"data":{"turn":0,"step":0,"callId":"c2","name":"bash","arguments":"{}"}}',
    '',
  ].join('\n'))
}

function caseValue(overrides: Partial<BenchmarkCase> = {}): BenchmarkCase {
  return { id: 'case-1', prompt: 'Solve the task.', ...overrides }
}

function judge(overrides: Partial<BenchmarkJudge> = {}): BenchmarkJudge {
  return { provider: 'deepseek', model: 'judge-m', maxScore: 10, ...overrides }
}

describe('dsh-eval judge', () => {
  it('summarizes the trace for the judge', () => {
    const summary = summarizeTrace(trace())
    expect(summary).toContain('final answer: final answer here')
    expect(summary).toContain('tools called: bash')
    expect(summary).toContain('invalid tool calls: 0')
  })

  it('summarizes a trace without an answer or tools', () => {
    const summary = summarizeTrace(emptyTrace())
    expect(summary).toContain('final answer: (none)')
    expect(summary).toContain('tools called: (none)')
  })

  it('counts invalid tool calls and retries', () => {
    const summary = summarizeTrace(failureTrace())
    expect(summary).toContain('invalid tool calls: 1')
    expect(summary).toContain('llm retries: 1')
  })

  it('deduplicates tool names and skips non-text answer blocks', () => {
    const deduped = summarizeTrace(duplicateToolsTrace())
    expect(deduped).toContain('tools called: bash')
    const withReasoning = parseSessionLog([
      '{"type":"session","version":0,"id":"s","createdAt":1,"delegationDepth":0}',
      '{"seq":0,"type":"assistant/message","time":2,"data":{"turn":0,"step":0,"message":{"id":"a","role":"assistant","content":[{"type":"reasoning","text":"think"},{"type":"text","text":"answer"}],"source":{"kind":"model"}}}}',
      '',
    ].join('\n'))
    expect(summarizeTrace(withReasoning)).toContain('final answer: answer')
  })

  it('builds a prompt with the rubric, task, and trace', () => {
    const built = buildJudgePrompt(caseValue(), trace(), judge({ rubric: 'Prefer concise answers.' }))
    expect(built.system).toContain('Prefer concise answers.')
    expect(built.system).toContain('0..10')
    expect(built.prompt).toContain('Task id: case-1')
    expect(built.prompt).toContain('Solve the task.')
    expect(built.prompt).toContain('final answer here')
  })

  it.each([
    { name: 'clean JSON', text: '{"finalAnswerScore": 7, "hallucination": false, "rationale": "solid"}', score: 7, hallucination: false },
    { name: 'fenced JSON', text: '```json\n{"finalAnswerScore": 9, "hallucination": true, "rationale": "no source"}\n```', score: 9, hallucination: true },
  ])('parses a $name verdict', ({ text, score, hallucination }) => {
    expect(parseJudgeVerdict(text, 10)).toEqual({
      finalAnswerScore: score,
      hallucination,
      rationale: hallucination ? 'no source' : 'solid',
    })
  })

  it('turns unusable judge output into null fields', () => {
    expect(parseJudgeVerdict('not json at all', 10)).toEqual({ finalAnswerScore: null, hallucination: null })
    expect(parseJudgeVerdict('"just a string"', 10)).toEqual({ finalAnswerScore: null, hallucination: null })
    expect(parseJudgeVerdict('[1, 2]', 10)).toEqual({ finalAnswerScore: null, hallucination: null })
    expect(parseJudgeVerdict('{"finalAnswerScore": 15, "hallucination": false}', 10))
      .toEqual({ finalAnswerScore: null, hallucination: false })
    expect(parseJudgeVerdict('{"finalAnswerScore": 5, "hallucination": "maybe"}', 10))
      .toEqual({ finalAnswerScore: 5, hallucination: null })
  })

  it('judges through the injected chat seam', async () => {
    const requests: Array<{ provider: string; model: string; system: string; prompt: string }> = []
    const chat = async (request: { provider: string; model: string; system: string; prompt: string }) => {
      requests.push(request)
      return JSON.stringify({ finalAnswerScore: 6, hallucination: false, rationale: 'ok' })
    }
    const verdict = await judgeTrial(caseValue(), trace(), judge(), chat)
    expect(verdict).toEqual({ finalAnswerScore: 6, hallucination: false, rationale: 'ok' })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ provider: 'deepseek', model: 'judge-m' })
  })

  it('assembles a reply from the llm stream seam', async () => {
    async function* chunks(): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: '{"finalAnswerScore":' }
      yield { type: 'text-delta', index: 0, text: ' 7, "hallucination": false}' }
    }
    const stream = (_options: GenerateOptions): AsyncIterable<StreamChunk> => chunks()
    const reply = await llmJudgeChat(stream)({
      provider: 'deepseek',
      model: 'judge-m',
      system: 'judge',
      prompt: 'task',
    })
    expect(parseJudgeVerdict(reply, 10)).toEqual({ finalAnswerScore: 7, hallucination: false })
  })

  it('ignores non-text blocks when assembling the reply', async () => {
    async function* mixed(): AsyncIterable<StreamChunk> {
      yield { type: 'reasoning-delta', index: 0, text: 'thinking' }
      yield { type: 'text-delta', index: 1, text: '{"finalAnswerScore": 5, "hallucination": false}' }
    }
    const stream = (_options: GenerateOptions): AsyncIterable<StreamChunk> => mixed()
    const reply = await llmJudgeChat(stream)({
      provider: 'deepseek',
      model: 'judge-m',
      system: 'judge',
      prompt: 'task',
    })
    expect(parseJudgeVerdict(reply, 10)).toEqual({ finalAnswerScore: 5, hallucination: false })
  })
})
