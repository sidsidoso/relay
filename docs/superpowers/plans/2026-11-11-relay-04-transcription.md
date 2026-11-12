# Relay — Plan 4: local transcription and voice messages

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer records a voice message in the widget; Relay stores it, a local Whisper service turns it into text, the inbox shows a player with the transcription below it, and the agent answers from the transcription. Audio never leaves the server, and a slow, failing or missing transcriber never blocks or breaks an agent turn.

**Architecture:** A small Python service (`services/transcriber`, stdlib `http.server` + faster-whisper) loads one model at startup and transcribes one audio at a time over `POST /transcribe`; it is reachable only on the internal Docker network. The widget uploads the recording over HTTP (`POST /api/widget/audio`), the API stores the file in the media folder and creates an `audio` message. The per-conversation agent queue (plan 2) now runs a turn runner that first transcribes the conversation's pending audio through `HttpTranscriber` (never throws, per-audio and per-turn deadlines), stores the result on `messages.transcription`, broadcasts `message.updated`, and then runs the unchanged `runAgentTurn`. When the service is unreachable nothing is stored and an `OfflineRetry` polls `/health` and reschedules the conversation once the model is loaded.

**Tech Stack:** unchanged from plan 3 (Fastify 5, Drizzle + better-sqlite3, zod v4, Vitest; React 19 + Vite), plus Python 3.12+ with `faster-whisper` (runtime only) and `pytest` (tests only). No Python web framework: the service has two routes.

Spec: `docs/superpowers/specs/2026-11-10-relay-design.md` §3 (message flow steps 3–4), §5 (transcription), §6 (widget voice), §7 (`messages.type`, `media_path`, `transcription`, `data/media`), §9 (audio player + transcription in the timeline), §11 (transcriber tests with a fake model). Follow-ups pulled in from `docs/superpowers/plans/followups-after-plan-1.md`: the whole "transcription and voice" section (history merge by id, visitor DTO, transcriptions in the timeline, WebSocket payload for audio, widget UI pass) and the handoff keyword `agent` that matches too much.

## Global Constraints

- Code, identifiers, comments and docs in English (the README keeps its Portuguese section). ESM; TypeScript `strict: true`. Python 3.12+ with type hints; the service tests need only the standard library and `pytest`.
- Tests never download a Whisper model and never use the network beyond `127.0.0.1`: the Python tests inject a fake model or a fake engine; the API tests use `FakeTranscriber` or a fake HTTP server bound to `127.0.0.1` on a random port.
- Service contract exactly: `GET /health` → `{ ok, model, loaded, error }`; `POST /transcribe` with the raw audio body (language in `X-Language`, default `pt`, `auto` = detect) → `{ text, duration_s, processing_s, model }`. Body limit 25 MB; a negative or non-numeric `Content-Length` answers 400 before the body is read. 503 while the model is loading or failed to load.
- Default model `small`; `TRANSCRIBER_MODEL` selects another. The model loads once at startup; one transcription at a time.
- The service keeps audio in memory only (no temporary files) and never logs the transcribed text. The API never logs the transcribed text either.
- The API client never throws. It returns `{ ok: true, text, durationS, processingS, model } | { ok: false, error: 'timeout' | 'offline' | 'http_<status>' | 'unreadable' }`. A 503 counts as `offline`.
- Deadlines: 40 000 ms per audio (`PER_AUDIO_MS`) and 40 000 ms per turn in total (`PER_TURN_MS`).
- `offline` stores nothing (the same audio is retried when the service is back). Every other failure stores `transcription.status = 'failed'` with the error code and is never retried — except a timeout that was cut short by the per-turn budget, which stores nothing. Empty speech stores `status = 'empty'`.
- The agent turn always runs after the transcription step; a missing transcription reaches the provider as `[audio]` (plan 2 behavior).
- Audio files live in the media folder (`RELAY_MEDIA_DIR`, default `media` next to the database: `/data/media` in the `relay-data` Docker volume). Stored file names are generated (`<uuid>.<ext>`); a client-supplied name never reaches the disk.
- Visitors never receive team user ids, file names or transcription internals.
- With `docker compose up` and no configuration, voice messages work end to end (the compose file points the API at the `transcriber` service). With `npm run dev:api` and no `TRANSCRIBER_URL`, voice messages are stored and reach the agent as `[audio]`.
- Docker is not required to build or verify this plan: every task is verified without it; the compose file is checked only where Docker exists.
- Sample content stays fictional ("Acme Coworking"). No employer data anywhere.
- Every commit message ends with a `Co-Authored-By:` trailer naming the model that wrote the commit.

## Decisions beyond the spec

These fill gaps the spec leaves open; each is small and reversible.

1. **Upload over HTTP, not a WebSocket frame.** `POST /api/widget/audio` with the visitor token in the `X-Relay-Visitor` header, at most 10 MB (`MAX_AUDIO_BYTES`); the widget stops recording at 2 minutes. The WebSocket keeps its 64 KiB frame limit (this closes the "raise or split `maxPayload`" follow-up by splitting).
2. **Transcription runs inside the agent queue, before the turn**, for every conversation with a new customer message — also assigned ones, so the team always sees the text. The queue already serializes per conversation.
3. **`OfflineRetry`** polls `GET /health` every 15 s while some conversation waits for an offline transcriber, and reschedules those conversations when the model is loaded. The rescheduled agent turn is skipped when the agent already answered (plan 2 rule), so the retry only fills in the transcription.
4. **`TRANSCRIBER_URL` unset = transcription off** in the API (development without Python). The compose file sets it.
5. **`RELAY_TRANSCRIBER_LANGUAGE`** (API) is forwarded as `X-Language` when set; the service default stays `pt` (spec), and the service also accepts `auto`.
6. **Service details:** CPU, `int8`, `beam_size=1`, `vad_filter=True`; 411 without `Content-Length`; 422 for audio that cannot be decoded.
7. **Handoff keywords:** the default list drops `agent` ("real estate agent" handed off) and adds `real person` / `pessoa real`; the seed upgrades a stored list only when it is exactly the old default. Keywords are now also matched against transcriptions, which is why the noisy keyword is fixed here.
8. **Demo provider and audio:** it searches with the spoken words (without the `[customer audio, transcribed]` marker) and answers an untranscribed `[audio]` by asking the customer to type, instead of searching for "audio" and handing off.
9. **Left for plan 5 (settings and knowledge base):** passages in the system prompt for Ollama models without tool support. It changes the prompt, not transcription, and belongs with the knowledge base editor. The demo provider still answers from the first search hit only: it is scripted on purpose (closed in plan 3).

## File structure

```
services/transcriber/
  requirements.txt                    NEW: faster-whisper (runtime)
  requirements-dev.txt                NEW: pytest (tests only; no model)
  pytest.ini                          NEW
  Dockerfile                          NEW: python:3.12-slim, model cache in /models
  .dockerignore                       NEW
  transcriber/__init__.py             NEW
  transcriber/engine.py               NEW: Engine (load once, one at a time), Result, UnreadableAudio
  transcriber/server.py               NEW: make_server — GET /health, POST /transcribe
  transcriber/__main__.py             NEW: python -m transcriber
  transcriber/bench.py                NEW: measured times for the README table
  tests/test_engine.py                NEW
  tests/test_server.py                NEW
apps/api/
  src/transcription/client.ts         NEW: Transcriber interface + HttpTranscriber (never throws)
  src/transcription/pipeline.ts       NEW: transcribePending (deadlines, storage, message.updated)
  src/transcription/retry.ts          NEW: OfflineRetry
  src/media/store.ts                  NEW: accepted audio types, saveAudio, mediaFile, removeAudio
  src/media/routes.ts                 NEW: GET /api/conversations/:id/messages/:messageId/audio
  src/channels/widget.ts              MODIFY: visitor DTO, POST /api/widget/audio
  src/agent/turn.ts                   NEW: makeTurnRunner (transcribe, then runAgentTurn)
  src/agent/engine.ts                 MODIFY: audio markers exported; keywords also match transcriptions
  src/agent/providers/demo.ts         MODIFY: audio-aware demo answers
  src/core/events.ts                  MODIFY: 'message.updated'
  src/core/settings.ts                MODIFY: transcriptionEnabled
  src/db/schema.ts                    MODIFY: Transcription.durationS
  src/db/seed.ts                      MODIFY: new default handoff keywords + upgrade of the old default
  src/http/errors.ts                  MODIFY: 413 → { code: 'too_large' }
  src/realtime/inbox.ts               MODIFY: forward 'message.updated'
  src/server.ts                       MODIFY: mediaDir option, media and upload routes
  src/main.ts                         MODIFY: media folder, transcriber, retry, turn runner
  test/fake-http.ts                   NEW: real HTTP server on 127.0.0.1 for client tests
  test/fake-transcriber.ts            NEW: in-memory Transcriber
  test/transcriber-client.test.ts     NEW
  test/transcription.test.ts          NEW
  test/transcription-retry.test.ts    NEW
  test/media.test.ts                  NEW
  test/turn.test.ts                   NEW
  test/agent-flow.test.ts             MODIFY: voice message end to end
  test/engine.test.ts, demo-provider.test.ts, settings.test.ts, inbox-ws.test.ts   MODIFY
apps/web/
  src/recorder.ts                     NEW: MediaRecorder wrapper (webm/opus, 2-minute limit)
  src/components/Widget.tsx           MODIFY: voice button, upload, merge by id, UI pass
  src/components/Timeline.tsx         MODIFY: audio player + transcription
  src/api.ts                          MODIFY: audioUrl, transcription type, message.updated frame
  src/pages/Inbox.tsx                 MODIFY: apply message.updated
  src/styles.css                      MODIFY
  test/recorder.test.tsx              NEW
  test/Timeline.test.tsx              NEW
  test/Widget.test.tsx, Inbox.test.tsx   MODIFY
apps/web/nginx.conf                   MODIFY: body limit for audio uploads
docker-compose.yml                    MODIFY: transcriber service, API variables, model volume
.env.example, .gitignore              MODIFY
README.md                             MODIFY: voice messages, measured times, running without Docker (EN + PT)
docs/superpowers/specs/2026-11-10-relay-design.md     MODIFY: §5/§6 details decided here
docs/superpowers/plans/followups-after-plan-1.md      MODIFY: plan-4 status, plan numbering
```

---

### Task 1: Transcriber engine (Python)

The engine wraps faster-whisper. It imports `faster_whisper` only inside `default_loader`, so the tests (and a machine without the model runtime) never need it.

**Files:**
- Create: `services/transcriber/requirements.txt`, `services/transcriber/requirements-dev.txt`, `services/transcriber/pytest.ini`, `services/transcriber/transcriber/__init__.py`, `services/transcriber/transcriber/engine.py`
- Modify: `.gitignore`
- Test: `services/transcriber/tests/test_engine.py`

**Interfaces:**
- Produces (`transcriber/engine.py`):
  - `@dataclass(frozen=True) class Result: text: str; duration_s: float`
  - `class UnreadableAudio(Exception)` — the audio could not be decoded or transcribed.
  - `default_loader(name: str, device: str, compute_type: str) -> Any` — `faster_whisper.WhisperModel(name, device=device, compute_type=compute_type)`.
  - `class Engine(model_name: str, *, device: str = "cpu", compute_type: str = "int8", loader: Callable[[str, str, str], Any] = default_loader)` with `model_name: str`, `error: str | None`, property `loaded: bool`, `load() -> None` (never raises; a failure sets `error` to `"<ExceptionType>: <message>"`, at most 200 chars), `transcribe(audio: bytes, language: str | None) -> Result` (raises `RuntimeError("model not loaded")` before `load()` succeeded; any model/decoding error becomes `UnreadableAudio`; holds a lock, so one transcription at a time; calls the model with `io.BytesIO(audio)`, `language=language`, `beam_size=1`, `vad_filter=True`; text = stripped non-empty segment texts joined by one space).

- [ ] **Step 1: Project files**

`services/transcriber/requirements.txt`:
```
faster-whisper>=1.1,<2
```

`services/transcriber/requirements-dev.txt`:
```
# Tests use a fake model: faster-whisper is not needed to run them.
pytest>=8,<10
```

`services/transcriber/pytest.ini`:
```ini
[pytest]
testpaths = tests
pythonpath = .
```

`services/transcriber/transcriber/__init__.py`:
```python
"""Relay transcriber: local speech-to-text over HTTP with faster-whisper."""
```

Append to the root `.gitignore`:
```
.venv/
.venv-*/
__pycache__/
.pytest_cache/
```

Create the test virtual environment (Windows, Git Bash; on Linux/macOS use `.venv/bin/python`):
```bash
cd services/transcriber
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements-dev.txt
```
Expected: pytest installs; faster-whisper is not installed.

- [ ] **Step 2: Failing tests**

`services/transcriber/tests/test_engine.py`:
```python
import io
import sys
import threading
import time
import types

import pytest

from transcriber.engine import Engine, Result, UnreadableAudio, default_loader


class Segment:
    def __init__(self, text):
        self.text = text


class FakeModel:
    """Stands in for faster_whisper.WhisperModel; records calls and concurrency."""

    def __init__(self, segments=(" Hello", " world. "), duration=2.5, fail=None, delay=0.0):
        self.segments = segments
        self.duration = duration
        self.fail = fail
        self.delay = delay
        self.calls = []
        self.active = 0
        self.max_active = 0

    def transcribe(self, audio, **kwargs):
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            self.calls.append((audio, kwargs))
            if self.delay:
                time.sleep(self.delay)
            if self.fail:
                raise self.fail
            return (Segment(s) for s in self.segments), types.SimpleNamespace(duration=self.duration)
        finally:
            self.active -= 1


def loaded(model=None):
    model = model or FakeModel()
    engine = Engine("small", loader=lambda name, device, compute_type: model)
    engine.load()
    return engine, model


def test_load_passes_model_device_and_compute_type():
    seen = []
    engine = Engine("base", loader=lambda *args: seen.append(args) or FakeModel())
    assert not engine.loaded
    engine.load()
    assert engine.loaded and engine.error is None
    assert seen == [("base", "cpu", "int8")]


def test_a_load_failure_is_reported_not_raised():
    def boom(*_):
        raise RuntimeError("download failed")

    engine = Engine("small", loader=boom)
    engine.load()
    assert not engine.loaded
    assert engine.error == "RuntimeError: download failed"


def test_default_loader_imports_faster_whisper_only_when_called(monkeypatch):
    created = []
    fake = types.ModuleType("faster_whisper")
    fake.WhisperModel = lambda name, device, compute_type: created.append((name, device, compute_type)) or "model"
    monkeypatch.setitem(sys.modules, "faster_whisper", fake)
    assert default_loader("tiny", "cpu", "int8") == "model"
    assert created == [("tiny", "cpu", "int8")]


def test_transcribe_joins_segments_and_reports_duration():
    engine, model = loaded()
    assert engine.transcribe(b"RIFF....", "pt") == Result(text="Hello world.", duration_s=2.5)
    audio, kwargs = model.calls[0]
    assert isinstance(audio, io.BytesIO) and audio.getvalue() == b"RIFF...."
    assert kwargs == {"language": "pt", "beam_size": 1, "vad_filter": True}


def test_language_none_lets_whisper_detect():
    engine, model = loaded()
    engine.transcribe(b"x", None)
    assert model.calls[0][1]["language"] is None


def test_silence_gives_empty_text():
    engine, _ = loaded(FakeModel(segments=("", "  ")))
    assert engine.transcribe(b"x", "pt").text == ""


def test_a_decoding_error_becomes_unreadable_audio():
    engine, _ = loaded(FakeModel(fail=ValueError("Invalid data found when processing input")))
    with pytest.raises(UnreadableAudio):
        engine.transcribe(b"not audio", "pt")


def test_transcribe_before_load_raises():
    engine = Engine("small", loader=lambda *_: FakeModel())
    with pytest.raises(RuntimeError, match="not loaded"):
        engine.transcribe(b"x", "pt")


def test_one_transcription_at_a_time():
    engine, model = loaded(FakeModel(delay=0.05))
    threads = [threading.Thread(target=engine.transcribe, args=(b"x", "pt")) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(model.calls) == 3
    assert model.max_active == 1
```

Run: `.venv/Scripts/python -m pytest -q` (from `services/transcriber`) → FAIL (`ModuleNotFoundError: No module named 'transcriber.engine'`).

- [ ] **Step 3: Implementation**

`services/transcriber/transcriber/engine.py`:
```python
"""Whisper model wrapper. faster-whisper is imported only when a model is loaded, so tests never need it."""

from __future__ import annotations

import io
import threading
from dataclasses import dataclass
from typing import Any, Callable

Loader = Callable[[str, str, str], Any]


@dataclass(frozen=True)
class Result:
    text: str
    duration_s: float


class UnreadableAudio(Exception):
    """The audio could not be decoded or transcribed."""


def default_loader(name: str, device: str, compute_type: str) -> Any:
    from faster_whisper import WhisperModel  # heavy import, deferred on purpose

    return WhisperModel(name, device=device, compute_type=compute_type)


class Engine:
    """Loads one model once and runs one transcription at a time."""

    def __init__(
        self,
        model_name: str,
        *,
        device: str = "cpu",
        compute_type: str = "int8",
        loader: Loader = default_loader,
    ) -> None:
        self.model_name = model_name
        self.error: str | None = None
        self._device = device
        self._compute_type = compute_type
        self._loader = loader
        self._model: Any = None
        self._lock = threading.Lock()

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def load(self) -> None:
        try:
            self._model = self._loader(self.model_name, self._device, self._compute_type)
        except Exception as exc:  # reported by GET /health instead of crashing the service
            self.error = f"{type(exc).__name__}: {exc}"[:200]

    def transcribe(self, audio: bytes, language: str | None) -> Result:
        if self._model is None:
            raise RuntimeError("model not loaded")
        with self._lock:
            try:
                segments, info = self._model.transcribe(
                    io.BytesIO(audio), language=language, beam_size=1, vad_filter=True
                )
                text = " ".join(t for s in segments if (t := s.text.strip()))
            except Exception as exc:
                raise UnreadableAudio(type(exc).__name__) from exc
        return Result(text=text, duration_s=float(info.duration))
```

