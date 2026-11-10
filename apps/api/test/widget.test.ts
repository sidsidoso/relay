import { describe, it, expect } from 'vitest'
import { createDb } from '../src/db/client'
import { seed } from '../src/db/seed'
import { EventBus } from '../src/core/events'
import { ChannelRegistry } from '../src/channels/types'
import { WidgetChannel } from '../src/channels/widget'
import { buildServer } from '../src/server'
import { listConversations, teamReply } from '../src/core/conversations'

async function setup() {
  const db = createDb(':memory:')
  await seed(db)
  const channels = new ChannelRegistry()
  const widget = new WidgetChannel()
  channels.register(widget)
  const deps = { db, bus: new EventBus(), channels }
  const app = await buildServer(deps, { widget })
  await app.ready()
  return { app, deps }
}

function frames(ws: any) {
  const queue: any[] = []
  const waiters: Array<(v: any) => void> = []
  ws.on('message', (d: Buffer) => {
    const f = JSON.parse(d.toString())
    const w = waiters.shift()
    if (w) w(f); else queue.push(f)
  })
  return () => new Promise<any>((resolve) => { const f = queue.shift(); if (f) resolve(f); else waiters.push(resolve) })
}

describe('/ws/widget', () => {
  it('a visitor message becomes a conversation, and the team reply reaches the visitor', async () => {
    const { app, deps } = await setup()
    const ws = await app.injectWS('/ws/widget?token=visitor-abc&name=Ana')
    const next = frames(ws)
    expect(await next()).toEqual({ type: 'history', messages: [] })

    ws.send(JSON.stringify({ type: 'text', text: 'Hi there' }))
    const echo = await next()
    expect(echo).toMatchObject({ type: 'message', message: { sender: 'contact', text: 'Hi there' } })

    const [conv] = listConversations(deps, {})
    expect(conv).toMatchObject({ contactName: 'Ana', channel: 'widget' })

    await teamReply(deps, conv!.id, 1, 'Hello Ana')
    expect(await next()).toMatchObject({ type: 'message', message: { sender: 'user', text: 'Hello Ana' } })
    ws.terminate()
  })

  it('reconnecting gets the history of the current conversation', async () => {
    const { app } = await setup()
    const a = await app.injectWS('/ws/widget?token=visitor-abc')
    const nextA = frames(a)
    await nextA()
    a.send(JSON.stringify({ type: 'text', text: 'First' }))
    await nextA()
    a.terminate()
    const b = await app.injectWS('/ws/widget?token=visitor-abc')
    const hist = await frames(b)()
    expect(hist.messages.map((m: any) => m.text)).toEqual(['First'])
    b.terminate()
  })

  it('rejects bad frames and a missing token', async () => {
    const { app } = await setup()
    const ws = await app.injectWS('/ws/widget?token=v')
    const next = frames(ws)
    await next()
    ws.send('not json')
    expect(await next()).toEqual({ type: 'error', code: 'invalid_frame' })
    ws.terminate()
    const noToken = await app.injectWS('/ws/widget')
    const code = await new Promise<number>((resolve) => noToken.once('close', (c: number) => resolve(c)))
    expect(code).toBe(4400)
  })
})
