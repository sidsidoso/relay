# Relay plan 6a — CI and hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every push and pull request is checked by GitHub Actions (type check, API and web tests, web build, transcriber tests, Docker images and a smoke test), and the open follow-ups that make the public demo safe and robust are closed: agent prompt and refusal handling, a testable `try-provider`, security headers, rate limits, session hardening, Docker Compose resilience and the open review findings.

**Architecture:** One workflow file with three jobs (`node`, `transcriber`, `docker`) that need no secrets: the API runs on the demo provider and the transcriber tests use a fake model. Hardening stays inside the existing Fastify app: an `onSend` hook adds security headers, a small in-memory fixed-window `RateLimiter` guards login and the public widget endpoints, an Origin check guards `/ws/*`, and a `SessionSockets` registry lets sign-out and expiry close inbox sockets. The engine builds its system prompt in one exported function and passes the text-only variant to providers that may drop tools mid-request.

**Tech Stack:** GitHub Actions, Docker Compose, nginx 1.29, Fastify 5, zod 4, Drizzle + better-sqlite3, React 19, Vitest 5, Python 3.12 + pytest.

**Split:** Plan 6 is delivered in two plans. **6a (this plan)** is CI and hardening. **6b** (`2026-11-12-relay-06b-i18n-e2e.md`) is the English/Portuguese UI and the Playwright end-to-end tests, and adds an `e2e` job to the workflow created here. 6a goes first so every later change runs under CI; 6b depends on two small UI changes made here (the `/demo` notice and the widget "too fast" notice), which it then translates.

## Global Constraints

- Code, comments, commit messages and UI copy in English (translations come in plan 6b).
- No employer names, data, IPs or keys anywhere; sample data stays fictional (Acme Coworking). CI uses no secrets.
- Git identity is already set in the repo (`João Leandro <272076793+sidsidoso@users.noreply.github.com>`). Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Push with `GH_TOKEN=$(gh auth token --user sidsidoso) git push`.
- API errors are always `{ error, code }` with a stable code (spec §10). Validation errors are `400 invalid_request` with `fields`.
- Every inbox/settings route requires a session (`makeRequireUser`).
- The demo must keep working with zero configuration (`docker compose up`, demo provider). Tests never call a model or the network.
- There is no linter in the repo. CI runs the strict TypeScript check in its place (spec §11 lists lint; adding ESLint is left as a user decision, see the report).
- Run tests per workspace: `npm test -w apps/api -- <file>` / `npm test -w apps/web -- <file>`; typecheck with `npm run typecheck`. Transcriber tests: `cd services/transcriber && .venv/Scripts/python -m pytest` (Linux/macOS: `.venv/bin/python`).
- Docker is not installed on the development machine: Docker changes are verified by the `docker` CI job, not locally.

## File map

| File | Responsibility |
|---|---|
| `.github/workflows/ci.yml` (create) | Jobs `node`, `transcriber`, `docker` on push and pull request |
| `package.json` (modify) | Root `build` script |
| `apps/api/src/agent/engine.ts` (modify) | `buildSystemPrompt`, generic "search the knowledge base first" rule, `textOnlySystem`, refusal → transferred |
| `apps/api/src/agent/providers/types.ts`, `providers/ollama.ts` (modify) | `textOnlySystem?` on `GenerateRequest`; Ollama uses it after dropping tools |
| `apps/api/src/agent/tryProvider.ts` (create), `apps/api/scripts/try-provider.ts` (modify) | One full agent turn on a throwaway DB with the selected provider |
| `apps/api/src/config.ts` (create) | `readPort`, `readList`, `readFlag` for environment values |
| `apps/api/src/http/security.ts` (create) | Security headers hook, JSON 404 handler, `redactUrl` for logs |
| `apps/api/src/http/rateLimit.ts` (create) | `RateLimiter`, `defaultLimits`, `tooManyRequests` |
| `apps/api/src/http/origin.ts` (create) | `originAllowed` for `/ws/*` |
| `apps/api/src/realtime/sessionSockets.ts` (create) | Inbox sockets by session token |
| `apps/api/src/server.ts`, `main.ts` (modify) | Wire logger, proxy trust, headers, limits, origins, sessions |
| `apps/api/src/auth/routes.ts`, `auth/sessions.ts`, `auth/password.ts` (modify) | Login limit, cookie attributes, purge, sign-out closes sockets, empty-key check, `z.email()` |
| `apps/api/src/channels/widget.ts`, `realtime/inbox.ts` (modify) | Origin check, per-visitor socket cap, message and audio limits, session re-check |
| `apps/api/test/helpers.ts` (modify) | `testServer` accepts server options |
| `apps/web/src/live.ts`, `components/Widget.tsx` (modify) | No reconnect on 4403; "too fast" notice |
| `apps/web/src/inboxList.ts` (create), `pages/Inbox.tsx`, `components/KnowledgeEditor.tsx`, `pages/Demo.tsx` (modify) | Review findings: keep loaded pages on refresh, no blank overwrite of an existing file; public-demo notice |
| `services/transcriber/transcriber/engine.py`, `__main__.py` (modify) | Retry a failed model load, then exit so Compose restarts it |
| `docker-compose.yml`, `apps/web/nginx.conf` (modify) | Healthchecks, `depends_on` conditions, proxy trust, nginx resolver, headers, log format without query strings |
| `README.md`, `.env.example`, `docs/superpowers/plans/followups-after-plan-1.md` (modify) | CI badge, security notes, new variables, follow-ups status, manual checklist |

---

### Task 1: CI workflow for type check, tests and build

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `package.json`

**Interfaces:**
- Produces: workflow `CI` with jobs `node` and `transcriber` (Task 10 adds `docker`, plan 6b adds `e2e`). Root script `npm run build` builds every workspace that has a `build` script.

- [ ] **Step 1: Add the root build script**

`package.json` (root), the whole `scripts` block:

```json
  "scripts": {
    "dev:api": "npm run dev -w apps/api",
    "dev:web": "npm run dev -w apps/web",
    "build": "npm run build --workspaces --if-present",
    "test": "npm test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present"
  }
```

- [ ] **Step 2: Write the workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI

# Runs on every push and pull request. No secrets: the API tests use recorded provider
# responses and the demo provider, and the transcriber tests use a fake Whisper model.
on:
  push:
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  node:
    name: Type check, tests and build
    runs-on: ubuntu-latest
    timeout-minutes: 15
    env:
      RELAY_PROVIDER: demo
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build

  transcriber:
    name: Transcriber tests (fake model)
    runs-on: ubuntu-latest
    timeout-minutes: 10
    defaults:
      run:
        working-directory: services/transcriber
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-python@v6
        with:
          python-version: '3.12'
          cache: pip
          cache-dependency-path: services/transcriber/requirements-dev.txt
      - run: python -m pip install -r requirements-dev.txt
      - run: python -m pytest
```

- [ ] **Step 3: Run the same commands locally**

Run: `npm ci && npm run typecheck && npm test && npm run build`
Expected: type check clean, every API and web test passes, `apps/web/dist` is built.

Run: `cd services/transcriber && python -m venv .venv && .venv/Scripts/python -m pip install -r requirements-dev.txt && .venv/Scripts/python -m pytest`
Expected: all transcriber tests pass.

- [ ] **Step 4: Commit and push, then watch the run**

```bash
git add package.json .github/workflows/ci.yml
git commit -m "ci: type check, API and web tests, web build and transcriber tests on every push

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
GH_TOKEN=$(gh auth token --user sidsidoso) git push -u origin HEAD
GH_TOKEN=$(gh auth token --user sidsidoso) gh run watch --repo sidsidoso/relay --exit-status
```

Expected: both jobs green. If a test fails only on Linux (paths, line endings, file ordering), fix the test or code in this task, with a commit `fix: <what> on Linux`, and push again until green.

---

### Task 2: The agent prompt asks for a knowledge search, and text-only fallbacks get the right prompt

The tool rule names Acme's topics ("prices, plans, rooms, hours or the address"); since the knowledge base is now editable, the rule must cover any company question. The review of plan 5 also found that when an Ollama model rejects tools on its first request, the fallback request reuses the tool prompt and so carries no knowledge passages.

**Files:**
- Modify: `apps/api/src/agent/engine.ts`, `apps/api/src/agent/providers/types.ts`, `apps/api/src/agent/providers/ollama.ts`, `apps/api/src/agent/tools.ts`
- Test: `apps/api/test/engine.test.ts`, `apps/api/test/ollama-provider.test.ts`, `apps/api/test/providers-engine.test.ts`

**Interfaces:**
- Produces: `export const SEARCH_RULE: string`; `export function buildSystemPrompt(instructions: string, textOnly: boolean, knowledge: Passage[], query: string): string`; `GenerateRequest.textOnlySystem?: string` — the prompt a provider must use if it drops tools during the request. The engine always sets it for tool-capable providers.

- [ ] **Step 1: Write the failing tests**

In `apps/api/test/engine.test.ts`, change the engine import to:

```ts
import { runAgentTurn, buildSystemPrompt, KNOWLEDGE_HEADER, SEARCH_RULE, type EngineDeps } from '../src/agent/engine'
```

and add inside `describe('text-only providers', …)`:

```ts
  it('tool-capable providers are told to search the knowledge base first, and get a text-only prompt for a fallback', async () => {
    const { provider, seen } = capturing(false)
    const { conversation } = receiveInbound(deps, { channel: 'widget', contactKey: 't-4', type: 'text', text: 'How much is a meeting room per hour?' })
    await runAgentTurn({ ...deps, provider }, conversation.id)
    expect(seen[0]!.system).toContain(SEARCH_RULE)
    expect(seen[0]!.textOnlySystem).toContain(KNOWLEDGE_HEADER)
    expect(seen[0]!.textOnlySystem).toContain('$20 per hour')
  })

  it('text-only providers get no fallback prompt', async () => {
    const { provider, seen } = capturing(true)
    const { conversation } = receiveInbound(deps, { channel: 'widget', contactKey: 't-5', type: 'text', text: 'Hello' })
    await runAgentTurn({ ...deps, provider }, conversation.id)
    expect(seen[0]!.textOnlySystem).toBeUndefined()
  })

  it('buildSystemPrompt puts the instructions first', () => {
    expect(buildSystemPrompt('Be nice.', false, KB, 'x').startsWith('Be nice.\n\nRules:')).toBe(true)
    expect(buildSystemPrompt('Be nice.', true, KB, 'meeting room')).toContain('Meeting rooms')
  })
```

In `apps/api/test/ollama-provider.test.ts`, add inside `describe('OllamaProvider', …)`:

```ts
  it('uses the text-only prompt for the request without tools', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { p, requests } = provider([{ status: 400, body: fixture('ollama/no-tools.json') }, { body: fixture('ollama/text.json') }], 'gemma2:2b')
      await p.generate({ system: 'TOOLS PROMPT', textOnlySystem: 'TEXT PROMPT', messages: [{ role: 'user', content: 'hi' }], tools: TOOL_SPECS })
      expect(requests[0]!.body.messages[0]).toEqual({ role: 'system', content: 'TOOLS PROMPT' })
      expect(requests[1]!.body.messages[0]).toEqual({ role: 'system', content: 'TEXT PROMPT' })
    } finally { warn.mockRestore() }
  })
