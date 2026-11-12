"""python -m transcriber — env: TRANSCRIBER_MODEL (small), TRANSCRIBER_HOST (127.0.0.1), TRANSCRIBER_PORT (8000)."""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Callable

from .engine import Engine
from .server import make_server

log = logging.getLogger("transcriber")

MAX_DELAY_S = 60.0


def _env(key: str, default: str) -> str:
    return os.environ.get(key, "").strip() or default


def load_with_retry(
    engine: Engine, *, attempts: int = 5, first_delay: float = 5.0, sleep: Callable[[float], None] = time.sleep
) -> bool:
    """Loads the model, retrying a failed load (a download can fail transiently). True once loaded."""
    delay = first_delay
    for attempt in range(1, attempts + 1):
        started = time.monotonic()
        log.info("loading model %s, attempt %d of %d (the first run downloads it)", engine.model_name, attempt, attempts)
        engine.load()
        if engine.error is None:
            log.info("model %s loaded in %.1f s", engine.model_name, time.monotonic() - started)
            return True
        log.error("model %s failed to load: %s", engine.model_name, engine.error)
        if attempt < attempts:
            log.info("retrying in %.0f s", delay)
            sleep(delay)
            delay = min(delay * 2, MAX_DELAY_S)
    return False


def _load_or_exit(engine: Engine) -> None:
    if not load_with_retry(engine):
        log.error("giving up on model %s; exiting so the container is restarted", engine.model_name)
        os._exit(1)  # from a thread: sys.exit would only end the thread


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    engine = Engine(_env("TRANSCRIBER_MODEL", "small"))
    host = _env("TRANSCRIBER_HOST", "127.0.0.1")
    port = int(_env("TRANSCRIBER_PORT", "8000"))
    server = make_server(engine, host, port)
    threading.Thread(target=_load_or_exit, args=(engine,), daemon=True).start()
    log.info("listening on %s:%d", host, port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
