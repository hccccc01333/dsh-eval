#!/usr/bin/env node
/**
 * Print the local-harness workspace closure dsh-eval needs.
 *
 * dsh-eval resolves its @deepseek-ai/* devDependencies to the local
 * deepseek-harness checkout through the `harness/` junction. Globbing the whole
 * harness tree drags in ~247 workspace members, some of which cannot resolve
 * standalone — so pnpm-workspace.yaml lists the transitive `workspace:^`
 * closure explicitly instead.
 *
 * Run this after a harness change to refresh that list:
 *
 *   node scripts/harness-closure.mjs
 *
 * It prints the ready-to-paste `packages:` entries and flags any member the
 * harness tree no longer provides.
 *
 * @module dsh-eval/harness-closure
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'

/** Workspace-relative root of the harness checkout. */
const HARNESS = 'harness'

/** The harness's own workspace globs, which define which members can exist. */
const HARNESS_GLOBS = [
  'vendor/*',
  'packages/*/*',
  'native/landlock-run',
  'native/landlock-run/packages/*',
  'apps/*',
  'website',
  'examples',
  'python/sdk-runtime',
]

/** The eval plugin's @deepseek-ai/* devDependencies — the closure roots. */
const ROOTS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/dsh-cmdline',
  '@deepseek-ai/dsh-invariants',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-retry',
  '@deepseek-ai/dsh-session',
]

/** Dependency fields whose `workspace:` ranges pull a member into the closure. */
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

/**
 * Expand one harness glob into the package directories it matches.
 * @param glob - a workspace glob relative to the harness root.
 * @returns the matching directories that carry a package.json.
 */
function expand(glob) {
  const found = []
  const walk = (base, segments, index) => {
    if (index === segments.length) {
      try {
        if (statSync(join(base, 'package.json')).isFile()) found.push(base)
      } catch {
        // Not a package directory; nothing to add.
      }
      return
    }
    let stat
    try {
      stat = statSync(base)
    } catch {
      return
    }
    if (!stat.isDirectory()) return
    const segment = segments[index]
    if (segment === '*') {
      for (const entry of readdirSync(base)) walk(join(base, entry), segments, index + 1)
    } else {
      walk(join(base, segment), segments, index + 1)
    }
  }
  walk(HARNESS, glob.split('/'), 0)
  return found
}

/** Map every harness workspace member's package name to its directory. */
function indexMembers() {
  const byName = new Map()
  for (const glob of HARNESS_GLOBS) {
    for (const dir of expand(glob)) {
      let manifest
      try {
        manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      } catch {
        continue
      }
      if (typeof manifest.name === 'string' && !byName.has(manifest.name)) {
        byName.set(manifest.name, dir)
      }
    }
  }
  return byName
}

/**
 * Walk `workspace:` dependency edges from the roots.
 * @param byName - member name to directory index.
 * @returns the reached member directories, in stable order, plus unresolvable names.
 */
function closure(byName) {
  const seen = new Set()
  const missing = new Set()
  const queue = [...ROOTS]
  while (queue.length > 0) {
    const name = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)
    const dir = byName.get(name)
    if (dir === undefined) {
      missing.add(name)
      continue
    }
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    for (const field of DEP_FIELDS) {
      for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
        if (typeof range === 'string' && range.startsWith('workspace:')) queue.push(dep)
      }
    }
  }
  const dirs = [...seen].filter((name) => byName.has(name)).map((name) => byName.get(name))
  return { dirs: dirs.sort(), missing: [...missing].sort() }
}

const byName = indexMembers()
const { dirs, missing } = closure(byName)

process.stdout.write(`# harness members indexed: ${byName.size}\n`)
process.stdout.write(`# closure size: ${dirs.length}\n\n`)
for (const dir of dirs) process.stdout.write(`  - ${posix.join(...dir.split('\\'))}\n`)

if (missing.length > 0) {
  process.stdout.write(`\n# UNRESOLVED — the harness tree does not provide:\n`)
  for (const name of missing) process.stdout.write(`#   ${name}\n`)
  process.exitCode = 1
}
