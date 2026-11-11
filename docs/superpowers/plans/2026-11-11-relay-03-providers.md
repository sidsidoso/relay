# Relay — Plan 3: Claude and Ollama providers

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent can run on a real model — Claude through the Anthropic API, or a local model through Ollama — behind the existing `Provider` interface, chosen from environment variables, with the scripted demo provider still the zero-configuration default. Any provider failure still hands the customer to a human.

**Architecture:** Two adapters in `apps/api/src/agent/providers/` translate the provider-neutral `GenerateRequest` / `GenerateResult` (plan 2) to each API. `ClaudeProvider` uses the official `@anthropic-ai/sdk` (Messages API, client tools); `OllamaProvider` calls Ollama's `POST /api/chat` with `fetch`. Both take an injectable `fetch`, so tests replay recorded JSON responses (`apps/api/test/fixtures/`) and CI never touches the network or needs a key. Failures become a `ProviderError` with a stable code, which the engine already turns into a `failed` run plus a handoff. `selectProvider(env)` applies the order from spec §4, and `main.ts` picks a per-provider timeout.

**Tech Stack:** unchanged from plan 2 (Fastify 5, Drizzle + better-sqlite3, zod v4, Vitest; React 19 + Vite), plus `@anthropic-ai/sdk` 1.x (sends API version `2026-10-21`). No Ollama client library: its HTTP API is small and `fetch` is built into Node 24.

Spec: `docs/superpowers/specs/2026-11-10-relay-design.md` §4 (providers, selection order, automatic handoff), §10 (error handling), §11 (providers tested against recorded responses). Follow-ups pulled in from `docs/superpowers/plans/followups-after-plan-1.md`: "real providers get all passages" (verified by a test here) and the "Small hardening (any plan)" `EventBus` items.

## Global Constraints

- Code, identifiers, comments and docs in English (the README keeps its Portuguese section). ESM; TypeScript `strict: true`.
- The `Provider` interface from plan 2 stays as it is, plus one optional opaque field (`raw`, Task 1). The engine stays provider-neutral: no `if (provider.id === ...)` inside `engine.ts`.
- Selection order exactly: `RELAY_PROVIDER` if set (`claude` | `ollama` | `demo`, case-insensitive); otherwise Claude if `ANTHROPIC_API_KEY` is set, then Ollama if `OLLAMA_URL` is set, then demo. An empty or whitespace-only variable counts as unset (Docker Compose passes empty strings).
- With no variables set, behavior is identical to plan 2 (demo provider, `docker compose up` works with no key).
- Default Claude model `claude-opus-5-5` (override: `RELAY_CLAUDE_MODEL`). Default Ollama model `llama3.2` (override: `RELAY_OLLAMA_MODEL`). Never append a date suffix to a Claude model ID.
- Claude requests: `max_tokens: 16000`, `output_config: { effort: 'low' }`, no `thinking`, `temperature`, `top_p`, `top_k` or `tool_choice` field (Opus 5.5 rejects disabled thinking, sampling parameters and forced tool choice). When the model calls a tool, the assistant turn is sent back with its content blocks unchanged (thinking blocks included).
- Tests never use the network and never need a key: every adapter test injects a fake `fetch` that replays fixtures from `apps/api/test/fixtures/`.
- Provider failures throw `ProviderError` whose `message` starts with a stable code (`claude_rate_limited`, `claude_auth`, `claude_model_not_found`, `claude_timeout`, `claude_offline`, `claude_http_<status>`, `claude_refusal`, `claude_max_tokens`, `claude_model_context_window_exceeded`, `ollama_offline`, `ollama_model_not_found`, `ollama_http_<status>`). The engine (plan 2) records it in `agent_runs.error` (first 200 chars) and hands off.
- API keys are never logged, stored, or put in error messages.
- Agent timeout per provider call: `RELAY_AGENT_TIMEOUT_MS` if it is a positive integer; otherwise 120 000 ms for Ollama and 30 000 ms (`DEFAULT_TIMEOUT_MS`) for everything else.
- Sample content stays fictional ("Acme Coworking"). No employer data anywhere.
- Every commit message ends with a `Co-Authored-By:` trailer naming the model that wrote the commit.

## File structure

```
apps/api/
  package.json                         MODIFY: @anthropic-ai/sdk dependency, try-provider script
  tsconfig.json                        MODIFY: include scripts/
  scripts/try-provider.ts              NEW: one live request with the selected provider (manual, never in CI)
  src/agent/providers/types.ts         MODIFY: optional `raw` on tool-call results and assistant messages; FetchLike
  src/agent/providers/errors.ts        NEW: ProviderError
  src/agent/providers/claude.ts        NEW: ClaudeProvider + toAnthropicMessages + toProviderError
  src/agent/providers/ollama.ts        NEW: OllamaProvider + toOllamaMessages
  src/agent/providers/index.ts         MODIFY: selectProvider(env, opts) + agentTimeoutMs(env, provider)
  src/agent/engine.ts                  MODIFY: carry `raw` into the assistant message
  src/core/events.ts                   MODIFY: EventBus hardening (follow-ups)
  src/main.ts                          MODIFY: pass the timeout to the engine
  test/fake-fetch.ts                   NEW: fetch stub that replays fixtures and records requests
  test/fixtures/claude/*.json          NEW: recorded Messages API responses
  test/fixtures/ollama/*.json          NEW: recorded /api/chat responses
  test/claude-provider.test.ts         NEW
  test/ollama-provider.test.ts         NEW
  test/provider-select.test.ts         NEW
  test/providers-engine.test.ts        NEW: full agent turns over the recorded responses
  test/engine.test.ts                  MODIFY: raw pass-through test
  test/demo-provider.test.ts           MODIFY: the selection test moves to provider-select.test.ts
  test/events.test.ts                  MODIFY: hardening tests
docker-compose.yml                     MODIFY: provider variables, host.docker.internal
.env.example                           NEW
README.md                              MODIFY: providers and configuration (EN + PT)
docs/superpowers/plans/followups-after-plan-1.md   MODIFY: plan-3 status
```

---

### Task 1: Provider plumbing — `ProviderError` and opaque `raw` turns

Claude requires that, when it calls a tool, the next request repeats its assistant turn exactly as it was returned (thinking blocks with their signatures, text, tool calls). The neutral `ChatMessage` cannot express that, so a provider may attach an opaque `raw` value to a `tool_calls` result; the engine copies it into the assistant message it appends, and only the same provider reads it back.

**Files:**
- Create: `apps/api/src/agent/providers/errors.ts`
- Modify: `apps/api/src/agent/providers/types.ts`, `apps/api/src/agent/engine.ts`
- Test: `apps/api/test/engine.test.ts` (extend)

**Interfaces:**
- Consumes (plan 2): `runAgentTurn(deps: EngineDeps, conversationId: number): Promise<TurnResult>`, `EngineDeps = CoreDeps & { provider; knowledge; timeoutMs? }`, `DEFAULT_TIMEOUT_MS = 30_000`.
- Produces (`providers/types.ts`, full file after this task):
```ts
export type ToolCall = { id: string; name: string; input: Record<string, unknown> }
export type ChatMessage =
  | { role: 'user'; content: string }
  /** `raw` is opaque provider data from a tool_calls result; only the provider that produced it reads it. */
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; raw?: unknown }
  | { role: 'tool'; toolCallId: string; name: string; content: string }
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> }
export type Usage = { inputTokens?: number; outputTokens?: number }
export type GenerateRequest = { system: string; messages: ChatMessage[]; tools: ToolSpec[]; signal?: AbortSignal }
export type GenerateResult =
  | { kind: 'text'; text: string; usage?: Usage }
  | { kind: 'tool_calls'; calls: ToolCall[]; text?: string; usage?: Usage; raw?: unknown }
export interface Provider { readonly id: string; readonly model: string | null; generate(req: GenerateRequest): Promise<GenerateResult> }
/** The subset of `fetch` the adapters use; tests pass a stub. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
```
- Produces (`providers/errors.ts`): `class ProviderError extends Error { readonly code: string }` — constructor `(code: string, detail?: string)`; `message` is `code` or `` `${code}: ${detail}` `` when `detail` is non-empty; `name` is `'ProviderError'`.
- Engine: when it appends the assistant turn after a `tool_calls` result, it includes `raw` only when the result has one (so `toEqual` assertions on plain histories keep passing).

- [ ] **Step 1: Failing tests**

Append inside the `describe('runAgentTurn', ...)` block of `apps/api/test/engine.test.ts`:
```ts
  it('passes a provider\'s opaque raw turn back on the next tool round', async () => {
    const seen: ChatMessage[][] = []
    const raw = [{ type: 'opaque', signature: 'abc' }]
    await setup({
      id: 'raw', model: null,
      generate: async (req) => {
        seen.push(structuredClone(req.messages))
        return seen.length === 1
          ? { kind: 'tool_calls', calls: [{ id: 't1', name: 'tag_conversation', input: { tags: ['pricing'] } }], raw }
          : { kind: 'text', text: 'done' }
      },
    })
    const id = ask('price?')
    expect((await runAgentTurn(deps, id)).outcome).toBe('replied')
    expect(seen[1]!.slice(-2)).toEqual([
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'tag_conversation', input: { tags: ['pricing'] } }], raw },
      { role: 'tool', toolCallId: 't1', name: 'tag_conversation', content: 'ok' },
    ])
  })

  it('a tool_calls result without raw adds no raw key', async () => {
    const seen: ChatMessage[][] = []
    await setup({
      id: 'noraw', model: null,
      generate: async (req) => {
        seen.push(structuredClone(req.messages))
        return seen.length === 1
          ? { kind: 'tool_calls', calls: [{ id: 't1', name: 'tag_conversation', input: { tags: ['x'] } }] }
          : { kind: 'text', text: 'done' }
      },
    })
    await runAgentTurn(deps, ask('price?'))
    expect('raw' in seen[1]!.at(-2)!).toBe(false)
  })
```

