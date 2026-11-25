"""E06: check FFmpeg-only stream-copy preservation using synthetic local media."""

from fractions import Fraction
from hashlib import sha256
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory


def run(*args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, timeout=60).stdout


def ffmpeg(*args):
    return run("ffmpeg", "-nostdin", "-v", "error", "-xerror", *args)


def measure(path):
    probe = json.loads(run("ffprobe", "-v", "error", "-show_streams", "-show_packets",
                           "-show_data_hash", "sha256", "-of", "json", path))
    streams = []
    for s in probe["streams"]:
        timebase = Fraction(s["time_base"])
        packets = [(int(p["pts"]) * timebase, int(p["duration"]) * timebase, p["data_hash"])
                   for p in probe["packets"] if p["stream_index"] == s["index"]]
        streams.append((s["codec_type"], s["codec_name"], packets))
    # Decode every video and audio stream, not just the default track. Subtitle
    # content and cue duration are covered by packet payload hashes and timings.
    raw = ffmpeg("-i", path, "-map", "0:v", "-map", "0:a", "-fps_mode", "passthrough",
                 "-f", "streamhash", "-hash", "sha256", "-")
    # Newer FFmpeg streamhash (v2) emits '#' header lines before the per-stream
    # checksum rows; keep only the checksum rows so the count and the copy/shift
    # comparisons stay stable across FFmpeg versions.
    decoded = b"".join(line for line in raw.splitlines(keepends=True) if not line.startswith(b"#"))
    return streams, decoded


def check(root):
    source = root / "非零 PTS.mkv"
    sub = root / "cue.srt"
    sub.write_text("1\n00:00:00,200 --> 00:00:00,600\nMarker\n", encoding="utf-8")
    ffmpeg("-f", "lavfi", "-i", "testsrc2=size=96x64:rate=25:duration=1",
           "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
           "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=1",
           "-i", sub, "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:s",
           "-vf", "select='not(eq(mod(n,4),1))'", "-fps_mode", "vfr", "-c:v", "ffv1",
           "-c:a", "pcm_s16le", "-c:s", "srt", "-output_ts_offset", "2", source)
    before = sha256(source.read_bytes()).digest()
    streams, decoded = measure(source)
    assert [s[:2] for s in streams] == [("video", "ffv1"), ("audio", "pcm_s16le"),
                                         ("audio", "pcm_s16le"), ("subtitle", "subrip")]
    pts = [p[0] for p in streams[0][2]]
    assert len(pts) == 19 and pts[0] == 2
    assert {b - a for a, b in zip(pts, pts[1:])} == {Fraction(1, 25), Fraction(2, 25)}
    assert streams[-1][2][0][:2] == (Fraction(11, 5), Fraction(2, 5))
    assert len(decoded.splitlines()) == 3
    good = root / "copy.mkv"
    ffmpeg("-copyts", "-i", source, "-map", "0", "-c", "copy", good)
    assert measure(good) == (streams, decoded), "stream-copy changed media or timeline"
    shifted = root / "shifted.mkv"
    ffmpeg("-i", source, "-map", "0", "-c", "copy", shifted)
    shifted_streams, shifted_decoded = measure(shifted)
    assert shifted_decoded == decoded and shifted_streams[0][2][0][0] == 0
    assert shifted_streams != streams, "failed to distinguish lost PTS offset"
    missing = root / "missing audio.mkv"
    ffmpeg("-copyts", "-i", source, "-map", "0", "-map", "-0:a:1", "-c", "copy", missing)
    missing_streams, _ = measure(missing)
    assert [s[0] for s in missing_streams] == ["video", "audio", "subtitle"]
    assert sha256(source.read_bytes()).digest() == before
    print("PASS: 19 VFR frames; start 2 s; steps 40/80 ms; two PCM tracks; one timed cue.")
    print("Stream copy preserved packet timing, payload and decoded A/V; both negative controls distinguished.")


def check_preview_clock(root):
    source = root / "25fps.mp4"
    ffmpeg("-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25:duration=2",
           "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
           "-c:v", "libx264", "-c:a", "aac", source)
    before = sha256(source.read_bytes()).digest()
    trim = "start=0.120:duration=1.280"
    scale = "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2"
    for forced in (True, False):
        out = root / ("forced.mp4" if forced else "source-clock.mp4")
        vf = f"trim={trim},setpts=PTS-STARTPTS,{scale}," + ("fps=30," if forced else "") + "setsar=1"
        ffmpeg("-i", source, "-map", "0:v:0", "-vf", vf, "-fps_mode", "vfr",
               *([] if forced else ["-enc_time_base:v", "filter"]), "-c:v", "libx264",
               "-pix_fmt", "yuv420p", "-map", "0:a:0", "-af", f"atrim={trim},asetpts=PTS-STARTPTS",
               "-c:a", "aac", "-ar", "48000", out)
        ffmpeg("-i", out, "-map", "0", "-f", "null", "-")
        probe = json.loads(run("ffprobe", "-v", "error", "-show_streams", "-show_frames",
                               "-show_entries", "stream=index,codec_type,time_base,start_pts,duration_ts:frame=stream_index,pts",
                               "-of", "json", out))
        v, a = probe["streams"]
        assert (v["codec_type"], a["codec_type"], v["start_pts"], a["start_pts"]) == ("video", "audio", 0, 0)
        clock = Fraction(v["time_base"])
        pts = [int(f["pts"]) * clock for f in probe["frames"] if f["stream_index"] == v["index"]]
        assert int(a["duration_ts"]) * Fraction(a["time_base"]) == Fraction(32, 25)
        if forced:
            assert len(pts) == 38 and int(v["duration_ts"]) * clock == Fraction(19, 15)
        else:
            assert pts == [Fraction(i, 25) for i in range(32)]
            assert int(v["duration_ts"]) * clock == Fraction(32, 25)
    assert sha256(source.read_bytes()).digest() == before
    print("PASS: [0.120, 1.400) source-clock preview: 32 frames, 1.280 s A/V; forced 30 fps gives 38 frames, short video.")


if __name__ == "__main__":
    with TemporaryDirectory(prefix="video-timebase-") as directory:
        check(Path(directory))
        check_preview_clock(Path(directory))
