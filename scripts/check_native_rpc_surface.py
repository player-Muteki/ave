#!/usr/bin/env python3
"""Verify native AVE RPC registry and authorization surface against frozen R0 baseline."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    spec = json.loads((ROOT / "conformance/r0-baseline/baseline-spec.json").read_text(encoding="utf-8"))
    rpc_txt = (ROOT / "services/daemon/src/rpc-registry.ts").read_text(encoding="utf-8")
    auth_txt = (ROOT / "packages/domain/src/authorization.ts").read_text(encoding="utf-8")
    v1_txt = (ROOT / "packages/contracts/src/v1.ts").read_text(encoding="utf-8")

    registered = set(re.findall(r'this\.register\("(video\.v1\.[a-z_]+)"', rpc_txt))
    expected_main = set(spec["rpcSurface"]["mainSwitchMethods"])

    read_m = set(re.findall(
        r'"(video\.v1\.[a-z_]+)"',
        re.search(r"READ_METHODS = new Set\(\[(.*?)\]\)", auth_txt, re.S).group(1),
    ))
    manage_m = set(re.findall(
        r'"(video\.v1\.[a-z_]+)"',
        re.search(r"MANAGE_METHODS = new Set\(\[(.*?)\]\)", auth_txt, re.S).group(1),
    ))

    expected_read = set(spec["rpcSurface"]["authorizationMatrix"]["readMethods"])
    expected_manage = set(spec["rpcSurface"]["authorizationMatrix"]["manageMethods"])
    rpc_exports = set(re.findall(r'name:\s*"(video\.v1\.[a-z_]+)"', v1_txt))

    errors: list[str] = []
    if registered != expected_main:
        missing = sorted(expected_main - registered)
        extra = sorted(registered - expected_main)
        errors.append(f"Registered RPC mismatch: missing={missing}, extra={extra}")
    if read_m != expected_read:
        errors.append(f"READ_METHODS drift vs R0: {sorted(read_m ^ expected_read)}")
    if manage_m != expected_manage:
        errors.append(f"MANAGE_METHODS drift vs R0: {sorted(manage_m ^ expected_manage)}")
    if read_m & manage_m:
        errors.append(f"Overlap between READ and MANAGE: {sorted(read_m & manage_m)}")
    if not (registered - {"video.v1.import_asset", "video.v1.create_invitation", "video.v1.redeem_invitation", "video.v1.revoke_device"}) <= rpc_exports:
        errors.append("Some registered RPCs are missing from @ave/contracts/v1.ts")

    if errors:
        print("Native RPC surface check FAILED:", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        return 1

    print(
        f"Native RPC surface PASS: {len(registered)} methods registered, "
        f"{len(read_m)} read + {len(manage_m)} manage methods match R0 baseline"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
