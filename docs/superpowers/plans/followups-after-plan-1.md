# Follow-ups after plan 1

Findings from the plan-1 reviews that were deliberately deferred. Each later plan should pull its items into its own tasks.

## Plan 2 — agent engine
- Wrap multi-step writes (`receiveInbound`, `teamReply`, agent replies) in `db.transaction`.
- Generalise `teamReply` into an outbound path that takes the sender (`user` | `agent` | `system`); define what happens when `channel.send` rejects after the insert (no duplicate on retry).
- Status rules: replying to or assigning a closed conversation answers 409 instead of reopening it; `handBack` resets `agentTurns`.
- Debounce the inbox list refetch (today one GET per frame) — the agent doubles event volume.
- Type the WebSocket frames (`frame: any` in `live.ts`) when agent events are added.
- Graceful shutdown that waits for in-flight agent turns.
- Rewrite/extend conversation-service tests (NotFound on close/handBack/teamReply, `[audio]` fallback, `handoffReason` cleared, event order, contact name update).

## Plan 4 — settings and knowledge base
- Typed settings instead of `Record<string, unknown>`.
- Unify validation error codes (login still answers `invalid_body`, everything else `invalid_request`).
- Inbox UX: in-flight guard on team replies (no double submit), keep a newer draft when a reply succeeds, Timeline auto-scroll, accessibility (reply input label, `aria-pressed` on filters, login button disabled while submitting).
- Show the demo credentials on `/demo` (spec §8).
- Paginate `listConversations`.

## Plan 5 — transcription and voice
- Widget: merge the history frame by message id instead of replacing (one-tick window where a push can be lost).
- Send a public message DTO to visitors instead of raw DB rows (no `userId`, `mediaPath`, internal transcription fields).
- Show transcriptions in the inbox Timeline.
- Raise or split the WebSocket `maxPayload` for binary audio.
- Widget UI pass: `aria-live`, auto-scroll, close button `type="button"`, max-height on short viewports, no empty bubble for null text.

## Plan 6 — polish, CI, public demo hardening
- Build the Docker images in CI before advertising `docker compose up --build`.
- Enable the Fastify logger in `main.ts`; add `setNotFoundHandler` returning `{ error, code }`.
- Sessions: `secure` cookie flag in production, cookie `maxAge` aligned with the 7-day session, purge expired sessions, close inbox sockets on logout/expiry, re-check session on long-lived sockets.
- Public-demo posture: rate limiting (login, widget messages), per-token socket cap, Origin check on `/ws/*`, a notice on `/demo` that demo conversations are visible to anyone, keep `?token=` out of nginx access logs.
- Compose resilience: healthchecks, `depends_on` with conditions, nginx `resolver 127.0.0.11` so an api restart does not cause 502s.
- `verifyPassword`: return false on an empty key; switch `z.string().email()` to `z.email()`; validate `PORT`.
- Tests: session expiry and cookie attributes, 404 on every conversation action, 401 on get/reply/act in the inbox, stale list/filter guard, close-listener races in WebSocket tests, restore spies in `finally`, close apps in tests, Playwright end-to-end (spec §11).

## Spec update
- Spec §6 still shows `send(conversation, OutgoingMessage)`; the implemented contract is `send({ conversation, contact }, message)`. Update the spec before plan 2.

## Small hardening (any plan)
- `EventBus.on`: ignore or track a second registration of the same function (today `off` removes only the latest wrapper); use `Promise.resolve(result).catch` to also catch non-native thenables; type `Listener` as `void | Promise<void>`.
