import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  InspectFrameHeaderSchema,
  type InspectFrameRequest,
  type InspectFrameHeader,
  type CreateMaskRevisionRequest,
  type SourceAsset,
} from "#video-editor/contracts/v1";
import { ContentAddressedStore, sha256File } from "./cas.js";
import { editorFailure } from "./errors.js";
import { resolveWorkerDir } from "./py-worker.js";

const execute = promisify(execFile);

interface IndexedFrame {
  stream_index: number;
  media_type: string;
  pts?: string;
  best_effort_timestamp?: string;
}

function processOptions(cwd: string) {
  return { cwd, timeout: 60_000, killSignal: "SIGKILL" as const, maxBuffer: 2 << 20 };
}

async function indexedTime(
  asset: SourceAsset,
  cas: ContentAddressedStore,
  video: SourceAsset["streams"][number],
  ordinal: number,
) {
  const index = JSON.parse((await cas.readBytes(asset.presentationIndex)).toString("utf8"));
  if (
    index.schemaVersion !== "video.presentation-index/v2" ||
    !Array.isArray(index.streams) ||
    !Array.isArray(index.frames)
  )
    editorFailure("SCHEMA_UNSUPPORTED", "Precise inspection requires a v2 presentation index");
  if (index.sourceSha256 !== asset.original.sha256)
    editorFailure("ARTIFACT_HASH_MISMATCH", "Source index mismatch");
  const stream = index.streams.find((s: { streamUid: string }) => s.streamUid === video.streamUid);
  if (
    stream?.streamIndex !== video.streamIndex ||
    stream.timeBase.num !== video.timeBase.num ||
    stream.timeBase.den !== video.timeBase.den
  )
    editorFailure("QA_FAILED", "Video stream index mismatch");
  const frames: IndexedFrame[] = index.frames.filter(
    (f: IndexedFrame) => f.stream_index === video.streamIndex && f.media_type === "video",
  );
  const frame = frames[ordinal];
  if (!frame) editorFailure("INVALID_ARGUMENT", "Frame ordinal outside the source stream");
  const pts = frame.pts ?? frame.best_effort_timestamp;
  if (typeof pts !== "string" || !/^-?\d+$/.test(pts))
    editorFailure("QA_FAILED", "Missing indexed frame PTS");
  return { pts, frameCount: frames.length };
}

async function resolveFrame(
  request: InspectFrameRequest,
  asset: SourceAsset,
  cas: ContentAddressedStore,
) {
  if (asset.presentationIndex.sha256 !== request.sourcePresentationIndexHash)
    editorFailure("REVISION_CONFLICT", "The source frame index has changed");
  const video = asset.streams.find((s) => s.streamUid === request.streamUid && s.kind === "video");
  if (!video?.width || !video.height) editorFailure("INVALID_ARGUMENT", "No such video raster");
  const { width, height } = video;
  const { pts, frameCount } = await indexedTime(asset, cas, video, request.frame);
  const original = cas.pathFor(asset.original);
  if ((await sha256File(original)) !== asset.original.sha256)
    editorFailure("ARTIFACT_HASH_MISMATCH", "Source changed");
  const scale = Math.min(1, 640 / Math.max(width, height));
  const previewWidth = Math.max(1, Math.round(width * scale));
  const previewHeight = Math.max(1, Math.round(height * scale));
  if (
    request.points.some((p) => p.x >= width || p.y >= height) ||
    (request.points.length && !request.points.some((p) => p.foreground))
  )
    editorFailure("INVALID_ARGUMENT", "Select a foreground point inside the source frame");
  return { video, width, height, pts, frameCount, original, previewWidth, previewHeight };
}

async function decodeIndexedFrame(
  ffmpeg: string,
  directory: string,
  ordinal: number,
  frame: Awaited<ReturnType<typeof resolveFrame>>,
) {
  const options = processOptions(directory);
  // FFmpeg presentation order matches the per-stream ordinals in the index. Rotation
  // stays disabled so the operator clicks directly in the encoded source raster.
  const input = ["-noautorotate", "-i", frame.original, "-map", `0:${frame.video.streamIndex}`];
  const select = `select=eq(n\\,${ordinal})`;
  const clock = frame.video.timeBase;
  const { stderr } = await execute(
    ffmpeg,
    [
      "-nostdin",
      "-hide_banner",
      "-nostats",
      "-loglevel",
      "info",
      "-xerror",
      "-copyts",
      ...input,
      "-vf",
      `${select},settb=${clock.num}/${clock.den},showinfo`,
      "-fps_mode",
      "passthrough",
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgb24",
      "-threads:v",
      "1",
      "frame.png",
    ],
    options,
  );
  const observed =
    /\[Parsed_showinfo_\d+ [^\]]+\]\s+n:\s*0\s+pts:\s*(-?\d+)\s+pts_time:[^\n]*?\bs:(\d+)x(\d+)\b/.exec(
      stderr,
    );
  if (
    !observed ||
    observed[1] !== frame.pts ||
    Number(observed[2]) !== frame.width ||
    Number(observed[3]) !== frame.height
  )
    editorFailure("QA_FAILED", "Decoded frame clock or geometry differs from its index");
}