Create `apps/api/test/provider-error.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { ProviderError } from '../src/agent/providers/errors'

describe('ProviderError', () => {
  it('starts its message with the stable code', () => {
    const e = new ProviderError('claude_rate_limited', 'slow down')
    expect(e).toBeInstanceOf(Error)
    expect(e).toMatchObject({ name: 'ProviderError', code: 'claude_rate_limited', message: 'claude_rate_limited: slow down' })
    expect(new ProviderError('ollama_offline').message).toBe('ollama_offline')
    expect(new ProviderError('ollama_offline', '').message).toBe('ollama_offline')
  })
})
```

Run: `npm test -w apps/api` → FAIL (the raw test sees no `raw`; `errors.ts` does not exist).

- [ ] **Step 2: Types and error class**

Replace `apps/api/src/agent/providers/types.ts` with exactly the block in Interfaces above.

`apps/api/src/agent/providers/errors.ts`:
```ts
/** A provider failure with a stable code; the engine logs `message` on the run and hands off. */
export class ProviderError extends Error {
  constructor(readonly code: string, detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'ProviderError'
  }
}
```

- [ ] **Step 3: Engine carries `raw`**

In `apps/api/src/agent/engine.ts`, replace the line
```ts
      chat.push({ role: 'assistant', content: result.text ?? '', toolCalls: result.calls })
```
with
```ts
      chat.push({
        role: 'assistant',
        content: result.text ?? '',
        toolCalls: result.calls,
        ...(result.raw !== undefined ? { raw: result.raw } : {}),
      })
```

- [ ] **Step 4: Run tests and typecheck, then commit**

Run: `npm test -w apps/api` → PASS. `npm run typecheck -w apps/api` → clean.
```bash
git add apps/api
git commit -m "feat(api): ProviderError and opaque provider turns in the engine"
```

---

### Task 2: Claude provider

**Files:**
- Modify: `apps/api/package.json`, `package-lock.json` (via `npm install`)
- Create: `apps/api/src/agent/providers/claude.ts`, `apps/api/test/fake-fetch.ts`, `apps/api/test/fixtures/claude/tool-use.json`, `apps/api/test/fixtures/claude/answer.json`, `apps/api/test/fixtures/claude/refusal.json`, `apps/api/test/fixtures/claude/max-tokens.json`, `apps/api/test/fixtures/claude/rate-limit.json`, `apps/api/test/fixtures/claude/overloaded.json`, `apps/api/test/fixtures/claude/auth.json`
- Test: `apps/api/test/claude-provider.test.ts`

**Interfaces:**
- Consumes (Task 1): `ChatMessage`, `GenerateRequest`, `GenerateResult`, `Provider`, `ToolSpec`, `FetchLike`, `ProviderError`.
- Produces (`providers/claude.ts`):
  - `DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5'`, `CLAUDE_MAX_TOKENS = 16_000`.
  - `type ClaudeOptions = { apiKey: string; model?: string; maxRetries?: number; fetch?: FetchLike }` (`maxRetries` defaults to 2 — the SDK retries 408/409/429/5xx and connection errors; the engine timeout still bounds the whole call).
  - `class ClaudeProvider implements Provider` — `id: 'claude'`, `model` = option or default. `generate` returns `text`, or `tool_calls` with `raw` = the response `content` array.
  - `toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[]` — rules: leading non-`user` messages are dropped (the API needs a user message first); an empty user message becomes `'[empty message]'`; an assistant message with `raw` is sent as `raw` unchanged; an assistant message with tool calls becomes `[text block if non-empty, ...tool_use blocks]`; a plain assistant message is sent as its string, or dropped when empty; consecutive `tool` messages become ONE user message of `tool_result` blocks.
  - `toProviderError(err: unknown): Error` — `APIUserAbortError` is returned unchanged (the engine timed out); otherwise a `ProviderError`: `RateLimitError` → `claude_rate_limited`, `AuthenticationError` / `PermissionDeniedError` → `claude_auth`, `NotFoundError` → `claude_model_not_found`, `APIConnectionTimeoutError` → `claude_timeout`, `APIConnectionError` → `claude_offline`, other `APIError` with a status → `claude_http_<status>`, anything else → `claude_error`. Detail = the SDK error message (never contains the key).
  - Response handling: `stop_reason: 'refusal'` → throw `ProviderError('claude_refusal', <stop_details.category or ''>)`; any `tool_use` block → `tool_calls` (all `text` blocks joined with `\n` and trimmed go in `text` when non-empty); otherwise `max_tokens` / `model_context_window_exceeded` → throw `ProviderError('claude_<stop_reason>')`; otherwise `text` (joined text blocks, trimmed — an empty string is returned as is and the engine hands off with `empty_reply`). `usage` = `{ inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }`.
- Produces (`test/fake-fetch.ts`): `fakeFetch(responses: Recorded[]): { fetch: FetchLike; requests: Array<{ url: string; body: any }> }` with `type Recorded = { status?: number; body?: unknown; throws?: Error }` (each call consumes the next entry; an unexpected extra call throws), and `fixture(path: string): any` reading `test/fixtures/<path>`.

- [ ] **Step 1: Install the SDK**

Run from the repository root:
```bash
npm install @anthropic-ai/sdk@^1.8.0 -w apps/api
```
Expected: `apps/api/package.json` gains `"@anthropic-ai/sdk": "^1.8.0"` under `dependencies` and `package-lock.json` is updated. (It must be a runtime dependency: the API Dockerfile installs with `--omit=dev`.)

- [ ] **Step 2: Fake fetch helper and fixtures**

`apps/api/test/fake-fetch.ts`:
```ts
import { readFileSync } from 'node:fs'
import type { FetchLike } from '../src/agent/providers/types'

export type Recorded = { status?: number; body?: unknown; throws?: Error }

/** Replays recorded HTTP responses in order and records every request. Tests never reach the network. */
export function fakeFetch(responses: Recorded[]) {
  const queue = [...responses]
  const requests: Array<{ url: string; body: any }> = []
  const fetch: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    requests.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    const next = queue.shift()
    if (!next) throw new Error(`unexpected request to ${url}`)
    if (next.throws) throw next.throws
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetch, requests }
}

export const fixture = (path: string): any =>
  JSON.parse(readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8'))
```

The fixtures are Messages API responses in the shape the API returns for `claude-opus-5-5` (adaptive thinking with the default `display: "omitted"`, so thinking text is empty and only the signature is meaningful). Write them exactly:

`apps/api/test/fixtures/claude/tool-use.json`:
```json
{
  "id": "msg_01RelayFixtureToolUse000001",
  "type": "message",
  "role": "assistant",
  "model": "claude-opus-5-5",
  "content": [
    { "type": "thinking", "thinking": "", "signature": "EqQBCkYIBhgCKkCrelayFixtureSignatureToolUse0001" },
    { "type": "text", "text": "Let me check our prices.", "citations": null },
    {
      "type": "tool_use",
      "id": "toolu_01RelayFixtureSearch00001",
      "name": "search_knowledge",
      "input": { "query": "meeting room price" },
      "caller": { "type": "direct" }
    }
  ],
  "stop_reason": "tool_use",
  "stop_sequence": null,
  "stop_details": null,
  "container": null,
  "usage": {
    "input_tokens": 912,
    "output_tokens": 64,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "service_tier": "standard"
  }
}
```

`apps/api/test/fixtures/claude/answer.json`:
```json
{
  "id": "msg_01RelayFixtureAnswer0000001",
  "type": "message",
  "role": "assistant",
  "model": "claude-opus-5-5",
  "content": [
    { "type": "thinking", "thinking": "", "signature": "EqQBCkYIBhgCKkCrelayFixtureSignatureAnswer00001" },
    {
      "type": "text",
      "text": "A meeting room costs $20 per hour. The small room seats 4 people and the large one seats 8. You can book at the front desk or by message.",
      "citations": null
    }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "stop_details": null,
  "container": null,
  "usage": {
    "input_tokens": 1040,
    "output_tokens": 48,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "service_tier": "standard"
  }
}
```

`apps/api/test/fixtures/claude/refusal.json`:
```json
{
  "id": "msg_01RelayFixtureRefusal000001",
  "type": "message",
  "role": "assistant",
  "model": "claude-opus-5-5",
  "content": [],
  "stop_reason": "refusal",
  "stop_sequence": null,
  "stop_details": { "type": "refusal", "category": null, "explanation": "The request was declined." },
  "container": null,
  "usage": { "input_tokens": 880, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "service_tier": "standard" }
}
```