- [ ] **Step 4: Run tests, then commit**

Run: `.venv/Scripts/python -m pytest -q` → `9 passed`. Confirm `git status` shows no `.venv` or `__pycache__` entries.
```bash
git add .gitignore services/transcriber
git commit -m "feat(transcriber): Whisper engine that loads once and transcribes one audio at a time"
```

---

### Task 2: Transcriber HTTP service (Python)

**Files:**
- Create: `services/transcriber/transcriber/server.py`, `services/transcriber/transcriber/__main__.py`, `services/transcriber/transcriber/bench.py`, `services/transcriber/Dockerfile`, `services/transcriber/.dockerignore`
- Test: `services/transcriber/tests/test_server.py`

**Interfaces:**
- Consumes (Task 1): `Engine` (`model_name`, `error`, `loaded`, `transcribe(audio, language)`), `Result`, `UnreadableAudio`.
- Produces (`transcriber/server.py`): `MAX_BODY = 25 * 1024 * 1024`, `DEFAULT_LANGUAGE = "pt"`, `make_server(engine, host="127.0.0.1", port=8000, *, max_body=MAX_BODY, default_language=DEFAULT_LANGUAGE) -> ThreadingHTTPServer`. Routes:
  - `GET /health` → 200 `{"ok": engine.error is None, "model": engine.model_name, "loaded": engine.loaded, "error": engine.error}`.
  - `POST /transcribe` → checks in this order, each answering before the body is read: no `Content-Length` → 411 `length_required`; not `^[0-9]+$` → 400 `invalid_content_length`; `0` → 400 `empty_body`; over `max_body` → 413 `too_large`; `X-Language` (default `default_language`, lowercased) not `auto` or 2–3 letters → 400 `invalid_language`; model not loaded → 503 `loading` (or `model_failed` when `engine.error` is set). Then reads the body (short → 400 `incomplete_body`), transcribes (`auto` → `None`), `UnreadableAudio` → 422 `unreadable_audio`, otherwise 200 `{"text", "duration_s", "processing_s", "model"}` (`duration_s` and `processing_s` rounded to 2 decimals). Errors are `{"error": "<code>"}`. Anything else → 404 `not_found`.
  - Logs (logger `transcriber`) the request line, and for each transcription `"transcribed %.1f s of audio in %.2f s (%s)"` — never the text.
- `python -m transcriber`: env `TRANSCRIBER_MODEL` (default `small`), `TRANSCRIBER_HOST` (default `127.0.0.1`; the Dockerfile sets `0.0.0.0`), `TRANSCRIBER_PORT` (default `8000`). Starts listening at once and loads the model in a background thread (so `/health` answers `loaded: false` while it loads).
- `python -m transcriber.bench <audio> [models...] [--language pt|auto|...]` prints a Markdown table (model, audio length, load time, transcription time after a warm-up run, first 60 chars of text).

- [ ] **Step 1: Failing tests**

`services/transcriber/tests/test_server.py`:
```python
import http.client
import json
import logging
import threading

import pytest

from transcriber.engine import Result, UnreadableAudio
from transcriber.server import make_server


class FakeEngine:
    model_name = "small"

    def __init__(self, loaded=True, error=None, text="Quanto custa uma sala de reunião?", fail=False):
        self.loaded = loaded
        self.error = error
        self.text = text
        self.fail = fail
        self.calls = []

    def transcribe(self, audio, language):
        self.calls.append((audio, language))
        if self.fail:
            raise UnreadableAudio("InvalidDataError")
        return Result(text=self.text, duration_s=3.21)


@pytest.fixture
def serve():
    servers = []

    def start(engine, **kwargs):
        server = make_server(engine, "127.0.0.1", 0, **kwargs)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
        return server.server_address[1]

    yield start
    for server in servers:
        server.shutdown()
        server.server_close()


def request(port, method, path, body=None, headers=None):
    """Sends exactly the given headers; Content-Length is added only for a body unless given explicitly."""
    headers = headers or {}
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.putrequest(method, path)
        for key, value in headers.items():
            conn.putheader(key, value)
        if body is not None and "Content-Length" not in headers:
            conn.putheader("Content-Length", str(len(body)))
        conn.endheaders()
        if body:
            conn.send(body)
        res = conn.getresponse()
        return res.status, json.loads(res.read())
    finally:
        conn.close()


def test_health_reports_model_and_load_state(serve):
    assert request(serve(FakeEngine(loaded=False)), "GET", "/health") == (
        200,
        {"ok": True, "model": "small", "loaded": False, "error": None},
    )
    assert request(serve(FakeEngine()), "GET", "/health")[1]["loaded"] is True
    failed = FakeEngine(loaded=False, error="RuntimeError: download failed")
    assert request(serve(failed), "GET", "/health") == (
        200,
        {"ok": False, "model": "small", "loaded": False, "error": "RuntimeError: download failed"},
    )


def test_transcribe_returns_text_and_timings(serve):
    engine = FakeEngine()
    status, body = request(serve(engine), "POST", "/transcribe", b"OggS-audio", {"Content-Type": "audio/webm"})
    assert status == 200
    assert body["text"] == "Quanto custa uma sala de reunião?"
    assert body["duration_s"] == 3.21 and body["model"] == "small"
    assert isinstance(body["processing_s"], float)
    assert engine.calls == [(b"OggS-audio", "pt")]


def test_language_header(serve):
    engine = FakeEngine()
    port = serve(engine)
    request(port, "POST", "/transcribe", b"a", {"X-Language": "EN"})
    request(port, "POST", "/transcribe", b"a", {"X-Language": "auto"})
    assert [language for _, language in engine.calls] == ["en", None]
    assert request(port, "POST", "/transcribe", b"a", {"X-Language": "pt-br"}) == (400, {"error": "invalid_language"})


@pytest.mark.parametrize("value", ["-1", "abc", "1.5", "+5"])
def test_an_invalid_content_length_is_rejected_at_once(serve, value):
    engine = FakeEngine()
    # No body is sent: the answer must come from the headers alone.
    assert request(serve(engine), "POST", "/transcribe", None, {"Content-Length": value}) == (
        400,
        {"error": "invalid_content_length"},
    )
    assert engine.calls == []


def test_missing_length_empty_body_and_too_large(serve):
    port = serve(FakeEngine(), max_body=10)
    assert request(port, "POST", "/transcribe") == (411, {"error": "length_required"})
    assert request(port, "POST", "/transcribe", None, {"Content-Length": "0"}) == (400, {"error": "empty_body"})
    assert request(port, "POST", "/transcribe", None, {"Content-Length": "11"}) == (413, {"error": "too_large"})


def test_the_default_limit_is_25_mb(serve):
    port = serve(FakeEngine())
    too_big = str(25 * 1024 * 1024 + 1)
    assert request(port, "POST", "/transcribe", None, {"Content-Length": too_big}) == (413, {"error": "too_large"})


def test_503_while_the_model_is_loading_or_after_it_failed(serve):
    assert request(serve(FakeEngine(loaded=False)), "POST", "/transcribe", b"a") == (503, {"error": "loading"})
    failed = FakeEngine(loaded=False, error="x")
    assert request(serve(failed), "POST", "/transcribe", b"a") == (503, {"error": "model_failed"})


def test_unreadable_audio_is_422(serve):
    assert request(serve(FakeEngine(fail=True)), "POST", "/transcribe", b"junk") == (
        422,
        {"error": "unreadable_audio"},
    )


def test_unknown_paths_are_404(serve):
    port = serve(FakeEngine())
    assert request(port, "GET", "/nope")[0] == 404
    assert request(port, "POST", "/nope", b"a")[0] == 404


def test_the_log_never_contains_the_text(serve, caplog):
    caplog.set_level(logging.INFO, logger="transcriber")
    request(serve(FakeEngine(text="segredo do cliente")), "POST", "/transcribe", b"a")
    assert "transcribed 3.2 s of audio" in caplog.text
    assert "segredo" not in caplog.text
```

Run: `.venv/Scripts/python -m pytest -q` → FAIL (`No module named 'transcriber.server'`).

- [ ] **Step 2: Server**

`services/transcriber/transcriber/server.py`:
```python
"""HTTP API: GET /health and POST /transcribe. Audio stays in memory and the text is never logged."""

from __future__ import annotations

import json
import logging
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .engine import Engine, UnreadableAudio

log = logging.getLogger("transcriber")

MAX_BODY = 25 * 1024 * 1024
DEFAULT_LANGUAGE = "pt"
_LENGTH = re.compile(r"^[0-9]+$")
_LANGUAGE = re.compile(r"^(auto|[a-z]{2,3})$")


def make_server(
    engine: Engine,
    host: str = "127.0.0.1",
    port: int = 8000,
    *,
    max_body: int = MAX_BODY,
    default_language: str = DEFAULT_LANGUAGE,
) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        server_version = "relay-transcriber"
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:  # request line and status only
            log.info("%s %s", self.address_string(), format % args)

        def do_GET(self) -> None:
            if self.path != "/health":
                return self._send(404, {"error": "not_found"})
            self._send(
                200,
                {"ok": engine.error is None, "model": engine.model_name, "loaded": engine.loaded, "error": engine.error},
            )

        def do_POST(self) -> None:
            # Every early answer closes the connection: the unread body must not be parsed as a new request.
            if self.path != "/transcribe":
                return self._send(404, {"error": "not_found"}, close=True)
            raw = self.headers.get("Content-Length")
            if raw is None:
                return self._send(411, {"error": "length_required"}, close=True)
            if not _LENGTH.match(raw.strip()):
                return self._send(400, {"error": "invalid_content_length"}, close=True)
            length = int(raw.strip())
            if length == 0:
                return self._send(400, {"error": "empty_body"}, close=True)
            if length > max_body:
                return self._send(413, {"error": "too_large"}, close=True)
            language = (self.headers.get("X-Language") or default_language).strip().lower()
            if not _LANGUAGE.match(language):
                return self._send(400, {"error": "invalid_language"}, close=True)
            if not engine.loaded:
                return self._send(503, {"error": "model_failed" if engine.error else "loading"}, close=True)
            audio = self.rfile.read(length)
            if len(audio) < length:
                return self._send(400, {"error": "incomplete_body"}, close=True)
            started = time.monotonic()
            try:
                result = engine.transcribe(audio, None if language == "auto" else language)
            except UnreadableAudio as exc:
                log.warning("unreadable audio (%s, %d bytes)", exc, length)
                return self._send(422, {"error": "unreadable_audio"})
            processing_s = round(time.monotonic() - started, 2)
            log.info("transcribed %.1f s of audio in %.2f s (%s)", result.duration_s, processing_s, engine.model_name)
            self._send(
                200,
                {
                    "text": result.text,
                    "duration_s": round(result.duration_s, 2),
                    "processing_s": processing_s,
                    "model": engine.model_name,
                },
            )

        def _send(self, status: int, body: dict[str, Any], close: bool = False) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            if close:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    return server
```

Run: `.venv/Scripts/python -m pytest -q` → `22 passed` (9 engine + 13 server).

- [ ] **Step 3: Entry point and benchmark**

`services/transcriber/transcriber/__main__.py`:
```python
"""python -m transcriber — env: TRANSCRIBER_MODEL (small), TRANSCRIBER_HOST (127.0.0.1), TRANSCRIBER_PORT (8000)."""

from __future__ import annotations

import logging
import os
import threading
import time

from .engine import Engine
from .server import make_server

log = logging.getLogger("transcriber")


def _env(key: str, default: str) -> str:
    return os.environ.get(key, "").strip() or default


def _load(engine: Engine) -> None:
    started = time.monotonic()
    log.info("loading model %s (the first run downloads it)", engine.model_name)
    engine.load()
    if engine.error:
        log.error("model %s failed to load: %s", engine.model_name, engine.error)
    else:
        log.info("model %s loaded in %.1f s", engine.model_name, time.monotonic() - started)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    engine = Engine(_env("TRANSCRIBER_MODEL", "small"))
    host = _env("TRANSCRIBER_HOST", "127.0.0.1")
    port = int(_env("TRANSCRIBER_PORT", "8000"))
    server = make_server(engine, host, port)
    threading.Thread(target=_load, args=(engine,), daemon=True).start()
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

`services/transcriber/transcriber/bench.py`:
```python
"""Measure load and transcription time per model, for the README table.

    python -m transcriber.bench sample.wav tiny base small --language auto
"""

from __future__ import annotations

import argparse
import platform
import time
from pathlib import Path

from .engine import Engine


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("audio", type=Path)
    parser.add_argument("models", nargs="*", default=["tiny", "base", "small"])
    parser.add_argument("--language", default="pt", help='language code, or "auto"')
    args = parser.parse_args(argv)
    audio = args.audio.read_bytes()
    language = None if args.language == "auto" else args.language
    print(f"CPU: {platform.processor() or platform.machine()}")
    print("| Model | Audio | Load | Transcription | Text |")
    print("| --- | --- | --- | --- | --- |")
    for name in args.models:
        engine = Engine(name)
        started = time.monotonic()
        engine.load()
        load_s = time.monotonic() - started
        if engine.error:
            print(f"| `{name}` | — | failed: {engine.error} | — | — |")
            continue
        engine.transcribe(audio, language)  # warm-up
        started = time.monotonic()
        result = engine.transcribe(audio, language)
        took = time.monotonic() - started
        print(f"| `{name}` | {result.duration_s:.1f} s | {load_s:.1f} s | {took:.1f} s | {result.text[:60]} |")


if __name__ == "__main__":
    main()
```

Check that the entry point starts without faster-whisper installed (the model load fails in the background, the server keeps answering). In one terminal, from `services/transcriber`:
```bash
TRANSCRIBER_PORT=8765 .venv/Scripts/python -m transcriber
```
In another: `curl -s http://127.0.0.1:8765/health` → `{"ok": false, "model": "small", "loaded": false, "error": "ModuleNotFoundError: No module named 'faster_whisper'"}`, and `curl -s -X POST --data-binary x http://127.0.0.1:8765/transcribe` → `{"error": "model_failed"}`. Stop the server with Ctrl+C.

- [ ] **Step 4: Docker image**

`services/transcriber/Dockerfile`:
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY transcriber transcriber
# The model is downloaded on first start into /models (a named volume in docker-compose.yml).
RUN useradd --create-home relay && mkdir -p /models && chown relay /models
ENV TRANSCRIBER_HOST=0.0.0.0 TRANSCRIBER_PORT=8000 HF_HOME=/models PYTHONUNBUFFERED=1
USER relay
EXPOSE 8000
CMD ["python", "-m", "transcriber"]
```

`services/transcriber/.dockerignore`:
```
.venv
.venv-*
__pycache__
.pytest_cache
tests
```

If Docker is installed: `docker build -t relay-transcriber services/transcriber` → builds. If it is not (the case on the development machine), skip and say so in the task report.

- [ ] **Step 5: Run tests, then commit**

Run: `.venv/Scripts/python -m pytest -q` → `22 passed`.
```bash
git add services/transcriber
git commit -m "feat(transcriber): HTTP service with health, transcribe, body limits and a benchmark"
```

---
### Task 3: Transcriber client in the API

**Files:**
- Create: `apps/api/src/transcription/client.ts`, `apps/api/test/fake-http.ts`
- Test: `apps/api/test/transcriber-client.test.ts`

**Interfaces:**
- Consumes (plan 3): `FetchLike` from `apps/api/src/agent/providers/types.ts`.
- Produces (`src/transcription/client.ts`):
```ts
export type TranscribeError = 'timeout' | 'offline' | `http_${number}` | 'unreadable'
export type TranscribeResult =
  | { ok: true; text: string; durationS: number; processingS: number; model: string }
  | { ok: false; error: TranscribeError }
export type TranscribeOptions = { mime: string; timeoutMs: number; language?: string }
export type TranscriberHealth = { ok: boolean; model: string | null; loaded: boolean; error: string | null }
export interface Transcriber {
  transcribe(audio: Uint8Array<ArrayBuffer>, opts: TranscribeOptions): Promise<TranscribeResult>
  health(timeoutMs?: number): Promise<TranscriberHealth | null>
}
export const HEALTH_TIMEOUT_MS = 3_000
export class HttpTranscriber implements Transcriber { constructor(opts: { url: string; language?: string; fetch?: FetchLike }) }
```
  Rules: `POST <url>/transcribe` with the raw bytes, `content-type: <mime>`, and `x-language` = `opts.language ?? constructor language` when set (trailing slashes on `url` are ignored). 503 → `offline`; other non-2xx → `http_<status>`; a body that is not JSON or has no string `text` → `unreadable`; abort after `timeoutMs` → `timeout`; a connection error → `offline`. Never throws. `health()` → `GET <url>/health`; returns `null` on any error or when `loaded` is not a boolean.
- Produces (`test/fake-http.ts`): `fakeHttp(handler: (req, res, body: Buffer) => void): Promise<{ url: string; seen: Seen[]; close(): Promise<void> }>` (a real `node:http` server on `127.0.0.1`, random port; `Seen = { method, url, headers, body }`), `deadUrl(): Promise<string>` (a URL where nothing listens), `json(res, status, body)`.

- [ ] **Step 1: Fake HTTP server helper**

`apps/api/test/fake-http.ts`:
```ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type Seen = { method: string; url: string; headers: IncomingMessage['headers']; body: Buffer }
export type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void

