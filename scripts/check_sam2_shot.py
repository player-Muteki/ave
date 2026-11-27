"""Exercise a pinned SAM2.1 worker on two shots with independent pixel truth.

Run in a CUDA-enabled SAM2 Python environment with ffmpeg on PATH, for example:
  python scripts/check_sam2_shot.py --source /path/to/clean/sam2 \
    --profile tiny --weights /path/to/sam2.1_hiera_tiny.pt --output /new/e07-tiny
The pinned source's README links the official checkpoints. All outputs are local.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

import numpy as np
from PIL import Image
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "services/media-worker"))
from sam2_shot import FramePrompt, Point, track_shot

SOURCE_REV = "2b90b9f5ceec907a1c18123530e92e794ad901a4"
PROFILES = {
    "tiny": ("sam2.1_hiera_t", "7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69"),
    "small": ("sam2.1_hiera_s", "6d1aa6f30de5c92224f8172114de081d104bbd23dd9dc5c58996f0cad5dc4d38"),
}
WIDTH, HEIGHT, COUNT, ANCHOR = 320, 192, 9, 4


def sha(path):
    with path.open("rb") as f:
        digest = hashlib.sha256()
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
        return digest.hexdigest()


def fixture(shot, idx):
    y, x = np.ogrid[:HEIGHT, :WIDTH]
    circle = (x - (70 + 7 * idx)) ** 2 + (y - 94) ** 2 <= 35 ** 2
    rectangle = (abs(x - (240 - 4 * idx)) <= 22) & (abs(y - 100) <= 35)
    frame = np.empty((HEIGHT, WIDTH, 3), dtype=np.uint8)
    frame[:] = (42, 57, 74) if shot == 0 else (116, 123, 133)
    frame[circle] = (225, 164, 52)
    frame[rectangle] = (35, 128, 74)
    if shot == 0 and 5 <= idx <= 7:
        occluder = (x >= 113) & (x <= 123) & (y >= 50) & (y <= 148)
        frame[occluder] = (157, 54, 78)
        circle = circle & ~occluder
    return frame, circle if shot == 0 else rectangle


def media(*args, data=None):
    return subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-xerror", *args],
                          input=data, capture_output=True, check=True, timeout=60).stdout


def check_bedroom(predictor, source, output):
    # The upstream notebook annotates the shorts, then refines the same object
    # with a second positive click on the shirt. No ground-truth mask is supplied.
    frames = output / "bedroom32"
    frames.mkdir()
    for i in range(32):
        name = f"{i:05d}.jpg"
        (frames / name).symlink_to(source / "notebooks/videos/bedroom" / name)
    first = FramePrompt(0, (Point(210, 350, True),))
    updated = FramePrompt(0, first.points + (Point(250, 220, True),))
    before = dict(track_shot(predictor, frames, 32, [first]))
    after = dict(track_shot(predictor, frames, 32, [first, updated]))
    replay = dict(track_shot(predictor, frames, 32, [first, updated]))
    assert all(np.array_equal(after[i], replay[i]) for i in range(32))
    assert before[0][220, 250] == 0 and after[0][220, 250] == 255
    panels = []
    for i in (0, 15, 31):
        with Image.open(frames / f"{i:05d}.jpg") as frame:
            pixels = np.array(frame.convert("RGB"))
        for mask in (before[i], after[i]):
            overlay = pixels.copy()
            target = mask != 0
            overlay[target] = overlay[target] // 2 + np.array([95, 12, 49], np.uint8)
            panel = Image.fromarray(overlay)
            panel.thumbnail((440, 260))
            panels.append(panel)
    width, height = panels[0].size
    sheet = Image.new("RGB", (2 * width, 3 * height))
    for index, panel in enumerate(panels):
        sheet.paste(panel, (index % 2 * width, index // 2 * height))
    sheet.save(output / "bedroom-correction.jpg", quality=94)
    return {"frames": 32, "rawMaskPixelsBeforeAfter": [
        [int(np.count_nonzero(before[i])), int(np.count_nonzero(after[i]))] for i in (0, 15, 31)
    ]}


def run(source, weights, output, profile, bedroom):
    config, weights_sha = PROFILES[profile]
    revision = subprocess.check_output(["git", "-C", source, "rev-parse", "HEAD"], text=True).strip()
    dirty = subprocess.check_output(["git", "-C", source, "status", "--porcelain"], text=True)
    if revision != SOURCE_REV or dirty or sha(weights) != weights_sha:
        raise ValueError("SAM2 source or weight digest does not match pinned profile")
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise RuntimeError("SAM2 BF16 check requires a compatible CUDA GPU")
    sys.path.insert(0, str(source))
    from sam2.build_sam import build_sam2_video_predictor

    output.mkdir(parents=True, exist_ok=False)
    raw = b"".join(fixture(s, i)[0].tobytes() for s in range(2) for i in range(COUNT))
    clip = output / "source.mkv"
    media("-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", f"{WIDTH}x{HEIGHT}",
          "-framerate", "9", "-i", "pipe:0", "-c:v", "ffv1", "-flags:v", "+bitexact",
          "-fflags", "+bitexact", str(clip), data=raw)
    source_hash = sha(clip)
    decoded = media("-i", str(clip), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1")
    assert decoded == raw, "lossless source decode mismatch"
    rgb = np.frombuffer(decoded, np.uint8).reshape(2, COUNT, HEIGHT, WIDTH, 3)
    torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()
    predictor = build_sam2_video_predictor(f"configs/sam2.1/{config}.yaml", str(weights))
    # The optional native connected-components extension is outside this profile.
    predictor.fill_hole_area = 0
    shots = []
    review = []
    for s in range(2):
        frames = output / f"shot-{s}"
        frames.mkdir()
        for i, frame in enumerate(rgb[s]):
            Image.fromarray(frame).save(frames / f"{i:04d}.jpg", quality=95)
        circle_center, rect_center = 70 + 7 * ANCHOR, 240 - 4 * ANCHOR
        prompts = [FramePrompt(ANCHOR, (Point(circle_center, 94, s == 0),
                                        Point(rect_center, 100, s == 1)))]
        if s == 0:
            prompts.append(FramePrompt(6, (Point(97, 94, True), Point(135, 94, True),
                                           Point(118, 94, False))))
        tracking_start = time.perf_counter()
        masks = dict(track_shot(predictor, frames, COUNT, prompts))
        tracking_seconds = time.perf_counter() - tracking_start
        replay = dict(track_shot(predictor, frames, COUNT, prompts))
        assert all(np.array_equal(replay[i], masks[i]) for i in range(COUNT)), "prompt replay mismatch"
        assert set(masks) == set(range(COUNT))
        if torch.is_inference_mode_enabled():
            raise AssertionError("worker leaked inference mode to its caller")
        rows = []
        for i in range(COUNT):
            mask = masks[i]
            truth = fixture(s, i)[1]
            actual = mask != 0
            iou = np.count_nonzero(actual & truth) / np.count_nonzero(actual | truth)
            assert iou >= 0.90, f"shot {s} frame {i} IoU {iou:.3f}"
            mask_path = output / f"mask-{s}-{i:04d}.png"
            Image.fromarray(mask).save(mask_path)
            with Image.open(mask_path) as recovered:
                assert np.array_equal(np.asarray(recovered), mask)
            rows.append({"sourceFrame": s * COUNT + i, "maskSha256": sha(mask_path), "iou": iou})
            overlay = rgb[s, i].copy()
            overlay[actual] = overlay[actual] // 2 + np.array([90, 20, 75], dtype=np.uint8)
            review.append(overlay.tobytes())
        shots.append({"trackingSeconds": tracking_seconds, "prompts": [
            {"sourceFrame": s * COUNT + p.frame, "points": [vars(pt) for pt in p.points]}
            for p in prompts], "frames": rows})
    elapsed = time.perf_counter() - started
    media("-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", f"{WIDTH}x{HEIGHT}",
          "-framerate", "9", "-i", "pipe:0", "-c:v", "libx264", "-pix_fmt", "yuv420p",
          str(output / "mask-review.mp4"), data=b"".join(review))
    media("-i", str(output / "mask-review.mp4"), "-f", "null", "-")
    assert sha(clip) == source_hash
    report = {"sourceSha256": source_hash, "sourceRevision": revision, "weightSha256": weights_sha,
              "config": config, "fillHoleArea": 0, "precision": "bf16",
              "gpu": torch.cuda.get_device_name(), "torch": torch.__version__,
              "cuda": torch.version.cuda, "elapsedSeconds": elapsed,
              "peakAllocatedBytes": torch.cuda.max_memory_allocated(), "shots": shots}
    if bedroom:
        report["bedroom"] = check_bedroom(predictor, source, output)
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({**report, "shots": len(shots),
                      "minIoU": min(f["iou"] for shot in shots for f in shot["frames"])}))


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--source", type=Path, required=True, help="clean pinned SAM2 checkout")
    cli.add_argument("--profile", choices=PROFILES, default="tiny")
    cli.add_argument("--weights", type=Path, required=True, help="pinned checkpoint for the profile")
    cli.add_argument("--output", type=Path, required=True, help="new directory for evidence")
    cli.add_argument("--bedroom", action="store_true", help="also replay the upstream real-video correction")
    args = cli.parse_args()
    run(args.source.resolve(), args.weights.resolve(), args.output.resolve(), args.profile, args.bedroom)
