#!/usr/bin/env python3
"""Offline consistency check for the main video RPC switch:
- every case in EditorRpcService.invoke must have a contract Rpc export
  (except the intentionally disabled import_asset stub)
- READ_METHODS / MANAGE_METHODS must only reference known methods
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
RPC = (ROOT / "packages/server/src/server/video/rpc.ts").read_text(encoding="utf-8")
V1 = (ROOT / "plugins/video-editor/shared/contracts/v1.ts").read_text(encoding="utf-8")
AUTH = (ROOT / "packages/server/src/server/video/authorization.ts").read_text(encoding="utf-8")

main = RPC.split("private async deviceOperation", 1)[0]
cases = set(re.findall(r'case "(video\.v1\.[a-z_]+)"', main))
# device-channel-only methods are dispatched outside the main switch
DEVICE_ONLY = {"video.v1.create_invitation", "video.v1.redeem_invitation", "video.v1.revoke_device", "video.v1.configure_worker"}
# forwarded to the device channel; contract exports live with the device wire format
FORWARDED = {"video.v1.create_invitation", "video.v1.redeem_invitation", "video.v1.revoke_device"}
STUBS = {"video.v1.import_asset"}  # intentionally disabled: no server path imports

rpc_exports = set(re.findall(r'name:\s*"(video\.v1\.[a-z_]+)"', V1))
read = set(re.findall(r'"(video\.v1\.[a-z_]+)"', re.search(r"READ_METHODS = new Set\(\[(.*?)\]\)", AUTH, re.S).group(1)))
manage = set(re.findall(r'"(video\.v1\.[a-z_]+)"', re.search(r"MANAGE_METHODS = new Set\(\[(.*?)\]\)", AUTH, re.S).group(1)))

problems = []
missing_export = cases - rpc_exports - STUBS - FORWARDED
if missing_export:
    problems.append(f"main-switch cases without contract export: {sorted(missing_export)}")
unknown_auth = (read | manage) - cases - DEVICE_ONLY
if unknown_auth:
    problems.append(f"authorization references unknown methods: {sorted(unknown_auth)}")
if read & manage:
    problems.append(f"methods in both read and manage: {sorted(read & manage)}")

if problems:
    for p in problems:
        print("FAIL:", p)
    raise SystemExit(1)
print(f"PASS: {len(cases)} main-switch cases, {len(rpc_exports)} contract exports, {len(read)} read + {len(manage)} manage methods consistent")
