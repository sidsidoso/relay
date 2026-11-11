import { readFile } from 'node:fs/promises'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { makeRequireUser } from '../auth/guard'
import type { CoreDeps } from '../core/conversations'
import { messages } from '../db/schema'
import { mediaFile } from './store'

const Params = z.object({ id: z.coerce.number().int().positive(), messageId: z.coerce.number().int().positive() })

export function mediaRoutes(app: FastifyInstance, deps: CoreDeps, mediaDir: string) {
  const requireUser = makeRequireUser(deps.db)

  app.get('/api/conversations/:id/messages/:messageId/audio', { preHandler: requireUser }, async (req, reply) => {
    const { id, messageId } = Params.parse(req.params)
    const m = deps.db.select().from(messages).where(and(eq(messages.id, messageId), eq(messages.conversationId, id))).get()
    const file = m?.type === 'audio' ? mediaFile(mediaDir, m.mediaPath) : null
    const notFound = () => reply.code(404).send({ error: 'Audio not found', code: 'not_found' })
    if (!m || !file) return notFound()
    let data: Buffer
    try {
      data = await readFile(file)
    } catch {
      return notFound()
    }
    return reply.header('content-type', m.mediaMime ?? 'application/octet-stream').header('cache-control', 'private, max-age=3600').send(data)
  })
}
