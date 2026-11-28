from fractions import Fraction
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest


def test_vace_manifest_contract():
    manifest_path = Path(__file__).resolve().parents[1] / "vace-1.3b.json"
    doc = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert len(doc["revision"]) == 40
    assert "model_index.json" in doc["files"]


def test_daemon_cli_returns_structured_error_on_bad_index(tmp_path: Path):
    cli = Path(__file__).resolve().parents[1] / "daemon_cli.py"
    bad = tmp_path / "bad.json"
    bad.write_text("{}")
    proc = subprocess.run(
        [
            sys.executable,
            "-I",
            "-B",
            str(cli),
            "sampling-map",
            "--index",
            str(bad),
            "--index-sha256",
            "0" * 64,
            "--source-sha256",
            "a" * 64,
            "--stream-uid",
            "v-0",
            "--first",
            "0",
            "--stop",
            "9",
            "--rate",
            "25/1",
        ],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 1
    payload = json.loads(proc.stdout)
    assert "error" in payload


def test_optional_shot_index_when_scenedetect_present():
    pytest.importorskip("scenedetect")
    from shot_index import Observation, detect_shots

    black = np.zeros((16, 16, 3), dtype=np.uint8)
    obs = [Observation(pts=i * 512, duration=512, bgr=black) for i in range(6)]
    shots = detect_shots(obs, Fraction(1, 12800))
    assert len(shots) >= 1
    assert shots[0].first_frame == 0
    assert shots[-1].stop_frame == 6


def test_optional_people_detector_when_onnx_and_cv2_present():
    pytest.importorskip("cv2")
    pytest.importorskip("onnxruntime")
    import people_detector

    assert callable(people_detector.detect_people_candidates)
    assert people_detector.detect_people is people_detector.detect_people_candidates
