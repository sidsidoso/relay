# Relay — Plan 1: skeleton, database, real-time inbox and widget

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running Relay with no AI: a visitor chats from the `/demo` widget, the team sees it live in the inbox, assigns, replies, hands back and closes.

**Architecture:** npm-workspaces monorepo. `apps/api` is a Fastify + TypeScript server with SQLite (Drizzle), a typed in-process event bus, a channel registry (widget implemented, WhatsApp interface only) and two WebSocket endpoints (`/ws/widget` for visitors, `/ws/inbox` for the team). `apps/web` is React + Vite with three pages: login, inbox, demo.

**Tech Stack:** Node 24, TypeScript, Fastify 5, @fastify/websocket, @fastify/cookie, Drizzle ORM + better-sqlite3, zod, Vitest; React 19, Vite, @testing-library/react.

Spec: `docs/superpowers/specs/2026-11-10-relay-design.md` (sections 3, 6, 7, 8, 9, 10, 13 steps 1–2).

## Global Constraints

- Code, identifiers, comments and docs in English.
- ESM everywhere (`"type": "module"`); TypeScript `strict: true`.
- Timestamps stored as ISO-8601 strings (`new Date().toISOString()`).
- Conversation status is exactly `open | waiting_human | closed`.
- Message sender is exactly `contact | agent | user | system`; message type is exactly `text | audio`.
- Errors from the API return JSON `{ error: string, code: string }`.
- Session cookie: name `relay_session`, httpOnly, sameSite `lax`, path `/`.
- Passwords hashed with `node:crypto` scrypt (no native hashing dependency).
- Seeded demo user: email `demo@relay.dev`, password `relay-demo`, name `Demo Agent`.
- API port 3000; web dev server port 5173 proxying `/api` and `/ws` to 3000.
- The repository contains no employer data; all sample data is fictional.
- Commit identity is already configured locally; end every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File structure

```
package.json                     workspaces root, shared scripts
tsconfig.base.json               shared compiler options
.gitignore
docker-compose.yml               api + web (transcriber added in plan 5)
apps/api/
  package.json, tsconfig.json, vitest.config.ts, drizzle.config.ts, Dockerfile
  drizzle/                       generated SQL migrations (committed)
  src/
    main.ts                      process entry: env, db, server.listen
    server.ts                    buildServer(deps): Fastify instance, plugins, routes
    db/schema.ts                 Drizzle tables
    db/client.ts                 createDb(file) -> Db (runs migrations)
    db/seed.ts                   seed(db)
    auth/password.ts             hashPassword / verifyPassword
    auth/sessions.ts             createSession / userForSession / deleteSession
    auth/routes.ts               /api/auth/*
    auth/guard.ts                requireUser preHandler
    core/events.ts               EventBus (typed)
    core/types.ts                shared domain types
    core/conversations.ts        conversation service
    core/routes.ts               /api/conversations/*
    channels/types.ts            Channel, InboundMessage, ChannelRegistry
    channels/widget.ts           WidgetChannel + /ws/widget
    channels/whatsapp.ts         WhatsAppChannel stub (disabled)
    realtime/inbox.ts            /ws/inbox
  test/                          vitest files, one per unit
apps/web/
  package.json, tsconfig.json, vite.config.ts, index.html, Dockerfile, nginx.conf
  src/
    main.tsx, App.tsx, styles.css
    api.ts                       fetch wrapper + types
    live.ts                      reconnecting WebSocket helper
    pages/Login.tsx, pages/Inbox.tsx, pages/Demo.tsx
    components/ConversationList.tsx, components/Timeline.tsx, components/Widget.tsx
  test/ConversationList.test.tsx
```

---

### Task 1: Monorepo skeleton and API health check

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.gitignore`
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/vitest.config.ts`
- Create: `apps/api/src/server.ts`, `apps/api/test/health.test.ts`

**Interfaces:**
- Produces: `buildServer(deps?: Partial<ServerDeps>): Promise<FastifyInstance>` in `apps/api/src/server.ts` (deps grow in later tasks); route `GET /api/health` → `{ ok: true }`.

- [ ] **Step 1: Root files**

`package.json`:
```json
{
  "name": "relay",
  "private": true,
  "type": "module",
  "workspaces": ["apps/*"],
  "scripts": {
    "dev:api": "npm run dev -w apps/api",
    "dev:web": "npm run dev -w apps/web",
    "test": "npm test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  }
}
```

`.gitignore`:
```
node_modules/
dist/
data/
*.db
*.db-journal
.env
coverage/
playwright-report/
```

- [ ] **Step 2: API package**

`apps/api/package.json`:
```json
{
  "name": "@relay/api",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "start": "tsx src/main.ts",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json",
    "db:generate": "drizzle-kit generate"
  },
  "dependencies": {
    "@fastify/cookie": "^11.1.5",
    "@fastify/websocket": "^11.3.7",
    "better-sqlite3": "^13.0.3",
    "drizzle-orm": "^0.45.4",
    "fastify": "^5.12.8",
    "tsx": "^4.23.15",
    "zod": "^4.6.7"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^24.0.0",
    "@types/ws": "^8.18.1",
    "drizzle-kit": "^0.31.11",
    "typescript": "^7.0.2",
    "vitest": "^5.1.0"
  }
}
```

`apps/api/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "test", "vitest.config.ts", "drizzle.config.ts"]
}
```

`apps/api/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
})
```

Run: `npm install` (from the repo root). Expected: installs without errors.

- [ ] **Step 3: Write the failing test**

`apps/api/test/health.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { buildServer } from '../src/server'

describe('GET /api/health', () => {
  it('answers ok', async () => {
    const app = await buildServer()
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    await app.close()
  })
})
```

- [ ] **Step 4: Run it to see it fail**

Run: `npm test -w apps/api`
Expected: FAIL — cannot resolve `../src/server`.

- [ ] **Step 5: Minimal server**

`apps/api/src/server.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify'

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  app.get('/api/health', async () => ({ ok: true }))
  return app
}
```

- [ ] **Step 6: Run the test to see it pass**

Run: `npm test -w apps/api`
Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json .gitignore apps/api
git commit -m "chore: monorepo skeleton and API health check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Database schema, migrations and seed

**Files:**
- Create: `apps/api/src/db/schema.ts`, `apps/api/src/db/client.ts`, `apps/api/src/db/seed.ts`
- Create: `apps/api/src/auth/password.ts`
- Create: `apps/api/drizzle.config.ts`, `apps/api/drizzle/` (generated)
- Test: `apps/api/test/db.test.ts`, `apps/api/test/password.test.ts`

**Interfaces:**
- Produces:
  - `type Db` (Drizzle database with schema) and `createDb(file: string): Db` — `':memory:'` for tests; runs migrations.
  - Tables exported from `schema.ts`: `users, sessions, contacts, conversations, messages, agentRuns, settings`.
  - `seed(db: Db): Promise<void>` — idempotent; creates the demo user and default settings.
  - `hashPassword(plain: string): Promise<string>`, `verifyPassword(plain: string, stored: string): Promise<boolean>`.

- [ ] **Step 1: Password test (failing)**

`apps/api/test/password.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from '../src/auth/password'

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('relay-demo')
    expect(stored).toMatch(/^scrypt\$/)
    expect(await verifyPassword('relay-demo', stored)).toBe(true)
    expect(await verifyPassword('wrong', stored)).toBe(false)
  })

  it('salts: the same password hashes differently', async () => {
    expect(await hashPassword('x')).not.toBe(await hashPassword('x'))
  })

  it('a malformed stored value is just "false", never a throw', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false)
  })
})
```

Run: `npm test -w apps/api` → FAIL (module not found).

- [ ] **Step 2: Implement password hashing**

`apps/api/src/auth/password.ts`:
```ts
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>
const KEY_LEN = 64

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(plain, salt, KEY_LEN)
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const [algo, saltHex, keyHex] = stored.split('$')
  if (algo !== 'scrypt' || !saltHex || !keyHex) return false
  const expected = Buffer.from(keyHex, 'hex')
  const actual = await scrypt(plain, Buffer.from(saltHex, 'hex'), expected.length)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
```

Run: `npm test -w apps/api` → password tests PASS.

- [ ] **Step 3: Schema**

`apps/api/src/db/schema.ts`:
```ts
import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: text('created_at').notNull(),
})

export const sessions = sqliteTable('sessions', {
  token: text('token').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id),
  expiresAt: text('expires_at').notNull(),
})

export const contacts = sqliteTable('contacts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  channel: text('channel').notNull(),
  contactKey: text('contact_key').notNull(),
  name: text('name'),
  createdAt: text('created_at').notNull(),
}, (t) => [uniqueIndex('contacts_channel_key').on(t.channel, t.contactKey)])

export const conversations = sqliteTable('conversations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  contactId: integer('contact_id').notNull().references(() => contacts.id),
  channel: text('channel').notNull(),
  status: text('status', { enum: ['open', 'waiting_human', 'closed'] }).notNull(),
  assigneeId: integer('assignee_id').references(() => users.id),
  agentTurns: integer('agent_turns').notNull().default(0),
  tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().$defaultFn(() => []),
  handoffReason: text('handoff_reason'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (t) => [index('conversations_updated').on(t.updatedAt)])

export type Transcription = {
  status: 'ok' | 'empty' | 'failed'
  text?: string
  error?: string
  model?: string
  at: string
}

export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  conversationId: integer('conversation_id').notNull().references(() => conversations.id),
  sender: text('sender', { enum: ['contact', 'agent', 'user', 'system'] }).notNull(),
  userId: integer('user_id').references(() => users.id),
  type: text('type', { enum: ['text', 'audio'] }).notNull(),
  text: text('text'),
  mediaPath: text('media_path'),
  mediaMime: text('media_mime'),
  transcription: text('transcription', { mode: 'json' }).$type<Transcription | null>(),
  createdAt: text('created_at').notNull(),
}, (t) => [index('messages_conversation').on(t.conversationId, t.createdAt)])

export const agentRuns = sqliteTable('agent_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  conversationId: integer('conversation_id').notNull().references(() => conversations.id),
  provider: text('provider').notNull(),
  model: text('model'),
  durationMs: integer('duration_ms').notNull(),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  outcome: text('outcome', { enum: ['replied', 'transferred', 'failed'] }).notNull(),
  error: text('error'),
  createdAt: text('created_at').notNull(),
})

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
})
```

