import { afterEach, describe, it, expect } from 'vitest'
import { HttpTranscriber } from '../src/transcription/client'
import { deadUrl, fakeHttp, json, type Handler } from './fake-http'

const AUDIO = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3])
const opts = { mime: 'audio/webm', timeoutMs: 2000 }
const closers: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(closers.splice(0).map((c) => c())) })

async function server(handler: Handler) {
  const s = await fakeHttp(handler)
  closers.push(s.close)
  return s
}

describe('HttpTranscriber.transcribe', () => {
  it('posts the raw audio and returns the text and timings', async () => {
    const s = await server((_req, res) => json(res, 200, { text: ' Quanto custa? ', duration_s: 2.4, processing_s: 0.8, model: 'small' }))
    const t = new HttpTranscriber({ url: `${s.url}/` })
    expect(await t.transcribe(AUDIO, opts)).toEqual({ ok: true, text: ' Quanto custa? ', durationS: 2.4, processingS: 0.8, model: 'small' })
    expect(s.seen[0]).toMatchObject({ method: 'POST', url: '/transcribe' })
    expect(s.seen[0]!.headers['content-type']).toBe('audio/webm')
    expect(s.seen[0]!.headers['x-language']).toBeUndefined()
    expect([...s.seen[0]!.body]).toEqual([...AUDIO])
  })

  it('sends X-Language when a language is configured or passed', async () => {
    const s = await server((_req, res) => json(res, 200, { text: 'hi', duration_s: 1, processing_s: 1, model: 'tiny' }))
    const t = new HttpTranscriber({ url: s.url, language: 'en' })
    await t.transcribe(AUDIO, opts)
    await t.transcribe(AUDIO, { ...opts, language: 'auto' })
    expect(s.seen.map((r) => r.headers['x-language'])).toEqual(['en', 'auto'])
  })

  it.each([
    [503, { error: 'loading' }, 'offline'],
    [422, { error: 'unreadable_audio' }, 'http_422'],
    [500, { error: 'boom' }, 'http_500'],
    [200, { text: 42 }, 'unreadable'],
  ] as const)('HTTP %i %j is %s', async (status, body, error) => {
    const s = await server((_req, res) => json(res, status, body))
    expect(await new HttpTranscriber({ url: s.url }).transcribe(AUDIO, opts)).toEqual({ ok: false, error })
  })

  it('a body that is not JSON is unreadable', async () => {
    const s = await server((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end('<html>') })
    expect(await new HttpTranscriber({ url: s.url }).transcribe(AUDIO, opts)).toEqual({ ok: false, error: 'unreadable' })
  })

  it('a service that does not answer in time is a timeout', async () => {
    const s = await server(() => { /* never answers */ })
    const started = Date.now()
    expect(await new HttpTranscriber({ url: s.url }).transcribe(AUDIO, { ...opts, timeoutMs: 100 })).toEqual({ ok: false, error: 'timeout' })
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('a service that is not running is offline', async () => {
    expect(await new HttpTranscriber({ url: await deadUrl() }).transcribe(AUDIO, opts)).toEqual({ ok: false, error: 'offline' })
  })
})

describe('HttpTranscriber.health', () => {
  it('reads the health document', async () => {
    const s = await server((_req, res) => json(res, 200, { ok: true, model: 'small', loaded: true, error: null }))
    expect(await new HttpTranscriber({ url: s.url }).health()).toEqual({ ok: true, model: 'small', loaded: true, error: null })
    expect(s.seen[0]).toMatchObject({ method: 'GET', url: '/health' })
  })

  it('returns null when the service is down or answers something else', async () => {
    expect(await new HttpTranscriber({ url: await deadUrl() }).health()).toBeNull()
    const s = await server((_req, res) => json(res, 200, { hello: 'world' }))
    expect(await new HttpTranscriber({ url: s.url }).health()).toBeNull()
  })
})
