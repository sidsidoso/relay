import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb } from './db/client'
import { seed } from './db/seed'
import { EventBus } from './core/events'
import { ChannelRegistry } from './channels/types'
import { WidgetChannel } from './channels/widget'
import { WhatsAppChannel } from './channels/whatsapp'
import { buildServer } from './server'
import { agentTimeoutMs, selectProvider } from './agent/providers'
import { KnowledgeStore, seedKnowledge } from './agent/knowledgeStore'
import { AgentQueue } from './agent/queue'
import { makeTurnRunner } from './agent/turn'
import { HttpTranscriber } from './transcription/client'
import { OfflineRetry } from './transcription/retry'

const env = (key: string) => process.env[key]?.trim() || undefined

const file = env('RELAY_DB') ?? 'data/relay.db'
mkdirSync(dirname(file), { recursive: true })
const db = createDb(file)
await seed(db)
const mediaDir = env('RELAY_MEDIA_DIR') ?? join(dirname(file), 'media')
mkdirSync(mediaDir, { recursive: true })

const bus = new EventBus()
const channels = new ChannelRegistry()
const widget = new WidgetChannel()
channels.register(widget)
channels.register(new WhatsAppChannel())

const provider = selectProvider(process.env)
const timeoutMs = agentTimeoutMs(process.env, provider)
// Editable copy in the data folder (a Docker volume); the files shipped in apps/api/knowledge seed it on first start.
const knowledgeDir = env('RELAY_KNOWLEDGE_DIR') ?? join(dirname(file), 'knowledge')
const seeded = seedKnowledge(knowledgeDir, fileURLToPath(new URL('../knowledge', import.meta.url)))
const knowledge = new KnowledgeStore(knowledgeDir)

const transcriberUrl = env('TRANSCRIBER_URL')
const transcriber = transcriberUrl ? new HttpTranscriber({ url: transcriberUrl, language: env('RELAY_TRANSCRIBER_LANGUAGE') }) : null
const retry = transcriber ? new OfflineRetry(transcriber, (id) => queue.schedule(id)) : null
const runTurn = makeTurnRunner({
  db, bus, channels, provider, knowledge: () => knowledge.passages(), timeoutMs, transcriber, mediaDir,
  onTranscriberOffline: (id) => retry?.add(id),
})
const queue = new AgentQueue(runTurn, bus)
queue.start()
console.log(`[relay] agent provider: ${provider.id} (${provider.model ?? 'n/a'}), timeout ${timeoutMs} ms, knowledge: ${knowledge.list().length} files in ${knowledgeDir}${seeded ? ` (seeded ${seeded})` : ''}`)
console.log(transcriberUrl
  ? `[relay] transcription: ${transcriberUrl}, media in ${mediaDir}`
  : `[relay] transcription: off (TRANSCRIBER_URL is not set); voice messages are stored in ${mediaDir} and reach the agent as [audio]`)

const app = await buildServer({ db, bus, channels }, { widget, mediaDir })
const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' })
console.log(`[relay] api listening on :${port}`)

let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[relay] ${signal}: finishing agent turns and shutting down`)
  retry?.stop()
  queue.stop()
  await app.close()
  await queue.drain()
  process.exit(0)
}
process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))
