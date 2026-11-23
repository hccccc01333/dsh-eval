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
import { chmod, mkdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * Write UTF-8 text atomically, creating parent directories as needed.
 * @param path - destination path.
 * @param text - complete file contents.
 */
export async function writeTextAtomic(path: string, text: string): Promise<void> {
  const absolute = resolve(path)
  // Replace the real target, not the symlink: an `--out` alias must stay valid.
  const destination = await realpath(absolute).catch(() => absolute)
  const directory = dirname(destination)
  await mkdir(directory, { recursive: true })
  const temp = join(directory, `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`)
  const existing = await stat(destination).catch(() => null)
  try {
    await writeFile(temp, text, 'utf8')
    // Preserve an existing file's permission bits across the rename.
    if (existing !== null) await chmod(temp, existing.mode)
    await rename(temp, destination)
  } catch (error) {
    /* v8 ignore next -- cleanup of a failed staged write is best-effort. */
    await unlink(temp).catch(() => {})
    throw error
  }
}
