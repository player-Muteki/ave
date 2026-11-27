import {
  AnalysisRateSchema,
  editorFailure,
  type Rational,
  type SourceAsset,
  type StreamDescriptor,
} from "@ave/contracts";

export interface FrameIndex {
  schemaVersion?: string;
  sourceSha256?: string;
  streams?: Pick<StreamDescriptor, "streamIndex" | "streamUid" | "timeBase">[];
  frames: {
    stream_index: number;
    media_type: string;
    pts?: string;
    duration?: string;
    pkt_duration?: string;
  }[];
}

export interface FrameSpan {
  first: bigint;
  end: bigint;
}

export function rationalEquals(a: Rational, b: Rational): boolean {
  return BigInt(a.num) * BigInt(b.den) === BigInt(b.num) * BigInt(a.den);
}

export function rationalAdd(a: Rational, b: Rational): Rational {
  return {
    num: (BigInt(a.num) * BigInt(b.den) + BigInt(b.num) * BigInt(a.den)).toString(),
    den: (BigInt(a.den) * BigInt(b.den)).toString(),
  };
}

export function rationalSub(a: Rational, b: Rational): Rational {
  return {
    num: (BigInt(a.num) * BigInt(b.den) - BigInt(b.num) * BigInt(a.den)).toString(),
    den: (BigInt(a.den) * BigInt(b.den)).toString(),
  };
}

export function rationalCompare(a: Rational, b: Rational): -1 | 0 | 1 {
  const lhs = BigInt(a.num) * BigInt(b.den);
  const rhs = BigInt(b.num) * BigInt(a.den);
  if (lhs < rhs) return -1;
  if (lhs > rhs) return 1;
  return 0;
}

export function rationalSeconds(r: Rational): string {
  const value = Number(r.num) / Number(r.den);
  return Number.isFinite(value) ? value.toFixed(3) : "0";
}

export function assertPositiveRange(
  range: { start: Rational; duration: Rational },
  code: "INVALID_ARGUMENT" | "PLAN_SEMANTIC_INVALID" = "PLAN_SEMANTIC_INVALID",
): void {
  if (
    range.start.num.startsWith("-") ||
    range.duration.num.startsWith("-") ||
    range.duration.num === "0" ||
    range.start.den === "0" ||
    range.duration.den === "0"
  ) {
    editorFailure(code, "Edit ranges must be non-empty, non-negative and rational");
  }
}

/** Clamp optional analysis sampling rate to [1/1, 1000/1]. */
export function clampAnalysisRate(rate?: string): string {
  if (rate === undefined) return "25/1";
  if (!AnalysisRateSchema.safeParse(rate).success) {
    editorFailure("INVALID_ARGUMENT", "Analysis rate must be a positive rational");
  }
  const [n, d] = rate.split("/");
  const numerator = BigInt(n!);
  const denominator = BigInt(d!);
  if (numerator <= denominator) return "1/1";
  if (numerator >= denominator * 1000n) return "1000/1";
  let a = numerator;
  let b = denominator;
  while (b) [a, b] = [b, a % b];
  return `${numerator / a}/${denominator / a}`;
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
  const media = streams.filter((stream) => stream.kind === "audio" || stream.kind === "video");
  if (!media.length) return null;
  let latest = 0n;
  for (const stream of media) {
    if (stream.startPts === undefined || stream.durationTicks === undefined) return null;
    const endTicks = BigInt(stream.startPts) + BigInt(stream.durationTicks);
    const denominator = BigInt(stream.timeBase.den) * BigInt(origin.den);
    const elapsed =
      endTicks * BigInt(stream.timeBase.num) * BigInt(origin.den) -
      BigInt(origin.num) * BigInt(stream.timeBase.den);
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
): Map<number, FrameSpan> {
  const spans = new Map<number, FrameSpan>();
  if (streams.length === 0) return spans;

  if (index.schemaVersion !== "video.presentation-index/v2") return spans;
  if (index.sourceSha256 !== asset.original.sha256) {
    editorFailure("ARTIFACT_HASH_MISMATCH", "Source index mismatch");
  }
  if (!Array.isArray(index.streams) || !Array.isArray(index.frames)) {
    editorFailure("SCHEMA_UNSUPPORTED", "Incomplete v2 presentation index");
  }
  const selected = new Map<number, StreamDescriptor["kind"]>();
  for (const stream of streams) {
    const clock = index.streams.find((s) => s.streamIndex === stream.streamIndex);
    if (
      clock?.streamUid === stream.streamUid &&
      clock.timeBase?.num === stream.timeBase.num &&
      clock.timeBase?.den === stream.timeBase.den
    ) {
      selected.set(stream.streamIndex, stream.kind);
    }
  }
  for (const frame of index.frames) {
    const id = frame.stream_index;
    if (!selected.has(id)) continue;
    const duration = frame.duration ?? frame.pkt_duration;
    if (
      frame.media_type !== selected.get(id) ||
      typeof frame.pts !== "string" ||
      !/^-?\d+$/.test(frame.pts) ||
      typeof duration !== "string" ||
      !/^[1-9]\d*$/.test(duration)
    ) {
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
