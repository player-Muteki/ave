"""Offline executable checks for the worker sampling kernel (stdlib only).

Run: python3 plugins/video-editor/test/test_sampling_map.py
"""
import json
import sys
from fractions import Fraction
from hashlib import sha256
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "worker"))
import sampling_map as sm  # noqa: E402

CHECKS = 0


def ok(cond):
    global CHECKS
    if not cond:
        raise AssertionError("check failed")
    CHECKS += 1


def raises(fn, match):
    global CHECKS
    try:
        fn()
    except ValueError as exc:
        if match not in str(exc):
            raise AssertionError(f"wrong error: {exc!r} (want {match!r})")
        CHECKS += 1
        return
    raise AssertionError(f"expected ValueError containing {match!r}")


DIGEST = "a" * 64
CLOCK = Fraction(1, 10)  # each tick = 0.1s; a 10-tick frame = 1s


def contiguous():
    return (sm.FrameSpan(0, 10), sm.FrameSpan(10, 10), sm.FrameSpan(20, 10))


def test_one_sample_per_second():
    m = sm.sample_shot(contiguous(), CLOCK, Fraction(1), DIGEST)
    ok(m.sample_to_source == (0, 1, 2))
    ok(m.source_to_samples() == ((0,), (1,), (2,)))
    ok(m.source_frames == contiguous())


def test_two_samples_per_second():
    m = sm.sample_shot(contiguous(), CLOCK, Fraction(2), DIGEST)
    ok(m.sample_to_source == (0, 0, 1, 1, 2, 2))
    ok(m.source_to_samples() == ((0, 1), (2, 3), (4, 5)))


def test_validate_output_grid():
    m = sm.sample_shot(contiguous(), CLOCK, Fraction(2), DIGEST)
    good = tuple(sm.FrameSpan(5 * i, 5) for i in range(6))
    m.validate_output(good, CLOCK)  # no raise
    ok(True)
    raises(lambda: m.validate_output(good[:-1], CLOCK), "frame count")
    bad = tuple(sm.FrameSpan(5 * i, 6) for i in range(6))
    raises(lambda: m.validate_output(bad, CLOCK), "PTS or duration")


def test_rebind_unchanged():
    identity = sm.sample_shot(contiguous(), CLOCK, Fraction(1), DIGEST)
    ok(identity.rebind_unchanged(contiguous(), CLOCK) == contiguous())
    duplicated = sm.sample_shot(contiguous(), CLOCK, Fraction(2), DIGEST)
    good = tuple(sm.FrameSpan(5 * i, 5) for i in range(6))
    raises(lambda: duplicated.rebind_unchanged(good, CLOCK), "explicit time mapping")


def test_sample_shot_rejections():
    raises(lambda: sm.sample_shot(contiguous(), CLOCK, Fraction(1), "xyz"), "digest")
    raises(lambda: sm.sample_shot((), CLOCK, Fraction(1), DIGEST), "shot and exact positive clocks")
    raises(lambda: sm.sample_shot(contiguous(), Fraction(0), Fraction(1), DIGEST), "positive clocks")
    gap = (sm.FrameSpan(0, 10), sm.FrameSpan(20, 10))
    raises(lambda: sm.sample_shot(gap, CLOCK, Fraction(1), DIGEST), "overlap or leave a gap")
    # 30 ticks * 1/10 * 3 = 9 samples (> integral but fine); force fractional grid instead:
    raises(lambda: sm.sample_shot(contiguous(), CLOCK, Fraction(1, 4), DIGEST), "integral working grid")


def test_sample_index_shot():
    doc = {
        "schemaVersion": "video.presentation-index/v2",
        "sourceSha256": "c" * 64,
        "streams": [{"streamUid": "stream:0", "streamIndex": 0, "timeBase": {"num": "1", "den": "10"}}],
        "frames": [{"stream_index": 0, "media_type": "video", "pts": str(p), "duration": "10"} for p in (0, 10, 20)],
    }
    raw = json.dumps(doc).encode()
    digest = sha256(raw).hexdigest()
    m = sm.sample_index_shot(raw, index_sha256=digest, source_sha256="c" * 64,
                             stream_uid="stream:0", first=0, stop=3, rate=Fraction(1))
    ok(m.sample_to_source == (0, 1, 2))
    ok(m.presentation_index_sha256 == digest)
    raises(lambda: sm.sample_index_shot(raw, index_sha256="d" * 64, source_sha256="c" * 64,
                                        stream_uid="stream:0", first=0, stop=3, rate=Fraction(1)),
           "digest mismatch")
    raises(lambda: sm.sample_index_shot(raw, index_sha256=digest, source_sha256="c" * 64,
                                        stream_uid="stream:0", first=0, stop=5, rate=Fraction(1)),
           "outside indexed video")
    raises(lambda: sm.sample_index_shot(raw, index_sha256=digest, source_sha256="c" * 64,
                                        stream_uid="stream:0", first=2, stop=1, rate=Fraction(1)),
           "invalid source frame range")


def main():
    for fn in [
        test_one_sample_per_second,
        test_two_samples_per_second,
        test_validate_output_grid,
        test_rebind_unchanged,
        test_sample_shot_rejections,
        test_sample_index_shot,
    ]:
        fn()
    print(f"PASS: {CHECKS} sampling-map checks")


if __name__ == "__main__":
    main()