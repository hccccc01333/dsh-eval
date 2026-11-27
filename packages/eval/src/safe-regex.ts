/**
 * Time-boxed regular-expression tests for agent-controlled text.
 *
 * A benchmark author can write a catastrophic backtracking pattern, and the
 * matched text comes from the agent under evaluation. Running such a pattern on
 * the main thread would hang the whole evaluator, so each test runs in a
 * disposable worker and is terminated when it exceeds its budget. The budget
 * includes worker startup, so it is generous enough for high concurrency.
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

const BATCH_WORKER_SOURCE = `
;(function () {
  const { parentPort, workerData } = require('node:worker_threads')
  try {
    const re = new RegExp(workerData.pattern, 'u')
    for (const input of workerData.inputs) {
      try {
        if (re.test(input)) {
          parentPort.postMessage({ ok: true, value: true })
          return
        }
      } catch {
        // One untestable input must not hide a later match.
      }
    }
    parentPort.postMessage({ ok: true, value: false })
  } catch (error) {
    parentPort.postMessage({ ok: false, error: String(error) })
  }
})()
`

type RegexMessage = { ok: boolean; value?: boolean; error?: string }

/** Run one pattern against one input within a shared worker budget. */
function runRegex(pattern: string, input: string, timeoutMs: number): Promise<boolean> {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { pattern, input },
  })
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(new Error(`regex timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    worker.once('message', (message: RegexMessage) => {
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

/** Test a pattern against a batch of inputs in one worker. */
function runRegexBatch(pattern: string, inputs: readonly string[], timeoutMs: number): Promise<boolean> {
  const worker = new Worker(BATCH_WORKER_SOURCE, {
    eval: true,
    workerData: { pattern, inputs },
  })
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(new Error(`regex timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    worker.once('message', (message: RegexMessage) => {
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

/**
 * Test a validated pattern against one untrusted input with a hard time budget.
 * @throws when the pattern is invalid or the budget is exceeded.
 */
export function safeRegexTest(pattern: string, input: string, timeoutMs = 2000): Promise<boolean> {
  return runRegex(pattern, input, timeoutMs)
}

/**
 * Test a pattern against several inputs. The common path uses **one** worker
 * for the whole batch: tool-name matching, the only caller, supplies a short
 * set of known names, so starting one worker per name was pure overhead.
 *
 * If the batch stalls or the pattern is invalid, fall back to the original
 * per-input isolation so a pathological input still cannot hide a later match,
 * and an invalid pattern still degrades to "no match" for the caller.
 *
 * @throws never for invalid patterns or timeouts; both degrade to false.
 */
export async function safeRegexTestAny(
  pattern: string,
  inputs: readonly string[],
  timeoutMs = 2000,
): Promise<boolean> {
  if (inputs.length === 0) return false
  try {
    return await runRegexBatch(pattern, inputs, timeoutMs)
  } catch {
    // A pathological input or an invalid pattern: preserve per-input budgets.
    for (const input of inputs) {
      try {
        if (await safeRegexTest(pattern, input, timeoutMs)) return true
      } catch {
        // One pathological or invalid input must not consume the remaining
        // inputs' chances to match; the caller still sees the aggregate result.
      }
    }
    return false
  }
}
