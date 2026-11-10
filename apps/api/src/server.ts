import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import websocket from '@fastify/websocket'
import { registerErrorHandler } from './http/errors'
import { authRoutes } from './auth/routes'
import { conversationRoutes } from './core/routes'
import { inboxSocket } from './realtime/inbox'
import { widgetSocket, type WidgetChannel } from './channels/widget'
import type { CoreDeps } from './core/conversations'

export type ServerDeps = CoreDeps

export async function buildServer(deps: ServerDeps, opts: { widget?: WidgetChannel } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(cookie)
  await app.register(websocket)
  app.get('/api/health', async () => ({ ok: true }))
  registerErrorHandler(app)
  authRoutes(app, deps.db)
  conversationRoutes(app, deps)
  inboxSocket(app, deps)
  if (opts.widget) widgetSocket(app, deps, opts.widget)
  return app
}
