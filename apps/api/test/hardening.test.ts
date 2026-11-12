import { describe, it, expect } from 'vitest'
import { testServer } from './helpers'
import { API_SECURITY_HEADERS } from '../src/http/security'

describe('HTTP hardening', () => {
  it('every API response carries the security headers, errors included', async () => {
    const { app } = await testServer()
    for (const url of ['/api/health', '/api/auth/me', '/api/nope']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.headers).toMatchObject(API_SECURITY_HEADERS)
    }
  })

  it('unknown routes answer 404 with a stable code', async () => {
    const { app } = await testServer()
    const res = await app.inject({ method: 'POST', url: '/api/does-not-exist' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'Not found', code: 'not_found' })
  })

  it('a malformed email is a validation error', async () => {
    const { app } = await testServer()
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'not-an-email', password: 'x' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'invalid_request', fields: ['email'] })
  })
})
