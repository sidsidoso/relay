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