/** A real HTTP server on 127.0.0.1 (random port); `handler` decides each response. Nothing leaves the machine. */
export async function fakeHttp(handler: Handler) {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      handler(req, res, body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

/** A URL where nothing listens: requests fail with "connection refused". */
export async function deadUrl(): Promise<string> {
  const s = await fakeHttp(() => {})
  await s.close()
  return s.url
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}
```

- [ ] **Step 2: Failing tests**

`apps/api/test/transcriber-client.test.ts`:
```ts
import { afterEach, describe, it, expect } from 'vitest'
import { HttpTranscriber } from '../src/transcription/client'
import { deadUrl, fakeHttp, json, type Handler } from './fake-http'

const AUDIO = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3])
const opts = { mime: 'audio/webm', timeoutMs: 2000 }
const closers: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(closers.splice(0).map((c) => c())) })

async function server(handler: Handler) {
  const s = await fakeHttp(handler)
  closers.push(s.close)
  return s
}

describe('HttpTranscriber.transcribe', () => {
  it('posts the raw audio and returns the text and timings', async () => {
    const s = await server((_req, res) => json(res, 200, { text: ' Quanto custa? ', duration_s: 2.4, processing_s: 0.8, model: 'small' }))
    const t = new HttpTranscriber({ url: `${s.url}/` })
    expect(await t.transcribe(AUDIO, opts)).toEqual({ ok: true, text: ' Quanto custa? ', durationS: 2.4, processingS: 0.8, model: 'small' })
    expect(s.seen[0]).toMatchObject({ method: 'POST', url: '/transcribe' })
    expect(s.seen[0]!.headers['content-type']).toBe('audio/webm')
    expect(s.seen[0]!.headers['x-language']).toBeUndefined()
    expect([...s.seen[0]!.body]).toEqual([...AUDIO])
  })

  it('sends X-Language when a language is configured or passed', async () => {
    const s = await server((_req, res) => json(res, 200, { text: 'hi', duration_s: 1, processing_s: 1, model: 'tiny' }))
    const t = new HttpTranscriber({ url: s.url, language: 'en' })
    await t.transcribe(AUDIO, opts)
    await t.transcribe(AUDIO, { ...opts, language: 'auto' })
    expect(s.seen.map((r) => r.headers['x-language'])).toEqual(['en', 'auto'])
  })

  it.each([
    [503, { error: 'loading' }, 'offline'],
    [422, { error: 'unreadable_audio' }, 'http_422'],
    [500, { error: 'boom' }, 'http_500'],
    [200, { text: 42 }, 'unreadable'],
  ] as const)('HTTP %i %j is %s', async (status, body, error) => {
    const s = await server((_req, res) => json(res, status, body))
    expect(await new HttpTranscriber({ url: s.url }).transcribe(AUDIO, opts)).toEqual({ ok: false, error })
  })

  it('a body that is not JSON is unreadable', async () => {
    const s = await server((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end('<html>') })
    expect(await new HttpTranscriber({ url: s.url }).transcribe(AUDIO, opts)).toEqual({ ok: false, error: 'unreadable' })
  })

  it('a service that does not answer in time is a timeout', async () => {
    const s = await server(() => { /* never answers */ })
    const started = Date.now()
    expect(await new HttpTranscriber({ url: s.url }).transcribe(AUDIO, { ...opts, timeoutMs: 100 })).toEqual({ ok: false, error: 'timeout' })
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('a service that is not running is offline', async () => {
    expect(await new HttpTranscriber({ url: await deadUrl() }).transcribe(AUDIO, opts)).toEqual({ ok: false, error: 'offline' })
  })
})

describe('HttpTranscriber.health', () => {
  it('reads the health document', async () => {
    const s = await server((_req, res) => json(res, 200, { ok: true, model: 'small', loaded: true, error: null }))
    expect(await new HttpTranscriber({ url: s.url }).health()).toEqual({ ok: true, model: 'small', loaded: true, error: null })
    expect(s.seen[0]).toMatchObject({ method: 'GET', url: '/health' })
  })

  it('returns null when the service is down or answers something else', async () => {
    expect(await new HttpTranscriber({ url: await deadUrl() }).health()).toBeNull()
    const s = await server((_req, res) => json(res, 200, { hello: 'world' }))
    expect(await new HttpTranscriber({ url: s.url }).health()).toBeNull()
  })
})
```

Run: `npm test -w apps/api -- transcriber-client` → FAIL (`Cannot find module '../src/transcription/client'`).

- [ ] **Step 3: Implementation**

`apps/api/src/transcription/client.ts`:
```ts
import type { FetchLike } from '../agent/providers/types'

export type TranscribeError = 'timeout' | 'offline' | `http_${number}` | 'unreadable'
export type TranscribeResult =
  | { ok: true; text: string; durationS: number; processingS: number; model: string }
  | { ok: false; error: TranscribeError }
export type TranscribeOptions = { mime: string; timeoutMs: number; language?: string }
export type TranscriberHealth = { ok: boolean; model: string | null; loaded: boolean; error: string | null }

/** Spec §5: never throws; every failure is a stable code. */
export interface Transcriber {
  transcribe(audio: Uint8Array<ArrayBuffer>, opts: TranscribeOptions): Promise<TranscribeResult>
  /** null when the service is unreachable or does not answer with a health document. */
  health(timeoutMs?: number): Promise<TranscriberHealth | null>
}

export const HEALTH_TIMEOUT_MS = 3_000

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Talks to services/transcriber over HTTP. */
export class HttpTranscriber implements Transcriber {
  private readonly url: string
  private readonly language?: string
  private readonly fetch: FetchLike

  constructor(opts: { url: string; language?: string; fetch?: FetchLike }) {
    this.url = opts.url.replace(/\/+$/, '')
    this.language = opts.language
    this.fetch = opts.fetch ?? globalThis.fetch
  }

  async transcribe(audio: Uint8Array<ArrayBuffer>, { mime, timeoutMs, language }: TranscribeOptions): Promise<TranscribeResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const headers: Record<string, string> = { 'content-type': mime }
    const lang = language ?? this.language
    if (lang) headers['x-language'] = lang
    try {
      const res = await this.fetch(`${this.url}/transcribe`, { method: 'POST', headers, body: audio, signal: controller.signal })
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        // 503: the model is still loading (or failed to load) — like a service that is not there yet.
        return { ok: false, error: res.status === 503 ? 'offline' : `http_${res.status}` }
      }
      const body: unknown = await res.json()
      if (!isRecord(body) || typeof body.text !== 'string') return { ok: false, error: 'unreadable' }
      return {
        ok: true,
        text: body.text,
        durationS: typeof body.duration_s === 'number' ? body.duration_s : 0,
        processingS: typeof body.processing_s === 'number' ? body.processing_s : 0,
        model: typeof body.model === 'string' ? body.model : 'unknown',
      }
    } catch (err) {
      if (controller.signal.aborted) return { ok: false, error: 'timeout' }
      if (err instanceof SyntaxError) return { ok: false, error: 'unreadable' }
      return { ok: false, error: 'offline' }
    } finally {
      clearTimeout(timer)
    }
  }

  async health(timeoutMs = HEALTH_TIMEOUT_MS): Promise<TranscriberHealth | null> {
    try {
      const res = await this.fetch(`${this.url}/health`, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) return null
      const body: unknown = await res.json()
      if (!isRecord(body) || typeof body.loaded !== 'boolean') return null
      return {
        ok: body.ok === true,
        model: typeof body.model === 'string' ? body.model : null,
        loaded: body.loaded,
        error: typeof body.error === 'string' ? body.error : null,
      }
    } catch {
      return null
    }
  }
}
```

- [ ] **Step 4: Run tests and typecheck, then commit**

Run: `npm test -w apps/api` → PASS. `npm run typecheck -w apps/api` → clean. (If the type checker rejects `body: audio`, the cause is the `ArrayBuffer` generic on `Uint8Array`: keep `Uint8Array<ArrayBuffer>` in the interface — `readFile` returns a `Buffer<ArrayBuffer>` — and do not widen it to `Uint8Array`.)
```bash
git add apps/api/src/transcription/client.ts apps/api/test/fake-http.ts apps/api/test/transcriber-client.test.ts
git commit -m "feat(api): transcriber HTTP client that never throws, tested against a local fake server"
```

---

### Task 4: Voice upload from the widget, media storage and the visitor message shape

**Files:**
- Create: `apps/api/src/media/store.ts`, `apps/api/src/media/routes.ts`
- Modify: `apps/api/src/channels/widget.ts`, `apps/api/src/server.ts`, `apps/api/src/http/errors.ts`
- Test: `apps/api/test/media.test.ts`

**Interfaces:**
- Consumes (plans 1–2): `receiveInbound(deps, InboundMessage)`, `historyForContact`, `CoreDeps`, `Message`, `WidgetChannel.push(contactKey, frame)`, `makeRequireUser(db)`, the `messages` table, `buildServer(deps, opts)`.
- Produces (`src/media/store.ts`):
  - `AUDIO_TYPES: Record<string, string>` — base MIME type → file extension: `audio/webm`→`webm`, `audio/ogg`→`ogg`, `audio/mp4`→`m4a`, `audio/mpeg`→`mp3`, `audio/wav`→`wav`, `audio/x-wav`→`wav`.
  - `MAX_AUDIO_BYTES = 10 * 1024 * 1024`.
  - `audioType(contentType: string | undefined): string | null` — base type, lowercased, without parameters, or `null` when it is not a key of `AUDIO_TYPES`.
  - `saveAudio(dir: string, bytes: Uint8Array, mime: string): Promise<string>` — writes `<uuid>.<ext>` (creating `dir`) and returns the file name.
  - `mediaFile(dir: string, name: string | null): string | null` — `join(dir, name)` for a plain file name; `null` for empty, `/` or `\` inside, or a leading dot.
  - `removeAudio(dir: string, name: string): Promise<void>` — best effort.
- Produces (`src/channels/widget.ts`):
  - `type VisitorMessage = { id: number; sender: Message['sender']; type: Message['type']; text: string | null; createdAt: string }` and `toVisitorMessage(m: Message): VisitorMessage` (`text` is `null` for audio). Every frame sent to a visitor (`history`, `message`) uses it.
  - `VISITOR_HEADER = 'x-relay-visitor'`, `contactKeyFor(token: string): string` (sha256 hex — the existing rule, now shared).
  - `widgetAudioRoute(app, deps: CoreDeps, widget: WidgetChannel, mediaDir: string): Promise<void>` — `POST /api/widget/audio`, raw body, `bodyLimit: MAX_AUDIO_BYTES`. Token missing or not 32–100 chars → 401 `invalid_token`; content type not accepted → 415 `unsupported_media_type`; empty body → 400 `empty_audio`; too large → 413 `too_large`. Success: stores the file, calls `receiveInbound` with `type: 'audio'`, `mediaPath`, `mediaMime` (base type), pushes `{ type: 'message', message: VisitorMessage }` to the visitor's sockets and answers 201 `{ message: VisitorMessage }`. A failure after the file was written removes the file.
- Produces (`src/media/routes.ts`): `mediaRoutes(app, deps: CoreDeps, mediaDir: string)` — `GET /api/conversations/:id/messages/:messageId/audio` (signed-in team member; 401 otherwise): the file with `content-type: <mediaMime>`; 404 `not_found` when the message is not an audio message of that conversation or the file is missing.
- `buildServer(deps, opts: { widget?: WidgetChannel; mediaDir?: string })`: with `mediaDir`, registers `mediaRoutes`; with both `widget` and `mediaDir`, also `widgetAudioRoute`.
- `registerErrorHandler`: Fastify's `FST_ERR_CTP_BODY_TOO_LARGE` → 413 `{ error: 'Payload too large', code: 'too_large' }`.

- [ ] **Step 1: Failing tests**

`apps/api/test/media.test.ts`:
```ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '../src/db/client'
import { seed, DEMO_USER } from '../src/db/seed'
import { EventBus } from '../src/core/events'
import { ChannelRegistry } from '../src/channels/types'
import { WidgetChannel, VISITOR_HEADER } from '../src/channels/widget'
import { buildServer } from '../src/server'
import { getConversation, listConversations, receiveInbound, teamReply } from '../src/core/conversations'
import { MAX_AUDIO_BYTES, audioType, mediaFile } from '../src/media/store'

const TOKEN = 'visitor-token-0123456789-abcdefghijklmnop'
const OPUS = Buffer.from('1a45dfa3-fake-opus-bytes')
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

async function setup() {
  const mediaDir = mkdtempSync(join(tmpdir(), 'relay-media-'))
  dirs.push(mediaDir)
  const db = createDb(':memory:')
  await seed(db)
  const channels = new ChannelRegistry()
  const widget = new WidgetChannel()
  channels.register(widget)
  const deps = { db, bus: new EventBus(), channels }
  const app = await buildServer(deps, { widget, mediaDir })
  await app.ready()
  const upload = (payload: Buffer, headers: Record<string, string> = {}) => app.inject({
    method: 'POST', url: '/api/widget/audio', payload,
    headers: { 'content-type': 'audio/webm;codecs=opus', [VISITOR_HEADER]: TOKEN, ...headers },
  })
  const login = async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: DEMO_USER.email, password: DEMO_USER.password } })
    const raw = res.headers['set-cookie']
    return ((Array.isArray(raw) ? raw[0] : raw) ?? '').split(';')[0]!
  }
  return { app, deps, mediaDir, upload, login }
}

describe('POST /api/widget/audio', () => {
  it('stores the audio as a customer message and pushes it to the visitor', async () => {
    const { app, deps, mediaDir, upload } = await setup()
    const ws = await app.injectWS(`/ws/widget?token=${TOKEN}`)
    const frames: any[] = []
    ws.on('message', (d: Buffer) => frames.push(JSON.parse(d.toString())))
    const res = await upload(OPUS)
    expect(res.statusCode).toBe(201)
    const { message } = res.json()
    expect(message).toEqual({ id: expect.any(Number), sender: 'contact', type: 'audio', text: null, createdAt: expect.any(String) })
    const [conv] = listConversations(deps, {})
    const found = getConversation(deps, conv!.id)!
    const stored = found.messages[0]!
    expect(stored).toMatchObject({ type: 'audio', mediaMime: 'audio/webm', transcription: null })
    expect(stored.mediaPath).toMatch(/^[0-9a-f-]{36}\.webm$/)
    expect(readFileSync(join(mediaDir, stored.mediaPath!))).toEqual(OPUS)
    expect(found.contact.contactKey).toBe(createHash('sha256').update(TOKEN).digest('hex'))
    await vi.waitFor(() => expect(frames).toContainEqual({ type: 'message', message }))
    ws.terminate()
  })

  it.each([
    ['no token', { [VISITOR_HEADER]: '' }, 401, 'invalid_token'],
    ['a short token', { [VISITOR_HEADER]: 'short' }, 401, 'invalid_token'],
    ['a non-audio type', { 'content-type': 'text/plain' }, 415, 'unsupported_media_type'],
  ])('rejects %s and stores nothing', async (_name, headers, status, code) => {
    const { deps, mediaDir, upload } = await setup()
    const res = await upload(OPUS, headers)
    expect(res.statusCode).toBe(status)
    expect(res.json()).toMatchObject({ code })
    expect(readdirSync(mediaDir)).toEqual([])
    expect(listConversations(deps, {})).toEqual([])
  })

  it('rejects an empty body and a body over the limit', async () => {
    const { mediaDir, upload } = await setup()
    const empty = await upload(Buffer.alloc(0))
    expect(empty.statusCode).toBe(400)
    expect(empty.json()).toMatchObject({ code: 'empty_audio' })
    const big = await upload(Buffer.alloc(MAX_AUDIO_BYTES + 1))
    expect(big.statusCode).toBe(413)
    expect(big.json()).toMatchObject({ code: 'too_large' })
    expect(readdirSync(mediaDir)).toEqual([])
  })
})

describe('visitor messages', () => {
  it('history frames carry no internal fields', async () => {
    const { app, deps, upload } = await setup()
    await upload(OPUS)
    const [conv] = listConversations(deps, {})
    await teamReply(deps, conv!.id, 1, 'We got your audio')
    const ws = await app.injectWS(`/ws/widget?token=${TOKEN}`)
    const history = await new Promise<any>((resolve) => ws.once('message', (d: Buffer) => resolve(JSON.parse(d.toString()))))
    const keys = ['createdAt', 'id', 'sender', 'text', 'type']
    expect(history.messages.map((m: object) => Object.keys(m).sort())).toEqual([keys, keys])
    expect(history.messages.map((m: any) => [m.type, m.text])).toEqual([['audio', null], ['text', 'We got your audio']])
    ws.terminate()
  })
})

