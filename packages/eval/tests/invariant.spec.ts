import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as invariant from '../src/invariant.ts'

describe('dsh-eval invariant companion', () => {
  it('registers the empty installer under the package name and disposes it', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, {})
    expect(invariant.name).toBe('eval-invariant')
    expect(invariant.inject).toEqual(['invariants'])
    expect('default' in invariant).toBe(false)
    const dispose = await invariant.apply(ctx)
    dispose()
  })
})
