import { describe, it, expect } from 'vitest'
import { testServer } from './helpers'
import { receiveInbound } from '../src/core/conversations'

const hello = { channel: 'widget' as const, contactKey: 'v-1', contactName: 'Ana', type: 'text' as const, text: 'Hi!' }

describe('inbox routes', () => {
  it('require a session', async () => {
    const { app } = await testServer()
    const res = await app.inject({ method: 'GET', url: '/api/conversations' })
    expect(res.statusCode).toBe(401)
  })

  it('list, open, assign to me, reply, hand back and close', async () => {
    const { app, deps, sent, login } = await testServer()
    const cookie = await login()
    const { conversation } = receiveInbound(deps, hello)
    const h = { cookie }

    const list = await app.inject({ method: 'GET', url: '/api/conversations', headers: h })
    expect(list.json().conversations).toHaveLength(1)

    const one = await app.inject({ method: 'GET', url: `/api/conversations/${conversation.id}`, headers: h })
    expect(one.json().messages).toHaveLength(1)
    expect(one.json().contact.name).toBe('Ana')

    const assigned = await app.inject({ method: 'POST', url: `/api/conversations/${conversation.id}/assign`, headers: h })
    expect(assigned.json().conversation.assigneeId).toBe(1)
    const mine = await app.inject({ method: 'GET', url: '/api/conversations?mine=1', headers: h })
    expect(mine.json().conversations).toHaveLength(1)

    const reply = await app.inject({ method: 'POST', url: `/api/conversations/${conversation.id}/messages`, headers: h, payload: { text: 'Hello Ana' } })
    expect(reply.statusCode).toBe(201)
    expect(sent).toEqual([{ contactKey: 'v-1', text: 'Hello Ana' }])

    const back = await app.inject({ method: 'POST', url: `/api/conversations/${conversation.id}/hand-back`, headers: h })
    expect(back.json().conversation.assigneeId).toBeNull()

    const closed = await app.inject({ method: 'POST', url: `/api/conversations/${conversation.id}/close`, headers: h })
    expect(closed.json().conversation.status).toBe('closed')
    const filtered = await app.inject({ method: 'GET', url: '/api/conversations?status=closed', headers: h })
    expect(filtered.json().conversations).toHaveLength(1)
  })

  it('404 with a stable code for an unknown conversation; 400 for empty reply or bad status', async () => {
    const { app, deps, login } = await testServer()
    const cookie = await login()
    const { conversation } = receiveInbound(deps, hello)
    const missing = await app.inject({ method: 'POST', url: '/api/conversations/999/assign', headers: { cookie } })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().code).toBe('not_found')
    const empty = await app.inject({ method: 'POST', url: `/api/conversations/${conversation.id}/messages`, headers: { cookie }, payload: { text: '  ' } })
    expect(empty.statusCode).toBe(400)
    const bad = await app.inject({ method: 'GET', url: '/api/conversations?status=nope', headers: { cookie } })
    expect(bad.statusCode).toBe(400)
  })
})
