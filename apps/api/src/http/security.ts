import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/** The API serves JSON and audio only: nothing may be framed, sniffed or loaded cross-origin. */
export const API_SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
}

/** Registered before any route, so every response (errors and 404s included) carries the headers. */
export function securityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_req, reply, payload) => {
    for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
      if (!reply.hasHeader(name)) reply.header(name, value)
    }
    return payload
  })
}

export function notFoundHandler(_req: FastifyRequest, reply: FastifyReply) {
  return reply.code(404).send({ error: 'Not found', code: 'not_found' })
}

/** Request URLs for the log: the query string is dropped because /ws/widget carries the visitor token there. */
export function redactUrl(url: string): string {
  const i = url.indexOf('?')
  return i === -1 ? url : url.slice(0, i)
}
