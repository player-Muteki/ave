"""Short-shot sampling in presentation order. No frame-rate estimation or implicit retiming."""
from dataclasses import dataclass
from fractions import Fraction
from hashlib import sha256
from itertools import islice
import json
import re


@dataclass(frozen=True)
class FrameSpan:
    pts: int
    duration: int


@dataclass(frozen=True)
class SamplingMap:
    presentation_index_sha256: str
    source_clock: Fraction
    sample_rate: Fraction
    source_frames: tuple[FrameSpan, ...]
    sample_to_source: tuple[int, ...]

    def source_to_samples(self) -> tuple[tuple[int, ...], ...]:
        groups: list[list[int]] = [[] for _ in self.source_frames]
        for sample, source in enumerate(self.sample_to_source):
            groups[source].append(sample)
        return tuple(tuple(group) for group in groups)

    def validate_output(self, frames: tuple[FrameSpan, ...], clock: Fraction) -> None:
        if not isinstance(clock, Fraction) or clock <= 0 or len(frames) != len(self.sample_to_source):
            raise ValueError("candidate frame count or clock differs from the working grid")
        for i, frame in enumerate(frames):
            if (type(frame.pts) is not int or type(frame.duration) is not int or
                    frame.pts * clock * self.sample_rate != i or
                    frame.duration * clock * self.sample_rate != 1):
                raise ValueError("candidate PTS or duration differs from the working grid")

    def rebind_unchanged(self, frames: tuple[FrameSpan, ...], clock: Fraction) -> tuple[FrameSpan, ...]:
        self.validate_output(frames, clock)
        if self.sample_to_source != tuple(range(len(self.source_frames))):
            raise ValueError("duplicated or omitted source frames require an explicit time mapping decision")
        return self.source_frames


def sample_shot(frames: tuple[FrameSpan, ...], source_clock: Fraction, sample_rate: Fraction,
                presentation_index_sha256: str) -> SamplingMap:
    """Sample at each CFR interval's left edge, inside a fully covered, half-open shot.

    Ordinals are local to this shot in the bound presentation index. The last source duration
    determines the exclusive end; a fractional last sample is never silently padded or dropped.
    """
    frames = tuple(frames)
    if not re.fullmatch(r"[a-f0-9]{64}", presentation_index_sha256):
        raise ValueError("invalid presentation index digest")
    if (not frames or not isinstance(source_clock, Fraction) or source_clock <= 0 or
            not isinstance(sample_rate, Fraction) or sample_rate <= 0):
        raise ValueError("a shot and exact positive clocks are required")
    for i, frame in enumerate(frames):
        if type(frame.pts) is not int or type(frame.duration) is not int or frame.duration <= 0:
            raise ValueError("frame timing requires integer PTS and positive duration")
        if i and frame.pts != frames[i-1].pts + frames[i-1].duration:
            raise ValueError("source presentation intervals overlap or leave a gap")
    span = frames[-1].pts + frames[-1].duration - frames[0].pts
    count = span * source_clock * sample_rate
    if count.denominator != 1 or count > 4096:
        raise ValueError("shot does not fit an integral working grid of at most 4096 samples")
    selected = []
    src = 0
    step = 1 / (sample_rate * source_clock)
    for sample in range(int(count)):
        tick = frames[0].pts + sample * step
        while src + 1 < len(frames) and frames[src + 1].pts <= tick:
            src += 1
        selected.append(src)
    return SamplingMap(presentation_index_sha256, source_clock, sample_rate, frames, tuple(selected))


def sample_index_shot(index_bytes: bytes, *, index_sha256: str, source_sha256: str,
                      stream_uid: str, first: int, stop: int, rate: Fraction) -> SamplingMap:
    """Read a stream-local [first, stop) slice from the daemon's immutable v2 index bytes."""
    if sha256(index_bytes).hexdigest() != index_sha256:
        raise ValueError("presentation index digest mismatch")
    if type(first) is not int or type(stop) is not int or not 0 <= first < stop:
        raise ValueError("invalid source frame range")
    doc = json.loads(index_bytes)
    if (not re.fullmatch(r"[a-f0-9]{64}", source_sha256) or doc.get("sourceSha256") != source_sha256 or
            doc.get("schemaVersion") != "video.presentation-index/v2"):
        raise ValueError("wrong index version or source digest")
    streams = [s for s in doc["streams"] if s["streamUid"] == stream_uid]
    if len(streams) != 1:
        raise ValueError("missing or ambiguous source stream")
    stream = streams[0]
    def tick(s):
        if not isinstance(s, str) or not re.fullmatch(r"-?[0-9]+", s):
            raise ValueError("presentation index must contain decimal integer strings")
        return int(s)
    base = stream["timeBase"]
    numerator, denominator = tick(base["num"]), tick(base["den"])
    if min(numerator, denominator) <= 0:
        raise ValueError("invalid source time base")
    rows = (r for r in doc["frames"] if r["stream_index"] == stream["streamIndex"] and r["media_type"] == "video")
    spans = tuple(FrameSpan(tick(r.get("pts")), tick(r.get("duration"))) for r in islice(rows, first, stop))
    if len(spans) != stop - first:
        raise ValueError("source frame range extends outside indexed video")
    return sample_shot(spans, Fraction(numerator, denominator), rate, index_sha256)
