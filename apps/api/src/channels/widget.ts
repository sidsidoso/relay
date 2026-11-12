import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import { z } from 'zod'
import type { Channel } from './types'
import type { Contact, Conversation, Message } from '../core/types'
import { historyForContact, receiveInbound, type CoreDeps } from '../core/conversations'
import { MAX_AUDIO_BYTES, audioType, removeAudio, saveAudio } from '../media/store'

const Frame = z.object({ type: z.literal('text'), text: z.string().trim().min(1).max(4000) })
const Token = z.string().min(32).max(100)
const Query = z.object({ token: Token, name: z.string().max(80).optional() })

/** The visitor token travels in this header on HTTP requests (never in the URL, so it stays out of access logs). */
export const VISITOR_HEADER = 'x-relay-visitor'

/** The token is a bearer secret: only its hash is used as the contact key, so it never reaches the DB or API. */
export const contactKeyFor = (token: string) => createHash('sha256').update(token).digest('hex')

export type VisitorMessage = { id: number; sender: Message['sender']; type: Message['type']; text: string | null; createdAt: string }

/** What a visitor may see: no team user ids, file names or transcription internals. */
export function toVisitorMessage(m: Message): VisitorMessage {
  return { id: m.id, sender: m.sender, type: m.type, text: m.type === 'audio' ? null : m.text, createdAt: m.createdAt }
}

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
    this.push(target.contact.contactKey, { type: 'message', message: toVisitorMessage(message) })
  }
}

export function widgetSocket(app: FastifyInstance, deps: CoreDeps, widget: WidgetChannel) {
  app.get('/ws/widget', { websocket: true }, (socket, req) => {
    const q = Query.safeParse(req.query)
    if (!q.success) { socket.close(4400, 'invalid_token'); return }
    const { token, name } = q.data
    const contactKey = contactKeyFor(token)
    const detach = widget.attach(contactKey, socket)
    const history = historyForContact(deps, 'widget', contactKey).map(toVisitorMessage)
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
        const { message } = receiveInbound(deps, { channel: 'widget', contactKey, contactName: name, type: 'text', text: frame.text })
        widget.push(contactKey, { type: 'message', message: toVisitorMessage(message) })
      } catch (err) {
        console.error('[relay] widget message failed', err)
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'error', code: 'internal' }))
      }
    })
    socket.on('close', detach)
  })
}

/** Voice messages: the browser posts the recording as the raw request body. */
export async function widgetAudioRoute(app: FastifyInstance, deps: CoreDeps, widget: WidgetChannel, mediaDir: string) {
  await app.register(async (scope) => {
    // Scoped to this plugin: the rest of the API keeps its JSON parser.
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => { done(null, body) })

    scope.post('/api/widget/audio', { bodyLimit: MAX_AUDIO_BYTES }, async (req, reply) => {
      const token = Token.safeParse(req.headers[VISITOR_HEADER])
      if (!token.success) return reply.code(401).send({ error: 'Missing or invalid visitor token', code: 'invalid_token' })
      const mime = audioType(req.headers['content-type'])
      if (!mime) return reply.code(415).send({ error: 'Unsupported audio type', code: 'unsupported_media_type' })
      const body = req.body
      if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: 'Empty audio', code: 'empty_audio' })

      const contactKey = contactKeyFor(token.data)
      const name = await saveAudio(mediaDir, body, mime)
      try {
        const { message } = receiveInbound(deps, { channel: 'widget', contactKey, type: 'audio', mediaPath: name, mediaMime: mime })
        const visible = toVisitorMessage(message)
        widget.push(contactKey, { type: 'message', message: visible })
        return reply.code(201).send({ message: visible })
      } catch (err) {
        await removeAudio(mediaDir, name)
        throw err
      }
    })
  })
}