describe('GET /api/conversations/:id/messages/:messageId/audio', () => {
  it('sends the stored audio to a signed-in team member', async () => {
    const { app, deps, upload, login } = await setup()
    const { message } = (await upload(OPUS)).json()
    const [conv] = listConversations(deps, {})
    const url = `/api/conversations/${conv!.id}/messages/${message.id}/audio`
    expect((await app.inject({ url })).statusCode).toBe(401)
    const res = await app.inject({ url, headers: { cookie: await login() } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('audio/webm')
    expect(res.rawPayload).toEqual(OPUS)
  })

  it('answers 404 for a text message, another conversation, or a missing file', async () => {
    const { app, deps, upload, login, mediaDir } = await setup()
    const cookie = await login()
    const { message } = (await upload(OPUS)).json()
    const [conv] = listConversations(deps, {})
    const text = receiveInbound(deps, { channel: 'widget', contactKey: 'other', type: 'text', text: 'hi' })
    const get = (c: number, m: number) => app.inject({ url: `/api/conversations/${c}/messages/${m}/audio`, headers: { cookie } })
    expect((await get(text.conversation.id, text.message.id)).statusCode).toBe(404)
    expect((await get(text.conversation.id, message.id)).statusCode).toBe(404)
    rmSync(join(mediaDir, getConversation(deps, conv!.id)!.messages[0]!.mediaPath!))
    expect((await get(conv!.id, message.id)).statusCode).toBe(404)
  })
})

describe('media helpers', () => {
  it('accepts recorder audio types and rejects the rest', () => {
    expect(audioType('audio/webm;codecs=opus')).toBe('audio/webm')
    expect(audioType('AUDIO/OGG; codecs=opus')).toBe('audio/ogg')
    expect(audioType('audio/mp4')).toBe('audio/mp4')
    expect(audioType('text/plain')).toBeNull()
    expect(audioType('constructor')).toBeNull()
    expect(audioType(undefined)).toBeNull()
  })

  it('only resolves plain generated file names', () => {
    expect(mediaFile('/m', 'a.webm')).toBe(join('/m', 'a.webm'))
    for (const bad of ['../a.webm', 'x/a.webm', 'x\\a.webm', '.hidden', '', null]) expect(mediaFile('/m', bad)).toBeNull()
  })
})
```

Run: `npm test -w apps/api -- media` → FAIL (`Cannot find module '../src/media/store'`).

- [ ] **Step 2: Media store**

`apps/api/src/media/store.ts`:
```ts
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** What browsers record with MediaRecorder, plus MP3/WAV for manual tests. Base MIME type → file extension. */
export const AUDIO_TYPES: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
}

/** 10 MB: far more than the widget's 2-minute recordings (opus voice is well under 1 MB per minute). */
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024

/** "audio/webm;codecs=opus" → "audio/webm"; null when the type is not an accepted audio type. */
export function audioType(contentType: string | undefined): string | null {
  const base = (contentType ?? '').split(';')[0]!.trim().toLowerCase()
  return Object.hasOwn(AUDIO_TYPES, base) ? base : null
}

/** Writes the audio under a generated name and returns that name (never a client-supplied one). */
export async function saveAudio(dir: string, bytes: Uint8Array, mime: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const name = `${randomUUID()}.${AUDIO_TYPES[mime] ?? 'bin'}`
  await writeFile(join(dir, name), bytes)
  return name
}

/** Absolute path of a stored file, or null for anything that is not a plain file name. */
export function mediaFile(dir: string, name: string | null): string | null {
  if (!name || /[\\/]/.test(name) || name.startsWith('.')) return null
  return join(dir, name)
}

export async function removeAudio(dir: string, name: string): Promise<void> {
  const file = mediaFile(dir, name)
  if (file) await rm(file, { force: true }).catch(() => {})
}
```

- [ ] **Step 3: Widget channel — visitor shape and upload route**

Replace `apps/api/src/channels/widget.ts` with:
```ts
import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import { z } from 'zod'
import type { Channel } from './types'
import type { Contact, Conversation, Message } from '../core/types'
import { historyForContact, receiveInbound, type CoreDeps } from '../core/conversations'
import { MAX_AUDIO_BYTES, audioType, removeAudio, saveAudio } from '../media/store'

const Frame = z.object({ type: z.literal('text'), text: z.string().trim().min(1).max(4000) })
const Token = z.string().min(32).max(100)
const Query = z.object({ token: Token, name: z.string().max(80).optional() })

/** The visitor token travels in this header on HTTP requests (never in the URL, so it stays out of access logs). */
export const VISITOR_HEADER = 'x-relay-visitor'

/** The token is a bearer secret: only its hash is used as the contact key, so it never reaches the DB or API. */
export const contactKeyFor = (token: string) => createHash('sha256').update(token).digest('hex')

export type VisitorMessage = { id: number; sender: Message['sender']; type: Message['type']; text: string | null; createdAt: string }

/** What a visitor may see: no team user ids, file names or transcription internals. */
export function toVisitorMessage(m: Message): VisitorMessage {
  return { id: m.id, sender: m.sender, type: m.type, text: m.type === 'audio' ? null : m.text, createdAt: m.createdAt }
}

export class WidgetChannel implements Channel {
  readonly id = 'widget' as const
  private sockets = new Map<string, Set<WebSocket>>()

  attach(contactKey: string, socket: WebSocket): () => void {
    const set = this.sockets.get(contactKey) ?? new Set<WebSocket>()
    set.add(socket)
    this.sockets.set(contactKey, set)
    return () => {
      set.delete(socket)
      if (set.size === 0) this.sockets.delete(contactKey)
    }
  }

  push(contactKey: string, frame: unknown): void {
    for (const s of this.sockets.get(contactKey) ?? []) {
      if (s.readyState === s.OPEN) s.send(JSON.stringify(frame))
    }
  }

  async send(target: { conversation: Conversation; contact: Contact }, message: Message): Promise<void> {
    this.push(target.contact.contactKey, { type: 'message', message: toVisitorMessage(message) })
  }
}

export function widgetSocket(app: FastifyInstance, deps: CoreDeps, widget: WidgetChannel) {
  app.get('/ws/widget', { websocket: true }, (socket, req) => {
    const q = Query.safeParse(req.query)
    if (!q.success) { socket.close(4400, 'invalid_token'); return }
    const { token, name } = q.data
    const contactKey = contactKeyFor(token)
    const detach = widget.attach(contactKey, socket)
    const history = historyForContact(deps, 'widget', contactKey).map(toVisitorMessage)
    setImmediate(() => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'history', messages: history }))
    })

    socket.on('message', (raw) => {
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

/** Voice messages: the browser posts the recording as the raw request body. */
export async function widgetAudioRoute(app: FastifyInstance, deps: CoreDeps, widget: WidgetChannel, mediaDir: string) {
  await app.register(async (scope) => {
    // Scoped to this plugin: the rest of the API keeps its JSON parser.
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => { done(null, body) })

    scope.post('/api/widget/audio', { bodyLimit: MAX_AUDIO_BYTES }, async (req, reply) => {
      const token = Token.safeParse(req.headers[VISITOR_HEADER])
      if (!token.success) return reply.code(401).send({ error: 'Missing or invalid visitor token', code: 'invalid_token' })
      const mime = audioType(req.headers['content-type'])
      if (!mime) return reply.code(415).send({ error: 'Unsupported audio type', code: 'unsupported_media_type' })
      const body = req.body
      if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: 'Empty audio', code: 'empty_audio' })

      const contactKey = contactKeyFor(token.data)
      const name = await saveAudio(mediaDir, body, mime)
      try {
        const { message } = receiveInbound(deps, { channel: 'widget', contactKey, type: 'audio', mediaPath: name, mediaMime: mime })
        const visible = toVisitorMessage(message)
        widget.push(contactKey, { type: 'message', message: visible })
        return reply.code(201).send({ message: visible })
      } catch (err) {
        await removeAudio(mediaDir, name)
        throw err
      }
    })
  })
}
```

- [ ] **Step 4: Inbox audio route, server wiring, 413 code**

`apps/api/src/media/routes.ts`:
```ts
import { readFile } from 'node:fs/promises'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { makeRequireUser } from '../auth/guard'
import type { CoreDeps } from '../core/conversations'
import { messages } from '../db/schema'
import { mediaFile } from './store'

const Params = z.object({ id: z.coerce.number().int().positive(), messageId: z.coerce.number().int().positive() })

export function mediaRoutes(app: FastifyInstance, deps: CoreDeps, mediaDir: string) {
  const requireUser = makeRequireUser(deps.db)

  app.get('/api/conversations/:id/messages/:messageId/audio', { preHandler: requireUser }, async (req, reply) => {
    const { id, messageId } = Params.parse(req.params)
    const m = deps.db.select().from(messages).where(and(eq(messages.id, messageId), eq(messages.conversationId, id))).get()
    const file = m?.type === 'audio' ? mediaFile(mediaDir, m.mediaPath) : null
    const notFound = () => reply.code(404).send({ error: 'Audio not found', code: 'not_found' })
    if (!m || !file) return notFound()
    let data: Buffer
    try {
      data = await readFile(file)
    } catch {
      return notFound()
    }
    return reply.header('content-type', m.mediaMime ?? 'application/octet-stream').header('cache-control', 'private, max-age=3600').send(data)
  })
}
```

In `apps/api/src/server.ts`, replace the widget import and add the media import:
```ts
import { widgetAudioRoute, widgetSocket, type WidgetChannel } from './channels/widget'
import { mediaRoutes } from './media/routes'
```
change the signature to
```ts
export async function buildServer(deps: ServerDeps, opts: { widget?: WidgetChannel; mediaDir?: string } = {}): Promise<FastifyInstance> {
```
and replace the line `if (opts.widget) widgetSocket(app, deps, opts.widget)` with:
```ts
  if (opts.widget) widgetSocket(app, deps, opts.widget)
  if (opts.mediaDir) {
    mediaRoutes(app, deps, opts.mediaDir)
    if (opts.widget) await widgetAudioRoute(app, deps, opts.widget, opts.mediaDir)
  }
```

In `apps/api/src/http/errors.ts`, add as the first line inside the `setErrorHandler` callback:
```ts
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ error: 'Payload too large', code: 'too_large' })
```

- [ ] **Step 5: Run tests and typecheck, then commit**

Run: `npm test -w apps/api` → PASS (the existing `widget.test.ts` still passes: it checks frames with `toMatchObject` on fields the visitor shape keeps). `npm run typecheck -w apps/api` → clean.
```bash
git add apps/api/src/media apps/api/src/channels/widget.ts apps/api/src/server.ts apps/api/src/http/errors.ts apps/api/test/media.test.ts
git commit -m "feat(api): voice upload from the widget, media storage and a visitor-safe message shape"
```

---

### Task 5: Transcription step — pending audio, deadlines, storage, live update and offline retry

**Files:**
- Create: `apps/api/src/transcription/pipeline.ts`, `apps/api/src/transcription/retry.ts`, `apps/api/test/fake-transcriber.ts`
- Modify: `apps/api/src/core/events.ts`, `apps/api/src/realtime/inbox.ts`, `apps/api/src/core/settings.ts`, `apps/api/src/db/schema.ts`
- Test: `apps/api/test/transcription.test.ts`, `apps/api/test/transcription-retry.test.ts`, `apps/api/test/settings.test.ts` (extend), `apps/api/test/inbox-ws.test.ts` (extend)

**Interfaces:**
- Consumes: `Transcriber`, `TranscribeResult`, `TranscriberHealth` (Task 3); `mediaFile` (Task 4); `getConversation`, `CoreDeps` (plan 1); `HISTORY_LIMIT = 20` from `src/agent/engine.ts` (plan 2); the `settings` row `transcription.enabled` (seeded `true` since plan 1).
- Produces:
  - `RelayEvents['message.updated']: { conversationId: number; message: Message }`, forwarded to `/ws/inbox` as `{ event: 'message.updated', data }`.
  - `Transcription` type (`src/db/schema.ts`) gains `durationS?: number` (JSON column, no migration).
  - `transcriptionEnabled(db: Db): boolean` (`src/core/settings.ts`) — the stored boolean, `true` when missing or invalid.
  - `src/transcription/pipeline.ts`: `PER_AUDIO_MS = 40_000`, `PER_TURN_MS = 40_000`, `type TranscriptionDeps = CoreDeps & { transcriber: Transcriber | null; mediaDir: string; perAudioMs?: number; perTurnMs?: number }`, `type TranscribeOutcome = { attempted: number; offline: boolean }`, `transcribePending(deps: TranscriptionDeps, conversationId: number): Promise<TranscribeOutcome>`.
    Rules: does nothing without a transcriber or when transcription is off. Considers `contact` messages of type `audio` with `transcription === null` among the last `HISTORY_LIMIT` messages, oldest first. Per audio: missing or invalid file → store `failed` / `missing_file` without calling the service; otherwise call with `timeoutMs = min(perAudio, time left in the turn)` (stop when no time is left). `ok` + non-blank text → `{ status: 'ok', text: <trimmed>, model, durationS, at }`; blank → `{ status: 'empty', model, durationS, at }`; `offline` → store nothing, set `offline: true`, stop; `timeout` with `timeoutMs < perAudio` → store nothing, stop; any other error → `{ status: 'failed', error, at }`. Every stored transcription emits `message.updated` with the updated row. Logs `[relay] transcribed message <id>: <d>s of audio in <p>s` or `[relay] transcription of message <id> failed: <code>` — never the text. `attempted` counts calls to the service.
  - `src/transcription/retry.ts`: `RETRY_INTERVAL_MS = 15_000`, `class OfflineRetry(transcriber: Pick<Transcriber, 'health'>, reschedule: (conversationId: number) => void, intervalMs = RETRY_INTERVAL_MS)` with `add(id)`, `check(): Promise<void>` (no-op when nothing waits or a check is running; when `health()` says `loaded`, reschedules every waiting conversation once and stops polling), `stop()`, `get size(): number`. `add` starts an unref'd interval that calls `check`.
  - `test/fake-transcriber.ts`: `class FakeTranscriber implements Transcriber` built with `answer: (call: number) => TranscribeResult | Promise<TranscribeResult>`; records `calls: Array<{ bytes: number; mime: string; timeoutMs: number }>`; `healthy: TranscriberHealth | null` (default loaded) returned by `health()`. `said(text: string): TranscribeResult` → `{ ok: true, text, durationS: 2, processingS: 0.5, model: 'fake' }`.

- [ ] **Step 1: Fake transcriber**

`apps/api/test/fake-transcriber.ts`:
```ts
import type { TranscribeOptions, TranscribeResult, Transcriber, TranscriberHealth } from '../src/transcription/client'

/** In-memory Transcriber: `answer` decides each result (call numbers start at 1). */
export class FakeTranscriber implements Transcriber {
  calls: Array<{ bytes: number; mime: string; timeoutMs: number }> = []
  healthy: TranscriberHealth | null = { ok: true, model: 'fake', loaded: true, error: null }

  constructor(private readonly answer: (call: number) => TranscribeResult | Promise<TranscribeResult>) {}

  async transcribe(audio: Uint8Array<ArrayBuffer>, opts: TranscribeOptions): Promise<TranscribeResult> {
    this.calls.push({ bytes: audio.length, mime: opts.mime, timeoutMs: opts.timeoutMs })
    return this.answer(this.calls.length)
  }

  async health(): Promise<TranscriberHealth | null> {
    return this.healthy
  }
}

export const said = (text: string): TranscribeResult => ({ ok: true, text, durationS: 2, processingS: 0.5, model: 'fake' })
```

- [ ] **Step 2: Failing tests**

`apps/api/test/transcription.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { createDb } from '../src/db/client'
import { seed } from '../src/db/seed'
import { settings } from '../src/db/schema'
import { EventBus } from '../src/core/events'
import { ChannelRegistry } from '../src/channels/types'
import { getConversation, postOutbound, receiveInbound } from '../src/core/conversations'
import { PER_AUDIO_MS, transcribePending, type TranscriptionDeps } from '../src/transcription/pipeline'
import { FakeTranscriber, said } from './fake-transcriber'

let deps: TranscriptionDeps
let mediaDir: string
let n = 0

async function setup(transcriber: FakeTranscriber | null, extra: Partial<TranscriptionDeps> = {}) {
  const db = createDb(':memory:')
  await seed(db)
  deps = { db, bus: new EventBus(), channels: new ChannelRegistry(), transcriber, mediaDir, ...extra }
}
beforeEach(() => { mediaDir = mkdtempSync(join(tmpdir(), 'relay-tx-')) })
afterEach(() => rmSync(mediaDir, { recursive: true, force: true }))

/** A customer voice message whose file exists in mediaDir. */
function voice(bytes = 'opus') {
  const name = `voice-${++n}.webm`
  writeFileSync(join(mediaDir, name), bytes)
  return receiveInbound(deps, { channel: 'widget', contactKey: 'k'.repeat(64), type: 'audio', mediaPath: name, mediaMime: 'audio/webm' })
}
const messagesOf = (id: number) => getConversation(deps, id)!.messages

