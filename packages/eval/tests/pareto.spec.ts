import { describe, expect, it } from 'vitest'
import { computeParetoFrontier } from '../src/pareto.ts'

interface Point {
  name: string
  quality: number | null | undefined
  cost: number | null | undefined
}

function frontierOf(items: readonly Point[]): number[] {
  return computeParetoFrontier(items, item => item.quality, item => item.cost)
}

describe('dsh-eval cost–quality Pareto frontier', () => {
  it('returns no indices for no items and keeps a single comparable item', () => {
    expect(frontierOf([])).toEqual([])
    expect(frontierOf([{ name: 'solo', quality: 0.6, cost: 1 }])).toEqual([0])
  })

  it('keeps every trade-off when higher quality always costs more', () => {
    const items: Point[] = [
      { name: 'a', quality: 0.4, cost: 1 },
      { name: 'b', quality: 0.7, cost: 2 },
      { name: 'c', quality: 0.9, cost: 3 },
    ]
    expect(frontierOf(items)).toEqual([0, 1, 2])
    // The exact signature with number-only accessors also works.
    expect(computeParetoFrontier(items, item => item.quality ?? 0, item => item.cost ?? 0))
      .toEqual([0, 1, 2])
  })

  it('drops rows beaten on quality alone or on cost alone', () => {
    const items: Point[] = [
      { name: 'best', quality: 0.9, cost: 2 },
      { name: 'less-quality', quality: 0.7, cost: 2 },
      { name: 'more-cost', quality: 0.9, cost: 3 },
      { name: 'worse-both', quality: 0.6, cost: 4 },
    ]
    expect(frontierOf(items)).toEqual([0])
  })

  it('keeps only the first of identical quality/cost points', () => {
    const items: Point[] = [
      { name: 'first', quality: 0.8, cost: 1 },
      { name: 'twin', quality: 0.8, cost: 1 },
      { name: 'twin-again', quality: 0.8, cost: 1 },
      { name: 'beaten', quality: 0.5, cost: 2 },
      { name: 'beaten-twin', quality: 0.5, cost: 2 },
    ]
    expect(frontierOf(items)).toEqual([0])
  })

  it('excludes null, undefined and NaN scores without affecting other items', () => {
    const items: Point[] = [
      { name: 'null-quality', quality: null, cost: 1 },
      { name: 'null-cost', quality: 0.9, cost: null },
      { name: 'undefined-quality', quality: undefined, cost: 1 },
      { name: 'undefined-cost', quality: 0.9, cost: undefined },
      { name: 'nan-quality', quality: Number.NaN, cost: 1 },
      { name: 'nan-cost', quality: 0.9, cost: Number.NaN },
      { name: 'only-valid', quality: 0.2, cost: 5 },
    ]
    expect(frontierOf(items)).toEqual([6])
  })

  it('returns ascending original indices deterministically', () => {
    const items: Point[] = [
      { name: 'dominated-early', quality: 0.3, cost: 4 },
      { name: 'frontier-a', quality: 0.6, cost: 2 },
      { name: 'dominated-late', quality: 0.2, cost: 9 },
      { name: 'frontier-b', quality: 0.9, cost: 5 },
    ]
    expect(frontierOf(items)).toEqual([1, 3])
    expect(frontierOf(items)).toEqual([1, 3])
    expect(items.map(item => item.name))
      .toEqual(['dominated-early', 'frontier-a', 'dominated-late', 'frontier-b'])
  })
})
