/**
 * Time-boxed regular-expression tests for agent-controlled text.
 *
 * A benchmark author can write a catastrophic backtracking pattern, and the
 * matched text comes from the agent under evaluation. Running such a pattern on
 * the main thread would hang the whole evaluator, so each test runs in a
 * disposable worker and is terminated when it exceeds its budget.
 *
 * @module dsh-eval/safe-regex
 */

import { Worker } from 'node:worker_threads'

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
try {
  const re = new RegExp(workerData.pattern, 'u')
  parentPort.postMessage({ ok: true, value: re.test(workerData.input) })
} catch (error) {
  parentPort.postMessage({ ok: false, error: String(error) })
}
`

/**
 * Test a validated pattern against untrusted input with a hard time budget.
 * @param pattern - a syntactically valid regular expression source.
 * @param input - agent-controlled text to test.
 * @param timeoutMs - wall-clock budget before the worker is terminated.
 * @returns whether the pattern matched.
 * @throws when the pattern is invalid or the budget is exceeded.
 */
export function safeRegexTest(pattern: string, input: string, timeoutMs = 250): Promise<boolean> {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { pattern, input },
  })
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(new Error(`regex timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    worker.once('message', (message: { ok: boolean; value?: boolean; error?: string }) => {
      clearTimeout(timer)
      void worker.terminate()
      if (message.ok === true && typeof message.value === 'boolean') resolve(message.value)
      else reject(new Error(`regex failed: ${message.error!}`))
    })
    /* v8 ignore next 3 -- worker startup failures are infrastructure errors. */
    worker.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}
