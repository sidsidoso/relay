import { eq } from 'drizzle-orm'
import type { Db } from './client'
import { users, settings } from './schema'
import { hashPassword } from '../auth/password'

export const DEMO_USER = { email: 'demo@relay.dev', password: 'relay-demo', name: 'Demo Agent' }

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  'agent.instructions': 'You are the assistant of Acme Coworking, a fictional coworking space. Be brief and friendly. Use the knowledge base for prices and services. Never invent prices.',
  'agent.handoffKeywords': ['human', 'agent', 'atendente', 'humano'],
  'agent.turnLimit': 10,
  'agent.handoffMessage': 'I am passing you to a person from our team. They will reply here shortly.',
  'transcription.enabled': true,
}

export async function seed(db: Db): Promise<void> {
  const existing = db.select().from(users).where(eq(users.email, DEMO_USER.email)).all()
  if (existing.length === 0) {
    db.insert(users).values({
      email: DEMO_USER.email,
      name: DEMO_USER.name,
      passwordHash: await hashPassword(DEMO_USER.password),
      createdAt: new Date().toISOString(),
    }).run()
  }
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    db.insert(settings).values({ key, value }).onConflictDoNothing().run()
  }
}
