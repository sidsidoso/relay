# Relay

An open-source omnichannel inbox with an AI agent and local voice transcription.

> Status: plan 2 of 6 — the AI agent answers with a scripted demo provider. Claude and Ollama providers land in plan 3.

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

## Architecture

- `apps/api` — Fastify + TypeScript, SQLite (Drizzle), WebSocket for the widget and the inbox.
- `apps/web` — React + Vite: inbox, login and the demo widget.
- Channels plug in through one interface; the widget ships in v1, WhatsApp is the next connector.

## Roadmap

Claude and Ollama providers · local Whisper transcription · WhatsApp connector · i18n (EN/PT).

## Em português

Relay é uma inbox de atendimento omnichannel, open source, com agente de IA e transcrição de áudio local. Rode com `docker compose up --build` e abra a inbox e a página `/demo` lado a lado. Sem configuração, o agente responde com um provedor de demonstração roteirizado (sem chave de API), consulta a base de conhecimento e transfere para um humano quando necessário.

## License

MIT
