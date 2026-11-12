# Relay plan 5 — settings and knowledge base — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in team member can edit the agent settings and the Markdown knowledge base from a Settings screen, and the plan-5 follow-ups (typed settings, unified error codes, inbox UX, pagination, passages for text-only models) are closed.

**Architecture:** The API gets a typed settings module (`readSettings` / `updateSettings`, one zod schema) with `GET/PUT /api/settings`, and a `KnowledgeStore` that owns `data/knowledge/*.md` (seeded from the shipped `apps/api/knowledge` on first start, cached passages invalidated on write) with CRUD routes. The engine puts the top passages into the system prompt when the provider is text-only. The web app gets a `/settings` page (agent form + knowledge editor) and inbox fixes.

**Tech Stack:** Fastify 5, zod 4, Drizzle + better-sqlite3, React 19 + Vite, Vitest 5, Testing Library.

## Global Constraints

- Code, comments, commit messages and UI copy in English (i18n is plan 6).
- No employer names, data, IPs or keys anywhere; sample data stays fictional (Acme Coworking).
- Git identity is already set in the repo (`João Leandro <272076793+sidsidoso@users.noreply.github.com>`). Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- API errors are always `{ error, code }` with a stable code (spec §10). Validation errors are `400 invalid_request`.
- Every inbox/settings route requires a session (`makeRequireUser`).
- The demo must keep working with zero configuration (`docker compose up`, demo provider).
- Run tests per workspace: `npm test -w apps/api -- <file>` / `npm test -w apps/web -- <file>`; typecheck with `npm run typecheck -w apps/api` and `-w apps/web`.

## File map

| File | Responsibility |
|---|---|
| `apps/api/src/core/settings.ts` (modify) | One zod schema for every setting; `readSettings`, `updateSettings`, `agentSettings`, `transcriptionEnabled` |
| `apps/api/src/core/settingsRoutes.ts` (create) | `GET/PUT /api/settings` |
| `apps/api/src/http/errors.ts` (modify) | `fields` on validation errors; `KnowledgeError` mapping |
| `apps/api/src/auth/routes.ts` (modify) | Login body errors become `invalid_request` |
| `apps/api/src/agent/knowledgeStore.ts` (create) | Files in the knowledge dir: list/read/write/remove, cached passages, seeding |
| `apps/api/src/agent/knowledgeRoutes.ts` (create) | `/api/knowledge` CRUD |
| `apps/api/src/agent/engine.ts` (modify) | Passages in the system prompt for text-only providers |
| `apps/api/src/agent/providers/types.ts` (modify) | `textOnly?` on `Provider` |
| `apps/api/src/core/conversations.ts`, `core/routes.ts` (modify) | Cursor pagination of the list |
| `apps/api/src/server.ts`, `main.ts` (modify) | Wire settings and knowledge routes, knowledge dir under data |
| `apps/web/src/api.ts` (modify) | Settings, knowledge and paginated list calls; `ApiError.fields` |
| `apps/web/src/demo.ts` (create) | Demo credentials shared by Login and Demo |
| `apps/web/src/pages/Settings.tsx` (create) | Agent settings form + knowledge editor host |
| `apps/web/src/components/KnowledgeEditor.tsx` (create) | List/open/edit/create/delete Markdown files |
| `apps/web/src/App.tsx`, `pages/Inbox.tsx`, `pages/Login.tsx`, `pages/Demo.tsx`, `components/Timeline.tsx`, `styles.css` (modify) | Routing, UX fixes, pagination |

---

### Task 1: Typed settings and the settings API

**Files:**
- Modify: `apps/api/src/core/settings.ts`
- Create: `apps/api/src/core/settingsRoutes.ts`
- Modify: `apps/api/src/http/errors.ts`, `apps/api/src/auth/routes.ts`, `apps/api/src/server.ts`
- Test: `apps/api/test/settings.test.ts`, `apps/api/test/settings-routes.test.ts` (create), `apps/api/test/auth.test.ts:60`, `apps/api/test/errors.test.ts:48`

**Interfaces:**
- Produces: `type Settings = { instructions: string; handoffKeywords: string[]; turnLimit: number; handoffMessage: string; transcriptionEnabled: boolean }`; `readSettings(db): Settings`; `updateSettings(db, patch: SettingsPatch): Settings`; `SettingsPatch` (zod, partial + strict); `agentSettings(db)` and `transcriptionEnabled(db)` keep their current signatures. Routes `GET /api/settings → { settings }`, `PUT /api/settings` (partial body) `→ { settings }`. Validation error body: `{ error: 'Invalid request', code: 'invalid_request', fields: string[] }`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/settings.test.ts` (inside the file, after the existing `describe`):

```ts
import { readSettings, updateSettings } from '../src/core/settings'

describe('readSettings / updateSettings', () => {
  it('reads every setting, typed', async () => {
    const db = createDb(':memory:')
    await seed(db)
    expect(readSettings(db)).toMatchObject({ turnLimit: 10, transcriptionEnabled: true })
    expect(typeof readSettings(db).instructions).toBe('string')
  })

  it('updates only the fields in the patch and returns the new settings', async () => {
    const db = createDb(':memory:')
    await seed(db)
    const before = readSettings(db)
    const after = updateSettings(db, { turnLimit: 4, transcriptionEnabled: false })
    expect(after).toEqual({ ...before, turnLimit: 4, transcriptionEnabled: false })
    expect(transcriptionEnabled(db)).toBe(false)
    expect(agentSettings(db).turnLimit).toBe(4)
  })

  it('trims text and keywords', async () => {
    const db = createDb(':memory:')
    await seed(db)
    const s = updateSettings(db, { handoffMessage: '  Hold on  ', handoffKeywords: [' human ', 'manager'] })
    expect(s.handoffMessage).toBe('Hold on')
    expect(s.handoffKeywords).toEqual(['human', 'manager'])
  })
})
```

Create `apps/api/test/settings-routes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { testServer } from './helpers'

describe('settings routes', () => {
  it('require a session', async () => {
    const { app } = await testServer()
    expect((await app.inject({ method: 'GET', url: '/api/settings' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: {} })).statusCode).toBe(401)
  })

  it('read and partially update the settings', async () => {
    const { app, login } = await testServer()
    const headers = { cookie: await login() }
    const got = await app.inject({ method: 'GET', url: '/api/settings', headers })
    expect(got.json().settings.turnLimit).toBe(10)
    const put = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { turnLimit: 3 } })
    expect(put.statusCode).toBe(200)
    expect(put.json().settings).toMatchObject({ turnLimit: 3, transcriptionEnabled: true })
  })

  it('reject invalid values and unknown keys, naming the fields', async () => {
    const { app, login } = await testServer()
    const headers = { cookie: await login() }
    const bad = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { turnLimit: 0, instructions: '   ' } })
    expect(bad.statusCode).toBe(400)
    expect(bad.json()).toEqual({ error: 'Invalid request', code: 'invalid_request', fields: ['instructions', 'turnLimit'] })
    const unknown = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { color: 'red' } })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.json().code).toBe('invalid_request')
  })
})
```

Change the expectation at `apps/api/test/auth.test.ts:60` to `expect(res.json().code).toBe('invalid_request')`.
Change `apps/api/test/errors.test.ts:48` to `expect(res.json()).toEqual({ error: 'Invalid request', code: 'invalid_request', fields: ['id'] })`.

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test -w apps/api -- test/settings.test.ts test/settings-routes.test.ts test/auth.test.ts test/errors.test.ts`
Expected: FAIL (`readSettings` is not exported; `/api/settings` is 404; old error codes).

- [ ] **Step 3: Rewrite `apps/api/src/core/settings.ts`**

```ts
import { z } from 'zod'
import type { Db } from '../db/client'
import { settings } from '../db/schema'
import { DEFAULT_SETTINGS } from '../db/seed'

export const SettingsSchema = z.object({
  instructions: z.string().trim().min(1).max(8000),
  handoffKeywords: z.array(z.string().trim().min(1).max(60)).max(50),
  turnLimit: z.number().int().min(1).max(100),
  handoffMessage: z.string().trim().min(1).max(1000),
  transcriptionEnabled: z.boolean(),
})
export type Settings = z.infer<typeof SettingsSchema>
export type AgentSettings = Omit<Settings, 'transcriptionEnabled'>

/** A PUT body: any subset of the settings, no unknown keys. */
export const SettingsPatch = SettingsSchema.partial().strict()
export type SettingsPatch = z.infer<typeof SettingsPatch>

/** Where each setting is stored in the `settings` table (spec §7). */
const KEYS: Record<keyof Settings, string> = {
  instructions: 'agent.instructions',
  handoffKeywords: 'agent.handoffKeywords',
  turnLimit: 'agent.turnLimit',
  handoffMessage: 'agent.handoffMessage',
  transcriptionEnabled: 'transcription.enabled',
}
const FIELDS = Object.keys(KEYS) as Array<keyof Settings>

/** Every setting, typed; a missing or invalid stored value falls back to its default. */
export function readSettings(db: Db): Settings {
  const stored = new Map(db.select().from(settings).all().map((r) => [r.key, r.value]))
  const out: Record<string, unknown> = {}
  for (const field of FIELDS) {
    const parsed = SettingsSchema.shape[field].safeParse(stored.get(KEYS[field]))
    out[field] = parsed.success ? parsed.data : DEFAULT_SETTINGS[KEYS[field]]
  }
  return out as Settings
}

/** Stores the fields present in `patch` in one transaction and returns the resulting settings. */
export function updateSettings(db: Db, patch: SettingsPatch): Settings {
  const clean = SettingsPatch.parse(patch)
  db.transaction((tx) => {
    for (const field of FIELDS) {
      const value = clean[field]
      if (value === undefined) continue
      tx.insert(settings).values({ key: KEYS[field], value })
        .onConflictDoUpdate({ target: settings.key, set: { value } }).run()
    }
  })
  return readSettings(db)
}

export function agentSettings(db: Db): AgentSettings {
  const { transcriptionEnabled: _ignored, ...agent } = readSettings(db)
  return agent
}

/** Spec §7 settings: transcription on/off. A missing or invalid stored value means on. */
export function transcriptionEnabled(db: Db): boolean {
  return readSettings(db).transcriptionEnabled
}
```

