import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb } from './db/client'
import { seed } from './db/seed'
import { EventBus } from './core/events'
import { ChannelRegistry } from './channels/types'
import { WidgetChannel } from './channels/widget'
import { WhatsAppChannel } from './channels/whatsapp'
import { buildServer } from './server'
import { agentTimeoutMs, selectProvider } from './agent/providers'
import { loadKnowledge } from './agent/knowledge'
import { runAgentTurn } from './agent/engine'
import { AgentQueue } from './agent/queue'

const file = process.env.RELAY_DB ?? 'data/relay.db'
mkdirSync(dirname(file), { recursive: true })
const db = createDb(file)
await seed(db)

const bus = new EventBus()
const channels = new ChannelRegistry()
const widget = new WidgetChannel()
channels.register(widget)
channels.register(new WhatsAppChannel())

const provider = selectProvider(process.env)
const timeoutMs = agentTimeoutMs(process.env, provider)
const knowledgeDir = process.env.RELAY_KNOWLEDGE_DIR ?? fileURLToPath(new URL('../knowledge', import.meta.url))
const knowledge = loadKnowledge(knowledgeDir)
const queue = new AgentQueue((id) => runAgentTurn({ db, bus, channels, provider, knowledge: () => knowledge, timeoutMs }, id), bus)
queue.start()
console.log(`[relay] agent provider: ${provider.id} (${provider.model ?? 'n/a'}), timeout ${timeoutMs} ms, knowledge passages: ${knowledge.length}`)

const app = await buildServer({ db, bus, channels }, { widget })
const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' })
console.log(`[relay] api listening on :${port}`)

let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[relay] ${signal}: finishing agent turns and shutting down`)
  queue.stop()
  await app.close()
  await queue.drain()
  process.exit(0)
}
process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))
