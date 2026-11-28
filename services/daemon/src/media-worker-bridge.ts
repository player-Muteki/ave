import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ContentAddressedStore } from "@ave/cas";
import { sha256File } from "@ave/cas";
import {
  EditPlanDraftV1Schema,
  EditorError,
  InspectFrameHeaderSchema,
  TrackedMaskManifestSchema,
  VACE_MODEL,
  VACE_PROFILE,
  editorFailure,
  encodeFramedChunk,
  type AcceptedEditPlan,
  type ApprovalRequest,
  type ArtifactRef,
  type CreateMaskRevisionRequest,
  type EditorPrincipal,
  type InspectFrameHeader,
  type InspectFrameRequest,
  type JobSnapshot,
  type ProposeVacePreview,
  type Rational,
  type SourceAsset,
  type TrackMaskRequest,
} from "@ave/contracts";
import { probeStartTime, rationalEquals, rationalSub, removalTargets, seedMaskAnchorRequest, sha256Json } from "@ave/domain";
import { detectObjectCandidates, objectSourceFrames, type DetectPeople } from "./object-detection.js";
import type { AveStore } from "@ave/sqlite";
import type { GeneratedShot } from "./backends/deterministic-backend.js";
import { verifyGeneratedPixels } from "./vace-output.js";
import { ffmpegOutputTimingArgs } from "./media-flags.js";
import { resolveMediaWorkerDir } from "./py-worker.js";
import type { MediaWorkerHook } from "./rpc-registry.js";

const execute = promisify(execFile);

const WORKER_PRINCIPAL: EditorPrincipal = {
  principalId: "worker",
  role: "owner",
  projectIds: null,
};

interface IndexedFrame {
  stream_index: number;
  media_type: string;
  pts?: string;
  best_effort_timestamp?: string;
  duration?: string;
  pkt_duration?: string;
}

/**
 * Optional deterministic test adapter injected explicitly in test harnesses so
 * CI can verify end-to-end mask, tracking, and VACE proposal pipelines without
 * GPU weights. Never auto-enabled in production.
 */
export interface MediaWorkerTestAdapter {
  detectPeople?: DetectPeople;
  inspectMask?: (params: {
    directory: string;
    width: number;
    height: number;
    points: InspectFrameRequest["points"];
    saveLabel: boolean;
  }) => Promise<{
    engine: "sam2.1-tiny";
    weightsSha256: string;
    labelSha256: string;
    foregroundPixels: number;
  }>;
  trackMask?: (params: {
    directory: string;
    width: number;
    height: number;
    count: number;
    anchorOffset: number;
    anchorRaw: Uint8Array;
  }) => Promise<number[]>;
  generateShot?: (directory: string, signal: AbortSignal) => Promise<void>;
  enableVace?: boolean;
}

export interface AveMediaWorkerOptions {
  store: AveStore;
  cas: ContentAddressedStore;
  ffmpeg: string;
  ffprobe: string;
  workerDir?: string;
  onProjectEvent: (projectId: string) => void;
  testAdapter?: MediaWorkerTestAdapter;
}

function rational(num: bigint, den: bigint): Rational {
  let a = num;
  let b = den;
  while (b) [a, b] = [b, a % b];
  return { num: String(num / a), den: String(den / a) };
}

function configuredSam2Env(): { python: string; source: string; weights: string } | undefined {
  const python = process.env.AVE_SAM2_PYTHON ?? process.env.VIDEO_EDITOR_SAM2_PYTHON;
  const source = process.env.AVE_SAM2_SOURCE ?? process.env.VIDEO_EDITOR_SAM2_SOURCE;
  const weights = process.env.AVE_SAM2_WEIGHTS ?? process.env.VIDEO_EDITOR_SAM2_WEIGHTS;
  if (!python || !source || !weights) return undefined;
  if (!path.isAbsolute(python) || !path.isAbsolute(source) || !path.isAbsolute(weights)) {
    return undefined;
  }
  if (!existsSync(python) || !existsSync(weights)) return undefined;
  return { python, source, weights };
}

function configuredVaceEnv(): { python: string; model: string } | undefined {
  const python = process.env.AVE_VACE_PYTHON ?? process.env.VIDEO_EDITOR_VACE_PYTHON;
  const model = process.env.AVE_VACE_MODEL ?? process.env.VIDEO_EDITOR_VACE_MODEL;
  if (!python || !model) return undefined;
  if (!path.isAbsolute(python) || !path.isAbsolute(model)) return undefined;
  if (!existsSync(python) || !existsSync(path.join(model, "model_index.json"))) return undefined;
  return { python, model };
}

/**
 * Native AVE bridge to isolated FFmpeg + Python media/CV/generative kernels.
 */
export class AveMediaWorkerBridge implements MediaWorkerHook {
  private readonly store: AveStore;
  private readonly cas: ContentAddressedStore;
  private readonly ffmpeg: string;
  private readonly ffprobe: string;
  private readonly workerDir: string;
  private readonly onProjectEvent: (projectId: string) => void;
  private readonly testAdapter?: MediaWorkerTestAdapter;
  private inspecting = false;

