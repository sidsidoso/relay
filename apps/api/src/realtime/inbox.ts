import type { FastifyInstance } from 'fastify'
import type { CoreDeps } from '../core/conversations'
import type { RelayEvents } from '../core/events'
import { SESSION_COOKIE } from '../auth/guard'
import { userForSession } from '../auth/sessions'
import { originAllowed } from '../http/origin'
import type { SessionSockets } from './sessionSockets'

const EVENTS: Array<keyof RelayEvents> = ['message.created', 'message.updated', 'conversation.updated', 'agent.run.created']

/** How often an open inbox socket re-checks that its session still exists and has not expired. */
export const SESSION_CHECK_MS = 60_000

export type InboxSocketOptions = { allowedOrigins: string[]; sessions: SessionSockets; sessionCheckMs?: number }

export function inboxSocket(app: FastifyInstance, deps: CoreDeps, opts: InboxSocketOptions) {
  app.get('/ws/inbox', { websocket: true }, (socket, req) => {
    if (!originAllowed(req.headers.origin, req.headers.host, opts.allowedOrigins)) { socket.close(4403, 'forbidden_origin'); return }
    const token = req.cookies[SESSION_COOKIE]
    if (!token || !userForSession(deps.db, token)) { socket.close(4401, 'unauthenticated'); return }
    const untrack = opts.sessions.add(token, socket)
    const timer = setInterval(() => {
      if (!userForSession(deps.db, token)) socket.close(4401, 'unauthenticated')
    }, opts.sessionCheckMs ?? SESSION_CHECK_MS)
    timer.unref()
    const handlers = EVENTS.map((event) => {
      const fn = (data: unknown) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ event, data })) }
      deps.bus.on(event, fn as never)
      return [event, fn] as const
    })
    socket.on('close', () => {
      clearInterval(timer)
      untrack()
      for (const [event, fn] of handlers) deps.bus.off(event, fn as never)
    })
  })
}