`apps/api/drizzle.config.ts`:
```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
})
```

Run: `npm run db:generate -w apps/api`
Expected: a new `apps/api/drizzle/0000_*.sql` plus `drizzle/meta/`. Open the SQL and confirm it creates the seven tables.

- [ ] **Step 4: DB test (failing)**

`apps/api/test/db.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDb } from '../src/db/client'
import { seed, DEFAULT_SETTINGS, DEMO_USER } from '../src/db/seed'
import { users, settings } from '../src/db/schema'
import { verifyPassword } from '../src/auth/password'

describe('database', () => {
  it('migrates an empty database and seeds the demo user and settings', async () => {
    const db = createDb(':memory:')
    await seed(db)
    const [u] = db.select().from(users).where(eq(users.email, DEMO_USER.email)).all()
    expect(u?.name).toBe('Demo Agent')
    expect(await verifyPassword(DEMO_USER.password, u!.passwordHash)).toBe(true)
    const rows = db.select().from(settings).all()
    expect(Object.fromEntries(rows.map((r) => [r.key, r.value]))).toEqual(DEFAULT_SETTINGS)
  })

  it('seed is idempotent', async () => {
    const db = createDb(':memory:')
    await seed(db)
    await seed(db)
    expect(db.select().from(users).all()).toHaveLength(1)
  })
})
```

Run: `npm test -w apps/api` → FAIL (module not found).

- [ ] **Step 5: Client and seed**

`apps/api/src/db/client.ts`:
```ts
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { fileURLToPath } from 'node:url'
import * as schema from './schema'

export type Db = BetterSQLite3Database<typeof schema>

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url))

export function createDb(file: string): Db {
  const sqlite = new Database(file)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: MIGRATIONS })
  return db
}
```

`apps/api/src/db/seed.ts`:
```ts
import { eq } from 'drizzle-orm'
import type { Db } from './client'
import { users, settings } from './schema'
import { hashPassword } from '../auth/password'

export const DEMO_USER = { email: 'demo@relay.dev', password: 'relay-demo', name: 'Demo Agent' }

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  'agent.instructions': 'You are the assistant of Acme Coworking, a fictional coworking space. Be brief and friendly. Use the knowledge base for prices and services. Never invent prices.',
  'agent.handoffKeywords': ['human', 'agent', 'atendente', 'humano'],
  'agent.turnLimit': 10,
  'agent.handoffMessage': 'I am passing you to a person from our team. They will reply here shortly.',
  'transcription.enabled': true,
}

export async function seed(db: Db): Promise<void> {
  const existing = db.select().from(users).where(eq(users.email, DEMO_USER.email)).all()
  if (existing.length === 0) {
    db.insert(users).values({
      email: DEMO_USER.email,
      name: DEMO_USER.name,
      passwordHash: await hashPassword(DEMO_USER.password),
      createdAt: new Date().toISOString(),
    }).run()
  }
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    db.insert(settings).values({ key, value }).onConflictDoNothing().run()
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `npm test -w apps/api`
Expected: PASS (health, password, db).

- [ ] **Step 7: Commit**

```bash
git add apps/api
git commit -m "feat(api): SQLite schema, migrations, seed and password hashing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Sessions and auth routes

**Files:**
- Create: `apps/api/src/auth/sessions.ts`, `apps/api/src/auth/routes.ts`, `apps/api/src/auth/guard.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/test/auth.test.ts`, `apps/api/test/helpers.ts`

**Interfaces:**
- Consumes: `createDb`, `seed`, `DEMO_USER`, `verifyPassword`, tables `users`, `sessions`.
- Produces:
  - `type PublicUser = { id: number; email: string; name: string }`
  - `createSession(db, userId): string` (token), `userForSession(db, token?: string): PublicUser | null`, `deleteSession(db, token): void`.
  - `requireUser` Fastify preHandler; after it, `req.user: PublicUser`.
  - `type ServerDeps = { db: Db }` (extended in Task 4); `buildServer(deps: ServerDeps)`.
  - Routes: `POST /api/auth/login {email,password}` → 200 `{ user }` + cookie | 401 `{error,code:'invalid_credentials'}`; `POST /api/auth/logout` → 204; `GET /api/auth/me` → 200 `{ user }` | 401 `{code:'unauthenticated'}`.
  - Test helper `testServer()` → `{ app, db, login(): Promise<string /* cookie header */> }`.

- [ ] **Step 1: Test helper and failing test**

`apps/api/test/helpers.ts`:
```ts
import { createDb } from '../src/db/client'
import { seed, DEMO_USER } from '../src/db/seed'
import { buildServer } from '../src/server'

export async function testServer() {
  const db = createDb(':memory:')
  await seed(db)
  const app = await buildServer({ db })
  async function login(): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: DEMO_USER.email, password: DEMO_USER.password },
    })
    const raw = res.headers['set-cookie']
    const cookie = (Array.isArray(raw) ? raw[0] : raw) ?? ''
    return cookie.split(';')[0]!
  }
  return { app, db, login }
}
```

`apps/api/test/auth.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { testServer } from './helpers'
import { DEMO_USER } from '../src/db/seed'

describe('auth', () => {
  it('logs in with the demo user and reads /me with the cookie', async () => {
    const { app, login } = await testServer()
    const cookie = await login()
    expect(cookie).toMatch(/^relay_session=/)
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    expect(me.statusCode).toBe(200)
    expect(me.json().user).toMatchObject({ email: DEMO_USER.email, name: 'Demo Agent' })
    expect(me.json().user.passwordHash).toBeUndefined()
  })

  it('rejects a wrong password with a stable code', async () => {
    const { app } = await testServer()
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: DEMO_USER.email, password: 'nope' } })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'Invalid email or password', code: 'invalid_credentials' })
  })

  it('rejects a malformed body with 400', async () => {
    const { app } = await testServer()
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 1 } })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid_body')
  })

  it('/me without a session is 401', async () => {
    const { app } = await testServer()
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unauthenticated')
  })

  it('logout ends the session', async () => {
    const { app, login } = await testServer()
    const cookie = await login()
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })
    expect(out.statusCode).toBe(204)
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    expect(me.statusCode).toBe(401)
  })
})
```

Update `apps/api/test/health.test.ts` to use the helper (the server now needs a db):
```ts
import { describe, it, expect } from 'vitest'
import { testServer } from './helpers'

describe('GET /api/health', () => {
  it('answers ok', async () => {
    const { app } = await testServer()
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    await app.close()
  })
})
```

Run: `npm test -w apps/api` → FAIL.

- [ ] **Step 2: Sessions**

`apps/api/src/auth/sessions.ts`:
```ts
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
```

- [ ] **Step 3: Guard and routes**

`apps/api/src/auth/guard.ts`:
```ts
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
```

`apps/api/src/auth/routes.ts`:
```ts
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
```

- [ ] **Step 4: Wire into the server**

`apps/api/src/server.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import type { Db } from './db/client'
import { authRoutes } from './auth/routes'

export type ServerDeps = { db: Db }

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(cookie)
  app.get('/api/health', async () => ({ ok: true }))
  authRoutes(app, deps.db)
  return app
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test -w apps/api`
Expected: PASS (all auth tests and health).

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat(api): sessions and login/logout/me routes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Event bus, channel interface and conversation service

**Files:**
- Create: `apps/api/src/core/types.ts`, `apps/api/src/core/events.ts`, `apps/api/src/core/conversations.ts`
- Create: `apps/api/src/channels/types.ts`, `apps/api/src/channels/whatsapp.ts`
- Test: `apps/api/test/conversations.test.ts`, `apps/api/test/channels-contract.test.ts`

