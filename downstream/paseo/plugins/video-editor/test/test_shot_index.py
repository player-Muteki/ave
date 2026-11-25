"""Offline executable checks for the hard-cut shot kernel (numpy + scenedetect).

Run: python3 plugins/video-editor/test/test_shot_index.py
"""
import sys
from fractions import Fraction
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "worker"))
import shot_index as si  # noqa: E402

CHECKS = 0
TB = Fraction(1, 10)


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


def frame(pts, duration=10, value=0):
    return si.Observation(pts, duration, np.full((4, 4, 3), value, np.uint8))


def test_time_base_validation():
    raises(lambda: si.detect_shots([frame(0)], Fraction(0)), "positive source time base")
    raises(lambda: si.detect_shots([frame(0)], 1), "positive source time base")


def test_empty_and_timing_validation():
    raises(lambda: si.detect_shots([], TB), "no decoded frames")
    raises(lambda: si.detect_shots([si.Observation(0.0, 10, np.zeros((4, 4, 3), np.uint8))], TB),
           "integer source PTS")
    raises(lambda: si.detect_shots([si.Observation(0, 0, np.zeros((4, 4, 3), np.uint8))], TB),
           "positive duration")
    raises(lambda: si.detect_shots([frame(10), frame(10)], TB), "non-increasing")


def test_frame_geometry_validation():
    bad = si.Observation(0, 10, np.zeros((4, 4, 3), np.float32))
    raises(lambda: si.detect_shots([bad], TB), "decoded uint8 BGR")
    changed = si.Observation(10, 10, np.zeros((8, 8, 3), np.uint8))
    raises(lambda: si.detect_shots([frame(0), changed], TB), "frame geometry changed")


def test_uniform_frames_form_one_shot():
    frames = [frame(p) for p in (0, 10, 20, 30, 40)]
    shots = si.detect_shots(frames, TB)
    ok(len(shots) == 1)
    ok(shots[0] == si.Shot(first_frame=0, stop_frame=5, start_pts=0, stop_pts=50))


def main():
    for fn in [
        test_time_base_validation,
        test_empty_and_timing_validation,
        test_frame_geometry_validation,
        test_uniform_frames_form_one_shot,
    ]:
        fn()
    print(f"PASS: {CHECKS} shot-index checks")


if __name__ == "__main__":
    main()