"""Verify the installer and its source revision inside a downloaded Actions artifact."""
import argparse
import hashlib
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("source_sha")
    args = parser.parse_args()
    if (args.directory / "SOURCE_SHA").read_text().strip() != args.source_sha:
        raise ValueError("Installer source revision differs from the requested build")
    expected, name = (args.directory / "SHA256SUMS").read_text().strip().split("  ")
    if name != Path(name).name or not name.startswith("AVE-"):
        raise ValueError("Unexpected installer filename")
    with (args.directory / name).open("rb") as source:
        actual = hashlib.file_digest(source, "sha256").hexdigest()
    if actual != expected:
        raise ValueError(f"Installer hash mismatch for {name}")
    print(f"{name}  {actual}")


if __name__ == "__main__":
    main()