```

In `apps/api/test/providers-engine.test.ts`, change the engine import to `import { runAgentTurn, KNOWLEDGE_HEADER, type EngineDeps } from '../src/agent/engine'` and add inside the `describe`:

```ts
  it('Ollama: the first text-only request already carries the knowledge passages', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = fakeFetch([{ status: 400, body: fixture('ollama/no-tools.json') }, { body: fixture('ollama/text.json') }])
    await setup(new OllamaProvider({ url: 'http://ollama:11434', model: 'gemma2:2b', fetch: f.fetch }))
    const id = ask('How much is a meeting room per hour?')
    expect((await runAgentTurn(deps, id)).outcome).toBe('replied')
    expect(f.requests[0]!.body.messages[0].content).not.toContain(KNOWLEDGE_HEADER)
    expect(f.requests[1]!.body.messages[0].content).toContain(KNOWLEDGE_HEADER)
    expect(f.requests[1]!.body.messages[0].content).toContain('Meeting rooms')
  })
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test -w apps/api -- test/engine.test.ts test/ollama-provider.test.ts test/providers-engine.test.ts`
Expected: FAIL (`buildSystemPrompt` / `SEARCH_RULE` not exported; `textOnlySystem` undefined; the fallback request still sends `TOOLS PROMPT`).

- [ ] **Step 3: Implement**

`apps/api/src/agent/providers/types.ts` — replace the `GenerateRequest` line with:

```ts
export type GenerateRequest = {
  system: string
  /** The prompt to use if the provider has to drop tools during this request (an Ollama model without tool support). */
  textOnlySystem?: string
  messages: ChatMessage[]
  tools: ToolSpec[]
  signal?: AbortSignal
}
```

`apps/api/src/agent/providers/ollama.ts` — in `generate`, change the destructuring and the retry:

```ts
  async generate({ system, textOnlySystem, messages, tools, signal }: GenerateRequest): Promise<GenerateResult> {
    const withTools = this.toolsSupported && tools.length > 0
    let res = await this.chat(system, messages, withTools ? tools : [], signal)
    if (withTools && res.status === 400) {
      const detail = await errorText(res)
      if (!NO_TOOLS.test(detail)) throw new ProviderError('ollama_http_400', detail)
      this.toolsSupported = false
      console.warn(`[relay] ollama model "${this.model}" does not support tools; running in text-only mode`)
      res = await this.chat(textOnlySystem ?? system, messages, [], signal)
    }
```

(the rest of the method is unchanged).

`apps/api/src/agent/tools.ts` — the `search_knowledge` description becomes:

```ts
    description: 'Search the company knowledge base. Use it before answering any question about the company, its products, services, prices, opening hours, policies or location.',
```

`apps/api/src/agent/engine.ts` — replace the `RULES` and `TEXT_ONLY_RULES` constants with:

```ts
/** Tool-capable models must look facts up instead of answering from memory. */
export const SEARCH_RULE =
  '- Before answering any question about the company, its products, services, prices, opening hours, policies or location, call search_knowledge and answer only from what it returns. Never invent prices or facts.'

const RULES = [
  'Rules:',
  SEARCH_RULE,
  '- If search_knowledge returns nothing useful, if you cannot answer confidently, or if the customer wants a human, a complaint, a cancellation or a refund, call transfer_to_human.',
  '- Reply in the language the customer writes in. Keep answers short.',
].join('\n')

/** For models without tools: facts come only from the passages below, and a person takes over what they do not cover. */
const TEXT_ONLY_RULES = [
  'Rules:',
  '- Answer questions about the company, its products, services, prices, opening hours, policies or location only from the knowledge base passages below. Never invent prices or facts.',
  '- If the passages do not answer the question, say that a person from the team will follow up.',
  '- Reply in the language the customer writes in. Keep answers short.',
].join('\n')
```

Add after `passagesBlock`:

```ts
/** The system prompt: the configured instructions, then the rules; text-only models also get the matching passages. */
export function buildSystemPrompt(instructions: string, textOnly: boolean, knowledge: Passage[], query: string): string {
  return textOnly
    ? `${instructions}\n\n${TEXT_ONLY_RULES}\n\n${passagesBlock(knowledge, query)}`
    : `${instructions}\n\n${RULES}`
}
```

In `runAgentTurn`, replace the `const system = …` statement with:

```ts
  const query = pending.map(wordsOf).filter(Boolean).join(' ')
  const textOnly = !!deps.provider.textOnly
  const system = buildSystemPrompt(settings.instructions, textOnly, deps.knowledge(), query)
  // If the provider drops tools mid-request (Ollama), it needs the prompt with the passages.
  const textOnlySystem = textOnly ? undefined : buildSystemPrompt(settings.instructions, true, deps.knowledge(), query)
```

and the provider call with:

```ts
      const result = await withTimeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, (signal) =>
        deps.provider.generate({ system, ...(textOnlySystem ? { textOnlySystem } : {}), messages: chat, tools: TOOL_SPECS, signal }))
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w apps/api`
Expected: all PASS. Then `grep -rn "prices, plans, rooms" apps/api/src apps/api/test` → no matches.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/agent apps/api/test
git commit -m "feat(agent): ask for a knowledge search on any company question; text-only fallback gets the passages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: A refusal is a handoff with its own reason, not a provider failure

Today a Claude refusal is logged as `failed` with the reason "The AI provider failed", which reads like an outage in the inbox. A refusal is the model's decision: the customer still gets the handoff message, but the run is `transferred` and the inbox says why.

**Files:**
- Modify: `apps/api/src/agent/engine.ts`
- Test: `apps/api/test/providers-engine.test.ts`

**Interfaces:**
- Consumes: `ProviderError` (`apps/api/src/agent/providers/errors.ts`), codes ending in `_refusal`.
- Produces: `export const REFUSAL_REASON = 'The AI model declined to answer'`.

- [ ] **Step 1: Change the test**

In `apps/api/test/providers-engine.test.ts`, change the engine import to include `REFUSAL_REASON` and replace the test `'Claude: a refusal hands off'` with:

```ts
  it('Claude: a refusal hands off as a transfer with its own reason', async () => {
    const { provider } = claude([{ body: fixture('claude/refusal.json') }])
    await setup(provider)
    const id = ask('How much is a meeting room?')
    expect((await runAgentTurn(deps, id)).outcome).toBe('transferred')
    const { conversation, messages } = getConversation(deps, id)!
    expect(conversation).toMatchObject({ status: 'waiting_human', handoffReason: REFUSAL_REASON })
    expect(messages.at(-1)).toMatchObject({ sender: 'agent' })
    expect(listRuns(deps.db, id)[0]).toMatchObject({ outcome: 'transferred', error: 'claude_refusal' })
  })
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -w apps/api -- test/providers-engine.test.ts`
Expected: FAIL (`REFUSAL_REASON` is not exported; outcome is `failed`).

- [ ] **Step 3: Implement**

In `apps/api/src/agent/engine.ts` add the import `import { ProviderError } from './providers/errors'`, add near the other constants:

```ts
/** Shown in the inbox when the model refuses: it is the model's decision, not an outage. */
export const REFUSAL_REASON = 'The AI model declined to answer'
```

and replace the whole `catch (err) { … }` block of `runAgentTurn` with:

```ts
  } catch (err) {
    const error = err instanceof TimeoutError ? 'timeout' : String((err as Error)?.message ?? err).slice(0, 200)
    const refused = err instanceof ProviderError && err.code.endsWith('_refusal')
    try {
      if (stillFree()) await handOff(deps, conversationId, refused ? REFUSAL_REASON : 'The AI provider failed', settings.handoffMessage)
    } catch (handoffErr) {
      console.error('[relay] handoff after provider failure failed', conversationId, handoffErr)
    }
    return log(refused ? 'transferred' : 'failed', error)
  }
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w apps/api`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/agent/engine.ts apps/api/test/providers-engine.test.ts
git commit -m "feat(agent): a model refusal is logged as a transfer with its own reason

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `try-provider` runs one real agent turn, and is tested without a key

`scripts/try-provider.ts` sends a hand-written prompt, so a live check with a real key does not exercise the app's prompt, tools or knowledge. It now runs one full agent turn on a throwaway in-memory database; the same function is tested with recorded responses, so CI covers it with no key.

**Files:**
- Create: `apps/api/src/agent/tryProvider.ts`
- Modify: `apps/api/scripts/try-provider.ts`
- Test: `apps/api/test/try-provider.test.ts` (create)

**Interfaces:**
- Consumes: `selectProvider(env, { fetch })`, `agentTimeoutMs`, `runAgentTurn`, `receiveInbound`, `getConversation`, `listRuns`, `loadKnowledge`.
- Produces: `type TryResult = { provider: string; model: string | null; outcome: 'replied' | 'transferred' | 'failed' | 'skipped'; reply: string | null; error: string | null; durationMs: number; inputTokens: number | null; outputTokens: number | null }`; `tryProvider(env: NodeJS.ProcessEnv, question: string, opts: { knowledgeDir: string; fetch?: FetchLike }): Promise<TryResult>`.

- [ ] **Step 1: Write the failing test**

`apps/api/test/try-provider.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { tryProvider } from '../src/agent/tryProvider'
import { SEARCH_RULE } from '../src/agent/engine'
import { fakeFetch, fixture } from './fake-fetch'

const knowledgeDir = fileURLToPath(new URL('../knowledge', import.meta.url))

