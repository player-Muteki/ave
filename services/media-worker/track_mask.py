"""Propagate a verified source-grid label over a daemon-owned sequence of JPEGs."""
import json
from pathlib import Path
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from inspect_mask import verified_predictor
from sam2_shot import track_shot


def main():
    spec = json.loads(Path("request.json").read_bytes())
    count, anchor = spec["count"], spec["anchor"]
    if not 2 <= count <= 81:
        raise ValueError("unsupported shot length")
    with Image.open("frames/00000.jpg") as image:
        width, height = image.size
    label = np.fromfile("anchor.raw", dtype=np.uint8).reshape(height, width)
    predictor = verified_predictor(video=True)
    areas = [None] * count
    for index, mask in track_shot(predictor, Path("frames"), count, [], label_anchor=(anchor, label)):
        mask.tofile(f"labels/{index:05d}.raw")
        with Image.open(f"frames/{index:05d}.jpg") as image:
            rgb = np.array(image.convert("RGB"))
        selected = mask != 0
        areas[index] = int(selected.sum())
        rgb[selected] = rgb[selected] // 2 + np.array([0, 115, 85], dtype=np.uint8)
        thumb = Image.fromarray(rgb)
        thumb.thumbnail((640, 640), Image.Resampling.LANCZOS)
        thumb.save(f"overlay/{index:05d}.png")
    if None in areas:
        raise RuntimeError("incomplete tracking output")
    print(json.dumps(areas))


if __name__ == "__main__":
    main()
