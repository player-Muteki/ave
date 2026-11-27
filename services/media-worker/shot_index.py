"""CPU hard-cut analysis over decoded BGR frames paired with exact source ticks.

This kernel has no file, subprocess, model or approval interface. The caller owns
both decoding and the source presentation index; it must supply presentation order.
"""
from collections import deque
from dataclasses import dataclass
from fractions import Fraction
from typing import Iterable

import numpy as np
from scenedetect.common import FrameTimecode
from scenedetect.detectors import AdaptiveDetector


@dataclass(frozen=True)
class Observation:
    pts: int
    duration: int
    bgr: np.ndarray


@dataclass(frozen=True)
class Shot:
    first_frame: int
    stop_frame: int
    start_pts: int
    stop_pts: int


def detect_shots(frames: Iterable[Observation], time_base: Fraction) -> list[Shot]:
    """Return half-open intervals, in frame ordinals and in the given stream's ticks."""
    if not isinstance(time_base, Fraction) or time_base <= 0:
        raise ValueError("positive source time base required")
    detector = AdaptiveDetector(window_width=2, min_scene_len=0)
    recent = deque(maxlen=detector.event_buffer_length + 1)
    starts = []
    last_pts = None
    shape = None
    for ordinal, frame in enumerate(frames):
        if type(frame.pts) is not int or type(frame.duration) is not int or frame.duration <= 0:
            raise ValueError("integer source PTS and positive duration required")
        if last_pts is not None and frame.pts <= last_pts:
            raise ValueError("non-increasing source presentation timestamps")
        if frame.bgr.dtype != np.uint8 or frame.bgr.ndim != 3 or frame.bgr.shape[2] != 3 or min(frame.bgr.shape[:2]) < 1:
            raise ValueError("expected a decoded uint8 BGR frame")
        if shape is not None and frame.bgr.shape != shape:
            raise ValueError("frame geometry changed")
        shape = frame.bgr.shape
        if ordinal == 0:
            starts.append((ordinal, frame.pts))
        recent.append((ordinal, frame.pts))
        # The detector's unit-rate clock is an ordinal lookup key only. Never use it for seconds.
        for cut in detector.process_frame(FrameTimecode(ordinal, fps=1.0), frame.bgr):
            at = dict(recent).get(cut.frame_num)
            if at is None or cut.frame_num <= starts[-1][0]:
                raise ValueError("detector returned an invalid buffered frame")
            starts.append((cut.frame_num, at))
        last_pts = frame.pts
        stop = (ordinal + 1, frame.pts + frame.duration)
    if not starts:
        raise ValueError("no decoded frames")
    return [Shot(first, end, pts, end_pts) for (first, pts), (end, end_pts)
            in zip(starts, [*starts[1:], stop])]
