import { describe, it, expect, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '../src/db/client'
import { seed } from '../src/db/seed'
import { EventBus } from '../src/core/events'
import { ChannelRegistry } from '../src/channels/types'
import { WidgetChannel, VISITOR_HEADER } from '../src/channels/widget'
import { getConversation, listConversations } from '../src/core/conversations'
import { buildServer } from '../src/server'
import { AgentQueue } from '../src/agent/queue'
import { runAgentTurn } from '../src/agent/engine'
import { DemoProvider } from '../src/agent/providers/demo'
import { loadKnowledge } from '../src/agent/knowledge'
import { makeTurnRunner } from '../src/agent/turn'
import { AUDIO_FALLBACK } from '../src/agent/providers/demo'
import { OfflineRetry } from '../src/transcription/retry'
import { FakeTranscriber, said } from './fake-transcriber'

const TOKEN = 'visitor-token-0123456789-abcdefghijklmnop'

describe('agent flow over the widget', () => {
  it('a visitor question gets an agent answer pushed to the widget', async () => {
    const db = createDb(':memory:')
    await seed(db)
    const bus = new EventBus()
    const channels = new ChannelRegistry()
    const widget = new WidgetChannel()
    channels.register(widget)
    const knowledge = loadKnowledge(fileURLToPath(new URL('../knowledge', import.meta.url)))
    const engine = { db, bus, channels, provider: new DemoProvider(), knowledge: () => knowledge }
    const queue = new AgentQueue((id) => runAgentTurn(engine, id), bus)
    queue.start()
    const app = await buildServer({ db, bus, channels }, { widget })
    await app.ready()

    const ws = await app.injectWS(`/ws/widget?token=${TOKEN}`)
    const agentReply = new Promise<any>((resolve) => ws.on('message', (d: Buffer) => {
      const f = JSON.parse(d.toString())
      if (f.type === 'message' && f.message.sender === 'agent') resolve(f)
    }))
    ws.send(JSON.stringify({ type: 'text', text: 'What are your opening hours?' }))
    const reply = await agentReply
    expect(reply.message.text).toContain('Opening hours')
    ws.terminate()
    queue.stop()
    await queue.drain()
    await app.close()
  })
})

describe('voice messages over the widget', () => {
  async function setupVoice(transcriber: FakeTranscriber, retryMs = 20) {
    const mediaDir = mkdtempSync(join(tmpdir(), 'relay-flow-'))
    const db = createDb(':memory:')
    await seed(db)
    const bus = new EventBus()
    const channels = new ChannelRegistry()
    const widget = new WidgetChannel()
    channels.register(widget)
    const knowledge = loadKnowledge(fileURLToPath(new URL('../knowledge', import.meta.url)))
    const retry = new OfflineRetry(transcriber, (id) => queue.schedule(id), retryMs)
    const run = makeTurnRunner({
      db, bus, channels, provider: new DemoProvider(), knowledge: () => knowledge, transcriber, mediaDir,
      onTranscriberOffline: (id) => retry.add(id),
    })
    const queue = new AgentQueue(run, bus)
    queue.start()
    const app = await buildServer({ db, bus, channels }, { widget, mediaDir })
    await app.ready()
    const core = { db, bus, channels }
    const upload = () => app.inject({
      method: 'POST', url: '/api/widget/audio', payload: Buffer.from('fake opus'),
      headers: { 'content-type': 'audio/webm;codecs=opus', [VISITOR_HEADER]: TOKEN },
    })
    const conversation = () => getConversation(core, listConversations(core, {})[0]!.id)!
    const done = async () => {
      retry.stop()
      queue.stop()
      await queue.drain()
      await app.close()
      rmSync(mediaDir, { recursive: true, force: true })
    }
    return { app, upload, conversation, queue, done }
  }

  it('a voice message is transcribed and answered from the transcription', async () => {
    const { app, upload, conversation, done } = await setupVoice(new FakeTranscriber(() => said('What are your opening hours?')))
    const ws = await app.injectWS(`/ws/widget?token=${TOKEN}`)
    const agentReply = new Promise<any>((resolve) => ws.on('message', (d: Buffer) => {
      const f = JSON.parse(d.toString())
      if (f.type === 'message' && f.message.sender === 'agent') resolve(f)
    }))
    expect((await upload()).statusCode).toBe(201)
    expect((await agentReply).message.text).toContain('Opening hours')
    expect(conversation().messages[0]!.transcription).toMatchObject({ status: 'ok', text: 'What are your opening hours?' })
    ws.terminate()
    await done()
  })

  it('with the transcriber offline the agent still answers, and the audio is transcribed once it is back', async () => {
    let up = false
    const transcriber = new FakeTranscriber(() => (up ? said('What are your opening hours?') : { ok: false, error: 'offline' }))
    transcriber.healthy = null
    const { upload, conversation, queue, done } = await setupVoice(transcriber)
    await upload()
    await vi.waitFor(() => expect(conversation().messages.at(-1)).toMatchObject({ sender: 'agent', text: AUDIO_FALLBACK }))
    expect(conversation().messages[0]!.transcription).toBeNull()

    up = true
    transcriber.healthy = { ok: true, model: 'fake', loaded: true, error: null }
    await vi.waitFor(() => expect(conversation().messages[0]!.transcription).toMatchObject({ status: 'ok' }), { timeout: 2000 })
    await queue.drain()
    // The agent already answered that message: the retry only fills in the transcription.
    expect(conversation().messages.filter((m) => m.sender === 'agent')).toHaveLength(1)
    await done()
  })
})