**Interfaces:**
- Consumes: `Db`, tables `contacts, conversations, messages, users`.
- Produces:
  - `core/types.ts`: `type Message = typeof messages.$inferSelect`, `type Conversation = typeof conversations.$inferSelect`, `type Contact = typeof contacts.$inferSelect`, `type ConversationSummary = Conversation & { contactName: string | null; lastMessage: string | null; assigneeName: string | null }`.
  - `core/events.ts`: `class EventBus` with `on/off/emit` for events `'message.created': { conversationId: number; message: Message }` and `'conversation.updated': { conversation: Conversation }`.
  - `channels/types.ts`: `type ChannelId = 'widget' | 'whatsapp'`; `type InboundMessage = { channel: ChannelId; contactKey: string; contactName?: string; type: 'text' | 'audio'; text?: string; mediaPath?: string; mediaMime?: string }`; `interface Channel { id: ChannelId; send(target: { conversation: Conversation; contact: Contact }, message: Message): Promise<void> }`; `class ChannelRegistry { register(c: Channel): void; get(id: string): Channel | undefined }`.
  - `core/conversations.ts`: `type CoreDeps = { db: Db; bus: EventBus; channels: ChannelRegistry }` and functions:
    - `receiveInbound(deps, msg: InboundMessage): { conversation: Conversation; message: Message }`
    - `listConversations(deps, filter: { status?: Conversation['status']; assigneeId?: number }): ConversationSummary[]`
    - `getConversation(deps, id: number): { conversation: Conversation; contact: Contact; messages: Message[] } | null`
    - `assign(deps, id: number, userId: number): Conversation`
    - `handBack(deps, id: number): Conversation`
    - `close(deps, id: number): Conversation`
    - `teamReply(deps, id: number, userId: number, text: string): Promise<Message>`
    - `historyForContact(deps, channel: ChannelId, contactKey: string): Message[]` (messages of the contact's current non-closed conversation; `[]` if none)
    - `class NotFoundError extends Error`.

- [ ] **Step 1: Failing tests**

`apps/api/test/conversations.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createDb } from '../src/db/client'
import { seed } from '../src/db/seed'
import { EventBus } from '../src/core/events'
import { ChannelRegistry, type Channel } from '../src/channels/types'
import {
  receiveInbound, listConversations, getConversation, assign, handBack, close, teamReply,
  historyForContact, NotFoundError, type CoreDeps,
} from '../src/core/conversations'

let deps: CoreDeps
let sent: Channel['send'] & ReturnType<typeof vi.fn>

beforeEach(async () => {
  const db = createDb(':memory:')
  await seed(db)
  const channels = new ChannelRegistry()
  sent = vi.fn(async () => {}) as never
  channels.register({ id: 'widget', send: sent })
  deps = { db, bus: new EventBus(), channels }
})

const hello = { channel: 'widget' as const, contactKey: 'v-1', contactName: 'Ana', type: 'text' as const, text: 'Hi!' }

describe('receiveInbound', () => {
  it('creates contact, open conversation and message, and emits both events', () => {
    const onMsg = vi.fn(); const onConv = vi.fn()
    deps.bus.on('message.created', onMsg); deps.bus.on('conversation.updated', onConv)
    const { conversation, message } = receiveInbound(deps, hello)
    expect(conversation).toMatchObject({ status: 'open', channel: 'widget', assigneeId: null })
    expect(message).toMatchObject({ sender: 'contact', type: 'text', text: 'Hi!' })
    expect(onMsg).toHaveBeenCalledWith({ conversationId: conversation.id, message })
    expect(onConv).toHaveBeenCalledWith({ conversation: expect.objectContaining({ id: conversation.id }) })
  })

  it('reuses the open conversation of the same contact', () => {
    const a = receiveInbound(deps, hello)
    const b = receiveInbound(deps, { ...hello, text: 'Again' })
    expect(b.conversation.id).toBe(a.conversation.id)
  })

  it('starts a new conversation after the previous one was closed', () => {
    const a = receiveInbound(deps, hello)
    close(deps, a.conversation.id)
    const b = receiveInbound(deps, hello)
    expect(b.conversation.id).not.toBe(a.conversation.id)
  })
})

describe('inbox actions', () => {
  it('lists with contact name and last message, newest first, filtered by status', () => {
    receiveInbound(deps, hello)
    const second = receiveInbound(deps, { ...hello, contactKey: 'v-2', contactName: 'Bruno', text: 'Price?' })
    const list = listConversations(deps, {})
    expect(list.map((c) => c.contactName)).toEqual(['Bruno', 'Ana'])
    expect(list[0]!.lastMessage).toBe('Price?')
    close(deps, second.conversation.id)
    expect(listConversations(deps, { status: 'closed' })).toHaveLength(1)
  })

  it('assign, hand back and close change status and assignee', () => {
    const { conversation } = receiveInbound(deps, hello)
    expect(assign(deps, conversation.id, 1)).toMatchObject({ assigneeId: 1, status: 'open' })
    expect(listConversations(deps, { assigneeId: 1 })[0]!.assigneeName).toBe('Demo Agent')
    expect(handBack(deps, conversation.id)).toMatchObject({ assigneeId: null, status: 'open' })
    expect(close(deps, conversation.id)).toMatchObject({ status: 'closed' })
  })

  it('team reply stores a user message and sends it through the channel', async () => {
    const { conversation } = receiveInbound(deps, hello)
    const msg = await teamReply(deps, conversation.id, 1, 'Hello Ana')
    expect(msg).toMatchObject({ sender: 'user', userId: 1, text: 'Hello Ana' })
    expect(sent).toHaveBeenCalledWith(
      { conversation: expect.objectContaining({ id: conversation.id }), contact: expect.objectContaining({ contactKey: 'v-1' }) },
      msg,
    )
    expect(getConversation(deps, conversation.id)!.messages.map((m) => m.sender)).toEqual(['contact', 'user'])
  })

  it('history for a contact returns the current conversation only', () => {
    const a = receiveInbound(deps, hello)
    close(deps, a.conversation.id)
    receiveInbound(deps, { ...hello, text: 'New' })
    expect(historyForContact(deps, 'widget', 'v-1').map((m) => m.text)).toEqual(['New'])
    expect(historyForContact(deps, 'widget', 'nobody')).toEqual([])
  })

  it('unknown conversation throws NotFoundError', () => {
    expect(() => assign(deps, 999, 1)).toThrow(NotFoundError)
    expect(getConversation(deps, 999)).toBeNull()
  })
})
```

`apps/api/test/channels-contract.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { WhatsAppChannel } from '../src/channels/whatsapp'
import { ChannelRegistry } from '../src/channels/types'

describe('channel contract', () => {
  it('the WhatsApp channel implements the interface but is disabled in v1', async () => {
    const ch = new WhatsAppChannel()
    expect(ch.id).toBe('whatsapp')
    await expect(ch.send({} as never, {} as never)).rejects.toThrow('WhatsApp channel is not enabled')
  })

  it('the registry returns registered channels by id', () => {
    const r = new ChannelRegistry()
    const ch = new WhatsAppChannel()
    r.register(ch)
    expect(r.get('whatsapp')).toBe(ch)
    expect(r.get('sms')).toBeUndefined()
  })
})
```

Run: `npm test -w apps/api` → FAIL.

- [ ] **Step 2: Types, bus and channels**

`apps/api/src/core/types.ts`:
```ts
import type { contacts, conversations, messages } from '../db/schema'

export type Message = typeof messages.$inferSelect
export type Conversation = typeof conversations.$inferSelect
export type Contact = typeof contacts.$inferSelect
export type ConversationSummary = Conversation & {
  contactName: string | null
  lastMessage: string | null
  assigneeName: string | null
}
```

`apps/api/src/core/events.ts`:
```ts
import { EventEmitter } from 'node:events'
import type { Conversation, Message } from './types'

export type RelayEvents = {
  'message.created': { conversationId: number; message: Message }
  'conversation.updated': { conversation: Conversation }
}

export class EventBus {
  private emitter = new EventEmitter().setMaxListeners(0)
  on<K extends keyof RelayEvents>(event: K, fn: (data: RelayEvents[K]) => void): void { this.emitter.on(event, fn) }
  off<K extends keyof RelayEvents>(event: K, fn: (data: RelayEvents[K]) => void): void { this.emitter.off(event, fn) }
  emit<K extends keyof RelayEvents>(event: K, data: RelayEvents[K]): void { this.emitter.emit(event, data) }
}
```

`apps/api/src/channels/types.ts`:
```ts
import type { Contact, Conversation, Message } from '../core/types'

export type ChannelId = 'widget' | 'whatsapp'

export type InboundMessage = {
  channel: ChannelId
  contactKey: string
  contactName?: string
  type: 'text' | 'audio'
  text?: string
  mediaPath?: string
  mediaMime?: string
}

export interface Channel {
  id: ChannelId
  send(target: { conversation: Conversation; contact: Contact }, message: Message): Promise<void>
}

export class ChannelRegistry {
  private byId = new Map<string, Channel>()
  register(channel: Channel): void { this.byId.set(channel.id, channel) }
  get(id: string): Channel | undefined { return this.byId.get(id) }
}
```

`apps/api/src/channels/whatsapp.ts`:
```ts
import type { Channel } from './types'

/** v2: WhatsApp Cloud API connector. v1 ships only the contract so the core stays channel-agnostic. */
export class WhatsAppChannel implements Channel {
  readonly id = 'whatsapp' as const
  async send(): Promise<void> {
    throw new Error('WhatsApp channel is not enabled')
  }
}
```

- [ ] **Step 3: Conversation service**

`apps/api/src/core/conversations.ts`:
```ts
import { and, desc, eq, ne, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { contacts, conversations, messages, users } from '../db/schema'
import type { EventBus } from './events'
import type { ChannelId, ChannelRegistry, InboundMessage } from '../channels/types'
import type { Contact, Conversation, ConversationSummary, Message } from './types'

export type CoreDeps = { db: Db; bus: EventBus; channels: ChannelRegistry }

export class NotFoundError extends Error {
  constructor(what: string) { super(`${what} not found`) }
}

const now = () => new Date().toISOString()

function findOrCreateContact(db: Db, msg: InboundMessage): Contact {
  const found = db.select().from(contacts)
    .where(and(eq(contacts.channel, msg.channel), eq(contacts.contactKey, msg.contactKey))).get()
  if (found) {
    if (msg.contactName && found.name !== msg.contactName) {
      return db.update(contacts).set({ name: msg.contactName }).where(eq(contacts.id, found.id)).returning().get()
    }
    return found
  }
  return db.insert(contacts).values({
    channel: msg.channel, contactKey: msg.contactKey, name: msg.contactName ?? null, createdAt: now(),
  }).returning().get()
}

function currentConversation(db: Db, contactId: number): Conversation | undefined {
  return db.select().from(conversations)
    .where(and(eq(conversations.contactId, contactId), ne(conversations.status, 'closed')))
    .orderBy(desc(conversations.id)).get()
}

function touch(deps: CoreDeps, id: number, changes: Partial<Conversation> = {}): Conversation {
  const updated = deps.db.update(conversations).set({ ...changes, updatedAt: now() })
    .where(eq(conversations.id, id)).returning().get()
  if (!updated) throw new NotFoundError('Conversation')
  deps.bus.emit('conversation.updated', { conversation: updated })
  return updated
}

export function receiveInbound(deps: CoreDeps, msg: InboundMessage): { conversation: Conversation; message: Message } {
  const contact = findOrCreateContact(deps.db, msg)
  const existing = currentConversation(deps.db, contact.id)
  const conv = existing ?? deps.db.insert(conversations).values({
    contactId: contact.id, channel: msg.channel, status: 'open', createdAt: now(), updatedAt: now(),
  }).returning().get()
  const message = deps.db.insert(messages).values({
    conversationId: conv.id, sender: 'contact', type: msg.type, text: msg.text ?? null,
    mediaPath: msg.mediaPath ?? null, mediaMime: msg.mediaMime ?? null, createdAt: now(),
  }).returning().get()
  deps.bus.emit('message.created', { conversationId: conv.id, message })
  const conversation = touch(deps, conv.id)
  return { conversation, message }
}

export function listConversations(
  deps: CoreDeps, filter: { status?: Conversation['status']; assigneeId?: number },
): ConversationSummary[] {
  const where = and(
    filter.status ? eq(conversations.status, filter.status) : undefined,
    filter.assigneeId !== undefined ? eq(conversations.assigneeId, filter.assigneeId) : undefined,
  )
  const lastMessage = sql<string | null>`(
    SELECT coalesce(m.text, '[audio]') FROM messages m
    WHERE m.conversation_id = ${conversations.id} ORDER BY m.id DESC LIMIT 1)`
  return deps.db.select({
    conversation: conversations, contactName: contacts.name, assigneeName: users.name, lastMessage,
  }).from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .leftJoin(users, eq(users.id, conversations.assigneeId))
    .where(where)
    .orderBy(desc(conversations.updatedAt), desc(conversations.id))
    .all()
    .map((r) => ({ ...r.conversation, contactName: r.contactName, assigneeName: r.assigneeName, lastMessage: r.lastMessage }))
}

export function getConversation(deps: CoreDeps, id: number) {
  const conversation = deps.db.select().from(conversations).where(eq(conversations.id, id)).get()
  if (!conversation) return null
  const contact = deps.db.select().from(contacts).where(eq(contacts.id, conversation.contactId)).get()!
  const list = deps.db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.id).all()
  return { conversation, contact, messages: list }
}

export function assign(deps: CoreDeps, id: number, userId: number): Conversation {
  return touch(deps, id, { assigneeId: userId, status: 'open' })
}

export function handBack(deps: CoreDeps, id: number): Conversation {
  return touch(deps, id, { assigneeId: null, status: 'open', handoffReason: null })
}

export function close(deps: CoreDeps, id: number): Conversation {
  return touch(deps, id, { status: 'closed' })
}

export async function teamReply(deps: CoreDeps, id: number, userId: number, text: string): Promise<Message> {
  const found = getConversation(deps, id)
  if (!found) throw new NotFoundError('Conversation')
  const message = deps.db.insert(messages).values({
    conversationId: id, sender: 'user', userId, type: 'text', text, createdAt: now(),
  }).returning().get()
  deps.bus.emit('message.created', { conversationId: id, message })
  const conversation = touch(deps, id)
  await deps.channels.get(conversation.channel)?.send({ conversation, contact: found.contact }, message)
  return message
}

export function historyForContact(deps: CoreDeps, channel: ChannelId, contactKey: string): Message[] {
  const contact = deps.db.select().from(contacts)
    .where(and(eq(contacts.channel, channel), eq(contacts.contactKey, contactKey))).get()
  if (!contact) return []
  const conv = currentConversation(deps.db, contact.id)
  if (!conv) return []
  return deps.db.select().from(messages).where(eq(messages.conversationId, conv.id)).orderBy(messages.id).all()
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w apps/api`
Expected: PASS (conversations, channel contract, and earlier tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): event bus, channel contract and conversation service

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Inbox REST routes and the inbox WebSocket

**Files:**
- Create: `apps/api/src/core/routes.ts`, `apps/api/src/realtime/inbox.ts`
- Modify: `apps/api/src/server.ts`, `apps/api/test/helpers.ts`
- Test: `apps/api/test/inbox-routes.test.ts`, `apps/api/test/inbox-ws.test.ts`

**Interfaces:**
- Consumes: everything in `core/conversations.ts`, `makeRequireUser`, `SESSION_COOKIE`, `userForSession`, `EventBus`, `ChannelRegistry`.
- Produces:
  - `ServerDeps` becomes `{ db: Db; bus: EventBus; channels: ChannelRegistry }` (= `CoreDeps`).
  - Routes (all require a session):
    - `GET /api/conversations?status=open|waiting_human|closed&mine=1` → `{ conversations: ConversationSummary[] }`
    - `GET /api/conversations/:id` → `{ conversation, contact, messages }` | 404 `{code:'not_found'}`
    - `POST /api/conversations/:id/assign` → `{ conversation }` (assigns to the caller)
    - `POST /api/conversations/:id/hand-back` → `{ conversation }`
    - `POST /api/conversations/:id/close` → `{ conversation }`
    - `POST /api/conversations/:id/messages {text}` → 201 `{ message }`
  - `GET /ws/inbox` (session cookie required; closes with code 4401 otherwise) pushes JSON frames `{ event: 'message.created' | 'conversation.updated', data }`.
  - `testServer()` now also returns `deps` (with a `bus` and a `channels` registry containing a fake widget channel recording sends in `sent: Array<{ contactKey: string; text: string | null }>`).

- [ ] **Step 1: Update the helper**

`apps/api/test/helpers.ts`:
```ts
import { createDb } from '../src/db/client'
import { seed, DEMO_USER } from '../src/db/seed'
import { buildServer } from '../src/server'
import { EventBus } from '../src/core/events'
import { ChannelRegistry } from '../src/channels/types'

export async function testServer(opts: { fakeWidget?: boolean } = { fakeWidget: true }) {
  const db = createDb(':memory:')
  await seed(db)
  const bus = new EventBus()
  const channels = new ChannelRegistry()
  const sent: Array<{ contactKey: string; text: string | null }> = []
  if (opts.fakeWidget) {
    channels.register({ id: 'widget', send: async ({ contact }, m) => { sent.push({ contactKey: contact.contactKey, text: m.text }) } })
  }
  const deps = { db, bus, channels }
  const app = await buildServer(deps)
  async function login(): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: DEMO_USER.email, password: DEMO_USER.password },
    })
    const raw = res.headers['set-cookie']
    const cookie = (Array.isArray(raw) ? raw[0] : raw) ?? ''
    return cookie.split(';')[0]!
  }
  return { app, db, deps, sent, login }
}
```

- [ ] **Step 2: Failing route tests**

`apps/api/test/inbox-routes.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { testServer } from './helpers'
import { receiveInbound } from '../src/core/conversations'

const hello = { channel: 'widget' as const, contactKey: 'v-1', contactName: 'Ana', type: 'text' as const, text: 'Hi!' }

describe('inbox routes', () => {
  it('require a session', async () => {
    const { app } = await testServer()
    const res = await app.inject({ method: 'GET', url: '/api/conversations' })
    expect(res.statusCode).toBe(401)
  })

  it('list, open, assign to me, reply, hand back and close', async () => {
    const { app, deps, sent, login } = await testServer()
    const cookie = await login()
    const { conversation } = receiveInbound(deps, hello)
    const h = { cookie }

    const list = await app.inject({ method: 'GET', url: '/api/conversations', headers: h })
    expect(list.json().conversations).toHaveLength(1)

    const one = await app.inject({ method: 'GET', url: `/api/conversations/${conversation.id}`, headers: h })
    expect(one.json().messages).toHaveLength(1)
    expect(one.json().contact.name).toBe('Ana')

    const assigned = await app.inject({ method: 'POST', url: `/api/conversations/${conversation.id}/assign`, headers: h })
    expect(assigned.json().conversation.assigneeId).toBe(1)
    const mine = await app.inject({ method: 'GET', url: '/api/conversations?mine=1', headers: h })
    expect(mine.json().conversations).toHaveLength(1)

    const reply = await app.inject({ method: 'POST', url: `/api/conversations/${conversation.id}/messages`, headers: h, payload: { text: 'Hello Ana' } })
    expect(reply.statusCode).toBe(201)
    expect(sent).toEqual([{ contactKey: 'v-1', text: 'Hello Ana' }])

    const back = await app.inject({ method: 'POST', url: `/api/conversations/${conversation.id}/hand-back`, headers: h })
    expect(back.json().conversation.assigneeId).toBeNull()

    const closed = await app.inject({ method: 'POST', url: `/api/conversations/${conversation.id}/close`, headers: h })
    expect(closed.json().conversation.status).toBe('closed')
    const filtered = await app.inject({ method: 'GET', url: '/api/conversations?status=closed', headers: h })
    expect(filtered.json().conversations).toHaveLength(1)
  })

  it('404 with a stable code for an unknown conversation; 400 for empty reply or bad status', async () => {
    const { app, deps, login } = await testServer()
    const cookie = await login()
    const { conversation } = receiveInbound(deps, hello)
    const missing = await app.inject({ method: 'POST', url: '/api/conversations/999/assign', headers: { cookie } })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().code).toBe('not_found')
    const empty = await app.inject({ method: 'POST', url: `/api/conversations/${conversation.id}/messages`, headers: { cookie }, payload: { text: '  ' } })
    expect(empty.statusCode).toBe(400)
    const bad = await app.inject({ method: 'GET', url: '/api/conversations?status=nope', headers: { cookie } })
    expect(bad.statusCode).toBe(400)
  })
})
```

`apps/api/test/inbox-ws.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { testServer } from './helpers'
import { receiveInbound } from '../src/core/conversations'

function nextFrame(ws: { once(ev: 'message', fn: (d: Buffer) => void): void }) {
  return new Promise<any>((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))))
}

describe('/ws/inbox', () => {
  it('pushes bus events to a signed-in team member', async () => {
    const { app, deps, login } = await testServer()
    await app.ready()
    const cookie = await login()
    const ws = await app.injectWS('/ws/inbox', { headers: { cookie } })
    const first = nextFrame(ws)
    receiveInbound(deps, { channel: 'widget', contactKey: 'v-1', type: 'text', text: 'Hi' })
    expect(await first).toMatchObject({ event: 'message.created', data: { message: { text: 'Hi' } } })
    ws.terminate()
  })

  it('closes with 4401 without a session', async () => {
    const { app } = await testServer()
    await app.ready()
    const ws = await app.injectWS('/ws/inbox')
    const code = await new Promise<number>((resolve) => ws.once('close', (c: number) => resolve(c)))
    expect(code).toBe(4401)
  })
})
```

Run: `npm test -w apps/api` → FAIL.

- [ ] **Step 3: Routes**

`apps/api/src/core/routes.ts`:
```ts
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { makeRequireUser } from '../auth/guard'
import {
  assign, close, getConversation, handBack, listConversations, teamReply, NotFoundError, type CoreDeps,
} from './conversations'

const ListQuery = z.object({
  status: z.enum(['open', 'waiting_human', 'closed']).optional(),
  mine: z.literal('1').optional(),
})
const IdParams = z.object({ id: z.coerce.number().int().positive() })
const ReplyBody = z.object({ text: z.string().trim().min(1).max(4000) })

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: 'Conversation not found', code: 'not_found' })
}

export function conversationRoutes(app: FastifyInstance, deps: CoreDeps) {
  const requireUser = makeRequireUser(deps.db)

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof NotFoundError) return notFound(reply)
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid request', code: 'invalid_body' })
    reply.code(500).send({ error: 'Internal error', code: 'internal' })
  })

  app.get('/api/conversations', { preHandler: requireUser }, async (req) => {
    const q = ListQuery.parse(req.query)
    return { conversations: listConversations(deps, { status: q.status, assigneeId: q.mine ? req.user!.id : undefined }) }
  })

  app.get('/api/conversations/:id', { preHandler: requireUser }, async (req, reply) => {
    const found = getConversation(deps, IdParams.parse(req.params).id)
    return found ?? notFound(reply)
  })

  app.post('/api/conversations/:id/assign', { preHandler: requireUser }, async (req) =>
    ({ conversation: assign(deps, IdParams.parse(req.params).id, req.user!.id) }))

  app.post('/api/conversations/:id/hand-back', { preHandler: requireUser }, async (req) =>
    ({ conversation: handBack(deps, IdParams.parse(req.params).id) }))

  app.post('/api/conversations/:id/close', { preHandler: requireUser }, async (req) =>
    ({ conversation: close(deps, IdParams.parse(req.params).id) }))

  app.post('/api/conversations/:id/messages', { preHandler: requireUser }, async (req, reply) => {
    const { id } = IdParams.parse(req.params)
    const { text } = ReplyBody.parse(req.body)
    const message = await teamReply(deps, id, req.user!.id, text)
    return reply.code(201).send({ message })
  })
}
```

- [ ] **Step 4: Inbox WebSocket**

`apps/api/src/realtime/inbox.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import type { CoreDeps } from '../core/conversations'
import type { RelayEvents } from '../core/events'
import { SESSION_COOKIE } from '../auth/guard'
import { userForSession } from '../auth/sessions'

const EVENTS: Array<keyof RelayEvents> = ['message.created', 'conversation.updated']

export function inboxSocket(app: FastifyInstance, deps: CoreDeps) {
  app.get('/ws/inbox', { websocket: true }, (socket, req) => {
    const user = userForSession(deps.db, req.cookies[SESSION_COOKIE])
    if (!user) { socket.close(4401, 'unauthenticated'); return }
    const handlers = EVENTS.map((event) => {
      const fn = (data: unknown) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ event, data })) }
      deps.bus.on(event, fn as never)
      return [event, fn] as const
    })
    socket.on('close', () => { for (const [event, fn] of handlers) deps.bus.off(event, fn as never) })
  })
}
```

- [ ] **Step 5: Server**

`apps/api/src/server.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import websocket from '@fastify/websocket'
import { authRoutes } from './auth/routes'
import { conversationRoutes } from './core/routes'
import { inboxSocket } from './realtime/inbox'
import type { CoreDeps } from './core/conversations'

export type ServerDeps = CoreDeps

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(cookie)
  await app.register(websocket)
  app.get('/api/health', async () => ({ ok: true }))
  authRoutes(app, deps.db)
  conversationRoutes(app, deps)
  inboxSocket(app, deps)
  return app
}
```

- [ ] **Step 6: Run the tests**

Run: `npm test -w apps/api`
Expected: PASS (all files).

- [ ] **Step 7: Commit**

```bash
git add apps/api
git commit -m "feat(api): inbox REST routes and live inbox WebSocket

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Widget channel and the process entry point

**Files:**
- Create: `apps/api/src/channels/widget.ts`, `apps/api/src/main.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/test/widget.test.ts`

**Interfaces:**
- Consumes: `receiveInbound`, `historyForContact`, `Channel`, `CoreDeps`.
- Produces:
  - `class WidgetChannel implements Channel` with `attach(contactKey: string, socket: WebSocket): () => void` (returns a detach function) and `send(target, message)` that pushes `{ type: 'message', message }` to every socket of that contact.
  - `widgetSocket(app, deps, widget: WidgetChannel)` registering `GET /ws/widget?token=<visitor token>&name=<optional>`:
    - on connect sends `{ type: 'history', messages: Message[] }`;
    - accepts frames `{ type: 'text', text: string }` (1–4000 chars after trim); anything else answers `{ type: 'error', code: 'invalid_frame' }`;
    - closes with 4400 when `token` is missing or longer than 100 chars.
  - `buildServer(deps, opts?: { widget?: WidgetChannel })` — when `opts.widget` is passed, registers the widget socket. `main.ts` creates the real `WidgetChannel` and registers it in `deps.channels`.
  - Env for `main.ts`: `RELAY_DB` (default `data/relay.db`), `PORT` (default `3000`), `HOST` (default `0.0.0.0`).

- [ ] **Step 1: Failing test**

`apps/api/test/widget.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { createDb } from '../src/db/client'
import { seed } from '../src/db/seed'
import { EventBus } from '../src/core/events'
import { ChannelRegistry } from '../src/channels/types'
import { WidgetChannel } from '../src/channels/widget'
import { buildServer } from '../src/server'
import { listConversations, teamReply } from '../src/core/conversations'

async function setup() {
  const db = createDb(':memory:')
  await seed(db)
  const channels = new ChannelRegistry()
  const widget = new WidgetChannel()
  channels.register(widget)
  const deps = { db, bus: new EventBus(), channels }
  const app = await buildServer(deps, { widget })
  await app.ready()
  return { app, deps }
}

function frames(ws: any) {
  const queue: any[] = []
  const waiters: Array<(v: any) => void> = []
  ws.on('message', (d: Buffer) => {
    const f = JSON.parse(d.toString())
    const w = waiters.shift()
    if (w) w(f); else queue.push(f)
  })
  return () => new Promise<any>((resolve) => { const f = queue.shift(); if (f) resolve(f); else waiters.push(resolve) })
}

describe('/ws/widget', () => {
  it('a visitor message becomes a conversation, and the team reply reaches the visitor', async () => {
    const { app, deps } = await setup()
    const ws = await app.injectWS('/ws/widget?token=visitor-abc&name=Ana')
    const next = frames(ws)
    expect(await next()).toEqual({ type: 'history', messages: [] })

    ws.send(JSON.stringify({ type: 'text', text: 'Hi there' }))
    const echo = await next()
    expect(echo).toMatchObject({ type: 'message', message: { sender: 'contact', text: 'Hi there' } })

    const [conv] = listConversations(deps, {})
    expect(conv).toMatchObject({ contactName: 'Ana', channel: 'widget' })

    await teamReply(deps, conv!.id, 1, 'Hello Ana')
    expect(await next()).toMatchObject({ type: 'message', message: { sender: 'user', text: 'Hello Ana' } })
    ws.terminate()
  })

  it('reconnecting gets the history of the current conversation', async () => {
    const { app } = await setup()
    const a = await app.injectWS('/ws/widget?token=visitor-abc')
    const nextA = frames(a)
    await nextA()
    a.send(JSON.stringify({ type: 'text', text: 'First' }))
    await nextA()
    a.terminate()
    const b = await app.injectWS('/ws/widget?token=visitor-abc')
    const hist = await frames(b)()
    expect(hist.messages.map((m: any) => m.text)).toEqual(['First'])
    b.terminate()
  })

  it('rejects bad frames and a missing token', async () => {
    const { app } = await setup()
    const ws = await app.injectWS('/ws/widget?token=v')
    const next = frames(ws)
    await next()
    ws.send('not json')
    expect(await next()).toEqual({ type: 'error', code: 'invalid_frame' })
    ws.terminate()
    const noToken = await app.injectWS('/ws/widget')
    const code = await new Promise<number>((resolve) => noToken.once('close', (c: number) => resolve(c)))
    expect(code).toBe(4400)
  })
})
```

Run: `npm test -w apps/api` → FAIL.

- [ ] **Step 2: Widget channel**

`apps/api/src/channels/widget.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import { z } from 'zod'
import type { Channel } from './types'
import type { Contact, Conversation, Message } from '../core/types'
import { historyForContact, receiveInbound, type CoreDeps } from '../core/conversations'

const Frame = z.object({ type: z.literal('text'), text: z.string().trim().min(1).max(4000) })
const Query = z.object({ token: z.string().min(1).max(100), name: z.string().max(80).optional() })

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
    this.push(target.contact.contactKey, { type: 'message', message })
  }
}