(`DEFAULT_SETTINGS['transcription.enabled']` is `true`, so an invalid stored value still means on.)

- [ ] **Step 4: Create `apps/api/src/core/settingsRoutes.ts`**

```ts
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client'
import { makeRequireUser } from '../auth/guard'
import { readSettings, updateSettings, SettingsPatch } from './settings'

export function settingsRoutes(app: FastifyInstance, db: Db) {
  const requireUser = makeRequireUser(db)
  app.get('/api/settings', { preHandler: requireUser }, async () => ({ settings: readSettings(db) }))
  app.put('/api/settings', { preHandler: requireUser }, async (req) =>
    ({ settings: updateSettings(db, SettingsPatch.parse(req.body ?? {})) }))
}
```

- [ ] **Step 5: Name the invalid fields in `apps/api/src/http/errors.ts`**

Replace the `ZodError` line with:

```ts
    if (err instanceof z.ZodError) {
      // An unknown key is an `unrecognized_keys` issue with an empty path: reported as `body`.
      const fields = [...new Set(err.issues.map((i) => i.path.join('.') || 'body'))]
      return reply.code(400).send({ error: 'Invalid request', code: 'invalid_request', fields })
    }
```

Note: zod reports issues in schema key order, so `fields` for the route test is `['instructions', 'turnLimit']`.

- [ ] **Step 6: Unify the login validation code in `apps/api/src/auth/routes.ts`**

Replace lines 35–36:

```ts
    const body = LoginBody.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'Invalid body', code: 'invalid_body' })
```

with:

```ts
    const body = { data: LoginBody.parse(req.body) } // a ZodError becomes 400 invalid_request in the error handler
```

(Keeping the `body.data` shape means the rest of the handler is unchanged.)

- [ ] **Step 7: Register the routes in `apps/api/src/server.ts`**

Add `import { settingsRoutes } from './core/settingsRoutes'` and, after `conversationRoutes(app, deps)`, `settingsRoutes(app, deps.db)`.

- [ ] **Step 8: Run the tests and the type check**

Run: `npm test -w apps/api -- test/settings.test.ts test/settings-routes.test.ts test/auth.test.ts test/errors.test.ts test/engine.test.ts test/transcription.test.ts`
Expected: PASS. Then `npm run typecheck -w apps/api` → no errors.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/core/settings.ts apps/api/src/core/settingsRoutes.ts apps/api/src/http/errors.ts apps/api/src/auth/routes.ts apps/api/src/server.ts apps/api/test/settings.test.ts apps/api/test/settings-routes.test.ts apps/api/test/auth.test.ts apps/api/test/errors.test.ts
git commit -m "feat(api): typed settings with GET/PUT /api/settings; validation errors name their fields

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Knowledge store under the data folder

**Files:**
- Create: `apps/api/src/agent/knowledgeStore.ts`
- Modify: `apps/api/src/main.ts:35-36,42,47`
- Test: `apps/api/test/knowledge-store.test.ts` (create)

**Interfaces:**
- Consumes: `loadKnowledge(dir): Passage[]` from `apps/api/src/agent/knowledge.ts`.
- Produces:
  - `KNOWLEDGE_NAME: RegExp` (`/^[a-z0-9][a-z0-9-]{0,62}\.md$/`), `MAX_KNOWLEDGE_BYTES = 100 * 1024`, `MAX_KNOWLEDGE_FILES = 50`
  - `class KnowledgeError extends Error { code: 'invalid_name' | 'too_large' | 'too_many_files' }`
  - `type KnowledgeFile = { name: string; bytes: number; updatedAt: string }`
  - `class KnowledgeStore { constructor(dir: string); passages(): Passage[]; list(): KnowledgeFile[]; read(name): string | null; write(name, content): KnowledgeFile; remove(name): boolean }`
  - `seedKnowledge(dir: string, shippedDir: string): number` — copies the shipped `*.md` only when `dir` has none; returns how many were copied.

- [ ] **Step 1: Write the failing test** — `apps/api/test/knowledge-store.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnowledgeStore, KnowledgeError, seedKnowledge, MAX_KNOWLEDGE_BYTES, MAX_KNOWLEDGE_FILES } from '../src/agent/knowledgeStore'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'relay-kb-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('KnowledgeStore', () => {
  it('writes, lists, reads and removes files, and refreshes passages after each write', () => {
    const store = new KnowledgeStore(join(dir, 'kb'))
    expect(store.list()).toEqual([])
    expect(store.passages()).toEqual([])
    const file = store.write('hours.md', '# Hours\r\n\r\n## Weekdays\r\nOpen 8am to 8pm.\r\n')
    expect(file).toMatchObject({ name: 'hours.md', bytes: expect.any(Number) })
    expect(store.read('hours.md')).toBe('# Hours\n\n## Weekdays\nOpen 8am to 8pm.\n')
    expect(store.passages().map((p) => p.title)).toEqual(['Weekdays'])
    store.write('hours.md', '# Hours\n\n## Weekends\nClosed.\n')
    expect(store.passages().map((p) => p.title)).toEqual(['Weekends'])
    expect(store.list().map((f) => f.name)).toEqual(['hours.md'])
    expect(store.remove('hours.md')).toBe(true)
    expect(store.remove('hours.md')).toBe(false)
    expect(store.read('hours.md')).toBeNull()
    expect(store.passages()).toEqual([])
    expect(readdirSync(join(dir, 'kb'))).toEqual([]) // no temp files left behind
  })

  it('rejects names that could leave the folder or are not lowercase .md', () => {
    const store = new KnowledgeStore(dir)
    for (const bad of ['../x.md', 'a/b.md', 'Notes.md', 'x.txt', '.md', '-x.md', `${'a'.repeat(64)}.md`]) {
      expect(() => store.write(bad, 'x')).toThrow(KnowledgeError)
      expect(() => store.read(bad)).toThrow(KnowledgeError)
      expect(() => store.remove(bad)).toThrow(KnowledgeError)
    }
  })

  it('caps the file size and the number of files', () => {
    const store = new KnowledgeStore(dir)
    expect(() => store.write('big.md', 'x'.repeat(MAX_KNOWLEDGE_BYTES + 1))).toThrow(expect.objectContaining({ code: 'too_large' }))
    for (let i = 0; i < MAX_KNOWLEDGE_FILES; i++) writeFileSync(join(dir, `f${i}.md`), 'x')
    expect(() => store.write('one-more.md', 'x')).toThrow(expect.objectContaining({ code: 'too_many_files' }))
    expect(() => store.write('f0.md', 'still fine')).not.toThrow() // replacing an existing file is allowed
  })
})

describe('seedKnowledge', () => {
  it('copies the shipped files only into an empty folder', () => {
    const shipped = join(dir, 'shipped')
    const target = join(dir, 'data')
    new KnowledgeStore(shipped).write('acme.md', '# Acme\n\n## Prices\nCheap.\n')
    expect(seedKnowledge(target, shipped)).toBe(1)
    new KnowledgeStore(target).write('acme.md', '# Acme\n\n## Prices\nEdited.\n')
    expect(seedKnowledge(target, shipped)).toBe(0)
    expect(new KnowledgeStore(target).read('acme.md')).toContain('Edited.')
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -w apps/api -- test/knowledge-store.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `apps/api/src/agent/knowledgeStore.ts`**

```ts
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadKnowledge, type Passage } from './knowledge'

/** Lowercase letters, digits and dashes, ending in .md: no path separators, no hidden files. */
export const KNOWLEDGE_NAME = /^[a-z0-9][a-z0-9-]{0,62}\.md$/
export const MAX_KNOWLEDGE_BYTES = 100 * 1024
export const MAX_KNOWLEDGE_FILES = 50

export class KnowledgeError extends Error {
  constructor(readonly code: 'invalid_name' | 'too_large' | 'too_many_files', message: string) { super(message) }
}

export type KnowledgeFile = { name: string; bytes: number; updatedAt: string }

function checkName(name: string): void {
  if (!KNOWLEDGE_NAME.test(name)) throw new KnowledgeError('invalid_name', 'Use lowercase letters, digits and dashes, ending in .md')
}

/** The Markdown knowledge base on disk (spec §7: data/knowledge), with passages cached until the next write. */
export class KnowledgeStore {
  private cache: Passage[] | null = null
  constructor(readonly dir: string) {}

  passages(): Passage[] {
    this.cache ??= loadKnowledge(this.dir)
    return this.cache
  }