describe('tryProvider', () => {
  it('runs a full turn on the demo provider with no configuration', async () => {
    const r = await tryProvider({}, 'What are your opening hours?', { knowledgeDir })
    expect(r).toMatchObject({ provider: 'demo', model: 'scripted', outcome: 'replied', error: null })
    expect(r.reply).toMatch(/^Here is what I found about/)
  })

  it('runs Claude with the app prompt and tools, over recorded responses', async () => {
    const answer = fixture('claude/answer.json')
    const f = fakeFetch([{ body: fixture('claude/tool-use.json') }, { body: answer }])
    const r = await tryProvider({ ANTHROPIC_API_KEY: 'test-key' }, 'How much is a meeting room?', { knowledgeDir, fetch: f.fetch })
    expect(r).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5-5', outcome: 'replied', reply: answer.content[1].text, inputTokens: 912 + 1040 })
    expect(f.requests[0]!.body.system).toContain(SEARCH_RULE)
    expect(f.requests[0]!.body.tools.map((t: { name: string }) => t.name)).toContain('search_knowledge')
  })

  it('reports a provider failure with its stable code', async () => {
    const f = fakeFetch([
      { status: 401, body: fixture('claude/auth.json') },
    ])
    const r = await tryProvider({ ANTHROPIC_API_KEY: 'bad-key' }, 'Hello?', { knowledgeDir, fetch: f.fetch })
    expect(r.outcome).toBe('failed')
    expect(r.error).toMatch(/^claude_auth/)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -w apps/api -- test/try-provider.test.ts`
Expected: FAIL (`Cannot find module '../src/agent/tryProvider'`).

- [ ] **Step 3: Implement**

`apps/api/src/agent/tryProvider.ts`:

```ts
import { createDb } from '../db/client'
import { seed } from '../db/seed'
import { EventBus } from '../core/events'
import { ChannelRegistry } from '../channels/types'
import { getConversation, receiveInbound } from '../core/conversations'
import { loadKnowledge } from './knowledge'
import { runAgentTurn, type TurnResult } from './engine'
import { listRuns } from './runs'
import { agentTimeoutMs, selectProvider } from './providers'
import type { FetchLike } from './providers/types'

export type TryResult = {
  provider: string
  model: string | null
  outcome: TurnResult['outcome']
  reply: string | null
  error: string | null
  durationMs: number
  inputTokens: number | null
  outputTokens: number | null
}

/**
 * One full agent turn — the app's real prompt, tools, knowledge and error handling — with the provider selected
 * from `env`, on a throwaway in-memory database. Used by `npm run try-provider`; tests pass a recorded `fetch`.
 */
export async function tryProvider(
  env: NodeJS.ProcessEnv,
  question: string,
  opts: { knowledgeDir: string; fetch?: FetchLike },
): Promise<TryResult> {
  const db = createDb(':memory:')
  await seed(db)
  const channels = new ChannelRegistry()
  channels.register({ id: 'widget', send: async () => {} })
  const provider = selectProvider(env, { fetch: opts.fetch })
  const passages = loadKnowledge(opts.knowledgeDir)
  const deps = { db, bus: new EventBus(), channels, provider, knowledge: () => passages, timeoutMs: agentTimeoutMs(env, provider) }
  const { conversation } = receiveInbound(deps, { channel: 'widget', contactKey: 'try-provider', type: 'text', text: question })
  const result = await runAgentTurn(deps, conversation.id)
  const last = getConversation(deps, conversation.id)!.messages.at(-1)
  const run = listRuns(db, conversation.id)[0]
  return {
    provider: provider.id,
    model: provider.model,
    outcome: result.outcome,
    reply: last && last.sender !== 'contact' ? last.text : null,
    error: run?.error ?? null,
    durationMs: run?.durationMs ?? 0,
    inputTokens: run?.inputTokens ?? null,
    outputTokens: run?.outputTokens ?? null,
  }
}
```

`apps/api/scripts/try-provider.ts` (whole file):

```ts
/**
 * Runs one full agent turn with the provider selected from the environment and prints the result.
 * With a key or a running Ollama it makes real requests; it is never part of the test suite.
 *   ANTHROPIC_API_KEY=... npm run try-provider -w apps/api -- "How much is a meeting room?"
 */
import { fileURLToPath } from 'node:url'
import { tryProvider } from '../src/agent/tryProvider'

const question = process.argv.slice(2).join(' ').trim() || 'How much is a meeting room?'
const knowledgeDir = process.env.RELAY_KNOWLEDGE_DIR?.trim() || fileURLToPath(new URL('../knowledge', import.meta.url))
const r = await tryProvider(process.env, question, { knowledgeDir })
const tokens = r.inputTokens !== null && r.outputTokens !== null ? `, ${r.inputTokens}/${r.outputTokens} tokens` : ''
console.log(`provider: ${r.provider} (${r.model ?? 'n/a'})`)
console.log(`outcome: ${r.outcome}${r.error ? ` (${r.error})` : ''}, ${r.durationMs} ms${tokens}`)
if (r.reply) console.log(`\n${r.reply}`)
process.exitCode = r.outcome === 'failed' ? 1 : 0
```

- [ ] **Step 4: Run the tests and the script**

Run: `npm test -w apps/api -- test/try-provider.test.ts` → PASS.
Run: `npm run try-provider -w apps/api -- "What are your opening hours?"` (no variables set)
Expected output starts with `provider: demo (scripted)` and `outcome: replied`, then the opening hours passage.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/agent/tryProvider.ts apps/api/scripts/try-provider.ts apps/api/test/try-provider.test.ts
git commit -m "feat(api): try-provider runs one full agent turn and is tested over recorded responses

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Security headers, JSON 404s, the request logger and validated configuration

**Files:**
- Create: `apps/api/src/config.ts`, `apps/api/src/http/security.ts`
- Modify: `apps/api/src/server.ts`, `apps/api/src/main.ts`, `apps/api/src/auth/password.ts`, `apps/api/src/auth/routes.ts`, `apps/api/test/helpers.ts`
- Test: `apps/api/test/hardening.test.ts` (create), `apps/api/test/config.test.ts` (create), `apps/api/test/password.test.ts`

**Interfaces:**
- Produces:
  - `config.ts`: `readPort(raw: string | undefined, fallback?: number): number` (throws on anything but an integer 1–65535; blank → fallback); `readList(raw: string | undefined): string[]` (comma-separated, trimmed, blanks dropped); `readFlag(raw: string | undefined): boolean` (`1`, `true`, `yes`, case-insensitive).
  - `http/security.ts`: `API_SECURITY_HEADERS: Record<string, string>`; `securityHeaders(app): void`; `notFoundHandler(req, reply)`; `redactUrl(url: string): string` (drops the query string).
  - `server.ts`: `export type ServerOptions = { widget?; mediaDir?; knowledge?; logger?: FastifyServerOptions['logger']; trustProxy?: boolean }`; `buildServer(deps, opts?: ServerOptions)`.
  - `test/helpers.ts`: `testServer(opts?: { fakeWidget?: boolean; knowledgeDir?: string; server?: ServerOptions })`.

- [ ] **Step 1: Write the failing tests**

`apps/api/test/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFlag, readList, readPort } from '../src/config'
import { redactUrl } from '../src/http/security'

describe('configuration values', () => {
  it('readPort accepts 1-65535 and falls back when blank', () => {
    expect(readPort(undefined)).toBe(3000)
    expect(readPort('  ', 8080)).toBe(8080)
    expect(readPort('3010')).toBe(3010)
    for (const bad of ['0', '65536', '30.5', 'abc', '-1']) expect(() => readPort(bad)).toThrow(/PORT must be an integer/)
  })

  it('readList splits on commas and drops blanks', () => {
    expect(readList(undefined)).toEqual([])
    expect(readList(' http://a.test , ,http://b.test ')).toEqual(['http://a.test', 'http://b.test'])
  })

  it('readFlag understands 1, true and yes', () => {
    for (const on of ['1', 'true', 'TRUE', 'yes']) expect(readFlag(on)).toBe(true)
    for (const off of [undefined, '', '0', 'false', 'no']) expect(readFlag(off)).toBe(false)
  })

  it('redactUrl drops the query string, where visitor tokens travel', () => {
    expect(redactUrl('/ws/widget?token=secret&name=Ana')).toBe('/ws/widget')
    expect(redactUrl('/api/health')).toBe('/api/health')
  })
})
```

`apps/api/test/hardening.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { testServer } from './helpers'
import { API_SECURITY_HEADERS } from '../src/http/security'

describe('HTTP hardening', () => {
  it('every API response carries the security headers, errors included', async () => {
    const { app } = await testServer()
    for (const url of ['/api/health', '/api/auth/me', '/api/nope']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.headers).toMatchObject(API_SECURITY_HEADERS)
    }
  })

  it('unknown routes answer 404 with a stable code', async () => {
    const { app } = await testServer()
    const res = await app.inject({ method: 'POST', url: '/api/does-not-exist' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'Not found', code: 'not_found' })
  })

  it('a malformed email is a validation error', async () => {
    const { app } = await testServer()
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'not-an-email', password: 'x' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'invalid_request', fields: ['email'] })
  })
})
```

Append to `apps/api/test/password.test.ts` (inside the file's `describe`, or at the end of the file if it has none):

```ts
it('a stored hash with an empty or non-hex key never matches', async () => {
  expect(await verifyPassword('anything', 'scrypt$00$')).toBe(false)
  expect(await verifyPassword('anything', 'scrypt$00$zz')).toBe(false)
})
```

(If `verifyPassword` is not imported in that file yet, add `import { verifyPassword } from '../src/auth/password'`.)

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -w apps/api -- test/config.test.ts test/hardening.test.ts test/password.test.ts`
Expected: FAIL (modules missing; no security headers; Fastify's default 404 body; `scrypt$00$zz` matches because both keys are empty).

- [ ] **Step 3: Implement**

`apps/api/src/config.ts`:

```ts
/** Environment values, validated once at startup so a typo fails loudly instead of misbehaving later. */

export function readPort(raw: string | undefined, fallback = 3000): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw.trim())
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`PORT must be an integer from 1 to 65535, got "${raw}"`)
  return n
}

export function readList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}

export function readFlag(raw: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes((raw ?? '').trim().toLowerCase())
}
```

`apps/api/src/http/security.ts`:

```ts
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
```

`apps/api/src/server.ts` (whole file):

```ts
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import cookie from '@fastify/cookie'
import websocket from '@fastify/websocket'
import { registerErrorHandler } from './http/errors'
import { notFoundHandler, securityHeaders } from './http/security'
import { authRoutes } from './auth/routes'
import { conversationRoutes } from './core/routes'
import { settingsRoutes } from './core/settingsRoutes'
import { inboxSocket } from './realtime/inbox'
import { widgetAudioRoute, widgetSocket, type WidgetChannel } from './channels/widget'
import { mediaRoutes } from './media/routes'
import { knowledgeRoutes } from './agent/knowledgeRoutes'
import type { KnowledgeStore } from './agent/knowledgeStore'
import type { CoreDeps } from './core/conversations'

/** Max inbound WebSocket frame size; ws's default (100 MiB) is far too large for a public endpoint. */
export const WS_MAX_PAYLOAD = 64 * 1024

export type ServerDeps = CoreDeps

export type ServerOptions = {
  widget?: WidgetChannel
  mediaDir?: string
  knowledge?: KnowledgeStore
  /** Fastify logger options; off when not given (tests). */
  logger?: FastifyServerOptions['logger']
  /** Trust X-Forwarded-* from the reverse proxy (nginx in Docker): real client IPs and HTTPS detection. */
  trustProxy?: boolean
}

export async function buildServer(deps: ServerDeps, opts: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: opts.trustProxy ?? false })
  securityHeaders(app)
  await app.register(cookie)
  await app.register(websocket, { options: { maxPayload: WS_MAX_PAYLOAD } })
  app.get('/api/health', async () => ({ ok: true }))
  registerErrorHandler(app)
  app.setNotFoundHandler(notFoundHandler)
  authRoutes(app, deps.db)
  conversationRoutes(app, deps)
  settingsRoutes(app, deps.db)
  inboxSocket(app, deps)
  if (opts.widget) widgetSocket(app, deps, opts.widget)
  if (opts.mediaDir) {
    mediaRoutes(app, deps, opts.mediaDir)
    if (opts.widget) await widgetAudioRoute(app, deps, opts.widget, opts.mediaDir)
  }
  if (opts.knowledge) knowledgeRoutes(app, deps.db, opts.knowledge)
  return app
}
```

`apps/api/src/auth/password.ts` — in `verifyPassword`, after `const expected = Buffer.from(keyHex, 'hex')` add:

```ts
  if (expected.length === 0) return false // an empty or non-hex key would compare two empty buffers as equal
```

`apps/api/src/auth/routes.ts` — the login schema becomes:

```ts
const LoginBody = z.object({ email: z.email(), password: z.string().min(1) })
```

`apps/api/src/main.ts`:
- add imports `import { readFlag, readPort } from './config'` and `import { redactUrl } from './http/security'`;
- replace the `buildServer` call and the port lines with:

```ts
const port = readPort(env('PORT'))
const app = await buildServer({ db, bus, channels }, {
  widget, mediaDir, knowledge,
  trustProxy: readFlag(env('RELAY_TRUST_PROXY')),
  logger: {
    level: env('RELAY_LOG_LEVEL') ?? 'info',
    serializers: { req: (req: { method: string; url: string; ip?: string }) => ({ method: req.method, url: redactUrl(req.url), remoteAddress: req.ip }) },
  },
})
await app.listen({ port, host: env('HOST') ?? '0.0.0.0' })
console.log(`[relay] api listening on :${port}`)
```

`apps/api/test/helpers.ts` — change the signature and the `buildServer` call:

```ts
import { buildServer, type ServerOptions } from '../src/server'
// …
export async function testServer(opts: { fakeWidget?: boolean; knowledgeDir?: string; server?: ServerOptions } = { fakeWidget: true }) {
  // … unchanged until:
  const app = await buildServer(deps, { ...opts.server, ...(knowledge ? { knowledge } : {}) })
```

- [ ] **Step 4: Run every API test and the type check**

Run: `npm test -w apps/api` → all PASS (if an older test expected Fastify's default 404 body, update it to `{ error: 'Not found', code: 'not_found' }`).
Run: `npm run typecheck -w apps/api` → clean.
Run: `PORT=abc npm run start -w apps/api` → exits at once with `PORT must be an integer from 1 to 65535, got "abc"`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(api): security headers, JSON 404s, request log without query strings, validated PORT

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Rate limits, a per-visitor socket cap and an Origin check on WebSockets

The public endpoints (login, the widget socket, the audio upload) get fixed-window limits per client IP; tokens are free to mint, so the IP is the key. A visitor may keep at most 5 widget sockets open. Browsers must open `/ws/*` from the page's own origin (or one listed in `RELAY_ALLOWED_ORIGINS`); clients that send no Origin header (not browsers) are still allowed, since they also need a session cookie or a visitor token.

**Files:**
- Create: `apps/api/src/http/rateLimit.ts`, `apps/api/src/http/origin.ts`
- Modify: `apps/api/src/server.ts`, `apps/api/src/main.ts`, `apps/api/src/auth/routes.ts`, `apps/api/src/channels/widget.ts`, `apps/api/src/realtime/inbox.ts`, `apps/web/src/live.ts`, `apps/web/src/components/Widget.tsx`
- Test: `apps/api/test/rate-limit.test.ts` (create), `apps/web/test/live.test.tsx` (create), `apps/web/test/Widget.test.tsx`

**Interfaces:**
- Produces:
  - `rateLimit.ts`: `class RateLimiter { constructor(limit: number, windowMs: number, now?: () => number); take(key: string): number }` — `take` counts one hit and returns 0 when allowed, otherwise the ms until the window resets; `type Limits = { login: RateLimiter; widgetMessages: RateLimiter; widgetAudio: RateLimiter }`; `defaultLimits(): Limits` (login 10 per 5 min, widget messages 30 per min, audio uploads 6 per min); `tooManyRequests(reply, waitMs)` → `429 { error: 'Too many requests', code: 'rate_limited' }` with `Retry-After` in seconds.
  - `origin.ts`: `originAllowed(origin: string | undefined, host: string | undefined, allowed: string[]): boolean`.
  - `ServerOptions` gains `allowedOrigins?: string[]` and `limits?: Limits`.
  - `widget.ts`: `MAX_SOCKETS_PER_VISITOR = 5`; `WidgetChannel.connections(contactKey): number`; `widgetSocket(app, deps, widget, opts: { allowedOrigins: string[]; messageLimiter: RateLimiter })`; `widgetAudioRoute(app, deps, widget, mediaDir, limiter: RateLimiter)`. Close codes: `4403 forbidden_origin`, `4429 too_many_connections`. Error frame `{ type: 'error', code: 'rate_limited' }`.
  - `inbox.ts`: `inboxSocket(app, deps, opts: { allowedOrigins: string[] })`.
  - `authRoutes(app, db, opts: { loginLimiter: RateLimiter })`.
  - Web: `connectLive` stops reconnecting on 4403; the widget shows `You are sending messages too fast. Wait a moment.` (role `alert`) for a `rate_limited` frame or a 429 upload.

- [ ] **Step 1: Write the failing API tests**

`apps/api/test/rate-limit.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '../src/db/client'
import { seed, DEMO_USER } from '../src/db/seed'
import { EventBus } from '../src/core/events'
import { ChannelRegistry } from '../src/channels/types'
import { WidgetChannel, MAX_SOCKETS_PER_VISITOR } from '../src/channels/widget'
import { buildServer } from '../src/server'
import { RateLimiter, defaultLimits, type Limits } from '../src/http/rateLimit'
import { originAllowed } from '../src/http/origin'
import { testServer } from './helpers'

const TOKEN = 'v'.repeat(32)

async function widgetServer(limits: Partial<Limits> = {}, allowedOrigins: string[] = []) {
  const db = createDb(':memory:')
  await seed(db)
  const channels = new ChannelRegistry()
  const widget = new WidgetChannel()
  channels.register(widget)
  const deps = { db, bus: new EventBus(), channels }
  const mediaDir = mkdtempSync(join(tmpdir(), 'relay-limits-'))
  const app = await buildServer(deps, { widget, mediaDir, limits: { ...defaultLimits(), ...limits }, allowedOrigins })
  await app.ready()
  return { app, deps }
}

const closeCode = (ws: { once(ev: 'close', fn: (code: number) => void): void }) =>
  new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))

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

describe('RateLimiter', () => {
  it('allows `limit` hits per window and then reports the wait', () => {
    let now = 0
    const l = new RateLimiter(2, 1000, () => now)
    expect(l.take('a')).toBe(0)
    expect(l.take('a')).toBe(0)
    expect(l.take('a')).toBe(1000)
    expect(l.take('b')).toBe(0)
    now = 400
    expect(l.take('a')).toBe(600)
    now = 1000
    expect(l.take('a')).toBe(0)
  })
})

describe('originAllowed', () => {
  it('allows no Origin, the same host, and listed origins only', () => {
    expect(originAllowed(undefined, 'localhost:8080', [])).toBe(true)
    expect(originAllowed('http://localhost:8080', 'localhost:8080', [])).toBe(true)
    expect(originAllowed('http://evil.example', 'localhost:8080', [])).toBe(false)
    expect(originAllowed('http://localhost:5173', 'api:3000', ['http://localhost:5173'])).toBe(true)
    expect(originAllowed('not a url', 'localhost:8080', [])).toBe(false)
  })
})

describe('limits on public endpoints', () => {
  it('login answers 429 with Retry-After after too many attempts from one address', async () => {
    const { app } = await testServer({ fakeWidget: true, server: { limits: { ...defaultLimits(), login: new RateLimiter(2, 60_000) } } })
    const attempt = (remoteAddress = '127.0.0.1') =>
      app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress, payload: { email: DEMO_USER.email, password: 'nope' } })
    expect((await attempt()).statusCode).toBe(401)
    expect((await attempt()).statusCode).toBe(401)
    const blocked = await attempt()
    expect(blocked.statusCode).toBe(429)
    expect(blocked.headers['retry-after']).toBe('60')
    expect(blocked.json()).toEqual({ error: 'Too many requests', code: 'rate_limited' })
    expect((await attempt('203.0.113.7')).statusCode).toBe(401) // TEST-NET-3: a documentation address
  })

  it('widget messages beyond the limit get an error frame and are not stored', async () => {
    const { app } = await widgetServer({ widgetMessages: new RateLimiter(2, 60_000) })
    const ws = await app.injectWS(`/ws/widget?token=${TOKEN}`)
    const next = frames(ws)
    expect((await next()).type).toBe('history')
    for (const text of ['one', 'two', 'three']) ws.send(JSON.stringify({ type: 'text', text }))
    expect((await next()).message.text).toBe('one')
    expect((await next()).message.text).toBe('two')
    expect(await next()).toEqual({ type: 'error', code: 'rate_limited' })
    ws.terminate()
  })

  it('audio uploads beyond the limit answer 429', async () => {
    const { app } = await widgetServer({ widgetAudio: new RateLimiter(1, 60_000) })
    const upload = () => app.inject({
      method: 'POST', url: '/api/widget/audio',
      headers: { 'content-type': 'audio/webm', 'x-relay-visitor': TOKEN }, payload: Buffer.from('fake audio'),
    })
    expect((await upload()).statusCode).toBe(201)
    const blocked = await upload()
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json().code).toBe('rate_limited')
  })

  it(`a visitor may keep ${MAX_SOCKETS_PER_VISITOR} widget sockets open, not more`, async () => {
    const { app } = await widgetServer()
    const open = []
    for (let i = 0; i < MAX_SOCKETS_PER_VISITOR; i++) open.push(await app.injectWS(`/ws/widget?token=${TOKEN}`))
    const extra = await app.injectWS(`/ws/widget?token=${TOKEN}`)
    expect(await closeCode(extra)).toBe(4429)
    for (const ws of open) ws.terminate()
  })

  it('browsers from another origin cannot open /ws/widget or /ws/inbox', async () => {
    const { app } = await widgetServer()
    const widget = await app.injectWS(`/ws/widget?token=${TOKEN}`, { headers: { origin: 'http://evil.example' } })
    expect(await closeCode(widget)).toBe(4403)
    const inbox = await app.injectWS('/ws/inbox', { headers: { origin: 'http://evil.example' } })
    expect(await closeCode(inbox)).toBe(4403)
  })

  it('an origin in the allow list may open /ws/widget', async () => {
    const { app } = await widgetServer({}, ['http://localhost:5173'])
    const ws = await app.injectWS(`/ws/widget?token=${TOKEN}`, { headers: { origin: 'http://localhost:5173' } })
    const next = frames(ws)
    expect((await next()).type).toBe('history')
    ws.terminate()
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -w apps/api -- test/rate-limit.test.ts`
Expected: FAIL (`Cannot find module '../src/http/rateLimit'`).

- [ ] **Step 3: Implement the API side**

`apps/api/src/http/rateLimit.ts`:

```ts
import type { FastifyReply } from 'fastify'

/** Keys kept before expired windows are swept; bounds memory under a flood of distinct addresses. */
const SWEEP_AT = 10_000

/** Fixed-window counter per key, in memory: Relay runs as one API process. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>()

  constructor(readonly limit: number, readonly windowMs: number, private readonly now: () => number = Date.now) {}

  /** Counts one hit for `key`. Returns 0 when it is allowed, otherwise the ms until the window resets. */
  take(key: string): number {
    const t = this.now()
    let entry = this.hits.get(key)
    if (!entry || entry.resetAt <= t) {
      if (this.hits.size >= SWEEP_AT) this.sweep(t)
      entry = { count: 0, resetAt: t + this.windowMs }
      this.hits.set(key, entry)
    }
    entry.count++
    return entry.count > this.limit ? entry.resetAt - t : 0
  }

  private sweep(t: number) {
    for (const [key, entry] of this.hits) if (entry.resetAt <= t) this.hits.delete(key)
  }
}

export type Limits = { login: RateLimiter; widgetMessages: RateLimiter; widgetAudio: RateLimiter }

/** Generous for people, tight for scripts: a public demo must survive someone looping on it. */
export function defaultLimits(): Limits {
  return {
    login: new RateLimiter(10, 5 * 60_000),
    widgetMessages: new RateLimiter(30, 60_000),
    widgetAudio: new RateLimiter(6, 60_000),
  }
}

export function tooManyRequests(reply: FastifyReply, waitMs: number) {
  return reply.code(429).header('retry-after', String(Math.ceil(waitMs / 1000)))
    .send({ error: 'Too many requests', code: 'rate_limited' })
}
```

`apps/api/src/http/origin.ts`:

```ts
/**
 * WebSockets are not covered by CORS: a page on another site could open /ws/* with the user's cookie.
 * Browsers always send Origin; it must match the Host the request came to, or be listed in RELAY_ALLOWED_ORIGINS.
 * No Origin means a non-browser client, which still needs a session cookie or a visitor token.
 */
export function originAllowed(origin: string | undefined, host: string | undefined, allowed: string[]): boolean {
  if (!origin) return true
  if (allowed.includes(origin)) return true
  try {
    return !!host && new URL(origin).host === host
  } catch {
    return false
  }
}
```

`apps/api/src/auth/routes.ts`:
- imports: add `import { tooManyRequests, type RateLimiter } from '../http/rateLimit'`;
- signature: `export function authRoutes(app: FastifyInstance, db: Db, opts: { loginLimiter: RateLimiter }) {`;
- first lines of the login handler:

```ts
  app.post('/api/auth/login', async (req, reply) => {
    const wait = opts.loginLimiter.take(req.ip)
    if (wait) return tooManyRequests(reply, wait)
    const body = { data: LoginBody.parse(req.body) } // a ZodError becomes 400 invalid_request in the error handler
```

`apps/api/src/realtime/inbox.ts` (whole file):

```ts
import type { FastifyInstance } from 'fastify'
import type { CoreDeps } from '../core/conversations'
import type { RelayEvents } from '../core/events'
import { SESSION_COOKIE } from '../auth/guard'
import { userForSession } from '../auth/sessions'
import { originAllowed } from '../http/origin'

const EVENTS: Array<keyof RelayEvents> = ['message.created', 'message.updated', 'conversation.updated', 'agent.run.created']

export type InboxSocketOptions = { allowedOrigins: string[] }

export function inboxSocket(app: FastifyInstance, deps: CoreDeps, opts: InboxSocketOptions) {
  app.get('/ws/inbox', { websocket: true }, (socket, req) => {
    if (!originAllowed(req.headers.origin, req.headers.host, opts.allowedOrigins)) { socket.close(4403, 'forbidden_origin'); return }
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

`apps/api/src/channels/widget.ts`:
- imports: add `import { originAllowed } from '../http/origin'` and `import { tooManyRequests, type RateLimiter } from '../http/rateLimit'`;
- after `VISITOR_HEADER` add:

```ts
/** A visitor may keep this many widget sockets open (tabs); more are refused with 4429. */
export const MAX_SOCKETS_PER_VISITOR = 5
```

- in `WidgetChannel`, add the method:

```ts
  connections(contactKey: string): number {
    return this.sockets.get(contactKey)?.size ?? 0
  }
```

- replace `widgetSocket` with:

```ts
export type WidgetSocketOptions = { allowedOrigins: string[]; messageLimiter: RateLimiter }

export function widgetSocket(app: FastifyInstance, deps: CoreDeps, widget: WidgetChannel, opts: WidgetSocketOptions) {
  app.get('/ws/widget', { websocket: true }, (socket, req) => {
    if (!originAllowed(req.headers.origin, req.headers.host, opts.allowedOrigins)) { socket.close(4403, 'forbidden_origin'); return }
    const q = Query.safeParse(req.query)
    if (!q.success) { socket.close(4400, 'invalid_token'); return }
    const { token, name } = q.data
    const contactKey = contactKeyFor(token)
    if (widget.connections(contactKey) >= MAX_SOCKETS_PER_VISITOR) { socket.close(4429, 'too_many_connections'); return }
    const detach = widget.attach(contactKey, socket)
    const history = historyForContact(deps, 'widget', contactKey).map(toVisitorMessage)
    setImmediate(() => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'history', messages: history }))
    })

    socket.on('message', (raw) => {
      if (opts.messageLimiter.take(req.ip)) {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'error', code: 'rate_limited' }))
        return
      }
      let frame: z.infer<typeof Frame>
      try {
        frame = Frame.parse(JSON.parse(raw.toString()))
      } catch {
        socket.send(JSON.stringify({ type: 'error', code: 'invalid_frame' }))
        return
      }
      try {
        const { message } = receiveInbound(deps, { channel: 'widget', contactKey, contactName: name, type: 'text', text: frame.text })
        widget.push(contactKey, { type: 'message', message: toVisitorMessage(message) })
      } catch (err) {
        console.error('[relay] widget message failed', err)
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'error', code: 'internal' }))
      }
    })
    socket.on('close', detach)
  })
}
```

- `widgetAudioRoute` gets a `limiter` parameter, checked first:

```ts
export async function widgetAudioRoute(app: FastifyInstance, deps: CoreDeps, widget: WidgetChannel, mediaDir: string, limiter: RateLimiter) {
  await app.register(async (scope) => {
    // Scoped to this plugin: the rest of the API keeps its JSON parser.
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => { done(null, body) })

    scope.post('/api/widget/audio', { bodyLimit: MAX_AUDIO_BYTES }, async (req, reply) => {
      const wait = limiter.take(req.ip)
      if (wait) return tooManyRequests(reply, wait)
      const token = Token.safeParse(req.headers[VISITOR_HEADER])
```

(the rest of the handler is unchanged).

`apps/api/src/server.ts`:
- imports: add `import { defaultLimits, type Limits } from './http/rateLimit'`;
- `ServerOptions` gains:

```ts
  /** Extra browser origins allowed to open /ws/* (the page's own origin is always allowed). */
  allowedOrigins?: string[]
  /** Rate limits; tests pass small ones. */
  limits?: Limits
```

- in `buildServer`, replace the lines from `authRoutes(…)` to the end of the media block with:

```ts
  const limits = opts.limits ?? defaultLimits()
  const allowedOrigins = opts.allowedOrigins ?? []
  authRoutes(app, deps.db, { loginLimiter: limits.login })
  conversationRoutes(app, deps)
  settingsRoutes(app, deps.db)
  inboxSocket(app, deps, { allowedOrigins })
  if (opts.widget) widgetSocket(app, deps, opts.widget, { allowedOrigins, messageLimiter: limits.widgetMessages })
  if (opts.mediaDir) {
    mediaRoutes(app, deps, opts.mediaDir)
    if (opts.widget) await widgetAudioRoute(app, deps, opts.widget, opts.mediaDir, limits.widgetAudio)
  }
```

`apps/api/src/main.ts`: import `readList` from `./config` too, and add `allowedOrigins: readList(env('RELAY_ALLOWED_ORIGINS')),` to the `buildServer` options.

- [ ] **Step 4: Run the API tests**

Run: `npm test -w apps/api` → all PASS. Run: `npm run typecheck -w apps/api` → clean.

- [ ] **Step 5: Write the failing web tests**

`apps/web/test/live.test.tsx`:

```tsx
import { vi } from 'vitest'
import { connectLive } from '../src/live'

class FakeWs {
  static made: FakeWs[] = []
  readyState = 0
  onopen?: () => void; onmessage?: (e: { data: string }) => void; onclose?: (e: { code: number }) => void
  constructor(public url: string) { FakeWs.made.push(this) }
  send() {}
  close() {}
}

beforeEach(() => { FakeWs.made = []; vi.useFakeTimers(); vi.stubGlobal('WebSocket', FakeWs) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('reconnects after a normal close but not after 4403 (forbidden origin)', () => {
  const live = connectLive('/ws/widget?token=t', () => {})
  FakeWs.made[0]!.onclose?.({ code: 1006 })
  vi.advanceTimersByTime(1000)
  expect(FakeWs.made).toHaveLength(2)
  FakeWs.made[1]!.onclose?.({ code: 4403 })
  vi.advanceTimersByTime(20_000)
  expect(FakeWs.made).toHaveLength(2)
  live.stop()
})
```

Append to `apps/web/test/Widget.test.tsx` inside `describe('Widget', …)`:

```tsx
  it('asks the visitor to slow down on a rate_limited frame', () => {
    render(<Widget company="Acme Coworking" />)
    fireEvent.click(screen.getByRole('button', { name: /chat with us/i }))
    act(() => FakeSocket.last.emit({ type: 'error', code: 'rate_limited' }))
    expect(screen.getByRole('alert')).toHaveTextContent('You are sending messages too fast. Wait a moment.')
  })
```

Run: `npm test -w apps/web -- test/live.test.tsx test/Widget.test.tsx`
Expected: FAIL (a third socket is opened after 4403; the alert says "Your message could not be sent.").

- [ ] **Step 6: Implement the web side**

`apps/web/src/live.ts` — the close handler's stop condition becomes:

```ts
      if (stopped || e.code === 4401 || e.code === 4400 || e.code === 4403) return
```

`apps/web/src/components/Widget.tsx`:
- `type Notice = 'connecting' | 'failed' | 'mic' | 'slow' | null`
- `uploadAudio` returns `'slow'` on 429:

```ts
async function uploadAudio(blob: Blob): Promise<WidgetMessage | 'slow' | null> {
  try {
    const res = await fetch('/api/widget/audio', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/webm', [VISITOR_HEADER]: visitorToken() },
      body: blob,
    })
    if (res.status === 429) return 'slow'
    if (!res.ok) return null
    return ((await res.json()) as { message: WidgetMessage }).message
  } catch {
    return null
  }
}
```

- in the socket effect: `if (frame.type === 'error') setNotice(frame.code === 'rate_limited' ? 'slow' : 'failed')`
- at the end of `toggleRecording`:

```ts
    setSendingAudio(true)
    const result = await uploadAudio(blob)
    setSendingAudio(false)
    if (result === 'slow') setNotice('slow')
    else if (result) setMessages((m) => mergeMessages(m, [result]))
    else setNotice('failed')
```

- with the other notices: `{notice === 'slow' && <p role="alert" className="widget-notice">You are sending messages too fast. Wait a moment.</p>}`

- [ ] **Step 7: Run all tests and the type check**

Run: `npm test && npm run typecheck` → all PASS, clean.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src apps/api/test apps/web/src apps/web/test
git commit -m "feat(api): rate limits on login and the widget, a per-visitor socket cap and an Origin check on /ws

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Session cookie attributes, expired-session purge, and inbox sockets that end with the session

**Files:**
- Create: `apps/api/src/realtime/sessionSockets.ts`
- Modify: `apps/api/src/auth/sessions.ts`, `apps/api/src/auth/routes.ts`, `apps/api/src/realtime/inbox.ts`, `apps/api/src/server.ts`, `apps/api/src/main.ts`
- Test: `apps/api/test/sessions.test.ts` (create)

**Interfaces:**
- Produces:
  - `sessions.ts`: `SESSION_MAX_AGE_S = 604800`; `purgeExpiredSessions(db: Db, now?: Date): number` (called by `createSession` and at startup).
  - `sessionSockets.ts`: `class SessionSockets { add(token: string, socket: WebSocket): () => void; closeAll(token: string): void }` — closes with `4401 unauthenticated`.
  - Cookie: `relay_session` with `HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`, plus `Secure` when the request came over HTTPS (`secure: 'auto'`; behind nginx this needs `trustProxy`).
  - `inboxSocket(app, deps, opts: { allowedOrigins: string[]; sessions: SessionSockets; sessionCheckMs?: number })`, `SESSION_CHECK_MS = 60_000`.
  - `authRoutes(app, db, opts: { loginLimiter: RateLimiter; sessions: SessionSockets })`.
  - `ServerOptions.sessionCheckMs?: number`.

- [ ] **Step 1: Write the failing tests**

`apps/api/test/sessions.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createDb } from '../src/db/client'
import { seed, DEMO_USER } from '../src/db/seed'
import { sessions, users } from '../src/db/schema'
import { createSession, purgeExpiredSessions } from '../src/auth/sessions'
import { testServer } from './helpers'

const closeCode = (ws: { once(ev: 'close', fn: (code: number) => void): void }) =>
  new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))

describe('sessions', () => {
  it('the cookie lasts 7 days, is httpOnly and SameSite=Lax, and is Secure over HTTPS', async () => {
    const { app } = await testServer({ fakeWidget: true, server: { trustProxy: true } })
    const login = (headers: Record<string, string> = {}) => app.inject({
      method: 'POST', url: '/api/auth/login', headers, payload: { email: DEMO_USER.email, password: DEMO_USER.password },
    })
    const plain = String((await login()).headers['set-cookie'])
    expect(plain).toMatch(/Max-Age=604800/)
    expect(plain).toMatch(/HttpOnly/)
    expect(plain).toMatch(/SameSite=Lax/)
    expect(plain).not.toMatch(/Secure/)
    expect(String((await login({ 'x-forwarded-proto': 'https' })).headers['set-cookie'])).toMatch(/Secure/)
  })

  it('creating a session purges the expired ones', async () => {
    const db = createDb(':memory:')
    await seed(db)
    const userId = db.select().from(users).get()!.id
    db.insert(sessions).values({ token: 'old', userId, expiresAt: '2000-01-01T00:00:00.000Z' }).run()
    expect(purgeExpiredSessions(db, new Date('1999-01-01'))).toBe(0)
    createSession(db, userId)
    const tokens = db.select().from(sessions).all().map((s) => s.token)
    expect(tokens).toHaveLength(1)
    expect(tokens).not.toContain('old')
  })

  it('an expired session is refused', async () => {
    const { app, db, login } = await testServer()
    const cookie = await login()
    db.update(sessions).set({ expiresAt: '2000-01-01T00:00:00.000Z' }).run()
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401)
  })

  it('signing out closes the inbox sockets of that session', async () => {
    const { app, login } = await testServer()
    await app.ready()
    const cookie = await login()
    const ws = await app.injectWS('/ws/inbox', { headers: { cookie } })
    const closed = closeCode(ws)
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })
    expect(await closed).toBe(4401)
  })

  it('an open inbox socket is closed when its session expires', async () => {
    const { app, db, login } = await testServer({ fakeWidget: true, server: { sessionCheckMs: 20 } })
    await app.ready()
    const cookie = await login()
    const ws = await app.injectWS('/ws/inbox', { headers: { cookie } })
    const closed = closeCode(ws)
    db.update(sessions).set({ expiresAt: '2000-01-01T00:00:00.000Z' }).run()
    expect(await closed).toBe(4401)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -w apps/api -- test/sessions.test.ts`
Expected: FAIL (`purgeExpiredSessions` is not exported; no `Max-Age`; sockets stay open).

- [ ] **Step 3: Implement**

`apps/api/src/auth/sessions.ts` — change the imports and add the purge:

```ts
import { randomBytes } from 'node:crypto'
import { eq, lt } from 'drizzle-orm'
import type { Db } from '../db/client'
import { sessions, users } from '../db/schema'

export type PublicUser = { id: number; email: string; name: string }

const SESSION_DAYS = 7
/** The cookie lives exactly as long as the session row. */
export const SESSION_MAX_AGE_S = SESSION_DAYS * 86_400

/** Deletes sessions past their expiry; returns how many were removed. */
export function purgeExpiredSessions(db: Db, now = new Date()): number {
  return db.delete(sessions).where(lt(sessions.expiresAt, now.toISOString())).run().changes
}

export function createSession(db: Db, userId: number): string {
  purgeExpiredSessions(db)
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString()
  db.insert(sessions).values({ token, userId, expiresAt }).run()
  return token
}
```

(`userForSession` and `deleteSession` are unchanged.)

`apps/api/src/realtime/sessionSockets.ts`:

```ts
import type { WebSocket } from 'ws'

/** Open inbox sockets by session token, so signing out closes them at once. */
export class SessionSockets {
  private byToken = new Map<string, Set<WebSocket>>()

  add(token: string, socket: WebSocket): () => void {
    const set = this.byToken.get(token) ?? new Set<WebSocket>()
    set.add(socket)
    this.byToken.set(token, set)
    return () => {
      set.delete(socket)
      if (set.size === 0) this.byToken.delete(token)
    }
  }

  closeAll(token: string): void {
    for (const socket of [...(this.byToken.get(token) ?? [])]) socket.close(4401, 'unauthenticated')
    this.byToken.delete(token)
  }
}
```

`apps/api/src/realtime/inbox.ts` (whole file):

```ts
import type { FastifyInstance } from 'fastify'
import type { CoreDeps } from '../core/conversations'
import type { RelayEvents } from '../core/events'
import { SESSION_COOKIE } from '../auth/guard'
import { userForSession } from '../auth/sessions'
import { originAllowed } from '../http/origin'
import type { SessionSockets } from './sessionSockets'

const EVENTS: Array<keyof RelayEvents> = ['message.created', 'message.updated', 'conversation.updated', 'agent.run.created']

/** How often an open inbox socket re-checks that its session still exists and has not expired. */
export const SESSION_CHECK_MS = 60_000

export type InboxSocketOptions = { allowedOrigins: string[]; sessions: SessionSockets; sessionCheckMs?: number }

export function inboxSocket(app: FastifyInstance, deps: CoreDeps, opts: InboxSocketOptions) {
  app.get('/ws/inbox', { websocket: true }, (socket, req) => {
    if (!originAllowed(req.headers.origin, req.headers.host, opts.allowedOrigins)) { socket.close(4403, 'forbidden_origin'); return }
    const token = req.cookies[SESSION_COOKIE]
    if (!token || !userForSession(deps.db, token)) { socket.close(4401, 'unauthenticated'); return }
    const untrack = opts.sessions.add(token, socket)
    const timer = setInterval(() => {
      if (!userForSession(deps.db, token)) socket.close(4401, 'unauthenticated')
    }, opts.sessionCheckMs ?? SESSION_CHECK_MS)
    timer.unref()
    const handlers = EVENTS.map((event) => {
      const fn = (data: unknown) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ event, data })) }
      deps.bus.on(event, fn as never)
      return [event, fn] as const
    })
    socket.on('close', () => {
      clearInterval(timer)
      untrack()
      for (const [event, fn] of handlers) deps.bus.off(event, fn as never)
    })
  })
}
```

`apps/api/src/auth/routes.ts`:
- imports: `import { SESSION_MAX_AGE_S, createSession, deleteSession } from './sessions'` and `import type { SessionSockets } from '../realtime/sessionSockets'`;
- signature: `export function authRoutes(app: FastifyInstance, db: Db, opts: { loginLimiter: RateLimiter; sessions: SessionSockets }) {`;
- the cookie line in login:

```ts
    // `secure: 'auto'`: Secure when the request came over HTTPS (behind nginx this relies on trustProxy).
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', secure: 'auto', maxAge: SESSION_MAX_AGE_S })
```

- the logout handler:

```ts
  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE]
    if (token) {
      deleteSession(db, token)
      opts.sessions.closeAll(token)
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return reply.code(204).send()
  })