describe('transcribePending', () => {
  it('stores the trimmed text and emits message.updated', async () => {
    const t = new FakeTranscriber(() => said('  What are your opening hours?  '))
    await setup(t)
    const { conversation } = voice()
    const events: unknown[] = []
    deps.bus.on('message.updated', (e) => { events.push(e) })
    expect(await transcribePending(deps, conversation.id)).toEqual({ attempted: 1, offline: false })
    expect(t.calls).toEqual([{ bytes: 4, mime: 'audio/webm', timeoutMs: PER_AUDIO_MS }])
    const stored = messagesOf(conversation.id)[0]!
    expect(stored.transcription).toEqual({ status: 'ok', text: 'What are your opening hours?', model: 'fake', durationS: 2, at: expect.any(String) })
    expect(events).toEqual([{ conversationId: conversation.id, message: stored }])
  })

  it('stores silence as empty', async () => {
    await setup(new FakeTranscriber(() => said('   ')))
    const { conversation } = voice()
    await transcribePending(deps, conversation.id)
    expect(messagesOf(conversation.id)[0]!.transcription).toMatchObject({ status: 'empty', model: 'fake' })
  })

  it('offline stores nothing and stops; the same audio is transcribed once the service is back', async () => {
    let up = false
    const t = new FakeTranscriber(() => (up ? said('hello') : { ok: false, error: 'offline' }))
    await setup(t)
    const { conversation } = voice()
    voice()
    expect(await transcribePending(deps, conversation.id)).toEqual({ attempted: 1, offline: true })
    expect(messagesOf(conversation.id).map((m) => m.transcription)).toEqual([null, null])
    up = true
    expect(await transcribePending(deps, conversation.id)).toEqual({ attempted: 2, offline: false })
    expect(messagesOf(conversation.id).map((m) => m.transcription?.status)).toEqual(['ok', 'ok'])
  })

  it('stores other failures as failed and never retries them', async () => {
    const t = new FakeTranscriber(() => ({ ok: false, error: 'http_422' }))
    await setup(t)
    const { conversation } = voice()
    await transcribePending(deps, conversation.id)
    expect(messagesOf(conversation.id)[0]!.transcription).toMatchObject({ status: 'failed', error: 'http_422' })
    expect(await transcribePending(deps, conversation.id)).toEqual({ attempted: 0, offline: false })
    expect(t.calls).toHaveLength(1)
  })

  it('a timeout at the per-audio deadline is a failure', async () => {
    await setup(new FakeTranscriber(() => ({ ok: false, error: 'timeout' })), { perAudioMs: 1000 })
    const { conversation } = voice()
    await transcribePending(deps, conversation.id)
    expect(messagesOf(conversation.id)[0]!.transcription).toMatchObject({ status: 'failed', error: 'timeout' })
  })

  it('stops at the per-turn budget and leaves the rest for a later turn', async () => {
    const t = new FakeTranscriber(async () => { await new Promise((r) => setTimeout(r, 60)); return said('first') })
    await setup(t, { perTurnMs: 40 })
    const { conversation } = voice()
    voice()
    await transcribePending(deps, conversation.id)
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0]!.timeoutMs).toBeLessThanOrEqual(40)
    expect(messagesOf(conversation.id).map((m) => m.transcription?.status ?? null)).toEqual(['ok', null])
  })

  it('does not store a timeout that the per-turn budget cut short', async () => {
    await setup(new FakeTranscriber(() => ({ ok: false, error: 'timeout' })), { perTurnMs: 30 })
    const { conversation } = voice()
    await transcribePending(deps, conversation.id)
    expect(messagesOf(conversation.id)[0]!.transcription).toBeNull()
  })

  it('a missing file is a failure, without calling the service', async () => {
    const t = new FakeTranscriber(() => said('x'))
    await setup(t)
    const { conversation } = receiveInbound(deps, { channel: 'widget', contactKey: 'k'.repeat(64), type: 'audio', mediaPath: 'gone.webm', mediaMime: 'audio/webm' })
    await transcribePending(deps, conversation.id)
    expect(t.calls).toHaveLength(0)
    expect(messagesOf(conversation.id)[0]!.transcription).toMatchObject({ status: 'failed', error: 'missing_file' })
  })

  it('does nothing when transcription is off or there is no transcriber', async () => {
    const t = new FakeTranscriber(() => said('x'))
    await setup(t)
    deps.db.update(settings).set({ value: false }).where(eq(settings.key, 'transcription.enabled')).run()
    const { conversation } = voice()
    expect(await transcribePending(deps, conversation.id)).toEqual({ attempted: 0, offline: false })
    await setup(null)
    const other = voice()
    expect(await transcribePending(deps, other.conversation.id)).toEqual({ attempted: 0, offline: false })
    expect(t.calls).toHaveLength(0)
  })

  it('ignores text messages and company messages', async () => {
    const t = new FakeTranscriber(() => said('x'))
    await setup(t)
    const { conversation } = receiveInbound(deps, { channel: 'widget', contactKey: 'k'.repeat(64), type: 'text', text: 'hi' })
    await postOutbound(deps, conversation.id, { sender: 'agent', text: 'hello' })
    expect(await transcribePending(deps, conversation.id)).toEqual({ attempted: 0, offline: false })
  })

  it('never logs the text', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await setup(new FakeTranscriber(() => said('my card number is 1234')))
      const { conversation } = voice()
      await transcribePending(deps, conversation.id)
      const logged = [...log.mock.calls, ...warn.mock.calls].flat().join(' ')
      expect(logged).toContain('transcribed message')
      expect(logged).not.toContain('1234')
    } finally {
      log.mockRestore()
      warn.mockRestore()
    }
  })
})
```

`apps/api/test/transcription-retry.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { OfflineRetry } from '../src/transcription/retry'
import type { TranscriberHealth } from '../src/transcription/client'

const up: TranscriberHealth = { ok: true, model: 'small', loaded: true, error: null }
const loading: TranscriberHealth = { ok: true, model: 'small', loaded: false, error: null }

/** health() answers each entry in turn and then keeps repeating the last one. */
function setup(answers: Array<TranscriberHealth | null>, intervalMs = 60_000) {
  const queue = [...answers]
  const transcriber = { health: vi.fn(async () => (queue.length > 1 ? queue.shift()! : queue[0]!)) }
  const reschedule = vi.fn()
  return { retry: new OfflineRetry(transcriber, reschedule, intervalMs), transcriber, reschedule }
}

describe('OfflineRetry', () => {
  it('reschedules every waiting conversation once the model is loaded', async () => {
    const { retry, reschedule } = setup([null, loading, up])
    retry.add(1)
    retry.add(2)
    retry.add(1)
    await retry.check()
    await retry.check()
    expect(reschedule).not.toHaveBeenCalled()
    await retry.check()
    expect(reschedule.mock.calls).toEqual([[1], [2]])
    expect(retry.size).toBe(0)
    retry.stop()
  })

  it('does not ask for health when nothing is waiting', async () => {
    const { retry, transcriber } = setup([up])
    await retry.check()
    expect(transcriber.health).not.toHaveBeenCalled()
  })

  it('polls on its own and stops polling when done', async () => {
    const { retry, transcriber, reschedule } = setup([up], 10)
    retry.add(7)
    await vi.waitFor(() => expect(reschedule).toHaveBeenCalledWith(7))
    const calls = transcriber.health.mock.calls.length
    await new Promise((r) => setTimeout(r, 40))
    expect(transcriber.health.mock.calls.length).toBe(calls)
  })

  it('stop() forgets the waiting conversations', async () => {
    const { retry, reschedule } = setup([up])
    retry.add(1)
    retry.stop()
    await retry.check()
    expect(reschedule).not.toHaveBeenCalled()
  })
})
```

Append to `apps/api/test/settings.test.ts` — add `transcriptionEnabled` to the import from `../src/core/settings`, and inside the `describe` block:
```ts
  it('transcription is on by default, can be turned off, and an invalid value means on', async () => {
    const db = createDb(':memory:')
    await seed(db)
    expect(transcriptionEnabled(db)).toBe(true)
    db.update(settings).set({ value: false }).where(eq(settings.key, 'transcription.enabled')).run()
    expect(transcriptionEnabled(db)).toBe(false)
    db.update(settings).set({ value: 'yes' }).where(eq(settings.key, 'transcription.enabled')).run()
    expect(transcriptionEnabled(db)).toBe(true)
  })
```

Append inside the `describe('/ws/inbox', ...)` block of `apps/api/test/inbox-ws.test.ts`:
```ts
  it('pushes transcription updates', async () => {
    const { app, deps, login } = await testServer()
    await app.ready()
    const cookie = await login()
    const { conversation, message } = receiveInbound(deps, { channel: 'widget', contactKey: 'v-1', type: 'audio', mediaPath: 'a.webm', mediaMime: 'audio/webm' })
    const ws = await app.injectWS('/ws/inbox', { headers: { cookie } })
    const first = nextFrame(ws)
    const updated = { ...message, transcription: { status: 'ok' as const, text: 'hi', at: '2026-11-11T12:00:00.000Z' } }
    deps.bus.emit('message.updated', { conversationId: conversation.id, message: updated })
    expect(await first).toEqual({ event: 'message.updated', data: { conversationId: conversation.id, message: updated } })
    ws.terminate()
  })
```

Run: `npm test -w apps/api` → FAIL (missing modules, `transcriptionEnabled` not exported, `'message.updated'` not an event).

- [ ] **Step 3: Event, inbox forwarding, schema type, setting**

In `apps/api/src/core/events.ts`, add to `RelayEvents`:
```ts
  'message.updated': { conversationId: number; message: Message }
```

In `apps/api/src/realtime/inbox.ts`:
```ts
const EVENTS: Array<keyof RelayEvents> = ['message.created', 'message.updated', 'conversation.updated', 'agent.run.created']
```

In `apps/api/src/db/schema.ts`, replace the `Transcription` type with:
```ts
export type Transcription = {
  status: 'ok' | 'empty' | 'failed'
  text?: string
  error?: string
  model?: string
  durationS?: number
  at: string
}
```

In `apps/api/src/core/settings.ts`, add `import { eq } from 'drizzle-orm'` at the top and append:
```ts
/** Spec §7 settings: transcription on/off. A missing or invalid stored value means on. */
export function transcriptionEnabled(db: Db): boolean {
  const row = db.select().from(settings).where(eq(settings.key, 'transcription.enabled')).get()
  const parsed = z.boolean().safeParse(row?.value)
  return parsed.success ? parsed.data : true
}
```

- [ ] **Step 4: Pipeline and retry**

`apps/api/src/transcription/pipeline.ts`:
```ts
import { readFile } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { getConversation, type CoreDeps } from '../core/conversations'
import { transcriptionEnabled } from '../core/settings'
import type { Message } from '../core/types'
import { messages, type Transcription } from '../db/schema'
import { HISTORY_LIMIT } from '../agent/engine'
import { mediaFile } from '../media/store'
import type { Transcriber } from './client'

/** Spec §5: per-audio deadline and per-turn total. */
export const PER_AUDIO_MS = 40_000
export const PER_TURN_MS = 40_000

export type TranscriptionDeps = CoreDeps & { transcriber: Transcriber | null; mediaDir: string; perAudioMs?: number; perTurnMs?: number }
export type TranscribeOutcome = { attempted: number; offline: boolean }

const now = () => new Date().toISOString()

function store(deps: CoreDeps, message: Message, transcription: Transcription): void {
  const updated = deps.db.update(messages).set({ transcription }).where(eq(messages.id, message.id)).returning().get()
  if (updated) deps.bus.emit('message.updated', { conversationId: updated.conversationId, message: updated })
}

/**
 * Transcribes the customer's recent voice messages that have no transcription yet.
 * `offline` means the service could not be reached: nothing was stored, so the same audio is tried again later.
 */
export async function transcribePending(deps: TranscriptionDeps, conversationId: number): Promise<TranscribeOutcome> {
  const outcome: TranscribeOutcome = { attempted: 0, offline: false }
  if (!deps.transcriber || !transcriptionEnabled(deps.db)) return outcome
  const found = getConversation(deps, conversationId)
  if (!found) return outcome
  const pending = found.messages.slice(-HISTORY_LIMIT)
    .filter((m) => m.sender === 'contact' && m.type === 'audio' && m.transcription === null)
  const perAudio = deps.perAudioMs ?? PER_AUDIO_MS
  const deadline = Date.now() + (deps.perTurnMs ?? PER_TURN_MS)

  for (const m of pending) {
    const left = deadline - Date.now()
    if (left <= 0) break
    const file = mediaFile(deps.mediaDir, m.mediaPath)
    let audio: Buffer<ArrayBuffer>
    try {
      if (!file) throw new Error('no file')
      audio = await readFile(file)
    } catch {
      store(deps, m, { status: 'failed', error: 'missing_file', at: now() })
      continue
    }
    const timeoutMs = Math.min(perAudio, left)
    outcome.attempted++
    const r = await deps.transcriber.transcribe(audio, { mime: m.mediaMime ?? 'application/octet-stream', timeoutMs })
    if (r.ok) {
      const text = r.text.trim()
      store(deps, m, text
        ? { status: 'ok', text, model: r.model, durationS: r.durationS, at: now() }
        : { status: 'empty', model: r.model, durationS: r.durationS, at: now() })
      // Never log the text: it is the customer's speech.
      console.log(`[relay] transcribed message ${m.id}: ${r.durationS}s of audio in ${r.processingS}s`)
      continue
    }
    console.warn(`[relay] transcription of message ${m.id} failed: ${r.error}`)
    if (r.error === 'offline') { outcome.offline = true; break }
    // Cut short by the turn budget, not by its own deadline: leave it for a later turn.
    if (r.error === 'timeout' && timeoutMs < perAudio) break
    store(deps, m, { status: 'failed', error: r.error, at: now() })
  }
  return outcome
}
```

(`readFile` returns `Buffer<ArrayBuffer>` with `@types/node` 24. If the type checker disagrees, declare `audio` as `Uint8Array<ArrayBuffer>` and assign `new Uint8Array(await readFile(file))`.)

`apps/api/src/transcription/retry.ts`:
```ts
import type { Transcriber } from './client'

export const RETRY_INTERVAL_MS = 15_000

/**
 * Spec §5: when the transcriber is offline, nothing is stored and the audio is retried when it comes back.
 * Polls /health while some conversation is waiting; once the model is loaded, reschedules each waiting conversation once.
 */
export class OfflineRetry {
  private readonly waiting = new Set<number>()
  private timer: ReturnType<typeof setInterval> | undefined
  private checking = false

  constructor(
    private readonly transcriber: Pick<Transcriber, 'health'>,
    private readonly reschedule: (conversationId: number) => void,
    private readonly intervalMs = RETRY_INTERVAL_MS,
  ) {}

  get size(): number {
    return this.waiting.size
  }

  add(conversationId: number): void {
    this.waiting.add(conversationId)
    if (this.timer) return
    this.timer = setInterval(() => void this.check(), this.intervalMs)
    this.timer.unref?.()
  }

  async check(): Promise<void> {
    if (this.checking || this.waiting.size === 0) return
    this.checking = true
    try {
      const health = await this.transcriber.health()
      if (!health?.loaded) return
      const ids = [...this.waiting]
      this.stop()
      for (const id of ids) this.reschedule(id)
    } finally {
      this.checking = false
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.waiting.clear()
  }
}
```

- [ ] **Step 5: Run tests and typecheck, then commit**

Run: `npm test -w apps/api` → PASS. `npm run typecheck -w apps/api` → clean.
```bash
git add apps/api/src/transcription apps/api/src/core apps/api/src/realtime/inbox.ts apps/api/src/db/schema.ts apps/api/test
git commit -m "feat(api): transcribe pending voice messages with deadlines, live updates and an offline retry"
```

---

### Task 6: Turn runner, audio-aware agent and wiring in `main.ts`

**Files:**
- Create: `apps/api/src/agent/turn.ts`
- Modify: `apps/api/src/agent/engine.ts`, `apps/api/src/agent/providers/demo.ts`, `apps/api/src/db/seed.ts`, `apps/api/src/main.ts`
- Test: `apps/api/test/turn.test.ts` (new), `apps/api/test/agent-flow.test.ts`, `apps/api/test/engine.test.ts`, `apps/api/test/demo-provider.test.ts`, `apps/api/test/settings.test.ts`

**Interfaces:**
- Consumes: `transcribePending`, `TranscriptionDeps` (Task 5); `OfflineRetry` (Task 5); `HttpTranscriber` (Task 3); `buildServer(deps, { widget, mediaDir })`, `VISITOR_HEADER` (Task 4); `runAgentTurn`, `EngineDeps`, `TurnResult`, `AgentQueue` (plan 2); `FakeTranscriber`, `said` (Task 5).
- Produces:
  - `src/agent/engine.ts`: `export const AUDIO_PLACEHOLDER = '[audio]'`, `export const TRANSCRIBED_PREFIX = '[customer audio, transcribed] '` (the history markers from spec §4, now shared); handoff keywords are matched against the text of a text message or the `ok` transcription of an audio message.
  - `src/agent/providers/demo.ts`: `export const AUDIO_FALLBACK = "Sorry, I couldn't listen to your voice message. Could you type your question?"`. A last user message equal to `AUDIO_PLACEHOLDER` gets that text; a message starting with `TRANSCRIBED_PREFIX` is handled (greeting, handoff words, search query) on the words after the prefix.
  - `src/db/seed.ts`: `DEFAULT_SETTINGS['agent.handoffKeywords'] = ['human', 'humano', 'atendente', 'real person', 'pessoa real']`; `seed()` replaces a stored list that is exactly the old default `['human', 'agent', 'atendente', 'humano']`.
  - `src/agent/turn.ts`: `type TurnDeps = EngineDeps & TranscriptionDeps & { onTranscriberOffline?: (conversationId: number) => void }`, `makeTurnRunner(deps: TurnDeps): (conversationId: number) => Promise<TurnResult>` — runs `transcribePending`, calls `onTranscriberOffline(id)` when it reports `offline`, logs `[relay] transcription step failed` if it throws, then always returns `runAgentTurn(deps, id)`.
  - `main.ts` environment: `RELAY_MEDIA_DIR` (default `<dirname(RELAY_DB)>/media`), `TRANSCRIBER_URL` (unset = transcription off), `RELAY_TRANSCRIBER_LANGUAGE` (optional).

- [ ] **Step 1: Failing tests**

In `apps/api/test/engine.test.ts`, add the imports
```ts
import { eq } from 'drizzle-orm'
import { messages } from '../src/db/schema'
```
and append inside `describe('runAgentTurn', ...)`:
```ts
  it('a transcribed voice message with a handoff keyword hands off without calling the provider', async () => {
    const provider = { id: 'spy', model: null, generate: vi.fn() }
    await setup(provider as unknown as Provider)
    const { conversation, message } = receiveInbound(deps, { channel: 'widget', contactKey: 'k'.repeat(64), type: 'audio', mediaPath: 'a.webm' })
    deps.db.update(messages).set({ transcription: { status: 'ok', text: 'Quero falar com um atendente', at: 'x' } }).where(eq(messages.id, message.id)).run()
    expect((await runAgentTurn(deps, conversation.id)).outcome).toBe('transferred')
    expect(provider.generate).not.toHaveBeenCalled()
  })