export function widgetSocket(app: FastifyInstance, deps: CoreDeps, widget: WidgetChannel) {
  app.get('/ws/widget', { websocket: true }, (socket, req) => {
    const q = Query.safeParse(req.query)
    if (!q.success) { socket.close(4400, 'invalid_token'); return }
    const { token, name } = q.data
    const detach = widget.attach(token, socket)
    socket.send(JSON.stringify({ type: 'history', messages: historyForContact(deps, 'widget', token) }))

    socket.on('message', (raw) => {
      let frame: z.infer<typeof Frame>
      try {
        frame = Frame.parse(JSON.parse(raw.toString()))
      } catch {
        socket.send(JSON.stringify({ type: 'error', code: 'invalid_frame' }))
        return
      }
      const { message } = receiveInbound(deps, { channel: 'widget', contactKey: token, contactName: name, type: 'text', text: frame.text })
      widget.push(token, { type: 'message', message })
    })
    socket.on('close', detach)
  })
}
```

- [ ] **Step 3: Server option and entry point**

`apps/api/src/server.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import websocket from '@fastify/websocket'
import { authRoutes } from './auth/routes'
import { conversationRoutes } from './core/routes'
import { inboxSocket } from './realtime/inbox'
import { widgetSocket, type WidgetChannel } from './channels/widget'
import type { CoreDeps } from './core/conversations'

