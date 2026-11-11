import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from '../db/client'
import { userForSession, type PublicUser } from './sessions'

export const SESSION_COOKIE = 'relay_session'

declare module 'fastify' {
  interface FastifyRequest { user?: PublicUser }
}

export function makeRequireUser(db: Db) {
  return async function requireUser(req: FastifyRequest, reply: FastifyReply) {
    const user = userForSession(db, req.cookies[SESSION_COOKIE])
    if (!user) return reply.code(401).send({ error: 'Not signed in', code: 'unauthenticated' })
    req.user = user
  }
}
