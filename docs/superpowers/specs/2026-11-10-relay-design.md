# Relay — design

**Date:** 2026-11-10
**Status:** approved in brainstorming, pending written-spec review

## 1. Purpose

Relay is an open-source omnichannel inbox with an AI agent and local voice transcription. It is a portfolio project, written from scratch, that shows:

- a real-time support inbox (customer widget on one side, team inbox on the other);
- an AI agent that answers on its own and hands off to a human when it should;
- voice messages transcribed locally with Whisper, so audio never leaves the server.

**Success criterion:** someone who clones the repository and runs `docker compose up`, with no API key and no configuration, sees the whole flow working in under five minutes: a message from the widget, an agent reply, a handoff to a human, and a transcribed voice message.

## 2. Scope

### In v1
- Web chat widget (text and voice recorded in the browser).
- Team inbox: conversation list, timeline, assign, hand back to agent, close, team reply. Live updates.
- AI agent with rules, tools, and three providers: Claude, Ollama, and a scripted demo provider.
- Local transcription service (faster-whisper).
- Agent settings screen and a Markdown knowledge base.
- Channel interface with the widget implemented; the WhatsApp connector exists only as an interface plus a contract test.
- UI in English and Portuguese; code and docs in English, README with a Portuguese section.
- Docker Compose, CI on GitHub Actions, MIT license.

### Out of v1 (roadmap in the README)
Real WhatsApp connector, multi-tenant (several companies), fine-grained permissions, vector search, cloud deployment.

## 3. Architecture

TypeScript monorepo (npm workspaces):

```
apps/web             React + Vite: team inbox and the widget demo page
apps/api             Node + TypeScript (Fastify): REST, WebSocket, agent queue
  src/channels/        Channel interface; widget (v1); whatsapp (interface only)
  src/agent/           agent engine: rules, tools, provider interface
    providers/         claude | ollama | demo
  src/transcription/   transcriber client (never throws)
  src/db/              SQLite via Drizzle: schema, migrations, seed
services/transcriber Python + faster-whisper, HTTP on the internal network only
docker-compose.yml   web, api, transcriber
```

### Message flow
1. The customer sends a message (text or audio) from the widget over WebSocket.
2. The API stores it and broadcasts `message.created` to the inbox.
3. If it is audio and transcription is on, the API asks the transcriber for the text and stores it on the message (`message.updated` to the inbox).
4. If the conversation has no assignee, the agent queue runs a turn.
5. The agent replies or hands off; the reply goes back to the widget and the inbox updates live.

The agent turn runs in an in-process queue, one turn per conversation at a time, so two quick messages from the same customer never produce two parallel replies.

## 4. The agent

### When it replies
- The conversation is `open` and has no assignee.
- There is a new customer message since the last message from the company (agent, team member, or system).
- The conversation is below the turn limit (configurable, default 10). Reaching the limit hands off.

### What it receives
- The agent instructions (persona, tone, what it may and may not promise).
- The last N messages of the conversation (default 20). Audio appears as `[customer audio, transcribed] <text>` or as `[audio]` when no transcription is available.
- Knowledge base passages relevant to the latest message. v1 uses Markdown files with keyword search (BM25-style scoring). No vector database.

### Tools
- `search_knowledge(query)` — searches the knowledge base.
- `transfer_to_human(reason)` — removes the agent from the conversation: status becomes `waiting_human`, the reason shows in the inbox, and the configured handoff message is sent to the customer.
- `tag_conversation(tags)` — adds tags to the conversation.

### Automatic handoff (does not depend on the model)
- The customer writes one of the configured handoff keywords (default: "human", "agent", "atendente", "humano").
- The provider fails, times out, or returns an empty reply. The customer is never left without an answer.

### Providers
One interface:

```ts
generate({ system, messages, tools }): Promise<
  { kind: 'text'; text: string; usage?: Usage } |
  { kind: 'tool_calls'; calls: ToolCall[]; usage?: Usage }
>
```

- **Claude** — used when `ANTHROPIC_API_KEY` is set. Model configurable, defaulting to a current Claude model.
- **Ollama** — used when `OLLAMA_URL` is set. Models without tool support run in text-only mode; handoff then relies on the automatic rules above.
- **Demo** — the default when nothing is configured. A scripted provider (greeting, pricing from the knowledge base, "I want a human" leads to a transfer) so the full flow is visible with no setup.

Selection order: `RELAY_PROVIDER` if set; otherwise Claude if there is a key, then Ollama if there is a URL, then Demo.

### Run log
Every turn writes an `agent_runs` row: provider, model, duration, tokens (when reported), and outcome (`replied | transferred | failed`). The inbox shows these in an "Agent activity" panel per conversation.

## 5. Transcription

### Service (`services/transcriber`)
- `GET /health` returns `{ ok, model, loaded, error }`.
- `POST /transcribe` takes the raw audio body (language in an `X-Language` header, default `pt`) and returns `{ text, duration_s, processing_s, model }`.
- `X-Language: auto` lets Whisper detect the language. While the model is loading, or if it failed to load, `POST /transcribe` answers 503.
- The model loads once at startup; one transcription at a time.
- Default model `small`; `TRANSCRIBER_MODEL` can select another (for example `large-v3-turbo`). The README includes a table of measured times per model.
- Body limit 25 MB; a negative or invalid `Content-Length` returns 400 at once.
- Audio stays in memory; the log never contains the text.
- Listens only on the internal Docker network.