export type ServerDeps = CoreDeps

export async function buildServer(deps: ServerDeps, opts: { widget?: WidgetChannel } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(cookie)
  await app.register(websocket)
  app.get('/api/health', async () => ({ ok: true }))
  authRoutes(app, deps.db)
  conversationRoutes(app, deps)
  inboxSocket(app, deps)
  if (opts.widget) widgetSocket(app, deps, opts.widget)
  return app
}
```

`apps/api/src/main.ts`:
```ts
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createDb } from './db/client'
import { seed } from './db/seed'
import { EventBus } from './core/events'
import { ChannelRegistry } from './channels/types'
import { WidgetChannel } from './channels/widget'
import { WhatsAppChannel } from './channels/whatsapp'
import { buildServer } from './server'

const file = process.env.RELAY_DB ?? 'data/relay.db'
mkdirSync(dirname(file), { recursive: true })
const db = createDb(file)
await seed(db)

const channels = new ChannelRegistry()
const widget = new WidgetChannel()
channels.register(widget)
channels.register(new WhatsAppChannel())

const app = await buildServer({ db, bus: new EventBus(), channels }, { widget })
const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' })
console.log(`[relay] api listening on :${port}`)
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -w apps/api` → PASS (all files).
Run: `npm run typecheck -w apps/api` → no errors.

- [ ] **Step 5: Smoke-run the API**

Run: `npm run dev:api`, then in another terminal `curl http://localhost:3000/api/health`
Expected: `{"ok":true}`. Stop the server.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat(api): widget channel over WebSocket and process entry point

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Web app — API client, login and inbox

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`
- Create: `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/styles.css`, `apps/web/src/api.ts`, `apps/web/src/live.ts`
- Create: `apps/web/src/pages/Login.tsx`, `apps/web/src/pages/Inbox.tsx`
- Create: `apps/web/src/components/ConversationList.tsx`, `apps/web/src/components/Timeline.tsx`
- Test: `apps/web/test/ConversationList.test.tsx`

**Interfaces:**
- Consumes: API routes from Tasks 3, 5 and frames from `/ws/inbox`.
- Produces:
  - `api.ts`: types `User`, `Message`, `Conversation`, `ConversationSummary`, `Contact` mirroring the API; `api.me()`, `api.login(email, password)`, `api.logout()`, `api.list(filter: 'all' | 'waiting_human' | 'mine' | 'closed')`, `api.get(id)`, `api.assign(id)`, `api.handBack(id)`, `api.close(id)`, `api.reply(id, text)`.
  - `live.ts`: `type Live = { stop(): void; send(data: string): boolean }` and `connectLive(path: string, onFrame: (frame: any) => void, onOpen?: () => void): Live` — reconnecting WebSocket (backoff 1 s → 10 s). `send` returns `false` when the socket is not open.
  - `<ConversationList items selectedId onSelect />` and `<Timeline messages />`.

- [ ] **Step 1: Package and config**

`apps/web/package.json`:
```json
{
  "name": "@relay/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "react": "^19.3.1",
    "react-dom": "^19.3.1"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.9.1",
    "@testing-library/react": "^16.3.3",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^6.3.0",
    "jsdom": "^31.0.0",
    "typescript": "^7.0.2",
    "vite": "^8.3.7",
    "vitest": "^5.1.0"
  }
}
```

`apps/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "test", "vite.config.ts"]
}
```

`apps/web/vite.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
  test: { environment: 'jsdom', globals: true, include: ['test/**/*.test.tsx'], setupFiles: [] },
})
```

`apps/web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Relay</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Run: `npm install` (repo root). Expected: installs without errors.

