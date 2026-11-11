import type { FastifyInstance } from 'fastify'
import type { CoreDeps } from '../core/conversations'
import type { RelayEvents } from '../core/events'
import { SESSION_COOKIE } from '../auth/guard'
import { userForSession } from '../auth/sessions'

const EVENTS: Array<keyof RelayEvents> = ['message.created', 'conversation.updated', 'agent.run.created']

export function inboxSocket(app: FastifyInstance, deps: CoreDeps) {
  app.get('/ws/inbox', { websocket: true }, (socket, req) => {
    const user = userForSession(deps.db, req.cookies[SESSION_COOKIE])
    if (!user) { socket.close(4401, 'unauthenticated'); return }
    const handlers = EVENTS.map((event) => {
      const fn = (data: unknown) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ event, data })) }
      deps.bus.on(event, fn as never)
      return [event, fn] as const
    })
    socket.on('close', () => { for (const [event, fn] of handlers) deps.bus.off(event, fn as never) })
  })
}
