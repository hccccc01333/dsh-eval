/**
 * Multi-run leaderboard for dsh-eval.
 *
 * `compare` answers a two-run question with paired inference; a leaderboard
 * answers the wider "which of these runs is currently best" question. Ranks
 * use pooled task success with deterministic tie-breakers, and every row shows
 * how far it trails the leader. This is a screening view, not a significance
 * test: use `compare` for the paired decision between two close runs.
 *
 * @module dsh-eval/leaderboard
 */

import { computeCoverage, computeReliability } from './reliability.ts'
import type { EvalRun } from './types.ts'

/** One ranked run. */
export interface LeaderboardEntry {
  label: string
  rank: number
  completed: number
  total: number
  taskSuccess: number | null
  strictPassAt1: number | null
  toolSelection: number | null
  judgeScore: number | null
  costUsd: number | null
  latencyMs: number | null
  gapFromBest: number | null
}

/** Normalize a pooled judge score using the run's configured scale. */
function judgeRate(run: EvalRun): number | null {
  const score = run.grading?.finalAnswerScore
  const maxScore = run.judge?.maxScore
  if (score === null || score === undefined || maxScore === undefined || maxScore <= 0) return null
  return Math.max(0, Math.min(1, score / maxScore))
}

/** Prefer higher values, pushing missing metrics to the bottom. */
function descending(a: number | null, b: number | null): number {
  if (a === null) return b === null ? 0 : 1
  if (b === null) return -1
  return b - a
}

/**
 * Rank persisted runs by task success.
 * @param runs - labelled run records; labels are usually `benchmark — model`.
 * @returns ranked rows with ties sharing a rank.
 */
export function buildLeaderboard(runs: readonly { label: string; run: EvalRun }[]): LeaderboardEntry[] {
  const rows: LeaderboardEntry[] = runs.map(({ label, run }) => {
    const coverage = computeCoverage(run)
    const reliability = computeReliability(run, 'task')
    return {
      label,
      completed: coverage.completed,
      total: coverage.total,
      taskSuccess: run.grading?.taskSuccessRate ?? null,
      strictPassAt1: reliability?.strictPassAt1 ?? null,
      toolSelection: run.grading?.toolSelectionAccuracyRate ?? null,
      judgeScore: judgeRate(run),
      costUsd: run.aggregate?.costUsd ?? null,
      latencyMs: run.aggregate?.latencyMs ?? null,
      gapFromBest: null,
      rank: 0,
    }
  })
  rows.sort((a, b) => descending(a.taskSuccess, b.taskSuccess)
    || descending(a.strictPassAt1, b.strictPassAt1)
    || descending(a.toolSelection, b.toolSelection)
    || descending(a.judgeScore, b.judgeScore)
    || a.label.localeCompare(b.label))
  const best = rows[0]?.taskSuccess ?? null
  let lastRate: number | null = null
  let lastRank = 0
  rows.forEach((row, index) => {
    if (row.taskSuccess !== lastRate) {
      lastRank = index + 1
      lastRate = row.taskSuccess
    }
    row.rank = lastRank
    row.gapFromBest = best === null || row.taskSuccess === null ? null : best - row.taskSuccess
  })
  return rows
}

/** Format a rate or a dash for markdown. */
function rate(value: number | null): string {
  return value === null ? '–' : `${(value * 100).toFixed(1)}%`
}

/** Format a signed percentage-point gap from the leader. */
function gap(value: number | null, rank: number): string {
  if (rank === 1) return 'leader'
  if (value === null) return '–'
  return `-${(value * 100).toFixed(1)}pp`
}

/**
 * Render a leaderboard as markdown.
 * @param rows - rows from {@link buildLeaderboard}.
 * @returns markdown ending in a newline.
 */
export function renderLeaderboard(rows: readonly LeaderboardEntry[]): string {
  const lines = [
    '# Leaderboard',
    '',
    '- ranked by pooled task success; ties share a rank',
    '- screening view only — use `dsh eval compare` for paired inference between two runs',
    '',
    '| rank | run | completed | task | strict pass@1 | tool | judge | cost/trial | latency/trial | Δ best |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ]
  for (const row of rows) {
    const label = row.label.replace(/[\r\n|]/gu, ' ')
    lines.push(`| ${row.rank} | ${label} | ${row.completed}/${row.total} | ${rate(row.taskSuccess)} | ${rate(row.strictPassAt1)} | ${rate(row.toolSelection)} | ${rate(row.judgeScore)} | ${row.costUsd === null ? '–' : `$${row.costUsd.toFixed(6)}`} | ${row.latencyMs === null ? '–' : `${row.latencyMs.toFixed(1)} ms`} | ${gap(row.gapFromBest, row.rank)} |`)
  }
  return `${lines.join('\n')}\n`
}