- [ ] **Step 2: Failing component test**

`apps/web/test/ConversationList.test.tsx`:
```tsx
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ConversationList } from '../src/components/ConversationList'
import type { ConversationSummary } from '../src/api'

const base: ConversationSummary = {
  id: 1, contactId: 1, channel: 'widget', status: 'open', assigneeId: null, agentTurns: 0, tags: [],
  handoffReason: null, createdAt: '2026-11-10T10:00:00Z', updatedAt: '2026-11-10T10:00:00Z',
  contactName: 'Ana', lastMessage: 'Hi!', assigneeName: null,
}

describe('ConversationList', () => {
  it('shows contact, last message and a waiting badge, and selects on click', () => {
    const onSelect = vi.fn()
    render(<ConversationList
      items={[base, { ...base, id: 2, contactName: null, status: 'waiting_human', lastMessage: '[audio]' }]}
      selectedId={1} onSelect={onSelect} />)
    expect(screen.getByText('Ana')).toBeInTheDocument()
    expect(screen.getByText('Visitor #2')).toBeInTheDocument()
    expect(screen.getByText('Waiting for human')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Visitor #2'))
    expect(onSelect).toHaveBeenCalledWith(2)
  })

  it('shows an empty state', () => {
    render(<ConversationList items={[]} selectedId={null} onSelect={() => {}} />)
    expect(screen.getByText('No conversations yet')).toBeInTheDocument()
  })
})
```

Run: `npm test -w apps/web` → FAIL (module not found).

- [ ] **Step 3: API client and live helper**

`apps/web/src/api.ts`:
```ts
export type User = { id: number; email: string; name: string }
export type Status = 'open' | 'waiting_human' | 'closed'
export type Message = {
  id: number; conversationId: number; sender: 'contact' | 'agent' | 'user' | 'system'; userId: number | null
  type: 'text' | 'audio'; text: string | null; mediaPath: string | null; mediaMime: string | null
  transcription: { status: 'ok' | 'empty' | 'failed'; text?: string } | null; createdAt: string
}
export type Conversation = {
  id: number; contactId: number; channel: string; status: Status; assigneeId: number | null; agentTurns: number
  tags: string[]; handoffReason: string | null; createdAt: string; updatedAt: string
}
export type ConversationSummary = Conversation & { contactName: string | null; lastMessage: string | null; assigneeName: string | null }
export type Contact = { id: number; channel: string; contactKey: string; name: string | null }
export type Filter = 'all' | 'waiting_human' | 'mine' | 'closed'

export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code) }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: init.body ? { 'Content-Type': 'application/json', ...init.headers } : init.headers,
  })
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, body.code ?? 'error')
  return body as T
}

const post = <T>(path: string, body?: unknown) =>
  call<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

const FILTER_QUERY: Record<Filter, string> = { all: '', waiting_human: '?status=waiting_human', mine: '?mine=1', closed: '?status=closed' }

export const api = {
  me: () => call<{ user: User }>('/api/auth/me'),
  login: (email: string, password: string) => post<{ user: User }>('/api/auth/login', { email, password }),
  logout: () => post<void>('/api/auth/logout'),
  list: (filter: Filter) => call<{ conversations: ConversationSummary[] }>(`/api/conversations${FILTER_QUERY[filter]}`),
  get: (id: number) => call<{ conversation: Conversation; contact: Contact; messages: Message[] }>(`/api/conversations/${id}`),
  assign: (id: number) => post<{ conversation: Conversation }>(`/api/conversations/${id}/assign`),
  handBack: (id: number) => post<{ conversation: Conversation }>(`/api/conversations/${id}/hand-back`),
  close: (id: number) => post<{ conversation: Conversation }>(`/api/conversations/${id}/close`),
  reply: (id: number, text: string) => post<{ message: Message }>(`/api/conversations/${id}/messages`, { text }),
}
```

`apps/web/src/live.ts`:
```ts
export type Live = { stop(): void; send(data: string): boolean }

const OPEN = 1

export function connectLive(path: string, onFrame: (frame: any) => void, onOpen?: () => void): Live {
  let ws: WebSocket | null = null
  let delay = 1000
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}${path}`)
    ws.onopen = () => { delay = 1000; onOpen?.() }
    ws.onmessage = (e) => { try { onFrame(JSON.parse(e.data)) } catch { /* ignore malformed frames */ } }
    ws.onclose = (e) => {
      if (stopped || e.code === 4401 || e.code === 4400) return
      timer = setTimeout(open, delay)
      delay = Math.min(delay * 2, 10_000)
    }
  }
  open()
  return {
    stop: () => { stopped = true; clearTimeout(timer); ws?.close() },
    send: (data) => {
      if (!ws || ws.readyState !== OPEN) return false
      ws.send(data)
      return true
    },
  }
}
```

`onOpen` runs on every (re)connect; callers refetch there, so nothing missed while offline is lost (spec section 10).

- [ ] **Step 4: Components**

`apps/web/src/components/ConversationList.tsx`:
```tsx
import type { ConversationSummary } from '../api'

const STATUS_LABEL = { open: 'Open', waiting_human: 'Waiting for human', closed: 'Closed' } as const

export function ConversationList({ items, selectedId, onSelect }: {
  items: ConversationSummary[]; selectedId: number | null; onSelect: (id: number) => void
}) {
  if (items.length === 0) return <p className="empty">No conversations yet</p>
  return (
    <ul className="conv-list">
      {items.map((c) => (
        <li key={c.id}>
          <button className={c.id === selectedId ? 'conv selected' : 'conv'} onClick={() => onSelect(c.id)}>
            <span className="conv-name">{c.contactName ?? `Visitor #${c.id}`}</span>
            {c.status !== 'open' && <span className={`badge badge-${c.status}`}>{STATUS_LABEL[c.status]}</span>}
            <span className="conv-last">{c.lastMessage ?? ''}</span>
            {c.assigneeName && <span className="conv-assignee">{c.assigneeName}</span>}
          </button>
        </li>
      ))}
    </ul>
  )
}
```

`apps/web/src/components/Timeline.tsx`:
```tsx
import type { Message } from '../api'

const WHO = { contact: 'Customer', agent: 'AI agent', user: 'Team', system: 'System' } as const

export function Timeline({ messages }: { messages: Message[] }) {
  return (
    <ol className="timeline">
      {messages.map((m) => (
        <li key={m.id} className={`msg msg-${m.sender}`}>
          <span className="msg-who">{WHO[m.sender]}</span>
          {m.type === 'audio'
            ? <span className="msg-text">[audio]</span>
            : <span className="msg-text">{m.text}</span>}
          <time className="msg-time">{new Date(m.createdAt).toLocaleTimeString()}</time>
        </li>
      ))}
    </ol>
  )
}
```

Run: `npm test -w apps/web` → PASS.

- [ ] **Step 5: Pages, App and styles**

`apps/web/src/pages/Login.tsx`:
```tsx
import { useState, type FormEvent } from 'react'
import { api, ApiError, type User } from '../api'

