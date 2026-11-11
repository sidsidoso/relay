import { describe, it, expect, vi } from 'vitest'
import { createDb } from '../src/db/client'
import { seed } from '../src/db/seed'
import { EventBus } from '../src/core/events'
import { ChannelRegistry } from '../src/channels/types'
import { WidgetChannel } from '../src/channels/widget'
import { buildServer, WS_MAX_PAYLOAD } from '../src/server'
import { createHash } from 'node:crypto'
import { listConversations, teamReply } from '../src/core/conversations'
import { contacts } from '../src/db/schema'

const TOKEN = 'v'.repeat(32)

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
    const ws = await app.injectWS(`/ws/widget?token=${TOKEN}&name=Ana`)
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
    const a = await app.injectWS(`/ws/widget?token=${TOKEN}`)
    const nextA = frames(a)
    await nextA()
    a.send(JSON.stringify({ type: 'text', text: 'First' }))
    await nextA()
    a.terminate()
    const b = await app.injectWS(`/ws/widget?token=${TOKEN}`)
    const hist = await frames(b)()
    expect(hist.messages.map((m: any) => m.text)).toEqual(['First'])
    b.terminate()
  })

  it('rejects bad frames and a missing token', async () => {
    const { app } = await setup()
    const ws = await app.injectWS(`/ws/widget?token=${TOKEN}`)
    const next = frames(ws)
    await next()
    ws.send('not json')
    expect(await next()).toEqual({ type: 'error', code: 'invalid_frame' })
    ws.terminate()
    const noToken = await app.injectWS('/ws/widget')
    const code = await new Promise<number>((resolve) => noToken.once('close', (c: number) => resolve(c)))
    expect(code).toBe(4400)
  })
  it('rejects a too-short visitor token with 4400', async () => {
    const { app } = await setup()
    const ws = await app.injectWS('/ws/widget?token=0123456789')
    const code = await new Promise<number>((resolve) => ws.once('close', (c: number) => resolve(c)))
    expect(code).toBe(4400)
  })

  it('replies with an internal error frame when handling fails, and stays usable', async () => {
    const { app, deps } = await setup()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const emit = vi.spyOn(deps.bus, 'emit').mockImplementationOnce(() => { throw new Error('boom') })
    const ws = await app.injectWS(`/ws/widget?token=${TOKEN}`)
    const next = frames(ws)
    await next()
    ws.send(JSON.stringify({ type: 'text', text: 'one' }))
    expect(await next()).toEqual({ type: 'error', code: 'internal' })
    expect(err).toHaveBeenCalledWith('[relay] widget message failed', expect.any(Error))
    ws.send(JSON.stringify({ type: 'text', text: 'two' }))
    expect(await next()).toMatchObject({ type: 'message', message: { text: 'two' } })
    emit.mockRestore(); err.mockRestore()
    ws.terminate()
  })

  it('closes the socket with 1009 when a frame exceeds the payload limit', async () => {
    const { app } = await setup()
    const ws = await app.injectWS(`/ws/widget?token=${TOKEN}`)
    const closed = new Promise<number>((resolve) => ws.once('close', (c: number) => resolve(c)))
    ws.send('x'.repeat(WS_MAX_PAYLOAD + 1))
    expect(await closed).toBe(1009)
  })

  it('stores only the sha256 of the visitor token as the contact key', async () => {
    const { app, deps } = await setup()
    const ws = await app.injectWS(`/ws/widget?token=${TOKEN}`)
    const next = frames(ws)
    await next()
    ws.send(JSON.stringify({ type: 'text', text: 'Hi' }))
    await next()
    const [contact] = deps.db.select().from(contacts).all()
    expect(contact!.contactKey).toBe(createHash('sha256').update(TOKEN).digest('hex'))
    expect(contact!.contactKey).not.toBe(TOKEN)
    ws.terminate()
  })
})
