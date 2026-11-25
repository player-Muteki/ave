import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  TrackedMaskManifestSchema,
  type ArtifactRef,
  type EditorPrincipal,
  type JobSnapshot,
  type MaskAnchorRevision,
  type TrackMaskRequest,
  type SourceAsset,
} from "#video-editor/contracts/v1";
import { ContentAddressedStore, sha256File } from "./cas.js";
import { editorFailure } from "./errors.js";
import type { MediaTools } from "./media.js";
import { resolveWorkerDir } from "./py-worker.js";
import { EditorStore } from "./store.js";

const execute = promisify(execFile);
const worker: EditorPrincipal = { principalId: "worker", role: "owner", projectIds: null };

interface IndexFrame {
  stream_index: number;
  media_type: string;
  pts?: string;
  best_effort_timestamp?: string;
}

async function prepareFrames(
  cas: ContentAddressedStore,
  asset: SourceAsset,
  revision: MaskAnchorRevision,
  request: TrackMaskRequest,
  executeMedia: (args: string[]) => Promise<{ stderr: string }>,
) {
  const h = revision.anchor;
  if (
    asset.original.sha256 !== h.sourceSha256 ||
    asset.presentationIndex.sha256 !== h.sourcePresentationIndexHash ||
    (await sha256File(cas.pathFor(asset.original))) !== h.sourceSha256
  )
    editorFailure("ARTIFACT_HASH_MISMATCH", "Tracking source or presentation index changed");
  const stream = asset.streams.find((s) => s.streamUid === h.streamUid && s.kind === "video");
  if (!stream || stream.width !== h.width || stream.height !== h.height)
    editorFailure("QA_FAILED", "Tracking source geometry changed");
  const index = JSON.parse((await cas.readBytes(asset.presentationIndex)).toString("utf8"));
  if (index.sourceSha256 !== h.sourceSha256)
    editorFailure("ARTIFACT_HASH_MISMATCH", "Frame index belongs to another source");
  const indexed: IndexFrame[] = index.frames.filter(
    (f: IndexFrame) => f.stream_index === stream.streamIndex && f.media_type === "video",
  );
  const start = request.firstFrame;
  const pts = indexed
    .slice(start, start + request.frameCount)
    .map((f) => f.pts ?? f.best_effort_timestamp);
  if (pts.length !== request.frameCount || pts[h.frame - start] !== h.pts)
    editorFailure("QA_FAILED", "Anchor clock mismatch");
  const filter = `select=between(n\\,${start}\\,${start + request.frameCount - 1}),settb=${h.timeBase.num}/${h.timeBase.den},showinfo`;
  const { stderr } = await executeMedia([
    "-hide_banner",
    "-nostats",
    "-loglevel",
    "info",
    "-copyts",
    "-noautorotate",
    "-i",
    cas.pathFor(asset.original),
    "-map",
    `0:${stream.streamIndex}`,
    "-vf",
    filter,
    "-fps_mode",
    "passthrough",
    "-frames:v",
    String(request.frameCount),
    "-start_number",
    "0",
    "-q:v",
    "2",
    "-threads:v",
    "1",
    "frames/%05d.jpg",
  ]);
  const records = [
    ...stderr.matchAll(
      /\[Parsed_showinfo_\d+ [^\]]+\]\s+n:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:[^\n]*?\bs:(\d+)x(\d+)\b/g,
    ),
  ];
  if (
    records.length !== pts.length ||
    records.some(
      (r, i) =>
        Number(r[1]) !== i ||
        r[2] !== pts[i] ||
        Number(r[3]) !== h.width ||
        Number(r[4]) !== h.height,
    )
  )
    editorFailure("QA_FAILED", "Decoded shot differs from indexed frame order or dimensions");
  return records.map((r) => r[2]!);
}

async function collectLabels(
  cas: ContentAddressedStore,
  folder: string,
  pts: string[],
  areas: unknown[],
  h: MaskAnchorRevision["anchor"],
  firstFrame: number,
  current: () => void,
) {
  const frames = [];
  for (const [i, time] of pts.entries()) {
    current();
    const raw = await readFile(path.join(folder, "labels", String(i).padStart(5, "0") + ".raw"));
    if (raw.length !== h.width * h.height) editorFailure("QA_FAILED", "Mask dimensions changed");
    let foregroundPixels = 0;
    for (const v of raw) {
      if (v === 255) foregroundPixels++;
      else if (v !== 0) editorFailure("QA_FAILED", "Non-binary mask");
    }
    if (foregroundPixels !== areas[i]) editorFailure("QA_FAILED", "Mask area mismatch");
    const label = await cas.writeBytes(raw, "application/octet-stream");
    const sourceFrame = firstFrame + i;
    if (sourceFrame === h.frame && label.sha256 !== h.mask.labelSha256)
      editorFailure("QA_FAILED", "Tracking changed the approved anchor");
    frames.push({ sourceFrame, pts: time, foregroundPixels, label });
  }
  return frames;
}