`apps/api/test/fixtures/claude/max-tokens.json`:
```json
{
  "id": "msg_01RelayFixtureMaxTokens00001",
  "type": "message",
  "role": "assistant",
  "model": "claude-opus-5-5",
  "content": [{ "type": "text", "text": "Our plans are", "citations": null }],
  "stop_reason": "max_tokens",
  "stop_sequence": null,
  "stop_details": null,
  "container": null,
  "usage": { "input_tokens": 900, "output_tokens": 16000, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "service_tier": "standard" }
}
```

`apps/api/test/fixtures/claude/rate-limit.json` (body of an HTTP 429):
```json
{
  "type": "error",
  "error": { "type": "rate_limit_error", "message": "Number of request tokens has exceeded your per-minute rate limit." },
  "request_id": "req_01RelayFixture429"
}
```

`apps/api/test/fixtures/claude/overloaded.json` (body of an HTTP 529):
```json
{
  "type": "error",
  "error": { "type": "overloaded_error", "message": "Overloaded" },
  "request_id": "req_01RelayFixture529"
}
```

`apps/api/test/fixtures/claude/auth.json` (body of an HTTP 401):
```json
{
  "type": "error",
  "error": { "type": "authentication_error", "message": "invalid x-api-key" },
  "request_id": "req_01RelayFixture401"
}
```

- [ ] **Step 3: Failing test**

`apps/api/test/claude-provider.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { ClaudeProvider, DEFAULT_CLAUDE_MODEL, CLAUDE_MAX_TOKENS, toAnthropicMessages, toProviderError } from '../src/agent/providers/claude'
import { ProviderError } from '../src/agent/providers/errors'
import { TOOL_SPECS } from '../src/agent/tools'
import { fakeFetch, fixture, type Recorded } from './fake-fetch'

const provider = (responses: Recorded[], model?: string) => {
  const f = fakeFetch(responses)
  return { p: new ClaudeProvider({ apiKey: 'test-key', model, maxRetries: 0, fetch: f.fetch }), requests: f.requests }
}
const ask = (p: ClaudeProvider) => p.generate({ system: 'You are the Acme assistant.', messages: [{ role: 'user', content: 'How much is a meeting room?' }], tools: TOOL_SPECS })

describe('ClaudeProvider', () => {
  it('sends a Messages API request with the tools, effort low and no sampling or thinking fields', async () => {
    const { p, requests } = provider([{ body: fixture('claude/answer.json') }])
    expect(p).toMatchObject({ id: 'claude', model: DEFAULT_CLAUDE_MODEL })
    await ask(p)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toMatch(/\/v1\/messages$/)
    const body = requests[0]!.body
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: CLAUDE_MAX_TOKENS,
      system: 'You are the Acme assistant.',
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'How much is a meeting room?' }],
    })
    expect(body.tools).toEqual(TOOL_SPECS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })))
    for (const key of ['thinking', 'temperature', 'top_p', 'top_k', 'tool_choice', 'stream']) expect(body).not.toHaveProperty(key)
  })

  it('uses the configured model and omits tools when there are none', async () => {
    const { p, requests } = provider([{ body: fixture('claude/answer.json') }], 'claude-sonnet-5-5')
    await p.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] })
    expect(p.model).toBe('claude-sonnet-5-5')
    expect(requests[0]!.body.model).toBe('claude-sonnet-5-5')
    expect(requests[0]!.body).not.toHaveProperty('tools')
  })

  it('returns tool calls with usage and the raw content blocks', async () => {
    const recorded = fixture('claude/tool-use.json')
    const { p } = provider([{ body: recorded }])
    expect(await ask(p)).toEqual({
      kind: 'tool_calls',
      calls: [{ id: 'toolu_01RelayFixtureSearch00001', name: 'search_knowledge', input: { query: 'meeting room price' } }],
      text: 'Let me check our prices.',
      usage: { inputTokens: 912, outputTokens: 64 },
      raw: recorded.content,
    })
  })

  it('returns the text of a final answer, ignoring thinking blocks', async () => {
    const { p } = provider([{ body: fixture('claude/answer.json') }])
    expect(await ask(p)).toEqual({
      kind: 'text',
      text: 'A meeting room costs $20 per hour. The small room seats 4 people and the large one seats 8. You can book at the front desk or by message.',
      usage: { inputTokens: 1040, outputTokens: 48 },
    })
  })

  it('a refusal or a truncated answer is a ProviderError', async () => {
    const refused = provider([{ body: fixture('claude/refusal.json') }])
    await expect(ask(refused.p)).rejects.toMatchObject({ name: 'ProviderError', code: 'claude_refusal' })
    const cut = provider([{ body: fixture('claude/max-tokens.json') }])
    await expect(ask(cut.p)).rejects.toMatchObject({ code: 'claude_max_tokens', message: 'claude_max_tokens' })
  })

  it('maps HTTP and network failures to stable codes', async () => {
    const cases: Array<[Recorded, string]> = [
      [{ status: 429, body: fixture('claude/rate-limit.json') }, 'claude_rate_limited'],
      [{ status: 401, body: fixture('claude/auth.json') }, 'claude_auth'],
      [{ status: 529, body: fixture('claude/overloaded.json') }, 'claude_http_529'],
      [{ status: 404, body: { type: 'error', error: { type: 'not_found_error', message: 'model: claude-x' } } }, 'claude_model_not_found'],
      [{ throws: new TypeError('fetch failed') }, 'claude_offline'],
    ]
    for (const [recorded, code] of cases) {
      const { p } = provider([recorded])
      const err = await ask(p).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ProviderError)
      expect((err as ProviderError).code).toBe(code)
      expect((err as Error).message).not.toContain('test-key')
    }
  })

  it('toProviderError keeps an abort as is and wraps unknown errors', () => {
    const abort = new Anthropic.APIUserAbortError()
    expect(toProviderError(abort)).toBe(abort)
    expect(toProviderError(new Error('weird'))).toMatchObject({ code: 'claude_error', message: 'claude_error: weird' })
  })
})

describe('toAnthropicMessages', () => {
  it('drops leading assistant turns, groups tool results and keeps raw turns unchanged', () => {
    const raw = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'r1', name: 'search_knowledge', input: { query: 'x' } }]
    expect(toAnthropicMessages([
      { role: 'assistant', content: 'Welcome back!' },
      { role: 'user', content: 'How much is a meeting room?' },
      { role: 'assistant', content: 'Checking.', toolCalls: [{ id: 't1', name: 'search_knowledge', input: { query: 'meeting room' } }, { id: 't2', name: 'tag_conversation', input: { tags: ['pricing'] } }] },
      { role: 'tool', toolCallId: 't1', name: 'search_knowledge', content: 'NO_RESULTS' },
      { role: 'tool', toolCallId: 't2', name: 'tag_conversation', content: 'ok' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'r1', name: 'search_knowledge', input: { query: 'x' } }], raw },
      { role: 'tool', toolCallId: 'r1', name: 'search_knowledge', content: '[]' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: 'Anything else?' },
      { role: 'user', content: '  ' },
    ])).toEqual([
      { role: 'user', content: 'How much is a meeting room?' },
      { role: 'assistant', content: [
        { type: 'text', text: 'Checking.' },
        { type: 'tool_use', id: 't1', name: 'search_knowledge', input: { query: 'meeting room' } },
        { type: 'tool_use', id: 't2', name: 'tag_conversation', input: { tags: ['pricing'] } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'NO_RESULTS' },
        { type: 'tool_result', tool_use_id: 't2', content: 'ok' },
      ] },
      { role: 'assistant', content: raw },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: '[]' }] },
      { role: 'assistant', content: 'Anything else?' },
      { role: 'user', content: '[empty message]' },
    ])
  })
})
```

Run: `npm test -w apps/api` → FAIL (module `claude.ts` not found).

- [ ] **Step 4: Implement the adapter**

