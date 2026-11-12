import { describe, it, expect } from 'vitest'
import { createDb } from '../src/db/client'
import { seed, DEMO_USER } from '../src/db/seed'
import { sessions, users } from '../src/db/schema'
import { createSession, purgeExpiredSessions } from '../src/auth/sessions'
import { testServer } from './helpers'

const closeCode = (ws: { once(ev: 'close', fn: (code: number) => void): void }) =>
  new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))

describe('sessions', () => {
  it('the cookie lasts 7 days, is httpOnly and SameSite=Lax, and is Secure over HTTPS', async () => {
    const { app } = await testServer({ fakeWidget: true, server: { trustProxy: true } })
    const login = (headers: Record<string, string> = {}) => app.inject({
      method: 'POST', url: '/api/auth/login', headers, payload: { email: DEMO_USER.email, password: DEMO_USER.password },
    })
    const plain = String((await login()).headers['set-cookie'])
    expect(plain).toMatch(/Max-Age=604800/)
    expect(plain).toMatch(/HttpOnly/)
    expect(plain).toMatch(/SameSite=Lax/)
    expect(plain).not.toMatch(/Secure/)
    expect(String((await login({ 'x-forwarded-proto': 'https' })).headers['set-cookie'])).toMatch(/Secure/)
  })

  it('creating a session purges the expired ones', async () => {
    const db = createDb(':memory:')
    await seed(db)
    const userId = db.select().from(users).get()!.id
    db.insert(sessions).values({ token: 'old', userId, expiresAt: '2000-01-01T00:00:00.000Z' }).run()
    expect(purgeExpiredSessions(db, new Date('1999-01-01'))).toBe(0)
    createSession(db, userId)
    const tokens = db.select().from(sessions).all().map((s) => s.token)
    expect(tokens).toHaveLength(1)
    expect(tokens).not.toContain('old')
  })

  it('an expired session is refused', async () => {
    const { app, db, login } = await testServer()
    const cookie = await login()
    db.update(sessions).set({ expiresAt: '2000-01-01T00:00:00.000Z' }).run()
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401)
  })

  it('signing out closes the inbox sockets of that session', async () => {
    const { app, login } = await testServer()
    await app.ready()
    const cookie = await login()
    const ws = await app.injectWS('/ws/inbox', { headers: { cookie } })
    const closed = closeCode(ws)
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })
    expect(await closed).toBe(4401)
  })

  it('an open inbox socket is closed when its session expires', async () => {
    const { app, db, login } = await testServer({ fakeWidget: true, server: { sessionCheckMs: 20 } })
    await app.ready()
    const cookie = await login()
    const ws = await app.injectWS('/ws/inbox', { headers: { cookie } })
    const closed = closeCode(ws)
    db.update(sessions).set({ expiresAt: '2000-01-01T00:00:00.000Z' }).run()
    expect(await closed).toBe(4401)
  })
})
