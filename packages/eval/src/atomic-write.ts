/**
 * Crash-safe text output shared by every file-writing CLI command.
 *
 * Writing directly to the destination can leave a truncated file that looks
 * loadable after a crash or a full disk. Staging beside the target and
 * renaming keeps readers on either the old or the new complete document.
 *
 * @module dsh-eval/atomic-write
 */

import { randomUUID } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * Write UTF-8 text atomically, creating parent directories as needed.
 * @param path - destination path.
 * @param text - complete file contents.
 */
export async function writeTextAtomic(path: string, text: string): Promise<void> {
  const absolute = resolve(path)
  const directory = dirname(absolute)
  await mkdir(directory, { recursive: true })
  const temp = join(directory, `.${basename(absolute)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, text, 'utf8')
    await rename(temp, absolute)
  } catch (error) {
    /* v8 ignore next -- cleanup of a failed staged write is best-effort. */
    await unlink(temp).catch(() => {})
    throw error
  }
}