  list(): KnowledgeFile[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir).filter((f) => f.endsWith('.md')).sort().map((name) => this.info(name))
  }

  read(name: string): string | null {
    checkName(name)
    const file = join(this.dir, name)
    return existsSync(file) ? readFileSync(file, 'utf8') : null
  }

  /** Atomic replace (temp file + rename); line endings are normalized to \n. */
  write(name: string, content: string): KnowledgeFile {
    checkName(name)
    const text = content.replace(/\r\n/g, '\n')
    if (Buffer.byteLength(text, 'utf8') > MAX_KNOWLEDGE_BYTES) throw new KnowledgeError('too_large', `At most ${MAX_KNOWLEDGE_BYTES} bytes per file`)
    const file = join(this.dir, name)
    if (!existsSync(file) && this.list().length >= MAX_KNOWLEDGE_FILES) {
      throw new KnowledgeError('too_many_files', `At most ${MAX_KNOWLEDGE_FILES} files`)
    }
    mkdirSync(this.dir, { recursive: true })
    const tmp = join(this.dir, `.${name}.${process.pid}.tmp`)
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
    this.cache = null
    return this.info(name)
  }

  remove(name: string): boolean {
    checkName(name)
    const file = join(this.dir, name)
    if (!existsSync(file)) return false
    rmSync(file)
    this.cache = null
    return true
  }

  private info(name: string): KnowledgeFile {
    const s = statSync(join(this.dir, name))
    return { name, bytes: s.size, updatedAt: s.mtime.toISOString() }
  }
}

/** First start: copy the shipped example files into the (empty) data folder so the demo has a knowledge base. */
export function seedKnowledge(dir: string, shippedDir: string): number {
  mkdirSync(dir, { recursive: true })
  if (readdirSync(dir).some((f) => f.endsWith('.md'))) return 0
  if (!existsSync(shippedDir)) return 0
  const files = readdirSync(shippedDir).filter((f) => f.endsWith('.md'))
  for (const f of files) copyFileSync(join(shippedDir, f), join(dir, f))
  return files.length
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -w apps/api -- test/knowledge-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it in `apps/api/src/main.ts`**

Replace lines 35–36:

```ts
const knowledgeDir = env('RELAY_KNOWLEDGE_DIR') ?? fileURLToPath(new URL('../knowledge', import.meta.url))
const knowledge = loadKnowledge(knowledgeDir)
```

with:

```ts
// Editable copy in the data folder (a Docker volume); the files shipped in apps/api/knowledge seed it on first start.
const knowledgeDir = env('RELAY_KNOWLEDGE_DIR') ?? join(dirname(file), 'knowledge')
const seeded = seedKnowledge(knowledgeDir, fileURLToPath(new URL('../knowledge', import.meta.url)))
const knowledge = new KnowledgeStore(knowledgeDir)
```

Change the import `import { loadKnowledge } from './agent/knowledge'` to `import { KnowledgeStore, seedKnowledge } from './agent/knowledgeStore'`.
In `makeTurnRunner({...})` change `knowledge: () => knowledge` to `knowledge: () => knowledge.passages()`.
Change the startup log's `knowledge passages: ${knowledge.length}` to `knowledge: ${knowledge.list().length} files in ${knowledgeDir}${seeded ? ` (seeded ${seeded})` : ''}`.
Change `buildServer({ db, bus, channels }, { widget, mediaDir })` to `buildServer({ db, bus, channels }, { widget, mediaDir, knowledge })` (the option is added in Task 3; do this edit in Task 3 if you run the type check now).

- [ ] **Step 6: Type check and commit**

Run: `npm run typecheck -w apps/api` → no errors (leave the `buildServer` edit for Task 3).

```bash
git add apps/api/src/agent/knowledgeStore.ts apps/api/src/main.ts apps/api/test/knowledge-store.test.ts
git commit -m "feat(api): knowledge store in the data folder, seeded from the shipped examples

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Knowledge base API

**Files:**
- Create: `apps/api/src/agent/knowledgeRoutes.ts`
- Modify: `apps/api/src/server.ts`, `apps/api/src/http/errors.ts`, `apps/api/src/main.ts` (the `buildServer` call), `apps/api/test/helpers.ts`
- Test: `apps/api/test/knowledge-routes.test.ts` (create)

**Interfaces:**
- Consumes: `KnowledgeStore`, `KnowledgeError` (Task 2).
- Produces: `buildServer(deps, { widget?, mediaDir?, knowledge?: KnowledgeStore })`; `testServer({ fakeWidget?, knowledgeDir? })` returns also `knowledge?: KnowledgeStore`. Routes:
  - `GET /api/knowledge → { files: KnowledgeFile[] }`
  - `GET /api/knowledge/:name → { name, content }` or 404 `not_found`
  - `PUT /api/knowledge/:name` body `{ content: string }` → `{ file: KnowledgeFile }`
  - `DELETE /api/knowledge/:name → 204` or 404 `not_found`
  - `KnowledgeError` → `invalid_name` 400, `too_large` 413, `too_many_files` 409.

- [ ] **Step 1: Extend the test helper** — in `apps/api/test/helpers.ts` change the signature and the `buildServer` call:

```ts
import { KnowledgeStore } from '../src/agent/knowledgeStore'

export async function testServer(opts: { fakeWidget?: boolean; knowledgeDir?: string } = { fakeWidget: true }) {
  // ...unchanged lines...
  const knowledge = opts.knowledgeDir ? new KnowledgeStore(opts.knowledgeDir) : undefined
  const app = await buildServer(deps, { knowledge })
  // ...login unchanged...
  return { app, db, deps, sent, login, knowledge }
}
```

- [ ] **Step 2: Write the failing test** — `apps/api/test/knowledge-routes.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testServer } from './helpers'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'relay-kbr-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('knowledge routes', () => {
  it('require a session', async () => {
    const { app } = await testServer({ fakeWidget: true, knowledgeDir: dir })
    expect((await app.inject({ method: 'GET', url: '/api/knowledge' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'PUT', url: '/api/knowledge/a.md', payload: { content: 'x' } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'DELETE', url: '/api/knowledge/a.md' })).statusCode).toBe(401)
  })

  it('create, list, read, replace and delete a file; the agent sees the change', async () => {
    const { app, login, knowledge } = await testServer({ fakeWidget: true, knowledgeDir: dir })
    const headers = { cookie: await login() }
    const put = await app.inject({ method: 'PUT', url: '/api/knowledge/parking.md', headers, payload: { content: '# Parking\n\n## Garage\nFree for members.\n' } })
    expect(put.statusCode).toBe(200)
    expect(put.json().file.name).toBe('parking.md')
    expect(knowledge!.passages().map((p) => p.title)).toEqual(['Garage'])

    const list = await app.inject({ method: 'GET', url: '/api/knowledge', headers })
    expect(list.json().files.map((f: { name: string }) => f.name)).toEqual(['parking.md'])
    const one = await app.inject({ method: 'GET', url: '/api/knowledge/parking.md', headers })
    expect(one.json()).toEqual({ name: 'parking.md', content: '# Parking\n\n## Garage\nFree for members.\n' })

    const del = await app.inject({ method: 'DELETE', url: '/api/knowledge/parking.md', headers })
    expect(del.statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: '/api/knowledge/parking.md', headers })).json()).toEqual({ error: 'File not found', code: 'not_found' })
    expect((await app.inject({ method: 'DELETE', url: '/api/knowledge/parking.md', headers })).statusCode).toBe(404)
  })

  it('answer stable codes for bad names, big files and bad bodies', async () => {
    const { app, login } = await testServer({ fakeWidget: true, knowledgeDir: dir })
    const headers = { cookie: await login() }
    const badName = await app.inject({ method: 'PUT', url: '/api/knowledge/Notes.md', headers, payload: { content: 'x' } })
    expect(badName.statusCode).toBe(400)
    expect(badName.json().code).toBe('invalid_name')
    const encoded = await app.inject({ method: 'GET', url: '/api/knowledge/..%2Fsecret.md', headers })
    expect(encoded.statusCode).toBe(400)
    const big = await app.inject({ method: 'PUT', url: '/api/knowledge/big.md', headers, payload: { content: 'x'.repeat(100 * 1024 + 1) } })
    expect(big.statusCode).toBe(413)
    expect(big.json().code).toBe('too_large')
    const noContent = await app.inject({ method: 'PUT', url: '/api/knowledge/a.md', headers, payload: {} })
    expect(noContent.json().code).toBe('invalid_request')
  })
})
```

- [ ] **Step 3: Run it to see it fail**

Run: `npm test -w apps/api -- test/knowledge-routes.test.ts`
Expected: FAIL (routes return 404).

- [ ] **Step 4: Implement `apps/api/src/agent/knowledgeRoutes.ts`**

```ts
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
```

- [ ] **Step 5: Map `KnowledgeError` in `apps/api/src/http/errors.ts`**

Add `import { KnowledgeError } from '../agent/knowledgeStore'` and, before the `ZodError` branch:

```ts
    if (err instanceof KnowledgeError) {
      const status = err.code === 'invalid_name' ? 400 : err.code === 'too_large' ? 413 : 409
      return reply.code(status).send({ error: err.message, code: err.code })
    }
```

- [ ] **Step 6: Register in `apps/api/src/server.ts`**

```ts
import { knowledgeRoutes } from './agent/knowledgeRoutes'
import type { KnowledgeStore } from './agent/knowledgeStore'

