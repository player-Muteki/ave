"""Verify the installed VACE snapshot against the packaged file manifest."""
import hashlib
import json
from pathlib import Path


def digest(path, algorithm="sha256", prefix=b""):
    result = hashlib.new(algorithm, prefix)
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 << 20), b""):
            result.update(block)
    return result.hexdigest()


def verify_model(model):
    lock = json.loads(Path(__file__).with_name("vace-1.3b.json").read_bytes())
    installed = {p.relative_to(model).as_posix() for p in model.rglob("*") if p.is_file()}
    if installed != set(lock["files"]):
        raise ValueError("model snapshot file list mismatch")
    for name, entry in lock["files"].items():
        path = model / name
        if path.stat().st_size != entry["bytes"]:
            raise ValueError(f"model file size mismatch: {name}")
        if "sha256" in entry:
            valid = digest(path) == entry["sha256"]
        else:
            header = f"blob {entry['bytes']}\0".encode()
            valid = digest(path, "sha1", header) == entry["gitBlobSha1"]
        if not valid:
            raise ValueError(f"model digest mismatch: {name}")
    return lock["revision"]
