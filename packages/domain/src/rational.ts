import {
  AnalysisRateSchema,
  editorFailure,
  type Rational,
  type SourceAsset,
  type StreamDescriptor,
  type TimeRange,
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

function reduced(num: bigint, den: bigint): Rational {
  let a = num < 0n ? -num : num;
  let b = den;
  while (b !== 0n) [a, b] = [b, a % b];
  return { num: (num / a).toString(), den: (den / a).toString() };
}

/** Resolve a user's playback-time selection on a *verified* constant-rate video stream. */
export function alignCfrTrimRange(
  requested: TimeRange, rate: Rational, frameCount: number, firstFrameTime?: Rational,
): TimeRange {
  assertPositiveRange(requested, "INVALID_ARGUMENT");
  const fpsNum = BigInt(rate.num);
  const fpsDen = BigInt(rate.den);
  const frames = BigInt(frameCount);
  if (fpsNum <= 0n || frames <= 0n) editorFailure("INVALID_ARGUMENT", "所选素材没有可裁剪的视频帧。");
  const secondsForFrames = (count: bigint) => reduced(count * fpsDen, fpsNum);
  function clampFrame(frame: bigint, min: bigint, max: bigint): bigint {
    if (frame < min) return min;
    return frame > max ? max : frame;
  }
  function nearestFrame(seconds: Rational): bigint {
    const divisor = BigInt(seconds.den) * fpsDen;
    return (2n * BigInt(seconds.num) * fpsNum + divisor) / (2n * divisor);
  }
  // Without a known demuxer origin, keep the user's seek time in the original clock.
  if (!firstFrameTime) {
    const count = nearestFrame(requested.duration);
    return { start: requested.start, duration: secondsForFrames(clampFrame(count, 1n, frames)) };
  }
  const start = rationalSub(requested.start, firstFrameTime);
  const end = rationalAdd(start, requested.duration);
  if (BigInt(end.num) <= 0n || rationalCompare(start, secondsForFrames(frames)) >= 0) {
    editorFailure("INVALID_ARGUMENT", "所选时间已超出视频范围，请调整开始时间或时长。");
  }
  // Skip frames starting before playback time zero (e.g. a leading edit list).
  const zero = rationalSub({ num: "0", den: "1" }, firstFrameTime);
  const divisor = BigInt(zero.den) * fpsDen;
  const firstUsable = BigInt(zero.num) > 0n ? (BigInt(zero.num) * fpsNum + divisor - 1n) / divisor : 0n;
  if (firstUsable >= frames) editorFailure("INVALID_ARGUMENT", "所选范围没有可裁剪的视频帧。");
  const first = clampFrame(nearestFrame(start), firstUsable, frames - 1n);
  const stop = clampFrame(nearestFrame(end), first + 1n, frames);
  const actualStart = rationalAdd(firstFrameTime, secondsForFrames(first));
  return { start: reduced(BigInt(actualStart.num), BigInt(actualStart.den)), duration: secondsForFrames(stop - first) };
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