  it('"agent" alone no longer hands off; "a real person" does', async () => {
    let calls = 0
    await setup({ id: 'rec', model: null, generate: async () => { calls++; return { kind: 'text', text: 'ok' } } })
    expect((await runAgentTurn(deps, ask('I am a real estate agent looking for a desk'))).outcome).toBe('replied')
    expect(calls).toBe(1)
    // Same contact key, same conversation: this is the next turn.
    expect((await runAgentTurn(deps, ask('Can I talk to a real person?'))).outcome).toBe('transferred')
    expect(calls).toBe(1)
  })
```

In `apps/api/test/demo-provider.test.ts`, add `AUDIO_FALLBACK` to the demo import (`import { DemoProvider, AUDIO_FALLBACK } from '../src/agent/providers/demo'`) and append inside `describe('DemoProvider', ...)`:
```ts
  it('searches with the spoken words of a transcribed voice message', async () => {
    expect(await run([{ role: 'user', content: '[customer audio, transcribed] What are your opening hours?' }])).toEqual({
      kind: 'tool_calls', calls: [{ id: 'demo-1', name: 'search_knowledge', input: { query: 'What are your opening hours?' } }],
    })
    expect(await run([{ role: 'user', content: '[customer audio, transcribed] Oi!' }])).toMatchObject({ kind: 'text', text: expect.stringMatching(/^Hi!/) })
  })

  it('asks the customer to type when a voice message has no transcription', async () => {
    expect(await run([{ role: 'user', content: '[audio]' }])).toEqual({ kind: 'text', text: AUDIO_FALLBACK })
  })
```

In `apps/api/test/settings.test.ts`, change the expectation of 'reads the seeded defaults' to
```ts
    expect(agentSettings(db)).toMatchObject({ turnLimit: 10, handoffKeywords: ['human', 'humano', 'atendente', 'real person', 'pessoa real'] })
```
and append inside the `describe` block:
```ts
  it('upgrades the old default keyword list, and only that list', async () => {
    const db = createDb(':memory:')
    await seed(db)
    db.update(settings).set({ value: ['human', 'agent', 'atendente', 'humano'] }).where(eq(settings.key, 'agent.handoffKeywords')).run()
    await seed(db)
    expect(agentSettings(db).handoffKeywords).toEqual(['human', 'humano', 'atendente', 'real person', 'pessoa real'])
    db.update(settings).set({ value: ['human', 'agent'] }).where(eq(settings.key, 'agent.handoffKeywords')).run()
    await seed(db)
    expect(agentSettings(db).handoffKeywords).toEqual(['human', 'agent'])
  })
```

`apps/api/test/turn.test.ts`:
```ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '../src/db/client'
import { seed } from '../src/db/seed'
import { EventBus } from '../src/core/events'
import { ChannelRegistry } from '../src/channels/types'
import { receiveInbound } from '../src/core/conversations'
import { makeTurnRunner, type TurnDeps } from '../src/agent/turn'
import type { ChatMessage, Provider } from '../src/agent/providers/types'
import { FakeTranscriber, said } from './fake-transcriber'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

async function setup(transcriber: FakeTranscriber, onTranscriberOffline?: (id: number) => void) {
  const mediaDir = mkdtempSync(join(tmpdir(), 'relay-turn-'))
  dirs.push(mediaDir)
  const db = createDb(':memory:')
  await seed(db)
  const seen: ChatMessage[][] = []
  const provider: Provider = {
    id: 'rec', model: null,
    generate: async (req) => { seen.push(structuredClone(req.messages)); return { kind: 'text', text: 'ok' } },
  }
  const deps: TurnDeps = {
    db, bus: new EventBus(), channels: new ChannelRegistry(), provider, knowledge: () => [], transcriber, mediaDir, onTranscriberOffline,
  }
  writeFileSync(join(mediaDir, 'v.webm'), 'opus')
  const { conversation } = receiveInbound(deps, { channel: 'widget', contactKey: 'k'.repeat(64), type: 'audio', mediaPath: 'v.webm', mediaMime: 'audio/webm' })
  return { run: makeTurnRunner(deps), id: conversation.id, seen }
}

describe('makeTurnRunner', () => {
  it('transcribes first, so the provider sees the transcription', async () => {
    const { run, id, seen } = await setup(new FakeTranscriber(() => said('How much is a meeting room?')))
    expect((await run(id)).outcome).toBe('replied')
    expect(seen[0]).toEqual([{ role: 'user', content: '[customer audio, transcribed] How much is a meeting room?' }])
  })

  it('reports an offline transcriber and still runs the turn with [audio]', async () => {
    const offline: number[] = []
    const { run, id, seen } = await setup(new FakeTranscriber(() => ({ ok: false, error: 'offline' })), (cid) => offline.push(cid))
    expect((await run(id)).outcome).toBe('replied')
    expect(offline).toEqual([id])
    expect(seen[0]).toEqual([{ role: 'user', content: '[audio]' }])
  })

  it('a crash in the transcription step is logged and the turn still runs', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { run, id } = await setup(new FakeTranscriber(() => { throw new Error('bug') }))
      expect((await run(id)).outcome).toBe('replied')
      expect(err).toHaveBeenCalledWith('[relay] transcription step failed', id, expect.any(Error))
    } finally {
      err.mockRestore()
    }
  })
})
```

In `apps/api/test/agent-flow.test.ts`, extend the imports:
```ts
import { vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VISITOR_HEADER } from '../src/channels/widget'
import { getConversation, listConversations } from '../src/core/conversations'
import { makeTurnRunner } from '../src/agent/turn'
import { AUDIO_FALLBACK } from '../src/agent/providers/demo'
import { OfflineRetry } from '../src/transcription/retry'
import { FakeTranscriber, said } from './fake-transcriber'
```
(merge `vi` into the existing `vitest` import), and add a second `describe` block at the end of the file:
```ts
describe('voice messages over the widget', () => {
  async function setupVoice(transcriber: FakeTranscriber, retryMs = 20) {
    const mediaDir = mkdtempSync(join(tmpdir(), 'relay-flow-'))
    const db = createDb(':memory:')
    await seed(db)
    const bus = new EventBus()
    const channels = new ChannelRegistry()
    const widget = new WidgetChannel()
    channels.register(widget)
    const knowledge = loadKnowledge(fileURLToPath(new URL('../knowledge', import.meta.url)))
    const retry = new OfflineRetry(transcriber, (id) => queue.schedule(id), retryMs)
    const run = makeTurnRunner({
      db, bus, channels, provider: new DemoProvider(), knowledge: () => knowledge, transcriber, mediaDir,
      onTranscriberOffline: (id) => retry.add(id),
    })
    const queue = new AgentQueue(run, bus)
    queue.start()
    const app = await buildServer({ db, bus, channels }, { widget, mediaDir })
    await app.ready()
    const core = { db, bus, channels }
    const upload = () => app.inject({
      method: 'POST', url: '/api/widget/audio', payload: Buffer.from('fake opus'),
      headers: { 'content-type': 'audio/webm;codecs=opus', [VISITOR_HEADER]: TOKEN },
    })
    const conversation = () => getConversation(core, listConversations(core, {})[0]!.id)!
    const done = async () => {
      retry.stop()
      queue.stop()
      await queue.drain()
      await app.close()
      rmSync(mediaDir, { recursive: true, force: true })
    }
    return { app, upload, conversation, queue, done }
  }

  it('a voice message is transcribed and answered from the transcription', async () => {
    const { app, upload, conversation, done } = await setupVoice(new FakeTranscriber(() => said('What are your opening hours?')))
    const ws = await app.injectWS(`/ws/widget?token=${TOKEN}`)
    const agentReply = new Promise<any>((resolve) => ws.on('message', (d: Buffer) => {
      const f = JSON.parse(d.toString())
      if (f.type === 'message' && f.message.sender === 'agent') resolve(f)
    }))
    expect((await upload()).statusCode).toBe(201)
    expect((await agentReply).message.text).toContain('Opening hours')
    expect(conversation().messages[0]!.transcription).toMatchObject({ status: 'ok', text: 'What are your opening hours?' })
    ws.terminate()
    await done()
  })

  it('with the transcriber offline the agent still answers, and the audio is transcribed once it is back', async () => {
    let up = false
    const transcriber = new FakeTranscriber(() => (up ? said('What are your opening hours?') : { ok: false, error: 'offline' }))
    transcriber.healthy = null
    const { upload, conversation, queue, done } = await setupVoice(transcriber)
    await upload()
    await vi.waitFor(() => expect(conversation().messages.at(-1)).toMatchObject({ sender: 'agent', text: AUDIO_FALLBACK }))
    expect(conversation().messages[0]!.transcription).toBeNull()

    up = true
    transcriber.healthy = { ok: true, model: 'fake', loaded: true, error: null }
    await vi.waitFor(() => expect(conversation().messages[0]!.transcription).toMatchObject({ status: 'ok' }), { timeout: 2000 })
    await queue.drain()
    // The agent already answered that message: the retry only fills in the transcription.
    expect(conversation().messages.filter((m) => m.sender === 'agent')).toHaveLength(1)
    await done()
  })
})
```

Run: `npm test -w apps/api` → FAIL (`../src/agent/turn` missing, `AUDIO_FALLBACK` missing, keyword expectations).

- [ ] **Step 2: Engine — shared markers, keywords on transcriptions**

In `apps/api/src/agent/engine.ts`, add after `DEFAULT_TIMEOUT_MS`:
```ts
/** How audio appears in the history sent to the provider (spec §4). */
export const AUDIO_PLACEHOLDER = '[audio]'
export const TRANSCRIBED_PREFIX = '[customer audio, transcribed] '
```
replace `contentOf` with:
```ts
/** The words of a message: its text, or the transcription of an audio message (null when there is none). */
function wordsOf(m: Message): string | null {
  if (m.type !== 'audio') return m.text
  return m.transcription?.status === 'ok' && m.transcription.text ? m.transcription.text : null
}

function contentOf(m: Message): string {
  if (m.type === 'audio') {
    const words = wordsOf(m)
    return words ? `${TRANSCRIBED_PREFIX}${words}` : AUDIO_PLACEHOLDER
  }
  return m.text ?? ''
}
```
and change the keyword check to:
```ts
  if (pending.some((m) => asksForHuman(wordsOf(m), settings.handoffKeywords))) return transfer('Customer asked for a human')
```

- [ ] **Step 3: Demo provider**

In `apps/api/src/agent/providers/demo.ts`, add the import
```ts
import { AUDIO_PLACEHOLDER, TRANSCRIBED_PREFIX } from '../engine'
```
add after `GREETING`:
```ts
export const AUDIO_FALLBACK = "Sorry, I couldn't listen to your voice message. Could you type your question?"
```
and replace the lines from `if (!user) return { kind: 'text', text: GREETING }` to the end of `generate` with:
```ts
    if (!user) return { kind: 'text', text: GREETING }
    if (user.content === AUDIO_PLACEHOLDER) return { kind: 'text', text: AUDIO_FALLBACK }
    const said = user.content.startsWith(TRANSCRIBED_PREFIX) ? user.content.slice(TRANSCRIBED_PREFIX.length) : user.content
    const q = plain(said)
    if (GREETINGS.test(q) && q.split(/\s+/).length <= 4) return { kind: 'text', text: GREETING }
    if (HANDOFF_WORDS.test(q)) {
      return { kind: 'tool_calls', calls: [{ id, name: 'transfer_to_human', input: { reason: 'Customer wants to complain, cancel or get a refund' } }] }
    }
    return { kind: 'tool_calls', calls: [{ id, name: 'search_knowledge', input: { query: said } }] }
  }
}
```

- [ ] **Step 4: Default keywords and the seed upgrade**

In `apps/api/src/db/seed.ts`, add above `DEFAULT_SETTINGS`:
```ts
/** The pre-plan-4 default: "agent" matched too much ("real estate agent"). A stored copy of exactly this list is upgraded. */
const OLD_HANDOFF_KEYWORDS = ['human', 'agent', 'atendente', 'humano']
```
set the default to
```ts
  'agent.handoffKeywords': ['human', 'humano', 'atendente', 'real person', 'pessoa real'],
```
and append at the end of `seed()`:
```ts
  const keywords = db.select().from(settings).where(eq(settings.key, 'agent.handoffKeywords')).get()
  if (keywords && JSON.stringify(keywords.value) === JSON.stringify(OLD_HANDOFF_KEYWORDS)) {
    db.update(settings).set({ value: DEFAULT_SETTINGS['agent.handoffKeywords'] }).where(eq(settings.key, 'agent.handoffKeywords')).run()
  }
```

- [ ] **Step 5: Turn runner**

`apps/api/src/agent/turn.ts`:
```ts
import { runAgentTurn, type EngineDeps, type TurnResult } from './engine'
import { transcribePending, type TranscriptionDeps } from '../transcription/pipeline'

export type TurnDeps = EngineDeps & TranscriptionDeps & { onTranscriberOffline?: (conversationId: number) => void }

/**
 * What the agent queue runs per conversation (spec §3 steps 3–4): transcribe pending voice messages, then the agent turn.
 * Transcription never blocks or breaks the turn.
 */
export function makeTurnRunner(deps: TurnDeps): (conversationId: number) => Promise<TurnResult> {
  return async (conversationId) => {
    try {
      const { offline } = await transcribePending(deps, conversationId)
      if (offline) deps.onTranscriberOffline?.(conversationId)
    } catch (err) {
      console.error('[relay] transcription step failed', conversationId, err)
    }
    return runAgentTurn(deps, conversationId)
  }
}
```

- [ ] **Step 6: Wire it in `main.ts`**

Replace `apps/api/src/main.ts` with:
```ts
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb } from './db/client'
import { seed } from './db/seed'
import { EventBus } from './core/events'
import { ChannelRegistry } from './channels/types'
import { WidgetChannel } from './channels/widget'
import { WhatsAppChannel } from './channels/whatsapp'
import { buildServer } from './server'
import { agentTimeoutMs, selectProvider } from './agent/providers'
import { loadKnowledge } from './agent/knowledge'
import { AgentQueue } from './agent/queue'
import { makeTurnRunner } from './agent/turn'
import { HttpTranscriber } from './transcription/client'
import { OfflineRetry } from './transcription/retry'

const env = (key: string) => process.env[key]?.trim() || undefined

const file = env('RELAY_DB') ?? 'data/relay.db'
mkdirSync(dirname(file), { recursive: true })
const db = createDb(file)
await seed(db)
const mediaDir = env('RELAY_MEDIA_DIR') ?? join(dirname(file), 'media')
mkdirSync(mediaDir, { recursive: true })

const bus = new EventBus()
const channels = new ChannelRegistry()
const widget = new WidgetChannel()
channels.register(widget)
channels.register(new WhatsAppChannel())

const provider = selectProvider(process.env)
const timeoutMs = agentTimeoutMs(process.env, provider)
const knowledgeDir = env('RELAY_KNOWLEDGE_DIR') ?? fileURLToPath(new URL('../knowledge', import.meta.url))
const knowledge = loadKnowledge(knowledgeDir)

const transcriberUrl = env('TRANSCRIBER_URL')
const transcriber = transcriberUrl ? new HttpTranscriber({ url: transcriberUrl, language: env('RELAY_TRANSCRIBER_LANGUAGE') }) : null
const retry = transcriber ? new OfflineRetry(transcriber, (id) => queue.schedule(id)) : null
const runTurn = makeTurnRunner({
  db, bus, channels, provider, knowledge: () => knowledge, timeoutMs, transcriber, mediaDir,
  onTranscriberOffline: (id) => retry?.add(id),
})
const queue = new AgentQueue(runTurn, bus)
queue.start()
console.log(`[relay] agent provider: ${provider.id} (${provider.model ?? 'n/a'}), timeout ${timeoutMs} ms, knowledge passages: ${knowledge.length}`)
console.log(transcriberUrl
  ? `[relay] transcription: ${transcriberUrl}, media in ${mediaDir}`
  : `[relay] transcription: off (TRANSCRIBER_URL is not set); voice messages are stored in ${mediaDir} and reach the agent as [audio]`)

const app = await buildServer({ db, bus, channels }, { widget, mediaDir })
const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' })
console.log(`[relay] api listening on :${port}`)

let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[relay] ${signal}: finishing agent turns and shutting down`)
  retry?.stop()
  queue.stop()
  await app.close()
  await queue.drain()
  process.exit(0)
}
process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))
```

(`queue` is used inside the retry callback before its declaration line; the callback only runs after the queue exists, and TypeScript allows a deferred reference inside a function.)

- [ ] **Step 7: Run tests and typecheck, then commit**

Run: `npm test -w apps/api` → PASS. `npm run typecheck -w apps/api` → clean. Quick start check: `npm run dev:api` with no variables prints `[relay] transcription: off (TRANSCRIBER_URL is not set)…`; stop it and delete the untracked `apps/api/data`.
```bash
git add apps/api
git commit -m "feat(api): transcribe before each agent turn, audio-aware demo replies and safer handoff keywords"
```

---

