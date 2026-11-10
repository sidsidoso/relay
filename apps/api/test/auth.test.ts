import { describe, it, expect, vi } from 'vitest'
import * as password from '../src/auth/password'
import { testServer } from './helpers'
import { DEMO_USER } from '../src/db/seed'

describe('auth', () => {
  it('logs in with the demo user and reads /me with the cookie', async () => {
    const { app, login } = await testServer()
    const cookie = await login()
    expect(cookie).toMatch(/^relay_session=/)
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    expect(me.statusCode).toBe(200)
    expect(me.json().user).toMatchObject({ email: DEMO_USER.email, name: 'Demo Agent' })
    expect(me.json().user.passwordHash).toBeUndefined()
  })

  it('rejects a wrong password with a stable code', async () => {
    const { app } = await testServer()
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: DEMO_USER.email, password: 'nope' } })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'Invalid email or password', code: 'invalid_credentials' })
  })

  it('unknown email gets the same 401 body and still runs a dummy password verification', async () => {
    const { app } = await testServer()
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: DEMO_USER.email, password: 'nope' } })
    const spy = vi.spyOn(password, 'verifyPassword')
    try {
      const unknown = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ghost@example.com', password: 'nope' } })
      expect(unknown.statusCode).toBe(401)
      expect(unknown.json()).toEqual(wrong.json())
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('rejects a malformed body with 400', async () => {
    const { app } = await testServer()
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 1 } })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid_body')
  })

  it('/me without a session is 401', async () => {
    const { app } = await testServer()
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unauthenticated')
  })

  it('logout ends the session', async () => {
    const { app, login } = await testServer()
    const cookie = await login()
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })
    expect(out.statusCode).toBe(204)
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    expect(me.statusCode).toBe(401)
  })
})
