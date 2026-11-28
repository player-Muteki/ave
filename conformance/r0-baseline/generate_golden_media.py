#!/usr/bin/env python3
"""Generate and optionally verify deterministic R0 golden media samples via FFmpeg."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path


def run_cmd(argv: list[str]) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, check=False, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"Command failed ({result.returncode}): {' '.join(argv)}\n{result.stderr.strip()}"
        )
    return result


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def generate_samples(out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    help_text = run_cmd(["ffmpeg", "-hide_banner", "-h", "full"]).stdout
    timing_flag = "-fps_mode" if any(
        line.lstrip().startswith(("-fps_mode ", "-fps_mode:", "-fps_mode["))
        for line in help_text.splitlines()
    ) else "-vsync"
    created: list[Path] = []

    # 1. cfr_25fps_av.mp4: 1.5s smptebars + 1.5s testsrc2 (deterministic scene cut) + 48kHz stereo AAC
    p1 = out_dir / "cfr_25fps_av.mp4"
    run_cmd([
        "ffmpeg", "-y", "-v", "error",
        "-f", "lavfi", "-i", "smptebars=size=320x180:rate=25:duration=1.5",
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=1.5",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3.0",
        "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a]pan=stereo|c0=c0|c1=c0[a]",
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-g", "25",
        "-c:a", "aac", "-b:a", "96k",
        "-movflags", "+faststart",
        str(p1),
    ])
    created.append(p1)

    # 2. cfr_30fps_av.mp4: 3.0s 30fps CFR + 48kHz stereo AAC
    p2 = out_dir / "cfr_30fps_av.mp4"
    run_cmd([
        "ffmpeg", "-y", "-v", "error",
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=3.0",
        "-f", "lavfi", "-i", "sine=frequency=523:sample_rate=48000:duration=3.0",
        "-filter_complex", "[1:a]pan=stereo|c0=c0|c1=c0[a]",
        "-map", "0:v", "-map", "[a]",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-g", "30",
        "-c:a", "aac", "-b:a", "96k",
        "-movflags", "+faststart",
        str(p2),
    ])
    created.append(p2)

    # 3. vfr_mixed_av.mp4: 50 frames where first 25 frames are 40ms (3600 ticks @ 90kHz)
    # and next 25 frames are ~66.67ms (6000 ticks @ 90kHz), total ~2.667s.
    p3 = out_dir / "vfr_mixed_av.mp4"
    run_cmd([
        "ffmpeg", "-y", "-v", "error",
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=2.0",
        "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=2.67",
        "-filter_complex",
        "[0:v]settb=1/90000,setpts='if(lt(N,25),N*3600,25*3600+(N-25)*6000)'[v];[1:a]pan=stereo|c0=c0|c1=c0[a]",
        "-map", "[v]", "-map", "[a]",
        timing_flag, "vfr", "-enc_time_base", "1/90000", "-video_track_timescale", "90000",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast",
        "-c:a", "aac", "-b:a", "96k",
        "-movflags", "+faststart",
        str(p3),
    ])
    created.append(p3)

    # 4. multistream_sub.mkv: 1 video + 2 audio (440Hz & 880Hz) + 1 SRT subtitle
    srt_path = out_dir / "_sub_temp.srt"
    srt_path.write_text(
        "1\n00:00:00,000 --> 00:00:01,000\nFirst cue\n\n"
        "2\n00:00:01,000 --> 00:00:02,000\nSecond cue\n",
        encoding="utf-8",
    )
    p4 = out_dir / "multistream_sub.mkv"
    try:
        run_cmd([
            "ffmpeg", "-y", "-v", "error",
            "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=2.0",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2.0",
            "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=2.0",
            "-i", str(srt_path),
            "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:s",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast",
            "-c:a", "aac", "-b:a", "96k",
            "-c:s", "srt",
            "-metadata:s:a:0", "language=eng",
            "-metadata:s:a:1", "language=zho",
            str(p4),
        ])
    finally:
        srt_path.unlink(missing_ok=True)
    created.append(p4)

    return created


def verify_samples(out_dir: Path) -> list[dict]:
    specs = {
        "cfr_25fps_av.mp4": {"video": 1, "audio": 1, "subtitle": 0, "avg_frame_rate": "25/1", "vfr": False},
        "cfr_30fps_av.mp4": {"video": 1, "audio": 1, "subtitle": 0, "avg_frame_rate": "30/1", "vfr": False},
        "vfr_mixed_av.mp4": {"video": 1, "audio": 1, "subtitle": 0, "avg_frame_rate": None, "vfr": True},
        "multistream_sub.mkv": {"video": 1, "audio": 2, "subtitle": 1, "avg_frame_rate": "25/1", "vfr": False},
    }
    report: list[dict] = []
    for name, expected in specs.items():
        path = out_dir / name
        if not path.is_file():
            raise RuntimeError(f"Missing generated sample: {path}")
        probe = json.loads(
            run_cmd([
                "ffprobe", "-v", "error", "-print_format", "json",
                "-show_format", "-show_streams", str(path),
            ]).stdout
        )
        streams = probe.get("streams", [])
        counts = {
            kind: sum(1 for s in streams if s.get("codec_type") == kind)
            for kind in ("video", "audio", "subtitle")
        }
        for kind in ("video", "audio", "subtitle"):
            if counts[kind] != expected[kind]:
                raise RuntimeError(f"{name}: expected {expected[kind]} {kind} streams, got {counts[kind]}")
        video_stream = next(s for s in streams if s.get("codec_type") == "video")
        if expected["avg_frame_rate"] and video_stream.get("avg_frame_rate") != expected["avg_frame_rate"]:
            raise RuntimeError(
                f"{name}: expected avg_frame_rate={expected['avg_frame_rate']}, got {video_stream.get('avg_frame_rate')}"
            )
        distinct_durations = None
        if expected["vfr"]:
            frames = json.loads(
                run_cmd([
                    "ffprobe", "-v", "error", "-select_streams", "v:0",
                    "-show_entries", "frame=duration,pkt_duration", "-print_format", "json", str(path),
                ]).stdout
            ).get("frames", [])
            durations = {
                f.get("duration", f.get("pkt_duration"))
                for f in frames
                if f.get("duration", f.get("pkt_duration")) is not None
            }
            distinct_durations = len(durations)
            if distinct_durations < 2:
                raise RuntimeError(f"{name}: expected VFR with >=2 frame durations, got {durations}")
        # Full decode check (every stream)
        run_cmd(["ffmpeg", "-v", "error", "-i", str(path), "-f", "null", "-"])
        report.append({
            "file": name,
            "bytes": path.stat().st_size,
            "sha256": sha256_file(path),
            "duration": probe.get("format", {}).get("duration"),
            "streams": counts,
            "distinctVideoDurations": distinct_durations,
        })
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-dir", type=Path, default=Path("/tmp/ave-r0-golden"))
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()

    generate_samples(args.out_dir)
    if args.verify:
        report = verify_samples(args.out_dir)
        print(json.dumps({"outDir": str(args.out_dir), "samples": report}, indent=2))
    else:
        print(f"Generated 4 golden media samples in {args.out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
