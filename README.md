# Relay

An open-source omnichannel inbox with an AI agent and local voice transcription.

> Status: plan 3 of 6 — the agent runs on Claude, a local Ollama model, or a scripted demo provider. Next: the settings screen and knowledge base editor.

## Run it

    docker compose up --build

Open http://localhost:8080 (team inbox, demo user pre-filled) and http://localhost:8080/demo (customer widget) side by side.

## Develop

    npm install
    npm run dev:api    # http://localhost:3000
    npm run dev:web    # http://localhost:5173
    npm test

## The AI agent

When a customer writes and nobody from the team has taken the conversation, the agent answers on its own:

- it searches the knowledge base (`apps/api/knowledge/*.md`, or `RELAY_KNOWLEDGE_DIR`) before answering factual questions;
- it hands off to a human when the customer asks for one, when it has no answer, after the turn limit, or when the AI provider fails — the customer always gets a reply;
- every turn is logged (provider, model, duration, tokens, outcome) and shown live in the inbox under "Agent activity".

With no configuration it runs on a scripted **demo provider**, so the whole flow works without an API key. Try: "What are your opening hours?", "How much is a meeting room?", "I want to cancel", or "I want to talk to a human".

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
| `RELAY_CLAUDE_MODEL` | `claude-sonnet-5-5` | Claude model ID. |
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

## Architecture

- `apps/api` — Fastify + TypeScript, SQLite (Drizzle), WebSocket for the widget and the inbox.
- `apps/web` — React + Vite: inbox, login and the demo widget.
- Channels plug in through one interface; the widget ships in v1, WhatsApp is the next connector.

## Roadmap

Local Whisper transcription · WhatsApp connector · i18n (EN/PT).

## Em português

Relay é uma inbox de atendimento omnichannel, open source, com agente de IA e transcrição de áudio local. Rode com `docker compose up --build` e abra a inbox e a página `/demo` lado a lado. Sem configuração, o agente responde com um provedor de demonstração roteirizado (sem chave de API), consulta a base de conhecimento e transfere para um humano quando necessário.

Para usar um modelo de verdade, defina `ANTHROPIC_API_KEY` (Claude) ou `OLLAMA_URL` (modelo local com Ollama) — copie `.env.example` para `.env`. Sem nada configurado, continua o provedor de demonstração. Se o provedor falhar (limite de uso, tempo esgotado, servidor fora do ar), a conversa vai para um atendente humano.

## License

MIT
