import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { createDb } from '../src/db/client'
import { seed } from '../src/db/seed'
import { settings } from '../src/db/schema'
import { EventBus } from '../src/core/events'
import { ChannelRegistry } from '../src/channels/types'
import { getConversation, postOutbound, receiveInbound } from '../src/core/conversations'
import { PER_AUDIO_MS, transcribePending, type TranscriptionDeps } from '../src/transcription/pipeline'
import { FakeTranscriber, said } from './fake-transcriber'

let deps: TranscriptionDeps
let mediaDir: string
let n = 0

async function setup(transcriber: FakeTranscriber | null, extra: Partial<TranscriptionDeps> = {}) {
  const db = createDb(':memory:')
  await seed(db)
  deps = { db, bus: new EventBus(), channels: new ChannelRegistry(), transcriber, mediaDir, ...extra }
}
beforeEach(() => { mediaDir = mkdtempSync(join(tmpdir(), 'relay-tx-')) })
afterEach(() => rmSync(mediaDir, { recursive: true, force: true }))

/** A customer voice message whose file exists in mediaDir. */
function voice(bytes = 'opus') {
  const name = `voice-${++n}.webm`
  writeFileSync(join(mediaDir, name), bytes)
  return receiveInbound(deps, { channel: 'widget', contactKey: 'k'.repeat(64), type: 'audio', mediaPath: name, mediaMime: 'audio/webm' })
}
const messagesOf = (id: number) => getConversation(deps, id)!.messages

describe('transcribePending', () => {
  it('stores the trimmed text and emits message.updated', async () => {
    const t = new FakeTranscriber(() => said('  What are your opening hours?  '))
    await setup(t)
    const { conversation } = voice()
    const events: unknown[] = []
    deps.bus.on('message.updated', (e) => { events.push(e) })
    expect(await transcribePending(deps, conversation.id)).toEqual({ attempted: 1, offline: false })
    expect(t.calls).toEqual([{ bytes: 4, mime: 'audio/webm', timeoutMs: PER_AUDIO_MS }])
    const stored = messagesOf(conversation.id)[0]!
    expect(stored.transcription).toEqual({ status: 'ok', text: 'What are your opening hours?', model: 'fake', durationS: 2, at: expect.any(String) })
    expect(events).toEqual([{ conversationId: conversation.id, message: stored }])
  })

  it('stores silence as empty', async () => {
    await setup(new FakeTranscriber(() => said('   ')))
    const { conversation } = voice()
    await transcribePending(deps, conversation.id)
    expect(messagesOf(conversation.id)[0]!.transcription).toMatchObject({ status: 'empty', model: 'fake' })
  })

  it('offline stores nothing and stops; the same audio is transcribed once the service is back', async () => {
    let up = false
    const t = new FakeTranscriber(() => (up ? said('hello') : { ok: false, error: 'offline' }))
    await setup(t)
    const { conversation } = voice()
    voice()
    expect(await transcribePending(deps, conversation.id)).toEqual({ attempted: 1, offline: true })
    expect(messagesOf(conversation.id).map((m) => m.transcription)).toEqual([null, null])
    up = true
    expect(await transcribePending(deps, conversation.id)).toEqual({ attempted: 2, offline: false })
    expect(messagesOf(conversation.id).map((m) => m.transcription?.status)).toEqual(['ok', 'ok'])
  })

  it('stores other failures as failed and never retries them', async () => {
    const t = new FakeTranscriber(() => ({ ok: false, error: 'http_422' }))
    await setup(t)
    const { conversation } = voice()
    await transcribePending(deps, conversation.id)
    expect(messagesOf(conversation.id)[0]!.transcription).toMatchObject({ status: 'failed', error: 'http_422' })
    expect(await transcribePending(deps, conversation.id)).toEqual({ attempted: 0, offline: false })
    expect(t.calls).toHaveLength(1)
  })

  it('a timeout at the per-audio deadline is a failure', async () => {
    await setup(new FakeTranscriber(() => ({ ok: false, error: 'timeout' })), { perAudioMs: 1000 })
    const { conversation } = voice()
    await transcribePending(deps, conversation.id)
    expect(messagesOf(conversation.id)[0]!.transcription).toMatchObject({ status: 'failed', error: 'timeout' })
  })

  it('stops at the per-turn budget and leaves the rest for a later turn', async () => {
    const t = new FakeTranscriber(async () => { await new Promise((r) => setTimeout(r, 60)); return said('first') })
    await setup(t, { perTurnMs: 40 })
    const { conversation } = voice()
    voice()
    await transcribePending(deps, conversation.id)
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0]!.timeoutMs).toBeLessThanOrEqual(40)
    expect(messagesOf(conversation.id).map((m) => m.transcription?.status ?? null)).toEqual(['ok', null])
  })

  it('does not store a timeout that the per-turn budget cut short', async () => {
    await setup(new FakeTranscriber(() => ({ ok: false, error: 'timeout' })), { perTurnMs: 30 })
    const { conversation } = voice()
    await transcribePending(deps, conversation.id)
    expect(messagesOf(conversation.id)[0]!.transcription).toBeNull()
  })

  it('a missing file is a failure, without calling the service', async () => {
    const t = new FakeTranscriber(() => said('x'))
    await setup(t)
    const { conversation } = receiveInbound(deps, { channel: 'widget', contactKey: 'k'.repeat(64), type: 'audio', mediaPath: 'gone.webm', mediaMime: 'audio/webm' })
    await transcribePending(deps, conversation.id)
    expect(t.calls).toHaveLength(0)
    expect(messagesOf(conversation.id)[0]!.transcription).toMatchObject({ status: 'failed', error: 'missing_file' })
  })

  it('does nothing when transcription is off or there is no transcriber', async () => {
    const t = new FakeTranscriber(() => said('x'))
    await setup(t)
    deps.db.update(settings).set({ value: false }).where(eq(settings.key, 'transcription.enabled')).run()
    const { conversation } = voice()
    expect(await transcribePending(deps, conversation.id)).toEqual({ attempted: 0, offline: false })
    await setup(null)
    const other = voice()
    expect(await transcribePending(deps, other.conversation.id)).toEqual({ attempted: 0, offline: false })
    expect(t.calls).toHaveLength(0)
  })

  it('ignores text messages and company messages', async () => {
    const t = new FakeTranscriber(() => said('x'))
    await setup(t)
    const { conversation } = receiveInbound(deps, { channel: 'widget', contactKey: 'k'.repeat(64), type: 'text', text: 'hi' })
    await postOutbound(deps, conversation.id, { sender: 'agent', text: 'hello' })
    expect(await transcribePending(deps, conversation.id)).toEqual({ attempted: 0, offline: false })
  })

  it('never logs the text', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await setup(new FakeTranscriber(() => said('my card number is 1234')))
      const { conversation } = voice()
      await transcribePending(deps, conversation.id)
      const logged = [...log.mock.calls, ...warn.mock.calls].flat().join(' ')
      expect(logged).toContain('transcribed message')
      expect(logged).not.toContain('1234')
    } finally {
      log.mockRestore()
      warn.mockRestore()
    }
  })
})
