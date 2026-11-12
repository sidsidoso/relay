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
