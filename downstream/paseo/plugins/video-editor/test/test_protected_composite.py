"""Offline executable checks for the protected composite kernel (numpy only).

Run: python3 plugins/video-editor/test/test_protected_composite.py
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "worker"))
import protected_composite as pc  # noqa: E402

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


def test_zero_alpha_restores_source():
    source = np.full((2, 2, 3), 10, np.uint8)
    candidate = np.full((2, 2, 3), 200, np.uint8)
    out = pc.composite_rgb24(source, candidate, np.ones((2, 2), bool), np.zeros((2, 2), np.uint8))
    ok(np.array_equal(out, source))


def test_full_alpha_uses_candidate():
    source = np.full((2, 2, 3), 10, np.uint8)
    candidate = np.full((2, 2, 3), 200, np.uint8)
    out = pc.composite_rgb24(source, candidate, np.ones((2, 2), bool), np.full((2, 2), 255, np.uint8))
    ok(np.array_equal(out, candidate))


def test_partial_alpha_blends():
    source = np.zeros((1, 1, 3), np.uint8)
    candidate = np.full((1, 1, 3), 255, np.uint8)
    out = pc.composite_rgb24(source, candidate, np.ones((1, 1), bool), np.full((1, 1), 128, np.uint8))
    ok(np.array_equal(out, np.full((1, 1, 3), 128, np.uint8)))


def test_feather_beyond_support_rejected():
    source = np.zeros((2, 2, 3), np.uint8)
    candidate = np.zeros((2, 2, 3), np.uint8)
    alpha = np.zeros((2, 2), np.uint8)
    alpha[0, 0] = 10
    raises(lambda: pc.composite_rgb24(source, candidate, np.zeros((2, 2), bool), alpha),
           "feather extends beyond")


def test_input_validation():
    source = np.zeros((2, 2, 3), np.uint8)
    candidate = np.zeros((2, 2, 3), np.uint8)
    approved = np.ones((2, 2), bool)
    alpha = np.zeros((2, 2), np.uint8)
    raises(lambda: pc.composite_rgb24(source.astype(np.float32), candidate, approved, alpha), "non-empty RGB24")
    raises(lambda: pc.composite_rgb24(source, np.zeros((3, 3, 3), np.uint8), approved, alpha), "does not match")
    raises(lambda: pc.composite_rgb24(source, candidate, np.ones((2, 2), np.uint8), alpha), "boolean mask")
    raises(lambda: pc.composite_rgb24(source, candidate, approved, np.zeros((2, 2), np.float32)), "8-bit mask")


def main():
    for fn in [
        test_zero_alpha_restores_source,
        test_full_alpha_uses_candidate,
        test_partial_alpha_blends,
        test_feather_beyond_support_rejected,
        test_input_validation,
    ]:
        fn()
    print(f"PASS: {CHECKS} protected-composite checks")


if __name__ == "__main__":
    main()