export function Login({ onLoggedIn }: { onLoggedIn: (u: User) => void }) {
  const [email, setEmail] = useState('demo@relay.dev')
  const [password, setPassword] = useState('relay-demo')
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      onLoggedIn((await api.login(email, password)).user)
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'invalid_credentials' ? 'Invalid email or password' : 'Could not sign in')
    }
  }

  return (
    <form className="login" onSubmit={submit}>
      <h1>Relay</h1>
      <label>Email <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required /></label>
      <label>Password <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit">Sign in</button>
      <p className="hint">Demo credentials are pre-filled.</p>
    </form>
  )
}
```

`apps/web/src/pages/Inbox.tsx`:
```tsx
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, type Contact, type Conversation, type ConversationSummary, type Filter, type Message, type User } from '../api'
import { connectLive } from '../live'
import { ConversationList } from '../components/ConversationList'
import { Timeline } from '../components/Timeline'

const FILTERS: Array<[Filter, string]> = [['all', 'All'], ['waiting_human', 'Waiting for human'], ['mine', 'Mine'], ['closed', 'Closed']]

export function Inbox({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [items, setItems] = useState<ConversationSummary[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<{ conversation: Conversation; contact: Contact; messages: Message[] } | null>(null)
  const [draft, setDraft] = useState('')

  const refreshList = useCallback(async () => setItems((await api.list(filter)).conversations), [filter])
  const refreshDetail = useCallback(async () => { if (selectedId) setDetail(await api.get(selectedId)) }, [selectedId])

  useEffect(() => { void refreshList() }, [refreshList])
  useEffect(() => { void refreshDetail() }, [refreshDetail])

  // Refs keep one socket for the whole session: the handler always sees the current selection
  // and refresh functions without reconnecting when they change.
  const selectedRef = useRef(selectedId)
  const refreshRef = useRef({ refreshList, refreshDetail })
  selectedRef.current = selectedId
  refreshRef.current = { refreshList, refreshDetail }

  useEffect(() => connectLive('/ws/inbox', (frame) => {
    void refreshRef.current.refreshList()
    const current = selectedRef.current
    if (frame.event === 'message.created' && frame.data.conversationId === current) {
      setDetail((d) => d && !d.messages.some((m) => m.id === frame.data.message.id)
        ? { ...d, messages: [...d.messages, frame.data.message] } : d)
    }
    if (frame.event === 'conversation.updated' && frame.data.conversation.id === current) {
      setDetail((d) => d && { ...d, conversation: frame.data.conversation })
    }
  }, () => { void refreshRef.current.refreshList(); void refreshRef.current.refreshDetail() }).stop, [])

  async function act(fn: (id: number) => Promise<unknown>) {
    if (!selectedId) return
    await fn(selectedId)
    await Promise.all([refreshList(), refreshDetail()])
  }

  async function send(e: FormEvent) {
    e.preventDefault()
    const text = draft.trim()
    if (!selectedId || !text) return
    setDraft('')
    await api.reply(selectedId, text)
  }

  const conv = detail?.conversation
  return (
    <div className="inbox">
      <aside className="col-list">
        <header className="topbar">
          <strong>Relay</strong>
          <span>{user.name}</span>
          <button onClick={async () => { await api.logout(); onLogout() }}>Sign out</button>
        </header>
        <nav className="filters">
          {FILTERS.map(([f, label]) => (
            <button key={f} className={f === filter ? 'active' : ''} onClick={() => setFilter(f)}>{label}</button>
          ))}
        </nav>
        <ConversationList items={items} selectedId={selectedId} onSelect={setSelectedId} />
      </aside>
      <main className="col-timeline">
        {!detail && <p className="empty">Select a conversation</p>}
        {detail && conv && (
          <>
            <header className="conv-header">
              <h2>{detail.contact.name ?? `Visitor #${conv.id}`}</h2>
              <div className="actions">
                {conv.assigneeId !== user.id && conv.status !== 'closed' && <button onClick={() => act(api.assign)}>Assign to me</button>}
                {conv.assigneeId !== null && conv.status !== 'closed' && <button onClick={() => act(api.handBack)}>Hand back to agent</button>}
                {conv.status !== 'closed' && <button onClick={() => act(api.close)}>Close</button>}
              </div>
            </header>
            {conv.handoffReason && <p className="handoff">Handoff: {conv.handoffReason}</p>}
            <Timeline messages={detail.messages} />
            {conv.status !== 'closed' && (
              <form className="reply" onSubmit={send}>
                <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Reply as the team…" />
                <button type="submit">Send</button>
              </form>
            )}
          </>
        )}
      </main>
      <aside className="col-contact">
        {detail && (
          <>
            <h3>Contact</h3>
            <p>{detail.contact.name ?? 'Anonymous visitor'}</p>
            <p className="muted">Channel: {detail.contact.channel}</p>
            <h3>Tags</h3>
            <p className="muted">{conv?.tags.length ? conv.tags.join(', ') : 'None'}</p>
          </>
        )}
      </aside>
    </div>
  )
}
```

`apps/web/src/App.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { api, type User } from './api'
import { Login } from './pages/Login'
import { Inbox } from './pages/Inbox'

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined)
  useEffect(() => { api.me().then((r) => setUser(r.user), () => setUser(null)) }, [])

  if (user === undefined) return null
  if (user === null) return <Login onLoggedIn={setUser} />
  return <Inbox user={user} onLogout={() => setUser(null)} />
}
```

`apps/web/src/main.tsx`:
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
```

`apps/web/src/styles.css`:
```css
:root { --bg: #f7f7f8; --panel: #fff; --text: #1d1d1f; --muted: #6b6b73; --line: #e4e4e8; --accent: #4f46e5; --warn: #b45309; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #111114; --panel: #1b1b20; --text: #ececf1; --muted: #9a9aa5; --line: #2c2c33; --accent: #818cf8; --warn: #fbbf24; }
}
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--text); }
button { font: inherit; cursor: pointer; border: 1px solid var(--line); background: var(--panel); color: var(--text); border-radius: 6px; padding: 6px 10px; }
button.active, button[type='submit'] { background: var(--accent); color: #fff; border-color: var(--accent); }
input { font: inherit; padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--text); }
.login { max-width: 320px; margin: 15vh auto; display: flex; flex-direction: column; gap: 12px; }
.login label { display: flex; flex-direction: column; gap: 4px; }
.error { color: #dc2626; } .hint, .muted, .empty { color: var(--muted); }
.inbox { display: grid; grid-template-columns: 300px 1fr 240px; height: 100vh; }
.col-list, .col-contact { background: var(--panel); border-right: 1px solid var(--line); overflow: auto; }
.col-contact { border-right: 0; border-left: 1px solid var(--line); padding: 12px; }
.col-timeline { display: flex; flex-direction: column; overflow: hidden; }
.topbar { display: flex; gap: 8px; align-items: center; padding: 12px; border-bottom: 1px solid var(--line); }
.topbar span { margin-left: auto; color: var(--muted); }
.filters { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px; }
.conv-list { list-style: none; margin: 0; padding: 0; }
.conv { width: 100%; text-align: left; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; display: grid; gap: 2px; padding: 10px 12px; }
.conv.selected { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.conv-name { font-weight: 600; } .conv-last, .conv-assignee { color: var(--muted); font-size: 13px; }
.badge { font-size: 12px; justify-self: start; padding: 1px 6px; border-radius: 99px; background: var(--line); }
.badge-waiting_human { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
.conv-header { display: flex; align-items: center; gap: 8px; padding: 12px; border-bottom: 1px solid var(--line); }
.conv-header h2 { margin: 0; font-size: 16px; } .actions { margin-left: auto; display: flex; gap: 6px; }
.handoff { margin: 8px 12px 0; color: var(--warn); }
.timeline { list-style: none; margin: 0; padding: 12px; flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 8px; }
.msg { max-width: 70%; padding: 8px 10px; border-radius: 10px; background: var(--panel); border: 1px solid var(--line); display: grid; gap: 2px; }
.msg-contact { align-self: flex-start; } .msg-agent, .msg-user { align-self: flex-end; }
.msg-agent { border-color: var(--accent); } .msg-who, .msg-time { font-size: 12px; color: var(--muted); }
.reply { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--line); } .reply input { flex: 1; }
@media (max-width: 800px) { .inbox { grid-template-columns: 1fr; } .col-contact { display: none; } }
```

- [ ] **Step 6: Typecheck and test**

Run: `npm run typecheck -w apps/web` → no errors. Run `npm test -w apps/web` → PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web package-lock.json
git commit -m "feat(web): API client, login and live inbox

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Demo page with the chat widget

**Files:**
- Create: `apps/web/src/components/Widget.tsx`, `apps/web/src/pages/Demo.tsx`
- Modify: `apps/web/src/App.tsx` (route `/demo`), `apps/web/src/styles.css` (append widget styles)
- Test: `apps/web/test/Widget.test.tsx`

**Interfaces:**
- Consumes: `/ws/widget` frames from Task 6 (`history`, `message`, `error`); `connectLive` from Task 7.
- Produces: `<Widget company="Acme Coworking" />` — floating chat that keeps a visitor token in `localStorage['relay.visitor']` (generated with `crypto.randomUUID()` on first use); `visitorToken(): string` exported for tests.

- [ ] **Step 1: Failing test**

