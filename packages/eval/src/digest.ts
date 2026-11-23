/**
 * Deterministic content hashing for benchmark provenance.
 *
 * A YAML digest alone misses prompt files, workspace fixtures and replay logs,
 * so the stored benchmark fingerprint folds every resolved input into one
 * SHA-256. Directory entries use code-point ordering (never locale ordering)
 * so the digest is identical on every machine, and symlinks are followed to
 * their real content so an in-directory link cannot hide a changed fixture.
 *
 * @module dsh-eval/digest
 */

import { createHash, type Hash } from 'node:crypto'
import { realpath, readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { Benchmark } from './types.ts'

/** Code-point ordering: `localeCompare` varies with the host's ICU locale. */
function byCodePoint(a: string, b: string): number {
  /* v8 ignore next -- readdir order decides which comparison branch runs. */
  return a < b ? -1 : a > b ? 1 : 0
}

/** Hash a labelled fragment with unambiguous delimiters. */
function fragment(hash: Hash, label: string, value: string): void {
  hash.update(`${label}\0${value}\0`)
}

/** Hash a file or directory tree, following symlinks without revisiting targets. */
async function hashPath(
  hash: Hash,
  path: string,
  root: string,
  label: string,
  seen: ReadonlySet<string>,
  excluded: ReadonlySet<string>,
): Promise<void> {
  const absolute = resolve(path)
  let real: string
  try {
    real = await realpath(absolute)
  } catch {
    real = absolute
  }
  if (excluded.has(absolute) || excluded.has(real)) return
  if (seen.has(real)) return
  const visited = new Set(seen)
  visited.add(real)
  let info
  try {
    info = await stat(real)
  } catch (error) {
    /* v8 ignore next -- non-ENOENT stat failures propagate to the caller. */
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    fragment(hash, `${label}-missing`, relative(root, absolute))
    return
  }
  if (info.isFile()) {
    fragment(hash, label, relative(root, absolute))
    hash.update(await readFile(real))
    return
  }
  /* v8 ignore next -- sockets/FIFOs are not valid benchmark inputs. */
  if (!info.isDirectory()) return
  const entries = (await readdir(real, { withFileTypes: true }))
    .sort((a, b) => byCodePoint(a.name, b.name))
  for (const entry of entries) {
    await hashPath(hash, join(real, entry.name), root, label, visited, excluded)
  }
}

/** Options that affect only the digest, not the benchmark itself. */
export interface BenchmarkDigestOptions {
  /** Absolute paths to omit, e.g. the run report written into a `workspace: .` tree. */
  excludePaths?: readonly string[]
}

/**
 * Hash the benchmark YAML plus every resolved input it reads at run time.
 * @param text - raw benchmark YAML source.
 * @param benchmark - the parsed benchmark with resolved paths.
 * @param options - digest-only exclusions for output artifacts.
 * @returns a stable 64-character hex digest.
 */
export async function hashBenchmarkInputs(
  text: string,
  benchmark: Benchmark,
  options: BenchmarkDigestOptions = {},
): Promise<string> {
  const hash = createHash('sha256')
  const excluded = new Set<string>()
  for (const path of options.excludePaths ?? []) {
    const absolute = resolve(path)
    excluded.add(absolute)
    // Windows temp paths can differ by short-name casing; canonicalize too.
    try {
      excluded.add(await realpath(absolute))
    } catch {
      /* Output paths often do not exist yet; the raw absolute form still applies. */
    }
  }
  const seen = new Set<string>()
  fragment(hash, 'yaml', text)
  for (const caseValue of benchmark.cases) {
    fragment(hash, 'case', caseValue.id)
    fragment(hash, 'prompt', caseValue.prompt)
    if (caseValue.workspace !== undefined) {
      await hashPath(hash, caseValue.workspace, caseValue.workspace, 'workspace', seen, excluded)
    }
  }
  if (benchmark.replay !== undefined) {
    await hashPath(hash, benchmark.replay.dir, benchmark.replay.dir, 'replay', seen, excluded)
  }
  return hash.digest('hex')
}
