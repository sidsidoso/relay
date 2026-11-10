import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { sessions, users } from '../db/schema'

export type PublicUser = { id: number; email: string; name: string }

const SESSION_DAYS = 7

export function createSession(db: Db, userId: number): string {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString()
  db.insert(sessions).values({ token, userId, expiresAt }).run()
  return token
}

export function userForSession(db: Db, token?: string): PublicUser | null {
  if (!token) return null
  const row = db.select({ id: users.id, email: users.email, name: users.name, expiresAt: sessions.expiresAt })
    .from(sessions).innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.token, token)).get()
  if (!row || row.expiresAt < new Date().toISOString()) return null
  return { id: row.id, email: row.email, name: row.name }
}

export function deleteSession(db: Db, token: string): void {
  db.delete(sessions).where(eq(sessions.token, token)).run()
}