export async function trackMaskJob(
  store: EditorStore,
  cas: ContentAddressedStore,
  tools: MediaTools,
  job: JobSnapshot,
  request: TrackMaskRequest,
  signal: AbortSignal,
) {
  const current = () => {
    if (signal.aborted) editorFailure("CANCELLED", "Mask tracking interrupted");
  };
  current();
  const python = process.env.VIDEO_EDITOR_SAM2_PYTHON;
  if (!python || !path.isAbsolute(python))
    editorFailure("CAPABILITY_UNAVAILABLE", "SAM2 Tiny is not configured");
  const revision = store.approvedTrackingAnchor(request, worker);
  const h = revision.anchor;
  const asset = store.asset(job.projectId, h.assetId, job.revision, worker);
  const anchor = await cas.readBytes(revision.rawLabelMask);
  if (revision.rawLabelMask.sha256 !== h.mask.labelSha256 || anchor.length !== h.width * h.height)
    editorFailure("ARTIFACT_HASH_MISMATCH", "Tracking label does not match approved anchor");
  const folder = await mkdtemp(path.join(tmpdir(), "video-mask-track-"));
  const options = {
    cwd: folder,
    signal,
    killSignal: "SIGKILL" as const,
    timeout: 180_000,
    maxBuffer: 4 << 20,
  };
  const ffmpeg = (args: string[]) =>
    execute(tools.ffmpeg, ["-nostdin", "-xerror", ...args], options);
  const phase = (detail: string) => {
    current();
    store.updateJob(job.projectId, job.jobId, (j) => ({ ...j, phaseDetail: detail }));
  };
  try {
    await Promise.all(
      ["frames", "labels", "overlay"].map((name) => mkdir(path.join(folder, name))),
    );
    phase("校验源帧时间戳");
    const pts = await prepareFrames(cas, asset, revision, request, ffmpeg);
    await writeFile(path.join(folder, "anchor.raw"), anchor);
    await writeFile(
      path.join(folder, "request.json"),
      JSON.stringify({ count: request.frameCount, anchor: h.frame - request.firstFrame }),
    );
    phase("SAM2 正在传播掩码");
    const script = path.join(
      resolveWorkerDir(path.dirname(fileURLToPath(import.meta.url))),
      "track_mask.py",
    );
    const { stdout } = await execute(python, ["-I", "-B", script], options);
    const areas: unknown = JSON.parse(stdout);
    if (!Array.isArray(areas) || areas.length !== pts.length)
      editorFailure("QA_FAILED", "Incomplete mask sequence");
    phase("校验逐帧标签与审片视频");
    const frames = await collectLabels(cas, folder, pts, areas, h, request.firstFrame, current);
    await ffmpeg([
      "-v",
      "error",
      "-framerate",
      "9",
      "-start_number",
      "0",
      "-i",
      "overlay/%05d.png",
      "-vf",
      "pad=ceil(iw/2)*2:ceil(ih/2)*2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-threads:v",
      "1",
      "review.mp4",
    ]);
    await ffmpeg(["-v", "error", "-i", "review.mp4", "-map", "0:v:0", "-f", "null", "-"]);
    const result = await execute(
      tools.ffprobe,
      [
        "-v",
        "error",
        "-show_streams",
        "-show_frames",
        "-show_entries",
        "stream=codec_name,time_base:frame=pts",
        "-of",
        "json",
        "review.mp4",
      ],
      options,
    );
    const probe = JSON.parse(result.stdout);
    const [num, den] = String(probe.streams[0]?.time_base).split("/").map(BigInt);
    if (
      probe.streams.length !== 1 ||
      probe.streams[0].codec_name !== "h264" ||
      probe.frames.length !== pts.length ||
      probe.frames.some(
        (f: { pts: number }, i: number) => BigInt(f.pts) * num! * 9n !== BigInt(i) * den!,
      )
    )
      editorFailure("QA_FAILED", "Review video frame clock mismatch");
    const reviewVideo = await cas.importFile(path.join(folder, "review.mp4"), "video/mp4");
    const manifest = TrackedMaskManifestSchema.parse({
      schemaVersion: "video.tracked-mask/v1",
      projectId: job.projectId,
      jobId: job.jobId,
      anchorApprovalId: request.anchorApprovalId,
      anchorHash: request.anchorHash,
      maskRevisionId: revision.maskRevisionId,
      sourceSha256: h.sourceSha256,
      sourcePresentationIndexHash: h.sourcePresentationIndexHash,
      assetId: h.assetId,
      streamUid: h.streamUid,
      engine: h.mask.engine,
      weightsSha256: h.mask.weightsSha256,
      anchorFrame: h.frame,
      width: h.width,
      height: h.height,
      timeBase: h.timeBase,
      frames,
      reviewImageRate: 9,
      reviewVideo,
    });
    const report = await cas.writeJson(manifest);
    const base = { projectId: job.projectId, jobId: job.jobId, revision: job.revision };
    const artifacts: ArtifactRef[] = [
      { ...base, kind: "mask", artifactId: job.jobId + ":tracked-mask", blob: report },
      { ...base, kind: "proxy", artifactId: job.jobId + ":tracking-preview", blob: reviewVideo },
    ];
    current();
    store.approvedTrackingAnchor(request, worker);
    return store.updateJob(job.projectId, job.jobId, (j) => ({
      ...j,
      state: "completed",
      phaseDetail: "掩码传播完成，待审片",
      progress: { completedUnits: String(frames.length), totalUnits: String(frames.length) },
      artifacts,
      error: undefined,
    }));
  } catch (error) {
    current();
    throw error;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
