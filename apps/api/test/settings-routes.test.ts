import { describe, it, expect } from 'vitest'
import { testServer } from './helpers'

describe('settings routes', () => {
  it('require a session', async () => {
    const { app } = await testServer()
    expect((await app.inject({ method: 'GET', url: '/api/settings' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: {} })).statusCode).toBe(401)
  })

  it('read and partially update the settings', async () => {
    const { app, login } = await testServer()
    const headers = { cookie: await login() }
    const got = await app.inject({ method: 'GET', url: '/api/settings', headers })
    expect(got.json().settings.turnLimit).toBe(10)
    const put = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { turnLimit: 3 } })
    expect(put.statusCode).toBe(200)
    expect(put.json().settings).toMatchObject({ turnLimit: 3, transcriptionEnabled: true })
  })

  it('reject invalid values and unknown keys, naming the fields', async () => {
    const { app, login } = await testServer()
    const headers = { cookie: await login() }
    const bad = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { turnLimit: 0, instructions: '   ' } })
    expect(bad.statusCode).toBe(400)
    expect(bad.json()).toEqual({ error: 'Invalid request', code: 'invalid_request', fields: ['instructions', 'turnLimit'] })
    const unknown = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { color: 'red' } })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.json().code).toBe('invalid_request')
  })
})
