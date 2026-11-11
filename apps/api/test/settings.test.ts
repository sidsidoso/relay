import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDb } from '../src/db/client'
import { seed } from '../src/db/seed'
import { settings } from '../src/db/schema'
import { agentSettings } from '../src/core/settings'

describe('agentSettings', () => {
  it('reads the seeded defaults', async () => {
    const db = createDb(':memory:')
    await seed(db)
    expect(agentSettings(db)).toMatchObject({ turnLimit: 10, handoffKeywords: ['human', 'agent', 'atendente', 'humano'] })
  })

  it('falls back to the default for an invalid stored value', async () => {
    const db = createDb(':memory:')
    await seed(db)
    db.update(settings).set({ value: 'not a number' }).where(eq(settings.key, 'agent.turnLimit')).run()
    expect(agentSettings(db).turnLimit).toBe(10)
  })
})
