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
