from fractions import Fraction
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

from sampling_map import FrameSpan, sample_index_shot, sample_shot


def _build_index_bytes(frame_count: int = 12):
    source_sha = "a" * 64
    frames = [
        {
            "stream_index": 0,
            "media_type": "video",
            "pts": str(i * 512),
            "duration": "512",
        }
        for i in range(frame_count)
    ]
    doc = {
        "schemaVersion": "video.presentation-index/v2",
        "sourceSha256": source_sha,
        "streams": [
            {
                "streamUid": "v-0",
                "streamIndex": 0,
                "kind": "video",
                "timeBase": {"num": "1", "den": "12800"},
            }
        ],
        "frames": frames,
    }
    raw = json.dumps(doc).encode("utf-8")
    return raw, hashlib.sha256(raw).hexdigest(), source_sha


def test_sample_shot_cfr_exact_mapping():
    spans = tuple(FrameSpan(pts=i * 512, duration=512) for i in range(9))
    idx_hash = "b" * 64
    smap = sample_shot(spans, Fraction(1, 12800), Fraction(25, 1), idx_hash)
    assert smap.sample_to_source == tuple(range(9))
    assert smap.source_to_samples() == tuple((i,) for i in range(9))


def test_sample_index_shot_and_cli(tmp_path: Path):
    raw, idx_hash, src_hash = _build_index_bytes()
    smap = sample_index_shot(
        raw,
        index_sha256=idx_hash,
        source_sha256=src_hash,
        stream_uid="v-0",
        first=1,
        stop=10,
        rate=Fraction(25, 1),
    )
    assert len(smap.sample_to_source) == 9

    index_file = tmp_path / "index.json"
    index_file.write_bytes(raw)
    cli = Path(__file__).resolve().parents[1] / "daemon_cli.py"

    sup = subprocess.run(
        [sys.executable, "-I", "-B", str(cli), "support"],
        capture_output=True,
        text=True,
        check=True,
    )
    sup_json = json.loads(sup.stdout)
    assert sup_json["numpy"] is True

    out = subprocess.run(
        [
            sys.executable,
            "-I",
            "-B",
            str(cli),
            "sampling-map",
            "--index",
            str(index_file),
            "--index-sha256",
            idx_hash,
            "--source-sha256",
            src_hash,
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
        check=True,
    )
    doc = json.loads(out.stdout)
    assert doc["sample_rate"] == "25/1"
    assert doc["sample_to_source"] == list(range(9))


def test_sample_index_rejects_digest_mismatch():
    raw, _idx_hash, src_hash = _build_index_bytes()
    with pytest.raises(ValueError, match="digest mismatch"):
        sample_index_shot(
            raw,
            index_sha256="0" * 64,
            source_sha256=src_hash,
            stream_uid="v-0",
            first=0,
            stop=9,
            rate=Fraction(25, 1),
        )
