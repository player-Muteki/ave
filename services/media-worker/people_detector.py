"""CPU people detection and cross-frame track association.

The kernel never decodes media: frames arrive as uint8 BGR arrays with exact
source ticks, the same contract as shot_index.py. Two detection backends:

- ``yolox-onnx``: caller supplies an Apache-2.0 licensed YOLOX/RT-DETR ONNX
  model; this kernel only preprocesses, decodes and NMSes. Weights are never
  downloaded or bundled.
- ``hog``: OpenCV's built-in HOG + SVM people detector when the local OpenCV
  build still ships it (reported by ``support()``, no weights).

Track association, role-agnostic metrics and evidence sampling are pure numpy so
the daemon can run them on CPU before asking a human which person to remove.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

import numpy as np


@dataclass(frozen=True)
class Observation:
    pts: int
    duration: int
    bgr: np.ndarray


@dataclass(frozen=True)
class Box:
    x: float
    y: float
    w: float
    h: float

    def iou(self, other: "Box") -> float:
        left = max(self.x, other.x)
        top = max(self.y, other.y)
        right = min(self.x + self.w, other.x + other.w)
        bottom = min(self.y + self.h, other.y + other.h)
        if right <= left or bottom <= top:
            return 0.0
        overlap = (right - left) * (bottom - top)
        union = self.w * self.h + other.w * other.h - overlap
        return overlap / union if union > 0 else 0.0


@dataclass(frozen=True)
class Detection:
    box: Box
    score: float


@dataclass
class Track:
    track_id: str
    first_frame: int
    last_frame: int
    boxes: dict[int, Box] = field(default_factory=dict)
    scores: dict[int, float] = field(default_factory=dict)
    coast: int = 0
    missed: int = 0

    @property
    def observed(self) -> int:
        return len(self.boxes)

    @property
    def span(self) -> int:
        return self.last_frame - self.first_frame + 1


def support() -> dict[str, Any]:
    """Report which backends this interpreter can actually run."""
    out: dict[str, Any] = {}
    try:
        import cv2  # noqa: F401

        out["opencv"] = True
        out["hog"] = hasattr(cv2, "HOGDescriptor") and hasattr(
            cv2, "HOGDescriptor_getDefaultPeopleDetector"
        )
    except Exception:
        out["opencv"] = False
        out["hog"] = False
    try:
        import onnxruntime  # noqa: F401

        out["onnxruntime"] = True
    except Exception:
        out["onnxruntime"] = False
    return out


def _checked_frames(observations: Iterable[Observation]) -> list[Observation]:
    frames = list(observations)
    if not frames:
        raise ValueError("no decoded frames")
    shape = None
    last = None
    for frame in frames:
        if type(frame.pts) is not int or type(frame.duration) is not int or frame.duration <= 0:
            raise ValueError("integer source PTS and positive duration required")
        if last is not None and frame.pts <= last:
            raise ValueError("non-increasing source presentation timestamps")
        if (
            frame.bgr.dtype != np.uint8
            or frame.bgr.ndim != 3
            or frame.bgr.shape[2] != 3
            or min(frame.bgr.shape[:2]) < 1
        ):
            raise ValueError("expected a decoded uint8 BGR frame")
        if shape is not None and frame.bgr.shape != shape:
            raise ValueError("frame geometry changed")
        shape = frame.bgr.shape
        last = frame.pts
    return frames


def _resize_bilinear(image: np.ndarray, width: int, height: int) -> np.ndarray:
    """Deterministic bilinear resize without an OpenCV dependency."""
    source_h, source_w = image.shape[:2]
    if source_w == width and source_h == height:
        return image.astype(np.float32, copy=False)
    xs = (np.arange(width, dtype=np.float32) + 0.5) * (source_w / width) - 0.5
    ys = (np.arange(height, dtype=np.float32) + 0.5) * (source_h / height) - 0.5
    xs = np.clip(xs, 0, source_w - 1)
    ys = np.clip(ys, 0, source_h - 1)
    x0 = np.floor(xs).astype(np.int32)
    y0 = np.floor(ys).astype(np.int32)
    x1 = np.minimum(x0 + 1, source_w - 1)
    y1 = np.minimum(y0 + 1, source_h - 1)
    wx = (xs - x0)[None, :, None]
    wy = (ys - y0)[:, None, None]
    image = image.astype(np.float32)
    top = image[y0][:, x0] * (1 - wx) + image[y0][:, x1] * wx
    bottom = image[y1][:, x0] * (1 - wx) + image[y1][:, x1] * wx
    return top * (1 - wy) + bottom * wy


def letterbox(image: np.ndarray, width: int, height: int) -> tuple[np.ndarray, float, int, int]:
    """Resize preserving aspect ratio, pad right/bottom, return (image, scale, dx, dy)."""
    source_h, source_w = image.shape[:2]
    scale = min(width / source_w, height / source_h)
    resized_w = max(1, int(round(source_w * scale)))
    resized_h = max(1, int(round(source_h * scale)))
    resized = _resize_bilinear(image, resized_w, resized_h)
    canvas = np.full((height, width, 3), 114, np.float32)
    canvas[:resized_h, :resized_w] = resized
    return canvas, scale, 0, 0


def _nms(detections: Sequence[Detection], threshold: float) -> list[Detection]:
    ordered = sorted(detections, key=lambda item: item.score, reverse=True)
    kept: list[Detection] = []
    for candidate in ordered:
        if all(candidate.box.iou(other.box) <= threshold for other in kept):
            kept.append(candidate)
    return kept


def decode_yolox(
    raw: np.ndarray,
    input_width: int,
    input_height: int,
    strides: Sequence[int] = (8, 16, 32),
    score_threshold: float = 0.3,
    iou_threshold: float = 0.45,
    class_index: int = 0,
) -> list[Detection]:
    """Decode YOLOX raw heads ``[1, N, 5 + classes]`` to normalized boxes.

    Column order is ``cx, cy, w, h, objectness, cls...``. Centers are offsets
    inside their stride grid and sizes are ``exp(w) * stride`` (YOLOX default).
    Only the configured person class survives; boxes are clipped to the input.
    """
    if raw.ndim != 3 or raw.shape[0] != 1:
        raise ValueError("expected a [1, N, 5 + classes] YOLOX output")
    channels = raw.shape[2]
    if channels < 6 or class_index >= channels - 5:
        raise ValueError("YOLOX output has no requested class column")
    anchor_count = sum(
        ((input_height + stride - 1) // stride) * ((input_width + stride - 1) // stride)
        for stride in strides
    )
    if raw.shape[1] != anchor_count:
        raise ValueError(f"expected {anchor_count} anchors, got {raw.shape[1]}")
    rows: list[tuple[float, list[float]]] = []
    offset = 0
    for stride in strides:
        grid_h = (input_height + stride - 1) // stride
        grid_w = (input_width + stride - 1) // stride
        block = raw[0, offset : offset + grid_h * grid_w]
        if block.shape[0] != grid_h * grid_w:
            raise ValueError("stride grid mismatch")
        gx, gy = np.meshgrid(np.arange(grid_w, dtype=np.float32), np.arange(grid_h, dtype=np.float32))
        centers_x = (block[:, 0] + gx.reshape(-1)) * stride
        centers_y = (block[:, 1] + gy.reshape(-1)) * stride
        widths = np.exp(block[:, 2]) * stride
        heights = np.exp(block[:, 3]) * stride
        objectness = block[:, 4]
        scores = objectness * block[:, 5 + class_index]
        for index in np.nonzero(scores >= score_threshold)[0]:
            cx, cy, w, h = (
                float(centers_x[index]),
                float(centers_y[index]),
                float(widths[index]),
                float(heights[index]),
            )
            rows.append(
                (
                    float(scores[index]),
                    [
                        max(0.0, (cx - w / 2) / input_width),
                        max(0.0, (cy - h / 2) / input_height),
                        min(1.0, (cx + w / 2) / input_width),
                        min(1.0, (cy + h / 2) / input_height),
                    ],
                )
            )
        offset += grid_h * grid_w
    boxes = [
        Detection(Box(rect[0], rect[1], max(0.0, rect[2] - rect[0]), max(0.0, rect[3] - rect[1])), score)
        for score, rect in rows
    ]
    return _nms(boxes, iou_threshold)


def decode_xyxy(
    raw: np.ndarray,
    score_threshold: float = 0.3,
    iou_threshold: float = 0.45,
) -> list[Detection]:
    """Decode already-normalized ``[1, N, 5]`` outputs (``x1, y1, x2, y2, score``)."""
    if raw.ndim != 3 or raw.shape[0] != 1 or raw.shape[2] < 5:
        raise ValueError("expected a [1, N, 5] normalized detection output")
    rows = [
        Detection(
            Box(
                max(0.0, min(1.0, float(row[0]))),
                max(0.0, min(1.0, float(row[1]))),
                max(0.0, min(1.0, float(row[2])) - max(0.0, min(1.0, float(row[0])))),
                max(0.0, min(1.0, float(row[3])) - max(0.0, min(1.0, float(row[1])))),
            ),
            float(row[4]),
        )
        for row in raw[0]
        if float(row[4]) >= score_threshold
    ]
    return _nms(rows, iou_threshold)


def _hungarian_like_match(iou_rows: np.ndarray, threshold: float) -> list[tuple[int, int]]:
    """Greedy one-to-one matches above threshold, highest IoU first (deterministic)."""
    pairs: list[tuple[float, int, int]] = []
    for track_index in range(iou_rows.shape[0]):
        for detection_index in range(iou_rows.shape[1]):
            value = float(iou_rows[track_index, detection_index])
            if value >= threshold:
                pairs.append((value, track_index, detection_index))
    pairs.sort(key=lambda item: (-item[0], item[1], item[2]))
    used_tracks: set[int] = set()
    used_detections: set[int] = set()
    matches: list[tuple[int, int]] = []
    for _, track_index, detection_index in pairs:
        if track_index in used_tracks or detection_index in used_detections:
            continue
        used_tracks.add(track_index)
        used_detections.add(detection_index)
        matches.append((track_index, detection_index))
    return matches


def associate(
    detections_per_frame: Sequence[Sequence[Detection]],
    iou_threshold: float = 0.3,
    max_missing: int = 2,
) -> list[Track]:
    """Greedy IoU association with coasting; short tracks are dropped."""
    tracks: list[Track] = []
    active: list[Track] = []
    for frame_index, detections in enumerate(detections_per_frame):
        if active:
            iou_rows = np.zeros((len(active), len(detections)), np.float32)
            for track_index, track in enumerate(active):
                last_box = track.boxes[track.last_frame]
                for detection_index, detection in enumerate(detections):
                    iou_rows[track_index, detection_index] = last_box.iou(detection.box)
            matches = _hungarian_like_match(iou_rows, iou_threshold)
        else:
            matches = []
        matched_tracks = {track_index for track_index, _ in matches}
        matched_detections = {detection_index for _, detection_index in matches}
        for track_index, detection_index in matches:
            track = active[track_index]
            detection = detections[detection_index]
            track.boxes[frame_index] = detection.box
            track.scores[frame_index] = detection.score
            track.last_frame = frame_index
            track.coast = 0
        survivors: list[Track] = []
        for track_index, track in enumerate(active):
            if track_index in matched_tracks:
                survivors.append(track)
                continue
            track.coast += 1
            track.missed += 1
            if track.coast <= max_missing:
                survivors.append(track)
        for detection_index, detection in enumerate(detections):
            if detection_index in matched_detections:
                continue
            track = Track(
                track_id=f"t{len(tracks) + 1}",
                first_frame=frame_index,
                last_frame=frame_index,
                boxes={frame_index: detection.box},
                scores={frame_index: detection.score},
            )
            tracks.append(track)
            survivors.append(track)
        active = survivors
    return [track for track in tracks if track.observed >= 2]


def _evidence_frames(track: Track, limit: int = 12) -> list[int]:
    frames = sorted(track.boxes)
    if len(frames) <= limit:
        return frames
    positions = np.linspace(0, len(frames) - 1, limit)
    return [frames[int(round(position))] for position in positions]


def track_metrics(track: Track, frame_width: int, frame_height: int) -> dict[str, float]:
    """Visibility, area, centrality, motion and occlusion without any role guess."""
    boxes = track.boxes
    areas = [box.w * box.h for box in boxes.values()]
    area_ratio = float(np.median(areas))
    centers = np.array(
        [[box.x + box.w / 2, box.y + box.h / 2] for box in boxes.values()], dtype=np.float64
    )
    mean_center = centers.mean(axis=0)
    distance = float(np.hypot(mean_center[0] - 0.5, mean_center[1] - 0.5))
    centrality = max(0.0, min(1.0, 1.0 - distance / 0.7071))
    if len(centers) > 1:
        steps = np.linalg.norm(np.diff(centers, axis=0), axis=1)
        motion = float(np.clip(np.mean(steps) / 0.7071, 0.0, 1.0))
    else:
        motion = 0.0
    occlusion = max(0.0, min(1.0, track.missed / track.span))
    return {
        "areaRatio": area_ratio,
        "centrality": centrality,
        "motion": motion,
        "occlusion": occlusion,
        "visibility": max(0.0, min(1.0, track.observed / track.span)),
    }


def detect_people_candidates(
    observations: Iterable[Observation],
    backend: str = "hog",
    model_path: str | None = None,
    input_width: int = 640,
    input_height: int = 640,
    output_format: str = "yolox",
    strides: Sequence[int] = (8, 16, 32),
    score_threshold: float = 0.3,
    iou_threshold: float = 0.3,
) -> dict[str, Any]:
    """Run a detector over decoded frames and return role-agnostic track candidates.

    This is the worker-facing public entry point. ``model_path`` is required for ``yolox-onnx``; the file is opened read-only
    by onnxruntime. No download, no network, no cache write.
    """
    frames = _checked_frames(observations)
    height, width = frames[0].bgr.shape[:2]
    if backend == "hog":
        import cv2

        if not hasattr(cv2, "HOGDescriptor"):
            raise ValueError("this OpenCV build has no HOGDescriptor")
        hog = cv2.HOGDescriptor()
        hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
        detections_per_frame: list[list[Detection]] = []
        for frame in frames:
            rects, weights = hog.detectMultiScale(
                frame.bgr, winStride=(8, 8), padding=(8, 8), scale=1.05
            )
            detections = [
                Detection(
                    Box(rect[0] / width, rect[1] / height, rect[2] / width, rect[3] / height),
                    float(weight),
                )
                for rect, weight in zip(rects, weights.flatten())
                if float(weight) >= 0.0
            ]
            detections_per_frame.append(detections)
    elif backend == "yolox-onnx":
        if not model_path:
            raise ValueError("yolox-onnx requires a caller-supplied model path")
        import onnxruntime as ort

        session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
        input_name = session.get_inputs()[0].name
        detections_per_frame = []
        for frame in frames:
            canvas, scale, _, _ = letterbox(frame.bgr, input_width, input_height)
            rgb = canvas[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255.0
            raw = session.run(None, {input_name: np.ascontiguousarray(rgb)})[0]
            if output_format == "yolox":
                decoded = decode_yolox(
                    raw,
                    input_width,
                    input_height,
                    strides=strides,
                    score_threshold=score_threshold,
                    iou_threshold=iou_threshold,
                )
            elif output_format == "xyxy":
                decoded = decode_xyxy(raw, score_threshold, iou_threshold)
            else:
                raise ValueError(f"unknown ONNX output format: {output_format}")
            detections_per_frame.append(_unletterbox(decoded, scale))
    else:
        raise ValueError(f"unknown detector backend: {backend}")

    tracks = associate(detections_per_frame, iou_threshold=0.3)
    return {
        "backend": backend,
        "frameWidth": width,
        "frameHeight": height,
        "frames": len(frames),
        "tracks": [
            {
                "trackId": track.track_id,
                "firstFrame": track.first_frame,
                "lastFrame": track.last_frame,
                "evidenceFrames": _evidence_frames(track),
                "box": _median_box(track),
                "confidence": float(np.mean(list(track.scores.values()))),
                **track_metrics(track, width, height),
            }
            for track in tracks
        ],
    }


# Keep the earlier internal name as a compatibility alias for existing callers.
detect_people = detect_people_candidates


def _median_box(track: Track) -> dict[str, float]:
    boxes = np.array([[b.x, b.y, b.w, b.h] for b in track.boxes.values()], dtype=np.float64)
    median = np.median(boxes, axis=0)
    return {
        "x": float(median[0]),
        "y": float(median[1]),
        "width": float(median[2]),
        "height": float(median[3]),
    }


def _unletterbox(detections: list[Detection], scale: float) -> list[Detection]:
    """Map letterboxed normalized boxes back to the original frame."""
    if scale <= 0:
        raise ValueError("positive letterbox scale required")
    out: list[Detection] = []
    for detection in detections:
        box = detection.box
        out.append(
            Detection(
                Box(
                    max(0.0, min(1.0, box.x / scale)),
                    max(0.0, min(1.0, box.y / scale)),
                    max(0.0, min(1.0 - box.x / scale, box.w / scale)),
                    max(0.0, min(1.0 - box.y / scale, box.h / scale)),
                ),
                detection.score,
            )
        )
    return out
