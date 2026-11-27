/**
 * Cost–quality Pareto frontier for dsh-eval.
 *
 * A leaderboard ranks runs by quality alone; this module adds the other axis.
 * A configuration is dominated when another one is at least as good, costs no
 * more, and is strictly better on at least one of the two axes. A dominated
 * configuration answers the "2x cost for 1pp" question with a clear "no":
 * the same or better quality is available for less.
 *
 * Items without a usable quality or cost never take part and never dominate
 * anyone. Identical (quality, cost) points keep only their first occurrence so
 * reruns of one configuration do not inflate the frontier.
 *
 * @module dsh-eval/pareto
 */

/** Score accessor: null/undefined/NaN mark an item that cannot join the frontier. */
export type ParetoScore<T> = (item: T) => number | null | undefined

/** A usable point, carrying its original position so output stays in input order. */
interface ScoredPoint {
  index: number
  quality: number
  cost: number
}

/** Whether a score can be compared on either frontier axis. */
function usable(value: number | null | undefined): value is number {
  return typeof value === 'number' && !Number.isNaN(value)
}

/**
 * Indices of the non-dominated items, in ascending order and deterministic.
 * @param items - configurations in a stable order; results index into this array.
 * @param quality - higher is better; null/undefined/NaN exclude an item.
 * @param cost - lower is better; null/undefined/NaN exclude an item.
 * @returns the frontier indices; an empty array when nothing is comparable.
 */
export function computeParetoFrontier<T>(
  items: readonly T[],
  quality: (item: T) => number,
  cost: (item: T) => number,
): number[]
export function computeParetoFrontier<T>(
  items: readonly T[],
  quality: ParetoScore<T>,
  cost: ParetoScore<T>,
): number[]
export function computeParetoFrontier<T>(
  items: readonly T[],
  quality: ParetoScore<T>,
  cost: ParetoScore<T>,
): number[] {
  const points: ScoredPoint[] = []
  items.forEach((item, index) => {
    const q = quality(item)
    const c = cost(item)
    if (usable(q) && usable(c)) points.push({ index, quality: q, cost: c })
  })
  const frontier: number[] = []
  for (const point of points) {
    const dominated = points.some(other =>
      other.quality >= point.quality && other.cost <= point.cost
      && (other.quality > point.quality || other.cost < point.cost
        || other.index < point.index))
    if (!dominated) frontier.push(point.index)
  }
  return frontier
}
