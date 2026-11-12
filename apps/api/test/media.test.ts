import { describe, it, expect, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '../src/db/client'
import { seed, DEMO_USER } from '../src/db/seed'
import { EventBus } from '../src/core/events'
import { ChannelRegistry } from '../src/channels/types'
import { WidgetChannel, VISITOR_HEADER } from '../src/channels/widget'
import { buildServer } from '../src/server'
import { getConversation, listConversations, receiveInbound, teamReply } from '../src/core/conversations'
import { MAX_AUDIO_BYTES, audioType, mediaFile } from '../src/media/store'

const TOKEN = 'visitor-token-0123456789-abcdefghijklmnop'
const OPUS = Buffer.from('1a45dfa3-fake-opus-bytes')
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

async function setup() {
  const mediaDir = mkdtempSync(join(tmpdir(), 'relay-media-'))
  dirs.push(mediaDir)
  const db = createDb(':memory:')
  await seed(db)
  const channels = new ChannelRegistry()
  const widget = new WidgetChannel()
  channels.register(widget)
  const deps = { db, bus: new EventBus(), channels }
  const app = await buildServer(deps, { widget, mediaDir })
  await app.ready()
  const upload = (payload: Buffer, headers: Record<string, string> = {}) => app.inject({
    method: 'POST', url: '/api/widget/audio', payload,
    headers: { 'content-type': 'audio/webm;codecs=opus', [VISITOR_HEADER]: TOKEN, ...headers },
  })
  const login = async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: DEMO_USER.email, password: DEMO_USER.password } })
    const raw = res.headers['set-cookie']
    return ((Array.isArray(raw) ? raw[0] : raw) ?? '').split(';')[0]!
  }
  return { app, deps, mediaDir, upload, login }
}

describe('POST /api/widget/audio', () => {
  it('stores the audio as a customer message and pushes it to the visitor', async () => {
    const { app, deps, mediaDir, upload } = await setup()
    const ws = await app.injectWS(`/ws/widget?token=${TOKEN}`)
    const frames: any[] = []
    ws.on('message', (d: Buffer) => frames.push(JSON.parse(d.toString())))
    const res = await upload(OPUS)
    expect(res.statusCode).toBe(201)
    const { message } = res.json()
    expect(message).toEqual({ id: expect.any(Number), sender: 'contact', type: 'audio', text: null, createdAt: expect.any(String) })
    const [conv] = listConversations(deps, {}).conversations
    const found = getConversation(deps, conv!.id)!
    const stored = found.messages[0]!
    expect(stored).toMatchObject({ type: 'audio', mediaMime: 'audio/webm', transcription: null })
    expect(stored.mediaPath).toMatch(/^[0-9a-f-]{36}\.webm$/)
    expect(readFileSync(join(mediaDir, stored.mediaPath!))).toEqual(OPUS)
    expect(found.contact.contactKey).toBe(createHash('sha256').update(TOKEN).digest('hex'))
    await vi.waitFor(() => expect(frames).toContainEqual({ type: 'message', message }))
    ws.terminate()
  })

  it.each([
    ['no token', { [VISITOR_HEADER]: '' }, 401, 'invalid_token'],
    ['a short token', { [VISITOR_HEADER]: 'short' }, 401, 'invalid_token'],
    ['a non-audio type', { 'content-type': 'text/plain' }, 415, 'unsupported_media_type'],
  ])('rejects %s and stores nothing', async (_name, headers, status, code) => {
    const { deps, mediaDir, upload } = await setup()
    const res = await upload(OPUS, headers)
    expect(res.statusCode).toBe(status)
    expect(res.json()).toMatchObject({ code })
    expect(readdirSync(mediaDir)).toEqual([])
    expect(listConversations(deps, {}).conversations).toEqual([])
  })

  it('rejects an empty body and a body over the limit', async () => {
    const { mediaDir, upload } = await setup()
    const empty = await upload(Buffer.alloc(0))
    expect(empty.statusCode).toBe(400)
    expect(empty.json()).toMatchObject({ code: 'empty_audio' })
    const big = await upload(Buffer.alloc(MAX_AUDIO_BYTES + 1))
    expect(big.statusCode).toBe(413)
    expect(big.json()).toMatchObject({ code: 'too_large' })
    expect(readdirSync(mediaDir)).toEqual([])
  })
})

describe('visitor messages', () => {
  it('history frames carry no internal fields', async () => {
    const { app, deps, upload } = await setup()
    await upload(OPUS)
    const [conv] = listConversations(deps, {}).conversations
    await teamReply(deps, conv!.id, 1, 'We got your audio')
    const ws = await app.injectWS(`/ws/widget?token=${TOKEN}`)
    const history = await new Promise<any>((resolve) => ws.once('message', (d: Buffer) => resolve(JSON.parse(d.toString()))))
    const keys = ['createdAt', 'id', 'sender', 'text', 'type']
    expect(history.messages.map((m: object) => Object.keys(m).sort())).toEqual([keys, keys])
    expect(history.messages.map((m: any) => [m.type, m.text])).toEqual([['audio', null], ['text', 'We got your audio']])
    ws.terminate()
  })
})

describe('GET /api/conversations/:id/messages/:messageId/audio', () => {
  it('sends the stored audio to a signed-in team member', async () => {
    const { app, deps, upload, login } = await setup()
    const { message } = (await upload(OPUS)).json()
    const [conv] = listConversations(deps, {}).conversations
    const url = `/api/conversations/${conv!.id}/messages/${message.id}/audio`
    expect((await app.inject({ url })).statusCode).toBe(401)
    const res = await app.inject({ url, headers: { cookie: await login() } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('audio/webm')
    expect(res.rawPayload).toEqual(OPUS)
  })

  it('answers 404 for a text message, another conversation, or a missing file', async () => {
    const { app, deps, upload, login, mediaDir } = await setup()
    const cookie = await login()
    const { message } = (await upload(OPUS)).json()
    const [conv] = listConversations(deps, {}).conversations
    const text = receiveInbound(deps, { channel: 'widget', contactKey: 'other', type: 'text', text: 'hi' })
    const get = (c: number, m: number) => app.inject({ url: `/api/conversations/${c}/messages/${m}/audio`, headers: { cookie } })
    expect((await get(text.conversation.id, text.message.id)).statusCode).toBe(404)
    expect((await get(text.conversation.id, message.id)).statusCode).toBe(404)
    rmSync(join(mediaDir, getConversation(deps, conv!.id)!.messages[0]!.mediaPath!))
    expect((await get(conv!.id, message.id)).statusCode).toBe(404)
  })
})

describe('media helpers', () => {
  it('accepts recorder audio types and rejects the rest', () => {
    expect(audioType('audio/webm;codecs=opus')).toBe('audio/webm')
    expect(audioType('AUDIO/OGG; codecs=opus')).toBe('audio/ogg')
    expect(audioType('audio/mp4')).toBe('audio/mp4')
    expect(audioType('text/plain')).toBeNull()
    expect(audioType('constructor')).toBeNull()
    expect(audioType(undefined)).toBeNull()
  })

  it('only resolves plain generated file names', () => {
    expect(mediaFile('/m', 'a.webm')).toBe(join('/m', 'a.webm'))
    for (const bad of ['../a.webm', 'x/a.webm', 'x\\a.webm', '.hidden', '', null]) expect(mediaFile('/m', bad)).toBeNull()
  })
})
