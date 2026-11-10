# Relay — Plan 2: agent engine with the demo provider

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a customer writes and nobody from the team has the conversation, an AI agent answers on its own — searching the knowledge base, tagging, or handing off to a human — with every turn logged and visible in the inbox. With no configuration it runs on a scripted demo provider.

**Architecture:** A per-conversation `AgentQueue` listens to `message.created` on the event bus and runs `runAgentTurn` serially per conversation. The engine applies the reply rules from spec §4, builds the prompt, calls a `Provider` (only the demo provider in this plan; Claude and Ollama arrive in plan 3), executes tool calls in a bounded loop, then replies or hands off through a single outbound path, and writes an `agent_runs` row it broadcasts on the bus. The inbox shows an "Agent activity" panel.

**Tech Stack:** unchanged from plan 1 (Fastify 5, Drizzle + better-sqlite3, zod v4, Vitest; React 19 + Vite).

Spec: `docs/superpowers/specs/2026-11-10-relay-design.md` §4 (agent), §10 (error handling). Follow-ups pulled in: the "Plan 2" section and the spec note of `docs/superpowers/plans/followups-after-plan-1.md`.

## Global Constraints

- Code, identifiers, comments and docs in English. ESM; TypeScript `strict: true`.
- Timestamps are ISO-8601 strings. API errors return `{ error: string, code: string }`.
- Conversation status exactly `open | waiting_human | closed`; message sender exactly `contact | agent | user | system`; `agent_runs.outcome` exactly `replied | transferred | failed`.
- The agent replies only when: conversation is `open`, has no assignee, and there is at least one `contact` message after the last message from anyone else. Turn limit default 10 (`agent.turnLimit`); reaching it hands off.
- Handoff = status `waiting_human` + `handoffReason` + the configured `agent.handoffMessage` sent to the customer as an `agent` message. The customer is never left without an answer: provider error, timeout or empty reply all hand off.
- Tools exactly: `search_knowledge(query)`, `transfer_to_human(reason)`, `tag_conversation(tags)`.
- History sent to the provider: last 20 messages. Tool rounds per turn: at most 3. Provider timeout default 30 000 ms.
- Every turn that is not skipped writes exactly one `agent_runs` row and emits `agent.run.created`.
- Sample knowledge base content is fictional ("Acme Coworking"). No employer data anywhere.
- Every commit message ends with a `Co-Authored-By:` trailer naming the model that wrote the commit.

## File structure

```
apps/api/
  knowledge/acme-coworking.md        fictional sample knowledge base (shipped)
  src/core/conversations.ts          MODIFY: transactions, postOutbound, ConflictError, addTags, handBack resets turns
  src/core/types.ts                  MODIFY: AgentRun type
  src/core/events.ts                 MODIFY: 'agent.run.created' event
  src/core/settings.ts               NEW: typed agent settings
  src/core/routes.ts                 MODIFY: GET /api/conversations/:id/agent-runs
  src/http/errors.ts                 MODIFY: ConflictError -> 409
  src/realtime/inbox.ts              MODIFY: forward 'agent.run.created'
  src/agent/knowledge.ts             NEW: load Markdown passages + BM25 search
  src/agent/providers/types.ts       NEW: Provider interface and chat types
  src/agent/providers/demo.ts        NEW: scripted demo provider
  src/agent/providers/index.ts       NEW: selectProvider(env)
  src/agent/tools.ts                 NEW: tool specs + executor
  src/agent/runs.ts                  NEW: recordRun / listRuns
  src/agent/engine.ts                NEW: runAgentTurn
  src/agent/queue.ts                 NEW: AgentQueue
  src/main.ts                        MODIFY: wire provider, knowledge, queue, graceful shutdown
apps/web/src/
  api.ts                             MODIFY: AgentRun, agentRuns(), InboxFrame
  live.ts                            MODIFY: generic frame type
  components/AgentActivity.tsx       NEW
  pages/Inbox.tsx                    MODIFY: runs panel, debounced list refresh, typed frames
docs/superpowers/specs/2026-11-10-relay-design.md   MODIFY: §6 channel contract
```

---

### Task 1: Outbound path, transactions and status rules

**Files:**
- Modify: `apps/api/src/core/conversations.ts`, `apps/api/src/http/errors.ts`, `docs/superpowers/specs/2026-11-10-relay-design.md`
- Test: `apps/api/test/conversations.test.ts` (extend), `apps/api/test/inbox-routes.test.ts` (extend)

**Interfaces:**
- Produces (in `core/conversations.ts`):
  - `class ConflictError extends Error { code: string }` — constructor `(code: string, message: string)`.
  - `type OutboundInput = { sender: 'agent' | 'user' | 'system'; userId?: number; text: string }`
  - `postOutbound(deps: CoreDeps, id: number, input: OutboundInput, changes?: Partial<Conversation>): Promise<Message>` — throws `NotFoundError` / `ConflictError('conversation_closed', ...)`; inserts the message and applies `changes` + `updatedAt` in ONE transaction; emits `message.created` then `conversation.updated`; then delivers through the channel; a delivery failure is logged (`console.error('[relay] delivery failed', channel, err)`) and does NOT throw.
  - `teamReply(deps, id, userId, text)` keeps its signature and delegates to `postOutbound`.
  - `assign` on a closed conversation throws `ConflictError('conversation_closed', 'Conversation is closed')`.
  - `handBack` also resets `agentTurns` to 0.
  - `addTags(deps: CoreDeps, id: number, tags: string[]): Conversation` — merges (unique, lowercase, trimmed, 1–30 chars each, at most 10 total) and emits `conversation.updated`.
  - `receiveInbound` runs its writes in one transaction and emits after commit (same return value and events as before).
- `errors.ts` maps `ConflictError` → 409 `{ error: err.message, code: err.code }`.

Note on transactions: with better-sqlite3, `db.transaction(cb)` is synchronous and runs on the same connection, so queries made through `deps.db` inside `cb` are part of the transaction. Never `await` inside `cb`, and never emit bus events inside it.

- [ ] **Step 1: Failing tests**

Append to `apps/api/test/conversations.test.ts` (inside the existing file, reusing its `deps`, `sent` and `hello`):
```ts
import { ConflictError, postOutbound, addTags } from '../src/core/conversations'

describe('outbound path and status rules', () => {
  it('postOutbound stores an agent message, applies changes atomically and delivers it', async () => {
    const { conversation } = receiveInbound(deps, hello)
    const events: string[] = []
    deps.bus.on('message.created', () => events.push('message.created'))
    deps.bus.on('conversation.updated', () => events.push('conversation.updated'))
    const msg = await postOutbound(deps, conversation.id, { sender: 'agent', text: 'Hello from the agent' }, { agentTurns: 1 })
    expect(msg).toMatchObject({ sender: 'agent', userId: null, text: 'Hello from the agent' })
    expect(getConversation(deps, conversation.id)!.conversation.agentTurns).toBe(1)
    expect(events).toEqual(['message.created', 'conversation.updated'])
    expect(sent).toHaveBeenCalledTimes(1)
  })

  it('a delivery failure is logged, not thrown, and the message stays stored once', async () => {
    const { conversation } = receiveInbound(deps, hello)
    sent.mockRejectedValueOnce(new Error('socket gone'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(postOutbound(deps, conversation.id, { sender: 'agent', text: 'x' })).resolves.toMatchObject({ text: 'x' })
      expect(spy).toHaveBeenCalledWith('[relay] delivery failed', 'widget', expect.any(Error))
      expect(getConversation(deps, conversation.id)!.messages.filter((m) => m.text === 'x')).toHaveLength(1)
    } finally { spy.mockRestore() }
  })

  it('replying to or assigning a closed conversation is a 409-style ConflictError', async () => {
    const { conversation } = receiveInbound(deps, hello)
    close(deps, conversation.id)
    await expect(teamReply(deps, conversation.id, 1, 'late')).rejects.toBeInstanceOf(ConflictError)
    expect(() => assign(deps, conversation.id, 1)).toThrow(ConflictError)
  })

  it('handBack resets the agent turn counter', async () => {
    const { conversation } = receiveInbound(deps, hello)
    await postOutbound(deps, conversation.id, { sender: 'agent', text: 'a' }, { agentTurns: 7 })
    assign(deps, conversation.id, 1)
    expect(handBack(deps, conversation.id).agentTurns).toBe(0)
  })

  it('addTags merges, normalizes and caps tags', () => {
    const { conversation } = receiveInbound(deps, hello)
    addTags(deps, conversation.id, ['Pricing', ' pricing ', 'virtual-office', ''])
    const c = addTags(deps, conversation.id, ['x'.repeat(31), 'meeting-room'])
    expect(c.tags).toEqual(['pricing', 'virtual-office', 'meeting-room'])
  })

  it('NotFoundError for close, handBack and teamReply on an unknown id', async () => {
    expect(() => close(deps, 999)).toThrow(NotFoundError)
    expect(() => handBack(deps, 999)).toThrow(NotFoundError)
    await expect(teamReply(deps, 999, 1, 'x')).rejects.toBeInstanceOf(NotFoundError)
  })
})
```

