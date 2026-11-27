"""Run E08 offline with pinned VACE weights and the output of check_sam2_shot.py."""
import argparse
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "services/media-worker"))
from protected_composite import composite_rgb24
from vace_shot import VaceCanvas, generate_shot
from vace_model import digest, verify_model

CANVAS = VaceCanvas((320, 192), (832, 480))
PROMPT = ("A bright cobalt blue polished ceramic ball moving slowly to the right, "
          "on a dark slate background. Static camera, flat clean composition, green rectangle on the right.")
NEGATIVE = "yellow, orange ball, shaky camera, text, lettering, blurry"
SEED = 732021
STEPS = 20


def media(*args, data=None):
    return subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-xerror", *args],
                          input=data, stdout=subprocess.PIPE, check=True, timeout=90).stdout


def prepare(sample):
    e07 = json.loads((sample / "report.json").read_bytes())
    clip = sample / "source.mkv"
    if digest(clip) != e07["sourceSha256"]:
        raise ValueError("E07 source hash mismatch")
    raw = media("-i", str(clip), "-map", "0:v:0", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1")
    source = np.frombuffer(raw, np.uint8).reshape(18, 192, 320, 3)
    # E07 fixture authorizes the visible orange disk only; the occluder stays protected.
    allowed = np.all(source[:9] == (225, 164, 52), axis=-1)
    controls, masks, alpha = [], [], []
    rows = e07["shots"][0]["frames"]
    if len(rows) != 9:
        raise ValueError("expected the nine-frame first shot")
    for i, row in enumerate(rows):
        path = sample / f"mask-0-{i:04d}.png"
        if row["sourceFrame"] != i or digest(path) != row["maskSha256"]:
            raise ValueError("mask is not bound to its source frame")
        with Image.open(path) as mask:
            control, label, weight = CANVAS.condition(source[i], np.asarray(mask), allowed[i])
        if not weight.any():
            raise ValueError(f"empty edit region in E07 frame {i}")
        controls.append(control)
        masks.append(label)
        alpha.append(weight)
    return source, allowed, controls, masks, np.stack(alpha)


def encode_rgb(path, frames, size, audio=None):
    stream = ["-f", "rawvideo", "-pix_fmt", "rgb24", "-video_size", size, "-framerate", "9", "-i", "pipe:0"]
    if audio is not None:
        stream += ["-i", str(audio), "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-ar", "48000"]
    media(*stream, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "9", "-threads:v", "1",
          str(path), data=frames.tobytes())
    media("-i", str(path), "-map", "0", "-f", "null", "-")


def probe_frames(path):
    result = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_frames",
                             "-of", "json", str(path)], capture_output=True, check=True, timeout=60)
    return json.loads(result.stdout)


def check_pts(probe, count):
    video = probe["streams"][0]
    ticks = Fraction(video["time_base"])
    pts = [frame["pts"] * ticks for frame in probe["frames"] if frame["media_type"] == "video"]
    if pts != [Fraction(i, 9) for i in range(count)]:
        raise ValueError("unexpected video frame timing")


