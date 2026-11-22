/**
 * Deterministic content hashing for benchmark provenance.
 *
 * A YAML digest alone misses prompt files, workspace fixtures and replay logs,
 * so the stored benchmark fingerprint folds every resolved input into one
 * SHA-256. Directory entries are sorted before hashing to stay stable across
 * filesystems, and symlinks are hashed by target rather than followed.
 *
 * @module dsh-eval/digest
 */

import { createHash, type Hash } from 'node:crypto'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { Benchmark } from './types.ts'

/** Hash a labelled fragment with unambiguous delimiters. */
function fragment(hash: Hash, label: string, value: string): void {
  hash.update(`${label}\0${value}\0`)
}

/** Hash a file, directory tree, or symlink at a resolved input path. */
async function hashPath(hash: Hash, path: string, root: string, label: string): Promise<void> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    /* v8 ignore next -- non-ENOENT lstat failures propagate to the caller. */
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    fragment(hash, `${label}-missing`, relative(root, path))
    return
  }
  if (info.isSymbolicLink()) {
    fragment(hash, `${label}-link`, relative(root, path))
    fragment(hash, 'target', await readlink(path))
    return
  }
  if (info.isFile()) {
    fragment(hash, label, relative(root, path))
    hash.update(await readFile(path))
    return
  }
  /* v8 ignore next -- sockets/FIFOs are not valid benchmark inputs. */
  if (!info.isDirectory()) return
  const entries = (await readdir(path, { withFileTypes: true }))
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    await hashPath(hash, join(path, entry.name), root, label)
  }
}

/**
 * Hash the benchmark YAML plus every resolved input it reads at run time.
 * @param text - raw benchmark YAML source.
 * @param benchmark - the parsed benchmark with resolved paths.
 * @returns a stable 64-character hex digest.
 */
export async function hashBenchmarkInputs(text: string, benchmark: Benchmark): Promise<string> {
  const hash = createHash('sha256')
  fragment(hash, 'yaml', text)
  for (const caseValue of benchmark.cases) {
    fragment(hash, 'case', caseValue.id)
    fragment(hash, 'prompt', caseValue.prompt)
    if (caseValue.workspace !== undefined) {
      await hashPath(hash, caseValue.workspace, caseValue.workspace, 'workspace')
    }
  }
  if (benchmark.replay !== undefined) {
    await hashPath(hash, benchmark.replay.dir, benchmark.replay.dir, 'replay')
  }
  return hash.digest('hex')
}