export async function buildServer(
  deps: ServerDeps,
  opts: { widget?: WidgetChannel; mediaDir?: string; knowledge?: KnowledgeStore } = {},
): Promise<FastifyInstance> {
  // ...existing lines...
  if (opts.knowledge) knowledgeRoutes(app, deps.db, opts.knowledge)
  return app
}
```

And in `apps/api/src/main.ts` pass `knowledge` to `buildServer` (see Task 2, Step 5).

- [ ] **Step 7: Run tests and type check**

Run: `npm test -w apps/api -- test/knowledge-routes.test.ts test/inbox-routes.test.ts test/errors.test.ts` → PASS. `npm run typecheck -w apps/api` → no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/agent/knowledgeRoutes.ts apps/api/src/server.ts apps/api/src/http/errors.ts apps/api/src/main.ts apps/api/test/helpers.ts apps/api/test/knowledge-routes.test.ts
git commit -m "feat(api): knowledge base CRUD routes with stable error codes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Knowledge passages in the prompt for text-only models

**Files:**
- Modify: `apps/api/src/agent/providers/types.ts:13`, `apps/api/src/agent/engine.ts:20-25,107`
- Test: `apps/api/test/engine.test.ts` (append)

**Interfaces:**
- Consumes: `searchKnowledge(passages, query, limit)`.
- Produces: `Provider` gains `readonly textOnly?: boolean` (the Ollama provider already has a `textOnly` getter, so it satisfies this). Exported `KNOWLEDGE_HEADER = 'Knowledge base passages:'` from `engine.ts`.

- [ ] **Step 1: Write the failing test** — append to `apps/api/test/engine.test.ts` (it already builds `deps` with `KB` from the shipped knowledge in `beforeEach`; reuse its imports — `receiveInbound`, `runAgentTurn`, `EventBus` etc. — and add any that are missing at the top):

```ts
import { KNOWLEDGE_HEADER } from '../src/agent/engine'
import type { GenerateRequest, Provider } from '../src/agent/providers/types'

describe('text-only providers', () => {
  function capturing(textOnly: boolean) {
    const seen: GenerateRequest[] = []
    const provider: Provider = {
      id: 'fake', model: null, textOnly,
      async generate(req) { seen.push(req); return { kind: 'text', text: 'ok' } },
    }
    return { provider, seen }
  }

  it('get the passages that match the pending messages in the system prompt', async () => {
    const { provider, seen } = capturing(true)
    const { conversation } = receiveInbound(deps, { channel: 'widget', contactKey: 't-1', type: 'text', text: 'How much is a meeting room per hour?' })
    await runAgentTurn({ ...deps, provider }, conversation.id)
    expect(seen[0]!.system).toContain(KNOWLEDGE_HEADER)
    expect(seen[0]!.system).toContain('Meeting rooms')
    expect(seen[0]!.system).toContain('$20 per hour')
  })

  it('say so when nothing matched', async () => {
    const { provider, seen } = capturing(true)
    const { conversation } = receiveInbound(deps, { channel: 'widget', contactKey: 't-2', type: 'text', text: 'zzzz qqqq' })
    await runAgentTurn({ ...deps, provider }, conversation.id)
    expect(seen[0]!.system).toContain(`${KNOWLEDGE_HEADER} none matched`)
  })

  it('tool-capable providers keep using search_knowledge and get no passages', async () => {
    const { provider, seen } = capturing(false)
    const { conversation } = receiveInbound(deps, { channel: 'widget', contactKey: 't-3', type: 'text', text: 'How much is a meeting room per hour?' })
    await runAgentTurn({ ...deps, provider }, conversation.id)
    expect(seen[0]!.system).not.toContain(KNOWLEDGE_HEADER)
  })
})
```

(If `receiveInbound`'s input in this file needs `contactName`, pass `contactName: null`; copy the shape used by the existing tests in the same file.)

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -w apps/api -- test/engine.test.ts`
Expected: FAIL (`KNOWLEDGE_HEADER` is not exported; `textOnly` not in `Provider`).

- [ ] **Step 3: Implement**

`apps/api/src/agent/providers/types.ts` line 13:

```ts
export interface Provider {
  readonly id: string
  readonly model: string | null
  /** True when the model cannot call tools; the engine then puts knowledge passages in the prompt (spec §4). */
  readonly textOnly?: boolean
  generate(req: GenerateRequest): Promise<GenerateResult>
}
```

`apps/api/src/agent/engine.ts` — replace `RULES` (lines 20–25) with:

```ts
const RULES = [
  'Rules:',
  '- Use search_knowledge before answering questions about prices, plans, rooms, hours or the address. Never invent prices or facts.',
  '- If you cannot answer confidently, or the customer wants a human, a complaint, a cancellation or a refund, call transfer_to_human.',
  '- Reply in the language the customer writes in. Keep answers short.',
].join('\n')

/** For models without tools: facts come only from the passages below, and a person takes over what they do not cover. */
const TEXT_ONLY_RULES = [
  'Rules:',
  '- Answer questions about prices, plans, rooms, hours or the address only from the knowledge base passages below. Never invent prices or facts.',
  '- If the passages do not answer the question, say that a person from the team will follow up.',
  '- Reply in the language the customer writes in. Keep answers short.',
].join('\n')

export const KNOWLEDGE_HEADER = 'Knowledge base passages:'

function passagesBlock(passages: Passage[], query: string): string {
  const hits = searchKnowledge(passages, query)
  if (hits.length === 0) return `${KNOWLEDGE_HEADER} none matched.`
  return `${KNOWLEDGE_HEADER}\n\n${hits.map((h) => `### ${h.title}\n${h.text}`).join('\n\n')}`
}
```

and replace line 107 (`const system = ...`) with:

```ts
  const system = deps.provider.textOnly
    ? `${settings.instructions}\n\n${TEXT_ONLY_RULES}\n\n${passagesBlock(deps.knowledge(), pending.map(wordsOf).filter(Boolean).join(' '))}`
    : `${settings.instructions}\n\n${RULES}`
```

- [ ] **Step 4: Run tests and type check**

Run: `npm test -w apps/api -- test/engine.test.ts test/ollama-provider.test.ts test/providers-engine.test.ts` → PASS. `npm run typecheck -w apps/api` → no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/agent/providers/types.ts apps/api/src/agent/engine.ts apps/api/test/engine.test.ts
git commit -m "feat(agent): text-only models get the matching knowledge passages in the prompt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Paginate the conversation list

**Files:**
- Modify: `apps/api/src/core/conversations.ts:71-90`, `apps/api/src/core/routes.ts:9-26`
- Test: `apps/api/test/conversations.test.ts`, `apps/api/test/inbox-routes.test.ts` (append)

**Interfaces:**
- Produces: `listConversations(deps, filter, page?: { limit?: number; before?: Cursor }): { conversations: ConversationSummary[]; nextCursor: string | null }`; `type Cursor = { updatedAt: string; id: number }`; `encodeCursor(c): string`, `decodeCursor(s): Cursor | null` (base64url JSON). `GET /api/conversations?limit=1..100&before=<cursor>` → `{ conversations, nextCursor }`. Default `limit` 50. A malformed cursor → 400 `invalid_request`.

**Note:** `listConversations` currently returns an array. Find every caller with `grep -rn "listConversations" apps/api` and update them (expected: `core/routes.ts` and tests).

- [ ] **Step 1: Write the failing tests** — append to `apps/api/test/inbox-routes.test.ts`:

```ts
describe('conversation list pagination', () => {
  it('pages newest first with a cursor, and rejects a bad cursor', async () => {
    const { app, deps, login } = await testServer()
    const headers = { cookie: await login() }
    for (let i = 1; i <= 5; i++) receiveInbound(deps, { ...hello, contactKey: `v-${i}`, contactName: `C${i}` })
    const first = await app.inject({ method: 'GET', url: '/api/conversations?limit=2', headers })
    expect(first.json().conversations.map((c: { contactName: string }) => c.contactName)).toEqual(['C5', 'C4'])
    const cursor = first.json().nextCursor as string
    expect(cursor).toEqual(expect.any(String))
    const second = await app.inject({ method: 'GET', url: `/api/conversations?limit=2&before=${encodeURIComponent(cursor)}`, headers })
    expect(second.json().conversations.map((c: { contactName: string }) => c.contactName)).toEqual(['C3', 'C2'])
    const third = await app.inject({ method: 'GET', url: `/api/conversations?limit=2&before=${encodeURIComponent(second.json().nextCursor)}`, headers })
    expect(third.json()).toMatchObject({ nextCursor: null })
    expect(third.json().conversations).toHaveLength(1)
    const bad = await app.inject({ method: 'GET', url: '/api/conversations?before=nope', headers })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('invalid_request')
  })
})
```

If two conversations get the same `updatedAt` (same millisecond), the `id` tie-break keeps the order stable — the test above relies on it, so do not add sleeps.

Update existing calls in `apps/api/test/conversations.test.ts` that use the array result: `listConversations(...)` → `listConversations(...).conversations`.

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -w apps/api -- test/inbox-routes.test.ts test/conversations.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement in `apps/api/src/core/conversations.ts`**

Add `lt`, `or` to the `drizzle-orm` import, then replace `listConversations` with:

```ts
export type Cursor = { updatedAt: string; id: number }
export const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url')
export function decodeCursor(s: string): Cursor | null {
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
    return typeof v?.updatedAt === 'string' && Number.isInteger(v?.id) ? { updatedAt: v.updatedAt, id: v.id } : null
  } catch {
    return null
  }
}

export const DEFAULT_PAGE = 50

/** Newest first, `limit` per page; `before` continues after the last item of the previous page. */
export function listConversations(
  deps: CoreDeps,
  filter: { status?: Conversation['status']; assigneeId?: number },
  page: { limit?: number; before?: Cursor } = {},
): { conversations: ConversationSummary[]; nextCursor: string | null } {
  const limit = page.limit ?? DEFAULT_PAGE
  const where = and(
    filter.status ? eq(conversations.status, filter.status) : undefined,
    filter.assigneeId !== undefined ? eq(conversations.assigneeId, filter.assigneeId) : undefined,
    page.before
      ? or(lt(conversations.updatedAt, page.before.updatedAt),
        and(eq(conversations.updatedAt, page.before.updatedAt), lt(conversations.id, page.before.id)))
      : undefined,
  )
  const lastMessage = sql<string | null>`(
    SELECT coalesce(m.text, '[audio]') FROM messages m
    WHERE m.conversation_id = ${conversations.id} ORDER BY m.id DESC LIMIT 1)`
  const rows = deps.db.select({
    conversation: conversations, contactName: contacts.name, assigneeName: users.name, lastMessage,
  }).from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .leftJoin(users, eq(users.id, conversations.assigneeId))
    .where(where)
    .orderBy(desc(conversations.updatedAt), desc(conversations.id))
    .limit(limit + 1)
    .all()
    .map((r) => ({ ...r.conversation, contactName: r.contactName, assigneeName: r.assigneeName, lastMessage: r.lastMessage }))
  const more = rows.length > limit
  const items = more ? rows.slice(0, limit) : rows
  const last = items[items.length - 1]
  return { conversations: items, nextCursor: more && last ? encodeCursor({ updatedAt: last.updatedAt, id: last.id }) : null }
}
```

- [ ] **Step 4: Update the route in `apps/api/src/core/routes.ts`**

```ts
const ListQuery = z.object({
  status: z.enum(['open', 'waiting_human', 'closed']).optional(),
  mine: z.literal('1').optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.string().transform((s, ctx) => {
    const c = decodeCursor(s)
    if (!c) ctx.addIssue({ code: 'custom', message: 'bad cursor' })
    return c ?? undefined
  }).optional(),
})
```

and the handler:

```ts
  app.get('/api/conversations', { preHandler: requireUser }, async (req) => {
    const q = ListQuery.parse(req.query)
    return listConversations(deps,
      { status: q.status, assigneeId: q.mine ? req.user!.id : undefined },
      { limit: q.limit, before: q.before })
  })
```

Add `decodeCursor` to the import from `./conversations`.

- [ ] **Step 5: Run tests and type check**

Run: `npm test -w apps/api -- test/inbox-routes.test.ts test/conversations.test.ts` → PASS. `npm run typecheck -w apps/api` → no errors. Then run the whole API suite once: `npm test -w apps/api` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/core/conversations.ts apps/api/src/core/routes.ts apps/api/test/inbox-routes.test.ts apps/api/test/conversations.test.ts
git commit -m "feat(api): cursor pagination for the conversation list

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Web — API client, routing and the agent settings form

**Files:**
- Modify: `apps/web/src/api.ts`, `apps/web/src/App.tsx`, `apps/web/src/pages/Inbox.tsx` (topbar link only), `apps/web/src/styles.css`
- Create: `apps/web/src/pages/Settings.tsx`
- Test: `apps/web/test/Settings.test.tsx` (create)

**Interfaces:**
- Consumes: `GET/PUT /api/settings` (Task 1), knowledge routes (Task 3), paginated list (Task 5).
- Produces in `api.ts`:
  - `type Settings = { instructions: string; handoffKeywords: string[]; turnLimit: number; handoffMessage: string; transcriptionEnabled: boolean }`
  - `type KnowledgeFile = { name: string; bytes: number; updatedAt: string }`
  - `class ApiError { status: number; code: string; fields: string[] }`
  - `api.list(filter, page?: { before?: string; limit?: number }) → { conversations, nextCursor: string | null }`
  - `api.settings()`, `api.saveSettings(patch: Partial<Settings>)` → `{ settings }`
  - `api.knowledgeList() → { files }`, `api.knowledgeFile(name) → { name, content }`, `api.saveKnowledge(name, content) → { file }`, `api.deleteKnowledge(name) → void`
  - `SettingsPage({ onLogout })` renders the form and `<KnowledgeEditor onExpired={onLogout} />` (Task 7). Until Task 7 exists, render a placeholder `<section aria-label="Knowledge base" />`; Task 7 replaces it.

- [ ] **Step 1: Write the failing test** — `apps/web/test/Settings.test.tsx`

```tsx
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { vi } from 'vitest'

vi.mock('../src/api', async (orig) => {
  const actual = await orig<typeof import('../src/api')>()
  return {
    ...actual,
    api: {
      settings: vi.fn(), saveSettings: vi.fn(),
      knowledgeList: vi.fn(async () => ({ files: [] })), knowledgeFile: vi.fn(), saveKnowledge: vi.fn(), deleteKnowledge: vi.fn(),
    },
  }
})

import { api, ApiError } from '../src/api'
import { SettingsPage } from '../src/pages/Settings'

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>
const current = { instructions: 'Be nice.', handoffKeywords: ['human', 'humano'], turnLimit: 10, handoffMessage: 'Hold on.', transcriptionEnabled: true }

beforeEach(() => {
  vi.clearAllMocks()
  mocked.settings.mockResolvedValue({ settings: current })
  mocked.knowledgeList.mockResolvedValue({ files: [] })
})

describe('SettingsPage', () => {
  it('loads the settings and saves the edited values', async () => {
    mocked.saveSettings.mockImplementation(async (patch) => ({ settings: { ...current, ...patch } }))
    render(<SettingsPage onLogout={vi.fn()} />)
    const limit = await screen.findByLabelText(/turn limit/i)
    expect(screen.getByLabelText(/handoff keywords/i)).toHaveValue('human, humano')
    fireEvent.change(limit, { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText(/handoff keywords/i), { target: { value: 'human, , manager ' } })
    fireEvent.click(screen.getByLabelText(/transcribe voice messages/i))
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))
    await screen.findByText(/saved/i)
    expect(mocked.saveSettings).toHaveBeenCalledWith({
      instructions: 'Be nice.', handoffKeywords: ['human', 'manager'], turnLimit: 4, handoffMessage: 'Hold on.', transcriptionEnabled: false,
    })
  })

  it('marks the invalid fields when the API rejects the values', async () => {
    mocked.saveSettings.mockRejectedValue(new ApiError(400, 'invalid_request', ['turnLimit']))
    render(<SettingsPage onLogout={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /save settings/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/check the highlighted fields/i)
    expect(screen.getByLabelText(/turn limit/i)).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText(/instructions/i)).toHaveAttribute('aria-invalid', 'false')
  })

  it('does not save twice while a save is in flight', async () => {
    let resolve!: (v: unknown) => void
    mocked.saveSettings.mockReturnValue(new Promise((r) => { resolve = r }))
    render(<SettingsPage onLogout={vi.fn()} />)
    const button = await screen.findByRole('button', { name: /save settings/i })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(mocked.saveSettings).toHaveBeenCalledTimes(1)
    resolve({ settings: current })
    await waitFor(() => expect(button).not.toBeDisabled())
  })

  it('goes back to login on 401', async () => {
    mocked.settings.mockRejectedValue(new ApiError(401, 'unauthorized'))
    const onLogout = vi.fn()
    render(<SettingsPage onLogout={onLogout} />)
    await waitFor(() => expect(onLogout).toHaveBeenCalled())
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -w apps/web -- test/Settings.test.tsx`
Expected: FAIL (module `../src/pages/Settings` not found).

- [ ] **Step 3: Extend `apps/web/src/api.ts`**

Replace the `ApiError` class and the `call` error line:

```ts
export class ApiError extends Error {
  constructor(public status: number, public code: string, public fields: string[] = []) { super(code) }
}
```

```ts
  if (!res.ok) throw new ApiError(res.status, body.code ?? 'error', Array.isArray(body.fields) ? body.fields : [])
```

Add types:

```ts
export type Settings = { instructions: string; handoffKeywords: string[]; turnLimit: number; handoffMessage: string; transcriptionEnabled: boolean }
export type KnowledgeFile = { name: string; bytes: number; updatedAt: string }
```

Add a `put`/`del` helper next to `post`:

```ts
const put = <T>(path: string, body: unknown) => call<T>(path, { method: 'PUT', body: JSON.stringify(body) })
const del = (path: string) => call<void>(path, { method: 'DELETE' })
```

Replace `api.list` and add the new calls:

```ts
  list: (filter: Filter, page: { before?: string; limit?: number } = {}) => {
    const q = new URLSearchParams(FILTER_QUERY[filter].replace(/^\?/, ''))
    if (page.before) q.set('before', page.before)
    if (page.limit) q.set('limit', String(page.limit))
    const qs = q.toString()
    return call<{ conversations: ConversationSummary[]; nextCursor: string | null }>(`/api/conversations${qs ? `?${qs}` : ''}`)
  },
  settings: () => call<{ settings: Settings }>('/api/settings'),
  saveSettings: (patch: Partial<Settings>) => put<{ settings: Settings }>('/api/settings', patch),
  knowledgeList: () => call<{ files: KnowledgeFile[] }>('/api/knowledge'),
  knowledgeFile: (name: string) => call<{ name: string; content: string }>(`/api/knowledge/${encodeURIComponent(name)}`),
  saveKnowledge: (name: string, content: string) => put<{ file: KnowledgeFile }>(`/api/knowledge/${encodeURIComponent(name)}`, { content }),
  deleteKnowledge: (name: string) => del(`/api/knowledge/${encodeURIComponent(name)}`),
```

- [ ] **Step 4: Create `apps/web/src/pages/Settings.tsx`**

