"""Compute one ephemeral SAM2 anchor mask in the daemon's private working directory."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import numpy as np
from PIL import Image
import torch

TINY = "7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69"
REVISION = "2b90b9f5ceec907a1c18123530e92e794ad901a4"


def verified_predictor():
    source = Path(os.environ["VIDEO_EDITOR_SAM2_SOURCE"]).resolve(strict=True)
    weights = Path(os.environ["VIDEO_EDITOR_SAM2_WEIGHTS"]).resolve(strict=True)
    head = subprocess.check_output(["git", "-C", source, "rev-parse", "HEAD"], timeout=10).decode().strip()
    changes = subprocess.check_output(["git", "-C", source, "status", "--porcelain"], timeout=10)
    digest = hashlib.sha256()
    with weights.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 << 20), b""):
            digest.update(chunk)
    if head != REVISION or changes or digest.hexdigest() != TINY:
        raise ValueError("SAM2 source or weights differ from the configured Tiny profile")
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise RuntimeError("SAM2 Tiny preview requires BF16-capable CUDA")
    sys.path.insert(0, str(source))
    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor

    return SAM2ImagePredictor(build_sam2("configs/sam2.1/sam2.1_hiera_t.yaml", str(weights)))


def main():
    with Image.open("frame.png") as frame:
        rgb = np.asarray(frame.convert("RGB"))
    points = json.loads(Path("points.json").read_bytes())
    height, width = rgb.shape[:2]
    if not 1 <= len(points) <= 32 or not any(p["foreground"] for p in points):
        raise ValueError("a foreground point is required")
    for p in points:
        if (type(p["x"]) is not int or type(p["y"]) is not int or type(p["foreground"]) is not bool
                or not 0 <= p["x"] < width or not 0 <= p["y"] < height):
            raise ValueError("invalid point in source raster")
    predictor = verified_predictor()
    with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
        predictor.set_image(rgb)
        masks, scores, _ = predictor.predict(
            point_coords=np.array([(p["x"], p["y"]) for p in points], dtype=np.float32),
            point_labels=np.array([p["foreground"] for p in points], dtype=np.int32),
            multimask_output=True,
        )
    if not np.isfinite(scores).all() or masks.shape != (len(scores), height, width):
        raise RuntimeError("SAM2 returned an invalid label map")
    mask = masks[scores.argmax()] > 0
    overlay = rgb.copy()
    overlay[mask] = rgb[mask] // 2 + np.array([0, 115, 85], np.uint8)
    Image.fromarray(overlay).save("overlay.png")
    label = mask.astype(np.uint8) * 255
    if sys.argv[1:] == ["--save-label"]:
        Path("label.raw").write_bytes(label.tobytes())
    print(json.dumps({"engine": "sam2.1-tiny", "weightsSha256": TINY,
                      "labelSha256": hashlib.sha256(label.tobytes()).hexdigest(),
                      "foregroundPixels": int(mask.sum())}))


if __name__ == "__main__":
    main()
