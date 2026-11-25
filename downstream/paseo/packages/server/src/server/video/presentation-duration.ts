import type { Rational, SourceAsset, StreamDescriptor } from "#video-editor/contracts/v1";
import { editorFailure } from "./errors.js";

export interface FrameIndex {
  schemaVersion?: string;
  sourceSha256?: string;
  streams?: Pick<StreamDescriptor, "streamIndex" | "streamUid" | "timeBase">[];
  frames: { stream_index: number; media_type: string; pts?: string; duration?: string; pkt_duration?: string }[];
}

interface FrameSpan {
  first: bigint;
  end: bigint;
}

/** ffprobe writes the demuxer's start_time as decimal seconds at microsecond precision. */
export function probeStartTime(seconds?: string): Rational | undefined {
  const match = /^(-?)([0-9]+)(?:\.([0-9]{1,6}))?$/.exec(seconds ?? "");
  if (!match) return undefined;
  const fraction = match[3] ?? "";
  return {
    num: BigInt(match[1]! + match[2]! + fraction).toString(),
    den: (10n ** BigInt(fraction.length)).toString(),
  };
}

/** Some demuxers report an absolute end as format.duration when playback starts away from zero. */
export function playbackDurationSeconds(
  header: string | undefined,
  origin: Rational | undefined,
  streams: { kind: string; timeBase: Rational; startPts?: string; durationTicks?: string }[],
): string | null {
  if (!origin || BigInt(origin.num) === 0n) return header ?? null;
  const media = streams.filter(stream => stream.kind === "audio" || stream.kind === "video");
  if (!media.length) return null;
  let latest = 0n;
  for (const stream of media) {
    if (stream.startPts === undefined || stream.durationTicks === undefined) return null;
    const endTicks = BigInt(stream.startPts) + BigInt(stream.durationTicks);
    const denominator = BigInt(stream.timeBase.den) * BigInt(origin.den);
    const elapsed = endTicks * BigInt(stream.timeBase.num) * BigInt(origin.den)
      - BigInt(origin.num) * BigInt(stream.timeBase.den);
    const micros = (elapsed * 1_000_000n + denominator / 2n) / denominator;
    if (micros > latest) latest = micros;
  }
  return `${latest / 1_000_000n}.${(latest % 1_000_000n).toString().padStart(6, "0")}`;
}

/** Extent of indexed decoded frames, in the bound stream's own ticks. */
export function presentationSpans(
  index: FrameIndex,
  asset: SourceAsset,
  streams: StreamDescriptor[],
) {
  const spans = new Map<number, FrameSpan>();
  if (streams.length === 0) return spans;

  if (index.schemaVersion !== "video.presentation-index/v2") return spans;
  if (index.sourceSha256 !== asset.original.sha256)
    editorFailure("ARTIFACT_HASH_MISMATCH", "Source index mismatch");
  if (!Array.isArray(index.streams) || !Array.isArray(index.frames))
    editorFailure("SCHEMA_UNSUPPORTED", "Incomplete v2 presentation index");
  const selected = new Map<number, StreamDescriptor["kind"]>();
  for (const stream of streams) {
    const clock = index.streams.find(s => s.streamIndex === stream.streamIndex);
    if (clock?.streamUid === stream.streamUid && clock.timeBase?.num === stream.timeBase.num &&
        clock.timeBase?.den === stream.timeBase.den)
      selected.set(stream.streamIndex, stream.kind);
  }
  for (const frame of index.frames) {
    const id = frame.stream_index;
    if (!selected.has(id)) continue;
    const duration = frame.duration ?? frame.pkt_duration;
    if (frame.media_type !== selected.get(id) || typeof frame.pts !== "string" || !/^-?\d+$/.test(frame.pts) ||
        typeof duration !== "string" || !/^[1-9]\d*$/.test(duration)) {
      // Omitting any unmeasured frame could shorten the reported extent.
      selected.delete(id);
      spans.delete(id);
      continue;
    }
    const pts = BigInt(frame.pts);
    const end = pts + BigInt(duration);
    const span = spans.get(id);
    if (!span) spans.set(id, { first: pts, end });
    else {
      if (pts < span.first) span.first = pts;
      if (end > span.end) span.end = end;
    }
  }
  return spans;
}
