import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '../src/db/client'
import { seed, DEMO_USER } from '../src/db/seed'
import { EventBus } from '../src/core/events'
import { ChannelRegistry } from '../src/channels/types'
import { WidgetChannel, MAX_SOCKETS_PER_VISITOR } from '../src/channels/widget'
import { buildServer } from '../src/server'
import { RateLimiter, defaultLimits, type Limits } from '../src/http/rateLimit'
import { originAllowed } from '../src/http/origin'
import { testServer } from './helpers'

const TOKEN = 'v'.repeat(32)

async function widgetServer(limits: Partial<Limits> = {}, allowedOrigins: string[] = []) {
  const db = createDb(':memory:')
  await seed(db)
  const channels = new ChannelRegistry()
  const widget = new WidgetChannel()
  channels.register(widget)
  const deps = { db, bus: new EventBus(), channels }
  const mediaDir = mkdtempSync(join(tmpdir(), 'relay-limits-'))
  const app = await buildServer(deps, { widget, mediaDir, limits: { ...defaultLimits(), ...limits }, allowedOrigins })
  await app.ready()
  return { app, deps }
}

const closeCode = (ws: { once(ev: 'close', fn: (code: number) => void): void }) =>
  new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))

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

describe('RateLimiter', () => {
  it('allows `limit` hits per window and then reports the wait', () => {
    let now = 0
    const l = new RateLimiter(2, 1000, () => now)
    expect(l.take('a')).toBe(0)
    expect(l.take('a')).toBe(0)
    expect(l.take('a')).toBe(1000)
    expect(l.take('b')).toBe(0)
    now = 400
    expect(l.take('a')).toBe(600)
    now = 1000
    expect(l.take('a')).toBe(0)
  })
})

describe('originAllowed', () => {
  it('allows no Origin, the same host, and listed origins only', () => {
    expect(originAllowed(undefined, 'localhost:8080', [])).toBe(true)
    expect(originAllowed('http://localhost:8080', 'localhost:8080', [])).toBe(true)
    expect(originAllowed('http://evil.example', 'localhost:8080', [])).toBe(false)
    expect(originAllowed('http://localhost:5173', 'api:3000', ['http://localhost:5173'])).toBe(true)
    expect(originAllowed('not a url', 'localhost:8080', [])).toBe(false)
  })
})

describe('limits on public endpoints', () => {
  it('login answers 429 with Retry-After after too many attempts from one address', async () => {
    const { app } = await testServer({ fakeWidget: true, server: { limits: { ...defaultLimits(), login: new RateLimiter(2, 60_000) } } })
    const attempt = (remoteAddress = '127.0.0.1') =>
      app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress, payload: { email: DEMO_USER.email, password: 'nope' } })
    expect((await attempt()).statusCode).toBe(401)
    expect((await attempt()).statusCode).toBe(401)
    const blocked = await attempt()
    expect(blocked.statusCode).toBe(429)
    expect(blocked.headers['retry-after']).toBe('60')
    expect(blocked.json()).toEqual({ error: 'Too many requests', code: 'rate_limited' })
    expect((await attempt('203.0.113.7')).statusCode).toBe(401) // TEST-NET-3: a documentation address
  })

  it('widget messages beyond the limit get an error frame and are not stored', async () => {
    const { app } = await widgetServer({ widgetMessages: new RateLimiter(2, 60_000) })
    const ws = await app.injectWS(`/ws/widget?token=${TOKEN}`)
    const next = frames(ws)
    expect((await next()).type).toBe('history')
    for (const text of ['one', 'two', 'three']) ws.send(JSON.stringify({ type: 'text', text }))
    expect((await next()).message.text).toBe('one')
    expect((await next()).message.text).toBe('two')
    expect(await next()).toEqual({ type: 'error', code: 'rate_limited' })
    ws.terminate()
  })

  it('audio uploads beyond the limit answer 429', async () => {
    const { app } = await widgetServer({ widgetAudio: new RateLimiter(1, 60_000) })
    const upload = () => app.inject({
      method: 'POST', url: '/api/widget/audio',
      headers: { 'content-type': 'audio/webm', 'x-relay-visitor': TOKEN }, payload: Buffer.from('fake audio'),
    })
    expect((await upload()).statusCode).toBe(201)
    const blocked = await upload()
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json().code).toBe('rate_limited')
  })

  it(`a visitor may keep ${MAX_SOCKETS_PER_VISITOR} widget sockets open, not more`, async () => {
    const { app } = await widgetServer()
    const open = []
    for (let i = 0; i < MAX_SOCKETS_PER_VISITOR; i++) open.push(await app.injectWS(`/ws/widget?token=${TOKEN}`))
    const extra = await app.injectWS(`/ws/widget?token=${TOKEN}`)
    expect(await closeCode(extra)).toBe(4429)
    for (const ws of open) ws.terminate()
  })

  it('browsers from another origin cannot open /ws/widget or /ws/inbox', async () => {
    const { app } = await widgetServer()
    const widget = await app.injectWS(`/ws/widget?token=${TOKEN}`, { headers: { origin: 'http://evil.example' } })
    expect(await closeCode(widget)).toBe(4403)
    const inbox = await app.injectWS('/ws/inbox', { headers: { origin: 'http://evil.example' } })
    expect(await closeCode(inbox)).toBe(4403)
  })

  it('an origin in the allow list may open /ws/widget', async () => {
    const { app } = await widgetServer({}, ['http://localhost:5173'])
    const ws = await app.injectWS(`/ws/widget?token=${TOKEN}`, { headers: { origin: 'http://localhost:5173' } })
    const next = frames(ws)
    expect((await next()).type).toBe('history')
    ws.terminate()
  })
})