Append to `apps/api/test/inbox-routes.test.ts`:
```ts
it('replying to a closed conversation answers 409 conversation_closed', async () => {
  const { app, deps, login } = await testServer()
  const cookie = await login()
  const { conversation } = receiveInbound(deps, hello)
  await app.inject({ method: 'POST', url: `/api/conversations/${conversation.id}/close`, headers: { cookie } })
  const res = await app.inject({ method: 'POST', url: `/api/conversations/${conversation.id}/messages`, headers: { cookie }, payload: { text: 'late' } })
  expect(res.statusCode).toBe(409)
  expect(res.json()).toEqual({ error: 'Conversation is closed', code: 'conversation_closed' })
})
```

Run: `npm test -w apps/api` → FAIL (missing exports).

- [ ] **Step 2: Implement in `core/conversations.ts`**

Add the error class and outbound path; rewrite `receiveInbound`, `assign`, `handBack`, `teamReply` and add `addTags`. Keep every other export unchanged.

```ts
export class ConflictError extends Error {
  constructor(public code: string, message: string) { super(message) }
}

export type OutboundInput = { sender: 'agent' | 'user' | 'system'; userId?: number; text: string }

export function receiveInbound(deps: CoreDeps, msg: InboundMessage): { conversation: Conversation; message: Message } {
  const { conversation, message } = deps.db.transaction(() => {
    const contact = findOrCreateContact(deps.db, msg)
    const existing = currentConversation(deps.db, contact.id)
    const conv = existing ?? deps.db.insert(conversations).values({
      contactId: contact.id, channel: msg.channel, status: 'open', createdAt: now(), updatedAt: now(),
    }).returning().get()
    const message = deps.db.insert(messages).values({
      conversationId: conv.id, sender: 'contact', type: msg.type, text: msg.text ?? null,
      mediaPath: msg.mediaPath ?? null, mediaMime: msg.mediaMime ?? null, createdAt: now(),
    }).returning().get()
    const conversation = deps.db.update(conversations).set({ updatedAt: now() })
      .where(eq(conversations.id, conv.id)).returning().get()!
    return { conversation, message }
  })
  deps.bus.emit('message.created', { conversationId: conversation.id, message })
  deps.bus.emit('conversation.updated', { conversation })
  return { conversation, message }
}

export function assign(deps: CoreDeps, id: number, userId: number): Conversation {
  const current = deps.db.select().from(conversations).where(eq(conversations.id, id)).get()
  if (!current) throw new NotFoundError('Conversation')
  if (current.status === 'closed') throw new ConflictError('conversation_closed', 'Conversation is closed')
  return touch(deps, id, { assigneeId: userId, status: 'open' })
}

export function handBack(deps: CoreDeps, id: number): Conversation {
  return touch(deps, id, { assigneeId: null, status: 'open', handoffReason: null, agentTurns: 0 })
}

export async function postOutbound(
  deps: CoreDeps, id: number, input: OutboundInput, changes: Partial<Conversation> = {},
): Promise<Message> {
  const found = getConversation(deps, id)
  if (!found) throw new NotFoundError('Conversation')
  if (found.conversation.status === 'closed') throw new ConflictError('conversation_closed', 'Conversation is closed')
  const { message, conversation } = deps.db.transaction(() => {
    const message = deps.db.insert(messages).values({
      conversationId: id, sender: input.sender, userId: input.userId ?? null, type: 'text', text: input.text, createdAt: now(),
    }).returning().get()
    const conversation = deps.db.update(conversations).set({ ...changes, updatedAt: now() })
      .where(eq(conversations.id, id)).returning().get()!
    return { message, conversation }
  })
  deps.bus.emit('message.created', { conversationId: id, message })
  deps.bus.emit('conversation.updated', { conversation })
  try {
    await deps.channels.get(conversation.channel)?.send({ conversation, contact: found.contact }, message)
  } catch (err) {
    // The message is stored and visible in the inbox; a retry must not create a duplicate.
    console.error('[relay] delivery failed', conversation.channel, err)
  }
  return message
}

export function teamReply(deps: CoreDeps, id: number, userId: number, text: string): Promise<Message> {
  return postOutbound(deps, id, { sender: 'user', userId, text })
}

export function addTags(deps: CoreDeps, id: number, tags: string[]): Conversation {
  const current = deps.db.select().from(conversations).where(eq(conversations.id, id)).get()
  if (!current) throw new NotFoundError('Conversation')
  const merged = [...current.tags]
  for (const raw of tags) {
    const tag = String(raw).trim().toLowerCase()
    if (tag.length < 1 || tag.length > 30 || merged.includes(tag)) continue
    merged.push(tag)
  }
  return touch(deps, id, { tags: merged.slice(0, 10) })
}
```

Delete the old `teamReply` body (it is replaced above) and remove the now-unused emit inside the old `receiveInbound`.

`apps/api/src/http/errors.ts` — add before the NotFound line:
```ts
import { ConflictError, NotFoundError } from '../core/conversations'
// ...
    if (err instanceof ConflictError) return reply.code(409).send({ error: err.message, code: err.code })
```

- [ ] **Step 3: Spec update (§6)**

In `docs/superpowers/specs/2026-11-10-relay-design.md` section 6, replace the `interface Channel` block with:
```ts
interface Channel {
  id: 'widget' | 'whatsapp'
  send(target: { conversation: Conversation; contact: Contact }, message: Message): Promise<void>
}
```
and add one sentence below it: "All outbound messages (team, agent, system) go through one core function, `postOutbound`, which stores the message, then delivers it; a delivery failure is logged and never creates a duplicate."

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -w apps/api` → PASS. `npm run typecheck -w apps/api` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api docs/superpowers/specs/2026-11-10-relay-design.md
git commit -m "feat(api): single outbound path, transactions and conversation status rules"
```
(end the message with the Co-Authored-By trailer)

---

### Task 2: Typed agent settings and the knowledge base

**Files:**
- Create: `apps/api/src/core/settings.ts`, `apps/api/src/agent/knowledge.ts`, `apps/api/knowledge/acme-coworking.md`
- Test: `apps/api/test/settings.test.ts`, `apps/api/test/knowledge.test.ts`

**Interfaces:**
- Produces:
  - `type AgentSettings = { instructions: string; handoffKeywords: string[]; turnLimit: number; handoffMessage: string }`
  - `agentSettings(db: Db): AgentSettings` — reads the `settings` rows; any missing or invalid value falls back to `DEFAULT_SETTINGS`.
  - `type Passage = { source: string; title: string; text: string }`
  - `loadKnowledge(dir: string): Passage[]` — every `*.md` file in `dir` (sorted by name), split into passages at `## ` headings; returns `[]` if `dir` does not exist.
  - `tokenize(text: string): string[]` — lowercase, accents removed, `[a-z0-9]+` tokens, drops 1-char tokens and stopwords.
  - `searchKnowledge(passages: Passage[], query: string, limit = 3): Passage[]` — BM25 (k1 = 1.2, b = 0.75) over `title + text`; only passages with score > 0, best first.

- [ ] **Step 1: Failing tests**

`apps/api/test/settings.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDb } from '../src/db/client'
import { seed } from '../src/db/seed'
import { settings } from '../src/db/schema'
import { agentSettings } from '../src/core/settings'

describe('agentSettings', () => {
  it('reads the seeded defaults', async () => {
    const db = createDb(':memory:')
    await seed(db)
    expect(agentSettings(db)).toMatchObject({ turnLimit: 10, handoffKeywords: ['human', 'agent', 'atendente', 'humano'] })
  })

  it('falls back to the default for an invalid stored value', async () => {
    const db = createDb(':memory:')
    await seed(db)
    db.update(settings).set({ value: 'not a number' }).where(eq(settings.key, 'agent.turnLimit')).run()
    expect(agentSettings(db).turnLimit).toBe(10)
  })
})
```

`apps/api/test/knowledge.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadKnowledge, searchKnowledge, tokenize } from '../src/agent/knowledge'

const SHIPPED = fileURLToPath(new URL('../knowledge', import.meta.url))

describe('knowledge base', () => {
  it('tokenize lowercases, strips accents and stopwords', () => {
    expect(tokenize('Qual é o PREÇO da sala de reunião?')).toEqual(['qual', 'preco', 'sala', 'reuniao'])
  })

  it('splits Markdown into passages by ## heading', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-'))
    writeFileSync(join(dir, 'a.md'), '# Acme\nIntro line\n\n## Prices\nDesk is 25 a day\n\n## Hours\nOpen 8 to 20\n')
    const passages = loadKnowledge(dir)
    expect(passages.map((p) => p.title)).toEqual(['Acme', 'Prices', 'Hours'])
    expect(passages[1]).toEqual({ source: 'a.md', title: 'Prices', text: 'Desk is 25 a day' })
  })

  it('a missing directory is an empty knowledge base', () => {
    expect(loadKnowledge(join(tmpdir(), 'does-not-exist-relay'))).toEqual([])
  })

  it('finds the right passage in the shipped sample, best first', () => {
    const passages = loadKnowledge(SHIPPED)
    expect(searchKnowledge(passages, 'how much is a meeting room?')[0]!.title).toBe('Meeting rooms')
    expect(searchKnowledge(passages, 'what time do you open on saturday')[0]!.title).toBe('Opening hours')
    expect(searchKnowledge(passages, 'quantum entanglement')).toEqual([])
  })
})
```