async function storeReviewedLabel(
  save: CreateMaskRevisionRequest,
  header: InspectFrameHeader,
  cas: ContentAddressedStore,
  directory: string,
) {
  const { width, height } = header;
  if (
    header.mask?.labelSha256 !== save.expectedLabelSha256 ||
    header.previewSha256 !== save.expectedPreviewSha256
  )
    editorFailure("REVISION_CONFLICT", "Recomputed mask differs from the reviewed anchor");
  const rawLabelMask = await cas.importFile(
    path.join(directory, "label.raw"),
    "application/octet-stream",
  );
  if (
    rawLabelMask.sha256 !== save.expectedLabelSha256 ||
    BigInt(rawLabelMask.bytes) !== BigInt(width) * BigInt(height)
  )
    editorFailure("QA_FAILED", "Stored mask does not match the reviewed source raster");
  return rawLabelMask;
}

export class FrameInspector {
  private tracking = false;

  async inspect(
    request: InspectFrameRequest,
    asset: SourceAsset,
    cas: ContentAddressedStore,
    ffmpeg: string,
    save?: CreateMaskRevisionRequest,
  ) {
    const frame = await resolveFrame(request, asset, cas);
    const { width, height, pts, frameCount, previewWidth, previewHeight } = frame;
    const points = request.points.length > 0;
    const python = process.env.VIDEO_EDITOR_SAM2_PYTHON;
    if (
      points &&
      (!python ||
        !path.isAbsolute(python) ||
        !process.env.VIDEO_EDITOR_SAM2_SOURCE ||
        !process.env.VIDEO_EDITOR_SAM2_WEIGHTS)
    )
      editorFailure("CAPABILITY_UNAVAILABLE", "SAM2 Tiny is not configured on this daemon");
    const directory = await mkdtemp(path.join(tmpdir(), "video-frame-"));
    let acquired = false;
    try {
      if (points) {
        if (this.tracking) editorFailure("WORKER_BUSY", "SAM2 is evaluating another anchor", true);
        this.tracking = acquired = true;
      }
      await decodeIndexedFrame(ffmpeg, directory, request.frame, frame);
      const options = processOptions(directory);
      let mask: unknown;
      if (points && python) {
        await writeFile(path.join(directory, "points.json"), JSON.stringify(request.points));
        const script = path.join(
          resolveWorkerDir(path.dirname(fileURLToPath(import.meta.url))),
          "inspect_mask.py",
        );
        try {
          const result = await execute(
            python,
            ["-I", "-B", script, ...(save ? ["--save-label"] : [])],
            {
              ...options,
              timeout: 120_000,
            },
          );
          mask = JSON.parse(result.stdout);
        } catch {
          editorFailure(
            "WORKER_FAILED",
            "SAM2 anchor preview failed; check the configured runtime and pinned weights",
          );
        }
      }
      const resize = `scale=${previewWidth}:${previewHeight},setsar=1`;
      const source = ["-i", points ? "overlay.png" : "frame.png", "-vf", resize];
      const { stdout } = await execute(
        ffmpeg,
        [
          "-nostdin",
          "-v",
          "error",
          "-xerror",
          ...source,
          "-frames:v",
          "1",
          "-c:v",
          "mjpeg",
          "-q:v",
          "3",
          "-threads:v",
          "1",
          "-f",
          "image2pipe",
          "pipe:1",
        ],
        { ...options, encoding: "buffer" },
      );
      if (
        stdout.length < 4 ||
        stdout.readUInt16BE(0) !== 0xffd8 ||
        stdout.readUInt16BE(stdout.length - 2) !== 0xffd9
      )
        editorFailure("QA_FAILED", "The decoder did not produce a complete JPEG");
      const header = InspectFrameHeaderSchema.parse({
        ...request,
        pts,
        timeBase: frame.video.timeBase,
        frameCount,
        width,
        height,
        previewWidth,
        previewHeight,
        sourceSha256: asset.original.sha256,
        previewSha256: createHash("sha256").update(stdout).digest("hex"),
        mask,
      });
      if (!save) return { header, jpeg: stdout };
      const rawLabelMask = await storeReviewedLabel(save, header, cas, directory);
      return { header, jpeg: stdout, rawLabelMask };
    } finally {
      if (acquired) this.tracking = false;
      await rm(directory, { recursive: true, force: true });
    }
  }
}
