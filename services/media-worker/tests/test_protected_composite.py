import numpy as np
import pytest

from protected_composite import composite_rgb24


def test_protected_composite_preserves_unmasked_pixels_bitwise():
    source = np.full((8, 8, 3), 40, dtype=np.uint8)
    candidate = np.full((8, 8, 3), 220, dtype=np.uint8)
    approved = np.zeros((8, 8), dtype=bool)
    approved[2:5, 2:5] = True
    alpha = np.zeros((8, 8), dtype=np.uint8)
    alpha[2:5, 2:5] = 255

    out = composite_rgb24(source, candidate, approved, alpha)
    assert np.array_equal(out[~approved], source[~approved])
    assert np.array_equal(out[approved], candidate[approved])


def test_protected_composite_rejects_alpha_outside_approved_support():
    source = np.zeros((4, 4, 3), dtype=np.uint8)
    candidate = np.full((4, 4, 3), 255, dtype=np.uint8)
    approved = np.zeros((4, 4), dtype=bool)
    alpha = np.zeros((4, 4), dtype=np.uint8)
    alpha[0, 0] = 128

    with pytest.raises(ValueError, match="approved support"):
        composite_rgb24(source, candidate, approved, alpha)
