import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createDb } from '../src/db/client'
import { seed } from '../src/db/seed'
import { EventBus } from '../src/core/events'
import { ChannelRegistry } from '../src/channels/types'
import { WidgetChannel } from '../src/channels/widget'
import { buildServer } from '../src/server'
import { AgentQueue } from '../src/agent/queue'
import { runAgentTurn } from '../src/agent/engine'
import { DemoProvider } from '../src/agent/providers/demo'
import { loadKnowledge } from '../src/agent/knowledge'

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
