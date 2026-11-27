#!/usr/bin/env python3
"""Offline gate for the FilmCraft upstream pin and its review verdict.

research/upstream.json pins the FilmCraft reference checkout. The reviewed
verdict (research/filmcraft-ba6fe105-to-7b8e522d.md) is source-only: the new
upstream is NOT adopted as the product backend, so the daemon must keep
reporting the filmcraft backend as unavailable and the preview profile must
keep rejecting it. This check fails if the pin drifts from the reviewed
commit or if any of those code gates regress.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

REVIEWED_PIN = "7b8e522d63f2e2c1617dea4939feb48e769d6f2f"
REVIEWED_CRAFT_LIBS = "a4db799563c9ccd7217e1731ec34c58f6ba57248"
REVIEW_DOC = ROOT / "research" / "filmcraft-ba6fe105-to-7b8e522d.md"


def main() -> int:
    errors: list[str] = []

    upstream = json.loads((ROOT / "research" / "upstream.json").read_text(encoding="utf-8"))
    filmcraft = next((r for r in upstream["references"] if r["path"] == "filmcraft"), None)
    if filmcraft is None:
        errors.append("research/upstream.json: no filmcraft reference")
    else:
        if filmcraft.get("commit") != REVIEWED_PIN:
            errors.append(
                f"research/upstream.json: filmcraft pin {filmcraft.get('commit')} != reviewed {REVIEWED_PIN}"
            )
        pins = filmcraft.get("dependencyPins", {})
        if pins.get("craft-libs") != REVIEWED_CRAFT_LIBS:
            errors.append(
                f"research/upstream.json: craft-libs pin {pins.get('craft-libs')} != reviewed {REVIEWED_CRAFT_LIBS}"
            )

    if not REVIEW_DOC.exists():
        errors.append(f"missing review doc {REVIEW_DOC.relative_to(ROOT)}")
    else:
        doc = REVIEW_DOC.read_text(encoding="utf-8")
        if REVIEWED_PIN not in doc:
            errors.append(f"{REVIEW_DOC.name}: does not mention the reviewed pin {REVIEWED_PIN}")
        if not any(marker in doc for marker in ("不启用", "不启动", "不采用", "未采用", "not adopted", "NOT adopted")):
            errors.append(f"{REVIEW_DOC.name}: missing the non-adoption verdict")

    rpc = (ROOT / "downstream/paseo/packages/server/src/server/video/rpc.ts").read_text(encoding="utf-8")
    if not re.search(r'id:\s*"filmcraft",\s*\n\s*available:\s*false', rpc):
        errors.append("rpc.ts: capabilities must keep filmcraft backend available:false")

    profile = (ROOT / "downstream/paseo/packages/server/src/server/video/preview-profile.ts").read_text(encoding="utf-8")
    if 'preferredDeterministicBackendId === "filmcraft"' not in profile:
        errors.append("preview-profile.ts: must keep rejecting the filmcraft backend")

    store = (ROOT / "downstream/paseo/packages/server/src/server/video/store.ts").read_text(encoding="utf-8")
    if '?? "ffmpeg"' not in store:
        errors.append('store.ts: plan backend must keep defaulting to "ffmpeg"')

    e13 = (ROOT / "scripts" / "check_filmcraft_e13.py").read_text(encoding="utf-8")
    if "upstream.json" not in e13:
        errors.append("check_filmcraft_e13.py: must read the pin from research/upstream.json")

    if errors:
        print("FilmCraft pin gate FAILED:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"PASS: filmcraft pin {REVIEWED_PIN[:8]} reviewed, not adopted; code gates consistent")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
