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