### Client (`apps/api/src/transcription`)
- Never throws. Returns `{ ok: true, text } | { ok: false, error: 'timeout' | 'offline' | 'http_<status>' | 'unreadable' }`.
- Per-audio deadline (default 40 s) and a per-turn total (default 40 s).
- `offline`: nothing is stored, so the same audio is retried when the service comes back.
- Other failures store `transcription.status = 'failed'` and are not retried.
- Empty speech stores `status = 'empty'`.
- The agent turn always proceeds; a missing transcription becomes `[audio]`.
- A 503 counts as `offline`. With `TRANSCRIBER_URL` unset the API does not transcribe (development without Python). Transcription runs in the agent queue before each turn, also for assigned conversations; an offline transcriber is polled on `/health` and the waiting conversations are retried when the model is loaded.

## 6. Channels

```ts
interface Channel {
  id: 'widget' | 'whatsapp'
  send(target: { conversation: Conversation; contact: Contact }, message: Message): Promise<void>
}
```

All outbound messages (team, agent, system) go through one core function, `postOutbound`, which stores the message, then delivers it; a delivery failure is logged and never creates a duplicate.

Inbound messages are normalized to `{ channel, contactKey, type: 'text' | 'audio', text?, mediaPath? }` before they reach the core.

- **Widget (v1):** WebSocket with the visitor. The visitor is identified by an anonymous token stored in the browser. Voice is recorded with `MediaRecorder` (webm/opus) and uploaded as binary with `POST /api/widget/audio` (visitor token in the `X-Relay-Visitor` header, at most 10 MB). Visitors receive messages without internal fields (no user ids, file names or transcriptions).
- **WhatsApp (v2):** disabled. v1 ships the interface and a contract test so the core proves it is channel-agnostic.

## 7. Data (SQLite + Drizzle)

- `users` — team members (seeded demo user).
- `contacts` — `id, channel, contact_key, name`.
- `conversations` — `id, contact_id, channel, status (open | waiting_human | closed), assignee_id, agent_turns, tags (JSON), handoff_reason, created_at, updated_at`.
- `messages` — `id, conversation_id, sender (contact | agent | user | system), type (text | audio), text, media_path, media_mime, transcription (JSON), created_at`.
- `agent_runs` — `id, conversation_id, provider, model, duration_ms, input_tokens, output_tokens, outcome, error, created_at`.
- `settings` — agent instructions, handoff keywords, turn limit, handoff message, transcription on/off.

Audio files live in `data/media` (a Docker volume). The knowledge base lives in `data/knowledge/*.md`, editable from the settings screen, seeded from `apps/api/knowledge` on first start; names are lowercase `a-z0-9-` ending in `.md`, at most 50 files of 100 KB.

## 8. Authentication

Login with an httpOnly session cookie. A single role (team member). The demo page shows the seeded credentials. Passwords are hashed with a slow hash function (argon2 or scrypt).

## 9. Screens (`apps/web`)

- **Login.**
- **Inbox**, three columns:
  - conversation list with filters (All, Waiting for human, Mine, Closed);
  - timeline with an audio player and the transcription below it, plus a team reply box;
  - contact panel with tags and "Agent activity".
- Actions: **Assign to me**, **Hand back to agent**, **Close**.
- **Agent settings:** instructions, handoff keywords, turn limit, handoff message, transcription on/off, knowledge base editor.
- **Widget demo page (`/demo`):** a fictional company site with the widget in the corner. Opening it next to the inbox shows both sides of the conversation.
- Light and dark themes; English and Portuguese.

## 10. Error handling

- Agent turn: any provider error becomes a handoff with a recorded reason; a run is always logged.
- Transcription: as described in section 5; it never blocks or crashes a turn.
- WebSocket: the widget and the inbox reconnect with backoff and refetch the conversation after reconnecting, so no message is lost.
- API: input validated at the edge (zod); errors return `{ error, code }` with a stable code. Validation errors also list the offending `fields`.

## 11. Testing

- **API (Vitest):** agent rules (when it replies, when it hands off), the demo provider, the transcriber client with a fake, channels, and routes, against a temporary SQLite database.
- **Providers:** the Claude and Ollama adapters are tested against recorded responses (no network in CI).
- **Transcriber (pytest):** with a fake model, so CI never downloads Whisper.
- **Web:** component tests on the inbox and widget pieces, plus one Playwright end-to-end test: customer message, demo agent reply, "I want a human" handoff, team reply.
- **CI:** lint, type check, and tests on every push.

## 12. Delivery

- `docker compose up` brings up web, api, and transcriber. With no configuration it runs in demo mode.
- README in English: demo GIF, architecture diagram, technical decisions (why local transcription, why a scripted demo provider), configuration, roadmap, and a section in Portuguese.
- MIT license.
- The repository contains no data, names, or code from any employer; all sample data is fictional.

## 13. Build order

Each step ends with something that runs.

1. Monorepo skeleton, database schema, seed, Docker Compose.
2. Inbox and widget with real-time messages, no AI yet.
3. Agent engine with the demo provider (rules, tools, handoff, run log).
4. Claude and Ollama providers.
5. Transcription service and client; voice in the widget.
6. Settings screen, i18n, polish, README, CI.