  constructor(options: AveMediaWorkerOptions) {
    this.store = options.store;
    this.cas = options.cas;
    this.ffmpeg = options.ffmpeg;
    this.ffprobe = options.ffprobe;
    this.workerDir = resolveMediaWorkerDir(options.workerDir);
    this.onProjectEvent = options.onProjectEvent;
    this.testAdapter = options.testAdapter;
  }

  hasMaskTracking(): boolean {
    return Boolean(this.testAdapter?.trackMask || configuredSam2Env());
  }

  hasVace(): boolean {
    return Boolean(this.testAdapter?.generateShot || this.testAdapter?.enableVace || configuredVaceEnv());
  }

  private async resolveFrame(request: InspectFrameRequest, asset: SourceAsset) {
    if (asset.presentationIndex.sha256 !== request.sourcePresentationIndexHash) {
      editorFailure("REVISION_CONFLICT", "The source frame index has changed");
    }
    const video = asset.streams.find((s) => s.streamUid === request.streamUid && s.kind === "video");
    if (!video?.width || !video.height) {
      editorFailure("INVALID_ARGUMENT", "No such video raster");
    }
    const { width, height } = video;
    const probe = await this.cas.readJson<{ format?: { start_time?: string } }>(asset.probe);
    const index = JSON.parse((await this.cas.readBytes(asset.presentationIndex)).toString("utf8")) as {
      schemaVersion?: string;
      sourceSha256?: string;
      streams?: Array<{ streamUid: string; streamIndex: number; timeBase: { num: string; den: string } }>;
      frames?: IndexedFrame[];
    };
    if (
      index.schemaVersion !== "video.presentation-index/v2" ||
      !Array.isArray(index.streams) ||
      !Array.isArray(index.frames)
    ) {
      editorFailure("SCHEMA_UNSUPPORTED", "Precise inspection requires a v2 presentation index");
    }
    if (index.sourceSha256 !== asset.original.sha256) {
      editorFailure("ARTIFACT_HASH_MISMATCH", "Source index mismatch");
    }
    const stream = index.streams.find((s) => s.streamUid === video.streamUid);
    if (
      stream?.streamIndex !== video.streamIndex ||
      stream.timeBase.num !== video.timeBase.num ||
      stream.timeBase.den !== video.timeBase.den
    ) {
      editorFailure("QA_FAILED", "Video stream index mismatch");
    }
    const frames = index.frames.filter(
      (f) => f.stream_index === video.streamIndex && f.media_type === "video",
    );
    const frame = frames[request.frame];
    if (!frame) {
      editorFailure("INVALID_ARGUMENT", "Frame ordinal outside the source stream");
    }
    const pts = frame.pts ?? frame.best_effort_timestamp;
    if (typeof pts !== "string" || !/^-?\d+$/.test(pts)) {
      editorFailure("QA_FAILED", "Missing indexed frame PTS");
    }
    const original = this.cas.pathFor(asset.original);
    if ((await sha256File(original)) !== asset.original.sha256) {
      editorFailure("ARTIFACT_HASH_MISMATCH", "Source changed");
    }
    const scale = Math.min(1, 640 / Math.max(width, height));
    const previewWidth = Math.max(1, Math.round(width * scale));
    const previewHeight = Math.max(1, Math.round(height * scale));
    if (
      request.points.some((p) => p.x >= width || p.y >= height) ||
      (request.points.length && !request.points.some((p) => p.foreground))
    ) {
      editorFailure("INVALID_ARGUMENT", "Select a foreground point inside the source frame");
    }
    return {
      video,
      width,
      height,
      pts,
      frameCount: frames.length,
      inputStartTime: probeStartTime(probe.format?.start_time),
      original,
      previewWidth,
      previewHeight,
    };
  }

