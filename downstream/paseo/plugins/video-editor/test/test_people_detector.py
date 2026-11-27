"""Offline executable checks for the people detection / association kernel.

Run: python3 plugins/video-editor/test/test_people_detector.py
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "worker"))
import people_detector as pd  # noqa: E402

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


def frame(value=0, pts=0, shape=(48, 64, 3)):
    return pd.Observation(pts, 10, np.full(shape, value, np.uint8))


def det(x, y, w=0.2, h=0.3, score=0.8):
    return pd.Detection(pd.Box(x, y, w, h), score)


def test_validation():
    raises(lambda: pd._checked_frames([]), "no decoded frames")
    raises(lambda: pd._checked_frames([frame(pts=0), frame(pts=0)]), "non-increasing")
    raises(lambda: pd._checked_frames([frame(pts=0, shape=(4, 4))]), "decoded uint8 BGR")
    raises(lambda: pd.detect_people([frame()], backend="magic"), "unknown detector backend")
    raises(lambda: pd.detect_people([frame()], backend="yolox-onnx"), "model path")


def test_decode_yolox():
    width = height = 32
    strides = (8, 16, 32)
    anchors = sum((height // stride) * (width // stride) for stride in strides)
    raw = np.zeros((1, anchors, 7), np.float32)
    index = 1 * 4 + 2  # grid row 1, column 2 on the stride-8 grid
    raw[0, index, 0] = 0.5
    raw[0, index, 1] = 0.25
    raw[0, index, 2] = np.log(0.2)
    raw[0, index, 3] = np.log(0.3)
    raw[0, index, 4] = 0.9
    raw[0, index, 5] = 0.8
    raw[0, index, 6] = 0.1  # wrong class must not survive
    detections = pd.decode_yolox(raw, width, height, strides=strides)
    ok(len(detections) == 1)
    box = detections[0].box
    ok(abs(box.x - (20 - 0.8) / 32) < 1e-4)
    ok(abs(box.y - (10 - 1.2) / 32) < 1e-4)
    ok(abs(box.w - 1.6 / 32) < 1e-4)
    ok(abs(box.h - 2.4 / 32) < 1e-4)
    ok(abs(detections[0].score - 0.72) < 1e-5)


def test_decode_xwyx_and_nms():
    raw = np.array(
        [[[0.1, 0.1, 0.4, 0.5, 0.9], [0.12, 0.11, 0.41, 0.51, 0.7], [0.6, 0.6, 0.9, 0.9, 0.1]]],
        np.float32,
    )
    detections = pd.decode_xyxy(raw, score_threshold=0.3, iou_threshold=0.4)
    ok(len(detections) == 1)
    ok(abs(detections[0].box.x - 0.1) < 1e-6)
    ok(abs(detections[0].box.w - 0.3) < 1e-6)


def test_associate_keeps_ids_across_short_occlusion():
    left = [det(0.05 + 0.03 * i, 0.2) for i in range(4)]
    right = [det(0.60 - 0.03 * i, 0.55) for i in range(4)]
    per_frame = [[left[i], right[i]] for i in range(4)]
    per_frame[1] = [right[1]]  # left disappears for one frame
    per_frame[2] = [left[2], right[2]]
    tracks = pd.associate(per_frame, max_missing=2)
    ok(len(tracks) == 2)
    ok(tracks[0].observed == 3)
    ok(tracks[0].missed == 1)
    ok(tracks[0].first_frame == 0 and tracks[0].last_frame == 3)


def test_associate_starts_new_track_after_long_gap():
    per_frame = [[det(0.1, 0.1)] for _ in range(2)]
    per_frame += [[] for _ in range(3)]
    per_frame += [[det(0.1, 0.1)] for _ in range(2)]
    tracks = pd.associate(per_frame, max_missing=1)
    ok(len(tracks) == 2)
    ok(tracks[0].observed == 2 and tracks[1].observed == 2)
    ok(tracks[0].track_id != tracks[1].track_id)


def test_associate_drops_single_frame_tracks():
    per_frame = [[det(0.1, 0.1)], [det(0.7, 0.7)], [det(0.1, 0.1)]]
    tracks = pd.associate(per_frame)
    ok(all(track.observed >= 2 for track in tracks))


def test_metrics():
    track = pd.Track("t1", 0, 3, {0: pd.Box(0.3, 0.3, 0.2, 0.4), 1: pd.Box(0.32, 0.3, 0.2, 0.4),
                                  2: pd.Box(0.34, 0.3, 0.2, 0.4), 3: pd.Box(0.36, 0.3, 0.2, 0.4)})
    track.missed = 0
    metrics = pd.track_metrics(track, 64, 48)
    ok(abs(metrics["areaRatio"] - 0.08) < 1e-6)
    ok(metrics["centrality"] > 0.9)
    ok(0.0 < metrics["motion"] < 0.1)
    ok(metrics["occlusion"] == 0.0)
    ok(metrics["visibility"] == 1.0)


def test_evidence_sampling_is_bounded_and_ordered():
    track = pd.Track("t1", 0, 40, {i: pd.Box(0.1, 0.1, 0.2, 0.3) for i in range(41)})
    evidence = pd._evidence_frames(track, limit=12)
    ok(len(evidence) == 12)
    ok(evidence == sorted(evidence))
    ok(evidence[0] == 0 and evidence[-1] == 40)


def test_letterbox_roundtrip():
    image = np.zeros((48, 64, 3), np.float32)
    canvas, scale, dx, dy = pd.letterbox(image, 64, 64)
    ok(canvas.shape == (64, 64, 3))
    ok(abs(scale - 1.0) < 1e-6)
    ok(dx == 0 and dy == 0)
    original = [det(0.3, 0.4, 0.2, 0.2, 0.9)]
    mapped = pd._unletterbox(original, 0.5)
    ok(abs(mapped[0].box.x - 0.6) < 1e-6)
    ok(abs(mapped[0].box.w - 0.4) < 1e-6)
    ok(mapped[0].box.x + mapped[0].box.w <= 1.0 + 1e-6)


def main():
    test_validation()
    test_decode_yolox()
    test_decode_xwyx_and_nms()
    test_associate_keeps_ids_across_short_occlusion()
    test_associate_starts_new_track_after_long_gap()
    test_associate_drops_single_frame_tracks()
    test_metrics()
    test_evidence_sampling_is_bounded_and_ordered()
    test_letterbox_roundtrip()
    print(f"PASS: {CHECKS} people detector checks")


if __name__ == "__main__":
    main()
