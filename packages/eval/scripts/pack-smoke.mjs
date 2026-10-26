#!/usr/bin/env node
/**
 * Pack smoke test: prove the tarball npm would publish actually loads.
 *
 * `npm test` exercises `src/` through vitest, so it structurally cannot catch a
 * `files` whitelist that drops a module the built entry imports — the exact
 * defect that shipped `dsh-eval@0.3.0` unimportable. This script packs the
 * package the way npm does and then:
 *
 *   1. asserts every relative import in the packed JS resolves inside the
 *      packed file set;
 *   2. asserts every relative declaration import resolves to a packed `.d.ts`;
 *   3. asserts every `exports` / `main` / `types` target is packed;
 *   4. reassembles the packed file set and imports the entry through the real
 *      `exports` map, so a missing module fails here rather than in a user's
 *      install.
 *
 * @module dsh-eval/pack-smoke
 */

import { execFileSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The package root (`packages/eval`). */
const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Matches `from './x'`, `import './x'` and `import('./x')` in built output. */
const RELATIVE_IMPORT = /\b(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/gu

/** Runtime exports the entry must expose for the bundle to mount. */
const EXPECTED_ENTRY_EXPORTS = ['apply', 'executeEval', 'inject', 'internals', 'name', 'resolveJudgeChat']

/** Runtime exports the `./invariant` subpath must expose. */
const EXPECTED_INVARIANT_EXPORTS = ['apply', 'inject', 'name']

/** Collected failures; a non-empty list exits nonzero. */
const failures = []

/** Normalize a platform path to a package-relative posix path. */
const toPosix = (value) => value.split(sep).join('/')

/**
 * Record a failure.
 * @param {string} message - what went wrong.
 */
function fail(message) {
  failures.push(message)
}

/**
 * Resolve a relative specifier against its importing file.
 * @param {string} specifier - the raw import specifier, e.g. `./runner.js`.
 * @param {string} from - package-relative path of the importing file.
 * @returns {string} the package-relative target path.
 */
function resolveSpecifier(specifier, from) {
  return posix.normalize(posix.join(posix.dirname(from), specifier)).replace(/^\.\//u, '')
}

/**
 * Map a declaration file's specifier onto the emitted `.d.ts` it means.
 *
 * `tsc` rewrites imports to `./x.js` in JS output, but declaration files keep
 * the source specifier (`./x.ts`) because the source enables
 * `allowImportingTsExtensions`; both denote `./x.d.ts` here.
 * @param {string} target - the resolved specifier target.
 * @returns {string} the expected packed declaration path.
 */
function declarationTarget(target) {
  if (target.endsWith('.js')) return `${target.slice(0, -3)}.d.ts`
  if (target.endsWith('.ts')) return `${target.slice(0, -3)}.d.ts`
  return `${target}.d.ts`
}

/**
 * Collect every literal path an `exports` map can resolve to.
 * @param {unknown} value - a node of the `exports` field.
 * @param {string[]} out - accumulator.
 */
function collectExportTargets(value, out) {
  if (typeof value === 'string') {
    if (!value.includes('*')) out.push(value.replace(/^\.\//u, ''))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) collectExportTargets(nested, out)
  }
}

/**
 * Pack the package and return the tarball name plus its file list.
 * @returns {{ files: string[], tarball: string }} packed entries as posix paths.
 */
function packPackage() {
  const staging = mkdtempSync(join(tmpdir(), 'dsh-eval-pack-'))
  const command = `npm pack --json --pack-destination "${staging}"`
  const stdout = execFileSync(command, {
    cwd: pkgDir,
    encoding: 'utf8',
    shell: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const [info] = JSON.parse(stdout)
  const files = info.files.map((entry) => toPosix(entry.path)).sort()
  return { files, tarball: join(staging, info.filename) }
}

/**
 * Rebuild the packed layout under the package's own node_modules so the entry's
 * bare specifiers resolve, then import it through the real `exports` map.
 * @param {string[]} files - packed package-relative paths.
 */
function importPackedEntry(files) {
  const scratch = join(pkgDir, 'node_modules', '.pack-smoke')
  rmSync(scratch, { recursive: true, force: true })
  try {
    const root = join(scratch, 'package')
    for (const file of files) {
      const destination = join(root, ...file.split('/'))
      mkdirSync(dirname(destination), { recursive: true })
      cpSync(join(pkgDir, ...file.split('/')), destination)
    }
    mkdirSync(join(scratch, 'node_modules'), { recursive: true })
    symlinkSync(root, join(scratch, 'node_modules', 'dsh-eval'), 'junction')
    writeFileSync(
      join(scratch, 'probe.mjs'),
      [
        "const entry = await import('dsh-eval')",
        "const invariant = await import('dsh-eval/invariant')",
        'process.stdout.write(JSON.stringify({',
        '  entry: Object.keys(entry).sort(),',
        '  invariant: Object.keys(invariant).sort(),',
        '}))',
      ].join('\n'),
    )
    const stdout = execFileSync(process.execPath, [join(scratch, 'probe.mjs')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return JSON.parse(stdout)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Assert that a probed export list covers the required names.
 * @param {string} label - subpath being checked.
 * @param {string[]} actual - exports the probe observed.
 * @param {string[]} expected - exports the subpath must expose.
 */
function checkExports(label, actual, expected) {
  for (const name of expected) {
    if (!actual.includes(name)) fail(`${label} does not export \`${name}\` (saw: ${actual.join(', ')})`)
  }
}

const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
const { files, tarball } = packPackage()
const packed = new Set(files)

process.stdout.write(`dsh-eval@${manifest.version} — ${files.length} files packed\n`)

// 1 + 2 — every relative import of every packed JS and declaration file resolves.
for (const file of files) {
  if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue
  const source = readFileSync(join(pkgDir, ...file.split('/')), 'utf8')
  for (const match of source.matchAll(RELATIVE_IMPORT)) {
    const target = resolveSpecifier(match[1], file)
    const expected = file.endsWith('.d.ts') ? declarationTarget(target) : target
    if (!packed.has(expected)) fail(`${file} imports \`${match[1]}\` but ${expected} is not packed`)
  }
}

// 3 — every exports/main/types target is packed.
const targets = []
collectExportTargets(manifest.exports, targets)
for (const field of ['main', 'types']) {
  if (typeof manifest[field] === 'string') targets.push(manifest[field].replace(/^\.\//u, ''))
}
for (const target of new Set(targets)) {
  if (!packed.has(target)) fail(`package.json points at ${target}, which is not packed`)
}

// 4 — the reassembled package imports through its own exports map.
try {
  const probe = importPackedEntry(files)
  checkExports('the entry point', probe.entry, EXPECTED_ENTRY_EXPORTS)
  checkExports('dsh-eval/invariant', probe.invariant, EXPECTED_INVARIANT_EXPORTS)
  if (failures.length === 0) process.stdout.write('packed entry imports cleanly through its exports map\n')
} catch (error) {
  fail(`importing the packed entry failed: ${error instanceof Error ? error.message : String(error)}`)
}

rmSync(dirname(tarball), { recursive: true, force: true })

if (failures.length > 0) {
  process.stderr.write(`\npack smoke test FAILED (${failures.length}):\n`)
  for (const failure of failures) process.stderr.write(`  ✗ ${failure}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('pack smoke test passed\n')
}