Run: `npm test -w apps/api` → FAIL.

- [ ] **Step 2: Settings**

`apps/api/src/core/settings.ts`:
```ts
import { z } from 'zod'
import type { Db } from '../db/client'
import { settings } from '../db/schema'
import { DEFAULT_SETTINGS } from '../db/seed'

export type AgentSettings = { instructions: string; handoffKeywords: string[]; turnLimit: number; handoffMessage: string }

const FIELDS = {
  instructions: ['agent.instructions', z.string().min(1)],
  handoffKeywords: ['agent.handoffKeywords', z.array(z.string().min(1)).max(50)],
  turnLimit: ['agent.turnLimit', z.number().int().min(1).max(100)],
  handoffMessage: ['agent.handoffMessage', z.string().min(1)],
} as const

export function agentSettings(db: Db): AgentSettings {
  const stored = new Map(db.select().from(settings).all().map((r) => [r.key, r.value]))
  const out: Record<string, unknown> = {}
  for (const [field, [key, schema]] of Object.entries(FIELDS)) {
    const parsed = schema.safeParse(stored.get(key))
    out[field] = parsed.success ? parsed.data : DEFAULT_SETTINGS[key]
  }
  return out as AgentSettings
}
```

- [ ] **Step 3: Knowledge base**

`apps/api/src/agent/knowledge.ts`:
```ts
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type Passage = { source: string; title: string; text: string }

const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'are', 'is', 'do', 'does', 'what', 'how', 'can', 'of', 'to', 'in', 'on', 'it', 'an', 'or', 'me', 'my', 'we', 'our',
  'de', 'da', 'do', 'das', 'dos', 'que', 'em', 'um', 'uma', 'para', 'com', 'por', 'os', 'as', 'no', 'na', 'se', 'eu', 'voce',
])

export function tokenize(text: string): string[] {
  const plain = text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  return (plain.match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

export function loadKnowledge(dir: string): Passage[] {
  if (!existsSync(dir)) return []
  const out: Passage[] = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const content = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n')
    const [head, ...sections] = content.split(/^## /m)
    const h1 = head!.match(/^# (.+)$/m)
    const intro = head!.replace(/^# .+$/m, '').trim()
    if (intro) out.push({ source: file, title: h1 ? h1[1]!.trim() : file.replace(/\.md$/, ''), text: intro })
    for (const section of sections) {
      const [titleLine, ...body] = section.split('\n')
      const text = body.join('\n').trim()
      if (text) out.push({ source: file, title: titleLine!.trim(), text })
    }
  }
  return out
}

export function searchKnowledge(passages: Passage[], query: string, limit = 3): Passage[] {
  const terms = [...new Set(tokenize(query))]
  if (terms.length === 0 || passages.length === 0) return []
  const docs = passages.map((p) => tokenize(`${p.title} ${p.text}`))
  const avgLen = docs.reduce((s, d) => s + d.length, 0) / docs.length
  const df = new Map(terms.map((t) => [t, docs.filter((d) => d.includes(t)).length]))
  const k1 = 1.2
  const b = 0.75
  return passages
    .map((p, i) => {
      const doc = docs[i]!
      let score = 0
      for (const t of terms) {
        const tf = doc.filter((x) => x === t).length
        if (tf === 0) continue
        const n = df.get(t)!
        const idf = Math.log(1 + (passages.length - n + 0.5) / (n + 0.5))
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / avgLen)))
      }
      return { p, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, z) => z.score - a.score)
    .slice(0, limit)
    .map((x) => x.p)
}
```

- [ ] **Step 4: Sample knowledge base**

`apps/api/knowledge/acme-coworking.md` (fictional company):
```markdown
# Acme Coworking

Acme Coworking is a fictional coworking space used to demo Relay. All names, prices and addresses here are made up.

## Plans and prices

- Day pass (hot desk): $25 per day.
- Fixed desk: $290 per month, with a locker.
- Private office for 2 to 4 people: from $890 per month.
- Virtual office: $49 per month (business address and mail handling).

## Meeting rooms

Meeting rooms cost $20 per hour. The small room seats 4 people and the large room seats 8. Members on a fixed desk or private office plan get 2 free hours per month. Book at the front desk or by message.

## Opening hours

Monday to Friday from 8:00 to 20:00, and Saturday from 9:00 to 13:00. Closed on Sundays and public holidays. Members with a fixed desk or private office have 24/7 access with their card.

## Virtual office

The virtual office gives your company a business address at Acme Coworking. We receive your mail, notify you by email the same day and keep it for 30 days. Mail scanning costs $2 per letter.

## Location

100 Example Street, Springfield. Five minutes from Central Station. Bike parking is free; car parking is not available.
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test -w apps/api` → PASS. `npm run typecheck -w apps/api` → clean. If a ranking assertion in the shipped-sample test fails, adjust the sample text (never the algorithm) so each question's best passage is the intended one, and say so in the report.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat(api): typed agent settings and Markdown knowledge base with BM25 search"
```

---

### Task 3: Provider interface and the scripted demo provider

**Files:**
- Create: `apps/api/src/agent/providers/types.ts`, `apps/api/src/agent/providers/demo.ts`, `apps/api/src/agent/providers/index.ts`, `apps/api/src/agent/tools.ts`
- Test: `apps/api/test/demo-provider.test.ts`

**Interfaces:**
- Produces (`providers/types.ts`):
```ts
export type ToolCall = { id: string; name: string; input: Record<string, unknown> }
export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string }
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> }
export type Usage = { inputTokens?: number; outputTokens?: number }
export type GenerateRequest = { system: string; messages: ChatMessage[]; tools: ToolSpec[]; signal?: AbortSignal }
export type GenerateResult =
  | { kind: 'text'; text: string; usage?: Usage }
  | { kind: 'tool_calls'; calls: ToolCall[]; text?: string; usage?: Usage }
export interface Provider { readonly id: string; readonly model: string | null; generate(req: GenerateRequest): Promise<GenerateResult> }
```
- `tools.ts`: `TOOL_SPECS: ToolSpec[]` (the three tools, JSON-schema parameters) and `NO_RESULTS = 'NO_RESULTS'`; search results are returned to the model as `JSON.stringify(passages.map(({ title, text }) => ({ title, text })))` or `NO_RESULTS`.
- `providers/demo.ts`: `class DemoProvider implements Provider` (`id: 'demo'`, `model: 'scripted'`).
- `providers/index.ts`: `selectProvider(env: NodeJS.ProcessEnv): Provider` — plan 2 always returns `new DemoProvider()`; if `RELAY_PROVIDER` is set to anything other than `demo`, log `console.warn('[relay] provider "<x>" is not available yet; using the demo provider')` once.

Demo script (deterministic, decided on the conversation's last non-tool message and the last tool result):
1. Last message is a `tool` result of `search_knowledge`:
   - content `NO_RESULTS` → `tool_calls`: `transfer_to_human({ reason: 'No answer in the knowledge base' })`
   - otherwise → `text`: `Here is what I found about "<title of first passage>":\n\n<text of first passage>` (passage text cut at 600 chars with `…`).
2. Last `user` message (lowercased, accents removed):
   - is a greeting with ≤ 4 words (`hi`, `hello`, `hey`, `oi`, `ola`, `bom dia`, `boa tarde`, `boa noite`) → `text`: `Hi! I'm the Acme Coworking assistant. Ask me about plans, prices, meeting rooms, opening hours or the virtual office.`
   - mentions `complain`, `complaint`, `refund`, `cancel`, `reclamacao`, `reembolso` or `cancelar` → `tool_calls`: `transfer_to_human({ reason: 'Customer wants to complain, cancel or get a refund' })`
   - otherwise → `tool_calls`: `search_knowledge({ query: <the user message as written> })`
3. No user message at all → `text`: the greeting above.
Tool call ids are `demo-<messages.length>`.

- [ ] **Step 1: Failing test**

