"""Composite one aligned SDR RGB24 frame in working-space code values, before encoding."""

import numpy as np


def composite_rgb24(source: np.ndarray, candidate: np.ndarray,
                    approved_region: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Black alpha restores source; positive alpha is allowed only inside the approved support.

    SamplingMap alignment and conversion to the same color/coordinate space belong to the caller.
    The approved support is boolean, not the model's predicted mask. Never grow it to fit alpha.
    """
    if source.dtype != np.uint8 or source.ndim != 3 or source.shape[2] != 3 or not source.size:
        raise ValueError("source must be a non-empty RGB24 frame")
    if candidate.shape != source.shape or candidate.dtype != np.uint8:
        raise ValueError("candidate does not match the source frame")
    if approved_region.dtype != np.bool_ or approved_region.shape != source.shape[:2]:
        raise ValueError("approved support must be a boolean mask in source coordinates")
    if alpha.dtype != np.uint8 or alpha.shape != approved_region.shape:
        raise ValueError("alpha must be an 8-bit mask in source coordinates")
    edit = alpha != 0
    if np.any(edit & ~approved_region):
        raise ValueError("feather extends beyond the approved support")
    result = source.copy()
    # Integer weights total 255: even white-on-white plus the rounding bias fits uint16.
    weight = alpha[edit, None].astype(np.uint16)
    result[edit] = (source[edit] * (255 - weight) + candidate[edit] * weight + 127) // 255
    return result
