import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDb } from '../src/db/client'
import { seed, DEFAULT_SETTINGS, DEMO_USER } from '../src/db/seed'
import { users, settings } from '../src/db/schema'
import { verifyPassword } from '../src/auth/password'

describe('database', () => {
  it('migrates an empty database and seeds the demo user and settings', async () => {
    const db = createDb(':memory:')
    await seed(db)
    const [u] = db.select().from(users).where(eq(users.email, DEMO_USER.email)).all()
    expect(u?.name).toBe('Demo Agent')
    expect(await verifyPassword(DEMO_USER.password, u!.passwordHash)).toBe(true)
    const rows = db.select().from(settings).all()
    expect(Object.fromEntries(rows.map((r) => [r.key, r.value]))).toEqual(DEFAULT_SETTINGS)
  })

  it('seed is idempotent', async () => {
    const db = createDb(':memory:')
    await seed(db)
    await seed(db)
    expect(db.select().from(users).all()).toHaveLength(1)
  })
})
