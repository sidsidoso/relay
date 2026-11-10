import { describe, it, expect } from 'vitest'
import { testServer } from './helpers'

describe('GET /api/health', () => {
  it('answers ok', async () => {
    const { app } = await testServer()
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    await app.close()
  })
})
