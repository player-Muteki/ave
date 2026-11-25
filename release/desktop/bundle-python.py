"""Install the immutable native Worker interpreter into the desktop's media resources."""
import argparse
import hashlib
import json
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    target = f"{platform.system()}-{platform.machine().lower()}"
    artifacts = json.loads(Path(__file__).with_name("python-lock.json").read_text())
    spec = artifacts[target]
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / "python.tar.gz"
        with urllib.request.urlopen(spec["url"], timeout=120) as source, archive.open("wb") as out:
            shutil.copyfileobj(source, out)
        with archive.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != spec["sha256"]:
                raise ValueError("Python distribution checksum mismatch")
        with tarfile.open(archive) as dist:
            dist.extractall(tmp, filter="data")
        python_dir = Path(tmp) / "python"
        exe = "python.exe" if platform.system() == "Windows" else "bin/python3"
        subprocess.run([str(python_dir / exe), "-I", "-B", "-c", "import fractions, hashlib, json, sqlite3"], check=True)
        shutil.copytree(python_dir, args.output / "python", symlinks=True)


if __name__ == "__main__":
    main()
