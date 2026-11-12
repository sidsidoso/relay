import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import cookie from '@fastify/cookie'
import websocket from '@fastify/websocket'
import { registerErrorHandler } from './http/errors'
import { notFoundHandler, securityHeaders } from './http/security'
import { authRoutes } from './auth/routes'
import { conversationRoutes } from './core/routes'
import { settingsRoutes } from './core/settingsRoutes'
import { inboxSocket } from './realtime/inbox'
import { SessionSockets } from './realtime/sessionSockets'
import { widgetAudioRoute, widgetSocket, type WidgetChannel } from './channels/widget'
import { defaultLimits, type Limits } from './http/rateLimit'
import { mediaRoutes } from './media/routes'
import { knowledgeRoutes } from './agent/knowledgeRoutes'
import type { KnowledgeStore } from './agent/knowledgeStore'
import type { CoreDeps } from './core/conversations'

/** Max inbound WebSocket frame size; ws's default (100 MiB) is far too large for a public endpoint. */
export const WS_MAX_PAYLOAD = 64 * 1024

export type ServerDeps = CoreDeps

export type ServerOptions = {
  widget?: WidgetChannel
  mediaDir?: string
  knowledge?: KnowledgeStore
  /** Fastify logger options; off when not given (tests). */
  logger?: FastifyServerOptions['logger']
  /** Trust X-Forwarded-* from the reverse proxy (nginx in Docker): real client IPs and HTTPS detection. */
  trustProxy?: boolean
  /** Extra browser origins allowed to open /ws/* (the page's own origin is always allowed). */
  allowedOrigins?: string[]
  /** Rate limits; tests pass small ones. */
  limits?: Limits
  /** How often an open inbox socket re-checks its session (default 60 s). */
  sessionCheckMs?: number
}

export async function buildServer(deps: ServerDeps, opts: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: opts.trustProxy ?? false })
  securityHeaders(app)
  await app.register(cookie)
  await app.register(websocket, { options: { maxPayload: WS_MAX_PAYLOAD } })
  app.get('/api/health', async () => ({ ok: true }))
  registerErrorHandler(app)
  app.setNotFoundHandler(notFoundHandler)
  const limits = opts.limits ?? defaultLimits()
  const allowedOrigins = opts.allowedOrigins ?? []
  const sessions = new SessionSockets()
  authRoutes(app, deps.db, { loginLimiter: limits.login, sessions })
  conversationRoutes(app, deps)
  settingsRoutes(app, deps.db)
  inboxSocket(app, deps, { allowedOrigins, sessions, sessionCheckMs: opts.sessionCheckMs })
  if (opts.widget) widgetSocket(app, deps, opts.widget, { allowedOrigins, messageLimiter: limits.widgetMessages })
  if (opts.mediaDir) {
    mediaRoutes(app, deps, opts.mediaDir)
    if (opts.widget) await widgetAudioRoute(app, deps, opts.widget, opts.mediaDir, limits.widgetAudio)
  }
  if (opts.knowledge) knowledgeRoutes(app, deps.db, opts.knowledge)
  return app
}