```

`apps/api/src/server.ts`:
- import `import { SessionSockets } from './realtime/sessionSockets'`;
- `ServerOptions` gains `/** How often an open inbox socket re-checks its session (default 60 s). */ sessionCheckMs?: number`;
- in `buildServer`:

```ts
  const sessions = new SessionSockets()
  authRoutes(app, deps.db, { loginLimiter: limits.login, sessions })
  conversationRoutes(app, deps)
  settingsRoutes(app, deps.db)
  inboxSocket(app, deps, { allowedOrigins, sessions, sessionCheckMs: opts.sessionCheckMs })
```

`apps/api/src/main.ts`: import `purgeExpiredSessions` from `./auth/sessions` and call `purgeExpiredSessions(db)` right after `await seed(db)`.

- [ ] **Step 4: Run all API tests and the type check**

Run: `npm test -w apps/api && npm run typecheck -w apps/api` → all PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(api): 7-day Secure-when-HTTPS session cookie, purge expired sessions, close inbox sockets on sign-out and expiry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Web review findings and the public-demo notice

The plan-5 review found two data-loss bugs: a live refresh caps the list at 100 rows and replaces everything the user loaded beyond that, and typing the name of an existing knowledge file opens a blank editor whose save overwrites the file. The follow-ups also ask `/demo` to say that the conversations are visible to anyone.

**Files:**
- Create: `apps/web/src/inboxList.ts`
- Modify: `apps/web/src/pages/Inbox.tsx`, `apps/web/src/components/KnowledgeEditor.tsx`, `apps/web/src/pages/Demo.tsx`
- Test: `apps/web/test/inboxList.test.tsx` (create), `apps/web/test/KnowledgeEditor.test.tsx`, `apps/web/test/Demo.test.tsx`

**Interfaces:**
- Produces: `mergeRefresh(loaded: ConversationSummary[], loadedCursor: string | null, fresh: ConversationSummary[], freshCursor: string | null): { items: ConversationSummary[]; nextCursor: string | null }`.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/inboxList.test.tsx`:

