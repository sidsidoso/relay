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
