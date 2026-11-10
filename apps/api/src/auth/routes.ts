import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../db/client'
import { users } from '../db/schema'
import { verifyPassword } from './password'
import { createSession, deleteSession } from './sessions'
import { SESSION_COOKIE, makeRequireUser } from './guard'

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) })

export function authRoutes(app: FastifyInstance, db: Db) {
  const requireUser = makeRequireUser(db)

  app.post('/api/auth/login', async (req, reply) => {
    const body = LoginBody.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'Invalid body', code: 'invalid_body' })
    const u = db.select().from(users).where(eq(users.email, body.data.email.toLowerCase())).get()
    if (!u || !(await verifyPassword(body.data.password, u.passwordHash))) {
      return reply.code(401).send({ error: 'Invalid email or password', code: 'invalid_credentials' })
    }
    const token = createSession(db, u.id)
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/' })
    return { user: { id: u.id, email: u.email, name: u.name } }
  })

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE]
    if (token) deleteSession(db, token)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return reply.code(204).send()
  })

  app.get('/api/auth/me', { preHandler: requireUser }, async (req) => ({ user: req.user }))
}