`apps/api/test/demo-provider.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { DemoProvider } from '../src/agent/providers/demo'
import { selectProvider } from '../src/agent/providers'
import { TOOL_SPECS, NO_RESULTS } from '../src/agent/tools'
import type { ChatMessage } from '../src/agent/providers/types'

const p = new DemoProvider()
const run = (messages: ChatMessage[]) => p.generate({ system: 's', messages, tools: TOOL_SPECS })

describe('DemoProvider', () => {
  it('greets', async () => {
    expect(await run([{ role: 'user', content: 'Olá!' }])).toMatchObject({ kind: 'text', text: expect.stringMatching(/^Hi! I'm the Acme Coworking assistant/) })
  })

  it('searches the knowledge base for a question', async () => {
    expect(await run([{ role: 'user', content: 'How much is a meeting room?' }])).toEqual({
      kind: 'tool_calls', calls: [{ id: 'demo-1', name: 'search_knowledge', input: { query: 'How much is a meeting room?' } }],
    })
  })

  it('answers from the first passage after a search', async () => {
    const r = await run([
      { role: 'user', content: 'price?' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'demo-1', name: 'search_knowledge', input: { query: 'price?' } }] },
      { role: 'tool', toolCallId: 'demo-1', name: 'search_knowledge', content: JSON.stringify([{ title: 'Plans and prices', text: 'Day pass: $25' }]) },
    ])
    expect(r).toEqual({ kind: 'text', text: 'Here is what I found about "Plans and prices":\n\nDay pass: $25' })
  })

  it('hands off when the search found nothing, or on a complaint', async () => {
    const none = await run([
      { role: 'user', content: 'quantum?' },
      { role: 'tool', toolCallId: 'demo-1', name: 'search_knowledge', content: NO_RESULTS },
    ])
    expect(none).toMatchObject({ kind: 'tool_calls', calls: [{ name: 'transfer_to_human', input: { reason: 'No answer in the knowledge base' } }] })
    const complaint = await run([{ role: 'user', content: 'Quero cancelar meu plano' }])
    expect(complaint).toMatchObject({ kind: 'tool_calls', calls: [{ name: 'transfer_to_human' }] })
  })

  it('selectProvider falls back to demo and warns once for an unknown provider', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(selectProvider({}).id).toBe('demo')
      expect(selectProvider({ RELAY_PROVIDER: 'claude' }).id).toBe('demo')
      selectProvider({ RELAY_PROVIDER: 'claude' })
      expect(warn).toHaveBeenCalledTimes(1)
    } finally { warn.mockRestore() }
  })

  it('TOOL_SPECS declares exactly the three tools', () => {
    expect(TOOL_SPECS.map((t) => t.name)).toEqual(['search_knowledge', 'transfer_to_human', 'tag_conversation'])
  })
})
```

Run: `npm test -w apps/api` → FAIL.

- [ ] **Step 2: Types and tool specs**

`apps/api/src/agent/providers/types.ts`: exactly the block in Interfaces above.

`apps/api/src/agent/tools.ts`:
```ts
import type { ToolSpec } from './providers/types'

export const NO_RESULTS = 'NO_RESULTS'

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'search_knowledge',
    description: 'Search the company knowledge base (prices, plans, rooms, opening hours, address). Use it before answering factual questions.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to look for' } }, required: ['query'] },
  },
  {
    name: 'transfer_to_human',
    description: 'Hand the conversation to a person from the team. Use it when the customer asks for a human, when you cannot answer confidently, or for complaints, cancellations and refunds.',
    parameters: { type: 'object', properties: { reason: { type: 'string', description: 'Short reason shown to the team' } }, required: ['reason'] },
  },
  {
    name: 'tag_conversation',
    description: 'Add short lowercase tags that describe the conversation, such as "pricing" or "virtual-office".',
    parameters: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' }, maxItems: 5 } }, required: ['tags'] },
  },
]
```

- [ ] **Step 3: Demo provider and selection**

`apps/api/src/agent/providers/demo.ts`:
```ts
import { NO_RESULTS } from '../tools'
import type { ChatMessage, GenerateRequest, GenerateResult, Provider } from './types'

const GREETING = "Hi! I'm the Acme Coworking assistant. Ask me about plans, prices, meeting rooms, opening hours or the virtual office."
const GREETINGS = /^(hi|hello|hey|oi|ola|bom dia|boa tarde|boa noite)\b/
const HANDOFF_WORDS = /\b(complain|complaint|refund|cancel|reclamacao|reembolso|cancelar)\b/

const plain = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()

/** Scripted provider: shows the whole agent flow (answer, search, handoff) with no API key. */
export class DemoProvider implements Provider {
  readonly id = 'demo'
  readonly model = 'scripted'

  async generate({ messages }: GenerateRequest): Promise<GenerateResult> {
    const id = `demo-${messages.length}`
    const last = messages.at(-1)
    if (last?.role === 'tool' && last.name === 'search_knowledge') {
      if (last.content === NO_RESULTS) {
        return { kind: 'tool_calls', calls: [{ id, name: 'transfer_to_human', input: { reason: 'No answer in the knowledge base' } }] }
      }
      const [first] = JSON.parse(last.content) as Array<{ title: string; text: string }>
      const text = first!.text.length > 600 ? `${first!.text.slice(0, 600)}…` : first!.text
      return { kind: 'text', text: `Here is what I found about "${first!.title}":\n\n${text}` }
    }
    const user = [...messages].reverse().find((m): m is Extract<ChatMessage, { role: 'user' }> => m.role === 'user')
    if (!user) return { kind: 'text', text: GREETING }
    const q = plain(user.content)
    if (GREETINGS.test(q) && q.split(/\s+/).length <= 4) return { kind: 'text', text: GREETING }
    if (HANDOFF_WORDS.test(q)) {
      return { kind: 'tool_calls', calls: [{ id, name: 'transfer_to_human', input: { reason: 'Customer wants to complain, cancel or get a refund' } }] }
    }
    return { kind: 'tool_calls', calls: [{ id, name: 'search_knowledge', input: { query: user.content } }] }
  }
}
```

`apps/api/src/agent/providers/index.ts`:
```ts
import { DemoProvider } from './demo'
import type { Provider } from './types'

let warned = false

/** Plan 2 ships only the demo provider; Claude and Ollama are added in plan 3. */
export function selectProvider(env: NodeJS.ProcessEnv): Provider {
  const wanted = env.RELAY_PROVIDER
  if (wanted && wanted !== 'demo' && !warned) {
    warned = true
    console.warn(`[relay] provider "${wanted}" is not available yet; using the demo provider`)
  }
  return new DemoProvider()
}
```

- [ ] **Step 4: Run tests and typecheck, then commit**

Run: `npm test -w apps/api` → PASS. `npm run typecheck -w apps/api` → clean.
```bash
git add apps/api
git commit -m "feat(api): provider interface, tool specs and scripted demo provider"
```

---

### Task 4: Agent engine and run log

**Files:**
- Create: `apps/api/src/agent/runs.ts`, `apps/api/src/agent/engine.ts`
- Modify: `apps/api/src/core/types.ts`, `apps/api/src/core/events.ts`
- Test: `apps/api/test/engine.test.ts`

**Interfaces:**
- Consumes: `postOutbound`, `addTags`, `getConversation`, `CoreDeps` (Task 1); `agentSettings` (Task 2); `searchKnowledge`, `Passage` (Task 2); `Provider`, `ChatMessage`, `TOOL_SPECS`, `NO_RESULTS` (Task 3).
- Produces:
  - `core/types.ts`: `export type AgentRun = typeof agentRuns.$inferSelect`
  - `core/events.ts`: event `'agent.run.created': { conversationId: number; run: AgentRun }`
  - `agent/runs.ts`: `recordRun(deps: CoreDeps, row: Omit<typeof agentRuns.$inferInsert, 'id' | 'createdAt'>): AgentRun` (inserts, emits `agent.run.created`); `listRuns(db: Db, conversationId: number, limit = 50): AgentRun[]` (newest first).
  - `agent/engine.ts`:
    - `type EngineDeps = CoreDeps & { provider: Provider; knowledge: () => Passage[]; timeoutMs?: number }`
    - `HISTORY_LIMIT = 20`, `MAX_TOOL_ROUNDS = 3`, `DEFAULT_TIMEOUT_MS = 30_000`
    - `runAgentTurn(deps: EngineDeps, conversationId: number): Promise<{ outcome: 'replied' | 'transferred' | 'failed' | 'skipped'; run?: AgentRun }>`
    - `handOff(deps: CoreDeps, conversationId: number, reason: string, message: string): Promise<void>`

