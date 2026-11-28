"""Daemon-facing CLI for the closed media Worker kernels.

Subcommands speak JSON over stdio/argv only: no file paths other than the
CAS-owned presentation index and private frame staging directory, no subprocess, no model, no network. The daemon
owns decoding, CAS and approvals; these kernels are pure functions of their
inputs plus the pinned presentation index bytes.
"""
import argparse
import importlib.util
import json
import sys
from dataclasses import asdict
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def _support() -> dict:
    out = {"python": sys.version.split()[0]}
    for mod in ("numpy", "scenedetect", "cv2"):
        out[mod] = importlib.util.find_spec(mod) is not None
    if out["cv2"] and out["numpy"]:
        from people_detector import support
        out["hog"] = support()["hog"]
    else:
        out["hog"] = False
    return out


def _sampling_map(args: argparse.Namespace) -> dict:
    from sampling_map import sample_index_shot

    index_bytes = Path(args.index).read_bytes()
    rate = Fraction(args.rate)
    smap = sample_index_shot(
        index_bytes,
        index_sha256=args.index_sha256,
        source_sha256=args.source_sha256,
        stream_uid=args.stream_uid,
        first=args.first,
        stop=args.stop,
        rate=rate,
    )
    doc = asdict(smap)
    doc["source_clock"] = f"{smap.source_clock.numerator}/{smap.source_clock.denominator}"
    doc["sample_rate"] = f"{smap.sample_rate.numerator}/{smap.sample_rate.denominator}"
    doc["source_frames"] = [{"pts": str(f.pts), "duration": str(f.duration)} for f in smap.source_frames]
    doc["sample_to_source"] = list(smap.sample_to_source)
    doc["source_to_samples"] = [list(g) for g in smap.source_to_samples()]
    return doc


def _detect_people(args: argparse.Namespace) -> dict:
    import numpy as np
    from people_detector import Observation, detect_people_candidates, support

    if not support()["hog"]:
        raise RuntimeError("CAPABILITY_UNAVAILABLE: OpenCV HOG people detector is unavailable")
    directory = Path(args.directory)
    request = json.loads((directory / "frames.json").read_bytes())
    samples = request["samples"]
    raster = np.memmap(directory / "frames.bgr", np.uint8, "r",
                       shape=(len(samples), request["height"], request["width"], 3))
    observations = [Observation(int(sample["pts"]), int(sample["duration"]), frame)
                    for sample, frame in zip(samples, raster, strict=True)]
    result = detect_people_candidates(observations)
    for track in result["tracks"]:
        track["firstFrame"] = str(samples[track["firstFrame"]]["ordinal"])
        track["lastFrame"] = str(samples[track["lastFrame"]]["ordinal"])
        track["evidenceFrames"] = [str(samples[i]["ordinal"]) for i in track["evidenceFrames"]]
        track["confidence"] = min(1.0, max(0.0, track["confidence"]))
    return result


def main() -> int:
    parser = argparse.ArgumentParser(prog="daemon_cli.py")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("support")
    sub.add_parser("detect-people").add_argument("--directory", required=True)
    sm = sub.add_parser("sampling-map")
    sm.add_argument("--index", required=True)
    sm.add_argument("--index-sha256", required=True)
    sm.add_argument("--source-sha256", required=True)
    sm.add_argument("--stream-uid", required=True)
    sm.add_argument("--first", type=int, required=True)
    sm.add_argument("--stop", type=int, required=True)
    sm.add_argument("--rate", required=True, help="num/den, e.g. 25/1")
    args = parser.parse_args()
    try:
        result = (_support() if args.command == "support" else
                  _detect_people(args) if args.command == "detect-people" else _sampling_map(args))
    except Exception as error:  # surfaced to the daemon as a structured failure
        print(json.dumps({"error": type(error).__name__, "message": str(error)}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