```tsx
import { mergeRefresh } from '../src/inboxList'
import type { ConversationSummary } from '../src/api'

const row = (id: number, updatedAt: string): ConversationSummary => ({
  id, contactId: id, channel: 'widget', status: 'open', assigneeId: null, agentTurns: 0, tags: [], handoffReason: null,
  createdAt: updatedAt, updatedAt, contactName: null, lastMessage: null, assigneeName: null,
})

describe('mergeRefresh', () => {
  it('takes the fresh page when nothing beyond it was loaded', () => {
    const fresh = [row(2, '2026-11-12T10:02:00Z'), row(1, '2026-11-12T10:01:00Z')]
    expect(mergeRefresh([row(1, '2026-11-12T10:01:00Z')], null, fresh, null)).toEqual({ items: fresh, nextCursor: null })
  })

  it('keeps the loaded rows older than the fresh page, without duplicates, and the loaded cursor', () => {
    const loaded = [row(5, '2026-11-12T10:05:00Z'), row(4, '2026-11-12T10:04:00Z'), row(3, '2026-11-12T10:03:00Z'), row(2, '2026-11-12T10:02:00Z')]
    // Conversation 3 got a new message: it is now first; the fresh page holds two rows.
    const fresh = [row(3, '2026-11-12T11:00:00Z'), row(5, '2026-11-12T10:05:00Z')]
    const merged = mergeRefresh(loaded, 'cursor-after-2', fresh, 'cursor-after-5')
    expect(merged.items.map((c) => c.id)).toEqual([3, 5, 4, 2])
    expect(merged.nextCursor).toBe('cursor-after-2')
  })
})
```

