#!/usr/bin/env python3
"""Generate DIVISION.svg from team milestones and the current Git history.

Metric definitions are intentionally narrow:
- commits: non-`chore(stats):` commits reachable from HEAD whose author matches
  team.json identities;
- effective lines: non-blank, non-comment source lines still present at the
  latest non-stats commit, attributed with git blame. Documents, generated files,
  lockfiles, dependencies, vendored code and reference checkouts are excluded;
- progress: completed workstreams / all assigned workstreams. It is not derived
  from commit counts or lines of code.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[1]
TEAM_FILE = ROOT / "research" / "team.json"
OUTPUT_FILE = ROOT / "DIVISION.svg"
SOURCE_SUFFIXES = {
    ".c", ".cc", ".cpp", ".cs", ".css", ".cxx", ".go", ".h", ".hpp",
    ".java", ".js", ".jsx", ".kt", ".kts", ".lua", ".php", ".py", ".rb",
    ".rs", ".scss", ".sh", ".sql", ".swift", ".ts", ".tsx",
}
EXCLUDED_PARTS = {
    ".git", "build", "coverage", "dist", "node_modules", "out", "paseo",
    "pi", "research/sources", "vendor",
}
STATUS_LABELS = {
    "planned": "未开始",
    "in_progress": "进行中",
    "blocked": "阻塞",
    "done": "已完成",
}
STATUS_MARKS = {"planned": "○", "in_progress": "◐", "blocked": "!", "done": "●"}


def run_git(repo: Path, *args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if check and result.returncode:
        raise RuntimeError(result.stderr.strip() or "git command failed")
    return result.stdout


def has_head(repo: Path) -> bool:
    result = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "--verify", "HEAD"],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0


def matches(author: str, email: str, member: dict) -> bool:
    identities = member["identities"]
    return author.casefold() in {x.casefold() for x in identities["names"]} or email.casefold() in {
        x.casefold() for x in identities["emails"]
    }


def is_source(path: str) -> bool:
    candidate = Path(path)
    normalized = path.replace("\\", "/")
    if any(part in EXCLUDED_PARTS for part in candidate.parts):
        return False
    if any(part in normalized for part in ("package-lock.json", "pnpm-lock.yaml", ".min.", "/generated/")):
        return False
    return candidate.suffix.lower() in SOURCE_SUFFIXES


def is_code_line(path: str, line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return False
    suffix = Path(path).suffix.lower()
    if suffix in {".py", ".sh", ".rb"}:
        return not stripped.startswith("#")
    if suffix in {".css", ".scss", ".html"}:
        return not stripped.startswith(("/*", "*", "*/", "<!--"))
    if suffix == ".sql":
        return not stripped.startswith(("--", "/*", "*", "*/"))
    return not stripped.startswith(("//", "/*", "*", "*/", "#"))


def repo_snapshot(repo: Path, revision: str, members: list[dict]) -> tuple[dict, dict]:
    commits = {member["id"]: 0 for member in members}
    lines = {member["id"]: 0 for member in members}
    for record in run_git(repo, "log", "--no-merges", "--format=%an%x00%ae%x00%s", revision).splitlines():
        fields = record.split("\x00")
        if len(fields) < 3 or fields[2].startswith("chore(stats):"):
            continue
        for member in members:
            if matches(fields[0], fields[1], member):
                commits[member["id"]] += 1
                break

    tracked = [
        path for path in run_git(repo, "ls-tree", "-r", "--name-only", revision).splitlines()
        if is_source(path)
    ]
    for path in tracked:
        blame = run_git(repo, "blame", "--line-porcelain", "-w", revision, "--", path)
        author = ""
        email = ""
        for raw in blame.splitlines():
            if raw.startswith("author "):
                author = raw[7:]
            elif raw.startswith("author-mail "):
                email = raw[12:].strip("<>")
            elif raw.startswith("\t") and is_code_line(path, raw[1:]):
                for member in members:
                    if matches(author, email, member):
                        lines[member["id"]] += 1
                        break
    return commits, lines


def gitlink_repos(repo: Path) -> list[tuple[Path, str, str]]:
    """Return initialized gitlinks as (path, name, HEAD) for tracked product forks."""
    links: list[tuple[Path, str, str]] = []
    for line in run_git(repo, "ls-files", "--stage").splitlines():
        metadata, _, path = line.partition("\t")
        parts = metadata.split()
        if len(parts) < 2 or parts[0] != "160000" or not path.startswith("vendor/"):
            continue
        checkout = repo / path
        if not (checkout / ".git").exists():
            continue
        actual = run_git(checkout, "rev-parse", "HEAD").strip()
        if actual == parts[1]:
            links.append((checkout, Path(path).name, actual))
    return links


def collect_git_metrics(repo: Path, members: list[dict]) -> tuple[dict, dict, str, str]:
    commits = {member["id"]: 0 for member in members}
    lines = {member["id"]: 0 for member in members}
    if not has_head(repo):
        return commits, lines, "unborn", "尚无提交"

    # Anchor stats to the checked-out tree, not to a log-order-dependent head
    # commit: on a PR merge ref the tree is identical but the tip commit (and
    # its timestamp) is a merge commit, which would otherwise skew the snapshot.
    revision = run_git(repo, "rev-parse", "HEAD").strip()
    tree = run_git(repo, "rev-parse", f"{revision}^{{tree}}").strip()
    history = run_git(repo, "log", "--no-merges", "--format=%H%x00%ct%x00%s", revision).splitlines()
    non_stats = [line for line in history if not line.split("\x00", 2)[2].startswith("chore(stats):")]
    epochs = [int(line.split("\x00", 2)[1]) for line in non_stats]
    if not epochs:
        epochs = [int(run_git(repo, "show", "-s", "--format=%ct", revision).strip())]
    revision_parts = [tree[:12]]
    for snapshot_repo, name, snapshot_head in [(repo, None, revision), *[
        (path, name, sha) for path, name, sha in gitlink_repos(repo)
    ]]:
        snapshot_commits, snapshot_lines = repo_snapshot(snapshot_repo, snapshot_head, members)
        for member in members:
            commits[member["id"]] += snapshot_commits[member["id"]]
            lines[member["id"]] += snapshot_lines[member["id"]]
        if name is not None:
            revision_parts.append(f"{name}@{snapshot_head[:12]}")
            epochs.append(int(run_git(snapshot_repo, "show", "-s", "--format=%ct", snapshot_head).strip()))
    timestamp = datetime.fromtimestamp(max(epochs), tz=timezone.utc).isoformat()
    return commits, lines, " · ".join(revision_parts), timestamp


def member_progress(member_id: str, workstreams: list[dict]) -> tuple[int, str, list[dict]]:
    assigned = [item for item in workstreams if member_id in item["owners"]]
    done = sum(item["status"] == "done" for item in assigned)
    progress = round(100 * done / len(assigned)) if assigned else 0
    statuses = {item["status"] for item in assigned}
    if statuses == {"done"} and statuses:
        status = "done"
    elif "blocked" in statuses:
        status = "blocked"
    elif "in_progress" in statuses or done:
        status = "in_progress"
    else:
        status = "planned"
    active = [item for item in assigned if item["status"] != "done"]
    return progress, status, active


def text(x: float, y: float, value: str, size: int = 14, weight: int = 400, anchor: str = "start", opacity: float = 1) -> str:
    return (
        f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" '
        f'text-anchor="{anchor}" opacity="{opacity}">{escape(str(value))}</text>'
    )


def build_svg(data: dict, repo: Path) -> str:
    members = data["members"]
    workstreams = data["workstreams"]
    commits, lines, revision, timestamp = collect_git_metrics(repo, members)
    height = 230 + len(members) * 126
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 {height}" role="img" aria-labelledby="title desc">',
        '<title id="title">Agentic Video Editor 团队分工与实时进度</title>',
        '<desc id="desc">成员职责、里程碑完成度、Git 提交数和当前有效代码行。图形由 scripts/update_division.py 生成。</desc>',
        '<g font-family="system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Noto Sans CJK SC, sans-serif" fill="currentColor">',
        text(40, 48, "团队分工与交付进度", 28, 700),
        text(40, 76, f"统计快照 {revision} · 数据时点 {timestamp}", 13, 400, opacity=0.68),
        text(40, 106, "进度 = 已完成工作流 / 已分配工作流；代码量与提交量仅作活动记录，不代表质量或完成度。", 13, 400, opacity=0.76),
        '<path d="M40 126H960" stroke="currentColor" opacity="0.18"/>',
    ]
    y = 150
    for member in members:
        progress, status, active = member_progress(member["id"], workstreams)
        done_count = sum(
            item["status"] == "done" for item in workstreams if member["id"] in item["owners"]
        )
        assigned_count = sum(member["id"] in item["owners"] for item in workstreams)
        out.extend([
            f'<rect x="40" y="{y}" width="920" height="108" rx="12" fill="var(--surface)" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.22"/>',
            text(62, y + 29, member["name"], 19, 700),
            text(250, y + 28, member["role"], 14, 400, opacity=0.78),
            text(932, y + 28, STATUS_LABELS[status], 13, 600, "end", 0.76),
            f'<rect x="62" y="{y + 47}" width="420" height="10" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.25"/>',
            f'<rect x="62" y="{y + 47}" width="{420 * progress / 100:.1f}" height="10" rx="5" fill="currentColor" opacity="0.78"/>',
            text(498, y + 58, f"{progress}%（{done_count}/{assigned_count} 项）", 13, 600),
            text(62, y + 84, f"提交 {commits[member['id']]}", 13, 500),
            text(166, y + 84, f"有效代码 {lines[member['id']]} 行", 13, 500),
        ])
        if active:
            current = "；".join(f"{STATUS_MARKS[item['status']]} {item['title']}" for item in active[:2])
        else:
            current = "● 所分配工作流均已完成"
        if len(current) > 44:
            current = current[:43] + "…"
        out.append(text(380, y + 84, current, 12, 400, opacity=0.7))
        y += 126

    out.extend([
        '<path d="M40 156H960" stroke="currentColor" opacity="0.08"/>',
        text(40, height - 47, "有效代码：统计快照中仍存活、git blame 归属的非空非注释源码行；排除文档、生成物、锁文件、依赖与参考仓库。", 12, 400, opacity=0.64),
        text(40, height - 24, "更新：python3 scripts/update_division.py · 校验：python3 scripts/update_division.py --check", 12, 500, opacity=0.72),
        '</g></svg>',
        "",
    ])
    return "\n".join(out)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if DIVISION.svg is stale")
    parser.add_argument("--repo", type=Path, default=ROOT, help=argparse.SUPPRESS)
    parser.add_argument("--output", type=Path, default=OUTPUT_FILE, help=argparse.SUPPRESS)
    args = parser.parse_args()
    data = json.loads(TEAM_FILE.read_text(encoding="utf-8"))
    if data.get("schemaVersion") != 1:
        raise ValueError("unsupported research/team.json schemaVersion")
    svg = build_svg(data, args.repo.resolve())
    if args.check:
        if not args.output.exists() or args.output.read_text(encoding="utf-8") != svg:
            print("DIVISION.svg 已过期；运行 python3 scripts/update_division.py", file=sys.stderr)
            return 1
        print("DIVISION.svg 与团队数据和 HEAD 一致")
        return 0
    args.output.write_text(svg, encoding="utf-8")
    print(f"已更新 {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
