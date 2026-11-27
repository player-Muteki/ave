"""Daemon-facing CLI for the closed media Worker kernels.

Subcommands speak JSON over stdio/argv only: no file paths other than the
CAS-owned presentation index, no subprocess, no model, no network. The daemon
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


def main() -> int:
    parser = argparse.ArgumentParser(prog="daemon_cli.py")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("support")
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
        result = _support() if args.command == "support" else _sampling_map(args)
    except Exception as error:  # surfaced to the daemon as a structured failure
        print(json.dumps({"error": type(error).__name__, "message": str(error)}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
