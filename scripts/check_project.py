#!/usr/bin/env python3
"""Validate project documentation, team data, links, and generated SVGs."""

from __future__ import annotations

import json
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
MARKDOWN_LINK = re.compile(r"(?<!!)\[[^]]*\]\(([^)]+)\)|!\[[^]]*\]\(([^)]+)\)")
VALID_STATUSES = {"planned", "in_progress", "blocked", "done"}


def fail(errors: list[str], message: str) -> None:
    errors.append(message)


def markdown_files() -> list[Path]:
    files = [ROOT / name for name in (
        "README.md", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "ROADMAP.md",
        "demo.md", "findings.md", "task_plan.md", "progress.md",
    )]
    files.extend((ROOT / "demo").glob("**/*.md"))
    return sorted({path for path in files if path.exists()})


def check_markdown(path: Path, errors: list[str]) -> None:
    content = path.read_text(encoding="utf-8")
    if content.count("```") % 2:
        fail(errors, f"{path.relative_to(ROOT)}: 代码围栏未成对")
    for match in MARKDOWN_LINK.finditer(content):
        target = (match.group(1) or match.group(2)).strip()
        if target.startswith("<") and target.endswith(">"):
            target = target[1:-1]
        target = target.split(" ", 1)[0]
        if not target or target.startswith(("#", "http://", "https://", "mailto:", "data:")):
            continue
        local = unquote(target.split("#", 1)[0])
        resolved = (path.parent / local).resolve()
        try:
            resolved.relative_to(ROOT)
        except ValueError:
            fail(errors, f"{path.relative_to(ROOT)}: 链接越出仓库 {target}")
            continue
        if not resolved.exists():
            fail(errors, f"{path.relative_to(ROOT)}: 死链 {target}")


def check_svg(path: Path, errors: list[str]) -> None:
    try:
        root = ET.parse(path).getroot()
    except (ET.ParseError, OSError) as error:
        fail(errors, f"{path.name}: SVG 无法解析：{error}")
        return
    if not root.tag.endswith("svg") or "viewBox" not in root.attrib:
        fail(errors, f"{path.name}: 缺少 svg/viewBox")
    for element in root.iter():
        name = element.tag.rsplit("}", 1)[-1]
        if name in {"script", "foreignObject", "animate", "set"}:
            fail(errors, f"{path.name}: 禁止动态/脚本元素 {name}")
        for key, value in element.attrib.items():
            if key.rsplit("}", 1)[-1] == "href" and not value.startswith("#"):
                fail(errors, f"{path.name}: 禁止外部资源 {value}")


def check_team(errors: list[str]) -> None:
    data = json.loads((ROOT / "research" / "team.json").read_text(encoding="utf-8"))
    members = data.get("members", [])
    workstreams = data.get("workstreams", [])
    member_ids = [member["id"] for member in members]
    if len(member_ids) != len(set(member_ids)):
        fail(errors, "team.json: member id 重复")
    known = set(member_ids)
    stream_ids = [item["id"] for item in workstreams]
    if len(stream_ids) != len(set(stream_ids)):
        fail(errors, "team.json: workstream id 重复")
    for item in workstreams:
        if item.get("status") not in VALID_STATUSES:
            fail(errors, f"team.json: {item.get('id')} 状态非法")
        if not item.get("owners") or not set(item.get("owners", [])) <= known:
            fail(errors, f"team.json: {item.get('id')} owners 缺失或未知")
        evidence_value = item.get("evidence", "").strip()
        if item.get("status") == "done" and not evidence_value:
            fail(errors, f"team.json: {item['id']} 已完成但缺少证据")
        for evidence in evidence_value.split(";"):
            evidence = evidence.strip()
            if evidence and not (ROOT / evidence).exists():
                fail(errors, f"team.json: {item['id']} 证据不存在 {evidence}")


def main() -> int:
    errors: list[str] = []
    for document in markdown_files():
        check_markdown(document, errors)
    for name in ("ARCHITECTURE.svg", "DIVISION.svg"):
        path = ROOT / name
        if path.exists():
            check_svg(path, errors)
        else:
            fail(errors, f"缺少 {name}")
    check_team(errors)
    rpc_surface = ROOT / "downstream" / "paseo" / "plugins" / "video-editor" / "test" / "test_rpc_surface.py"
    if rpc_surface.exists():
        surface = subprocess.run(
            [sys.executable, str(rpc_surface)],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        if surface.returncode:
            fail(errors, surface.stdout.strip() or surface.stderr.strip())
    repository = subprocess.run(
        ["git", "-C", str(ROOT), "rev-parse", "--is-inside-work-tree"],
        check=False,
        capture_output=True,
        text=True,
    )
    if repository.returncode == 0 and repository.stdout.strip() == "true":
        generated = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "update_division.py"), "--check"],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        if generated.returncode:
            fail(errors, generated.stderr.strip())
    if errors:
        print("项目校验失败：", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"项目校验通过：{len(markdown_files())} 份 Markdown、2 份 SVG、团队数据与链接一致")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
