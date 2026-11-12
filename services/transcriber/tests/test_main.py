from transcriber.__main__ import load_with_retry
from transcriber.engine import Engine


def flaky(failures):
    calls = []

    def loader(name, device, compute_type):
        calls.append(name)
        if len(calls) <= failures:
            raise OSError("network down")
        return object()

    return loader, calls


def test_retries_until_the_model_loads():
    loader, calls = flaky(2)
    engine = Engine("tiny", loader=loader)
    sleeps = []
    assert load_with_retry(engine, attempts=5, first_delay=1.0, sleep=sleeps.append)
    assert engine.loaded and engine.error is None
    assert len(calls) == 3
    assert sleeps == [1.0, 2.0]


def test_gives_up_after_the_last_attempt():
    loader, calls = flaky(99)
    engine = Engine("tiny", loader=loader)
    sleeps = []
    assert not load_with_retry(engine, attempts=3, first_delay=1.0, sleep=sleeps.append)
    assert len(calls) == 3
    assert sleeps == [1.0, 2.0]
    assert engine.error.startswith("OSError")


def test_delays_are_capped_at_a_minute():
    loader, _ = flaky(99)
    sleeps = []
    load_with_retry(Engine("tiny", loader=loader), attempts=5, first_delay=40.0, sleep=sleeps.append)
    assert sleeps == [40.0, 60.0, 60.0, 60.0]