Append to `apps/web/test/KnowledgeEditor.test.tsx` inside `describe('KnowledgeEditor', …)`:

```tsx
  it('opens the existing file instead of a blank one when the new name is taken', async () => {
    render(<KnowledgeEditor onExpired={vi.fn()} />)
    await screen.findByRole('button', { name: 'acme-coworking.md' })
    fireEvent.change(screen.getByLabelText(/new file name/i), { target: { value: 'acme-coworking' } })
    fireEvent.click(screen.getByRole('button', { name: 'New file' }))
    expect(await screen.findByLabelText(/content of acme-coworking.md/i)).toHaveValue('# Acme\n')
    expect(mocked.knowledgeFile).toHaveBeenCalledWith('acme-coworking.md')
  })
```

Append to `apps/web/test/Demo.test.tsx`:

```tsx
it('says that demo conversations are visible to anyone', () => {
  render(<Demo />)
  expect(screen.getByText(/public demo/i)).toBeInTheDocument()
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -w apps/web -- test/inboxList.test.tsx test/KnowledgeEditor.test.tsx test/Demo.test.tsx`
Expected: FAIL (module missing; the editor opens empty; no notice).

- [ ] **Step 3: Implement**

`apps/web/src/inboxList.ts`:

```ts
import type { ConversationSummary } from './api'

/** Same order as the API: newest `updatedAt` first, then highest id. */
const olderThan = (a: ConversationSummary, b: ConversationSummary) =>
  a.updatedAt < b.updatedAt || (a.updatedAt === b.updatedAt && a.id < b.id)

/**
 * A live refresh reloads only the first page (at most 100 rows). Rows the user loaded beyond it are kept, without
 * duplicates, and so is the cursor that continues after them.
 */
export function mergeRefresh(
  loaded: ConversationSummary[], loadedCursor: string | null,
  fresh: ConversationSummary[], freshCursor: string | null,
): { items: ConversationSummary[]; nextCursor: string | null } {
  const last = fresh.at(-1)
  if (!freshCursor || !last) return { items: fresh, nextCursor: freshCursor }
  const seen = new Set(fresh.map((c) => c.id))
  const tail = loaded.filter((c) => !seen.has(c.id) && olderThan(c, last))
  if (tail.length === 0) return { items: fresh, nextCursor: freshCursor }
  return { items: [...fresh, ...tail], nextCursor: loadedCursor }
}
```

