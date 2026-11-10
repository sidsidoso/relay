import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import { z } from 'zod'
import type { Channel } from './types'
import type { Contact, Conversation, Message } from '../core/types'
import { historyForContact, receiveInbound, type CoreDeps } from '../core/conversations'

const Frame = z.object({ type: z.literal('text'), text: z.string().trim().min(1).max(4000) })
const Query = z.object({ token: z.string().min(32).max(100), name: z.string().max(80).optional() })

export class WidgetChannel implements Channel {
  readonly id = 'widget' as const
  private sockets = new Map<string, Set<WebSocket>>()

  attach(contactKey: string, socket: WebSocket): () => void {
    const set = this.sockets.get(contactKey) ?? new Set<WebSocket>()
    set.add(socket)
    this.sockets.set(contactKey, set)
    return () => {
      set.delete(socket)
      if (set.size === 0) this.sockets.delete(contactKey)
    }
  }

  push(contactKey: string, frame: unknown): void {
    for (const s of this.sockets.get(contactKey) ?? []) {
      if (s.readyState === s.OPEN) s.send(JSON.stringify(frame))
    }
  }

  async send(target: { conversation: Conversation; contact: Contact }, message: Message): Promise<void> {
    this.push(target.contact.contactKey, { type: 'message', message })
  }
}

export function widgetSocket(app: FastifyInstance, deps: CoreDeps, widget: WidgetChannel) {
  app.get('/ws/widget', { websocket: true }, (socket, req) => {
    const q = Query.safeParse(req.query)
    if (!q.success) { socket.close(4400, 'invalid_token'); return }
    const { token, name } = q.data
    const detach = widget.attach(token, socket)
    const history = historyForContact(deps, 'widget', token)
    setImmediate(() => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'history', messages: history }))
    })

    socket.on('message', (raw) => {
      let frame: z.infer<typeof Frame>
      try {
        frame = Frame.parse(JSON.parse(raw.toString()))
      } catch {
        socket.send(JSON.stringify({ type: 'error', code: 'invalid_frame' }))
        return
      }
      try {
        const { message } = receiveInbound(deps, { channel: 'widget', contactKey: token, contactName: name, type: 'text', text: frame.text })
        widget.push(token, { type: 'message', message })
      } catch (err) {
        console.error('[relay] widget message failed', err)
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'error', code: 'internal' }))
      }
    })
    socket.on('close', detach)
  })
}
