"""Build a native installer on its target OS from the compiled workspace and media runtime."""
import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def stage(payload):
    modules = payload / "node_modules"
    modules.mkdir(parents=True)
    shutil.copy2(ROOT / "package.json", payload)
    for group in ("apps", "services", "packages", "storage"):
        for manifest in (ROOT / group).glob("*/package.json"):
            source = manifest.parent
            if source.name == "mobile":
                continue
            dest = payload / source.relative_to(ROOT)
            dist = source / "dist"
            if not dist.is_dir():
                raise RuntimeError(f"Missing compiled workspace {dist}")
            shutil.copytree(dist, dest / "dist")
            shutil.copy2(manifest, dest)
            if group not in ("services", "apps") or source.name == "planner-worker":
                name = json.loads(manifest.read_bytes())["name"]
                shutil.copytree(dest, modules / name)
    worker = payload / "services/media-worker"
    worker.mkdir(exist_ok=True)
    for source in (ROOT / "services/media-worker").glob("*.py"):
        shutil.copy2(source, worker)
    for package in ("ws", "zod"):
        shutil.copytree(ROOT / "node_modules" / package, modules / package)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--media", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--builder", default="electron-builder")
    parser.add_argument("--electron-dist", type=Path)
    args = parser.parse_args()
    suffix = ".exe" if os.name == "nt" else ""
    media = args.media.resolve()
    for file in ("bin/ffmpeg" + suffix, "bin/ffprobe" + suffix, "python/python.exe" if suffix else "python/bin/python3"):
        if not (media / file).is_file():
            parser.error(f"Missing bundled runtime {media / file}")
    with tempfile.TemporaryDirectory(prefix="ave-native-") as temporary:
        work = Path(temporary)
        entry = work / "entry"
        entry.mkdir()
        payload = work / "payload"
        stage(payload)
        sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        (payload / "SOURCE_SHA").write_text(sha + "\n")
        shutil.copy2(HERE / "main.mjs", entry)
        (entry / "package.json").write_text(json.dumps({"name":"ave","productName":"AVE","version":"0.1.0","main":"main.mjs","author":"AVE contributors","description":"AVE desktop video editor"}))
        config = {"appId":"io.github.player-muteki.ave","productName":"AVE","electronVersion":"44.2.0",
                  "directories":{"output":str(args.output.resolve())},"files":["main.mjs","package.json"],
                  "npmRebuild":False, "afterPack":str(HERE / "resources.cjs"),
                  "mac":{"target":"dmg","identity":"-","extendInfo":{"AVESourceCommit":sha}},
                  "win":{"target":"nsis"},"linux":{"target":"AppImage","category":"Video"}}
        if args.electron_dist:
            config["electronDist"] = str(args.electron_dist.resolve())
        config_path = work / "builder.json"
        config_path.write_text(json.dumps(config))
        command = [args.builder, "--projectDir", str(entry), "--config", str(config_path), "--publish", "never"]
        command.append("--arm64" if platform.machine().lower() in ("arm64","aarch64") else "--x64")
        subprocess.run(command, check=True, env={**os.environ, "AVE_PACKAGE_PAYLOAD":str(payload),"AVE_PACKAGE_MEDIA":str(media)})


if __name__ == "__main__":
    main()
