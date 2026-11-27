/**
 * Cross-run dimension comparison.
 *
 * A single run's `Segments` table says how a benchmark did on `hard` cases;
 * answering "did the hard cases get better?" needs two runs. This module
 * aligns two runs on their case tags and reports per-tag deltas for task
 * success and judge score. Tags present in only one run are kept, with a null
 * delta instead of being silently dropped or treated as zero.
 *
 * @module dsh-eval/segment-compare
 */

import { computeSegments, type SegmentStat } from './dimensions.ts'
import type { EvalRun } from './types.ts'

/** One tag's position in two runs. */
export interface SegmentDelta {
  tag: string
  baseline: SegmentStat | null
  candidate: SegmentStat | null
  /** Candidate minus baseline in percentage points; null without both sides. */
  taskSuccessDelta: number | null
  /** Candidate minus baseline in judge score units; null without both sides. */
  judgeScoreDelta: number | null
}

function delta(before: number | null | undefined, after: number | null | undefined): number | null {
  if (before === null || before === undefined || after === null || after === undefined) return null
  return after - before
}

/** Align two runs by tag, sorted by tag in code-unit order. */
export function compareSegments(baseline: EvalRun, candidate: EvalRun): SegmentDelta[] {
  const before = new Map(computeSegments(baseline).map(stat => [stat.tag, stat]))
  const after = new Map(computeSegments(candidate).map(stat => [stat.tag, stat]))
  const tags = new Set([...before.keys(), ...after.keys()])
  return [...tags].sort((a, b) => Number(a > b) - Number(a < b)).map(tag => {
    const base = before.get(tag)
    const cand = after.get(tag)
    return {
      tag,
      baseline: base ?? null,
      candidate: cand ?? null,
      taskSuccessDelta: delta(base?.taskSuccessRate, cand?.taskSuccessRate),
      judgeScoreDelta: delta(base?.judgeScoreMean, cand?.judgeScoreMean),
    }
  })
}

/**
 * Benchmark-controlled tags are printed to the terminal by the `segments`
 * command. Strip control bytes (including ESC sequences) as well as markdown
 * syntax so a hostile tag cannot repaint or inject into the console.
 */
function escapeMarkdown(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
    .replace(/[|`]/gu, ' ')
}

function rate(value: number | null | undefined): string {
  return value === null || value === undefined ? '–' : `${(value * 100).toFixed(1)}%`
}

function score(value: number | null | undefined): string {
  return value === null || value === undefined ? '–' : value.toFixed(1)
}

function signed(value: number | null, scale = 1, suffix = ''): string {
  if (value === null) return '–'
  const scaled = value * scale
  return `${scaled >= 0 ? '+' : ''}${scaled.toFixed(1)}${suffix}`
}

/** Render aligned segment deltas as a markdown table. */
export function renderSegmentComparison(deltas: SegmentDelta[]): string {
  const lines = [
    '## Segment comparison',
    '',
    '| tag | baseline task | candidate task | Δ task | baseline score | candidate score | Δ score |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const item of deltas) {
    lines.push(`| ${escapeMarkdown(item.tag)} | ${rate(item.baseline?.taskSuccessRate)} | ${rate(item.candidate?.taskSuccessRate)} | ${signed(item.taskSuccessDelta, 100, 'pp')} | ${score(item.baseline?.judgeScoreMean)} | ${score(item.candidate?.judgeScoreMean)} | ${signed(item.judgeScoreDelta)} |`)
  }
  return `${lines.join('\n')}\n`
}

/** Render aligned segment deltas as machine-readable JSON. */
export function renderSegmentComparisonJson(deltas: SegmentDelta[]): string {
  return `${JSON.stringify(deltas)}\n`
}