`apps/api/src/agent/providers/claude.ts`:
```ts
import Anthropic from '@anthropic-ai/sdk'
import { ProviderError } from './errors'
import type { ChatMessage, FetchLike, GenerateRequest, GenerateResult, Provider, ToolCall, ToolSpec } from './types'

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5'
/** Room for adaptive thinking plus a short chat answer; non-streaming requests stay well under SDK timeouts. */
export const CLAUDE_MAX_TOKENS = 16_000
const EMPTY_MESSAGE = '[empty message]'

export type ClaudeOptions = { apiKey: string; model?: string; maxRetries?: number; fetch?: FetchLike }

const toAnthropicTool = (t: ToolSpec): Anthropic.Tool => ({
  name: t.name,
  description: t.description,
  input_schema: t.parameters as Anthropic.Tool['input_schema'],
})

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/** Neutral chat history -> Messages API turns (see the rules in plan 3, Task 2). */
export function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content.trim() ? m.content : EMPTY_MESSAGE })
      continue
    }
    if (out.length === 0) continue // the first message must come from the user
    if (m.role === 'tool') {
      const block: Anthropic.ToolResultBlockParam = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }
      const prev = out.at(-1)!
      if (prev.role === 'user' && Array.isArray(prev.content) && prev.content.every((b) => b.type === 'tool_result')) {
        prev.content.push(block)
      } else {
        out.push({ role: 'user', content: [block] })
      }
      continue
    }
    if (m.raw !== undefined) {
      out.push({ role: 'assistant', content: m.raw as Anthropic.ContentBlockParam[] })
      continue
    }
    if (m.toolCalls?.length) {
      const blocks: Anthropic.ContentBlockParam[] = []
      if (m.content.trim()) blocks.push({ type: 'text', text: m.content })
      for (const c of m.toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input })
      out.push({ role: 'assistant', content: blocks })
      continue
    }
    if (m.content.trim()) out.push({ role: 'assistant', content: m.content })
  }
  return out
}

/** SDK errors -> ProviderError with a stable code. An abort is returned as is: the engine already timed out. */
export function toProviderError(err: unknown): Error {
  if (err instanceof Anthropic.APIUserAbortError) return err
  const detail = String((err as Error)?.message ?? err)
  if (err instanceof Anthropic.RateLimitError) return new ProviderError('claude_rate_limited', detail)
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return new ProviderError('claude_auth', detail)
  if (err instanceof Anthropic.NotFoundError) return new ProviderError('claude_model_not_found', detail)
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError('claude_timeout', detail)
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError('claude_offline', detail)
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') return new ProviderError(`claude_http_${err.status}`, detail)
  return new ProviderError('claude_error', detail)
}

/** Claude through the Anthropic Messages API, with the agent's tools as client tools. */
export class ClaudeProvider implements Provider {
  readonly id = 'claude'
  readonly model: string
  private readonly client: Anthropic

  constructor({ apiKey, model, maxRetries = 2, fetch }: ClaudeOptions) {
    this.model = model ?? DEFAULT_CLAUDE_MODEL
    this.client = new Anthropic({ apiKey, maxRetries, ...(fetch ? { fetch } : {}) })
  }

  async generate({ system, messages, tools, signal }: GenerateRequest): Promise<GenerateResult> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: CLAUDE_MAX_TOKENS,
      system,
      messages: toAnthropicMessages(messages),
      ...(tools.length ? { tools: tools.map(toAnthropicTool) } : {}),
      // Short support answers: low effort keeps latency and cost down; thinking stays adaptive (Opus 5.5 cannot disable it).
      output_config: { effort: 'low' },
    }
    let res: Anthropic.Message
    try {
      res = await this.client.messages.create(params, { signal })
    } catch (err) {
      throw toProviderError(err)
    }
    if (res.stop_reason === 'refusal') throw new ProviderError('claude_refusal', res.stop_details?.category ?? '')
    const usage = { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens }
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim()
    const calls: ToolCall[] = res.content.flatMap((b) =>
      b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: asRecord(b.input) }] : [])
    if (calls.length) return { kind: 'tool_calls', calls, ...(text ? { text } : {}), usage, raw: res.content }
    if (res.stop_reason === 'max_tokens' || res.stop_reason === 'model_context_window_exceeded') {
      throw new ProviderError(`claude_${res.stop_reason}`)
    }
    return { kind: 'text', text, usage }
  }
}
```

Note: if `tsc` reports that `Anthropic.MessageCreateParamsNonStreaming` or another type name differs in the installed SDK version, look the name up in `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts` and fix the reference; do not replace SDK types with hand-written interfaces.

- [ ] **Step 5: Run tests and typecheck, then commit**

Run: `npm test -w apps/api` → PASS (no network: the provider only sees the fake `fetch`). `npm run typecheck -w apps/api` → clean.
```bash
git add apps/api package-lock.json
git commit -m "feat(api): Claude provider over the Messages API with recorded-response tests"
```

---

### Task 3: Ollama provider

**Files:**
- Create: `apps/api/src/agent/providers/ollama.ts`, `apps/api/test/fixtures/ollama/text.json`, `apps/api/test/fixtures/ollama/tool-call.json`, `apps/api/test/fixtures/ollama/think-tags.json`, `apps/api/test/fixtures/ollama/no-tools.json`, `apps/api/test/fixtures/ollama/model-not-found.json`
- Test: `apps/api/test/ollama-provider.test.ts`

**Interfaces:**
- Consumes: Task 1 types and `ProviderError`; Task 2 `fakeFetch`, `fixture`.
- Produces (`providers/ollama.ts`):
  - `DEFAULT_OLLAMA_MODEL = 'llama3.2'`, `DEFAULT_OLLAMA_URL = 'http://localhost:11434'`.
  - `class OllamaProvider implements Provider` — constructor `({ url: string; model?: string; fetch?: FetchLike })`; `id: 'ollama'`; `model` = option or default; trailing slashes are removed from `url`; getter `textOnly: boolean`.
  - Request: `POST <url>/api/chat` with JSON `{ model, stream: false, messages, tools? }`. `messages` = `toOllamaMessages(system, messages)`: first `{ role: 'system', content: system }`, then `user` → `{ role: 'user', content }`, `assistant` → `{ role: 'assistant', content }` plus `tool_calls: [{ function: { name, arguments: input } }]` when it has tool calls (`raw` is ignored), `tool` → `{ role: 'tool', content, tool_name: name }`. `tools` (only when tools are supported and non-empty) = `[{ type: 'function', function: { name, description, parameters } }]`.
  - Text-only mode: if a request with tools answers HTTP 400 whose `error` matches `/does not support tools/i`, the provider switches to text-only for the rest of its life (`console.warn('[relay] ollama model "<model>" does not support tools; running in text-only mode')`, once) and repeats the same request without tools. Handoff then relies on the engine's automatic rules (spec §4).
  - Response: `message.tool_calls` non-empty → `tool_calls` with `id` = the call's `id` if present, else `` `ollama-${messages.length}-${index}` ``; `arguments` given as a JSON string are parsed (invalid JSON → `{}`). Otherwise `text` = `message.content` with `<think>…</think>` blocks removed, trimmed. `usage` = `{ inputTokens: prompt_eval_count, outputTokens: eval_count }`.
  - Errors: `fetch` throws and the signal is not aborted → `ProviderError('ollama_offline', <message>)` (an abort is rethrown as is); HTTP 404 → `ollama_model_not_found`; other non-2xx → `ollama_http_<status>`; detail = the `error` string of the body when there is one.
  - `toOllamaMessages(system: string, messages: ChatMessage[]): OllamaMessage[]` is exported for tests.

- [ ] **Step 1: Fixtures**

These are `/api/chat` responses with `stream: false`, as Ollama returns them.

`apps/api/test/fixtures/ollama/text.json`:
```json
{
  "model": "llama3.2",
  "created_at": "2026-11-11T12:00:00.000000Z",
  "message": { "role": "assistant", "content": "Hello! How can I help you today?" },
  "done_reason": "stop",
  "done": true,
  "total_duration": 1834000000,
  "load_duration": 21000000,
  "prompt_eval_count": 412,
  "prompt_eval_duration": 900000000,
  "eval_count": 11,
  "eval_duration": 800000000
}
```

`apps/api/test/fixtures/ollama/tool-call.json`:
```json
{
  "model": "llama3.2",
  "created_at": "2026-11-11T12:00:01.000000Z",
  "message": {
    "role": "assistant",
    "content": "",
    "tool_calls": [
      { "function": { "name": "search_knowledge", "arguments": { "query": "opening hours" } } }
    ]
  },
  "done_reason": "stop",
  "done": true,
  "total_duration": 2410000000,
  "load_duration": 20000000,
  "prompt_eval_count": 655,
  "prompt_eval_duration": 1500000000,
  "eval_count": 21,
  "eval_duration": 850000000
}
```

`apps/api/test/fixtures/ollama/think-tags.json`:
```json
{
  "model": "llama3.2",
  "created_at": "2026-11-11T12:00:02.000000Z",
  "message": { "role": "assistant", "content": "<think>The customer is greeting me.</think>\n\nHi! How can I help?" },
  "done_reason": "stop",
  "done": true,
  "prompt_eval_count": 300,
  "eval_count": 19
}
```

`apps/api/test/fixtures/ollama/no-tools.json` (body of an HTTP 400):
```json
{ "error": "registry.ollama.ai/library/gemma2:2b does not support tools" }
```

`apps/api/test/fixtures/ollama/model-not-found.json` (body of an HTTP 404):
```json
{ "error": "model \"llama3.2\" not found, try pulling it first" }
```

- [ ] **Step 2: Failing test**

