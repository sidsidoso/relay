import { describe, it, expect, vi } from 'vitest'
import { testServer } from './helpers'
import { buildServer } from '../src/server'

describe('error handler', () => {
  it('malformed JSON is a 400 client error, not a 500', async () => {
    const { app, login } = await testServer()
    const cookie = await login()
    const res = await app.inject({
      method: 'POST', url: '/api/conversations/1/messages',
      headers: { cookie, 'content-type': 'application/json' }, payload: '{not json',
    })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(typeof body.error).toBe('string')
    expect(typeof body.code).toBe('string')
  })

  it('unexpected errors are logged and answered as 500 internal', async () => {
    const { deps } = await testServer()
    const app = await buildServer(deps)
    app.get('/api/boom', async () => { throw new Error('kaboom') })
    await app.ready()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await app.inject({ method: 'GET', url: '/api/boom' })
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({ error: 'Internal error', code: 'internal' })
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('unknown conversation is 404 not_found', async () => {
    const { app, login } = await testServer()
    const cookie = await login()
    const res = await app.inject({ method: 'POST', url: '/api/conversations/99999/close', headers: { cookie } })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'Conversation not found', code: 'not_found' })
  })

  it('bad :id is 400 invalid_request', async () => {
    const { app, login } = await testServer()
    const cookie = await login()
    const res = await app.inject({ method: 'GET', url: '/api/conversations/abc', headers: { cookie } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'Invalid request', code: 'invalid_request' })
  })
})
