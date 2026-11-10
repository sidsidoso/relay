import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createDb } from './db/client'
import { seed } from './db/seed'
import { EventBus } from './core/events'
import { ChannelRegistry } from './channels/types'
import { WidgetChannel } from './channels/widget'
import { WhatsAppChannel } from './channels/whatsapp'
import { buildServer } from './server'

const file = process.env.RELAY_DB ?? 'data/relay.db'
mkdirSync(dirname(file), { recursive: true })
const db = createDb(file)
await seed(db)

const channels = new ChannelRegistry()
const widget = new WidgetChannel()
channels.register(widget)
channels.register(new WhatsAppChannel())

const app = await buildServer({ db, bus: new EventBus(), channels }, { widget })
const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' })
console.log(`[relay] api listening on :${port}`)
