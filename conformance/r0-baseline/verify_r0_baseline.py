#!/usr/bin/env python3
"""Verify R0 frozen baseline against downstream/paseo and golden media tooling."""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
R0_DIR = Path(__file__).resolve().parent
DOWNSTREAM = ROOT / "downstream" / "paseo"


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    spec = json.loads((R0_DIR / "baseline-spec.json").read_text(encoding="utf-8"))
    errors: list[str] = []

    # 1. Verify frozen contract & fixture hashes against downstream/paseo
    v1_schema = DOWNSTREAM / "plugins/video-editor/shared/contracts/v1.schema.json"
    v1_ts = DOWNSTREAM / "plugins/video-editor/shared/contracts/v1.ts"
    legacy_fixtures = DOWNSTREAM / "plugins/video-editor/test/fixtures.json"
    r0_fixtures = R0_DIR / "fixtures.json"

    if sha256_file(v1_schema) != spec["sourceHashes"]["v1SchemaJsonSha256"]:
        errors.append("v1.schema.json hash mismatch vs baseline-spec.json")
    if sha256_file(v1_ts) != spec["sourceHashes"]["v1ContractTsSha256"]:
        errors.append("v1.ts hash mismatch vs baseline-spec.json")
    if sha256_file(legacy_fixtures) != spec["sourceHashes"]["fixturesJsonSha256"]:
        errors.append("legacy fixtures.json hash mismatch vs baseline-spec.json")
    if sha256_file(r0_fixtures) != spec["sourceHashes"]["fixturesJsonSha256"]:
        errors.append("conformance/r0-baseline/fixtures.json differs from legacy fixtures.json")

    fixtures_data = json.loads(r0_fixtures.read_text(encoding="utf-8"))
    if len(fixtures_data) != 196:
        errors.append(f"Expected 196 fixtures, found {len(fixtures_data)}")

    # 2. Verify RPC switch & authorization matrix match live downstream files
    rpc_txt = (DOWNSTREAM / "packages/server/src/server/video/rpc.ts").read_text(encoding="utf-8")
    main_rpc = rpc_txt.split("private async deviceOperation", 1)[0]
    live_rpc_cases = sorted(set(re.findall(r'case\s+"(video\.v1\.[a-z_]+)"', main_rpc)))
    if live_rpc_cases != sorted(spec["rpcSurface"]["mainSwitchMethods"]):
        errors.append("RPC mainSwitchMethods mismatch vs rpc.ts")

    auth_txt = (DOWNSTREAM / "packages/server/src/server/video/authorization.ts").read_text(encoding="utf-8")
    live_read = sorted(set(re.findall(
        r'"(video\.v1\.[a-z_]+)"',
        re.search(r"READ_METHODS = new Set\(\[(.*?)\]\)", auth_txt, re.S).group(1),
    )))
    live_manage = sorted(set(re.findall(
        r'"(video\.v1\.[a-z_]+)"',
        re.search(r"MANAGE_METHODS = new Set\(\[(.*?)\]\)", auth_txt, re.S).group(1),
    )))
    if live_read != sorted(spec["rpcSurface"]["authorizationMatrix"]["readMethods"]):
        errors.append("READ_METHODS mismatch vs authorization.ts")
    if live_manage != sorted(spec["rpcSurface"]["authorizationMatrix"]["manageMethods"]):
        errors.append("MANAGE_METHODS mismatch vs authorization.ts")

    # 3. Verify 17 planner tools vs tool-broker.ts
    tb_txt = (DOWNSTREAM / "packages/server/src/server/video/tool-broker.ts").read_text(encoding="utf-8")
    live_tools = sorted(set(re.findall(r'case\s+"([a-z_]+)"', tb_txt)))
    if live_tools != sorted(spec["plannerTools"]["allowed"]):
        errors.append(f"plannerTools mismatch: live={live_tools}")

    # 4. Verify error codes, job states, and object-edit FSM states
    v1_txt = v1_ts.read_text(encoding="utf-8")
    oe_states = re.findall(
        r'"([^"]+)"',
        re.search(r"export const ObjectEditStateSchema\s*=\s*z\.enum\(\[(.*?)\]\);", v1_txt, re.S).group(1),
    )
    if oe_states != spec["objectEditFsm"]["states"]:
        errors.append(f"objectEditFsm states mismatch: live={oe_states}")

    job_states = re.findall(
        r'"([^"]+)"',
        re.search(r"export const JobStateSchema\s*=\s*z\.enum\(\[(.*?)\]\);", v1_txt, re.S).group(1),
    )
    if job_states != spec["jobStates"]:
        errors.append(f"jobStates mismatch: live={job_states}")

    thrown_codes = set()
    for p in (DOWNSTREAM / "packages/server/src/server/video").rglob("*.ts"):
        if p.name.endswith(".test.ts"):
            continue
        for m in re.finditer(r'(?:editorFailure|new EditorError)\(\s*"([A-Z0-9_]+)"', p.read_text(encoding="utf-8")):
            thrown_codes.add(m.group(1))
    if not thrown_codes <= set(spec["errorCodes"]):
        errors.append(f"Undocumented error codes in downstream: {sorted(thrown_codes - set(spec['errorCodes']))}")

    # 5. Run legacy offline RPC surface check
    rpc_surface = subprocess.run(
        [sys.executable, str(DOWNSTREAM / "plugins/video-editor/test/test_rpc_surface.py")],
        cwd=ROOT, check=False, capture_output=True, text=True,
    )
    if rpc_surface.returncode != 0:
        errors.append(f"test_rpc_surface.py failed: {rpc_surface.stdout} {rpc_surface.stderr}")

    # 6. Generate and verify 4 golden media samples in an isolated temp dir
    with tempfile.TemporaryDirectory(prefix="ave-r0-golden-") as tmp:
        gen = subprocess.run(
            [sys.executable, str(R0_DIR / "generate_golden_media.py"), "--out-dir", tmp, "--verify"],
            cwd=ROOT, check=False, capture_output=True, text=True,
        )
        if gen.returncode != 0:
            errors.append(f"generate_golden_media.py failed: {gen.stdout} {gen.stderr}")
        else:
            media_report = json.loads(gen.stdout)

    if errors:
        print("R0 baseline verification FAILED:", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        return 1

    print(
        f"R0 baseline PASS: {len(fixtures_data)} fixtures, {len(live_rpc_cases)} RPC methods, "
        f"{len(live_tools)} planner tools, {len(spec['errorCodes'])} error codes, "
        f"{len(spec['objectEditFsm']['states'])} objectEdit states, "
        f"{len(media_report['samples'])} golden media samples verified & decoded"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
