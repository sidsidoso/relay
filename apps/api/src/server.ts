import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import websocket from '@fastify/websocket'
import { registerErrorHandler } from './http/errors'
import { authRoutes } from './auth/routes'
import { conversationRoutes } from './core/routes'
import { settingsRoutes } from './core/settingsRoutes'
import { inboxSocket } from './realtime/inbox'
import { widgetAudioRoute, widgetSocket, type WidgetChannel } from './channels/widget'
import { mediaRoutes } from './media/routes'
import type { CoreDeps } from './core/conversations'

/** Max inbound WebSocket frame size; ws's default (100 MiB) is far too large for a public endpoint. */
export const WS_MAX_PAYLOAD = 64 * 1024

export type ServerDeps = CoreDeps

export async function buildServer(deps: ServerDeps, opts: { widget?: WidgetChannel; mediaDir?: string } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(cookie)
  await app.register(websocket, { options: { maxPayload: WS_MAX_PAYLOAD } })
  app.get('/api/health', async () => ({ ok: true }))
  registerErrorHandler(app)
  authRoutes(app, deps.db)
  conversationRoutes(app, deps)
  settingsRoutes(app, deps.db)
  inboxSocket(app, deps)
  if (opts.widget) widgetSocket(app, deps, opts.widget)
  if (opts.mediaDir) {
    mediaRoutes(app, deps, opts.mediaDir)
    if (opts.widget) await widgetAudioRoute(app, deps, opts.widget, opts.mediaDir)
  }
  return app
}
