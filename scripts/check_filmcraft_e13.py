"""E13: dual-run the pinned FilmCraft CLI against FFmpeg on real media samples.

Requires a filmcraft checkout at the pinned commit (scripts/bootstrap_references.py
--restore) with the CLI built (`cargo build --locked -p filmcraft-cli`), plus
ffmpeg/ffprobe on PATH or via --ffmpeg/--ffprobe. Asserts the whitelist op
(single-segment trim + h264/aac export, audio-only export) conforms; records the
known non-conformant surfaces (VFR timing, subtitle/multi-audio passthrough) that
keep FilmCraft a constrained backend per ADR 005/006/011.

The pinned commit is source-review-only (research/filmcraft-ba6fe105-to-7b8e522d.md):
the upstream is NOT adopted as the product backend. The dual-run remains a research
probe; scripts/check_filmcraft_pin.py guards the pin and the non-adoption verdict.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
PIN = json.loads((ROOT / "research" / "upstream.json").read_text(encoding="utf-8"))
FILMCRAFT_PIN = next(r for r in PIN["references"] if r["path"] == "filmcraft")["commit"]

RANGE_START, RANGE_END = 0.5, 2.0


def run(*args, timeout=600):
    return subprocess.run([str(a) for a in args], capture_output=True, text=True, timeout=timeout)


def probe(ffprobe, path):
    r = run(ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", path)
    if r.returncode:
        return {"error": r.stderr.strip()}
    d = json.loads(r.stdout)
    return {
        "duration": d.get("format", {}).get("duration"),
        "streams": [
            {k: s.get(k) for k in ("codec_type", "codec_name", "avg_frame_rate", "nb_frames",
                                   "sample_rate", "channels", "duration")}
            for s in d.get("streams", [])
        ],
    }


def decode_errors(ffmpeg, path):
    r = run(ffmpeg, "-nostdin", "-v", "error", "-xerror", "-i", path,
            "-map", "0:v?", "-map", "0:a?", "-f", "null", "-")
    errors = r.stderr.splitlines()
    if r.returncode:
        errors.append(f"decoder exited {r.returncode}")
    return errors


def media_failures(findings):
    """Check each side against the fixture, not just against the other exporter."""
    failures = []
    for name in ("cfr", "vfr", "multistream", "audio_wav", "audio_m4a"):
        audio_only = name.startswith("audio_")
        for side in ("fc", "ff"):
            rec = findings[name][side]
            probe_result = rec["probe"]
            streams = probe_result.get("streams", [])
            audio = [s for s in streams if s["codec_type"] == "audio"]
            video = [s for s in streams if s["codec_type"] == "video"]
            label = f"{name}/{side}"
            if rec["rc"] or probe_result.get("error") or rec["decode_errors"]:
                failures.append(f"{label}: export, probe or decode failed")
            if not audio or bool(video) == audio_only:
                failures.append(f"{label}: missing or unexpected A/V streams")
            if name == "cfr" and (len(video) != 1 or video[0].get("codec_name") != "h264"
                                  or video[0].get("nb_frames") != "38"
                                  or video[0].get("avg_frame_rate") != "25/1"):
                failures.append(f"{label}: unexpected CFR video")
            if name == "cfr" or audio_only:
                rate = "44100" if name == "audio_m4a" else "48000"
                codec = "pcm_s16le" if name == "audio_wav" else "aac"
                expected = 1.3 if audio_only else 1.5
                try:
                    duration = float(audio[0]["duration"])
                except (IndexError, KeyError, ValueError, TypeError):
                    duration = 0
                if (len(audio) != 1 or audio[0].get("sample_rate") != rate
                        or audio[0].get("codec_name") != codec or not abs(duration - expected) <= 0.05):
                    failures.append(f"{label}: unexpected audio profile or duration")
    return failures


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--cli", default=ROOT / "filmcraft" / "target" / "debug" / "filmcraft-cli")
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--ffprobe", default="ffprobe")
    args = ap.parse_args()
    cli, ffmpeg, ffprobe = Path(args.cli), args.ffmpeg, args.ffprobe
    fc_root = ROOT / "filmcraft"
    head = run("git", "-C", fc_root, "rev-parse", "HEAD").stdout.strip()
    if head != FILMCRAFT_PIN:
        print(f"filmcraft checkout is {head}, expected pinned {FILMCRAFT_PIN}", file=sys.stderr)
        return 1
    if not cli.exists():
        print(f"CLI binary missing: {cli} (build with `cargo build --locked -p filmcraft-cli`)",
              file=sys.stderr)
        return 1

    findings = {}
    with tempfile.TemporaryDirectory(prefix="e13-") as tmp:
        tmp = Path(tmp)
        samples, work = tmp / "samples", tmp / "work"
        samples.mkdir(); work.mkdir()

        def ff(*a):
            return run(ffmpeg, "-nostdin", "-y", "-v", "error", *a)

        ff("-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=3",
           "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2",
           samples / "cfr.mp4")
        for rate in (25, 30, 24):
            ff("-f", "lavfi", "-i", f"testsrc2=size=320x180:rate={rate}:duration=1",
               "-c:v", "libx264", "-pix_fmt", "yuv420p", samples / f"seg{rate}.mp4")
        (samples / "concat.txt").write_text(
            "".join(f"file 'seg{r}.mp4'\n" for r in (25, 30, 24)), encoding="utf-8")
        ff("-f", "concat", "-safe", "0", "-i", samples / "concat.txt",
           "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=3",
           "-c:v", "copy", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", samples / "vfr.mp4")
        (samples / "subs.srt").write_text(
            "1\n00:00:00,000 --> 00:00:01,000\nhello\n\n2\n00:00:01,000 --> 00:00:03,000\nworld\n",
            encoding="utf-8")
        ff("-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=3",
           "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
           "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100:duration=3",
           "-i", samples / "subs.srt", "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3",
           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a:0", "aac", "-ar:a:0", "48000",
           "-c:a:1", "aac", "-ar:a:1", "44100", "-c:s", "mov_text", samples / "multistream.mp4")
        ff("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
           "-ac", "2", "-c:a", "pcm_s16le", samples / "audio.wav")
        ff("-f", "lavfi", "-i", "sine=frequency=550:sample_rate=44100:duration=2",
           "-c:a", "aac", samples / "audio.m4a")

        def fc(*a, timeout=600):
            return run(cli, *a, timeout=timeout)

        def fc_trim_export(sample, out, fmt="h264", start=RANGE_START, end=RANGE_END, extra=()):
            project = out.with_suffix(".fcproj")
            shutil.rmtree(project, ignore_errors=True)
            r = fc("--save-as", project, "exec", "file.import", json.dumps({"paths": [str(sample)]}))
            if r.returncode:
                return {"rc": r.returncode, "error": r.stderr.strip()}
            r = fc("--project", project, "--save", "exec", "file.newSequence",
                   json.dumps({"name": "seq", "fromItems": [1]}))
            if r.returncode:
                return {"rc": r.returncode, "error": r.stderr.strip()}
            r = fc("--project", project, "export", out, "--format", fmt,
                   "--start", str(start), "--end", str(end), *extra)
            return {"rc": r.returncode, "stderr_tail": r.stderr.strip()[-300:]}

        def ff_trim(sample, out, acodec="aac"):
            r = ff("-ss", str(RANGE_START), "-to", str(RANGE_END), "-i", sample,
                   "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", acodec,
                   "-ar", "48000", "-ac", "2", out)
            return {"rc": r.returncode, "stderr": r.stderr.strip()[-300:]}

        # Whitelist op: single-segment trim + h264/aac export on CFR/VFR/multi-stream.
        for name in ("cfr", "vfr", "multistream"):
            fc_out, ff_out = work / f"{name}_fc.mp4", work / f"{name}_ff.mp4"
            fc_rec, ff_rec = fc_trim_export(samples / f"{name}.mp4", fc_out), ff_trim(samples / f"{name}.mp4", ff_out)
            findings[name] = {
                "fc": {**fc_rec, "probe": probe(ffprobe, fc_out), "decode_errors": decode_errors(ffmpeg, fc_out)},
                "ff": {**ff_rec, "probe": probe(ffprobe, ff_out), "decode_errors": decode_errors(ffmpeg, ff_out)},
            }

        # Audio-only exports.
        for name, sample, fmt, acodec in (("wav", samples / "audio.wav", "wav", "pcm_s16le"),
                                          ("m4a", samples / "audio.m4a", "aac", "aac")):
            ext = fmt
            fc_out, ff_out = work / f"audio_{name}_fc.{ext}", work / f"audio_{name}_ff.{ext}"
            fc_rec = fc_trim_export(sample, fc_out, fmt=fmt, start=0.2, end=1.5)
            ff_rec = ff("-ss", "0.2", "-to", "1.5", "-i", sample, "-c:a", acodec, ff_out)
            findings[f"audio_{name}"] = {
                "fc": {**fc_rec, "probe": probe(ffprobe, fc_out), "decode_errors": decode_errors(ffmpeg, fc_out)},
                "ff": {"rc": ff_rec.returncode, "probe": probe(ffprobe, ff_out),
                       "decode_errors": decode_errors(ffmpeg, ff_out)},
            }

        # kill/restart: project must survive kill -9 mid-export and re-export cleanly.
        kill_proj = work / "kill.fcproj"
        fc("--save-as", kill_proj, "exec", "file.import", json.dumps({"paths": [str(samples / "cfr.mp4")]}))
        fc("--project", kill_proj, "--save", "exec", "file.newSequence", json.dumps({"name": "seq", "fromItems": [1]}))
        script = work / "kill.jsonl"
        script.write_text(json.dumps({"id": "file.exportMedia", "params": {
            "path": str(work / "kill_out.mp4"), "format": "h264", "wait": True}}) + "\n", encoding="utf-8")
        proc = subprocess.Popen([str(cli), "--project", kill_proj, "--save", "run", script],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        time.sleep(0.35)
        proc.kill()
        proc.wait(timeout=30)
        insp = json.loads(fc("--project", kill_proj, "inspect", "project").stdout)
        reexp = fc("--project", kill_proj, "export", work / "kill_reexport.mp4", "--format", "h264")
        findings["kill_restart"] = {
            "killed_rc": proc.returncode, "revision_after_kill": insp.get("revision"),
            "dirty_after_kill": insp.get("dirty"), "reexport_rc": reexp.returncode,
            "reexport_probe": probe(ffprobe, work / "kill_reexport.mp4") if reexp.returncode == 0 else None,
        }

        # Offline media: placeholder render must fail closed unless explicitly allowed.
        off_proj = work / "offline.fcproj"
        fc("--save-as", off_proj, "exec", "file.import", json.dumps({"paths": [str(samples / "cfr.mp4")]}))
        fc("--project", off_proj, "--save", "exec", "file.newSequence", json.dumps({"name": "seq", "fromItems": [1]}))
        moved = samples / "cfr_moved.mp4"
        shutil.move(samples / "cfr.mp4", moved)
        try:
            r_off = fc("--project", off_proj, "export", work / "offline_out.mp4", "--format", "h264")
            r_allow = fc("--project", off_proj, "export", work / "offline_allow.mp4",
                         "--format", "h264", "--allow-offline")
        finally:
            shutil.move(moved, samples / "cfr.mp4")
        findings["offline"] = {
            "rc_without_allow": r_off.returncode,
            "offline_media_reported": "offlineMedia" in r_off.stdout,
            "rc_with_allow": r_allow.returncode,
        }

    failures = media_failures(findings)
    kr = findings["kill_restart"]
    if kr["killed_rc"] != -9 or kr["revision_after_kill"] is None or kr["reexport_rc"] != 0:
        failures.append(f"kill_restart: {kr}")
    off = findings["offline"]
    if off["rc_without_allow"] != 1 or not off["offline_media_reported"] or off["rc_with_allow"] != 0:
        failures.append(f"offline: {off}")

    if failures:
        print("E13 FAIL:", file=sys.stderr)
        for f in failures:
            print(f"- {f}", file=sys.stderr)
        return 1

    vfr_fc = next(s for s in findings["vfr"]["fc"]["probe"]["streams"] if s["codec_type"] == "video")
    vfr_ff = next(s for s in findings["vfr"]["ff"]["probe"]["streams"] if s["codec_type"] == "video")
    ms_fc_streams = [s["codec_type"] for s in findings["multistream"]["fc"]["probe"]["streams"]]
    print(json.dumps({
        "build": {"cli": str(cli), "filmcraft_head": head,
                  "ffmpeg": run(ffmpeg, "-version").stdout.splitlines()[0]},
        "vfr": {"filmcraft": vfr_fc, "ffmpeg": vfr_ff,
                "note": "FilmCraft conforms VFR to sequence CFR; source PTS not preserved"},
        "multistream_fc_streams": ms_fc_streams,
        "kill_restart": kr, "offline": off,
    }, indent=2, ensure_ascii=False))
    print("E13 PASS: whitelist trim/export + audio conform; VFR normalized to sequence CFR and "
          "subtitle/multi-audio not passthrough (kept out of the FilmCraft whitelist per ADR 005/006/011)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