def verify_delivery(path):
    probe = probe_frames(path)
    video, audio = probe["streams"]
    if ((video["codec_name"], video["width"], video["height"], video["start_pts"]) != ("h264", 320, 192, 0)
            or (audio["codec_name"], audio["sample_rate"], audio["start_pts"]) != ("aac", "48000", 0)):
        raise ValueError("unexpected output stream or start PTS")
    for stream in (video, audio):
        if stream["duration_ts"] * Fraction(stream["time_base"]) != 2:
            raise ValueError("output stream length changed")
    check_pts(probe, 18)
    rgb = media("-i", str(path), "-map", "0:v", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1")
    pcm = media("-i", str(path), "-map", "0:a", "-f", "s16le", "pipe:1")
    return np.frombuffer(rgb, np.uint8).reshape(18, 192, 320, 3), hashlib.sha256(pcm).hexdigest()


def save_conditions(out, controls, masks):
    folder = out / "conditions"
    folder.mkdir()
    hashes = {}
    for i, (control, mask) in enumerate(zip(controls, masks, strict=True)):
        for kind, image in (("video", control), ("mask", mask)):
            path = folder / f"{kind}-{i:04d}.png"
            image.save(path)
            hashes[str(path.relative_to(out))] = digest(path)
    return hashes


def save_review(out, source, frames, decoded):
    sheet = Image.new("RGB", (3 * 320, 3 * 216))
    labels = ImageDraw.Draw(sheet)
    for row, i in enumerate((0, 4, 7)):
        tiles = (("Source", source[i]), ("VACE", CANVAS.restore(frames[i])), ("Export", decoded[i]))
        for col, (label, rgb) in enumerate(tiles):
            x, y = col * 320, row * 216
            labels.text((x + 5, y + 4), f"{label} | frame {i}", fill="white")
            sheet.paste(Image.fromarray(rgb), (x, y + 24))
    sheet.save(out / "review.png")


def shot_metrics(decoded, alpha):
    blue, temporal = [], []
    # The E07 disk translates exactly seven pixels right per frame. Compare
    # visible pixels of the same surface across adjacent frames, excluding occlusion.
    shift = 7
    for i, frame in enumerate(decoded[:9].astype(np.int16)):
        support = alpha[i] != 0
        colors = frame[support]
        blue.append(float(np.mean((colors[:, 2] > colors[:, 0] + 20) & (colors[:, 2] > colors[:, 1] + 10))))
        if i > 0:
            common = support[:, shift:] & (alpha[i-1, :, :-shift] != 0)
            previous = decoded[i-1, :, :-shift].astype(np.int16)
            temporal.append(float(np.abs(frame[:, shift:][common] - previous[common]).mean()))
    return {"blueFraction": blue, "motionAlignedMeanRgbDifference": temporal}


def evaluate(out, sample, frames, source, allowed, alpha):
    encode_rgb(out / "candidate.mp4", np.stack([np.asarray(frame) for frame in frames]), "832x480")
    candidate = probe_frames(out / "candidate.mp4")
    video, = candidate["streams"]
    if (video["width"], video["height"], video["codec_name"], Fraction(video["avg_frame_rate"])) != (832, 480, "h264", 9):
        raise ValueError("unexpected candidate geometry, codec or frame rate")
    check_pts(candidate, 9)
    final = source.copy()
    for i, frame in enumerate(frames):
        final[i] = composite_rgb24(source[i], CANVAS.restore(frame), allowed[i], alpha[i])
    protected = np.ones(source.shape[:3], dtype=bool)
    protected[:9] = alpha == 0
    if not np.array_equal(final[protected], source[protected]):
        raise ValueError("pre-encoding protected pixels changed")
    # E07 is silent. Attach a known two-second PCM fixture before either render,
    # so the export and the no-op reference carry exactly the same source audio.
    av = out / "source-with-audio.mkv"
    media("-i", str(sample / "source.mkv"), "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
          "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "pcm_s16le", str(av))
    av_hash = digest(av)
    encode_rgb(out / "noop.mp4", source, "320x192", av)
    encode_rgb(out / "composite.mp4", final, "320x192", av)
    # A deterministic, independently recolored frame sequence provides a simple
    # temporal control with the same shape, occluder, source audio and encoder.
    framewise = source.copy()
    framewise[:9][alpha != 0] = (35, 79, 185)
    encode_rgb(out / "framewise.mp4", framewise, "320x192", av)
    reference, reference_audio = verify_delivery(out / "framewise.mp4")
    base, base_audio = verify_delivery(out / "noop.mp4")
    decoded, final_audio = verify_delivery(out / "composite.mp4")
    if digest(av) != av_hash or final_audio != base_audio or reference_audio != base_audio:
        raise ValueError("source or delivered audio differs from no-op control")
    save_review(out, source, frames, decoded)
    error = np.abs(decoded[protected].astype(np.int16) - base[protected].astype(np.int16))
    metrics = {name: shot_metrics(frames, alpha) for name, frames in
               (("noop", base), ("framewise", reference), ("vace", decoded))}
    return {"frames": len(decoded), "protectedPixels": int(protected.sum()),
            "preencodeProtectedMaxError": 0, "encodedProtectedMeanErrorVsNoop": float(error.mean()),
            "encodedProtectedMaxErrorVsNoop": int(error.max()), "shots": metrics,
            "audioPcmSha256": final_audio, "sourceWithAudioSha256": av_hash,
            "candidateSha256": digest(out / "candidate.mp4"), "outputSha256": digest(out / "composite.mp4")}


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--model", required=True, type=Path, help="local Diffusers snapshot")
    cli.add_argument("--sam2-evidence", required=True, type=Path, help="E07 output directory")
    cli.add_argument("--output", required=True, type=Path, help="new directory for this run")
    args = cli.parse_args()
    revision = verify_model(args.model)
    clip, manifest = (args.sam2_evidence / name for name in ("source.mkv", "report.json"))
    source_hash, mask_report_hash = digest(clip), digest(manifest)
    source, allowed, controls, masks, alpha = prepare(args.sam2_evidence)
    args.output.mkdir(parents=True, exist_ok=False)
    conditions = save_conditions(args.output, controls, masks)
    frames, runtime = generate_shot(args.model, args.output, controls, masks, prompt=PROMPT,
                                    negative_prompt=NEGATIVE, steps=STEPS, seed=SEED)
    qa = evaluate(args.output, args.sam2_evidence, frames, source, allowed, alpha)
    if source_hash != digest(clip) or mask_report_hash != digest(manifest):
        raise ValueError("E07 inputs changed during the run")
    report = {"revision": revision, "sourceSha256": source_hash, "maskReportSha256": mask_report_hash,
              "seed": SEED, "guidanceScale": 5.0, "contentBox": CANVAS.content_box, "sampleFps": 9,
              "steps": STEPS, "prompt": PROMPT, "negativePrompt": NEGATIVE, "conditions": conditions,
              "runtime": runtime, "qa": qa}
    (args.output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))
