import { describe, it, expect } from 'vitest'
import { testServer } from './helpers'
import { receiveInbound } from '../src/core/conversations'
import { recordRun } from '../src/agent/runs'

function nextFrame(ws: { once(ev: 'message', fn: (d: Buffer) => void): void }) {
  return new Promise<any>((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))))
}

describe('/ws/inbox', () => {
  it('pushes bus events to a signed-in team member', async () => {
    const { app, deps, login } = await testServer()
    await app.ready()
    const cookie = await login()
    const ws = await app.injectWS('/ws/inbox', { headers: { cookie } })
    const first = nextFrame(ws)
    receiveInbound(deps, { channel: 'widget', contactKey: 'v-1', type: 'text', text: 'Hi' })
    expect(await first).toMatchObject({ event: 'message.created', data: { message: { text: 'Hi' } } })
    ws.terminate()
  })

  it('pushes agent runs to a signed-in team member', async () => {
    const { app, deps, login } = await testServer()
    await app.ready()
    const cookie = await login()
    const { conversation } = receiveInbound(deps, { channel: 'widget', contactKey: 'v-1', type: 'text', text: 'Hi' })
    const ws = await app.injectWS('/ws/inbox', { headers: { cookie } })
    const first = nextFrame(ws)
    const run = recordRun(deps, { conversationId: conversation.id, provider: 'demo', model: 'scripted', durationMs: 3, inputTokens: null, outputTokens: null, outcome: 'replied', error: null })
    expect(await first).toEqual({ event: 'agent.run.created', data: { conversationId: conversation.id, run } })
    ws.terminate()
  })

  it('closes with 4401 without a session', async () => {
    const { app } = await testServer()
    await app.ready()
    const ws = await app.injectWS('/ws/inbox')
    const code = await new Promise<number>((resolve) => ws.once('close', (c: number) => resolve(c)))
    expect(code).toBe(4401)
  })
})
