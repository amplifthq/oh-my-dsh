import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'fixture-organ'
export const inject = []
export const provide = ['fixtureOrgan']
export const Config = z.object({
  fail: z.boolean().default(false),
})

export const fixtureEvents = []

export function resetFixtureEvents() {
  fixtureEvents.length = 0
}

class FixtureOrganService extends Service {
  constructor(ctx) {
    super(ctx, 'fixtureOrgan')
    this.value = 'active'
  }
}

export function apply(ctx, config) {
  if (config.fail) throw new Error('fixture organ startup failed')
  new FixtureOrganService(ctx)
  ctx.effect(() => {
    fixtureEvents.push('mounted')
    return () => fixtureEvents.push('disposed')
  }, 'fixture-organ.reversible-effect')
}
