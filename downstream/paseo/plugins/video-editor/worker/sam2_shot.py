"""Track one selected object in a single shot's private, numbered JPEG frames."""
from dataclasses import dataclass
from math import isfinite
from pathlib import Path

import numpy as np
from PIL import Image
import torch


@dataclass(frozen=True)
class Point:
    x: float
    y: float
    foreground: bool


@dataclass(frozen=True)
class FramePrompt:
    frame: int
    points: tuple[Point, ...]


def track_shot(predictor, frames: Path, count: int, prompts: list[FramePrompt], *, label_anchor=None):
    """Yield (shot-local frame index, uint8 0/255 mask) in propagation order.

    The caller owns the directory and binds its frames to the presentation index.
    Consume the entire iterator before publishing a candidate mask revision.
    """
    if (not prompts and label_anchor is None) or type(count) is not int or count <= 0:
        raise ValueError("a nonempty shot and a prompt are required")
    for prompt in prompts:
        if type(prompt.frame) is not int or not 0 <= prompt.frame < count:
            raise ValueError("anchor outside shot")
        if not any(p.foreground for p in prompt.points):
            raise ValueError("a foreground point is required")
    # SAM2 sorts JPEG filenames numerically and silently compacts gaps. Check the
    # complete shot before binding any prompt or mask to a frame index.
    paths = sorted(p for p in frames.iterdir() if p.suffix.lower() in {".jpeg", ".jpg"})
    indices = [int(p.stem) for p in paths]
    if sorted(indices) != list(range(count)):
        raise ValueError("shot frames must be numbered from zero without gaps")
    sizes = set()
    for path in paths:
        with Image.open(path) as image:
            sizes.add(image.size)
    if len(sizes) != 1:
        raise ValueError("shot frame sizes differ")
    width, height = sizes.pop()
    if label_anchor is not None:
        anchor, label = label_anchor
        if (prompts or type(anchor) is not int or not 0 <= anchor < count or
                label.shape != (height, width) or label.dtype != np.uint8 or
                np.any((label != 0) & (label != 255)) or not label.any()):
            raise ValueError("invalid approved anchor label")
    for prompt in prompts:
        for point in prompt.points:
            if (type(point.foreground) is not bool or not isfinite(point.x) or not isfinite(point.y)
                    or not 0 <= point.x < width or not 0 <= point.y < height):
                raise ValueError("invalid prompt in shot pixel coordinates")

    # Keep torch's thread-local inference/autocast scopes inside model calls.
    # A generator suspended at yield must not change its caller's torch mode.
    def infer(call, *args, **kwargs):
        with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
            return call(*args, **kwargs)

    state = infer(predictor.init_state, video_path=str(frames), offload_video_to_cpu=True)
    if (state["num_frames"], state["video_width"], state["video_height"]) != (count, width, height):
        raise RuntimeError("predictor geometry does not match shot")
    for prompt in prompts:
        infer(predictor.add_new_points_or_box, state, frame_idx=prompt.frame, obj_id=1,
              points=np.array([(p.x, p.y) for p in prompt.points], dtype=np.float32),
              labels=np.array([p.foreground for p in prompt.points], dtype=np.int32),
              clear_old_points=True)
    if label_anchor is None:
        anchor = min(p.frame for p in prompts)
    else:
        infer(predictor.add_new_mask, state, frame_idx=anchor, obj_id=1, mask=label != 0)
    for reverse in (False, True):
        if reverse and anchor == 0:
            break
        result = predictor.propagate_in_video(state, start_frame_idx=anchor, reverse=reverse)
        expected = range(anchor, -1, -1) if reverse else range(anchor, count)
        for idx in expected:
            item = infer(next, result, None)
            if item is None:
                raise RuntimeError("missing tracked frame")
            frame, objects, logits = item
            if frame != idx or list(objects) != [1] or tuple(logits.shape) != (1, 1, height, width):
                raise RuntimeError("mask does not match requested object or frame")
            if not torch.isfinite(logits).all().item():
                raise RuntimeError("invalid mask logits")
            if not (reverse and idx == anchor):
                # The predictor resamples its conditioning mask internally. The
                # reviewed source raster remains authoritative on the anchor.
                if label_anchor is not None and idx == anchor:
                    yield idx, label.copy()
                else:
                    yield idx, (logits[0, 0] > 0).to(torch.uint8).cpu().numpy() * 255
        if infer(next, result, None) is not None:
            raise RuntimeError("extra tracked frame")
