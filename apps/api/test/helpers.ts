import { createDb } from '../src/db/client'
import { seed, DEMO_USER } from '../src/db/seed'
import { buildServer } from '../src/server'

export async function testServer() {
  const db = createDb(':memory:')
  await seed(db)
  const app = await buildServer({ db })
  async function login(): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: DEMO_USER.email, password: DEMO_USER.password },
    })
    const raw = res.headers['set-cookie']
    const cookie = (Array.isArray(raw) ? raw[0] : raw) ?? ''
    return cookie.split(';')[0]!
  }
  return { app, db, login }
}
