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
