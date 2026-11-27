# AVE Media Worker (`services/media-worker/`)

Isolated Python worker kernels invoked exclusively by `@ave/daemon` (`shell: false`, `python3 -I -B`, pinned CAS index bytes and staged temporary working directories). This worker has zero direct access to SQLite, CAS database records, RPC sockets, or approvals.

## Third-Party Dependency & License Inventory

Standard open-source dependencies (permitted per ADR 012):
- `numpy` (BSD-3-Clause) — integer/rational frame sampling, binary mask verification, protected compositing
- `Pillow` (HPND) — anchor overlay thumbnail generation
- `scenedetect` (BSD-3-Clause, optional) — CPU adaptive shot detection (`shot_index.py`)
- `opencv-python-headless` (Apache-2.0, optional) — BGR frame utilities & person detection preprocessing
- `onnxruntime` (MIT, optional) — CPU person detector (`people_detector.py`)
- `torch` / `sam2` / `diffusers` / `transformers` (optional GPU runtimes) — pinned SAM2.1 Tiny & Wan2.1 VACE 1.3B kernels (`inspect_mask.py`, `track_mask.py`, `generate_masked_shot.py`)

Removed frameworks: zero Paseo, Pi, or FilmCraft dependencies or adapters are present.

## Verification

```bash
pytest services/media-worker/tests
```

Optional ML/GPU tests are gated via `pytest.importorskip` when GPU packages or pinned weights are absent on CPU-only hosts.
