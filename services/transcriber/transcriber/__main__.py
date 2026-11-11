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
