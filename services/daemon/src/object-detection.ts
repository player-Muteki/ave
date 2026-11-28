import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ContentAddressedStore } from "@ave/cas";
import { editorFailure, type ObjectEditWorkflow, type SourceAsset } from "@ave/contracts";
import {
  DetectorResultSchema, probeStartTime, rationalAdd, rationalCompare, rationalEquals,
  toObjectCandidates, type FrameIndex,
} from "@ave/domain";
import { ffmpegOutputTimingArgs } from "./media-flags.js";
import { AvePyWorker } from "./py-worker.js";

type FrameSample = { ordinal: number; pts: string; duration: string };
export type DetectPeople = (directory: string, signal: AbortSignal) => Promise<unknown>;

export async function objectSourceFrames(cas: ContentAddressedStore, asset: SourceAsset, workflow: ObjectEditWorkflow) {
  const video = asset.streams.find(s => s.kind === "video");
  if (!video?.width || !video.height) editorFailure("CAPABILITY_UNAVAILABLE", "Object analysis requires a video stream");
  const index = await cas.readJson<FrameIndex>(asset.presentationIndex);
  const stream = index.streams?.find(s => s.streamUid === video.streamUid);
  if (index.schemaVersion !== "video.presentation-index/v2" || index.sourceSha256 !== asset.original.sha256 ||
      asset.original.sha256 !== workflow.assetContentHash || stream?.streamIndex !== video.streamIndex ||
      !rationalEquals(stream.timeBase, video.timeBase)) {
    editorFailure("REVISION_CONFLICT", "Object analysis source or index changed");
  }
  const probe = await cas.readJson<{ format?: { start_time?: string } }>(asset.probe);
  const offset = probeStartTime(probe.format?.start_time) ?? { num: "0", den: "1" };
  const start = rationalAdd(offset, workflow.sourceRange.start);
  const end = rationalAdd(start, workflow.sourceRange.duration);
  const rows = index.frames.filter(f => f.media_type === "video" && f.stream_index === video.streamIndex);
  const range: FrameSample[] = [];
  for (const [ordinal, row] of rows.entries()) {
    if (row.pts === undefined) editorFailure("QA_FAILED", "An indexed frame is missing its timestamp");
    const time = { num: String(BigInt(row.pts) * BigInt(video.timeBase.num)), den: video.timeBase.den };
    if (rationalCompare(time, start) < 0 || rationalCompare(time, end) >= 0) continue;
    const duration = row.duration ?? row.pkt_duration ??
      (rows[ordinal + 1]?.pts ? String(BigInt(rows[ordinal + 1]!.pts!) - BigInt(row.pts)) : undefined);
    if (!duration || BigInt(duration) <= 0n) editorFailure("QA_FAILED", "Missing source frame duration");
    range.push({ ordinal, pts: row.pts, duration });
  }
  if (!range.length) editorFailure("INVALID_ARGUMENT", "The selected source range contains no video frame");
  const sourceFrames = { streamUid: video.streamUid, firstFrame: range[0]!.ordinal, frameCount: range.length };
  const count = Math.min(range.length, 12);
  const samples = Array.from({ length: count }, (_, i) => range[Math.round(i * (range.length - 1) / Math.max(1, count - 1))]!);
  return { video, width: video.width, height: video.height, sourceFrames, samples };
}

export async function detectObjectCandidates(cas: ContentAddressedStore, asset: SourceAsset,
  workflow: ObjectEditWorkflow, ffmpeg: string, workerDir: string, signal: AbortSignal, detect?: DetectPeople) {
  const { video, width, height, samples, sourceFrames } = await objectSourceFrames(cas, asset, workflow);
  if (!await cas.verifyBlob(asset.original)) editorFailure("ARTIFACT_HASH_MISMATCH", "Object analysis source changed");
  const scale = Math.min(1, 640 / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const directory = await mkdtemp(path.join(tmpdir(), "ave-detection-"));
  try {
    const select = samples.map(s => "eq(n\\," + s.ordinal + ")").join("+");
    await promisify(execFile)(ffmpeg, ["-v", "error", "-nostdin", "-noautorotate", "-i", cas.pathFor(asset.original),
      "-map", "0:" + video.streamIndex, "-vf", "select=" + select + ",scale=" + w + ":" + h,
      ...await ffmpegOutputTimingArgs(ffmpeg, "passthrough"), "-frames:v", String(samples.length),
      "-threads:v", "1", "-pix_fmt", "bgr24", "-f", "rawvideo", "frames.bgr"],
    { cwd: directory, signal, timeout: 120_000, shell: false });
    if ((await stat(path.join(directory, "frames.bgr"))).size !== samples.length * w * h * 3) {
      editorFailure("QA_FAILED", "Detector raster count differs from the selected frames");
    }
    await writeFile(path.join(directory, "frames.json"), JSON.stringify({ width: w, height: h, samples }));
    const output = detect ? await detect(directory, signal) : await new AvePyWorker({ workerDir }).detectPeople(directory, signal);
    const result = DetectorResultSchema.parse(output);
    const ordinals = new Set(samples.map(s => String(s.ordinal)));
    if (result.frames !== samples.length || result.frameWidth !== w || result.frameHeight !== h ||
        result.tracks.some(t => t.evidenceFrames.some(frame => !ordinals.has(frame)))) {
      editorFailure("QA_FAILED", "People detector returned evidence outside the sampled source");
    }
    return { sourceFrames, candidates: toObjectCandidates(result, asset.original.sha256).slice(0, 32) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
