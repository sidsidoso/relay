# Follow-ups after plan 1

Findings from the plan-1 reviews that were deliberately deferred. Each later plan should pull its items into its own tasks.

## Done in plan 2
- Multi-step writes (`receiveInbound`, outbound messages, agent replies) run in `db.transaction`.
- One outbound path, `postOutbound`, for `user` | `agent` | `system`; a rejected `channel.send` is logged and the stored message is never duplicated.
- Status rules: replying to or assigning a closed conversation answers 409 `conversation_closed`; `handBack` resets `agentTurns`.
- Inbox list refetch triggered by live frames is debounced (at most one request per 300 ms).
- WebSocket frames are typed (`connectLive<F>`, `InboxFrame`, widget frame union).
- Graceful shutdown on SIGINT/SIGTERM waits for in-flight agent turns.
- Conversation-service tests extended (NotFound on close/handBack/teamReply/addTags, `[audio]` fallback, `handoffReason` cleared, event order, contact name update).
- Spec §6 channel contract updated.
- Typed settings for the agent keys (`agentSettings`); the generic settings API is still plan 4.

## Done in plan 3
- Real providers receive every search passage (the engine sends all hits; covered by `providers-engine.test.ts`).
- `EventBus.on`: duplicate registrations ignored, non-native thenables caught, `Listener` typed as `void | Promise<void>`.

## Done in plan 4
- Widget history is merged by message id.
- Visitors receive a public message shape (`toVisitorMessage`): no `userId`, `mediaPath` or transcription.
- Transcriptions (and an audio player) in the inbox Timeline, updated live by `message.updated`.
- Audio is uploaded over HTTP (`POST /api/widget/audio`, 10 MB), so the WebSocket keeps its 64 KiB `maxPayload`.
- Widget UI pass: `aria-live`, auto-scroll, close button `type="button"`, height capped on short viewports, no empty bubbles.
- Default handoff keywords no longer include `agent`; the seed upgrades the old default list; keywords also match transcriptions.

## Plan 5 — settings and knowledge base
- Typed settings instead of `Record<string, unknown>`.
- Unify validation error codes (login still answers `invalid_body`, everything else `invalid_request`).
- Inbox UX: in-flight guard on team replies (no double submit), keep a newer draft when a reply succeeds, Timeline auto-scroll, accessibility (reply input label, `aria-pressed` on filters, login button disabled while submitting).
- Show the demo credentials on `/demo` (spec §8).
- Paginate `listConversations`.
- Text-only Ollama models cannot call `search_knowledge`; consider putting the top passages in the system prompt for them (spec §4 'What it receives').

## Plan 6 — polish, CI, public demo hardening
- Rate limit and per-token cap on `POST /api/widget/audio`; a retention policy for the media folder.
- CI runs the transcriber tests (`python -m pytest` in `services/transcriber`) and builds its image.
- HTTP Range support on the audio route (seeking in long recordings).
- Compose healthcheck for the transcriber (`GET /health`).
- Build the Docker images in CI before advertising `docker compose up --build`.
- Enable the Fastify logger in `main.ts`; add `setNotFoundHandler` returning `{ error, code }`.
- Sessions: `secure` cookie flag in production, cookie `maxAge` aligned with the 7-day session, purge expired sessions, close inbox sockets on logout/expiry, re-check session on long-lived sockets.
- Public-demo posture: rate limiting (login, widget messages), per-token socket cap, Origin check on `/ws/*`, a notice on `/demo` that demo conversations are visible to anyone, keep `?token=` out of nginx access logs.
- Compose resilience: healthchecks, `depends_on` with conditions, nginx `resolver 127.0.0.11` so an api restart does not cause 502s.
- `verifyPassword`: return false on an empty key; switch `z.string().email()` to `z.email()`; validate `PORT`.
- Tests: session expiry and cookie attributes, 404 on every conversation action, 401 on get/reply/act in the inbox, stale list/filter guard, close-listener races in WebSocket tests, restore spies in `finally`, close apps in tests, Playwright end-to-end (spec §11).
