/**
 * Session-log harvesting and parsing for dsh-eval. A trial's headless dsh
 * writes a plain-JSONL session log under its DSH_HOME; the importer reads the
 * header line, decodes every event row (packed chunk rows included) through
 * the session package's storage decoder, and enforces seq continuity.
 *
 * @module dsh-eval/trace
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeStorageRecord, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { EvalTrace } from './types.ts'

const headerSchema = z.object({
  type: z.literal('session'),
  id: z.string().min(1),
  createdAt: z.number().nonnegative(),
}).loose()

/**
 * Parse a plain-JSONL session log into a trace.
 * @param text - the log file's UTF-8 text, header line first.
 * @returns the parsed trace.
 * @throws when the header is missing or malformed, a row is not valid JSON,
 *   or event seqs are not contiguous.
 */
export function parseSessionLog(text: string): EvalTrace {
  const lines = text.split(/\r?\n/u).filter(line => line.trim() !== '')
  if (lines.length === 0) throw new Error('empty session log')
  const header = headerSchema.parse(JSON.parse(lines[0] as string))
  const events: SessionEvent[] = []
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index] as string
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      throw new Error(`corrupt session log: invalid JSON at line ${index + 1}`)
    }
    for (const event of decodeStorageRecord(record)) {
      if (event.seq !== events.length) {
        throw new Error(
          `corrupt session log: seq gap at line ${index + 1} (expected ${events.length}, got ${event.seq})`,
        )
      }
      events.push(event)
    }
  }
  return {
    sessionId: SessionId(header.id),
    createdAt: header.createdAt,
    events,
  }
}

/**
 * Load and parse the primary session log at a path.
 * @param path - absolute path to a `session.jsonl` file.
 * @returns the parsed trace.
 */
export async function loadTrace(path: string): Promise<EvalTrace> {
  return parseSessionLog(await readFile(path, 'utf8'))
}

/**
 * Find the newest primary `session.jsonl` under a DSH_HOME tree, descending
 * into directories without following symlinks.
 * @param root - the DSH_HOME directory to scan.
 * @returns the newest primary log's absolute path, or null when none exists.
 */
export async function findPrimarySessionLog(root: string): Promise<string | null> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  let best: { path: string; mtime: number } | null = null
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = await findPrimarySessionLog(join(root, entry.name))
      if (found !== null) {
        const mtime = (await stat(found)).mtimeMs
        if (best === null || mtime > best.mtime) best = { path: found, mtime }
      }
    } else if (entry.isFile() && entry.name === 'session.jsonl') {
      const mtime = (await stat(join(root, entry.name))).mtimeMs
      if (best === null || mtime > best.mtime) best = { path: join(root, entry.name), mtime }
    }
  }
  return best?.path ?? null
}

/**
 * Find every `session.jsonl` under a DSH_HOME tree, sorted by modification
 * time ascending so the parent session (started first) comes first.
 * @param root - the DSH_HOME directory to scan.
 * @returns absolute log paths in ascending mtime order.
 */
export async function findSessionLogs(root: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found: { path: string; mtime: number }[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      for (const nested of await findSessionLogs(join(root, entry.name))) {
        found.push({ path: nested, mtime: (await stat(nested)).mtimeMs })
      }
    } else if (entry.isFile() && entry.name === 'session.jsonl') {
      found.push({ path: join(root, entry.name), mtime: (await stat(join(root, entry.name))).mtimeMs })
    }
  }
  return found.sort((a, b) => a.mtime - b.mtime).map(entry => entry.path)
}

/**
 * Merge traces into one timeline: events from every trace sorted by event
 * time, ties broken by source order. The primary trace's header (session id
 * and creation time) labels the merged trace.
 * @param traces - harvested traces, primary first.
 * @returns the merged trace.
 */
export function mergeTraces(traces: readonly EvalTrace[]): EvalTrace {
  const primary = traces[0]
  if (primary === undefined) throw new Error('mergeTraces requires at least one trace')
  const events = traces
    .flatMap((trace, source) => trace.events.map(event => ({ event, source })))
    .sort((a, b) => a.event.time - b.event.time || a.source - b.source)
    .map(entry => entry.event)
  return { sessionId: primary.sessionId, createdAt: primary.createdAt, events }
}