`apps/web/src/pages/Inbox.tsx`:
- import `import { mergeRefresh } from '../inboxList'`;
- next to `itemsCountRef`, add refs for the loaded rows and the cursor (the merge reads both outside a state updater, so the updaters stay pure):

```ts
  const itemsRef = useRef<ConversationSummary[]>([])
  itemsRef.current = items
  const nextCursorRef = useRef<string | null>(null)
  nextCursorRef.current = nextCursor
```

- in `refreshList`, replace the line `if (filterRef.current === wanted) { setItems(r.conversations); setNextCursor(r.nextCursor) }` with:

```ts
      if (filterRef.current !== wanted) return
      const merged = mergeRefresh(itemsRef.current, nextCursorRef.current, r.conversations, r.nextCursor)
      setItems(merged.items)
      setNextCursor(merged.nextCursor)
```

- the filter buttons reset the list: replace `onClick={() => setFilter(f)}` with `onClick={() => { if (f !== filter) { setItems([]); setNextCursor(null); setFilter(f) } }}` (a refresh must never merge rows of another filter).

`apps/web/src/components/KnowledgeEditor.tsx` — `create()` becomes:

```ts
  function create() {
    const raw = newName.trim().toLowerCase().endsWith('.md') ? newName.trim() : `${newName.trim()}.md`
    if (!NAME.test(raw)) { setError(MESSAGES.invalid_name!); return }
    setNewName('')
    // An existing name opens that file: a blank editor would overwrite it on save.
    if (files.some((f) => f.name === raw)) { void select(raw); return }
    if (!leave()) return
    setError(null); setStatus('idle')
    setOpen({ name: raw, content: '', saved: '', isNew: true })
  }
```

`apps/web/src/pages/Demo.tsx` — add after the credentials paragraph:

```tsx
        <p className="demo-notice">
          This is a public demo: anyone who signs in to the inbox can read the conversations started here. Do not share personal data.
        </p>
```

and append to `apps/web/src/styles.css`: `.demo-notice { color: var(--warn); }`

- [ ] **Step 4: Run all web tests and the type check**

Run: `npm test -w apps/web && npm run typecheck -w apps/web` → all PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src apps/web/test
git commit -m "fix(web): keep loaded pages on a live refresh, never open a blank copy of an existing file; public-demo notice

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The transcriber retries a failed model load, then exits so Compose restarts it

From the plan-4 review: a transient download failure leaves the service running with `loaded: false` forever, because `restart: unless-stopped` never restarts a running process.

**Files:**
- Modify: `services/transcriber/transcriber/engine.py`, `services/transcriber/transcriber/__main__.py`
- Test: `services/transcriber/tests/test_main.py` (create)

**Interfaces:**
- Produces: `load_with_retry(engine: Engine, *, attempts: int = 5, first_delay: float = 5.0, sleep=time.sleep) -> bool` in `transcriber/__main__.py`; delays double up to 60 s. `Engine.load()` clears a previous `error` before each attempt.

- [ ] **Step 1: Write the failing tests**

`services/transcriber/tests/test_main.py`:

```python
from transcriber.__main__ import load_with_retry
from transcriber.engine import Engine


def flaky(failures):
    calls = []

    def loader(name, device, compute_type):
        calls.append(name)
        if len(calls) <= failures:
            raise OSError("network down")
        return object()

    return loader, calls


def test_retries_until_the_model_loads():
    loader, calls = flaky(2)
    engine = Engine("tiny", loader=loader)
    sleeps = []
    assert load_with_retry(engine, attempts=5, first_delay=1.0, sleep=sleeps.append)
    assert engine.loaded and engine.error is None
    assert len(calls) == 3
    assert sleeps == [1.0, 2.0]


def test_gives_up_after_the_last_attempt():
    loader, calls = flaky(99)
    engine = Engine("tiny", loader=loader)
    sleeps = []
    assert not load_with_retry(engine, attempts=3, first_delay=1.0, sleep=sleeps.append)
    assert len(calls) == 3
    assert sleeps == [1.0, 2.0]
    assert engine.error.startswith("OSError")


def test_delays_are_capped_at_a_minute():
    loader, _ = flaky(99)
    sleeps = []
    load_with_retry(Engine("tiny", loader=loader), attempts=5, first_delay=40.0, sleep=sleeps.append)
    assert sleeps == [40.0, 60.0, 60.0, 60.0]
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd services/transcriber && .venv/Scripts/python -m pytest tests/test_main.py -v`
Expected: FAIL (`ImportError: cannot import name 'load_with_retry'`).

- [ ] **Step 3: Implement**

`services/transcriber/transcriber/engine.py` — `load` becomes:

```python
    def load(self) -> None:
        self.error = None
        try:
            self._model = self._loader(self.model_name, self._device, self._compute_type)
        except Exception as exc:  # reported by GET /health instead of crashing the service
            self.error = f"{type(exc).__name__}: {exc}"[:200]
```

`services/transcriber/transcriber/__main__.py` (whole file):

```python
"""python -m transcriber — env: TRANSCRIBER_MODEL (small), TRANSCRIBER_HOST (127.0.0.1), TRANSCRIBER_PORT (8000)."""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Callable

from .engine import Engine
from .server import make_server

log = logging.getLogger("transcriber")

MAX_DELAY_S = 60.0


def _env(key: str, default: str) -> str:
    return os.environ.get(key, "").strip() or default


def load_with_retry(
    engine: Engine, *, attempts: int = 5, first_delay: float = 5.0, sleep: Callable[[float], None] = time.sleep
) -> bool:
    """Loads the model, retrying a failed load (a download can fail transiently). True once loaded."""
    delay = first_delay
    for attempt in range(1, attempts + 1):
        started = time.monotonic()
        log.info("loading model %s, attempt %d of %d (the first run downloads it)", engine.model_name, attempt, attempts)
        engine.load()
        if engine.error is None:
            log.info("model %s loaded in %.1f s", engine.model_name, time.monotonic() - started)
            return True
        log.error("model %s failed to load: %s", engine.model_name, engine.error)
        if attempt < attempts:
            log.info("retrying in %.0f s", delay)
            sleep(delay)
            delay = min(delay * 2, MAX_DELAY_S)
    return False


def _load_or_exit(engine: Engine) -> None:
    if not load_with_retry(engine):
        log.error("giving up on model %s; exiting so the container is restarted", engine.model_name)
        os._exit(1)  # from a thread: sys.exit would only end the thread


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    engine = Engine(_env("TRANSCRIBER_MODEL", "small"))
    host = _env("TRANSCRIBER_HOST", "127.0.0.1")
    port = int(_env("TRANSCRIBER_PORT", "8000"))
    server = make_server(engine, host, port)
    threading.Thread(target=_load_or_exit, args=(engine,), daemon=True).start()
    log.info("listening on %s:%d", host, port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run all transcriber tests**

Run: `cd services/transcriber && .venv/Scripts/python -m pytest`
Expected: all PASS (including `test_a_load_failure_is_reported_not_raised` in `test_engine.py`).

- [ ] **Step 5: Commit**

```bash
git add services/transcriber
git commit -m "fix(transcriber): retry a failed model load, then exit so Compose restarts the service

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Compose resilience, nginx hardening, and Docker in CI

Docker has never been run for this project. CI now builds the three images, checks the nginx configuration, starts `api` and `web` in demo mode and runs a smoke test through nginx.

**Files:**
- Modify: `docker-compose.yml`, `apps/web/nginx.conf`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `RELAY_TRUST_PROXY`, `RELAY_ALLOWED_ORIGINS` (Tasks 5–6); `GET /api/health`; transcriber `GET /health` → `{ loaded }`.
- Produces: compose project name `relay` (images `relay-api`, `relay-web`, `relay-transcriber`); healthchecks on `api` and `transcriber`; `web` starts after `api` is healthy; CI job `docker`.

- [ ] **Step 1: Compose**

`docker-compose.yml` (whole file):

```yaml
name: relay
services:
  api:
    build: { context: ., dockerfile: apps/api/Dockerfile }
    volumes: [relay-data:/data]
    environment:
      # All optional. With none set, the agent runs on the scripted demo provider.
      RELAY_PROVIDER: ${RELAY_PROVIDER:-}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      RELAY_CLAUDE_MODEL: ${RELAY_CLAUDE_MODEL:-}
      OLLAMA_URL: ${OLLAMA_URL:-}
      RELAY_OLLAMA_MODEL: ${RELAY_OLLAMA_MODEL:-}
      RELAY_AGENT_TIMEOUT_MS: ${RELAY_AGENT_TIMEOUT_MS:-}
      # Voice messages: the transcriber below, on the internal network only.
      TRANSCRIBER_URL: ${TRANSCRIBER_URL:-http://transcriber:8000}
      RELAY_TRANSCRIBER_LANGUAGE: ${RELAY_TRANSCRIBER_LANGUAGE:-}
      # Only nginx (the web service) reaches the api, so its X-Forwarded-* headers are trusted:
      # real client IPs for the rate limits, and Secure cookies when nginx is served over HTTPS.
      RELAY_TRUST_PROXY: "1"
      RELAY_ALLOWED_ORIGINS: ${RELAY_ALLOWED_ORIGINS:-}
    # Lets the container reach an Ollama running on the host (Linux needs this; Docker Desktop has it built in).
    extra_hosts: ["host.docker.internal:host-gateway"]
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 30s
    restart: unless-stopped
  transcriber:
    build: { context: services/transcriber }
    environment:
      TRANSCRIBER_MODEL: ${TRANSCRIBER_MODEL:-small}
    # The model is downloaded on first start and kept here.
    volumes: [whisper-models:/models]
    # No `ports`: only the api reaches it, over the compose network. Audio never leaves the server.
    expose: ["8000"]
    # Healthy once the model is loaded; the first start downloads it, hence the long start period.
    healthcheck:
      test: ["CMD", "python", "-c", "import json, sys, urllib.request; sys.exit(0 if json.load(urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)).get('loaded') else 1)"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10m
    restart: unless-stopped
  web:
    build: { context: ., dockerfile: apps/web/Dockerfile }
    ports: ["8080:80"]
    depends_on:
      api: { condition: service_healthy }
    restart: unless-stopped
volumes:
  relay-data:
  whisper-models:
```

The `api` does not wait for the transcriber on purpose: voice messages wait for it (offline retry), everything else works without it.

- [ ] **Step 2: nginx**

`apps/web/nginx.conf` (whole file):