Engine algorithm (implement exactly):
1. Load the conversation. Return `skipped` (no run) if it does not exist, is not `open`, or has an assignee.
2. `pending` = `contact` messages after the last message whose sender is not `contact`. If empty → `skipped`.
3. `settings = agentSettings(db)`; start a timer.
4. If `agentTurns >= turnLimit` → `handOff(reason 'Turn limit reached')`, run `transferred`.
5. If any pending message's text contains a handoff keyword (case/accent-insensitive whole word) → `handOff(reason 'Customer asked for a human')`, run `transferred`.
6. Build `system` = settings.instructions + a fixed rules paragraph (use the knowledge base, never invent prices, transfer when unsure, reply in the customer's language) and `chat` = last `HISTORY_LIMIT` messages mapped: `contact` → `{ role: 'user', content }`; `agent`/`user`/`system` → `{ role: 'assistant', content }`; audio content = `[customer audio, transcribed] <text>` when `transcription.status === 'ok'`, else `[audio]`.
7. Up to `MAX_TOOL_ROUNDS` rounds: `await` the provider with a timeout (`timeoutMs ?? DEFAULT_TIMEOUT_MS`, abort via `AbortController`). Sum usage tokens.
   - `text`: trimmed empty → `handOff(reason 'The agent returned an empty reply')`, run `transferred` with error `empty_reply`. Otherwise re-read the conversation: if it is no longer open-and-unassigned → `skipped` (no run). Else `postOutbound(sender 'agent', text, changes { agentTurns: agentTurns + 1 })`, run `replied`.
   - `tool_calls`: push `{ role: 'assistant', content: text ?? '', toolCalls: calls }`; for each call in order: `transfer_to_human` → `handOff(reason = input.reason as string || 'The agent asked for a human')`, run `transferred`, stop; `search_knowledge` → content = JSON passages or `NO_RESULTS`; `tag_conversation` → `addTags(input.tags)` (non-array → `[]`), content `ok`; unknown tool → content `unknown tool`. Push `{ role: 'tool', toolCallId, name, content }` per call.
8. Rounds exhausted → `handOff(reason 'The agent did not finish within the tool limit')`, run `transferred`.
9. Any thrown error (provider failure, timeout) → try `handOff(reason 'The AI provider failed')` (log and swallow a failure of the handoff itself), run `failed` with `error` = `timeout` for a timeout, else the error message cut to 200 chars.
10. The run row: `provider` = provider.id, `model` = provider.model, `durationMs`, summed tokens (null when the provider reported none), `outcome`, `error`.

`handOff` = `postOutbound(deps, id, { sender: 'agent', text: message }, { status: 'waiting_human', handoffReason: reason })`.

- [ ] **Step 1: Failing tests**

`apps/api/test/engine.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createDb } from '../src/db/client'
import { seed } from '../src/db/seed'
import { EventBus } from '../src/core/events'
import { ChannelRegistry } from '../src/channels/types'
import { receiveInbound, getConversation, assign, postOutbound } from '../src/core/conversations'
import { loadKnowledge } from '../src/agent/knowledge'
import { DemoProvider } from '../src/agent/providers/demo'
import { runAgentTurn, type EngineDeps } from '../src/agent/engine'
import { listRuns } from '../src/agent/runs'
import type { Provider } from '../src/agent/providers/types'

const KB = loadKnowledge(fileURLToPath(new URL('../knowledge', import.meta.url)))
let deps: EngineDeps
const delivered: string[] = []

async function setup(provider: Provider = new DemoProvider(), timeoutMs?: number) {
  const db = createDb(':memory:')
  await seed(db)
  const channels = new ChannelRegistry()
  channels.register({ id: 'widget', send: async (_t, m) => { delivered.push(m.text ?? '') } })
  deps = { db, bus: new EventBus(), channels, provider, knowledge: () => KB, timeoutMs }
}
const ask = (text: string) => receiveInbound(deps, { channel: 'widget', contactKey: 'k'.repeat(64), type: 'text', text }).conversation.id
const last = (id: number) => getConversation(deps, id)!.messages.at(-1)!

beforeEach(async () => { delivered.length = 0; await setup() })

describe('runAgentTurn', () => {
  it('answers a question from the knowledge base and logs a replied run', async () => {
    const id = ask('How much is a meeting room?')
    const events: unknown[] = []
    deps.bus.on('agent.run.created', (e) => events.push(e))
    const r = await runAgentTurn(deps, id)
    expect(r.outcome).toBe('replied')
    expect(last(id)).toMatchObject({ sender: 'agent', text: expect.stringContaining('Meeting rooms') })
    expect(getConversation(deps, id)!.conversation.agentTurns).toBe(1)
    expect(listRuns(deps.db, id)[0]).toMatchObject({ provider: 'demo', model: 'scripted', outcome: 'replied', error: null })
    expect(events).toHaveLength(1)
    expect(delivered.at(-1)).toContain('Meeting rooms')
  })

  it('hands off on a handoff keyword without calling the provider', async () => {
    const provider = { id: 'spy', model: null, generate: vi.fn() }
    await setup(provider as unknown as Provider)
    const id = ask('I want to talk to a HUMANO please')
    expect((await runAgentTurn(deps, id)).outcome).toBe('transferred')
    expect(provider.generate).not.toHaveBeenCalled()
    const c = getConversation(deps, id)!.conversation
    expect(c).toMatchObject({ status: 'waiting_human', handoffReason: 'Customer asked for a human' })
    expect(last(id)).toMatchObject({ sender: 'agent', text: 'I am passing you to a person from our team. They will reply here shortly.' })
  })

  it('hands off when the knowledge base has no answer (demo flow)', async () => {
    const id = ask('Do you sell quantum computers?')
    expect((await runAgentTurn(deps, id)).outcome).toBe('transferred')
    expect(getConversation(deps, id)!.conversation.handoffReason).toBe('No answer in the knowledge base')
  })

  it('hands off when the turn limit is reached', async () => {
    const id = ask('hi')
    await postOutbound(deps, id, { sender: 'agent', text: 'x' }, { agentTurns: 10 })
    ask('price?')
    expect((await runAgentTurn(deps, id)).outcome).toBe('transferred')
    expect(getConversation(deps, id)!.conversation.handoffReason).toBe('Turn limit reached')
  })

  it('skips when assigned, closed, or nothing new from the customer — and writes no run', async () => {
    const id = ask('hi')
    await runAgentTurn(deps, id)
    expect((await runAgentTurn(deps, id)).outcome).toBe('skipped')
    ask('price?')
    assign(deps, id, 1)
    expect((await runAgentTurn(deps, id)).outcome).toBe('skipped')
    expect(listRuns(deps.db, id)).toHaveLength(1)
  })

  it('a provider error hands off and logs a failed run', async () => {
    await setup({ id: 'boom', model: 'x', generate: async () => { throw new Error('upstream 500') } })
    const id = ask('price?')
    expect((await runAgentTurn(deps, id)).outcome).toBe('failed')
    expect(getConversation(deps, id)!.conversation).toMatchObject({ status: 'waiting_human', handoffReason: 'The AI provider failed' })
    expect(listRuns(deps.db, id)[0]).toMatchObject({ outcome: 'failed', error: 'upstream 500' })
  })

  it('a provider timeout is a failed run with error "timeout"', async () => {
    await setup({ id: 'slow', model: null, generate: () => new Promise(() => {}) }, 20)
    const id = ask('price?')
    expect((await runAgentTurn(deps, id)).outcome).toBe('failed')
    expect(listRuns(deps.db, id)[0]!.error).toBe('timeout')
  })

  it('an empty reply hands off; tool rounds are bounded; tags are applied', async () => {
    await setup({ id: 'empty', model: null, generate: async () => ({ kind: 'text', text: '   ' }) })
    const a = ask('x')
    expect((await runAgentTurn(deps, a)).outcome).toBe('transferred')
    expect(listRuns(deps.db, a)[0]!.error).toBe('empty_reply')

    let n = 0
    await setup({ id: 'loop', model: null, generate: async () => ({ kind: 'tool_calls', calls: [{ id: `t${n++}`, name: 'tag_conversation', input: { tags: ['pricing'] } }] }) })
    const b = ask('x')
    expect((await runAgentTurn(deps, b)).outcome).toBe('transferred')
    expect(n).toBe(3)
    expect(getConversation(deps, b)!.conversation).toMatchObject({ tags: ['pricing'], handoffReason: 'The agent did not finish within the tool limit' })
  })

  it('records token usage when the provider reports it', async () => {
    await setup({ id: 'u', model: 'm', generate: async () => ({ kind: 'text', text: 'ok', usage: { inputTokens: 12, outputTokens: 3 } }) })
    const id = ask('x')
    await runAgentTurn(deps, id)
    expect(listRuns(deps.db, id)[0]).toMatchObject({ inputTokens: 12, outputTokens: 3 })
  })
})
```

Run: `npm test -w apps/api` → FAIL.

- [ ] **Step 2: Types, event and run log**

`core/types.ts` — add:
```ts
import type { agentRuns } from '../db/schema'
export type AgentRun = typeof agentRuns.$inferSelect
```
`core/events.ts` — add to `RelayEvents`:
```ts
  'agent.run.created': { conversationId: number; run: AgentRun }
```
(import `AgentRun` from `./types`).

`apps/api/src/agent/runs.ts`:
```ts
import { desc, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { agentRuns } from '../db/schema'
import type { CoreDeps } from '../core/conversations'
import type { AgentRun } from '../core/types'

export function recordRun(deps: CoreDeps, row: Omit<typeof agentRuns.$inferInsert, 'id' | 'createdAt'>): AgentRun {
  const run = deps.db.insert(agentRuns).values({ ...row, createdAt: new Date().toISOString() }).returning().get()
  deps.bus.emit('agent.run.created', { conversationId: run.conversationId, run })
  return run
}

export function listRuns(db: Db, conversationId: number, limit = 50): AgentRun[] {
  return db.select().from(agentRuns).where(eq(agentRuns.conversationId, conversationId))
    .orderBy(desc(agentRuns.id)).limit(limit).all()
}
```

- [ ] **Step 3: Engine**

`apps/api/src/agent/engine.ts`:
```ts
import { addTags, getConversation, postOutbound, type CoreDeps } from '../core/conversations'
import { agentSettings } from '../core/settings'
import type { AgentRun, Message } from '../core/types'
import { searchKnowledge, tokenize, type Passage } from './knowledge'
import type { ChatMessage, Provider, ToolCall } from './providers/types'
import { recordRun } from './runs'
import { NO_RESULTS, TOOL_SPECS } from './tools'

export const HISTORY_LIMIT = 20
export const MAX_TOOL_ROUNDS = 3
export const DEFAULT_TIMEOUT_MS = 30_000

export type EngineDeps = CoreDeps & { provider: Provider; knowledge: () => Passage[]; timeoutMs?: number }
export type TurnResult = { outcome: 'replied' | 'transferred' | 'failed' | 'skipped'; run?: AgentRun }

const RULES = [
  'Rules:',
  '- Use search_knowledge before answering questions about prices, plans, rooms, hours or the address. Never invent prices or facts.',
  '- If you cannot answer confidently, or the customer wants a human, a complaint, a cancellation or a refund, call transfer_to_human.',
  '- Reply in the language the customer writes in. Keep answers short.',
].join('\n')

class TimeoutError extends Error { constructor() { super('timeout') } }

export async function handOff(deps: CoreDeps, conversationId: number, reason: string, message: string): Promise<void> {
  await postOutbound(deps, conversationId, { sender: 'agent', text: message }, { status: 'waiting_human', handoffReason: reason })
}

function contentOf(m: Message): string {
  if (m.type === 'audio') {
    return m.transcription?.status === 'ok' && m.transcription.text ? `[customer audio, transcribed] ${m.transcription.text}` : '[audio]'
  }
  return m.text ?? ''
}

function toChat(m: Message): ChatMessage {
  return m.sender === 'contact' ? { role: 'user', content: contentOf(m) } : { role: 'assistant', content: contentOf(m) }
}

function asksForHuman(text: string | null, keywords: string[]): boolean {
  if (!text) return false
  const words = new Set(tokenize(text))
  return keywords.some((k) => tokenize(k).every((w) => words.has(w)))
}

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new TimeoutError()) }, ms)
  })
  try {
    return await Promise.race([fn(controller.signal), timeout])
  } finally {
    clearTimeout(timer)
  }
}

export async function runAgentTurn(deps: EngineDeps, conversationId: number): Promise<TurnResult> {
  const found = getConversation(deps, conversationId)
  if (!found) return { outcome: 'skipped' }
  const { conversation, messages } = found
  if (conversation.status !== 'open' || conversation.assigneeId !== null) return { outcome: 'skipped' }
  let lastCompany = -1
  messages.forEach((m, i) => { if (m.sender !== 'contact') lastCompany = i })
  const pending = messages.slice(lastCompany + 1).filter((m) => m.sender === 'contact')
  if (pending.length === 0) return { outcome: 'skipped' }

  const settings = agentSettings(deps.db)
  const started = Date.now()
  let inputTokens: number | null = null
  let outputTokens: number | null = null
  const log = (outcome: 'replied' | 'transferred' | 'failed', error: string | null = null): TurnResult => ({
    outcome,
    run: recordRun(deps, {
      conversationId, provider: deps.provider.id, model: deps.provider.model, durationMs: Date.now() - started,
      inputTokens, outputTokens, outcome, error,
    }),
  })
  const transfer = async (reason: string, error: string | null = null) => {
    await handOff(deps, conversationId, reason, settings.handoffMessage)
    return log('transferred', error)
  }

  if (conversation.agentTurns >= settings.turnLimit) return transfer('Turn limit reached')
  if (pending.some((m) => asksForHuman(m.text, settings.handoffKeywords))) return transfer('Customer asked for a human')

  const system = `${settings.instructions}\n\n${RULES}`
  const chat: ChatMessage[] = messages.slice(-HISTORY_LIMIT).map(toChat)

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const result = await withTimeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, (signal) =>
        deps.provider.generate({ system, messages: chat, tools: TOOL_SPECS, signal }))
      if (result.usage?.inputTokens !== undefined) inputTokens = (inputTokens ?? 0) + result.usage.inputTokens
      if (result.usage?.outputTokens !== undefined) outputTokens = (outputTokens ?? 0) + result.usage.outputTokens

      if (result.kind === 'text') {
        const text = result.text.trim()
        if (!text) return transfer('The agent returned an empty reply', 'empty_reply')
        const now = getConversation(deps, conversationId)?.conversation
        if (!now || now.status !== 'open' || now.assigneeId !== null) return { outcome: 'skipped' }
        await postOutbound(deps, conversationId, { sender: 'agent', text }, { agentTurns: now.agentTurns + 1 })
        return log('replied')
      }

      chat.push({ role: 'assistant', content: result.text ?? '', toolCalls: result.calls })
      for (const call of result.calls) {
        if (call.name === 'transfer_to_human') {
          const reason = typeof call.input.reason === 'string' && call.input.reason.trim() ? call.input.reason.trim() : 'The agent asked for a human'
          return transfer(reason)
        }
        chat.push({ role: 'tool', toolCallId: call.id, name: call.name, content: runTool(deps, conversationId, call) })
      }
    }
    return transfer('The agent did not finish within the tool limit')
  } catch (err) {
    const error = err instanceof TimeoutError ? 'timeout' : String((err as Error)?.message ?? err).slice(0, 200)
    try {
      await handOff(deps, conversationId, 'The AI provider failed', settings.handoffMessage)
    } catch (handoffErr) {
      console.error('[relay] handoff after provider failure failed', conversationId, handoffErr)
    }
    return log('failed', error)
  }
}

function runTool(deps: EngineDeps, conversationId: number, call: ToolCall): string {
  if (call.name === 'search_knowledge') {
    const hits = searchKnowledge(deps.knowledge(), String(call.input.query ?? ''))
    return hits.length ? JSON.stringify(hits.map(({ title, text }) => ({ title, text }))) : NO_RESULTS
  }
  if (call.name === 'tag_conversation') {
    addTags(deps, conversationId, Array.isArray(call.input.tags) ? call.input.tags.map(String) : [])
    return 'ok'
  }
  return 'unknown tool'
}
```

- [ ] **Step 4: Run tests and typecheck, then commit**

Run: `npm test -w apps/api` → PASS. `npm run typecheck -w apps/api` → clean.
```bash
git add apps/api
git commit -m "feat(api): agent engine with reply rules, tools, automatic handoff and run log"
```

---

### Task 5: Agent queue, wiring, runs API and graceful shutdown

**Files:**
- Create: `apps/api/src/agent/queue.ts`
- Modify: `apps/api/src/main.ts`, `apps/api/src/core/routes.ts`, `apps/api/src/realtime/inbox.ts`
- Test: `apps/api/test/queue.test.ts`, `apps/api/test/agent-flow.test.ts`, extend `apps/api/test/inbox-routes.test.ts`

**Interfaces:**
- Consumes: `runAgentTurn`, `EngineDeps` (Task 4); `listRuns` (Task 4); `selectProvider` (Task 3); `loadKnowledge` (Task 2).
- Produces:
  - `class AgentQueue { constructor(run: (conversationId: number) => Promise<unknown>, bus: EventBus); start(): void; stop(): void; schedule(conversationId: number): void; drain(): Promise<void> }` — `start` subscribes to `message.created` and schedules only `contact` messages. One turn at a time per conversation; a message arriving during a running turn schedules exactly one more turn afterwards (coalesced). Turns start on `setImmediate`, never synchronously inside the emitter. A turn that throws is logged (`console.error('[relay] agent turn crashed', conversationId, err)`) and does not stop the queue. `drain()` resolves when nothing is running or scheduled.
  - Route `GET /api/conversations/:id/agent-runs` (session required) → `{ runs: AgentRun[] }` (newest first, max 50); 404 `not_found` for an unknown conversation.
  - `/ws/inbox` forwards `agent.run.created` frames too.
  - `main.ts`: provider from `selectProvider(process.env)`; knowledge loaded once from `RELAY_KNOWLEDGE_DIR` (default: `apps/api/knowledge`, resolved from `import.meta.url`); logs `[relay] agent provider: <id> (<model>), knowledge passages: <n>`; starts the queue; on `SIGINT`/`SIGTERM`: stop the queue, close the app, await `queue.drain()`, exit 0.

- [ ] **Step 1: Failing tests**

`apps/api/test/queue.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { EventBus } from '../src/core/events'
import { AgentQueue } from '../src/agent/queue'

const msg = (conversationId: number, sender: string) => ({ conversationId, message: { sender } as never })

describe('AgentQueue', () => {
  it('runs only for contact messages, never synchronously, and drains', async () => {
    const bus = new EventBus()
    const run = vi.fn(async () => {})
    const q = new AgentQueue(run, bus)
    q.start()
    bus.emit('message.created', msg(1, 'contact'))
    bus.emit('message.created', msg(2, 'agent'))
    expect(run).not.toHaveBeenCalled()
    await q.drain()
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(1)
  })

  it('serializes per conversation and coalesces messages that arrive during a turn', async () => {
    const bus = new EventBus()
    let active = 0
    let maxActive = 0
    const run = vi.fn(async () => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 10)); active-- })
    const q = new AgentQueue(run, bus)
    q.start()
    bus.emit('message.created', msg(1, 'contact'))
    await new Promise((r) => setTimeout(r, 2))
    bus.emit('message.created', msg(1, 'contact'))
    bus.emit('message.created', msg(1, 'contact'))
    await q.drain()
    expect(maxActive).toBe(1)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('a crashing turn is logged and the queue keeps working; stop unsubscribes', async () => {
    const bus = new EventBus()
    const run = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const q = new AgentQueue(run, bus)
      q.start()
      bus.emit('message.created', msg(1, 'contact'))
      await q.drain()
      expect(spy).toHaveBeenCalledWith('[relay] agent turn crashed', 1, expect.any(Error))
      bus.emit('message.created', msg(1, 'contact'))
      await q.drain()
      expect(run).toHaveBeenCalledTimes(2)
      q.stop()
      bus.emit('message.created', msg(1, 'contact'))
      await q.drain()
      expect(run).toHaveBeenCalledTimes(2)
    } finally { spy.mockRestore() }
  })
})
```

`apps/api/test/agent-flow.test.ts` (end to end through the real widget socket):
```ts
import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createDb } from '../src/db/client'
import { seed } from '../src/db/seed'
import { EventBus } from '../src/core/events'
import { ChannelRegistry } from '../src/channels/types'
import { WidgetChannel } from '../src/channels/widget'
import { buildServer } from '../src/server'
import { AgentQueue } from '../src/agent/queue'
import { runAgentTurn } from '../src/agent/engine'
import { DemoProvider } from '../src/agent/providers/demo'
import { loadKnowledge } from '../src/agent/knowledge'

const TOKEN = 'visitor-token-0123456789-abcdefghijklmnop'

describe('agent flow over the widget', () => {
  it('a visitor question gets an agent answer pushed to the widget', async () => {
    const db = createDb(':memory:')
    await seed(db)
    const bus = new EventBus()
    const channels = new ChannelRegistry()
    const widget = new WidgetChannel()
    channels.register(widget)
    const knowledge = loadKnowledge(fileURLToPath(new URL('../knowledge', import.meta.url)))
    const engine = { db, bus, channels, provider: new DemoProvider(), knowledge: () => knowledge }
    const queue = new AgentQueue((id) => runAgentTurn(engine, id), bus)
    queue.start()
    const app = await buildServer({ db, bus, channels }, { widget })
    await app.ready()

    const ws = await app.injectWS(`/ws/widget?token=${TOKEN}`)
    const frames: any[] = []
    const agentReply = new Promise<any>((resolve) => ws.on('message', (d: Buffer) => {
      const f = JSON.parse(d.toString())
      frames.push(f)
      if (f.type === 'message' && f.message.sender === 'agent') resolve(f)
    }))
    ws.send(JSON.stringify({ type: 'text', text: 'What are your opening hours?' }))
    const reply = await agentReply
    expect(reply.message.text).toContain('Opening hours')
    ws.terminate()
    queue.stop()
    await queue.drain()
    await app.close()
  })
})
```

Append to `apps/api/test/inbox-routes.test.ts`:
```ts
it('lists agent runs for a conversation, newest first; 404 for unknown', async () => {
  const { app, deps, login } = await testServer()
  const cookie = await login()
  const { conversation } = receiveInbound(deps, hello)
  recordRun(deps, { conversationId: conversation.id, provider: 'demo', model: 'scripted', durationMs: 5, inputTokens: null, outputTokens: null, outcome: 'replied', error: null })
  recordRun(deps, { conversationId: conversation.id, provider: 'demo', model: 'scripted', durationMs: 7, inputTokens: null, outputTokens: null, outcome: 'transferred', error: null })
  const res = await app.inject({ method: 'GET', url: `/api/conversations/${conversation.id}/agent-runs`, headers: { cookie } })
  expect(res.json().runs.map((r: { outcome: string }) => r.outcome)).toEqual(['transferred', 'replied'])
  const missing = await app.inject({ method: 'GET', url: '/api/conversations/999/agent-runs', headers: { cookie } })
  expect(missing.statusCode).toBe(404)
})
```
(add `import { recordRun } from '../src/agent/runs'` at the top). Also extend `apps/api/test/inbox-ws.test.ts` with a test that a `recordRun(...)` call reaches a signed-in inbox socket as `{ event: 'agent.run.created', data: { conversationId, run } }`.

Run: `npm test -w apps/api` → FAIL.

- [ ] **Step 2: Queue**

`apps/api/src/agent/queue.ts`:
```ts
import type { EventBus, RelayEvents } from '../core/events'

/** Runs agent turns one at a time per conversation; extra messages during a turn coalesce into one more turn. */
export class AgentQueue {
  private running = new Map<number, Promise<void>>()
  private again = new Set<number>()
  private readonly onMessage = ({ conversationId, message }: RelayEvents['message.created']) => {
    if (message.sender === 'contact') this.schedule(conversationId)
  }

  constructor(private readonly run: (conversationId: number) => Promise<unknown>, private readonly bus: EventBus) {}

  start(): void { this.bus.on('message.created', this.onMessage) }
  stop(): void { this.bus.off('message.created', this.onMessage) }

  schedule(conversationId: number): void {
    if (this.running.has(conversationId)) { this.again.add(conversationId); return }
    const task = new Promise<void>((resolve) => setImmediate(resolve))
      .then(async () => {
        do {
          this.again.delete(conversationId)
          try {
            await this.run(conversationId)
          } catch (err) {
            console.error('[relay] agent turn crashed', conversationId, err)
          }
        } while (this.again.has(conversationId))
      })
      .finally(() => this.running.delete(conversationId))
    this.running.set(conversationId, task)
  }

  async drain(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running.values()])
  }
}
```

- [ ] **Step 3: Route and inbox socket**

`core/routes.ts` — add (import `listRuns` from `../agent/runs`):
```ts
  app.get('/api/conversations/:id/agent-runs', { preHandler: requireUser }, async (req, reply) => {
    const { id } = IdParams.parse(req.params)
    if (!getConversation(deps, id)) return notFound(reply)
    return { runs: listRuns(deps.db, id) }
  })
```
`realtime/inbox.ts` — `const EVENTS: Array<keyof RelayEvents> = ['message.created', 'conversation.updated', 'agent.run.created']`.

- [ ] **Step 4: main.ts**

Replace `apps/api/src/main.ts` with:
```ts
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb } from './db/client'
import { seed } from './db/seed'
import { EventBus } from './core/events'
import { ChannelRegistry } from './channels/types'
import { WidgetChannel } from './channels/widget'
import { WhatsAppChannel } from './channels/whatsapp'
import { buildServer } from './server'
import { selectProvider } from './agent/providers'
import { loadKnowledge } from './agent/knowledge'
import { runAgentTurn } from './agent/engine'
import { AgentQueue } from './agent/queue'

const file = process.env.RELAY_DB ?? 'data/relay.db'
mkdirSync(dirname(file), { recursive: true })
const db = createDb(file)
await seed(db)

const bus = new EventBus()
const channels = new ChannelRegistry()
const widget = new WidgetChannel()
channels.register(widget)
channels.register(new WhatsAppChannel())

const provider = selectProvider(process.env)
const knowledgeDir = process.env.RELAY_KNOWLEDGE_DIR ?? fileURLToPath(new URL('../knowledge', import.meta.url))
const knowledge = loadKnowledge(knowledgeDir)
const queue = new AgentQueue((id) => runAgentTurn({ db, bus, channels, provider, knowledge: () => knowledge }, id), bus)
queue.start()
console.log(`[relay] agent provider: ${provider.id} (${provider.model ?? 'n/a'}), knowledge passages: ${knowledge.length}`)

const app = await buildServer({ db, bus, channels }, { widget })
const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' })
console.log(`[relay] api listening on :${port}`)

let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[relay] ${signal}: finishing agent turns and shutting down`)
  queue.stop()
  await app.close()
  await queue.drain()
  process.exit(0)
}
process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))
```

- [ ] **Step 5: Run tests, typecheck and a smoke run**

Run: `npm test -w apps/api` → PASS. `npm run typecheck -w apps/api` → clean.
Smoke: `npm run dev:api` in the background → the log shows `agent provider: demo (scripted), knowledge passages: 6`; `curl http://localhost:3000/api/health` → `{"ok":true}`; stop it; delete the untracked `apps/api/data` if it was created.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat(api): agent queue, runs API, live run events and graceful shutdown"
```

---

### Task 6: Inbox — agent activity, typed frames, debounced refresh

**Files:**
- Create: `apps/web/src/components/AgentActivity.tsx`
- Modify: `apps/web/src/api.ts`, `apps/web/src/live.ts`, `apps/web/src/pages/Inbox.tsx`, `apps/web/src/components/Widget.tsx` (only the `connectLive` type argument), `apps/web/src/styles.css`
- Test: `apps/web/test/AgentActivity.test.tsx`, extend `apps/web/test/Inbox.test.tsx`

**Interfaces:**
- Consumes: `GET /api/conversations/:id/agent-runs` → `{ runs }`; inbox frames `message.created`, `conversation.updated`, `agent.run.created`.
- Produces:
  - `api.ts`: `type AgentRun = { id: number; conversationId: number; provider: string; model: string | null; durationMs: number; inputTokens: number | null; outputTokens: number | null; outcome: 'replied' | 'transferred' | 'failed'; error: string | null; createdAt: string }`; `api.agentRuns(id)`; `type InboxFrame = { event: 'message.created'; data: { conversationId: number; message: Message } } | { event: 'conversation.updated'; data: { conversation: Conversation } } | { event: 'agent.run.created'; data: { conversationId: number; run: AgentRun } }`.
  - `live.ts`: `connectLive<F = unknown>(path, onFrame: (frame: F) => void, onOpen?, onClose?)`.
  - `<AgentActivity runs={AgentRun[]} />`: empty state "No agent activity yet"; each run shows the outcome label (`Replied`, `Handed off`, `Failed`), `provider · model`, duration in ms, tokens as `in/out tokens` when present, the error when present, and the local time.
  - Inbox: loads runs together with the detail (if `api.agentRuns` fails with non-401, show runs as empty — the conversation still opens); prepends `agent.run.created` runs for the selected conversation (de-dup by id); the conversation list refresh triggered by frames is debounced to at most one request per 300 ms; the handoff reason line stays.

- [ ] **Step 1: Failing tests**

`apps/web/test/AgentActivity.test.tsx`:
```tsx
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { AgentActivity } from '../src/components/AgentActivity'
import type { AgentRun } from '../src/api'

