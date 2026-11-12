import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ConflictError, NotFoundError } from '../core/conversations'
import { KnowledgeError } from '../agent/knowledgeStore'

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) => {
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ error: 'Payload too large', code: 'too_large' })
    if (err instanceof ConflictError) return reply.code(409).send({ error: err.message, code: err.code })
    if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message, code: 'not_found' })
    if (err instanceof KnowledgeError) {
      const status = err.code === 'invalid_name' ? 400 : err.code === 'too_large' ? 413 : 409
      return reply.code(status).send({ error: err.message, code: err.code })
    }
    if (err instanceof z.ZodError) {
      // An unknown key is an `unrecognized_keys` issue with an empty path: reported as `body`.
      const fields = [...new Set(err.issues.map((i) => i.path.join('.') || 'body'))]
      return reply.code(400).send({ error: 'Invalid request', code: 'invalid_request', fields })
    }
    const status = err.statusCode
    if (typeof status === 'number' && status >= 400 && status <= 499) {
      return reply.code(status).send({ error: err.message, code: err.code ?? 'bad_request' })
    }
    app.log.error(err)
    console.error('[relay] internal error', err)
    return reply.code(500).send({ error: 'Internal error', code: 'internal' })
  })
}
