import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../db/client'
import { users } from '../db/schema'
import * as password from './password'
import { SESSION_MAX_AGE_S, createSession, deleteSession } from './sessions'
import { SESSION_COOKIE, makeRequireUser } from './guard'
import { tooManyRequests, type RateLimiter } from '../http/rateLimit'
import type { SessionSockets } from '../realtime/sessionSockets'

const LoginBody = z.object({ email: z.email(), password: z.string().min(1) })

const DUMMY_PASSWORD = 'relay-dummy-password'

export function authRoutes(app: FastifyInstance, db: Db, opts: { loginLimiter: RateLimiter; sessions: SessionSockets }) {
  const requireUser = makeRequireUser(db)

  // Verified against when the email is unknown so response time does not reveal which accounts exist.
  // Started eagerly at build time so the first unknown-email login does not pay an extra scrypt.
  const startDummyHash = () => {
    const p = password.hashPassword(DUMMY_PASSWORD)
    p.catch(() => {}) // avoid an unhandled rejection; the failure is surfaced on the next login instead
    return p
  }
  let dummyHash = startDummyHash()
  async function getDummyHash(): Promise<string> {
    try {
      return await dummyHash
    } catch {
      dummyHash = startDummyHash()
      return dummyHash
    }
  }

  app.post('/api/auth/login', async (req, reply) => {
    const wait = opts.loginLimiter.take(req.ip)
    if (wait) return tooManyRequests(reply, wait)
    const body = { data: LoginBody.parse(req.body) } // a ZodError becomes 400 invalid_request in the error handler
    const u = db.select().from(users).where(eq(users.email, body.data.email.toLowerCase())).get()
    let ok = false
    if (u) {
      ok = await password.verifyPassword(body.data.password, u.passwordHash)
    } else {
      // Dummy verification so an unknown email costs the same time as a known one.
      await password.verifyPassword(body.data.password, await getDummyHash())
    }
    if (!u || !ok) {
      return reply.code(401).send({ error: 'Invalid email or password', code: 'invalid_credentials' })
    }
    const token = createSession(db, u.id)
    // `secure: 'auto'`: Secure when the request came over HTTPS (behind nginx this relies on trustProxy).
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', secure: 'auto', maxAge: SESSION_MAX_AGE_S })
    return { user: { id: u.id, email: u.email, name: u.name } }
  })

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE]
    if (token) {
      deleteSession(db, token)
      opts.sessions.closeAll(token)
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return reply.code(204).send()
  })

  app.get('/api/auth/me', { preHandler: requireUser }, async (req) => ({ user: req.user }))
}