`apps/web/test/Widget.test.tsx`:
```tsx
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { Widget, visitorToken } from '../src/components/Widget'

class FakeSocket {
  static last: FakeSocket
  sent: string[] = []
  readyState = 1
  onopen?: () => void; onmessage?: (e: { data: string }) => void; onclose?: (e: { code: number }) => void
  constructor(public url: string) { FakeSocket.last = this; setTimeout(() => this.onopen?.(), 0) }
  send(d: string) { this.sent.push(d) }
  close() {}
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }) }
}

beforeEach(() => { localStorage.clear(); (globalThis as any).WebSocket = FakeSocket })

describe('Widget', () => {
  it('keeps one visitor token per browser', () => {
    const a = visitorToken()
    expect(a).toMatch(/[0-9a-f-]{36}/)
    expect(visitorToken()).toBe(a)
  })

  it('opens, shows history and live messages, and sends text frames', async () => {
    render(<Widget company="Acme Coworking" />)
    fireEvent.click(screen.getByRole('button', { name: /chat with us/i }))
    expect(FakeSocket.last.url).toContain(`/ws/widget?token=${visitorToken()}`)
    act(() => FakeSocket.last.emit({ type: 'history', messages: [{ id: 1, sender: 'contact', type: 'text', text: 'Earlier' }] }))
    expect(screen.getByText('Earlier')).toBeInTheDocument()
    act(() => FakeSocket.last.emit({ type: 'message', message: { id: 2, sender: 'user', type: 'text', text: 'Hello from the team' } }))
    expect(screen.getByText('Hello from the team')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText(/type a message/i), { target: { value: 'Price?' } })
    fireEvent.submit(screen.getByRole('form', { name: /chat/i }))
    expect(JSON.parse(FakeSocket.last.sent[0]!)).toEqual({ type: 'text', text: 'Price?' })
  })
})
```

Run: `npm test -w apps/web` → FAIL.

- [ ] **Step 2: Widget**

`apps/web/src/components/Widget.tsx`:
```tsx
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { connectLive, type Live } from '../live'

type WidgetMessage = { id: number; sender: 'contact' | 'agent' | 'user' | 'system'; type: 'text' | 'audio'; text: string | null }

const KEY = 'relay.visitor'

export function visitorToken(): string {
  let t = localStorage.getItem(KEY)
  if (!t) { t = crypto.randomUUID(); localStorage.setItem(KEY, t) }
  return t
}

export function Widget({ company }: { company: string }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<WidgetMessage[]>([])
  const [draft, setDraft] = useState('')
  const liveRef = useRef<Live | null>(null)

  useEffect(() => {
    if (!open) return
    const live = connectLive(`/ws/widget?token=${visitorToken()}`, (frame) => {
      if (frame.type === 'history') setMessages(frame.messages)
      if (frame.type === 'message') setMessages((m) => m.some((x) => x.id === frame.message.id) ? m : [...m, frame.message])
    })
    liveRef.current = live
    return () => { live.stop(); liveRef.current = null }
  }, [open])

  function send(e: FormEvent) {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    if (liveRef.current?.send(JSON.stringify({ type: 'text', text }))) setDraft('')
  }

  if (!open) return <button className="widget-launcher" onClick={() => setOpen(true)}>Chat with us</button>

  return (
    <section className="widget">
      <header className="widget-head">
        <strong>{company}</strong>
        <button aria-label="Close chat" onClick={() => setOpen(false)}>×</button>
      </header>
      <ol className="widget-body">
        {messages.map((m) => (
          <li key={m.id} className={m.sender === 'contact' ? 'w-msg w-me' : 'w-msg w-them'}>
            {m.type === 'audio' ? '[audio]' : m.text}
          </li>
        ))}
      </ol>
      <form aria-label="Chat" className="widget-form" onSubmit={send}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type a message…" />
        <button type="submit">Send</button>
      </form>
    </section>
  )
}
```

- [ ] **Step 3: Demo page, route and styles**

`apps/web/src/App.tsx` (adds the `/demo` route, which needs no sign-in):
```tsx
import { useEffect, useState } from 'react'
import { api, type User } from './api'
import { Login } from './pages/Login'
import { Inbox } from './pages/Inbox'
import { Demo } from './pages/Demo'

export function App() {
  const isDemo = location.pathname.startsWith('/demo')
  const [user, setUser] = useState<User | null | undefined>(undefined)
  useEffect(() => { if (!isDemo) api.me().then((r) => setUser(r.user), () => setUser(null)) }, [isDemo])

  if (isDemo) return <Demo />
  if (user === undefined) return null
  if (user === null) return <Login onLoggedIn={setUser} />
  return <Inbox user={user} onLogout={() => setUser(null)} />
}
```

`apps/web/src/pages/Demo.tsx`:
```tsx
import { Widget } from '../components/Widget'

export function Demo() {
  return (
    <div className="demo-site">
      <header><h1>Acme Coworking</h1><p>Fictional company used to demo Relay.</p></header>
      <main>
        <p>Desks, meeting rooms and a virtual office address in the city center.</p>
        <p>Open the <a href="/">inbox</a> in another tab, sign in with the demo user, and chat here.</p>
      </main>
      <Widget company="Acme Coworking" />
    </div>
  )
}
```

Append to `apps/web/src/styles.css`:
```css
.demo-site { max-width: 720px; margin: 0 auto; padding: 32px 16px; }
.widget-launcher { position: fixed; right: 20px; bottom: 20px; background: var(--accent); color: #fff; border: 0; border-radius: 99px; padding: 12px 18px; }
.widget { position: fixed; right: 20px; bottom: 20px; width: min(360px, calc(100vw - 32px)); height: 480px; display: flex; flex-direction: column; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 8px 30px rgb(0 0 0 / .15); }
.widget-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--line); }
.widget-body { list-style: none; margin: 0; padding: 12px; flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 6px; }
.w-msg { max-width: 80%; padding: 6px 10px; border-radius: 10px; }
.w-me { align-self: flex-end; background: var(--accent); color: #fff; } .w-them { align-self: flex-start; background: var(--bg); }
.widget-form { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--line); } .widget-form input { flex: 1; }
```

- [ ] **Step 4: Tests and typecheck**

Run: `npm test -w apps/web` → PASS (ConversationList, Widget).
Run: `npm run typecheck -w apps/web` → no errors.

- [ ] **Step 5: Manual end-to-end check**

1. `npm run dev:api` in one terminal, `npm run dev:web` in another.
2. Open `http://localhost:5173/` → sign in (pre-filled).
3. Open `http://localhost:5173/demo` in a second tab → "Chat with us" → send "Hi".
4. Expected: the conversation appears in the inbox without a reload; open it, "Assign to me", reply "Hello" → it shows in the widget; "Hand back to agent", "Close" update the status live.
5. Reload the demo tab, reopen the chat → history is still there (until the conversation is closed).

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat(web): demo page with the chat widget

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Docker Compose and a first README

**Files:**
- Create: `apps/api/Dockerfile`, `apps/web/Dockerfile`, `apps/web/nginx.conf`, `docker-compose.yml`, `.dockerignore`, `README.md`, `LICENSE`

**Interfaces:**
- Produces: `docker compose up` serves the web app on `http://localhost:8080` (nginx serving the Vite build and proxying `/api` and `/ws` to the `api` service on 3000). Data persists in the `relay-data` volume.

- [ ] **Step 1: Dockerfiles**

`.dockerignore`:
```
node_modules
**/node_modules
data
**/dist
.git
```

`apps/api/Dockerfile`:
```dockerfile
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci -w apps/api --include-workspace-root=false
COPY apps/api apps/api
WORKDIR /app/apps/api
ENV RELAY_DB=/data/relay.db PORT=3000
EXPOSE 3000
CMD ["npx", "tsx", "src/main.ts"]
```

`apps/web/Dockerfile`:
```dockerfile
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/web --include-workspace-root=false
COPY apps/web apps/web
RUN npm run build -w apps/web

FROM nginx:1.29-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
```

`apps/web/nginx.conf`:
```nginx
server {
  listen 80;
  root /usr/share/nginx/html;
  location /api/ { proxy_pass http://api:3000; }
  location /ws/ {
    proxy_pass http://api:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
  location / { try_files $uri /index.html; }
}
```

`docker-compose.yml`:
```yaml
services:
  api:
    build: { context: ., dockerfile: apps/api/Dockerfile }
    volumes: [relay-data:/data]
    restart: unless-stopped
  web:
    build: { context: ., dockerfile: apps/web/Dockerfile }
    ports: ["8080:80"]
    depends_on: [api]
    restart: unless-stopped
volumes:
  relay-data:
```

- [ ] **Step 2: README and license**

`README.md`:
```markdown
# Relay

An open-source omnichannel inbox with an AI agent and local voice transcription.

> Status: plan 1 of 6 — real-time inbox and chat widget. The AI agent and transcription land in the next plans.

## Run it

    docker compose up --build

Open http://localhost:8080 (team inbox, demo user pre-filled) and http://localhost:8080/demo (customer widget) side by side.

## Develop

    npm install
    npm run dev:api    # http://localhost:3000
    npm run dev:web    # http://localhost:5173
    npm test

## Architecture

- `apps/api` — Fastify + TypeScript, SQLite (Drizzle), WebSocket for the widget and the inbox.
- `apps/web` — React + Vite: inbox, login and the demo widget.
- Channels plug in through one interface; the widget ships in v1, WhatsApp is the next connector.

## Roadmap

AI agent with handoff to humans · Claude and Ollama providers · local Whisper transcription · WhatsApp connector · i18n (EN/PT).

## Em português

Relay é uma inbox de atendimento omnichannel, open source, com agente de IA e transcrição de áudio local. Rode com `docker compose up --build` e abra a inbox e a página `/demo` lado a lado.

## License

MIT
```

`LICENSE`: the standard MIT license text with `Copyright (c) 2026 João Leandro`.

- [ ] **Step 3: Verify**

If Docker is available: `docker compose up --build`, then repeat the manual check from Task 8 on `http://localhost:8080`.
If Docker is not available on this machine, record that in the commit message body; CI in plan 6 builds the images.

Run: `npm test` and `npm run typecheck` from the root → PASS, no errors.

- [ ] **Step 4: Commit**

```bash
git add .dockerignore docker-compose.yml apps/api/Dockerfile apps/web/Dockerfile apps/web/nginx.conf README.md LICENSE
git commit -m "chore: docker compose, README and MIT license

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Next plans

- Plan 2 — agent engine with the demo provider (rules, tools, handoff, run log, "Agent activity").
- Plan 3 — Claude and Ollama providers.
- Plan 4 — transcription service, client and voice in the widget.
- Plan 5 — settings screen and knowledge base editor.
- Plan 6 — i18n, polish, Playwright end-to-end test, CI, final README with GIF.
