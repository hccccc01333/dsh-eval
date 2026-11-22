/**
 * Multi-run leaderboard for dsh-eval.
 *
 * `compare` answers a two-run question with paired inference; a leaderboard
 * answers the wider "which of these runs is currently best" question. Ranks
 * use pooled task success with deterministic tie-breakers, and every row shows
 * how far it trails the leader. This is a screening view, not a significance
 * test, but each non-leader row carries a Bonferroni-corrected paired verdict
 * against the leader so a one-point lead is not mistaken for a real gap.
 *
 * @module dsh-eval/leaderboard
 */

import { pairedCompare } from './compare.ts'
import { computeCoverage, computeReliability } from './reliability.ts'
import { signTestPower } from './stats.ts'
import type { EvalRun } from './types.ts'

/** Paired evidence that a row really trails the current leader. */
export interface LeaderboardSignificance {
  /** Adjusted p-value after both the compare family and leaderboard family. */
  adjustedP: number
  /** Whether the smallest attainable p-value can reach alpha at this sample size. */
  detectable: boolean
  /** Whether the paired primary metric moved against the row. */
  worse: boolean
  /** The paired metric the verdict is based on. */
  primaryMetric: string | null
  /** Machine-readable interpretation of the comparison. */
  verdict: 'significantly-behind' | 'behind-not-significant' | 'ahead-or-tied'
    | 'underpowered' | 'unpaired'
}

/** One ranked run. */
export interface LeaderboardEntry {
  label: string
  benchmark: string
  model: string
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
  /** Paired verdict against the leader; null for the leader itself. */
  significance: LeaderboardSignificance | null
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
  const runByEntry = new Map<LeaderboardEntry, EvalRun>()
  const rows: LeaderboardEntry[] = runs.map(({ label, run }) => {
    const coverage = computeCoverage(run)
    const reliability = computeReliability(run, 'task')
    const entry: LeaderboardEntry = {
      label,
      benchmark: run.benchmark,
      model: run.model,
      completed: coverage.completed,
      total: coverage.total,
      taskSuccess: run.grading?.taskSuccessRate ?? null,
      strictPassAt1: reliability?.strictPassAt1 ?? null,
      toolSelection: run.grading?.toolSelectionAccuracyRate ?? null,
      judgeScore: judgeRate(run),
      costUsd: run.aggregate?.costUsd ?? null,
      latencyMs: run.aggregate?.latencyMs ?? null,
      gapFromBest: null,
      significance: null,
      rank: 0,
    }
    runByEntry.set(entry, run)
    return entry
  })
  rows.sort((a, b) => descending(a.taskSuccess, b.taskSuccess)
    || descending(a.strictPassAt1, b.strictPassAt1)
    || descending(a.toolSelection, b.toolSelection)
    || descending(a.judgeScore, b.judgeScore)
    || a.label.localeCompare(b.label))
  const best = rows[0]?.taskSuccess ?? null
  let lastRate: number | null = null
  let lastRank = 0
  let first = true
  rows.forEach((row, index) => {
    if (row.taskSuccess === null || first || row.taskSuccess !== lastRate) {
      lastRank = index + 1
      lastRate = row.taskSuccess
      first = false
    }
    row.rank = lastRank
    row.gapFromBest = best === null || row.taskSuccess === null ? null : best - row.taskSuccess
  })
  const leader = rows.find(row => row.rank === 1)
  const leaderRun = leader === undefined ? undefined : runByEntry.get(leader)
  const family = Math.max(1, rows.length - 1)
  if (leaderRun !== undefined) {
    for (const row of rows) {
      if (row === leader) continue
      const paired = pairedCompare(leaderRun, runByEntry.get(row)!)
      if (paired === null) {
        row.significance = {
          adjustedP: 1, detectable: false, worse: false, primaryMetric: null,
          verdict: 'unpaired',
        }
        continue
      }
      const worse = paired.losses > paired.wins
      // The verdict concerns the one primary metric only, so the board's
      // comparison family is the only correction that applies here. Comparing
      // every metric (as `paired.correction` does) would double-count.
      const adjustedP = Math.min(1, paired.test.pValue * family)
      const detectable = signTestPower(paired.losses + paired.wins,
        family, paired.correction.alpha).detectable
      row.significance = {
        adjustedP,
        detectable,
        worse,
        primaryMetric: paired.primaryMetric,
        verdict: !detectable ? 'underpowered'
          : worse && adjustedP <= paired.correction.alpha ? 'significantly-behind'
            : worse ? 'behind-not-significant' : 'ahead-or-tied',
      }
    }
  }
  return rows
}

/**
 * Render leaderboard rows as machine-readable JSON.
 * @param rows - rows from {@link buildLeaderboard}.
 * @returns a JSON string ending in a newline.
 */
export function renderLeaderboardJson(rows: readonly LeaderboardEntry[]): string {
  return `${JSON.stringify({ rankedBy: 'taskSuccess', rows })}\n`
}

/** Format a rate or a dash for markdown. */
function rate(value: number | null): string {
  return value === null ? '–' : `${(value * 100).toFixed(1)}%`
}

/** Format a signed percentage-point gap from the leader. */
function gap(value: number | null, rank: number): string {
  if (value === null) return '–'
  if (rank === 1) return 'leader'
  return `-${(value * 100).toFixed(1)}pp`
}

/** Format the paired verdict against the leader. */
export function formatLeaderboardSignificance(value: LeaderboardSignificance | null): string {
  if (value === null) return 'leader'
  if (value.verdict === 'unpaired') return 'unpaired'
  return `${value.verdict} (p=${value.adjustedP.toFixed(3)}, ${value.primaryMetric})`
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
    '- ranks are a screening view; `vs leader` applies a Bonferroni-corrected paired sign test',
    '',
    '| rank | run | completed | task | strict pass@1 | tool | judge | cost/trial | latency/trial | Δ best | vs leader |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ]
  for (const row of rows) {
    const label = row.label.replace(/[\r\n|]/gu, ' ')
    lines.push(`| ${row.rank} | ${label} | ${row.completed}/${row.total} | ${rate(row.taskSuccess)} | ${rate(row.strictPassAt1)} | ${rate(row.toolSelection)} | ${rate(row.judgeScore)} | ${row.costUsd === null ? '–' : `$${row.costUsd.toFixed(6)}`} | ${row.latencyMs === null ? '–' : `${row.latencyMs.toFixed(1)} ms`} | ${gap(row.gapFromBest, row.rank)} | ${formatLeaderboardSignificance(row.significance)} |`)
  }
  return `${lines.join('\n')}\n`
}
