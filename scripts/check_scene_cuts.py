"""Real PySceneDetect + FFmpeg acceptance for the worker's presentation-tick cut kernel."""
from fractions import Fraction
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
REFERENCE = ROOT / "references/pyscenedetect-verified"
PIN = "a696070d1a30d81b35ba9aff89de50eb80696f04"


def run(*args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, timeout=60).stdout


def check(root):
    # `--no-lazy-fetch` needs git >= 2.36; on older git the flag is a usage error.
    # The pinned HEAD commit is present in the checkout, so `rev-parse HEAD` reads
    # it without any blob fetch; the clean-tree assertion below still guards drift.
    assert run("git", "-C", REFERENCE, "rev-parse", "HEAD").decode().strip() == PIN
    assert not run("git", "-C", REFERENCE, "status", "--porcelain")
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(REFERENCE))
    sys.path.insert(0, str(ROOT / "vendor/paseo/plugins/video-editor/worker"))
    import numpy as np
    import scenedetect
    from shot_index import Observation, Shot, detect_shots

    assert Path(scenedetect.__file__).resolve().is_relative_to(REFERENCE)
    source = root / "cut.mkv"
    run("ffmpeg", "-nostdin", "-v", "error", "-xerror", "-f", "lavfi", "-i",
        "color=black:size=96x64:rate=25:duration=2", "-vf",
        "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='gte(n,25)',select='not(eq(mod(n,4),1))'",
        "-fps_mode", "vfr", "-c:v", "ffv1", "-output_ts_offset", "2", source)
    digest = sha256(source.read_bytes()).digest()
    probe = json.loads(run("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_streams", "-show_frames",
                           "-show_entries", "stream=time_base:frame=pts,duration", "-of", "json", source))
    base = Fraction(probe["streams"][0]["time_base"])
    raw = run("ffmpeg", "-nostdin", "-v", "error", "-xerror", "-i", source, "-map", "0:v:0", "-fps_mode", "passthrough",
              "-pix_fmt", "bgr24", "-f", "rawvideo", "-")
    images = np.frombuffer(raw, dtype=np.uint8).reshape(-1,64,96,3)
    rows = [Observation(int(f["pts"]), int(f["duration"]), img) for f, img in zip(probe["frames"], images, strict=True)]
    assert len(rows) == 37
    assert {base*(b.pts-a.pts) for a,b in zip(rows,rows[1:])} == {Fraction(1,25),Fraction(2,25)}
    cut = next(i for i,f in enumerate(rows) if f.bgr[0,0,0] > 200)
    assert cut == 19 and rows[cut].pts*base == Fraction(76,25)
    shots = detect_shots(rows, base)
    assert shots == [Shot(0,cut,rows[0].pts,rows[cut].pts), Shot(cut,len(rows),rows[cut].pts,rows[-1].pts+rows[-1].duration)]
    assert shots[0].start_pts*base == 2 and shots[-1].stop_pts*base == Fraction(99,25)
    assert len(detect_shots(rows[:cut], base)) == 1
    try:
        detect_shots([rows[0], rows[0]], base)
    except ValueError as error:
        assert "non-increasing" in str(error)
    else:
        raise AssertionError("duplicate source timestamps were accepted")
    assert sha256(source.read_bytes()).digest() == digest
    print(f"PASS {PIN[:8]}: {len(rows)} VFR frames; cut at ordinal {cut}, {rows[cut].pts} ticks @ {base}; shots {shots}; no-cut and duplicate-PTS controls passed.")


if __name__ == "__main__":
    with TemporaryDirectory(prefix="scene-cut-qa-") as temp:
        check(Path(temp))
