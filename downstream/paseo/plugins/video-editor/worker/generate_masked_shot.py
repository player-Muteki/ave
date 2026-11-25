"""Generate one nine-frame VACE candidate in the daemon's private job directory."""
import json
import os
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from protected_composite import composite_rgb24
from vace_model import verify_model
from vace_shot import VaceCanvas, generate_shot


def main():
    request = json.loads(Path("request.json").read_text())
    model = Path(os.environ["VIDEO_EDITOR_VACE_MODEL"])
    revision = verify_model(model)
    width, height = request["width"], request["height"]
    source = np.memmap("source.rgb", np.uint8, "r", shape=(9, height, width, 3))
    canvas = VaceCanvas((width, height), (832, 480))
    controls, masks, labels = [], [], []
    for i, frame in enumerate(source):
        label = np.memmap(f"{i}.raw", np.uint8, "r", shape=(height, width))
        control, mask, _ = canvas.condition(frame, label, label != 0)
        controls.append(control)
        masks.append(mask)
        labels.append(label)
    frames, stats = generate_shot(model, Path.cwd(), controls, masks, prompt=request["prompt"],
                                  negative_prompt=request["negativePrompt"], seed=request["seed"], steps=20)
    changed, protected = [], []
    with open("composite.rgb", "wb") as output:
        for frame, generated, label in zip(source, frames, labels, strict=True):
            allowed = label != 0
            result = composite_rgb24(frame, canvas.restore(generated), allowed, label)
            delta = np.any(result != frame, axis=2)
            if np.any(delta & ~allowed):
                raise ValueError("candidate changes pixels outside the approved mask")
            changed.append(int(delta.sum()))
            protected.append(int((~allowed).sum()))
            output.write(result.tobytes())
    if not any(changed):
        raise ValueError("model produced no visible change inside the selected region")
    Path("report.json").write_text(json.dumps({"modelRevision": revision, "steps":20, "seed":request["seed"],
        "changedPixels":changed, "protectedPixels":protected, **stats}))


if __name__ == "__main__":
    main()