```tsx
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, ApiError, type Settings } from '../api'
import { KnowledgeEditor } from '../components/KnowledgeEditor'

type Form = { instructions: string; keywords: string; turnLimit: string; handoffMessage: string; transcriptionEnabled: boolean }
type Status = 'loading' | 'idle' | 'saving' | 'saved' | 'invalid' | 'error'

const toForm = (s: Settings): Form => ({
  instructions: s.instructions, keywords: s.handoffKeywords.join(', '), turnLimit: String(s.turnLimit),
  handoffMessage: s.handoffMessage, transcriptionEnabled: s.transcriptionEnabled,
})
const fromForm = (f: Form): Settings => ({
  instructions: f.instructions,
  handoffKeywords: f.keywords.split(',').map((k) => k.trim()).filter(Boolean),
  turnLimit: Number(f.turnLimit),
  handoffMessage: f.handoffMessage,
  transcriptionEnabled: f.transcriptionEnabled,
})

export function SettingsPage({ onLogout }: { onLogout: () => void }) {
  const [form, setForm] = useState<Form | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [invalid, setInvalid] = useState<string[]>([])
  const saving = useRef(false)

  const expired = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) { onLogout(); return true }
    return false
  }

  useEffect(() => {
    api.settings().then((r) => { setForm(toForm(r.settings)); setStatus('idle') }, (err) => { if (!expired(err)) setStatus('error') })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!form || saving.current) return
    saving.current = true
    setStatus('saving')
    setInvalid([])
    try {
      const r = await api.saveSettings(fromForm(form))
      setForm(toForm(r.settings))
      setStatus('saved')
    } catch (err) {
      if (expired(err)) return
      if (err instanceof ApiError && err.code === 'invalid_request') { setInvalid(err.fields); setStatus('invalid') } else setStatus('error')
    } finally {
      saving.current = false
    }
  }

  const set = <K extends keyof Form>(k: K, v: Form[K]) => { setForm((f) => (f ? { ...f, [k]: v } : f)); if (status === 'saved') setStatus('idle') }
  const bad = (field: keyof Settings) => invalid.includes(field)

  return (
    <div className="settings">
      <header className="topbar">
        <strong>Relay</strong>
        <a href="/">Inbox</a>
        <span>Settings</span>
      </header>
      {status === 'loading' && <p className="empty">Loading…</p>}
      {status === 'error' && !form && <p role="alert" className="error">Could not load the settings.</p>}
      {form && (
        <form className="settings-form" onSubmit={save}>
          <h2>Agent</h2>
          <label>Instructions
            <textarea rows={6} value={form.instructions} aria-invalid={bad('instructions')} onChange={(e) => set('instructions', e.target.value)} />
          </label>
          <label>Handoff keywords (comma-separated)
            <input value={form.keywords} aria-invalid={bad('handoffKeywords')} onChange={(e) => set('keywords', e.target.value)} />
          </label>
          <label>Turn limit
            <input type="number" min={1} max={100} value={form.turnLimit} aria-invalid={bad('turnLimit')} onChange={(e) => set('turnLimit', e.target.value)} />
          </label>
          <label>Handoff message
            <textarea rows={2} value={form.handoffMessage} aria-invalid={bad('handoffMessage')} onChange={(e) => set('handoffMessage', e.target.value)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={form.transcriptionEnabled} onChange={(e) => set('transcriptionEnabled', e.target.checked)} />
            Transcribe voice messages
          </label>
          <div className="settings-actions">
            <button type="submit" disabled={status === 'saving'}>Save settings</button>
            {status === 'saved' && <span className="muted" role="status">Saved</span>}
            {status === 'invalid' && <p role="alert" className="error">Check the highlighted fields.</p>}
            {status === 'error' && <p role="alert" className="error">Could not save. Try again.</p>}
          </div>
        </form>
      )}
      <KnowledgeEditor onExpired={onLogout} />
    </div>
  )
}
```

Until Task 7, create a minimal `apps/web/src/components/KnowledgeEditor.tsx` so this compiles:

```tsx
export function KnowledgeEditor(_props: { onExpired: () => void }) {
  return <section aria-label="Knowledge base" />
}
```

- [ ] **Step 5: Route `/settings` in `apps/web/src/App.tsx`**

```tsx
import { SettingsPage } from './pages/Settings'
// ...
  if (user === null) return <Login onLoggedIn={setUser} />
  if (location.pathname.startsWith('/settings')) return <SettingsPage onLogout={() => setUser(null)} />
  return <Inbox user={user} onLogout={() => setUser(null)} />
```

(nginx already falls back to `index.html` for unknown paths, and Vite does in dev.)

In `apps/web/src/pages/Inbox.tsx`, in the topbar after `<strong>Relay</strong>`, add `<a href="/settings">Settings</a>`.

- [ ] **Step 6: Styles** — append to `apps/web/src/styles.css`:

```css
textarea { font: inherit; padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--text); resize: vertical; }
[aria-invalid='true'] { border-color: #dc2626; }
.topbar a { color: var(--accent); }
.settings { max-width: 960px; margin: 0 auto; padding-bottom: 48px; }
.settings-form, .kb { display: flex; flex-direction: column; gap: 12px; padding: 12px; }
.settings-form label { display: flex; flex-direction: column; gap: 4px; }
.settings-form label.check { flex-direction: row; align-items: center; gap: 8px; }
.settings-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
```

- [ ] **Step 7: Run tests and type check**

Run: `npm test -w apps/web -- test/Settings.test.tsx test/Inbox.test.tsx` → `Settings` PASS. `Inbox.test.tsx` mocks `api.list` returning `{ conversations }` without `nextCursor`; it still passes because the Inbox does not read `nextCursor` until Task 8. Then `npm run typecheck -w apps/web` → no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/api.ts apps/web/src/App.tsx apps/web/src/pages/Settings.tsx apps/web/src/components/KnowledgeEditor.tsx apps/web/src/pages/Inbox.tsx apps/web/src/styles.css apps/web/test/Settings.test.tsx
git commit -m "feat(web): settings page for the agent, with field-level validation errors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Web — knowledge base editor

**Files:**
- Modify: `apps/web/src/components/KnowledgeEditor.tsx` (replace the placeholder)
- Test: `apps/web/test/KnowledgeEditor.test.tsx` (create)

**Interfaces:**
- Consumes: `api.knowledgeList`, `api.knowledgeFile`, `api.saveKnowledge`, `api.deleteKnowledge`, `ApiError` (Task 6).
- Produces: `KnowledgeEditor({ onExpired })`.

Behavior: lists files; clicking one loads it into a textarea; **Save file** writes it; **New file** takes a name (`.md` appended when missing, must match `^[a-z0-9][a-z0-9-]{0,62}\.md$`), opens an empty editor that is created on first save; **Delete** asks `window.confirm` first. Switching files with unsaved changes asks `window.confirm('Discard unsaved changes?')`. Errors: `invalid_name` → "Use lowercase letters, digits and dashes.", `too_large` → "The file is too large (100 KB max).", `too_many_files` → "Too many files (50 max).", other → "Could not save. Try again."

- [ ] **Step 1: Write the failing test** — `apps/web/test/KnowledgeEditor.test.tsx`

```tsx
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { vi } from 'vitest'

vi.mock('../src/api', async (orig) => {
  const actual = await orig<typeof import('../src/api')>()
  return { ...actual, api: { knowledgeList: vi.fn(), knowledgeFile: vi.fn(), saveKnowledge: vi.fn(), deleteKnowledge: vi.fn() } }
})

import { api, ApiError } from '../src/api'
import { KnowledgeEditor } from '../src/components/KnowledgeEditor'

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>
const file = (name: string) => ({ name, bytes: 10, updatedAt: '2026-11-12T10:00:00Z' })

beforeEach(() => {
  vi.clearAllMocks()
  mocked.knowledgeList.mockResolvedValue({ files: [file('acme-coworking.md')] })
  mocked.knowledgeFile.mockResolvedValue({ name: 'acme-coworking.md', content: '# Acme\n' })
  mocked.saveKnowledge.mockImplementation(async (name: string) => ({ file: file(name) }))
  mocked.deleteKnowledge.mockResolvedValue(undefined)
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

describe('KnowledgeEditor', () => {
  it('opens a file, edits and saves it', async () => {
    render(<KnowledgeEditor onExpired={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'acme-coworking.md' }))
    const editor = await screen.findByLabelText(/content of acme-coworking.md/i)
    expect(editor).toHaveValue('# Acme\n')
    fireEvent.change(editor, { target: { value: '# Acme\n\n## Parking\nFree.\n' } })
    fireEvent.click(screen.getByRole('button', { name: /save file/i }))
    await screen.findByText(/saved/i)
    expect(mocked.saveKnowledge).toHaveBeenCalledWith('acme-coworking.md', '# Acme\n\n## Parking\nFree.\n')
  })

  it('creates a new file, adding .md, and rejects bad names locally', async () => {
    render(<KnowledgeEditor onExpired={vi.fn()} />)
    const name = await screen.findByLabelText(/new file name/i)
    fireEvent.change(name, { target: { value: 'Bad Name' } })
    fireEvent.click(screen.getByRole('button', { name: /new file/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/lowercase letters, digits and dashes/i)
    fireEvent.change(name, { target: { value: 'parking' } })
    fireEvent.click(screen.getByRole('button', { name: /new file/i }))
    const editor = await screen.findByLabelText(/content of parking.md/i)
    fireEvent.change(editor, { target: { value: '# Parking\n' } })
    fireEvent.click(screen.getByRole('button', { name: /save file/i }))
    await waitFor(() => expect(mocked.saveKnowledge).toHaveBeenCalledWith('parking.md', '# Parking\n'))
    await waitFor(() => expect(mocked.knowledgeList).toHaveBeenCalledTimes(2))
  })

  it('deletes after confirming', async () => {
    render(<KnowledgeEditor onExpired={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'acme-coworking.md' }))
    await screen.findByLabelText(/content of acme-coworking.md/i)
    fireEvent.click(screen.getByRole('button', { name: /delete/i }))
    await waitFor(() => expect(mocked.deleteKnowledge).toHaveBeenCalledWith('acme-coworking.md'))
    expect(window.confirm).toHaveBeenCalled()
  })

  it('shows the API reason when a save is rejected', async () => {
    mocked.saveKnowledge.mockRejectedValue(new ApiError(413, 'too_large'))
    render(<KnowledgeEditor onExpired={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'acme-coworking.md' }))
    await screen.findByLabelText(/content of acme-coworking.md/i)
    fireEvent.click(screen.getByRole('button', { name: /save file/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/too large/i)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -w apps/web -- test/KnowledgeEditor.test.tsx`