### Task 7: Voice in the widget

**Files:**
- Create: `apps/web/src/recorder.ts`
- Modify: `apps/web/src/components/Widget.tsx`, `apps/web/src/styles.css`
- Test: `apps/web/test/recorder.test.tsx` (new — the web Vitest config only picks up `*.test.tsx`), `apps/web/test/Widget.test.tsx`

**Interfaces:**
- Consumes (Task 4): `POST /api/widget/audio` with the recording as the body, `Content-Type` = the recording's type, header `X-Relay-Visitor: <visitor token>` → 201 `{ message: { id, sender, type, text, createdAt } }`; visitor frames carry the same shape (`text: null` for audio).
- Produces (`src/recorder.ts`):
  - `MAX_RECORDING_MS = 120_000`.
  - `type Recording = { done: Promise<Blob | null>; stop(): void; cancel(): void }` — `done` resolves with the audio when recording stops (by `stop()` or at the time limit), or `null` after `cancel()` or when nothing was recorded. The microphone is released when recording stops.
  - `canRecord(): boolean` — `MediaRecorder` exists and `navigator.mediaDevices.getUserMedia` exists.
  - `startRecording(maxMs = MAX_RECORDING_MS): Promise<Recording>` — asks for the microphone, prefers `audio/webm;codecs=opus`, then `audio/ogg;codecs=opus`, then `audio/mp4`, else the browser default. Rejects when the microphone is refused.
- Produces (`src/components/Widget.tsx`): `mergeMessages(current, incoming)` (by id, sorted by id) used for history and live frames; a "Voice" button (only when `canRecord()`) labelled "Record a voice message" / "Stop recording" with `aria-pressed`; audio bubbles read "Voice message"; no bubble for a text message without text; `aria-live="polite"` and auto-scroll on the message list; the close button is `type="button"` and cancels a recording in progress. Notices: `Microphone not available. Check the browser permission.` (alert), `Your message could not be sent.` (alert, also for a failed upload), `Sending voice message…` (status).

- [ ] **Step 1: Failing tests**

`apps/web/test/recorder.test.tsx`:
```tsx
import { vi } from 'vitest'
import { canRecord, startRecording, MAX_RECORDING_MS } from '../src/recorder'

class FakeRecorder {
  static instances: FakeRecorder[] = []
  static isTypeSupported = (t: string) => t === 'audio/webm;codecs=opus'
  state: 'inactive' | 'recording' = 'inactive'
  mimeType: string
  ondataavailable?: (e: { data: Blob }) => void
  onstop?: () => void
  constructor(public stream: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? ''
    FakeRecorder.instances.push(this)
  }
  start() { this.state = 'recording' }
  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['opus'], { type: this.mimeType }) })
    this.onstop?.()
  }
}

const track = { stop: vi.fn() }
const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }))

beforeEach(() => {
  FakeRecorder.instances = []
  track.stop.mockClear()
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('recorder', () => {
  it('can record only with MediaRecorder and a microphone API', () => {
    expect(canRecord()).toBe(true)
    vi.stubGlobal('MediaRecorder', undefined)
    expect(canRecord()).toBe(false)
  })

  it('records opus in WebM and releases the microphone when stopped', async () => {
    const rec = await startRecording()
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(FakeRecorder.instances[0]!.mimeType).toBe('audio/webm;codecs=opus')
    rec.stop()
    const blob = await rec.done
    expect(blob?.type).toBe('audio/webm;codecs=opus')
    expect(blob?.size).toBe(4)
    expect(track.stop).toHaveBeenCalled()
  })

  it('cancel() resolves with null and releases the microphone', async () => {
    const rec = await startRecording()
    rec.cancel()
    expect(await rec.done).toBeNull()
    expect(track.stop).toHaveBeenCalled()
  })

  it('stops by itself at the time limit', async () => {
    vi.useFakeTimers()
    const rec = await startRecording()
    vi.advanceTimersByTime(MAX_RECORDING_MS)
    expect(await rec.done).not.toBeNull()
  })
})
```

In `apps/web/test/Widget.test.tsx`, add at the top (after the jest-dom import):
```tsx
import { vi } from 'vitest'
vi.mock('../src/recorder', () => ({ canRecord: vi.fn(() => true), startRecording: vi.fn(), MAX_RECORDING_MS: 120_000 }))
import { startRecording } from '../src/recorder'
```
change the import of the widget module to `import { Widget, visitorToken, mergeMessages } from '../src/components/Widget'`, add `afterEach(() => vi.unstubAllGlobals())` next to the existing `beforeEach`, and append inside `describe('Widget', ...)`:
```tsx
  function openWidget() {
    render(<Widget company="Acme Coworking" />)
    fireEvent.click(screen.getByRole('button', { name: /chat with us/i }))
  }

  function recordingThatStops(blob: Blob | null) {
    let finish!: (b: Blob | null) => void
    const done = new Promise<Blob | null>((resolve) => { finish = resolve })
    vi.mocked(startRecording).mockResolvedValue({ done, stop: vi.fn(() => finish(blob)), cancel: vi.fn(() => finish(null)) })
  }

  it('records a voice message and uploads it with the visitor token', async () => {
    recordingThatStops(new Blob(['opus'], { type: 'audio/webm;codecs=opus' }))
    const fetchMock = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ message: { id: 7, sender: 'contact', type: 'audio', text: null } }) }))
    vi.stubGlobal('fetch', fetchMock)
    openWidget()
    fireEvent.click(screen.getByRole('button', { name: /record a voice message/i }))
    fireEvent.click(await screen.findByRole('button', { name: /stop recording/i }))
    expect(await screen.findByText('Voice message')).toBeInTheDocument()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/widget/audio')
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'audio/webm;codecs=opus', 'X-Relay-Visitor': visitorToken() } })
    expect(init.body).toBeInstanceOf(Blob)
  })

  it('shows an alert when the microphone is not available', async () => {
    vi.mocked(startRecording).mockRejectedValue(new Error('NotAllowedError'))
    openWidget()
    fireEvent.click(screen.getByRole('button', { name: /record a voice message/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Microphone not available. Check the browser permission.')
  })

  it('shows an alert when the upload fails', async () => {
    recordingThatStops(new Blob(['opus'], { type: 'audio/webm' }))
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 413, json: async () => ({}) })))
    openWidget()
    fireEvent.click(screen.getByRole('button', { name: /record a voice message/i }))
    fireEvent.click(await screen.findByRole('button', { name: /stop recording/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Your message could not be sent.')
  })

  it('a cancelled recording uploads nothing', async () => {
    recordingThatStops(null)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    openWidget()
    fireEvent.click(screen.getByRole('button', { name: /record a voice message/i }))
    fireEvent.click(await screen.findByRole('button', { name: /stop recording/i }))
    expect(await screen.findByRole('button', { name: /record a voice message/i })).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('merges the history with live messages by id and skips empty text bubbles', () => {
    openWidget()
    act(() => FakeSocket.last.emit({ type: 'message', message: { id: 2, sender: 'agent', type: 'text', text: 'Live reply' } }))
    act(() => FakeSocket.last.emit({ type: 'history', messages: [
      { id: 1, sender: 'contact', type: 'text', text: 'Earlier' },
      { id: 3, sender: 'system', type: 'text', text: null },
    ] }))
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Earlier', 'Live reply'])
  })

  it('mergeMessages replaces by id and keeps id order', () => {
    const a = { id: 1, sender: 'contact' as const, type: 'text' as const, text: 'a' }
    const b = { id: 2, sender: 'agent' as const, type: 'text' as const, text: 'b' }
    expect(mergeMessages([b], [a, { ...b, text: 'b2' }])).toEqual([a, { ...b, text: 'b2' }])
  })

  it('the close button does not submit anything', () => {
    openWidget()
    expect(screen.getByRole('button', { name: /close chat/i })).toHaveAttribute('type', 'button')
  })
```

Run: `npm test -w apps/web` → FAIL (`../src/recorder` cannot be resolved; no voice button).

- [ ] **Step 2: Recorder**

`apps/web/src/recorder.ts`:
```ts
/** The widget stops recording here; the API accepts up to 10 MB, far more than 2 minutes of opus. */
export const MAX_RECORDING_MS = 120_000

const PREFERRED = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']

export type Recording = {
  /** The audio when recording stops (stop() or the time limit); null after cancel() or when nothing was captured. */
  done: Promise<Blob | null>
  stop(): void
  cancel(): void
}

export function canRecord(): boolean {
  return typeof MediaRecorder !== 'undefined' && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
}

export async function startRecording(maxMs = MAX_RECORDING_MS): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const mimeType = PREFERRED.find((t) => MediaRecorder.isTypeSupported(t))
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  const chunks: Blob[] = []
  let cancelled = false
  let limit: ReturnType<typeof setTimeout> | undefined
  const done = new Promise<Blob | null>((resolve) => {
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
    recorder.onstop = () => {
      clearTimeout(limit)
      stream.getTracks().forEach((t) => t.stop())
      resolve(cancelled || chunks.length === 0 ? null : new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' }))
    }
  })
  const stop = () => { if (recorder.state !== 'inactive') recorder.stop() }
  limit = setTimeout(stop, maxMs)
  recorder.start()
  return { done, stop, cancel: () => { cancelled = true; stop() } }
}
```

- [ ] **Step 3: Widget**

Replace `apps/web/src/components/Widget.tsx` with:
```tsx
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { connectLive, type Live } from '../live'
import { canRecord, startRecording, type Recording } from '../recorder'

type WidgetMessage = { id: number; sender: 'contact' | 'agent' | 'user' | 'system'; type: 'text' | 'audio'; text: string | null; createdAt?: string }
type WidgetFrame = { type: 'history'; messages: WidgetMessage[] } | { type: 'message'; message: WidgetMessage } | { type: 'error'; code: string }
type Notice = 'connecting' | 'failed' | 'mic' | null

const KEY = 'relay.visitor'
const VISITOR_HEADER = 'X-Relay-Visitor'

let memoryToken: string | null = null

function newToken(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function visitorToken(): string {
  try {
    let t = localStorage.getItem(KEY)
    if (!t || t.length < 32) { t = newToken(); localStorage.setItem(KEY, t) }
    return t
  } catch {
    return (memoryToken ??= newToken())
  }
}

/** The reconnect history and live frames can interleave: merge by id instead of replacing. */
export function mergeMessages(current: WidgetMessage[], incoming: WidgetMessage[]): WidgetMessage[] {
  const byId = new Map(current.map((m) => [m.id, m]))
  for (const m of incoming) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => a.id - b.id)
}

async function uploadAudio(blob: Blob): Promise<WidgetMessage | null> {
  try {
    const res = await fetch('/api/widget/audio', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/webm', [VISITOR_HEADER]: visitorToken() },
      body: blob,
    })
    if (!res.ok) return null
    return ((await res.json()) as { message: WidgetMessage }).message
  } catch {
    return null
  }
}

export function Widget({ company }: { company: string }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<WidgetMessage[]>([])
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState<Notice>(null)
  const [recording, setRecording] = useState(false)
  const [sendingAudio, setSendingAudio] = useState(false)
  const liveRef = useRef<Live | null>(null)
  const recordingRef = useRef<Recording | null>(null)
  const bodyRef = useRef<HTMLOListElement | null>(null)

  useEffect(() => {
    if (!open) return
    const live = connectLive<WidgetFrame>(`/ws/widget?token=${visitorToken()}`, (frame) => {
      if (frame.type === 'error') setNotice('failed')
      if (frame.type === 'history') setMessages((m) => mergeMessages(m, frame.messages))
      if (frame.type === 'message') setMessages((m) => mergeMessages(m, [frame.message]))
    })
    liveRef.current = live
    return () => { live.stop(); liveRef.current = null }
  }, [open])

  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  useEffect(() => () => recordingRef.current?.cancel(), [])

  function send(e: FormEvent) {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    if (liveRef.current?.send(JSON.stringify({ type: 'text', text }))) { setDraft(''); setNotice(null) }
    else setNotice('connecting')
  }

  async function toggleRecording() {
    if (recordingRef.current) { recordingRef.current.stop(); return }
    let rec: Recording
    try {
      rec = await startRecording()
    } catch {
      setNotice('mic')
      return
    }
    recordingRef.current = rec
    setRecording(true)
    setNotice(null)
    const blob = await rec.done
    recordingRef.current = null
    setRecording(false)
    if (!blob) return
    setSendingAudio(true)
    const message = await uploadAudio(blob)
    setSendingAudio(false)
    if (message) setMessages((m) => mergeMessages(m, [message]))
    else setNotice('failed')
  }

  function close() {
    recordingRef.current?.cancel()
    setOpen(false)
  }

  if (!open) return <button className="widget-launcher" onClick={() => setOpen(true)}>Chat with us</button>

  return (
    <section className="widget">
      <header className="widget-head">
        <strong>{company}</strong>
        <button type="button" aria-label="Close chat" onClick={close}>×</button>
      </header>
      <ol className="widget-body" ref={bodyRef} aria-live="polite">
        {messages.filter((m) => m.type === 'audio' || m.text).map((m) => (
          <li key={m.id} className={m.sender === 'contact' ? 'w-msg w-me' : 'w-msg w-them'}>
            {m.type === 'audio' ? <span className="w-audio">Voice message</span> : m.text}
          </li>
        ))}
      </ol>
      <form aria-label="Chat" className="widget-form" onSubmit={send}>
        <input aria-label="Message" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type a message…" />
        {canRecord() && (
          <button
            type="button"
            className="w-voice"
            aria-pressed={recording}
            aria-label={recording ? 'Stop recording' : 'Record a voice message'}
            disabled={sendingAudio}
            onClick={() => void toggleRecording()}
          >
            {recording ? 'Stop' : 'Voice'}
          </button>
        )}
        <button type="submit">Send</button>
      </form>
      {notice === 'connecting' && <p role="status" className="widget-notice">Connecting… try again in a moment.</p>}
      {notice === 'failed' && <p role="alert" className="widget-notice">Your message could not be sent.</p>}
      {notice === 'mic' && <p role="alert" className="widget-notice">Microphone not available. Check the browser permission.</p>}
      {sendingAudio && <p role="status" className="widget-notice">Sending voice message…</p>}
    </section>
  )
}
```

In `apps/web/src/styles.css`, replace the `.widget { … }` rule's `height: 480px;` with `height: min(480px, calc(100vh - 40px));`, and append:
```css
.w-audio { font-style: italic; }
.w-voice[aria-pressed='true'] { background: #dc2626; color: #fff; border-color: #dc2626; }
.widget-notice { margin: 0; padding: 4px 12px 8px; font-size: 13px; color: var(--muted); }
```

- [ ] **Step 4: Run tests and typecheck, then commit**

Run: `npm test -w apps/web` → PASS. `npm run typecheck -w apps/web` → clean.
```bash
git add apps/web
git commit -m "feat(web): record and send voice messages from the widget; merge history by id"
```

---

### Task 8: Audio player and transcription in the inbox

**Files:**
- Modify: `apps/web/src/api.ts`, `apps/web/src/components/Timeline.tsx`, `apps/web/src/pages/Inbox.tsx`, `apps/web/src/styles.css`
- Test: `apps/web/test/Timeline.test.tsx` (new), `apps/web/test/Inbox.test.tsx`

**Interfaces:**
- Consumes (Tasks 4–5): `GET /api/conversations/:id/messages/:messageId/audio`; inbox frame `{ event: 'message.updated', data: { conversationId, message } }`; `transcription` = `{ status: 'ok' | 'empty' | 'failed'; text?; error?; model?; durationS?; at }` or `null`.
- Produces (`src/api.ts`): `audioUrl(conversationId: number, messageId: number): string` (a standalone export, so the `api` mock in the Inbox tests keeps working); `Message['transcription']` gains `error?: string; durationS?: number`; `InboxFrame` gains `message.updated`.
- Timeline: an audio message renders `<audio controls preload="none" src={audioUrl(…)} aria-label="Voice message">` and below it `Transcription: <text>` (ok), `No speech detected` (empty), `Transcription failed (<error>)` (failed) or `Not transcribed yet` (null).
- Inbox: a `message.updated` frame for the open conversation replaces that message by id.

- [ ] **Step 1: Failing tests**

`apps/web/test/Timeline.test.tsx`:
```tsx
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { Timeline } from '../src/components/Timeline'
import type { Message } from '../src/api'

const voice: Message = {
  id: 1, conversationId: 5, sender: 'contact', userId: null, type: 'audio', text: null,
  mediaPath: 'a.webm', mediaMime: 'audio/webm', transcription: null, createdAt: '2026-11-11T12:00:00Z',
}

describe('Timeline', () => {
  it('plays customer audio from the API and shows the transcription below it', () => {
    const { container } = render(<Timeline messages={[{ ...voice, transcription: { status: 'ok', text: 'Quanto custa uma sala?' } }]} />)
    expect(container.querySelector('audio')).toHaveAttribute('src', '/api/conversations/5/messages/1/audio')
    expect(screen.getByText('Quanto custa uma sala?')).toBeInTheDocument()
  })

  it.each([
    [null, 'Not transcribed yet'],
    [{ status: 'empty' as const }, 'No speech detected'],
    [{ status: 'failed' as const, error: 'http_422' }, 'Transcription failed (http_422)'],
  ])('shows the transcription state %j', (transcription, label) => {
    render(<Timeline messages={[{ ...voice, transcription }]} />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('renders text messages without a player', () => {
    const { container } = render(<Timeline messages={[{ ...voice, type: 'text', text: 'hello', mediaPath: null, mediaMime: null }]} />)
    expect(screen.getByText('hello')).toBeInTheDocument()
    expect(container.querySelector('audio')).toBeNull()
  })
})
```