const run = (over: Partial<AgentRun>): AgentRun => ({
  id: 1, conversationId: 1, provider: 'demo', model: 'scripted', durationMs: 12, inputTokens: null, outputTokens: null,
  outcome: 'replied', error: null, createdAt: '2026-11-10T12:00:00Z', ...over,
})

describe('AgentActivity', () => {
  it('shows an empty state', () => {
    render(<AgentActivity runs={[]} />)
    expect(screen.getByText('No agent activity yet')).toBeInTheDocument()
  })

  it('shows outcome, provider, duration, tokens and error', () => {
    render(<AgentActivity runs={[
      run({ id: 2, outcome: 'failed', error: 'timeout', provider: 'claude', model: 'claude-sonnet-5-5', inputTokens: 120, outputTokens: 40, durationMs: 30000 }),
      run({ id: 1, outcome: 'transferred' }),
    ]} />)
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.getByText('Handed off')).toBeInTheDocument()
    expect(screen.getByText('claude · claude-sonnet-5-5')).toBeInTheDocument()
    expect(screen.getByText('120/40 tokens')).toBeInTheDocument()
    expect(screen.getByText('timeout')).toBeInTheDocument()
    expect(screen.getByText('30000 ms')).toBeInTheDocument()
  })
})
```

In `apps/web/test/Inbox.test.tsx`: add `agentRuns: vi.fn()` to the mocked `api` object, default `mocked.agentRuns.mockResolvedValue({ runs: [] })` in `beforeEach`, and add:
```tsx
  it('shows agent runs and adds live ones for the open conversation', async () => {
    mocked.agentRuns.mockResolvedValue({ runs: [{ id: 1, conversationId: 1, provider: 'demo', model: 'scripted', durationMs: 5, inputTokens: null, outputTokens: null, outcome: 'replied', error: null, createdAt: '2026-11-10T12:00:00Z' }] })
    await openFirst()
    expect(await screen.findByText('Replied')).toBeInTheDocument()
    const onFrame = vi.mocked(connectLive).mock.calls[0]![1] as (f: unknown) => void
    act(() => onFrame({ event: 'agent.run.created', data: { conversationId: 1, run: { id: 2, conversationId: 1, provider: 'demo', model: 'scripted', durationMs: 9, inputTokens: null, outputTokens: null, outcome: 'transferred', error: null, createdAt: '2026-11-10T12:01:00Z' } } }))
    expect(await screen.findByText('Handed off')).toBeInTheDocument()
  })

  it('debounces list refreshes triggered by frames', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await openFirst()
      const before = mocked.list.mock.calls.length
      const onFrame = vi.mocked(connectLive).mock.calls[0]![1] as (f: unknown) => void
      act(() => { for (let i = 0; i < 5; i++) onFrame({ event: 'conversation.updated', data: { conversation: { ...conv(2) } } }) })
      await act(async () => { await vi.advanceTimersByTimeAsync(350) })
      expect(mocked.list.mock.calls.length - before).toBe(1)
    } finally { vi.useRealTimers() }
  })