  private async decodeSingleIndexedFrame(
    directory: string,
    ordinal: number,
    frame: Awaited<ReturnType<AveMediaWorkerBridge["resolveFrame"]>>,
  ): Promise<void> {
    const options = { cwd: directory, timeout: 60_000, killSignal: "SIGKILL" as const, maxBuffer: 2 << 20 };
    const clock = frame.video.timeBase;
    const { stderr } = await execute(
      this.ffmpeg,
      [
        "-nostdin",
        "-hide_banner",
        "-nostats",
        "-loglevel",
        "info",
        "-xerror",
        "-copyts",
        "-noautorotate",
        "-i",
        frame.original,
        "-map",
        `0:${frame.video.streamIndex}`,
        "-vf",
        `select=eq(n\\,${ordinal}),settb=${clock.num}/${clock.den},showinfo`,
        ...(await ffmpegOutputTimingArgs(this.ffmpeg, "passthrough")),
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
    ) {
      editorFailure("QA_FAILED", "Decoded frame clock or geometry differs from its index");
    }
  }

  private async runInspectInternal(
    request: InspectFrameRequest,
    asset: SourceAsset,
    save?: CreateMaskRevisionRequest | "workflow",
  ) {
    const frame = await this.resolveFrame(request, asset);
    const { width, height, pts, frameCount, previewWidth, previewHeight } = frame;
    const points = request.points.length > 0;
    const sam2Env = configuredSam2Env();

    if (points && !this.testAdapter?.inspectMask && !sam2Env) {
      editorFailure("CAPABILITY_UNAVAILABLE", "SAM2 Tiny is not configured on this daemon");
    }

    const directory = await mkdtemp(path.join(tmpdir(), "ave-frame-"));
    let acquired = false;
    try {
      if (points) {
        if (this.inspecting) {
          editorFailure("WORKER_BUSY", "SAM2 is evaluating another anchor", true);
        }
        this.inspecting = acquired = true;
      }
      await this.decodeSingleIndexedFrame(directory, request.frame, frame);
      const options = { cwd: directory, timeout: 120_000, killSignal: "SIGKILL" as const, maxBuffer: 2 << 20 };

      let mask:
        | {
            engine: "sam2.1-tiny";
            weightsSha256: string;
            labelSha256: string;
            foregroundPixels: number;
          }
        | undefined;

      if (points) {
        if (this.testAdapter?.inspectMask) {
          mask = await this.testAdapter.inspectMask({
            directory,
            width,
            height,
            points: request.points,
            saveLabel: Boolean(save),
          });
        } else if (sam2Env) {
          await writeFile(path.join(directory, "points.json"), JSON.stringify(request.points));
          const script = path.join(this.workerDir, "inspect_mask.py");
          try {
            const result = await execute(
              sam2Env.python,
              ["-I", "-B", script, ...(save ? ["--save-label"] : [])],
              options,
            );
            mask = JSON.parse(result.stdout) as typeof mask;
          } catch {
            editorFailure(
              "WORKER_FAILED",
              "SAM2 anchor preview failed; check the configured runtime and pinned weights",
            );
          }
        }
      }

      const resize = `scale=${previewWidth}:${previewHeight},setsar=1`;
      const sourceInput = ["-i", points ? "overlay.png" : "frame.png", "-vf", resize];
      const { stdout } = await execute(
        this.ffmpeg,
        [
          "-nostdin",
          "-v",
          "error",
          "-xerror",
          ...sourceInput,
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
      ) {
        editorFailure("QA_FAILED", "The decoder did not produce a complete JPEG");
      }

      const header = InspectFrameHeaderSchema.parse({
        ...request,
        pts,
        timeBase: frame.video.timeBase,
        inputStartTime: frame.inputStartTime,
        frameCount,
        width,
        height,
        previewWidth,
        previewHeight,
        sourceSha256: asset.original.sha256,
        previewSha256: createHash("sha256").update(stdout).digest("hex"),
        ...(mask ? { mask } : {}),
      });

      if (!save) return { header, jpeg: stdout };

      if (!header.mask?.foregroundPixels) editorFailure("QA_FAILED", "The anchor has no foreground pixels");
      if (save !== "workflow" && (header.mask.labelSha256 !== save.expectedLabelSha256 ||
        header.previewSha256 !== save.expectedPreviewSha256)) {
        editorFailure("REVISION_CONFLICT", "Recomputed mask differs from the reviewed anchor");
      }
      const rawLabelMask = await this.cas.importFile(
        path.join(directory, "label.raw"),
        "application/octet-stream",
      );
      if (
        rawLabelMask.sha256 !== header.mask.labelSha256 ||
        BigInt(rawLabelMask.bytes) !== BigInt(width) * BigInt(height)
      ) {
        editorFailure("QA_FAILED", "Stored mask does not match the reviewed source raster");
      }
      const label = await this.cas.readBytes(rawLabelMask);
      let foreground = 0;
      for (const value of label) {
        if (value !== 0 && value !== 255) editorFailure("QA_FAILED", "The anchor label must be binary");
        if (value) foreground++;
      }
      if (foreground !== header.mask.foregroundPixels) editorFailure("QA_FAILED", "The anchor foreground count changed");
      return { header, jpeg: stdout, rawLabelMask };
    } finally {
      if (acquired) this.inspecting = false;
      await rm(directory, { recursive: true, force: true });
    }
  }

  async runObjectTask(job: JobSnapshot, signal: AbortSignal): Promise<void> {
    const task = job.objectTask!;
    const workflow = this.store.objectEdits.getObjectEdit(job.projectId, task.workflowId, WORKER_PRINCIPAL);
    const asset = this.store.projects.getAsset(job.projectId, workflow.assetId, workflow.baseTimelineRevision, WORKER_PRINCIPAL);
    if (task.stage === "detect") {
      const result = await detectObjectCandidates(this.cas, asset, workflow, this.ffmpeg, this.workerDir, signal, this.testAdapter?.detectPeople);
      this.store.objectEdits.finishWorker(job, WORKER_PRINCIPAL, result);
    } else {
      const { video, width, height, sourceFrames } = await objectSourceFrames(this.cas, asset, workflow);
      const targets = removalTargets(workflow.candidates, workflow.decisions);
      const evidence = targets[0]?.evidenceFrames.map(Number).filter(frame =>
        frame >= sourceFrames.firstFrame && frame < sourceFrames.firstFrame + sourceFrames.frameCount &&
        targets.every(c => c.evidenceFrames.includes(String(frame)))) ?? [];
      if (!evidence.length) editorFailure("CAPABILITY_UNAVAILABLE", "Selected targets have no common evidence frame in this range");
      const previous = workflow.anchorFrame === undefined ? -1 : evidence.indexOf(workflow.anchorFrame);
      const frame = evidence[(previous + 1) % evidence.length]!;
      const context = { projectId: job.projectId, assetId: asset.assetId, streamUid: video.streamUid,
        sourcePresentationIndexHash: asset.presentationIndex.sha256, frame };
      const keep = workflow.candidates.filter(c => c.evidenceFrames.includes(String(frame)) &&
        workflow.decisions.some(d => d.objectId === c.objectId && d.decision === "keep"));
      const anchor = seedMaskAnchorRequest(context, targets[0]!, width, height);
      if (targets.length > 1 || keep.length) {
        anchor.points = [...targets, ...keep].map((candidate, i) => {
          const points = seedMaskAnchorRequest(context, candidate, width, height).points;
          return { ...points[Math.floor(points.length / 2)]!, foreground: i < targets.length };
        });
      }
      const { header, jpeg, rawLabelMask } = await this.runInspectInternal(anchor, asset, "workflow");
      if (!rawLabelMask || !header.mask) editorFailure("QA_FAILED", "The mask worker returned no label");
      const image = await this.cas.writeBytes(jpeg, "image/jpeg");
      const request = { requestId: sha256Json([job.jobId, "save-anchor"]), expectedRevision: job.revision,
        anchor, expectedLabelSha256: rawLabelMask.sha256, expectedPreviewSha256: image.sha256 };
      this.store.objectEdits.finishWorker(job, WORKER_PRINCIPAL, { sourceFrames, request, header, label: rawLabelMask, image });
    }
    this.onProjectEvent(job.projectId);
  }

  async inspectFrame(request: InspectFrameRequest, principal: EditorPrincipal): Promise<Uint8Array> {
    this.store.devices.authorizeProject(request.projectId, principal, "operator");
    const project = this.store.projects.getProjectSnapshot(request.projectId, principal);
    const asset = project.assets.find((a) => a.assetId === request.assetId);
    if (!asset) {
      editorFailure("ASSET_NOT_FOUND", "Unknown asset in this project");
    }
    const { header, jpeg } = await this.runInspectInternal(request, asset);
    return encodeFramedChunk(header, jpeg);
  }

  async createMaskRevision(
    request: CreateMaskRevisionRequest,
    principal: EditorPrincipal,
  ): Promise<ApprovalRequest> {
    const projectId = request.anchor.projectId;
    this.store.devices.authorizeProject(projectId, principal, "operator");
    const existing = this.store.objectEdits.savedMaskApproval(request, principal);
    if (existing) return existing;
    if (
      request.anchor.points.length === 0 ||
      !request.anchor.points.some((p) => p.foreground)
    ) {
      editorFailure("INVALID_ARGUMENT", "Saving a mask requires at least one foreground point");
    }
    const asset = this.store.projects.getAsset(
      projectId,
      request.anchor.assetId,
      request.expectedRevision,
      principal,
    );
    const { header, jpeg, rawLabelMask } = await this.runInspectInternal(
      request.anchor,
      asset,
      request,
    );
    if (!rawLabelMask || !header.mask) {
      editorFailure("QA_FAILED", "Mask anchor generation did not produce a binary label");
    }
    const reviewImage = await this.cas.writeBytes(jpeg, "image/jpeg");
    const approval = this.store.objectEdits.saveMaskRevision(
      request,
      header as InspectFrameHeader,
      rawLabelMask,
      reviewImage,
      principal,
    );
    this.onProjectEvent(projectId);
    return approval;
  }

  async readMaskRevision(
    projectId: string,
    maskRevisionId: string,
    principal: EditorPrincipal,
  ): Promise<Uint8Array> {
    const revision = this.store.objectEdits.getMaskRevision(projectId, maskRevisionId, principal);
    const reviewBytes = await this.cas.readBytes(revision.reviewImage);
    return encodeFramedChunk(revision, reviewBytes);
  }

  private async prepareShotFrames(
    asset: SourceAsset,
    h: InspectFrameHeader,
    request: TrackMaskRequest,
    executeMedia: (args: string[]) => Promise<{ stderr: string }>,
    format: "jpeg" | "rgb24" = "jpeg",
  ): Promise<string[]> {
    if (
      asset.original.sha256 !== h.sourceSha256 ||
      asset.presentationIndex.sha256 !== h.sourcePresentationIndexHash ||
      (await sha256File(this.cas.pathFor(asset.original))) !== h.sourceSha256
    ) {
      editorFailure("ARTIFACT_HASH_MISMATCH", "Tracking source or presentation index changed");
    }
    const stream = asset.streams.find((s) => s.streamUid === h.streamUid && s.kind === "video");
    if (!stream || stream.width !== h.width || stream.height !== h.height) {
      editorFailure("QA_FAILED", "Tracking source geometry changed");
    }
    const index = JSON.parse((await this.cas.readBytes(asset.presentationIndex)).toString("utf8")) as {
      sourceSha256?: string;
      frames: IndexedFrame[];
    };
    if (index.sourceSha256 !== h.sourceSha256) {
      editorFailure("ARTIFACT_HASH_MISMATCH", "Frame index belongs to another source");
    }
    const indexed = index.frames.filter(
      (f) => f.stream_index === stream.streamIndex && f.media_type === "video",
    );
    const start = request.firstFrame;
    const pts = indexed
      .slice(start, start + request.frameCount)
      .map((f) => f.pts ?? f.best_effort_timestamp);
    if (pts.length !== request.frameCount || pts[h.frame - start] !== h.pts) {
      editorFailure("QA_FAILED", "Anchor clock mismatch");
    }
    const filter = `select=between(n\\,${start}\\,${start + request.frameCount - 1}),settb=${h.timeBase.num}/${h.timeBase.den},showinfo`;
    const { stderr } = await executeMedia([
      "-hide_banner",
      "-nostats",
      "-loglevel",
      "info",
      "-copyts",
      "-noautorotate",
      "-i",
      this.cas.pathFor(asset.original),
      "-map",
      `0:${stream.streamIndex}`,
      "-vf",
      filter,
      ...(await ffmpegOutputTimingArgs(this.ffmpeg, "passthrough")),
      "-frames:v",
      String(request.frameCount),
      "-threads:v",
      "1",
      ...(format === "rgb24"
        ? ["-pix_fmt", "rgb24", "-f", "rawvideo", "source.rgb"]
        : ["-start_number", "0", "-q:v", "2", "frames/%05d.jpg"]),
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
    ) {
      editorFailure("QA_FAILED", "Decoded shot differs from indexed frame order or dimensions");
    }
    return records.map((r) => r[2]!);
  }

  async runTrackMaskJob(
    job: JobSnapshot,
    request: TrackMaskRequest,
    signal: AbortSignal,
  ): Promise<JobSnapshot> {
    const checkAbort = () => {
      if (signal.aborted) editorFailure("CANCELLED", "Mask tracking interrupted");
    };
    checkAbort();

    const sam2Env = configuredSam2Env();
    if (!this.testAdapter?.trackMask && !sam2Env) {
      editorFailure("CAPABILITY_UNAVAILABLE", "SAM2 Tiny is not configured");
    }

    const revision = this.store.objectEdits.approvedTrackingAnchor(request, WORKER_PRINCIPAL);
    const h = revision.anchor;
    const asset = this.store.projects.getAsset(job.projectId, h.assetId, job.revision, WORKER_PRINCIPAL);
    const anchor = await this.cas.readBytes(revision.rawLabelMask);
    if (
      revision.rawLabelMask.sha256 !== h.mask.labelSha256 ||
      anchor.length !== h.width * h.height
    ) {
      editorFailure("ARTIFACT_HASH_MISMATCH", "Tracking label does not match approved anchor");
    }

    const folder = await mkdtemp(path.join(tmpdir(), "ave-mask-track-"));
    const options = {
      cwd: folder,
      signal,
      killSignal: "SIGKILL" as const,
      timeout: 180_000,
      maxBuffer: 4 << 20,
    };
    const ffmpeg = (args: string[]) =>
      execute(this.ffmpeg, ["-nostdin", "-xerror", ...args], options);
    const phase = (detail: string) => {
      checkAbort();
      this.store.jobs.updateJob(job.projectId, job.jobId, (j) => ({ ...j, phaseDetail: detail }));
      this.onProjectEvent(job.projectId);
    };

    try {
      await Promise.all(
        ["frames", "labels", "overlay"].map((name) => mkdir(path.join(folder, name))),
      );
      phase("校验源帧时间戳");
      const pts = await this.prepareShotFrames(asset, h, request, ffmpeg, "jpeg");
      await writeFile(path.join(folder, "anchor.raw"), anchor);
      await writeFile(
        path.join(folder, "request.json"),
        JSON.stringify({ count: request.frameCount, anchor: h.frame - request.firstFrame }),
      );

      phase("SAM2 正在传播掩码");
      let areas: unknown;
      if (this.testAdapter?.trackMask) {
        areas = await this.testAdapter.trackMask({
          directory: folder,
          width: h.width,
          height: h.height,
          count: request.frameCount,
          anchorOffset: h.frame - request.firstFrame,
          anchorRaw: anchor,
        });
      } else if (sam2Env) {
        const script = path.join(this.workerDir, "track_mask.py");
        const { stdout } = await execute(sam2Env.python, ["-I", "-B", script], options);
        areas = JSON.parse(stdout);
      }

      if (!Array.isArray(areas) || areas.length !== pts.length) {
        editorFailure("QA_FAILED", "Incomplete mask sequence");
      }

      phase("校验逐帧标签与审片视频");
      const frames = [];
      for (const [i, time] of pts.entries()) {
        checkAbort();
        const raw = await readFile(path.join(folder, "labels", String(i).padStart(5, "0") + ".raw"));
        if (raw.length !== h.width * h.height) {
          editorFailure("QA_FAILED", "Mask dimensions changed");
        }
        let foregroundPixels = 0;
        for (const v of raw) {
          if (v === 255) foregroundPixels++;
          else if (v !== 0) editorFailure("QA_FAILED", "Non-binary mask");
        }
        if (foregroundPixels !== areas[i]) {
          editorFailure("QA_FAILED", "Mask area mismatch");
        }
        const label = await this.cas.writeBytes(raw, "application/octet-stream");
        const sourceFrame = request.firstFrame + i;
        if (sourceFrame === h.frame && label.sha256 !== h.mask.labelSha256) {
          editorFailure("QA_FAILED", "Tracking changed the approved anchor");
        }
        frames.push({ sourceFrame, pts: time, foregroundPixels, label });
      }

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
      const probeResult = await execute(
        this.ffprobe,
        [
          "-v",
          "error",
          "-show_streams",
          "-show_frames",
          "-show_entries",
          "stream=codec_name,time_base:frame=pts,best_effort_timestamp",
          "-of",
          "json",
          "review.mp4",
        ],
        options,
      );
      const probe = JSON.parse(probeResult.stdout) as {
        streams: Array<{ codec_name: string; time_base: string }>;
        frames: Array<{ pts?: number | string; best_effort_timestamp?: number | string }>;
      };
      const [num, den] = String(probe.streams[0]?.time_base).split("/").map(BigInt);
      const framePts = probe.frames.map((frame) => frame.pts ?? frame.best_effort_timestamp);
      if (
        probe.streams.length !== 1 ||
        probe.streams[0]?.codec_name !== "h264" ||
        framePts.length !== pts.length ||
        framePts.some(
          (value, i) =>
            value === undefined || BigInt(value) * num! * 9n !== BigInt(i) * den!,
        )
      ) {
        editorFailure("QA_FAILED", "Review video frame clock mismatch");
      }

      const reviewVideo = await this.cas.importFile(path.join(folder, "review.mp4"), "video/mp4");
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
      const report = await this.cas.writeJson(manifest);
      const base = { projectId: job.projectId, jobId: job.jobId, revision: job.revision };
      const artifacts: ArtifactRef[] = [
        { ...base, kind: "mask", artifactId: `${job.jobId}:tracked-mask`, blob: report },
        { ...base, kind: "proxy", artifactId: `${job.jobId}:tracking-preview`, blob: reviewVideo },
      ];
      checkAbort();
      this.store.objectEdits.approvedTrackingAnchor(request, WORKER_PRINCIPAL);
      const updated = this.store.jobs.updateJob(job.projectId, job.jobId, (j) => ({
        ...j,
        state: "completed",
        phaseDetail: "掩码传播完成，待审片",
        progress: { completedUnits: String(frames.length), totalUnits: String(frames.length) },
        artifacts,
        error: undefined,
      }));
      this.onProjectEvent(job.projectId);
      return updated;
    } catch (error) {
      checkAbort();
      throw error;
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  private async generationInputs(request: Pick<ProposeVacePreview, "projectId" | "expectedRevision" | "maskApprovalId" | "manifestHash">,
    principal: EditorPrincipal) {
    if (!this.hasVace()) {
      editorFailure("CAPABILITY_UNAVAILABLE", "Configure the local VACE model and Python runtime");
    }
    this.store.devices.authorizeProject(request.projectId, principal, "operator");
    const input = this.store.objectEdits.approvedSequence(
      request.projectId,
      request.maskApprovalId,
      request.manifestHash,
      request.expectedRevision,
      principal,
    );
    const asset = this.store.projects.getAsset(
      request.projectId,
      input.anchor.anchor.assetId,
      request.expectedRevision,
      principal,
    );
    const doc = TrackedMaskManifestSchema.parse(
      JSON.parse((await this.cas.readBytes(input.manifest.blob)).toString("utf8")),
    );
    const stream = asset.streams.find((s) => s.streamUid === doc.streamUid && s.kind === "video");
    if (!stream) {
      editorFailure("ASSET_NOT_FOUND", "Missing generation video stream");
    }
    const anchor = input.anchor.anchor;
    if (doc.projectId !== request.projectId || doc.jobId !== input.manifest.jobId ||
        doc.anchorApprovalId !== input.tracking.anchorApprovalId || doc.anchorHash !== input.tracking.anchorHash ||
        doc.maskRevisionId !== input.anchor.maskRevisionId || doc.sourceSha256 !== asset.original.sha256 ||
        doc.sourcePresentationIndexHash !== asset.presentationIndex.sha256 || doc.assetId !== asset.assetId ||
        doc.streamUid !== anchor.streamUid || doc.width !== stream.width || doc.height !== stream.height ||
        !rationalEquals(doc.timeBase, stream.timeBase) || doc.reviewVideo.sha256 !== input.proxy.blob.sha256 ||
        doc.frames.some((frame, i) => frame.sourceFrame !== input.tracking.firstFrame + i)) {
      editorFailure("REVISION_CONFLICT", "Approved sequence is bound to different source frames");
    }
    const squarePixels = ["1:1", "1/1", "N/A", ""].includes(stream.sampleAspectRatio ?? "");
    const hdr = ["smpte2084", "arib-std-b67"].includes(stream.color?.transfer ?? "");
    if (
      doc.frames.length !== 9 ||
      doc.width % 2 ||
      doc.height % 2 ||
      Number(stream.rotation ?? 0) !== 0 ||
      !squarePixels ||
      hdr
    ) {
      editorFailure(
        "CAPABILITY_UNAVAILABLE",
        "Local VACE needs nine unrotated, square-pixel SDR frames of even size",
      );
    }

    const index = JSON.parse((await this.cas.readBytes(asset.presentationIndex)).toString("utf8")) as {
      frames: IndexedFrame[];
    };
    const rows = index.frames.filter(
      (r) => r.stream_index === stream.streamIndex && r.media_type === "video",
    );
    const first = doc.frames[0]!;
    const last = doc.frames[8]!;
    const start = BigInt(first.pts);
    const step = BigInt(doc.frames[1]!.pts) - start;
    const finalRow = rows[last.sourceFrame];
    const nextRow = rows[last.sourceFrame + 1];
    const duration = nextRow
      ? BigInt(nextRow.pts ?? nextRow.best_effort_timestamp ?? 0) - BigInt(last.pts)
      : BigInt(finalRow?.duration ?? finalRow?.pkt_duration ?? 0);
    if (
      step <= 0n ||
      duration !== step ||
      doc.frames.some(
        (f, i) =>
          BigInt(f.pts) !== start + BigInt(i) * step ||
          f.pts !== (rows[f.sourceFrame]?.pts ?? rows[f.sourceFrame]?.best_effort_timestamp),
      )
    ) {
      editorFailure(
        "CAPABILITY_UNAVAILABLE",
        "Local VACE requires an equally spaced nine-frame range with a known end",
      );
    }
    const n = BigInt(doc.timeBase.num);
    const d = BigInt(doc.timeBase.den);
    if (asset.streams.some((s) => s.kind === "audio") && (9n * step * n * 48000n) % d !== 0n) {
      editorFailure(
        "CAPABILITY_UNAVAILABLE",
        "This shot duration cannot be represented by the 48 kHz output audio clock",
      );
    }
    const probe = await this.cas.readJson<{ format?: { start_time?: string } }>(asset.probe);
    const origin = probeStartTime(probe.format?.start_time) ?? { num: "0", den: "1" };
    const clock = {
      start: rationalSub(rational(start * n, d), origin),
      duration: rational(9n * step * n, d),
      rate: rational(d, step * n),
    };

    return { input, asset, doc, clock };
  }

  async generateShot(plan: AcceptedEditPlan, directory: string, signal: AbortSignal): Promise<GeneratedShot> {
    const g = plan.generationRequests[0]!;
    const config = configuredVaceEnv();
    if (!this.testAdapter?.generateShot && !config) editorFailure("CAPABILITY_UNAVAILABLE", "Local VACE execution is unavailable");
    const { input, asset, doc, clock } = await this.generationInputs({
      projectId: plan.projectId, expectedRevision: plan.baseTimelineRevision, maskApprovalId: g.maskApprovalId!,
      manifestHash: g.referenceManifestHash,
    }, WORKER_PRINCIPAL);
    const trim = plan.trimOperations[0]!;
    if (g.modelId !== VACE_MODEL || g.maskRevisionId !== input.manifest.artifactId || g.shotId !== doc.jobId ||
        trim.source.assetId !== asset.assetId || trim.source.assetContentHash !== doc.sourceSha256 || trim.source.streamUid !== doc.streamUid ||
        !rationalEquals(trim.sourceRange.start, clock.start) || !rationalEquals(trim.sourceRange.duration, clock.duration) ||
        !rationalEquals(clock.rate, g.sampleFps) || g.samplingMapHash !== sha256Json(["source-ordinal", g.referenceManifestHash, input.tracking.firstFrame, 9])) {
      editorFailure("REVISION_CONFLICT", "Generation request differs from the approved mask sequence or timeline");
    }
    const sourcePts = await this.prepareShotFrames(asset, input.anchor.anchor, input.tracking,
      args => execute(this.ffmpeg, args, { cwd: directory, signal, shell: false, timeout: 120_000, maxBuffer: 4 << 20 }), "rgb24");
    const sourcePath = path.join(directory, "source.rgb");
    const sourceRgbHash = await sha256File(sourcePath);
    for (const [i, frame] of doc.frames.entries()) {
      if (sourcePts[i] !== frame.pts) editorFailure("QA_FAILED", "VACE frame does not match the approved source PTS");
      await writeFile(path.join(directory, i + ".raw"), await this.cas.readBytes(frame.label));
    }
    const seed = Number(g.seed);
    await writeFile(path.join(directory, "request.json"), JSON.stringify({
      width: doc.width, height: doc.height, prompt: g.prompt, negativePrompt: g.negativePrompt, seed,
    }));
    try {
      if (this.testAdapter?.generateShot) await this.testAdapter.generateShot(directory, signal);
      else await execute(config!.python, ["-I", "-B", path.join(this.workerDir, "generate_masked_shot.py")], {
        cwd: directory, signal, shell: false, timeout: 20 * 60_000, killSignal: "SIGKILL", maxBuffer: 4 << 20,
        env: { ...process.env, AVE_VACE_MODEL: config!.model, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
      });
    } catch {
      if (signal.aborted) editorFailure("CANCELLED", "VACE generation was cancelled");
      editorFailure("WORKER_FAILED", "VACE generation failed or timed out", true);
    }
    let changedPixels: number[];
    try {
      if (await sha256File(sourcePath) !== sourceRgbHash) editorFailure("QA_FAILED", "VACE modified its reference frames");
      changedPixels = await verifyGeneratedPixels(directory, this.cas, doc.frames, doc.width, doc.height, seed);
    } catch (error) {
      if (error instanceof EditorError) throw error;
      editorFailure("QA_FAILED", "VACE returned an incomplete composite or pixel report");
    }
    const output = path.join(directory, "composite.rgb");
    return { path: output, width: doc.width, height: doc.height, rate: clock.rate, trace: {
      modelRevision: g.modelId, seed, promptHash: sha256Json([g.prompt, g.negativePrompt]),
      maskHash: g.referenceManifestHash, sourceRgbHash, compositeHash: await sha256File(output), sourcePts, changedPixels,
    } };
  }

  async proposeVacePreview(request: ProposeVacePreview, principal: EditorPrincipal): Promise<unknown> {
    const { input, doc, clock } = await this.generationInputs(request, principal);
    const project = this.store.projects.getProjectSnapshot(request.projectId, principal);
    const draft = EditPlanDraftV1Schema.parse({
      schemaVersion: "video.edit-plan/v1",
      projectId: request.projectId,
      baseTimelineRevision: request.expectedRevision,
      baseAssetManifestHash: project.baseAssetManifestHash,
      intent: `VACE 对象编辑 · ${request.prompt}`,
      preferredDeterministicBackendId: "ffmpeg",
      maxCostMicros: "0",
      trimOperations: [
        {
          opId: "trim-1",
          order: "1",
          trackId: "v1",
          clipId: "shot",
          source: {
            assetId: doc.assetId,
            assetContentHash: doc.sourceSha256,
            streamUid: doc.streamUid,
            probeRevision: "1",
          },
          sourceRange: { start: clock.start, duration: clock.duration },
          recordRange: { start: { num: "0", den: "1" }, duration: clock.duration },
        },
      ],
      transformOperations: [],
      transitionOperations: [],
      audioOperations: [],
      subtitleOperations: [],
      qaRequirements: [],
      externalDestinations: [],
      generationRequests: [
        {
          requestId: "generate-1",
          shotId: doc.jobId,
          providerProfileId: VACE_PROFILE,
          modelId: VACE_MODEL,
          prompt: request.prompt,
          negativePrompt: request.negativePrompt,
          maskRevisionId: input.manifest.artifactId,
          maskApprovalId: request.maskApprovalId,
          referenceAssetIds: [],
          referenceManifestHash: request.manifestHash,
          samplingMapHash: sha256Json([
            "source-ordinal",
            request.manifestHash,
            input.tracking.firstFrame,
            9,
          ]),
          frameCount: "9",
          sampleFps: clock.rate,
          seedPolicy: "fixed",
          seed: String(request.seed),
          maxCostMicros: "0",
        },
      ],
    });

    const result = this.store.plans.createPlan({
      requestId: request.requestId,
      runId: request.requestId,
      toolCallId: request.requestId,
      draft,
      principal,
    });
    this.onProjectEvent(request.projectId);
    return result;
  }
}
