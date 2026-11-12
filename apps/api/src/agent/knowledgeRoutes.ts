import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/client'
import { makeRequireUser } from '../auth/guard'
import type { KnowledgeStore } from './knowledgeStore'

const NameParams = z.object({ name: z.string() })
const PutBody = z.object({ content: z.string() })

export function knowledgeRoutes(app: FastifyInstance, db: Db, store: KnowledgeStore) {
  const requireUser = makeRequireUser(db)
  const notFound = { error: 'File not found', code: 'not_found' }

  app.get('/api/knowledge', { preHandler: requireUser }, async () => ({ files: store.list() }))

  app.get('/api/knowledge/:name', { preHandler: requireUser }, async (req, reply) => {
    const { name } = NameParams.parse(req.params)
    const content = store.read(name)
    return content === null ? reply.code(404).send(notFound) : { name, content }
  })

  app.put('/api/knowledge/:name', { preHandler: requireUser }, async (req) => {
    const { name } = NameParams.parse(req.params)
    return { file: store.write(name, PutBody.parse(req.body).content) }
  })

  app.delete('/api/knowledge/:name', { preHandler: requireUser }, async (req, reply) => {
    const { name } = NameParams.parse(req.params)
    return store.remove(name) ? reply.code(204).send() : reply.code(404).send(notFound)
  })
}
