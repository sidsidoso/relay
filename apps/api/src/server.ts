import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import type { Db } from './db/client'
import { authRoutes } from './auth/routes'

export type ServerDeps = { db: Db }

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(cookie)
  app.get('/api/health', async () => ({ ok: true }))
  authRoutes(app, deps.db)
  return app
}
