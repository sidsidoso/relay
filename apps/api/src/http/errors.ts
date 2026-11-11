import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { NotFoundError } from '../core/conversations'

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) => {
    if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message, code: 'not_found' })
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid request', code: 'invalid_request' })
    const status = err.statusCode
    if (typeof status === 'number' && status >= 400 && status <= 499) {
      return reply.code(status).send({ error: err.message, code: err.code ?? 'bad_request' })
    }
    app.log.error(err)
    console.error('[relay] internal error', err)
    return reply.code(500).send({ error: 'Internal error', code: 'internal' })
  })
}