`apps/api/test/ollama-provider.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { OllamaProvider, DEFAULT_OLLAMA_MODEL, toOllamaMessages } from '../src/agent/providers/ollama'
import { ProviderError } from '../src/agent/providers/errors'
import { TOOL_SPECS } from '../src/agent/tools'
import { fakeFetch, fixture, type Recorded } from './fake-fetch'

const provider = (responses: Recorded[], model?: string) => {
  const f = fakeFetch(responses)
  return { p: new OllamaProvider({ url: 'http://ollama:11434/', model, fetch: f.fetch }), requests: f.requests }
}
const ask = (p: OllamaProvider, content = 'When are you open?') =>
  p.generate({ system: 'You are the Acme assistant.', messages: [{ role: 'user', content }], tools: TOOL_SPECS })

describe('OllamaProvider', () => {
  it('posts a non-streaming chat request with the system prompt and the tools', async () => {
    const { p, requests } = provider([{ body: fixture('ollama/text.json') }])
    expect(p).toMatchObject({ id: 'ollama', model: DEFAULT_OLLAMA_MODEL })
    expect(p.textOnly).toBe(false)
    await ask(p)
    expect(requests[0]!.url).toBe('http://ollama:11434/api/chat')
    expect(requests[0]!.body).toEqual({
      model: 'llama3.2',
      stream: false,
      messages: [
        { role: 'system', content: 'You are the Acme assistant.' },
        { role: 'user', content: 'When are you open?' },
      ],
      tools: TOOL_SPECS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
    })
  })

  it('returns text with usage, and strips <think> blocks', async () => {
    const { p } = provider([{ body: fixture('ollama/text.json') }, { body: fixture('ollama/think-tags.json') }])
    expect(await ask(p)).toEqual({ kind: 'text', text: 'Hello! How can I help you today?', usage: { inputTokens: 412, outputTokens: 11 } })
    expect(await ask(p)).toMatchObject({ kind: 'text', text: 'Hi! How can I help?' })
  })

  it('returns tool calls with generated ids, and parses string arguments', async () => {
    const stringArgs = fixture('ollama/tool-call.json')
    stringArgs.message.tool_calls = [{ id: 'call_7', function: { name: 'tag_conversation', arguments: '{"tags":["hours"]}' } }]
    const { p } = provider([{ body: fixture('ollama/tool-call.json') }, { body: stringArgs }])
    expect(await ask(p)).toEqual({
      kind: 'tool_calls',
      calls: [{ id: 'ollama-1-0', name: 'search_knowledge', input: { query: 'opening hours' } }],
      usage: { inputTokens: 655, outputTokens: 21 },
    })
    expect(await ask(p)).toMatchObject({ calls: [{ id: 'call_7', name: 'tag_conversation', input: { tags: ['hours'] } }] })
  })

  it('switches to text-only mode once when the model does not support tools', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { p, requests } = provider([
        { status: 400, body: fixture('ollama/no-tools.json') },
        { body: fixture('ollama/text.json') },
        { body: fixture('ollama/text.json') },
      ], 'gemma2:2b')
      expect(await ask(p)).toMatchObject({ kind: 'text', text: 'Hello! How can I help you today?' })
      expect(p.textOnly).toBe(true)
      expect(requests[0]!.body).toHaveProperty('tools')
      expect(requests[1]!.body).not.toHaveProperty('tools')
      await ask(p)
      expect(requests).toHaveLength(3)
      expect(requests[2]!.body).not.toHaveProperty('tools')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith('[relay] ollama model "gemma2:2b" does not support tools; running in text-only mode')
    } finally { warn.mockRestore() }
  })

  it('maps failures to stable codes', async () => {
    const cases: Array<[Recorded, string]> = [
      [{ status: 404, body: fixture('ollama/model-not-found.json') }, 'ollama_model_not_found'],
      [{ status: 500, body: { error: 'llama runner process has terminated' } }, 'ollama_http_500'],
      [{ status: 400, body: { error: 'invalid message format' } }, 'ollama_http_400'],
      [{ throws: new TypeError('fetch failed') }, 'ollama_offline'],
    ]
    for (const [recorded, code] of cases) {
      const { p } = provider([recorded])
      const err = await ask(p).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ProviderError)
      expect((err as ProviderError).code).toBe(code)
    }
    const { p } = provider([{ status: 404, body: fixture('ollama/model-not-found.json') }])
    await expect(ask(p)).rejects.toThrow('ollama_model_not_found: model "llama3.2" not found, try pulling it first')
  })

  it('rethrows an abort instead of reporting the server offline', async () => {
    const controller = new AbortController()
    controller.abort()
    const abortError = new DOMException('This operation was aborted', 'AbortError')
    const { p } = provider([{ throws: abortError }])
    await expect(p.generate({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [], signal: controller.signal })).rejects.toBe(abortError)
  })
})

describe('toOllamaMessages', () => {
  it('maps assistant tool calls and tool results', () => {
    expect(toOllamaMessages('sys', [
      { role: 'user', content: 'hours?' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'search_knowledge', input: { query: 'hours' } }], raw: { ignored: true } },
      { role: 'tool', toolCallId: 'a', name: 'search_knowledge', content: 'NO_RESULTS' },
      { role: 'assistant', content: 'We open at 8:00.' },
    ])).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hours?' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'search_knowledge', arguments: { query: 'hours' } } }] },
      { role: 'tool', content: 'NO_RESULTS', tool_name: 'search_knowledge' },
      { role: 'assistant', content: 'We open at 8:00.' },
    ])
  })
})
```

Run: `npm test -w apps/api` → FAIL (module `ollama.ts` not found).

- [ ] **Step 3: Implement the adapter**

`apps/api/src/agent/providers/ollama.ts`:
```ts
import { ProviderError } from './errors'
import type { ChatMessage, FetchLike, GenerateRequest, GenerateResult, Provider, ToolSpec } from './types'

export const DEFAULT_OLLAMA_MODEL = 'llama3.2'
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434'

type OllamaToolCall = { id?: string; function: { name: string; arguments: Record<string, unknown> | string } }
export type OllamaMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: OllamaToolCall[]
  tool_name?: string
}
type OllamaChatResponse = {
  model: string
  message?: { role: 'assistant'; content?: string; tool_calls?: OllamaToolCall[] }
  done: boolean
  prompt_eval_count?: number
  eval_count?: number
}

/** Reasoning models may inline their thinking; the customer must never see it. */
const THINK_BLOCK = /<think>[\s\S]*?<\/think>/g
const NO_TOOLS = /does not support tools/i

export function toOllamaMessages(system: string, messages: ChatMessage[]): OllamaMessage[] {
  const out: OllamaMessage[] = [{ role: 'system', content: system }]
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content })
    else if (m.role === 'tool') out.push({ role: 'tool', content: m.content, tool_name: m.name })
    else if (m.toolCalls?.length) {
      out.push({ role: 'assistant', content: m.content, tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.input } })) })
    } else out.push({ role: 'assistant', content: m.content })
  }
  return out
}

const toOllamaTool = (t: ToolSpec) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } })

function parseArguments(args: Record<string, unknown> | string | undefined): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args
  if (typeof args !== 'string') return {}
  try {
    const v: unknown = JSON.parse(args)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown }
    return typeof body.error === 'string' ? body.error : ''
  } catch {
    return ''
  }
}

/** A local model through Ollama's /api/chat. Models without tool support fall back to text-only mode. */
export class OllamaProvider implements Provider {
  readonly id = 'ollama'
  readonly model: string
  private readonly url: string
  private readonly fetch: FetchLike
  private toolsSupported = true

  constructor({ url, model, fetch }: { url: string; model?: string; fetch?: FetchLike }) {
    this.url = url.replace(/\/+$/, '')
    this.model = model ?? DEFAULT_OLLAMA_MODEL
    this.fetch = fetch ?? globalThis.fetch
  }

  get textOnly(): boolean {
    return !this.toolsSupported
  }

  async generate({ system, messages, tools, signal }: GenerateRequest): Promise<GenerateResult> {
    const withTools = this.toolsSupported && tools.length > 0
    let res = await this.chat(system, messages, withTools ? tools : [], signal)
    if (withTools && res.status === 400) {
      const detail = await errorText(res)
      if (!NO_TOOLS.test(detail)) throw new ProviderError('ollama_http_400', detail)
      this.toolsSupported = false
      console.warn(`[relay] ollama model "${this.model}" does not support tools; running in text-only mode`)
      res = await this.chat(system, messages, [], signal)
    }
    if (!res.ok) {
      const detail = await errorText(res)
      throw new ProviderError(res.status === 404 ? 'ollama_model_not_found' : `ollama_http_${res.status}`, detail)
    }
    const data = (await res.json()) as OllamaChatResponse
    const usage = { inputTokens: data.prompt_eval_count, outputTokens: data.eval_count }
    const text = (data.message?.content ?? '').replace(THINK_BLOCK, '').trim()
    const calls = data.message?.tool_calls ?? []
    if (calls.length) {
      return {
        kind: 'tool_calls',
        calls: calls.map((c, i) => ({ id: c.id ?? `ollama-${messages.length}-${i}`, name: c.function.name, input: parseArguments(c.function.arguments) })),
        ...(text ? { text } : {}),
        usage,
      }
    }
    return { kind: 'text', text, usage }
  }

  private async chat(system: string, messages: ChatMessage[], tools: ToolSpec[], signal?: AbortSignal): Promise<Response> {
    const body = {
      model: this.model,
      stream: false,
      messages: toOllamaMessages(system, messages),
      ...(tools.length ? { tools: tools.map(toOllamaTool) } : {}),
    }
    try {
      return await this.fetch(`${this.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
    } catch (err) {
      if (signal?.aborted) throw err
      throw new ProviderError('ollama_offline', String((err as Error)?.message ?? err))
    }
  }
}
```

- [ ] **Step 4: Run tests and typecheck, then commit**

Run: `npm test -w apps/api` → PASS. `npm run typecheck -w apps/api` → clean.
```bash
git add apps/api
git commit -m "feat(api): Ollama provider with text-only fallback and recorded-response tests"
```

---

### Task 4: Provider selection, timeouts, wiring and full-turn tests

**Files:**
- Modify: `apps/api/src/agent/providers/index.ts`, `apps/api/src/main.ts`, `apps/api/test/demo-provider.test.ts`, `apps/api/package.json`, `apps/api/tsconfig.json`
- Create: `apps/api/scripts/try-provider.ts`
- Test: `apps/api/test/provider-select.test.ts`, `apps/api/test/providers-engine.test.ts`

**Interfaces:**
- Consumes: `ClaudeProvider`, `DEFAULT_CLAUDE_MODEL` (Task 2); `OllamaProvider`, `DEFAULT_OLLAMA_URL` (Task 3); `DemoProvider` (plan 2); `DEFAULT_TIMEOUT_MS`, `runAgentTurn` (plan 2 engine).
- Produces (`providers/index.ts`):
  - `selectProvider(env: NodeJS.ProcessEnv, opts?: { fetch?: FetchLike }): Provider` — order from Global Constraints. `RELAY_PROVIDER=claude` without a key → warn `[relay] RELAY_PROVIDER=claude needs ANTHROPIC_API_KEY; using the demo provider` and return demo. `RELAY_PROVIDER=ollama` without `OLLAMA_URL` → Ollama at `DEFAULT_OLLAMA_URL`. Unknown value → warn `[relay] unknown RELAY_PROVIDER "<value>"; using the demo provider` and return demo. Each distinct warning is printed once per process. `opts.fetch` is passed to the adapters (tests only).
  - `agentTimeoutMs(env: NodeJS.ProcessEnv, provider: Provider): number` — `RELAY_AGENT_TIMEOUT_MS` when it parses to a positive integer, else `OLLAMA_TIMEOUT_MS = 120_000` for `provider.id === 'ollama'`, else `DEFAULT_TIMEOUT_MS`.
- `main.ts` passes `timeoutMs: agentTimeoutMs(process.env, provider)` to `runAgentTurn` and logs it on startup.
- `scripts/try-provider.ts`: one live request with the selected provider (manual check with a real key or a running Ollama; never run in CI).

- [ ] **Step 1: Failing tests**

`apps/api/test/provider-select.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { selectProvider, agentTimeoutMs } from '../src/agent/providers'
import { DEFAULT_TIMEOUT_MS } from '../src/agent/engine'

