import { z } from 'zod'
import type { Db } from '../db/client'
import { settings } from '../db/schema'
import { DEFAULT_SETTINGS } from '../db/seed'

export type AgentSettings = { instructions: string; handoffKeywords: string[]; turnLimit: number; handoffMessage: string }

const FIELDS = {
  instructions: ['agent.instructions', z.string().min(1)],
  handoffKeywords: ['agent.handoffKeywords', z.array(z.string().min(1)).max(50)],
  turnLimit: ['agent.turnLimit', z.number().int().min(1).max(100)],
  handoffMessage: ['agent.handoffMessage', z.string().min(1)],
} as const

/** Typed agent settings; a missing or invalid stored value falls back to its default. */
export function agentSettings(db: Db): AgentSettings {
  const stored = new Map(db.select().from(settings).all().map((r) => [r.key, r.value]))
  const out: Record<string, unknown> = {}
  for (const [field, [key, schema]] of Object.entries(FIELDS)) {
    const parsed = schema.safeParse(stored.get(key))
    out[field] = parsed.success ? parsed.data : DEFAULT_SETTINGS[key]
  }
  return out as AgentSettings
}
