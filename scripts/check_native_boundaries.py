#!/usr/bin/env python3
"""Enforce native AVE dependency and framework-removal boundaries."""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NATIVE_ROOTS = ["packages", "storage", "services", "apps"]
SCAN_SUFFIXES = {".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".py"}
IGNORE_PARTS = {"node_modules", "dist", "build", ".venv", "__pycache__"}

FORBIDDEN_GLOBAL = [
    ("@getpaseo/", "Paseo package reference"),
    ("@earendil-works/pi-", "Pi agent package reference"),
    ("downstream/paseo", "legacy downstream path reference"),
    ("vendor/paseo", "legacy vendor path reference"),
    ("filmcraft", "FilmCraft package/source reference"),
]

IMPORT_LINE_RE = re.compile(r"""(?:from\s+['"]|import\(['"]|require\(['"]|^\s*(?:import|from)\s+)([^'"]+)""")


def iter_native_files():
    for top in NATIVE_ROOTS:
        base = ROOT / top
        if not base.exists():
            continue
        for path in sorted(base.rglob("*")):
            if not path.is_file():
                continue
            if any(part in IGNORE_PARTS for part in path.parts):
                continue
            if path.suffix in SCAN_SUFFIXES:
                yield top, path


def main() -> int:
    errors: list[str] = []
    scanned = 0

    root_pkg = ROOT / "package.json"
    if root_pkg.exists():
        text = root_pkg.read_text(encoding="utf-8")
        for needle, label in FORBIDDEN_GLOBAL:
            if needle in text:
                errors.append(f"package.json: forbidden {label} ({needle})")

    for top, path in iter_native_files():
        scanned += 1
        rel = path.relative_to(ROOT).as_posix()
        text = path.read_text(encoding="utf-8", errors="ignore")

        for needle, label in FORBIDDEN_GLOBAL:
            if needle in text:
                # Allow string literal "filmcraft" only in contracts/domain schema compat enum check,
                # never as an import/dependency/package reference.
                if needle == "filmcraft" and (
                    rel.startswith("packages/contracts/")
                    or rel.startswith("packages/domain/")
                ):
                    if re.search(r"""(?:from\s+['"][^'"]*filmcraft|require\(['"][^'"]*filmcraft|"filmcraft":)""", text, re.I):
                        errors.append(f"{rel}: forbidden FilmCraft import/dependency")
                    continue
                errors.append(f"{rel}: forbidden {label} ({needle})")

        if top == "apps":
            for m in IMPORT_LINE_RE.finditer(text):
                spec = m.group(1)
                if spec in {"@ave/sqlite", "@ave/cas", "node:sqlite"} or spec.startswith("@ave/service"):
                    errors.append(f"{rel}: UI layer must not import storage/service ({spec})")

        if rel.startswith("services/planner-worker/"):
            for m in IMPORT_LINE_RE.finditer(text):
                spec = m.group(1)
                if spec in {"@ave/sqlite", "@ave/cas", "node:sqlite"}:
                    errors.append(f"{rel}: planner-worker must not import storage ({spec})")

    if errors:
        print("Native boundary check FAILED:", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        return 1

    print(f"Native boundary check PASS: {scanned} files scanned, zero Paseo/Pi/FilmCraft coupling")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