Expected: FAIL (placeholder renders nothing).

- [ ] **Step 3: Implement `apps/web/src/components/KnowledgeEditor.tsx`**

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, type KnowledgeFile } from '../api'

const NAME = /^[a-z0-9][a-z0-9-]{0,62}\.md$/
const MESSAGES: Record<string, string> = {
  invalid_name: 'Use lowercase letters, digits and dashes.',
  too_large: 'The file is too large (100 KB max).',
  too_many_files: 'Too many files (50 max).',
}

type Open = { name: string; content: string; saved: string; isNew: boolean }

export function KnowledgeEditor({ onExpired }: { onExpired: () => void }) {
  const [files, setFiles] = useState<KnowledgeFile[]>([])
  const [open, setOpen] = useState<Open | null>(null)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const busy = useRef(false)

  const fail = useCallback((err: unknown, fallback: string) => {
    if (err instanceof ApiError && err.status === 401) { onExpired(); return }
    setError(err instanceof ApiError ? MESSAGES[err.code] ?? fallback : fallback)
  }, [onExpired])

  const refresh = useCallback(async () => {
    try { setFiles((await api.knowledgeList()).files) } catch (err) { fail(err, 'Could not load the knowledge base.') }
  }, [fail])
  useEffect(() => { void refresh() }, [refresh])

  const dirty = open !== null && open.content !== open.saved
  const leave = () => !dirty || window.confirm('Discard unsaved changes?')

  async function select(name: string) {
    if (open?.name === name || !leave()) return
    setError(null); setStatus('idle')
    try {
      const f = await api.knowledgeFile(name)
      setOpen({ name: f.name, content: f.content, saved: f.content, isNew: false })
    } catch (err) { fail(err, 'Could not open the file.') }
  }

  function create() {
    const raw = newName.trim().toLowerCase().endsWith('.md') ? newName.trim() : `${newName.trim()}.md`
    if (!NAME.test(raw)) { setError(MESSAGES.invalid_name!); return }
    if (!leave()) return
    setError(null); setStatus('idle'); setNewName('')
    setOpen({ name: raw, content: '', saved: '', isNew: true })
  }

  async function save() {
    if (!open || busy.current) return
    busy.current = true
    setStatus('saving'); setError(null)
    const { name, content } = open
    try {
      await api.saveKnowledge(name, content)
      setOpen((o) => (o && o.name === name ? { ...o, saved: content, isNew: false } : o))
      setStatus('saved')
      await refresh()
    } catch (err) {
      setStatus('idle')
      fail(err, 'Could not save. Try again.')
    } finally {
      busy.current = false
    }
  }

  async function remove() {
    if (!open || busy.current || !window.confirm(`Delete ${open.name}?`)) return
    busy.current = true
    try {
      if (!open.isNew) await api.deleteKnowledge(open.name)
      setOpen(null); setStatus('idle')
      await refresh()
    } catch (err) {
      fail(err, 'Could not delete. Try again.')
    } finally {
      busy.current = false
    }
  }

  return (
    <section className="kb" aria-label="Knowledge base">
      <h2>Knowledge base</h2>
      <p className="muted">Markdown files. Each <code>## heading</code> is one passage the agent can find.</p>
      <div className="kb-grid">
        <ul className="kb-files">
          {files.map((f) => (
            <li key={f.name}>
              <button type="button" aria-pressed={open?.name === f.name} onClick={() => void select(f.name)}>{f.name}</button>
            </li>
          ))}
          {files.length === 0 && <li className="muted">No files yet</li>}
        </ul>
        <div className="kb-editor">
          {open ? (
            <>
              <label>
                {`Content of ${open.name}`}
                <textarea rows={18} value={open.content} onChange={(e) => { const v = e.target.value; setOpen((o) => (o ? { ...o, content: v } : o)); setStatus('idle') }} />
              </label>
              <div className="settings-actions">
                <button type="button" onClick={() => void save()} disabled={status === 'saving'}>Save file</button>
                <button type="button" onClick={() => void remove()}>Delete</button>
                {status === 'saved' && <span className="muted" role="status">Saved</span>}
                {dirty && <span className="muted">Unsaved changes</span>}
              </div>
            </>
          ) : <p className="empty">Select a file or create one.</p>}
        </div>
      </div>
      <div className="settings-actions">
        <label>New file name <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="parking" /></label>
        <button type="button" onClick={create}>New file</button>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
    </section>
  )
}
```

Note the accessible name of the "New file" button is exactly "New file" and the label is "New file name"; the test uses `getByRole('button', { name: /new file/i })`, which matches only the button (labels are not buttons).

- [ ] **Step 4: Styles** — append to `apps/web/src/styles.css`:

```css
.kb-grid { display: grid; grid-template-columns: 220px 1fr; gap: 12px; }
.kb-files { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.kb-files button { width: 100%; text-align: left; }
.kb-files button[aria-pressed='true'] { border-color: var(--accent); }
.kb-editor label { display: flex; flex-direction: column; gap: 4px; }
.kb-editor textarea { font-family: ui-monospace, monospace; }
@media (max-width: 700px) { .kb-grid { grid-template-columns: 1fr; } }
```

- [ ] **Step 5: Run tests and type check**

Run: `npm test -w apps/web -- test/KnowledgeEditor.test.tsx test/Settings.test.tsx` → PASS. `npm run typecheck -w apps/web` → no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/KnowledgeEditor.tsx apps/web/src/styles.css apps/web/test/KnowledgeEditor.test.tsx
git commit -m "feat(web): knowledge base editor on the settings page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Web — inbox UX, pagination, login and demo credentials

**Files:**
- Create: `apps/web/src/demo.ts`
- Modify: `apps/web/src/pages/Inbox.tsx`, `apps/web/src/components/Timeline.tsx`, `apps/web/src/pages/Login.tsx`, `apps/web/src/pages/Demo.tsx`
- Test: `apps/web/test/Inbox.test.tsx`, `apps/web/test/Timeline.test.tsx` (append), `apps/web/test/Login.test.tsx`, `apps/web/test/Demo.test.tsx` (create)

**Interfaces:**
- Consumes: `api.list(filter, page) → { conversations, nextCursor }` (Task 6).
- Produces: `DEMO_CREDENTIALS = { email: 'demo@relay.dev', password: 'relay-demo' }` in `apps/web/src/demo.ts` (must match `DEMO_USER` in `apps/api/src/db/seed.ts`).

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/test/Inbox.test.tsx` (inside `describe('Inbox', ...)`):

```tsx
  it('sends a reply once even when submitted twice quickly', async () => {
    let resolve!: (v: unknown) => void
    mocked.reply.mockReturnValue(new Promise((r) => { resolve = r }))
    await openFirst()
    const input = screen.getByPlaceholderText(/reply as the team/i)
    fireEvent.change(input, { target: { value: 'once' } })
    fireEvent.submit(input.closest('form')!)
    fireEvent.submit(input.closest('form')!)
    expect(mocked.reply).toHaveBeenCalledTimes(1)
    await act(async () => { resolve({ message: { ...detail(1, 'Ana').messages[0]!, id: 998, sender: 'user', text: 'once' } }) })
  })

  it('keeps a newer draft typed while the reply was in flight', async () => {
    let resolve!: (v: unknown) => void
    mocked.reply.mockReturnValue(new Promise((r) => { resolve = r }))
    await openFirst()
    const input = screen.getByPlaceholderText(/reply as the team/i)
    fireEvent.change(input, { target: { value: 'first' } })
    fireEvent.submit(input.closest('form')!)
    fireEvent.change(input, { target: { value: 'second thought' } })
    await act(async () => { resolve({ message: { ...detail(1, 'Ana').messages[0]!, id: 997, sender: 'user', text: 'first' } }) })
    expect(input).toHaveValue('second thought')
  })

  it('labels the reply box and marks the active filter', async () => {
    await openFirst()
    expect(screen.getByLabelText(/^reply$/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Closed' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('loads more conversations with the cursor', async () => {
    mocked.list.mockImplementation(async (_f: string, page?: { before?: string }) => page?.before
      ? { conversations: [summary(3, 'Cid')], nextCursor: null }
      : { conversations: [summary(1, 'Ana'), summary(2, 'Bob')], nextCursor: 'c1' })
    render(<Inbox user={user} onLogout={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /load more/i }))
    expect(await screen.findByRole('button', { name: /Cid/ })).toBeInTheDocument()
    expect(mocked.list).toHaveBeenLastCalledWith('all', { before: 'c1' })
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument()
  })
```

Also change the `beforeEach` default to `mocked.list.mockResolvedValue({ conversations: [summary(1, 'Ana'), summary(2, 'Bob')], nextCursor: null })`.

Append to `apps/web/test/Timeline.test.tsx`:

```tsx
it('scrolls to the newest message when one arrives', () => {
  const msg = (id: number) => ({ id, conversationId: 1, sender: 'contact' as const, userId: null, type: 'text' as const, text: `m${id}`, mediaPath: null, mediaMime: null, transcription: null, createdAt: '2026-11-12T10:00:00Z' })
  const { container, rerender } = render(<Timeline messages={[msg(1)]} />)
  const list = container.querySelector('ol')!
  Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 500 })
  rerender(<Timeline messages={[msg(1), msg(2)]} />)
  expect(list.scrollTop).toBe(500)
})
```

(Match the imports already present in `Timeline.test.tsx`; add `render` if missing.)

Create `apps/web/test/Login.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { vi } from 'vitest'

vi.mock('../src/api', async (orig) => {
  const actual = await orig<typeof import('../src/api')>()
  return { ...actual, api: { login: vi.fn() } }
})

import { api } from '../src/api'
import { Login } from '../src/pages/Login'

it('disables the button while signing in', async () => {
  let resolve!: (v: unknown) => void
  ;(api.login as ReturnType<typeof vi.fn>).mockReturnValue(new Promise((r) => { resolve = r }))
  render(<Login onLoggedIn={vi.fn()} />)
  const button = screen.getByRole('button', { name: /sign in/i })
  fireEvent.click(button)
  expect(button).toBeDisabled()
  await act(async () => { resolve({ user: { id: 1, email: 'demo@relay.dev', name: 'Demo' } }) })
})
```

Create `apps/web/test/Demo.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { vi } from 'vitest'

vi.mock('../src/components/Widget', () => ({ Widget: () => null }))
import { Demo } from '../src/pages/Demo'

it('shows the demo credentials', () => {
  render(<Demo />)
  expect(screen.getByText('demo@relay.dev')).toBeInTheDocument()
  expect(screen.getByText('relay-demo')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -w apps/web -- test/Inbox.test.tsx test/Timeline.test.tsx test/Login.test.tsx test/Demo.test.tsx`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement**

`apps/web/src/demo.ts`:

```ts
/** The seeded demo account (apps/api/src/db/seed.ts DEMO_USER); shown on /demo and pre-filled on the login form. */
export const DEMO_CREDENTIALS = { email: 'demo@relay.dev', password: 'relay-demo' } as const
```

`apps/web/src/pages/Login.tsx`: import `DEMO_CREDENTIALS`, initialise the two fields from it, add `const [submitting, setSubmitting] = useState(false)`; in `submit`, `if (submitting) return; setSubmitting(true)` before the `try` and `finally { setSubmitting(false) }` after the `catch`; render `<button type="submit" disabled={submitting}>Sign in</button>`.

`apps/web/src/pages/Demo.tsx`: replace the `<main>` paragraph about the inbox with:

```tsx
        <p>Open the <a href="/">inbox</a> in another tab, sign in, and chat here.</p>
        <p className="demo-credentials">
          Demo sign-in: <code>{DEMO_CREDENTIALS.email}</code> / <code>{DEMO_CREDENTIALS.password}</code>
        </p>
```

with `import { DEMO_CREDENTIALS } from '../demo'`.

`apps/web/src/components/Timeline.tsx`: add a ref and an effect:

```tsx
import { useEffect, useRef } from 'react'
// ...
export function Timeline({ messages }: { messages: Message[] }) {
  const list = useRef<HTMLOListElement>(null)
  // Follow the conversation: jump to the newest message whenever one is added.
  useEffect(() => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length])
  return (
    <ol className="timeline" ref={list}>
```

`apps/web/src/pages/Inbox.tsx`:

1. State: add `const [nextCursor, setNextCursor] = useState<string | null>(null)` and `const [sending, setSending] = useState(false)`, plus `const sendingRef = useRef(false)`.
2. `refreshList`: refresh at least as many rows as are loaded, so a live refresh does not drop pages the user opened:

```ts
  const itemsCountRef = useRef(0)
  itemsCountRef.current = items.length
  const refreshList = useCallback(async () => {
    const wanted = filter
    try {
      const limit = Math.min(100, Math.max(50, itemsCountRef.current))
      const r = await api.list(wanted, limit > 50 ? { limit } : {})
      if (filterRef.current === wanted) { setItems(r.conversations); setNextCursor(r.nextCursor) }
    } catch (err) { expired(err) }
  }, [filter, expired])
```

   (With the default 50 the call is `api.list(wanted, {})`; the existing tests that assert `api.list` calls must accept the second argument — update `toHaveBeenCalledWith('all')` to `toHaveBeenCalledWith('all', {})` if any exists.)
3. Load more:

```ts
  async function loadMore() {
    const wanted = filter
    if (!nextCursor) return
    try {
      const r = await api.list(wanted, { before: nextCursor })
      if (filterRef.current !== wanted) return
      setItems((xs) => [...xs, ...r.conversations.filter((c) => !xs.some((x) => x.id === c.id))])
      setNextCursor(r.nextCursor)
    } catch (err) { expired(err) }
  }
```

   Render after `<ConversationList …/>`: `{nextCursor && <button className="load-more" onClick={() => void loadMore()}>Load more</button>}`.
4. Filters: `<button key={f} className={…} aria-pressed={f === filter} onClick={…}>`.
5. `send`:

```ts
  async function send(e: FormEvent) {
    e.preventDefault()
    const text = draft.trim()
    const id = selectedId
    if (!id || !text || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setReplyError(false)
    try {
      const { message } = await api.reply(id, text)
      if (selectedRef.current !== id) return
      setDraft((d) => (d.trim() === text ? '' : d)) // keep anything typed while the reply was in flight
      setDetail((d) => d && d.conversation.id === id && !d.messages.some((m) => m.id === message.id)
        ? { ...d, messages: [...d.messages, message] } : d)
    } catch (err) {
      if (!expired(err) && selectedRef.current === id) setReplyError(true)
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }
```

6. Reply form: `<input aria-label="Reply" … />` and `<button type="submit" disabled={sending}>Send</button>`.

Append to `apps/web/src/styles.css`: `.load-more { margin: 8px; } .demo-credentials code { padding: 1px 4px; border-radius: 4px; background: var(--line); }`

- [ ] **Step 4: Run tests and type check**

Run: `npm test -w apps/web` → all PASS. `npm run typecheck -w apps/web` → no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src apps/web/test
git commit -m "feat(web): reply in-flight guard, newer drafts kept, auto-scroll, a11y, load more, demo credentials

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Docs, follow-ups and a manual run

**Files:**
- Modify: `docs/superpowers/plans/followups-after-plan-1.md`, `docs/superpowers/specs/2026-11-10-relay-design.md` (§7, §9, §10 if needed), `README.md`

- [ ] **Step 1: Follow-ups** — in `followups-after-plan-1.md`, rename `## Plan 5 — settings and knowledge base` to `## Done in plan 5` and reword each item in the past tense (typed settings with `GET/PUT /api/settings`; validation errors are `invalid_request` with `fields`; inbox UX items; demo credentials on `/demo`; cursor pagination; passages in the prompt for text-only models). Add under it: `- Knowledge base editable from Settings; files live in data/knowledge (seeded from apps/api/knowledge on first start).`

- [ ] **Step 2: Spec** — §7: change "The knowledge base lives in `data/knowledge/*.md`, editable from the settings screen." to also say "seeded from `apps/api/knowledge` on first start; names are lowercase `a-z0-9-` ending in `.md`, at most 50 files of 100 KB". §10: add "Validation errors also list the offending `fields`."

- [ ] **Step 3: README** — run `grep -n "RELAY_KNOWLEDGE_DIR\|knowledge" README.md`. In the configuration table/section, set `RELAY_KNOWLEDGE_DIR` default to `<folder of RELAY_DB>/knowledge` (`/data/knowledge` in Docker) and mention it is editable from **Settings**. If the README lists screens or a roadmap, mark "Agent settings and knowledge base editor" as done.

- [ ] **Step 4: Full checks**

Run: `npm run typecheck && npm test`
Expected: both workspaces pass.

- [ ] **Step 5: Manual run (no Docker)**

```bash
RELAY_DB=$(mktemp -d)/relay.db npm run dev:api   # terminal 1: log shows "knowledge: 1 files in …/knowledge (seeded 1)"
npm run dev:web                                    # terminal 2
```

Open http://localhost:5173, sign in, click **Settings**: change the turn limit, save, reload — the value stays. Open `acme-coworking.md`, add `## Parking\nFree for members.`, save. On http://localhost:5173/demo ask "Is there parking?" — the demo agent answers from the new passage. Stop both servers.

- [ ] **Step 6: Commit**

```bash
git add docs README.md
git commit -m "docs: plan-5 follow-ups, knowledge folder and settings in spec and README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec §9 "Agent settings: instructions, handoff keywords, turn limit, handoff message, transcription on/off, knowledge base editor" → Tasks 1, 6, 7.
- Spec §7 `data/knowledge` → Task 2. Spec §4 "Knowledge base passages relevant to the latest message" for text-only → Task 4.
- Follow-ups plan 5: typed settings (T1), unified codes (T1), inbox UX (T8), demo credentials (T8), pagination (T5, T8), Ollama passages (T4).
- Out of scope here (plan 6): i18n, CI, Playwright, rate limits, Docker healthchecks.
