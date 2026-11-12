import { z } from 'zod'
import type { Db } from '../db/client'
import { settings } from '../db/schema'
import { DEFAULT_SETTINGS } from '../db/seed'

export const SettingsSchema = z.object({
  instructions: z.string().trim().min(1).max(8000),
  handoffKeywords: z.array(z.string().trim().min(1).max(60)).max(50),
  turnLimit: z.number().int().min(1).max(100),
  handoffMessage: z.string().trim().min(1).max(1000),
  transcriptionEnabled: z.boolean(),
})
export type Settings = z.infer<typeof SettingsSchema>
export type AgentSettings = Omit<Settings, 'transcriptionEnabled'>

/** A PUT body: any subset of the settings, no unknown keys. */
export const SettingsPatch = SettingsSchema.partial().strict()
export type SettingsPatch = z.infer<typeof SettingsPatch>

/** Where each setting is stored in the `settings` table (spec §7). */
const KEYS: Record<keyof Settings, string> = {
  instructions: 'agent.instructions',
  handoffKeywords: 'agent.handoffKeywords',
  turnLimit: 'agent.turnLimit',
  handoffMessage: 'agent.handoffMessage',
  transcriptionEnabled: 'transcription.enabled',
}
const FIELDS = Object.keys(KEYS) as Array<keyof Settings>

/** Every setting, typed; a missing or invalid stored value falls back to its default. */
export function readSettings(db: Db): Settings {
  const stored = new Map(db.select().from(settings).all().map((r) => [r.key, r.value]))
  const out: Record<string, unknown> = {}
  for (const field of FIELDS) {
    const parsed = SettingsSchema.shape[field].safeParse(stored.get(KEYS[field]))
    out[field] = parsed.success ? parsed.data : DEFAULT_SETTINGS[KEYS[field]]
  }
  return out as Settings
}

/** Stores the fields present in `patch` in one transaction and returns the resulting settings. */
export function updateSettings(db: Db, patch: SettingsPatch): Settings {
  const clean = SettingsPatch.parse(patch)
  db.transaction((tx) => {
    for (const field of FIELDS) {
      const value = clean[field]
      if (value === undefined) continue
      tx.insert(settings).values({ key: KEYS[field], value })
        .onConflictDoUpdate({ target: settings.key, set: { value } }).run()
    }
  })
  return readSettings(db)
}

export function agentSettings(db: Db): AgentSettings {
  const { transcriptionEnabled: _ignored, ...agent } = readSettings(db)
  return agent
}

/** Spec §7 settings: transcription on/off. A missing or invalid stored value means on. */
export function transcriptionEnabled(db: Db): boolean {
  return readSettings(db).transcriptionEnabled
}
