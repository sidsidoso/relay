# Relay

An open-source omnichannel inbox with an AI agent and local voice transcription.

> Status: plan 5 of 6 — voice messages are transcribed locally with Whisper; the agent runs on Claude, a local Ollama model, or a scripted demo provider; agent settings and the knowledge base are editable from the **Settings** screen. Next: polish, CI and public demo hardening.

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

- it searches the knowledge base (Markdown files in `data/knowledge`, or `RELAY_KNOWLEDGE_DIR`, editable from **Settings**) before answering factual questions;
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
| `RELAY_KNOWLEDGE_DIR` | `<folder of RELAY_DB>/knowledge` (`/data/knowledge` in Docker) | Folder with the Markdown knowledge base, editable from **Settings**; seeded from `apps/api/knowledge` on first start. |

Notes:

- **Privacy.** With Claude, the recent conversation and the knowledge passages the agent looks up are sent to the Anthropic API. With Ollama, everything stays on your machine.
- **Failures never strand the customer.** A rate limit, a timeout, a refusal, an unreachable server or an empty answer hands the conversation to a person; the reason shows under "Agent activity" (for example `claude_rate_limited` or `ollama_offline`).
- **Models without tool support** (some small Ollama models) run in text-only mode: the knowledge passages that match the customer's messages are put in their prompt, but they cannot hand off by themselves; handoff keywords and the turn limit still apply.
- **Quick check** of your configuration, outside the app: `npm run try-provider -w apps/api -- "How much is a meeting room?"` sends one real request and prints the result.
- **Tests never call a model.** The Claude and Ollama adapters are tested against recorded responses in `apps/api/test/fixtures/`, so CI needs no key and no network.

## Voice messages

Customers can record a voice message in the widget (the browser's `MediaRecorder`, opus in WebM, up to 2 minutes). Relay stores the file in the media folder (`/data/media` in the `relay-data` volume) and a small Python service, `services/transcriber`, turns it into text with [faster-whisper](https://github.com/SYSTRAN/faster-whisper). The inbox shows a player with the transcription below it, and the agent reads it as `[customer audio, transcribed] …`.

- **Audio never leaves the server.** The model runs locally on the CPU. The transcriber is reachable only on the internal Docker network, keeps the audio in memory, and never logs the text.
- **Transcription never blocks the agent.** Each audio gets up to 40 s, and a turn spends at most 40 s on transcription. If transcription fails, the agent still answers and sees `[audio]`. If the transcriber is down or still loading its model, nothing is marked as failed and the audio is transcribed when it comes back.
- **The first start downloads the model** into the `whisper-models` volume (`small` is about 500 MB), so the first voice message can take a while.

| Variable | Default | What it does |
| --- | --- | --- |
| `TRANSCRIBER_MODEL` | `small` | Whisper model: `tiny`, `base`, `small`, `medium`, `large-v3-turbo`… |
| `TRANSCRIBER_URL` | `http://transcriber:8000` in Docker; unset with `npm run dev:api` | Where the API finds the transcriber. Unset: voice messages are stored but not transcribed. |
| `RELAY_TRANSCRIBER_LANGUAGE` | the service default, `pt` | Language code for Whisper, or `auto` to detect it. |
| `RELAY_MEDIA_DIR` | `media` next to the database | Where voice messages are stored. |

### Measured times

Measured on a laptop CPU (12th Gen Intel Core i5-1235U; the benchmark prints `Intel64 Family 6 Model 154`) with a 10-second English sample made with the Windows speech synthesizer: `int8`, `beam_size=1`, language detection on, after one warm-up run. Load times are with the model already downloaded. Reproduce with `python -m transcriber.bench <audio> tiny base small --language auto`.

| Model | Audio | Load | Transcription |
| --- | --- | --- | --- |
| `tiny` | 10.2 s | 0.8 s | 1.0 s |
| `base` | 10.2 s | 0.6 s | 4.4 s |
| `small` | 10.2 s | 1.6 s | 6.2 s |

### Running the transcriber without Docker

```bash
cd services/transcriber
python -m venv .venv-run                      # Python 3.12 recommended
.venv-run/Scripts/python -m pip install -r requirements.txt   # Linux/macOS: .venv-run/bin/python
TRANSCRIBER_MODEL=tiny .venv-run/Scripts/python -m transcriber   # listens on 127.0.0.1:8000
```

Then start the API with `TRANSCRIBER_URL=http://127.0.0.1:8000 npm run dev:api`. The service tests need only pytest (a fake model stands in for Whisper): `python -m venv .venv && .venv/Scripts/python -m pip install -r requirements-dev.txt && .venv/Scripts/python -m pytest`.

## Architecture

- `apps/api` — Fastify + TypeScript, SQLite (Drizzle), WebSocket for the widget and the inbox.
- `apps/web` — React + Vite: inbox, login and the demo widget.
- Channels plug in through one interface; the widget ships in v1, WhatsApp is the next connector.

## Roadmap

WhatsApp connector · i18n (EN/PT).

## Em português

Relay é uma inbox de atendimento omnichannel, open source, com agente de IA e transcrição de áudio local. Rode com `docker compose up --build` e abra a inbox e a página `/demo` lado a lado. Sem configuração, o agente responde com um provedor de demonstração roteirizado (sem chave de API), consulta a base de conhecimento e transfere para um humano quando necessário.

Para usar um modelo de verdade, defina `ANTHROPIC_API_KEY` (Claude) ou `OLLAMA_URL` (modelo local com Ollama) — copie `.env.example` para `.env`. Sem nada configurado, continua o provedor de demonstração. Se o provedor falhar (limite de uso, tempo esgotado, servidor fora do ar), a conversa vai para um atendente humano.

Mensagens de voz: o cliente grava um áudio no widget e um serviço Python local (`services/transcriber`, faster-whisper) transcreve o áudio sem enviá-lo para fora do servidor. A inbox mostra o player com a transcrição embaixo, e o agente responde a partir do texto. Se a transcrição falhar, o agente responde mesmo assim; se o serviço estiver fora do ar, o áudio é transcrito quando ele voltar. O modelo padrão é o `small` (troque com `TRANSCRIBER_MODEL`).

## License

MIT
