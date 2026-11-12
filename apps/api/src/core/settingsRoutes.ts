import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client'
import { makeRequireUser } from '../auth/guard'
import { readSettings, updateSettings, SettingsPatch } from './settings'

export function settingsRoutes(app: FastifyInstance, db: Db) {
  const requireUser = makeRequireUser(db)
  app.get('/api/settings', { preHandler: requireUser }, async () => ({ settings: readSettings(db) }))
  app.put('/api/settings', { preHandler: requireUser }, async (req) =>
    ({ settings: updateSettings(db, SettingsPatch.parse(req.body ?? {})) }))
}