```

Run: `npm test -w apps/web` → FAIL.

- [ ] **Step 2: Implement**

`apps/web/src/components/AgentActivity.tsx`:
```tsx
import type { AgentRun } from '../api'

const OUTCOME = { replied: 'Replied', transferred: 'Handed off', failed: 'Failed' } as const

export function AgentActivity({ runs }: { runs: AgentRun[] }) {
  if (runs.length === 0) return <p className="muted">No agent activity yet</p>
  return (
    <ol className="runs">
      {runs.map((r) => (
        <li key={r.id} className={`run run-${r.outcome}`}>
          <strong>{OUTCOME[r.outcome]}</strong>
          <span>{r.model ? `${r.provider} · ${r.model}` : r.provider}</span>
          <span>{r.durationMs} ms</span>
          {r.inputTokens !== null && r.outputTokens !== null && <span>{r.inputTokens}/{r.outputTokens} tokens</span>}
          {r.error && <span className="run-error">{r.error}</span>}
          <time>{new Date(r.createdAt).toLocaleTimeString()}</time>
        </li>
      ))}
    </ol>
  )
}
```

`api.ts`: add `AgentRun`, `InboxFrame` (exactly as in Interfaces) and `agentRuns: (id: number) => call<{ runs: AgentRun[] }>(\`/api/conversations/${id}/agent-runs\`)`.

`live.ts`: make it generic — `export function connectLive<F = unknown>(path: string, onFrame: (frame: F) => void, onOpen?: () => void, onClose?: (code: number) => void): Live` and cast the parsed JSON to `F`. In `Widget.tsx`, pass its frame type: `connectLive<{ type: 'history'; messages: WidgetMessage[] } | { type: 'message'; message: WidgetMessage } | { type: 'error'; code: string }>(...)` and keep the behavior.

`Inbox.tsx` changes:
1. State `const [runs, setRuns] = useState<AgentRun[]>([])`; clear it in `select()` together with `detail`.
2. `refreshDetail` loads both: `const [d, r] = await Promise.all([api.get(id), api.agentRuns(id).catch((err) => { if (err instanceof ApiError && err.status === 401) throw err; return { runs: [] } })])`, then (if still current) `setDetail(d); setRuns(r.runs)`.
3. Debounce: a `listTimer` ref; `scheduleListRefresh()` sets a 300 ms timeout if none is pending, and calls `refreshRef.current.refreshList()` when it fires; clear it on unmount. Frames call `scheduleListRefresh()` instead of `refreshList()` directly (the `onOpen` reconnect path still refreshes immediately).
4. Type the socket: `connectLive<InboxFrame>(...)`, and handle `agent.run.created`: if `frame.data.conversationId === selectedRef.current`, `setRuns((rs) => rs.some((x) => x.id === frame.data.run.id) ? rs : [frame.data.run, ...rs])`.
5. In the contact column, under Tags: `<h3>Agent activity</h3><AgentActivity runs={runs} />`.

`styles.css` — append:
```css
.runs { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.run { display: grid; gap: 2px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; font-size: 13px; }
.run span, .run time { color: var(--muted); }
.run-failed { border-color: #dc2626; } .run-transferred { border-color: var(--warn); }
.run-error { color: #dc2626 !important; }
```

- [ ] **Step 3: Run tests and typecheck, then commit**

Run: `npm test -w apps/web` → PASS (pristine). `npm run typecheck -w apps/web` → clean. `npm test -w apps/api` still PASS.
```bash
git add apps/web
git commit -m "feat(web): agent activity panel, typed live frames and debounced list refresh"
```

---

### Task 7: README and end-to-end check

**Files:**
- Modify: `README.md`, `docs/superpowers/plans/followups-after-plan-1.md`

- [ ] **Step 1: README**

Replace the status line with `> Status: plan 2 of 6 — the AI agent answers with a scripted demo provider. Claude and Ollama providers land in plan 3.` and add after "Develop":
```markdown
## The AI agent

When a customer writes and nobody from the team has taken the conversation, the agent answers on its own:

- it searches the knowledge base (`apps/api/knowledge/*.md`, or `RELAY_KNOWLEDGE_DIR`) before answering factual questions;
- it hands off to a human when the customer asks for one, when it has no answer, after the turn limit, or when the AI provider fails — the customer always gets a reply;
- every turn is logged (provider, model, duration, tokens, outcome) and shown live in the inbox under "Agent activity".

With no configuration it runs on a scripted **demo provider**, so the whole flow works without an API key. Try: "What are your opening hours?", "How much is a meeting room?", "I want to cancel", or "I want to talk to a human".
```
Update the Portuguese section with one sentence about the agent.

- [ ] **Step 2: Follow-ups file**

In `docs/superpowers/plans/followups-after-plan-1.md`, mark the plan-2 items done by moving them under a new heading `## Done in plan 2` (keep any you did not implement under "Plan 2" and say why).

- [ ] **Step 3: End-to-end check**

Start `npm run dev:api` and `npm run dev:web` in the background. With a small Node script using `ws` through `ws://localhost:5173/ws/widget?token=<36+ char token>`: send "What are your opening hours?" and confirm an `agent` message frame containing "Opening hours" arrives; send "I want to talk to a human" and confirm the handoff message arrives. Through the API (log in as the demo user with `curl` and the cookie), confirm `GET /api/conversations` shows the conversation as `waiting_human` and `GET /api/conversations/:id/agent-runs` lists the runs. Stop both servers and delete the untracked `apps/api/data`.

- [ ] **Step 4: Full suite and commit**

Run from the root: `npm test` and `npm run typecheck` → PASS / clean.
```bash
git add README.md docs/superpowers/plans/followups-after-plan-1.md
git commit -m "docs: agent section in the README and plan-2 follow-ups status"
```