```nginx
# Visitor tokens travel in the /ws/widget query string: the access log records paths without query strings.
log_format relay '$remote_addr - $remote_user [$time_local] "$request_method $uri $server_protocol" '
                 '$status $body_bytes_sent "$http_referer" "$http_user_agent"';

server {
  listen 80;
  client_max_body_size 11m;
  root /usr/share/nginx/html;
  access_log /var/log/nginx/access.log relay;

  # Docker's DNS. With the upstream in a variable, nginx resolves "api" per request, so an api restart
  # (new container IP) does not leave it answering 502, and `nginx -t` works without the api running.
  resolver 127.0.0.11 valid=10s ipv6=off;
  set $api http://api:3000;

  location /api/ {
    proxy_pass $api;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
  location /ws/ {
    proxy_pass $api;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    # $http_host keeps the port, so the api's Origin check sees the same host:port as the browser.
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
  }
  location / {
    # The SPA: same-origin scripts, styles, API calls and sockets; the microphone for the widget.
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy no-referrer always;
    add_header Permissions-Policy "microphone=(self), camera=(), geolocation=()" always;
    try_files $uri /index.html;
  }
}
```

- [ ] **Step 3: The `docker` CI job**

Append to `.github/workflows/ci.yml` under `jobs:`:

```yaml
  docker:
    name: Docker images and smoke test
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v5
      - name: Compose file is valid
        run: docker compose config --quiet
      - name: Build the api, web and transcriber images
        run: docker compose build
      - name: nginx configuration is valid
        run: docker run --rm relay-web nginx -t
      - name: Start api and web (demo provider; the transcriber is not started, so no model is downloaded)
        run: docker compose up -d --wait --wait-timeout 120 api web
      - name: Smoke test through nginx
        run: |
          set -eu
          curl -fsS http://localhost:8080/api/health | grep -q '"ok":true'
          curl -fsS -D headers.txt -o /dev/null http://localhost:8080/demo
          grep -qi '^content-security-policy:' headers.txt
          curl -fsS -c cookies.txt -H 'content-type: application/json' \
            -d '{"email":"demo@relay.dev","password":"relay-demo"}' http://localhost:8080/api/auth/login | grep -q '"email":"demo@relay.dev"'
          curl -fsS -b cookies.txt http://localhost:8080/api/conversations | grep -q '"conversations"'
          curl -fsS -b cookies.txt http://localhost:8080/api/settings | grep -q '"turnLimit"'
      - name: Logs on failure
        if: failure()
        run: docker compose logs
      - name: Stop
        if: always()
        run: docker compose down -v
```

- [ ] **Step 4: Push and watch CI**

```bash
git add docker-compose.yml apps/web/nginx.conf .github/workflows/ci.yml
git commit -m "ci: build the Docker images and smoke-test api and web; compose healthchecks, nginx resolver and headers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
GH_TOKEN=$(gh auth token --user sidsidoso) git push
GH_TOKEN=$(gh auth token --user sidsidoso) gh run watch --repo sidsidoso/relay --exit-status
```

Expected: `node`, `transcriber` and `docker` green. This is the first time the images are built: if a Dockerfile step fails (missing file in the build context, a native module that needs build tools, a wrong path), fix the Dockerfile in a commit `fix(docker): <what>` and push again until the job is green. Do not weaken the smoke test to make it pass.

---

### Task 11: Docs, follow-ups and the manual checklist

**Files:**
- Modify: `README.md`, `.env.example`, `docs/superpowers/plans/followups-after-plan-1.md`

- [ ] **Step 1: README**

1. Under the title add the badge: `[![CI](https://github.com/sidsidoso/relay/actions/workflows/ci.yml/badge.svg)](https://github.com/sidsidoso/relay/actions/workflows/ci.yml)`.
2. Status line: `> Status: plan 6a of 6b — CI on every push (type check, tests, Docker images and a smoke test) and public-demo hardening. Next: English/Portuguese UI and end-to-end tests.`
3. In "Develop", add `npm run build` and the transcriber test command (already in the voice section, link to it).
4. Replace the "Quick check" bullet with: `- **Quick check** of your configuration, outside the app: \`npm run try-provider -w apps/api -- "How much is a meeting room?"\` runs one full agent turn (the app's prompt, tools and knowledge base) on a throwaway database and prints the reply, the outcome and the tokens. With a key it makes real requests; the same code is tested in CI over recorded responses.`
5. In the failures bullet, mention that a refusal shows "The AI model declined to answer".
6. New section after "Voice messages":

```markdown
## Running it in public

Relay is built to be safe as a public demo:

- **Rate limits** per client IP: 10 sign-in attempts per 5 minutes, 30 widget messages and 6 voice uploads per minute. A visitor can keep 5 widget connections open.
- **WebSockets** accept only pages from the same origin (or those in `RELAY_ALLOWED_ORIGINS`).
- **Sessions** last 7 days; the cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` when served over HTTPS. Signing out or an expired session closes the live inbox connection.
- **Headers:** the API and the web app send a Content Security Policy and the usual `nosniff`/`DENY`/`no-referrer` headers.
- **Logs** never contain visitor tokens: nginx and the API log paths without query strings.
- Anyone who signs in with the demo account can read every demo conversation; `/demo` says so.

| Variable | Default | What it does |
| --- | --- | --- |
| `RELAY_TRUST_PROXY` | `1` in Docker, off otherwise | Trust `X-Forwarded-*` from the reverse proxy (client IPs, HTTPS). Turn on only behind a proxy. |
| `RELAY_ALLOWED_ORIGINS` | — | Extra origins allowed to open `/ws/*`, comma-separated. |
| `RELAY_LOG_LEVEL` | `info` | API log level (`debug`, `info`, `warn`, `error`). |
```

7. In "Em português", add one paragraph: `O CI roda a cada push: checagem de tipos, testes da API, da web e do transcritor, build das imagens Docker e um teste rápido com o provedor demo. Para uso público, há limites por IP, checagem de origem nos WebSockets, cookie de sessão seguro e cabeçalhos de segurança.`

- [ ] **Step 2: `.env.example`**

Append:

```bash
# Extra browser origins allowed to open the WebSockets, comma-separated (the page's own origin is always allowed).
RELAY_ALLOWED_ORIGINS=
# API log level: debug, info (default), warn, error.
RELAY_LOG_LEVEL=
```

- [ ] **Step 3: Follow-ups**

In `docs/superpowers/plans/followups-after-plan-1.md`, replace the section `## Plan 6 — polish, CI, public demo hardening` with:

```markdown
## Done in plan 6a
- CI on every push and pull request: type check, API and web tests, web build, transcriber tests (fake model), Docker image builds, `nginx -t` and a smoke test of api + web in demo mode.
- Compose: healthchecks for api and transcriber, `web` waits for a healthy `api`, nginx re-resolves `api` (`resolver 127.0.0.11`), project name `relay`.
- The transcriber retries a failed model load and exits after the last attempt so Compose restarts it (plan-4 review).
- Fastify logger on, with URLs logged without query strings; JSON 404 `{ error, code }`; security headers on the API and the SPA; `PORT` validated.
- Sessions: `Secure` over HTTPS, `Max-Age` of 7 days, expired sessions purged, inbox sockets closed on sign-out and on expiry.
- Public demo: rate limits (login, widget messages, voice uploads), 5 widget sockets per visitor, Origin check on `/ws/*`, a notice on `/demo`, no tokens in nginx or API logs.
- `verifyPassword` rejects an empty or non-hex stored key; `z.email()`.
- Agent: the prompt asks for `search_knowledge` on any company question; the Ollama text-only fallback gets the passages on its first request (plan-5 review); a refusal is a transfer with its own reason.
- `try-provider` runs one full agent turn and is tested over recorded responses.
- Web: a live refresh keeps the pages loaded beyond 100 rows; a taken knowledge file name opens that file instead of a blank one (plan-5 review).

## Plan 6b — i18n and end-to-end
- English and Portuguese UI with a language switcher (spec §2, §9).
- Playwright end-to-end tests in CI (spec §11).

## Later (not planned)
- HTTP Range support on the audio route (seeking in long recordings).
- A retention policy for the media folder.
- Test hygiene: 404 on every conversation action, 401 handling on get/reply/act in the inbox, stale list/filter guard, close-listener races in WebSocket tests, restoring spies in `finally`, closing apps in tests.
- A linter (ESLint) in CI.
```

- [ ] **Step 4: Full checks**

Run: `npm run typecheck && npm test && npm run build` → clean, all PASS, built. Transcriber: `.venv/Scripts/python -m pytest` → PASS.

- [ ] **Step 5: Manual checklist (run it, then report each line as done or not done)**

```bash
RELAY_DB=$(mktemp -d)/relay.db npm run dev:api   # terminal 1
npm run dev:web                                    # terminal 2
```

1. http://localhost:5173/demo shows the public-demo notice; the widget answers "What are your opening hours?".
2. Sign in at http://localhost:5173: the conversation is there with a "Replied" run. Sign out in that tab: the inbox returns to the login form.
3. Sign in 11 times in a row with a wrong password (`curl -s -o /dev/null -w '%{http_code}\n' -H 'content-type: application/json' -d '{"email":"demo@relay.dev","password":"x"}' http://localhost:3000/api/auth/login`): the 11th answers `429`.
4. **Microphone (manual, a real browser and microphone):** start the transcriber (README, "Running the transcriber without Docker", model `tiny`) and run the API with `TRANSCRIBER_URL=http://127.0.0.1:8000`. On `/demo`, click **Voice**, allow the microphone, say "What are your opening hours?", click **Stop**. The widget shows "Voice message" and then the agent's answer about opening hours; the inbox shows the player and the transcription below it. Repeat with the microphone permission blocked: the widget says "Microphone not available. Check the browser permission."
5. If a key is available: `ANTHROPIC_API_KEY=… npm run try-provider -w apps/api -- "How much is a meeting room?"` prints `outcome: replied` and an answer with the meeting room price. Report whether it was run.

- [ ] **Step 6: Commit and push**

```bash
git add README.md .env.example docs/superpowers/plans/followups-after-plan-1.md
git commit -m "docs: CI badge, public-demo hardening, new variables and plan-6a follow-ups

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
GH_TOKEN=$(gh auth token --user sidsidoso) git push
```

---

## Self-review notes

- Spec §11 "CI: lint, type check, and tests on every push" → Task 1 (type check, tests), Task 10 (Docker); lint is not in the repo (left as a decision). Spec §11 transcriber pytest in CI → Task 1. Spec §12 `docker compose up` works with no configuration → Task 10 builds and starts it in CI for the first time.
- Spec §4 "Knowledge base passages" / `search_knowledge` → Task 2. Spec §10 "any provider error becomes a handoff with a recorded reason" → Task 3 keeps the handoff and adds a refusal reason.
- Spec §10 "errors return `{ error, code }`" → Task 5 (404 handler). Spec §8 httpOnly session cookie → Task 7.
- Follow-ups "Plan 6" section: every item is in Tasks 1, 5, 6, 7, 9, 10 except HTTP Range, media retention and part of the test hygiene list, moved to "Later" in Task 11 with the reason (not needed for the demo flow; the demo keeps short recordings). Playwright moves to plan 6b.
- Review findings: plan-4 transcriber load (Task 9), plan-5 Ollama prompt (Task 2), plan-5 knowledge overwrite and list refresh (Task 8).
- Type consistency: `ServerOptions` grows in Tasks 5 → 6 → 7 (`logger`, `trustProxy` → `allowedOrigins`, `limits` → `sessionCheckMs`); `authRoutes` opts grow from `{ loginLimiter }` (Task 6) to `{ loginLimiter, sessions }` (Task 7); `inboxSocket` opts from `{ allowedOrigins }` to `{ allowedOrigins, sessions, sessionCheckMs }`.
