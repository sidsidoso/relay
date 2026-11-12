import { createDb } from '../src/db/client'
import { seed, DEMO_USER } from '../src/db/seed'
import { buildServer } from '../src/server'
import { EventBus } from '../src/core/events'
import { ChannelRegistry } from '../src/channels/types'
import { KnowledgeStore } from '../src/agent/knowledgeStore'

export async function testServer(opts: { fakeWidget?: boolean; knowledgeDir?: string } = { fakeWidget: true }) {
  const db = createDb(':memory:')
  await seed(db)
  const bus = new EventBus()
  const channels = new ChannelRegistry()
  const sent: Array<{ contactKey: string; text: string | null }> = []
  if (opts.fakeWidget) {
    channels.register({ id: 'widget', send: async ({ contact }, m) => { sent.push({ contactKey: contact.contactKey, text: m.text }) } })
  }
  const deps = { db, bus, channels }
  const knowledge = opts.knowledgeDir ? new KnowledgeStore(opts.knowledgeDir) : undefined
  const app = await buildServer(deps, { knowledge })
  async function login(): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: DEMO_USER.email, password: DEMO_USER.password },
    })
    const raw = res.headers['set-cookie']
    const cookie = (Array.isArray(raw) ? raw[0] : raw) ?? ''
    return cookie.split(';')[0]!
  }
  return { app, db, deps, sent, login, knowledge }
}