const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
afterEach(() => warn.mockClear())

describe('selectProvider', () => {
  it('defaults to the demo provider', () => {
    expect(selectProvider({})).toMatchObject({ id: 'demo', model: 'scripted' })
  })

  it('auto-selects Claude when there is a key, then Ollama when there is a URL', () => {
    expect(selectProvider({ ANTHROPIC_API_KEY: 'k' })).toMatchObject({ id: 'claude', model: 'claude-opus-5-5' })
    expect(selectProvider({ ANTHROPIC_API_KEY: 'k', RELAY_CLAUDE_MODEL: ' claude-sonnet-5-5 ' })).toMatchObject({ id: 'claude', model: 'claude-sonnet-5-5' })
    expect(selectProvider({ OLLAMA_URL: 'http://ollama:11434' })).toMatchObject({ id: 'ollama', model: 'llama3.2' })
    expect(selectProvider({ OLLAMA_URL: 'http://ollama:11434', RELAY_OLLAMA_MODEL: 'qwen3:4b' })).toMatchObject({ id: 'ollama', model: 'qwen3:4b' })
    expect(selectProvider({ ANTHROPIC_API_KEY: 'k', OLLAMA_URL: 'http://ollama:11434' }).id).toBe('claude')
  })

  it('treats empty or blank variables as unset (Docker Compose passes empty strings)', () => {
    expect(selectProvider({ RELAY_PROVIDER: '', ANTHROPIC_API_KEY: '  ', OLLAMA_URL: '' }).id).toBe('demo')
    expect(selectProvider({ ANTHROPIC_API_KEY: 'k', RELAY_CLAUDE_MODEL: '' }).model).toBe('claude-opus-5-5')
  })

  it('RELAY_PROVIDER wins, case-insensitively', () => {
    const both = { ANTHROPIC_API_KEY: 'k', OLLAMA_URL: 'http://ollama:11434' }
    expect(selectProvider({ ...both, RELAY_PROVIDER: 'ollama' }).id).toBe('ollama')
    expect(selectProvider({ ...both, RELAY_PROVIDER: 'Demo' }).id).toBe('demo')
    expect(selectProvider({ ...both, RELAY_PROVIDER: 'CLAUDE' }).id).toBe('claude')
  })

  it('RELAY_PROVIDER=ollama without a URL uses the local default', async () => {
    const calls: string[] = []
    const p = selectProvider({ RELAY_PROVIDER: 'ollama' }, {
      fetch: async (input) => { calls.push(String(input)); return new Response(JSON.stringify({ message: { role: 'assistant', content: 'hi' }, done: true })) },
    })
    await p.generate({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [] })
    expect(calls).toEqual(['http://localhost:11434/api/chat'])
  })

  it('RELAY_PROVIDER=claude without a key falls back to demo and warns once', () => {
    expect(selectProvider({ RELAY_PROVIDER: 'claude' }).id).toBe('demo')
    selectProvider({ RELAY_PROVIDER: 'claude' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[relay] RELAY_PROVIDER=claude needs ANTHROPIC_API_KEY; using the demo provider')
  })

  it('an unknown RELAY_PROVIDER falls back to demo and warns once', () => {
    expect(selectProvider({ RELAY_PROVIDER: 'gpt' }).id).toBe('demo')
    selectProvider({ RELAY_PROVIDER: 'gpt' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[relay] unknown RELAY_PROVIDER "gpt"; using the demo provider')
  })
})

describe('agentTimeoutMs', () => {
  it('uses RELAY_AGENT_TIMEOUT_MS when valid, else a per-provider default', () => {
    const demo = selectProvider({})
    const ollama = selectProvider({ OLLAMA_URL: 'http://ollama:11434' })
    expect(agentTimeoutMs({}, demo)).toBe(DEFAULT_TIMEOUT_MS)
    expect(agentTimeoutMs({}, ollama)).toBe(120_000)
    expect(agentTimeoutMs({ RELAY_AGENT_TIMEOUT_MS: '45000' }, ollama)).toBe(45_000)
    for (const bad of ['', 'abc', '-5', '0', '1.5']) expect(agentTimeoutMs({ RELAY_AGENT_TIMEOUT_MS: bad }, demo)).toBe(DEFAULT_TIMEOUT_MS)
  })
})
```

In `apps/api/test/demo-provider.test.ts`, delete the test `'selectProvider falls back to demo and warns once for an unknown provider'` and the now-unused `selectProvider` and `vi` imports (selection is covered by `provider-select.test.ts`; `'claude'` is a real provider now).

`apps/api/test/providers-engine.test.ts` — full agent turns over recorded responses (this also proves the follow-up "real providers get all passages": the tool result sent back holds every search hit):
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createDb } from '../src/db/client'
import { seed } from '../src/db/seed'
import { EventBus } from '../src/core/events'
import { ChannelRegistry } from '../src/channels/types'
import { receiveInbound, getConversation } from '../src/core/conversations'
import { loadKnowledge, searchKnowledge } from '../src/agent/knowledge'
import { ClaudeProvider } from '../src/agent/providers/claude'
import { OllamaProvider } from '../src/agent/providers/ollama'
import { runAgentTurn, type EngineDeps } from '../src/agent/engine'
import { listRuns } from '../src/agent/runs'
import type { Provider } from '../src/agent/providers/types'
import { fakeFetch, fixture, type Recorded } from './fake-fetch'

const KB = loadKnowledge(fileURLToPath(new URL('../knowledge', import.meta.url)))
let deps: EngineDeps

async function setup(provider: Provider) {
  const db = createDb(':memory:')
  await seed(db)
  const channels = new ChannelRegistry()
  channels.register({ id: 'widget', send: async () => {} })
  deps = { db, bus: new EventBus(), channels, provider, knowledge: () => KB }
}
const claude = (responses: Recorded[]) => {
  const f = fakeFetch(responses)
  return { provider: new ClaudeProvider({ apiKey: 'test-key', maxRetries: 0, fetch: f.fetch }), requests: f.requests }
}
const ask = (text: string) => receiveInbound(deps, { channel: 'widget', contactKey: 'k'.repeat(64), type: 'text', text }).conversation.id

describe('agent turns over recorded provider responses', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('Claude: search, then answer; the thinking turn is replayed unchanged and all passages are sent', async () => {
    const toolUse = fixture('claude/tool-use.json')
    const answer = fixture('claude/answer.json')
    const { provider, requests } = claude([{ body: toolUse }, { body: answer }])
    await setup(provider)
    const id = ask('How much is a meeting room?')

    expect((await runAgentTurn(deps, id)).outcome).toBe('replied')
    expect(getConversation(deps, id)!.messages.at(-1)).toMatchObject({ sender: 'agent', text: answer.content[1].text })

    const second = requests[1]!.body.messages
    expect(second.at(-2)).toEqual({ role: 'assistant', content: toolUse.content })
    const result = second.at(-1).content[0]
    expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_01RelayFixtureSearch00001' })
    const sent = JSON.parse(result.content) as Array<{ title: string }>
    expect(sent.map((p) => p.title)).toEqual(searchKnowledge(KB, 'meeting room price').map((p) => p.title))

    expect(listRuns(deps.db, id)[0]).toMatchObject({
      provider: 'claude', model: 'claude-opus-5-5', outcome: 'replied', inputTokens: 912 + 1040, outputTokens: 64 + 48, error: null,
    })
  })

  it('Claude: a rate limit hands off and logs a failed run with a stable code', async () => {
    const { provider } = claude([{ status: 429, body: fixture('claude/rate-limit.json') }])
    await setup(provider)
    const id = ask('How much is a meeting room?')
    expect((await runAgentTurn(deps, id)).outcome).toBe('failed')
    expect(getConversation(deps, id)!.conversation).toMatchObject({ status: 'waiting_human', handoffReason: 'The AI provider failed' })
    expect(listRuns(deps.db, id)[0]!.error).toMatch(/^claude_rate_limited: /)
  })

  it('Claude: a refusal hands off', async () => {
    const { provider } = claude([{ body: fixture('claude/refusal.json') }])
    await setup(provider)
    const id = ask('How much is a meeting room?')
    expect((await runAgentTurn(deps, id)).outcome).toBe('failed')
    expect(listRuns(deps.db, id)[0]!.error).toBe('claude_refusal')
  })

  it('Ollama: a model without tools still answers in text-only mode', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = fakeFetch([{ status: 400, body: fixture('ollama/no-tools.json') }, { body: fixture('ollama/text.json') }])
    await setup(new OllamaProvider({ url: 'http://ollama:11434', model: 'gemma2:2b', fetch: f.fetch }))
    const id = ask('hello there')
    expect((await runAgentTurn(deps, id)).outcome).toBe('replied')
    expect(getConversation(deps, id)!.messages.at(-1)!.text).toBe('Hello! How can I help you today?')
    expect(listRuns(deps.db, id)[0]).toMatchObject({ provider: 'ollama', model: 'gemma2:2b', inputTokens: 412, outputTokens: 11 })
  })

  it('Ollama: the server being down hands off', async () => {
    const f = fakeFetch([{ throws: new TypeError('fetch failed') }])
    await setup(new OllamaProvider({ url: 'http://ollama:11434', fetch: f.fetch }))
    const id = ask('hello there')
    expect((await runAgentTurn(deps, id)).outcome).toBe('failed')
    expect(listRuns(deps.db, id)[0]!.error).toBe('ollama_offline: fetch failed')
  })
})
```

Run: `npm test -w apps/api` → FAIL (`agentTimeoutMs` is not exported; `selectProvider` still always returns demo).

- [ ] **Step 2: Selection and timeout**

Replace `apps/api/src/agent/providers/index.ts`:
```ts
import { DEFAULT_TIMEOUT_MS } from '../engine'
import { ClaudeProvider } from './claude'
import { DemoProvider } from './demo'
import { DEFAULT_OLLAMA_URL, OllamaProvider } from './ollama'
import type { FetchLike, Provider } from './types'

/** Local models are slower, especially on CPU and on the first request that loads the model. */
export const OLLAMA_TIMEOUT_MS = 120_000

const warned = new Set<string>()
function warnOnce(message: string) {
  if (warned.has(message)) return
  warned.add(message)
  console.warn(message)
}

/** Docker Compose passes unset variables as empty strings: treat blank as unset. */
const read = (env: NodeJS.ProcessEnv, key: string) => env[key]?.trim() || undefined

/** Spec §4: RELAY_PROVIDER if set; otherwise Claude if there is a key, then Ollama if there is a URL, then demo. */
export function selectProvider(env: NodeJS.ProcessEnv, opts: { fetch?: FetchLike } = {}): Provider {
  const apiKey = read(env, 'ANTHROPIC_API_KEY')
  const ollamaUrl = read(env, 'OLLAMA_URL')
  const claude = (key: string) => new ClaudeProvider({ apiKey: key, model: read(env, 'RELAY_CLAUDE_MODEL'), fetch: opts.fetch })
  const ollama = (url: string) => new OllamaProvider({ url, model: read(env, 'RELAY_OLLAMA_MODEL'), fetch: opts.fetch })

  const wanted = read(env, 'RELAY_PROVIDER')?.toLowerCase()
  if (wanted === 'demo') return new DemoProvider()
  if (wanted === 'claude') {
    if (apiKey) return claude(apiKey)
    warnOnce('[relay] RELAY_PROVIDER=claude needs ANTHROPIC_API_KEY; using the demo provider')
    return new DemoProvider()
  }
  if (wanted === 'ollama') return ollama(ollamaUrl ?? DEFAULT_OLLAMA_URL)
  if (wanted) {
    warnOnce(`[relay] unknown RELAY_PROVIDER "${wanted}"; using the demo provider`)
    return new DemoProvider()
  }
  if (apiKey) return claude(apiKey)
  if (ollamaUrl) return ollama(ollamaUrl)
  return new DemoProvider()
}

export function agentTimeoutMs(env: NodeJS.ProcessEnv, provider: Provider): number {
  const raw = read(env, 'RELAY_AGENT_TIMEOUT_MS')
  const n = raw === undefined ? NaN : Number(raw)
  if (Number.isInteger(n) && n > 0) return n
  return provider.id === 'ollama' ? OLLAMA_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
}
```

(`engine.ts` imports only `./providers/types`, so importing `DEFAULT_TIMEOUT_MS` from it here creates no import cycle.)

- [ ] **Step 3: Wiring in `main.ts`**

In `apps/api/src/main.ts`, change the import to `import { agentTimeoutMs, selectProvider } from './agent/providers'` and replace the provider/queue block:
```ts
const provider = selectProvider(process.env)
const timeoutMs = agentTimeoutMs(process.env, provider)
const knowledgeDir = process.env.RELAY_KNOWLEDGE_DIR ?? fileURLToPath(new URL('../knowledge', import.meta.url))
const knowledge = loadKnowledge(knowledgeDir)
const queue = new AgentQueue((id) => runAgentTurn({ db, bus, channels, provider, knowledge: () => knowledge, timeoutMs }, id), bus)
queue.start()
console.log(`[relay] agent provider: ${provider.id} (${provider.model ?? 'n/a'}), timeout ${timeoutMs} ms, knowledge passages: ${knowledge.length}`)
```

- [ ] **Step 4: Manual check script**

`apps/api/scripts/try-provider.ts`:
```ts
/**
 * Sends one question to the provider selected from the environment and prints the raw result.
 * Manual check only (it calls the real API or a running Ollama); never part of the test suite.
 *   ANTHROPIC_API_KEY=... npm run try-provider -w apps/api -- "How much is a meeting room?"
 */
import { agentTimeoutMs, selectProvider } from '../src/agent/providers'
import { TOOL_SPECS } from '../src/agent/tools'

const question = process.argv.slice(2).join(' ').trim() || 'How much is a meeting room?'
const provider = selectProvider(process.env)
console.log(`provider: ${provider.id} (${provider.model ?? 'n/a'})`)
const started = Date.now()
const result = await provider.generate({
  system: 'You are the assistant of Acme Coworking, a fictional coworking space. Keep answers short.',
  messages: [{ role: 'user', content: question }],
  tools: TOOL_SPECS,
  signal: AbortSignal.timeout(agentTimeoutMs(process.env, provider)),
})
const { raw: _raw, ...shown } = result as typeof result & { raw?: unknown }
console.log(JSON.stringify(shown, null, 2))
console.log(`${Date.now() - started} ms`)
```

In `apps/api/package.json` add the script `"try-provider": "tsx scripts/try-provider.ts"`. In `apps/api/tsconfig.json` change `include` to `["src", "test", "scripts", "vitest.config.ts", "drizzle.config.ts"]`.

- [ ] **Step 5: Run tests and typecheck, then commit**

Run: `npm test -w apps/api` → PASS. `npm run typecheck -w apps/api` → clean. `npm run try-provider -w apps/api` with no variables set → prints `provider: demo (scripted)` and a `search_knowledge` tool call (no network).
```bash
git add apps/api
git commit -m "feat(api): select Claude, Ollama or demo from the environment, per-provider timeout"
```

---

### Task 5: EventBus hardening (follow-ups)

From "Small hardening (any plan)" in the follow-ups file.

**Files:**
- Modify: `apps/api/src/core/events.ts`
- Test: `apps/api/test/events.test.ts` (extend)

**Interfaces:**
- `EventBus.on(event, fn)`: registering the same `fn` again for the same event is ignored (one call per emit; one `off` removes it).
- Listener results that are thenables (not only native `Promise`s) have their rejection logged via `Promise.resolve(result).catch(...)`.
- `type Listener<K> = (data: RelayEvents[K]) => void | Promise<void>` (the `as any` casts in tests for async listeners are no longer needed).

- [ ] **Step 1: Failing tests**

Append inside `describe('EventBus', ...)` in `apps/api/test/events.test.ts`:
```ts
  it('ignores a second registration of the same listener; one off removes it', () => {
    const bus = new EventBus()
    const fn = vi.fn()
    bus.on('message.created', fn)
    bus.on('message.created', fn)
    bus.emit('message.created', payload)
    expect(fn).toHaveBeenCalledTimes(1)
    bus.off('message.created', fn)
    bus.emit('message.created', payload)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('logs a rejecting non-native thenable', async () => {
    const bus = new EventBus()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const boom = new Error('thenable boom')
      const thenable = { then: (_ok: unknown, fail: (e: unknown) => void) => fail(boom) }
      bus.on('message.created', () => thenable as unknown as Promise<void>)
      bus.emit('message.created', payload)
      await new Promise((r) => setImmediate(r))
      expect(err).toHaveBeenCalledWith('[relay] event listener failed', 'message.created', boom)
    } finally { err.mockRestore() }
  })

  it('accepts async listeners without casts', async () => {
    const bus = new EventBus()
    const seen: number[] = []
    bus.on('message.created', async ({ conversationId }) => { seen.push(conversationId) })
    bus.emit('message.created', payload)
    await new Promise((r) => setImmediate(r))
    expect(seen).toEqual([1])
  })
```

Run: `npm test -w apps/api` → FAIL (the listener runs twice; the thenable rejection is not logged).

- [ ] **Step 2: Implement**

In `apps/api/src/core/events.ts`, replace the `Listener` type and the `on` method:
```ts
type Listener<K extends keyof RelayEvents> = (data: RelayEvents[K]) => void | Promise<void>

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  !!v && (typeof v === 'object' || typeof v === 'function') && typeof (v as { then?: unknown }).then === 'function'
```
```ts
  on<K extends keyof RelayEvents>(event: K, fn: Listener<K>): void {
    let byFn = this.wrappers.get(event)
    if (!byFn) this.wrappers.set(event, (byFn = new Map()))
    if (byFn.has(fn)) return // same listener twice would run twice and need two offs
    const fail = (err: unknown) => console.error('[relay] event listener failed', event, err)
    const wrapper: Listener<K> = (data) => {
      try {
        const result: unknown = fn(data)
        if (isThenable(result)) Promise.resolve(result).catch(fail)
      } catch (err) {
        fail(err)
      }
    }
    byFn.set(fn, wrapper)
    this.emitter.on(event, wrapper)
  }
```
Keep `off` and `emit` as they are. Remove the now-unneeded `as any` cast in the existing `'logs a rejecting async listener'` test.

- [ ] **Step 3: Run tests and typecheck, then commit**

Run: `npm test -w apps/api` → PASS. `npm run typecheck -w apps/api` → clean.
```bash
git add apps/api
git commit -m "fix(api): EventBus ignores duplicate listeners and logs rejected thenables"
```

---

### Task 6: Configuration, docs and end-to-end check

**Files:**
- Modify: `docker-compose.yml`, `README.md`, `docs/superpowers/plans/followups-after-plan-1.md`
- Create: `.env.example`

- [ ] **Step 1: Docker Compose and `.env.example`**

Replace the `api` service in `docker-compose.yml` (the `web` service and `volumes` stay as they are):
```yaml
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
    # Lets the container reach an Ollama running on the host (Linux needs this; Docker Desktop has it built in).
    extra_hosts: ["host.docker.internal:host-gateway"]
    restart: unless-stopped
```

`.env.example` (repository root; `.env` is already in `.gitignore` and `.dockerignore`, and Docker Compose reads it automatically):
```bash
# Copy to .env and fill in what you need. Everything is optional:
# with nothing set, the agent runs on the scripted demo provider.

# claude | ollama | demo. Empty = automatic (Claude if there is a key, then Ollama if there is a URL, then demo).
RELAY_PROVIDER=

# Claude (Anthropic API). The conversation history and knowledge passages are sent to the API.
ANTHROPIC_API_KEY=
# Default: claude-opus-5-5
RELAY_CLAUDE_MODEL=

# Ollama (local models; nothing leaves your machine). From Docker use http://host.docker.internal:11434
OLLAMA_URL=
# Default: llama3.2 (pull it first: ollama pull llama3.2). Models without tool support run in text-only mode.
RELAY_OLLAMA_MODEL=

# Per-request agent timeout in ms. Default: 30000, or 120000 for Ollama.
RELAY_AGENT_TIMEOUT_MS=
```

Run: `docker compose config --quiet` → exits 0 (valid file). If Docker is not installed, skip this check and say so in the task report.

- [ ] **Step 2: README**

Replace the status line with:
```markdown
> Status: plan 3 of 6 — the agent runs on Claude, a local Ollama model, or a scripted demo provider. Next: the settings screen and knowledge base editor.
```

After the existing "The AI agent" section, add:
```markdown
## Choosing the AI provider

The agent talks to models through one small provider interface. Relay picks the provider from the environment:

1. `RELAY_PROVIDER` (`claude`, `ollama` or `demo`) if it is set;
2. otherwise **Claude** if `ANTHROPIC_API_KEY` is set;
3. otherwise **Ollama** if `OLLAMA_URL` is set;
4. otherwise the scripted **demo** provider.

With Docker, copy `.env.example` to `.env` and fill in what you need; for `npm run dev:api`, export the variables in your shell.

| Variable | Default | What it does |
| --- | --- | --- |
| `RELAY_PROVIDER` | automatic | Force `claude`, `ollama` or `demo`. |
| `ANTHROPIC_API_KEY` | — | Enables Claude (Anthropic Messages API, with tool use). |
| `RELAY_CLAUDE_MODEL` | `claude-opus-5-5` | Claude model ID. |
| `OLLAMA_URL` | — | Enables Ollama, e.g. `http://localhost:11434` (from Docker: `http://host.docker.internal:11434`). |
| `RELAY_OLLAMA_MODEL` | `llama3.2` | Ollama model; run `ollama pull <model>` first. |
| `RELAY_AGENT_TIMEOUT_MS` | `30000` (`120000` for Ollama) | Time limit for each model call. |
| `RELAY_KNOWLEDGE_DIR` | `apps/api/knowledge` | Folder with the Markdown knowledge base. |

Notes:

- **Privacy.** With Claude, the recent conversation and the knowledge passages the agent looks up are sent to the Anthropic API. With Ollama, everything stays on your machine.
- **Failures never strand the customer.** A rate limit, a timeout, a refusal, an unreachable server or an empty answer hands the conversation to a person; the reason shows under "Agent activity" (for example `claude_rate_limited` or `ollama_offline`).
- **Models without tool support** (some small Ollama models) run in text-only mode: they answer, but cannot search the knowledge base or hand off by themselves; handoff keywords and the turn limit still apply.
- **Quick check** of your configuration, outside the app: `npm run try-provider -w apps/api -- "How much is a meeting room?"` sends one real request and prints the result.
- **Tests never call a model.** The Claude and Ollama adapters are tested against recorded responses in `apps/api/test/fixtures/`, so CI needs no key and no network.
```

In "Roadmap", remove "Claude and Ollama providers · ". In "Em português", append:
```markdown
Para usar um modelo de verdade, defina `ANTHROPIC_API_KEY` (Claude) ou `OLLAMA_URL` (modelo local com Ollama) — copie `.env.example` para `.env`. Sem nada configurado, continua o provedor de demonstração. Se o provedor falhar (limite de uso, tempo esgotado, servidor fora do ar), a conversa vai para um atendente humano.
```

- [ ] **Step 3: Follow-ups file**

In `docs/superpowers/plans/followups-after-plan-1.md`:
- Add a section `## Done in plan 3` with: "Real providers receive every search passage (the engine sends all hits; covered by `providers-engine.test.ts`)." and "`EventBus.on`: duplicate registrations ignored, non-native thenables caught, `Listener` typed as `void | Promise<void>`."
- Remove the line "The demo provider only reads the first search hit; real providers (plan 3) get all passages." from "Found during plan 2" and delete the "Small hardening (any plan)" section (both now done).
- Under "Found during plan 2 (for later)", add: "Text-only Ollama models cannot call `search_knowledge`; consider putting the top passages in the system prompt for them (spec §4 'What it receives') together with the settings work in plan 4."

- [ ] **Step 4: End-to-end check**

1. Demo still works with no configuration: start `npm run dev:api` and `npm run dev:web` in the background with no provider variables set; the API log shows `agent provider: demo (scripted), timeout 30000 ms`. Run the same widget check as plan 2 Task 7 (send "What are your opening hours?" through `ws://localhost:5173/ws/widget?token=<36+ char token>` and confirm an `agent` message containing "Opening hours" arrives). Stop both servers.
2. Selection: `RELAY_PROVIDER=ollama OLLAMA_URL=http://127.0.0.1:9 npm run dev:api` → the log shows `agent provider: ollama (llama3.2), timeout 120000 ms`. Send one widget message; confirm the customer receives the handoff message and `GET /api/conversations/:id/agent-runs` (logged in as the demo user with `curl` and the cookie) lists a `failed` run whose `error` starts with `ollama_offline`. Stop the server.
3. Live checks are optional and manual (they need a key or a running Ollama; never in CI): if `ANTHROPIC_API_KEY` is available, `npm run try-provider -w apps/api` prints a `search_knowledge` tool call or a short answer from `claude-opus-5-5`; if Ollama is running, `OLLAMA_URL=http://localhost:11434 npm run try-provider -w apps/api` does the same with `llama3.2`. Report which of these were run.
4. Delete the untracked `apps/api/data`.

- [ ] **Step 5: Full suite and commit**

Run from the root: `npm test` and `npm run typecheck` → PASS / clean. Confirm `git grep -n "sk-ant-"` finds nothing.
```bash
git add docker-compose.yml .env.example README.md docs/superpowers/plans/followups-after-plan-1.md
git commit -m "docs: provider configuration, compose variables and plan-3 follow-ups status"
```