Append inside `describe('Inbox', ...)` of `apps/web/test/Inbox.test.tsx`:
```tsx
  it('replaces a message when its transcription arrives', async () => {
    const audio = { ...detail(1, 'Ana').messages[0]!, id: 101, type: 'audio' as const, text: null, mediaPath: 'a.webm', mediaMime: 'audio/webm' }
    mocked.get.mockImplementation(async (id: number) => ({ ...detail(id, id === 1 ? 'Ana' : 'Bob'), messages: [audio] }))
    await openFirst()
    expect(await screen.findByText('Not transcribed yet')).toBeInTheDocument()
    const onFrame = vi.mocked(connectLive).mock.calls[0]![1] as (f: unknown) => void
    act(() => onFrame({ event: 'message.updated', data: { conversationId: 1, message: { ...audio, transcription: { status: 'ok', text: 'Quanto custa?' } } } }))
    expect(await screen.findByText('Quanto custa?')).toBeInTheDocument()
    expect(screen.queryByText('Not transcribed yet')).toBeNull()
  })
```

Run: `npm test -w apps/web` → FAIL (no `<audio>`, no transcription text, `message.updated` ignored).

- [ ] **Step 2: API types**

In `apps/web/src/api.ts`, change the `transcription` field of `Message` to:
```ts
  transcription: { status: 'ok' | 'empty' | 'failed'; text?: string; error?: string; model?: string; durationS?: number } | null; createdAt: string
```
add to `InboxFrame`:
```ts
  | { event: 'message.updated'; data: { conversationId: number; message: Message } }
```
and add after the `api` object:
```ts
/** The stored voice message, for the inbox audio player (cookie-authenticated). */
export const audioUrl = (conversationId: number, messageId: number) => `/api/conversations/${conversationId}/messages/${messageId}/audio`
```

- [ ] **Step 3: Timeline and Inbox**

Replace `apps/web/src/components/Timeline.tsx` with:
```tsx
import { audioUrl, type Message } from '../api'

const WHO = { contact: 'Customer', agent: 'AI agent', user: 'Team', system: 'System' } as const

function Transcript({ t }: { t: Message['transcription'] }) {
  if (!t) return <span className="msg-transcript muted">Not transcribed yet</span>
  if (t.status === 'ok') return <p className="msg-transcript"><span className="muted">Transcription: </span>{t.text}</p>
  if (t.status === 'empty') return <span className="msg-transcript muted">No speech detected</span>
  return <span className="msg-transcript muted">{`Transcription failed${t.error ? ` (${t.error})` : ''}`}</span>
}

export function Timeline({ messages }: { messages: Message[] }) {
  return (
    <ol className="timeline">
      {messages.map((m) => (
        <li key={m.id} className={`msg msg-${m.sender}`}>
          <span className="msg-who">{WHO[m.sender]}</span>
          {m.type === 'audio'
            ? (
              <>
                <audio className="msg-audio" controls preload="none" src={audioUrl(m.conversationId, m.id)} aria-label="Voice message" />
                <Transcript t={m.transcription} />
              </>
            )
            : <span className="msg-text">{m.text}</span>}
          <time className="msg-time">{new Date(m.createdAt).toLocaleTimeString()}</time>
        </li>
      ))}
    </ol>
  )
}
```

In `apps/web/src/pages/Inbox.tsx`, inside the `connectLive<InboxFrame>` callback, after the `message.created` block, add:
```tsx
    if (frame.event === 'message.updated' && frame.data.conversationId === current) {
      const { message } = frame.data
      setDetail((d) => d && d.conversation.id === message.conversationId
        ? { ...d, messages: d.messages.map((m) => (m.id === message.id ? message : m)) } : d)
    }
```

Append to `apps/web/src/styles.css`:
```css
.msg-audio { width: 260px; max-width: 100%; height: 36px; }
.msg-transcript { margin: 0; font-size: 13px; }
```

- [ ] **Step 4: Run tests and typecheck, then commit**

Run: `npm test -w apps/web` → PASS. `npm run typecheck -w apps/web` → clean.
```bash
git add apps/web
git commit -m "feat(web): audio player and live transcription in the inbox timeline"
```

---

### Task 9: Compose, docs, measured times and the end-to-end check without Docker

**Files:**
- Modify: `docker-compose.yml`, `apps/web/nginx.conf`, `.env.example`, `README.md`, `docs/superpowers/specs/2026-11-10-relay-design.md`, `docs/superpowers/plans/followups-after-plan-1.md`

- [ ] **Step 1: Compose, nginx and `.env.example`**

In `docker-compose.yml`, add to the `api` service's `environment` (after `RELAY_AGENT_TIMEOUT_MS`):
```yaml
      # Voice messages: the transcriber below, on the internal network only.
      TRANSCRIBER_URL: ${TRANSCRIBER_URL:-http://transcriber:8000}
      RELAY_TRANSCRIBER_LANGUAGE: ${RELAY_TRANSCRIBER_LANGUAGE:-}
```
add a service after `api`:
```yaml
  transcriber:
    build: { context: services/transcriber }
    environment:
      TRANSCRIBER_MODEL: ${TRANSCRIBER_MODEL:-small}
    # The model is downloaded on first start and kept here.
    volumes: [whisper-models:/models]
    # No `ports`: only the api reaches it, over the compose network. Audio never leaves the server.
    expose: ["8000"]
    restart: unless-stopped
```
and add `whisper-models:` under `volumes:` next to `relay-data:`.

In `apps/web/nginx.conf`, add as the first line inside `server { … }` (nginx's default body limit is 1 MB):
```nginx
  client_max_body_size 11m;
```

Append to `.env.example`:
```bash

# Voice messages. Whisper model for the transcriber service: tiny, base, small (default), medium, large-v3-turbo…
TRANSCRIBER_MODEL=
# Language sent to Whisper (pt, en, …) or "auto" to detect it. Empty = the service default (pt).
RELAY_TRANSCRIBER_LANGUAGE=
# Where the API finds the transcriber. Docker: leave empty (http://transcriber:8000). npm run dev:api: http://127.0.0.1:8000
TRANSCRIBER_URL=
```

Run: `docker compose config --quiet` → exits 0. If Docker is not installed, skip and say so in the task report.

- [ ] **Step 2: README**

Replace the status line with:
```markdown
> Status: plan 4 of 6 — voice messages are transcribed locally with Whisper; the agent runs on Claude, a local Ollama model, or a scripted demo provider. Next: the settings screen and knowledge base editor.
```

After the "Choosing the AI provider" section, add:
````markdown
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

<!-- BENCH -->

### Running the transcriber without Docker

```bash
cd services/transcriber
python -m venv .venv-run                      # Python 3.12 recommended
.venv-run/Scripts/python -m pip install -r requirements.txt   # Linux/macOS: .venv-run/bin/python
TRANSCRIBER_MODEL=tiny .venv-run/Scripts/python -m transcriber   # listens on 127.0.0.1:8000
```

Then start the API with `TRANSCRIBER_URL=http://127.0.0.1:8000 npm run dev:api`. The service tests need only pytest (a fake model stands in for Whisper): `python -m venv .venv && .venv/Scripts/python -m pip install -r requirements-dev.txt && .venv/Scripts/python -m pytest`.
````

In "Roadmap", remove "Local Whisper transcription · ". In "Em português", append:
```markdown
Mensagens de voz: o cliente grava um áudio no widget e um serviço Python local (`services/transcriber`, faster-whisper) transcreve o áudio sem enviá-lo para fora do servidor. A inbox mostra o player com a transcrição embaixo, e o agente responde a partir do texto. Se a transcrição falhar, o agente responde mesmo assim; se o serviço estiver fora do ar, o áudio é transcrito quando ele voltar. O modelo padrão é o `small` (troque com `TRANSCRIBER_MODEL`).
```

- [ ] **Step 3: Spec and follow-ups**

In `docs/superpowers/specs/2026-11-10-relay-design.md`:
- §5 "Service", after the `POST /transcribe` bullet, add: "`X-Language: auto` lets Whisper detect the language. While the model is loading, or if it failed to load, `POST /transcribe` answers 503."
- §5 "Client", add: "A 503 counts as `offline`. With `TRANSCRIBER_URL` unset the API does not transcribe (development without Python). Transcription runs in the agent queue before each turn, also for assigned conversations; an offline transcriber is polled on `/health` and the waiting conversations are retried when the model is loaded."
- §6 "Widget (v1)", replace "and uploaded as binary." with "and uploaded as binary with `POST /api/widget/audio` (visitor token in the `X-Relay-Visitor` header, at most 10 MB). Visitors receive messages without internal fields (no user ids, file names or transcriptions)."

Rewrite `docs/superpowers/plans/followups-after-plan-1.md` as follows (plan 4 became transcription, so the settings work moves to plan 5):
- Keep "Done in plan 2" and "Done in plan 3" as they are.
- Add `## Done in plan 4` with: "Widget history is merged by message id."; "Visitors receive a public message shape (`toVisitorMessage`): no `userId`, `mediaPath` or transcription."; "Transcriptions (and an audio player) in the inbox Timeline, updated live by `message.updated`."; "Audio is uploaded over HTTP (`POST /api/widget/audio`, 10 MB), so the WebSocket keeps its 64 KiB `maxPayload`."; "Widget UI pass: `aria-live`, auto-scroll, close button `type=\"button\"`, height capped on short viewports, no empty bubbles."; "Default handoff keywords no longer include `agent`; the seed upgrades the old default list; keywords also match transcriptions."
- Rename `## Plan 4 — settings and knowledge base` to `## Plan 5 — settings and knowledge base`, and move into it the line "Text-only Ollama models cannot call `search_knowledge`; consider putting the top passages in the system prompt for them (spec §4 'What it receives')." Delete the "default handoff keyword `agent`" line from "Found during plan 2 (for later)" (done); if that section is then empty, delete it.
- Delete `## Plan 5 — transcription and voice` (all done).
- Under `## Plan 6 — polish, CI, public demo hardening`, add: "Rate limit and per-token cap on `POST /api/widget/audio`; a retention policy for the media folder."; "CI runs the transcriber tests (`python -m pytest` in `services/transcriber`) and builds its image."; "HTTP Range support on the audio route (seeking in long recordings)."; "Compose healthcheck for the transcriber (`GET /health`)."

- [ ] **Step 4: End-to-end check without Docker**

Docker is not available on the development machine, so the real model runs directly. Use Git Bash from the repository root unless a step says PowerShell.

1. **Service tests:** `cd services/transcriber && .venv/Scripts/python -m pytest -q` → `22 passed`.
2. **Real model runtime:** faster-whisper needs wheels for ctranslate2 and PyAV, which may not exist yet for the newest Python. Try `python -m venv .venv-run && .venv-run/Scripts/python -m pip install -r requirements.txt`. If the install fails, install Python 3.12 with the Python install manager (`py install 3.12`), delete `.venv-run`, and run `py -V:3.12 -m venv .venv-run` before the same `pip install`.
3. **Start the service** (downloads `tiny`, about 75 MB): `TRANSCRIBER_MODEL=tiny .venv-run/Scripts/python -m transcriber`, in the background. Wait for `model tiny loaded`. `curl -s http://127.0.0.1:8000/health` → `{"ok": true, "model": "tiny", "loaded": true, "error": null}`.
4. **A fictional sample audio** (PowerShell; uses the Windows speech synthesizer):
   ```powershell
   Add-Type -AssemblyName System.Speech
   $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
   $s.SetOutputToWaveFile("$env:TEMP\relay-sample.wav")
   $s.Speak("Hello. What are your opening hours? And how much is a meeting room for four people on Friday afternoon?")
   $s.Dispose()
   ```
   Then (Git Bash): `curl -s -X POST -H "content-type: audio/wav" -H "x-language: auto" --data-binary @"$TEMP/relay-sample.wav" http://127.0.0.1:8000/transcribe` → JSON with `text` close to the sentence, `duration_s` around 7, and `processing_s`. Check that the service log has the `transcribed … s of audio` line and not the sentence.
5. **Limits at the HTTP level:** `curl -s -X POST -H "content-length: -1" http://127.0.0.1:8000/transcribe` → `{"error": "invalid_content_length"}` immediately.
6. **API with the real transcriber:** start `TRANSCRIBER_URL=http://127.0.0.1:8000 RELAY_TRANSCRIBER_LANGUAGE=auto npm run dev:api` in the background (log: `[relay] transcription: http://127.0.0.1:8000, media in data/media` — `data\media` on Windows). Then:
   ```bash
   TOKEN=e2e-visitor-token-0123456789-abcdefghij
   curl -s -X POST -H "content-type: audio/wav" -H "x-relay-visitor: $TOKEN" --data-binary @"$TEMP/relay-sample.wav" http://localhost:3000/api/widget/audio
   curl -s -c "$TEMP/relay-cookie" -H "content-type: application/json" -d '{"email":"demo@relay.dev","password":"relay-demo"}' http://localhost:3000/api/auth/login
   curl -s -b "$TEMP/relay-cookie" http://localhost:3000/api/conversations
   curl -s -b "$TEMP/relay-cookie" http://localhost:3000/api/conversations/<id>
   ```
   Expected: the upload answers 201 with `"type":"audio","text":null`; within a few seconds the conversation's audio message has `transcription.status: "ok"` with the sentence, and the next message is the demo agent's answer about opening hours. `curl -s -o /dev/null -w "%{http_code} %{content_type}" -b "$TEMP/relay-cookie" http://localhost:3000/api/conversations/<id>/messages/<messageId>/audio` → `200 audio/wav`.
7. **Offline and back:** stop the transcriber. Upload the sample again with another token (`TOKEN=e2e-visitor-token-offline-0123456789-abc`). The new conversation gets the demo answer "Sorry, I couldn't listen to your voice message…" and its audio has `transcription: null`. Start the transcriber again; within about 15 s after `model tiny loaded`, that audio has `status: "ok"` and there is still exactly one agent message in the conversation.
8. **Measured times for the README:** with the API stopped, run `.venv-run/Scripts/python -m transcriber.bench "$TEMP/relay-sample.wav" tiny base small --language auto` (downloads `base` and `small`; `large-v3-turbo` is optional and about 1.6 GB). Replace the `<!-- BENCH -->` line in the README with: one sentence naming the CPU (the first line of the output), the sample ("a 7-second English sample made with the Windows speech synthesizer"), and the settings (`int8`, `beam_size=1`, after one warm-up run); then the table rows from the output without the Text column (`| Model | Audio | Load | Transcription |`). Use only measured numbers. If the model runtime could not be installed in step 2, leave the marker, report the step as blocked, and do not invent numbers.
9. **Browser (manual, optional):** with `npm run dev:web` also running, open http://localhost:5173/demo in a browser with a microphone, record a short question, and check that the inbox (http://localhost:5173) shows the player, then the transcription. Report whether this was done.
10. Stop every server; delete the untracked `apps/api/data`, `services/transcriber/.venv-run` stays ignored. Confirm `git status` shows only the intended changes.

- [ ] **Step 5: Full suite and commit**

Run from the root: `npm test` and `npm run typecheck` → PASS / clean; `cd services/transcriber && .venv/Scripts/python -m pytest -q` → PASS. Confirm `git grep -n "sk-ant-"` finds nothing and no audio file is staged (`git status --short | grep -E "\.(wav|webm)$"` prints nothing).
```bash
git add docker-compose.yml apps/web/nginx.conf .env.example README.md docs/superpowers/specs/2026-11-10-relay-design.md docs/superpowers/plans/followups-after-plan-1.md
git commit -m "docs: voice messages, transcriber compose service, measured times and plan-4 follow-ups"
```

---

## Self-review

- **Spec coverage.** §3 steps 3–4 → Tasks 5–6 (transcribe before the turn, `message.updated`). §5 service → Tasks 1–2 (`/health`, `/transcribe`, model loaded once, one at a time, `TRANSCRIBER_MODEL`, 25 MB, 400 on a bad `Content-Length`, memory only, no text in logs, internal network in Task 9) and the README table (Task 9). §5 client → Task 3 (never throws, error codes) and Task 5 (40 s per audio and per turn, `offline` not stored and retried, other failures `failed`, `empty`, `[audio]`). §6 widget voice (`MediaRecorder`, webm/opus, binary upload) → Tasks 4 and 7. §7 `messages.type/media_path/transcription`, `data/media` in a volume → Tasks 4, 6, 9. §9 audio player with the transcription below → Task 8. §11 transcriber client with a fake, pytest with a fake model → Tasks 1–3, 5.
- **Follow-ups.** The whole former "transcription and voice" list → Tasks 4, 7, 8; handoff keyword `agent` → Task 6; Ollama text-only passages and the demo provider's first-hit answer → explained under "Decisions beyond the spec" (item 9).
- **Names used across tasks.** `Transcriber`, `HttpTranscriber`, `TranscribeResult`, `TranscriberHealth` (Task 3) → Tasks 5–6; `mediaFile`, `MAX_AUDIO_BYTES`, `VISITOR_HEADER`, `buildServer(…, { widget, mediaDir })` (Task 4) → Tasks 5–6; `transcribePending`, `TranscriptionDeps`, `OfflineRetry`, `FakeTranscriber`, `said` (Task 5) → Task 6; `AUDIO_PLACEHOLDER`, `TRANSCRIBED_PREFIX`, `AUDIO_FALLBACK`, `makeTurnRunner` (Task 6) → Task 6 tests and `main.ts`; `audioUrl`, `message.updated` frame (Task 8) ↔ the API route and event of Tasks 4–5.
