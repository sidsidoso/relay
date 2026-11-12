import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDb } from '../src/db/client'
import { seed } from '../src/db/seed'
import { settings } from '../src/db/schema'
import { agentSettings, transcriptionEnabled, readSettings, updateSettings } from '../src/core/settings'

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

describe('readSettings / updateSettings', () => {
  it('reads every setting, typed', async () => {
    const db = createDb(':memory:')
    await seed(db)
    expect(readSettings(db)).toMatchObject({ turnLimit: 10, transcriptionEnabled: true })
    expect(typeof readSettings(db).instructions).toBe('string')
  })

  it('updates only the fields in the patch and returns the new settings', async () => {
    const db = createDb(':memory:')
    await seed(db)
    const before = readSettings(db)
    const after = updateSettings(db, { turnLimit: 4, transcriptionEnabled: false })
    expect(after).toEqual({ ...before, turnLimit: 4, transcriptionEnabled: false })
    expect(transcriptionEnabled(db)).toBe(false)
    expect(agentSettings(db).turnLimit).toBe(4)
  })

  it('trims text and keywords', async () => {
    const db = createDb(':memory:')
    await seed(db)
    const s = updateSettings(db, { handoffMessage: '  Hold on  ', handoffKeywords: [' human ', 'manager'] })
    expect(s.handoffMessage).toBe('Hold on')
    expect(s.handoffKeywords).toEqual(['human', 'manager'])
  })
})
