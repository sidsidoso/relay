import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDb } from '../src/db/client'
import { seed } from '../src/db/seed'
import { settings } from '../src/db/schema'
import { agentSettings, transcriptionEnabled } from '../src/core/settings'

describe('agentSettings', () => {
  it('reads the seeded defaults', async () => {
    const db = createDb(':memory:')
    await seed(db)
    expect(agentSettings(db)).toMatchObject({ turnLimit: 10, handoffKeywords: ['human', 'humano', 'atendente', 'real person', 'pessoa real'] })
  })

  it('falls back to the default for an invalid stored value', async () => {
    const db = createDb(':memory:')
    await seed(db)
    db.update(settings).set({ value: 'not a number' }).where(eq(settings.key, 'agent.turnLimit')).run()
    expect(agentSettings(db).turnLimit).toBe(10)
  })

  it('transcription is on by default, can be turned off, and an invalid value means on', async () => {
    const db = createDb(':memory:')
    await seed(db)
    expect(transcriptionEnabled(db)).toBe(true)
    db.update(settings).set({ value: false }).where(eq(settings.key, 'transcription.enabled')).run()
    expect(transcriptionEnabled(db)).toBe(false)
    db.update(settings).set({ value: 'yes' }).where(eq(settings.key, 'transcription.enabled')).run()
    expect(transcriptionEnabled(db)).toBe(true)
  })

  it('upgrades the old default keyword list, and only that list', async () => {
    const db = createDb(':memory:')
    await seed(db)
    db.update(settings).set({ value: ['human', 'agent', 'atendente', 'humano'] }).where(eq(settings.key, 'agent.handoffKeywords')).run()
    await seed(db)
    expect(agentSettings(db).handoffKeywords).toEqual(['human', 'humano', 'atendente', 'real person', 'pessoa real'])
    db.update(settings).set({ value: ['human', 'agent'] }).where(eq(settings.key, 'agent.handoffKeywords')).run()
    await seed(db)
    expect(agentSettings(db).handoffKeywords).toEqual(['human', 'agent'])
  })
})
