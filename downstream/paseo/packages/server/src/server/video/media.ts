import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { ContentAddressedStore, sha256File } from "./cas.js";
import { EditorError, editorFailure } from "./errors.js";
import { assertRenderablePreview } from "./preview-profile.js";
import { encodeFramedChunk } from "#video-editor/bytes";
import { FrameInspector } from "./frame-inspector.js";
import { PyWorker } from "./py-worker.js";
import { EditorStore } from "./store.js";
import {
  SourceAssetSchema,
  StreamDescriptorSchema,
  type AcceptedEditPlan,
  type BlobRef,
  type EditorPrincipal,
  type JobSnapshot,
  type Rational,
  type SourceAsset,
  type StreamDescriptor,
  type ContactSheetResult,
  type InspectFrameRequest,
  type CreateMaskRevisionRequest,
  type MaskAnchorRevision,
} from "#video-editor/contracts/v1";

const execFileAsync = promisify(execFile);

interface ProbeDocument {
  format: { duration?: string; start_time?: string; format_name?: string };
  streams: Array<{
    index: number;
    codec_type: string;
    codec_name?: string;
    profile?: string;
    time_base?: string;
    duration_ts?: number;
    start_pts?: number;
    avg_frame_rate?: string;
    width?: number;
    height?: number;
    sample_rate?: string;
    channels?: number;
    channel_layout?: string;
    color_space?: string;
    color_transfer?: string;
    color_primaries?: string;
    sample_aspect_ratio?: string;
    disposition?: Record<string, number>;
    tags?: Record<string, string>;
    side_data_list?: Array<{ side_data_type?: string; rotation?: number | string }>;
  }>;
  chapters?: unknown[];
}

interface ProcessResult {
  stdout: string;
  stderr: string;
}

export interface MediaTools {
  ffmpeg: string;
  ffprobe: string;
}

export class MediaService {
  private readonly uploadsInFlight = new Map<string, Promise<void>>();
  private readonly py = new PyWorker();
  private readonly frameInspector = new FrameInspector();

  async inspectFrame(input: InspectFrameRequest, principal: EditorPrincipal) {
    const project = this.store.project(input.projectId, principal);
    const asset = project.assets.find(a => a.assetId === input.assetId);
    if (!asset) editorFailure("ASSET_NOT_FOUND", "The asset is not in this project");
    const { header, jpeg } = await this.frameInspector.inspect(input, asset, this.cas, this.tools.ffmpeg);
    return encodeFramedChunk(header, jpeg);
  }

  async createMaskRevision(request: CreateMaskRevisionRequest, principal: EditorPrincipal) {
    const input = request.anchor;
    const previous = this.store.savedMaskApproval(request, principal);
    if (previous) return previous;
    const asset = this.store.asset(input.projectId, input.assetId, request.expectedRevision, principal);
    if (!input.points.length) editorFailure("INVALID_ARGUMENT", "Select a foreground point before saving");
    const rendered = await this.frameInspector.inspect(input, asset, this.cas, this.tools.ffmpeg, request);
    if (!rendered.rawLabelMask || !rendered.header.mask) editorFailure("QA_FAILED", "No anchor label was produced");
    const reviewImage = await this.cas.writeBytes(rendered.jpeg, "image/jpeg");
    return this.store.saveMaskRevision(request, rendered.header, rendered.rawLabelMask, reviewImage, principal);
  }

  async verifyMaskFiles(revision: MaskAnchorRevision) {
    if (revision.rawLabelMask.sha256 !== revision.anchor.mask.labelSha256 ||
        revision.reviewImage.sha256 !== revision.anchor.previewSha256 ||
        BigInt(revision.rawLabelMask.bytes) !== BigInt(revision.anchor.width) * BigInt(revision.anchor.height))
      editorFailure("ARTIFACT_HASH_MISMATCH", "Stored mask or review image differs from its source frame");
    await this.cas.readBytes(revision.rawLabelMask);
    return this.cas.readBytes(revision.reviewImage);
  }

  async readMaskRevision(projectId: string, maskRevisionId: string, principal: EditorPrincipal) {
    const revision = this.store.maskRevision(projectId, maskRevisionId, principal);
    return encodeFramedChunk(revision, await this.verifyMaskFiles(revision));
  }

  /** Working sample rate for analysis jobs (CFR grid); VFR sources keep their index ticks. */
  private static readonly ANALYSIS_RATE = "25/1";

  private async withUpload<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.uploadsInFlight.get(id) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.uploadsInFlight.set(id, tail);
    try {
      return await result;
    } finally {
      if (this.uploadsInFlight.get(id) === tail) this.uploadsInFlight.delete(id);
    }
  }

  constructor(
    private readonly store: EditorStore,
    private readonly cas: ContentAddressedStore,
    private readonly tools: MediaTools = { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
  ) {}

  private async prepareAsset(input: {
    assetId: string;
    displayName: string;
    existingBlob: BlobRef;
  }): Promise<SourceAsset> {
    const original = input.existingBlob;
    const source = this.cas.pathFor(original);
    const probed = await this.probe(source);
    const presentationIndex = await this.presentationIndex(original, probed.streams);
    const probe = await this.cas.writeJson(probed.document);
    const index = await this.cas.writeJson(presentationIndex);
    const proxy = await this.createProxy(source);
    return SourceAssetSchema.parse({
      assetId: input.assetId,
      original,
      displayName: input.displayName,
      streams: probed.streams,
      presentationIndex: index,
      probe,
      proxy,
      sourceNeverWritable: true,
    });
  }

  async executeJob(projectId: string, jobId: string, signal: AbortSignal): Promise<JobSnapshot> {
    const job = this.store.job(projectId, jobId, {
      principalId: "worker",
      role: "owner",
      projectIds: null,
    });
    if (job.kind === "analysis") return this.executeAnalysisJob(projectId, jobId, signal);
    this.store.updateJob(projectId, jobId, (current) => ({
      ...current,
      phaseDetail: "reading approved plan",
    }));
    const plan = await this.readPlan(projectId, job.planHash);
    const project = this.store.project(projectId, {
      principalId: "worker",
      role: "owner",
      projectIds: null,
    });
    if (job.kind === "export") return this.deliver(job, plan, signal);
    if (job.kind !== "preview" && job.kind !== "final")
      editorFailure("CAPABILITY_UNAVAILABLE", "Not a render job");
    const assets = new Map<string, SourceAsset>();
    for (const op of plan.trimOperations) {
      const asset = project.assets.find((a) => a.assetId === op.source.assetId);
      if (!asset || (await sha256File(this.cas.pathFor(asset.original))) !== asset.original.sha256)
        editorFailure("ARTIFACT_HASH_MISMATCH", "A source changed before render");
      assets.set(asset.assetId, asset);
    }
    const firstAsset = assets.get(plan.trimOperations[0]!.source.assetId)!;
    const directory = await mkdtemp(path.join(tmpdir(), "video-render-"));
    let outputBlob: BlobRef;
    try {
      const output = path.join(directory, "candidate.mp4");
      await this.render(assets, firstAsset, plan, job.kind, output, signal);
      this.throwIfCancelled(signal);
      outputBlob = await this.cas.importFile(output, "video/mp4");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    const probe = await this.probe(this.cas.pathFor(outputBlob));
    await this.verifyCandidateDecode(outputBlob, signal);
    const audioProfile = [...assets.values()].flatMap(a => a.streams).find(s => s.kind === "audio");
    checkCandidate(probe.document, firstAsset, plan, job.kind, audioProfile);
    const reviewProxy = job.kind === "final" ? await this.createFinalReviewProxy(outputBlob, signal) : undefined;
    if (reviewProxy) {
      checkCandidate((await this.probe(this.cas.pathFor(reviewProxy))).document, firstAsset, plan, "preview", audioProfile);
      await this.verifyCandidateDecode(reviewProxy, signal);
    }
    const build = await this.run(this.tools.ffmpeg, ["-version"]);
    const qa = await this.cas.writeJson({
      ffmpegBuildHash: createHash("sha256").update(build.stdout).digest("hex"),
      reportId: job.jobId,
      subjectHash: outputBlob.sha256,
      reviewProxyHash: reviewProxy?.sha256,
      revision: job.candidateRevision,
      thresholdsVersion: "deterministic-v1",
      gates: [
        {
          gate: "G4",
          status: "passed",
          checks: [
            { name: "full_decode", status: "passed" },
            { name: "ffprobe", status: "passed" },
          ],
        },
        {
          gate: "G5",
          status: "manual_required",
          checks: [{ name: "human_review", status: "manual_required" }],
        },
      ],
      probe: probe.document,
    });
    this.throwIfCancelled(signal);
    const artifact = {
      artifactId: `${jobId}:candidate`,
      projectId,
      jobId,
      revision: job.revision,
      kind: "candidate" as const,
      blob: outputBlob,
    };
    return this.store.finishCandidate(job, artifact, {
      ...artifact,
      artifactId: `${jobId}:qa`,
      kind: "qa",
      blob: qa,
    }, reviewProxy && { ...artifact, artifactId: `${jobId}:review-proxy`, kind: "proxy", blob: reviewProxy });
  }

  private async deliver(
    job: JobSnapshot,
    plan: AcceptedEditPlan,
    signal: AbortSignal,
  ): Promise<JobSnapshot> {
    const { candidate, qa } = this.store.deliveryInputs(job);
    const report = JSON.parse((await this.cas.readBytes(qa.blob)).toString("utf8"));
    if (
      report.subjectHash !== candidate.blob.sha256 ||
      report.revision !== candidate.revision ||
      report.reportId !== candidate.jobId ||
      !report.gates.some(
        (g: { gate: string; status: string }) => g.gate === "G4" && g.status === "passed",
      )
    )
      editorFailure("QA_FAILED", "Report does not cover the reviewed output");
    if (
      !(await this.cas.has(candidate.blob)) ||
      (await sha256File(this.cas.pathFor(candidate.blob))) !== candidate.blob.sha256
    )
      editorFailure("ARTIFACT_HASH_MISMATCH", "Reviewed bytes changed before delivery");
    const manifest = await this.cas.writeJson({
      exportId: job.jobId,
      output: candidate.blob,
      sourceManifestHash: plan.baseAssetManifestHash,
      revision: candidate.revision,
      planHash: plan.planHash,
      ffmpegBuildHash: report.ffmpegBuildHash,
      modelRuns: [],
      maskLineageRoots: [],
      encoding: report.probe.streams,
      qaReport: report,
      approvalId: job.approvalId,
      segments: plan.trimOperations.map((op) => ({
        opId: op.opId,
        assetId: op.source.assetId,
        assetContentHash: op.source.assetContentHash,
        streamUid: op.source.streamUid,
        sourceRange: op.sourceRange,
        recordRange: op.recordRange,
      })),
      subtitleCues: plan.subtitleOperations.length,
      audioOperations: plan.audioOperations.map((op) => ({
        opId: op.opId,
        clipId: op.clipId,
        gainMilli: op.gainMilli,
        mute: op.mute,
      })),
    });
    this.throwIfCancelled(signal);
    const output = {
      ...candidate,
      jobId: job.jobId,
      artifactId: `${job.jobId}:export`,
      kind: "export" as const,
    };
    return this.store.finishDelivery(job, output, {
      ...output,
      artifactId: `${job.jobId}:manifest`,
      kind: "manifest",
      blob: manifest,
    });
  }

  async writeUploadChunk(
    uploadId: string,
    offset: string,
    payload: Uint8Array,
    principal: EditorPrincipal,
  ): Promise<string> {
    return this.withUpload(uploadId, async () => {
      const upload = this.store.upload(uploadId);
      this.store.uploadStatus(upload.projectId, uploadId, principal);
      const end = BigInt(offset) + BigInt(payload.byteLength);
      if (
        !payload.byteLength ||
        payload.byteLength > 262144 ||
        end > BigInt(upload.expectedSize) ||
        end > BigInt(Number.MAX_SAFE_INTEGER)
      )
        editorFailure("INVALID_ARGUMENT", "Chunk exceeds the declared upload range");
      const digest = createHash("sha256").update(payload).digest("hex");
      const confirmed = this.store.confirmedChunkHash(uploadId, offset);
      if (confirmed === digest) return upload.nextOffset;
      if (confirmed || upload.nextOffset !== offset)
        editorFailure("IDEMPOTENCY_CONFLICT", "Chunk conflicts with the confirmed bytes or offset");
      await this.cas.writeUploadChunk(uploadId, BigInt(offset), payload);
      this.store.confirmChunk({ uploadId, offset, nextOffset: end.toString(), digest });
      return end.toString();
    });
  }

  async commitUpload(
    uploadId: string,
    requestId: string,
    finalSha256: string,
    principal: EditorPrincipal,
  ): Promise<SourceAsset> {
    return this.withUpload(uploadId, () =>
      this.commitConfirmedUpload(uploadId, requestId, finalSha256, principal),
    );
  }

  private async commitConfirmedUpload(
    uploadId: string,
    requestId: string,
    finalSha256: string,
    principal: EditorPrincipal,
  ): Promise<SourceAsset> {
    const receipt = this.store.committedUpload(uploadId, requestId, finalSha256, principal);
    if (receipt) {
      await this.cas.removeTemporary(uploadId);
      return receipt;
    }
    const upload = this.store.upload(uploadId);
    this.store.uploadStatus(upload.projectId, uploadId, principal);
    if (upload.nextOffset !== upload.expectedSize)
      editorFailure("ARTIFACT_HASH_MISMATCH", "Upload has unconfirmed bytes");
    if (upload.expectedSha256 !== finalSha256)
      editorFailure("ARTIFACT_HASH_MISMATCH", "The final hash differs from the upload declaration");
    const blob = await this.cas.commitUpload(
      uploadId,
      finalSha256,
      upload.expectedSize,
      upload.mediaType,
    );
    const asset = await this.prepareAsset({
      assetId: `asset-${uploadId}`,
      displayName: upload.displayName,
      existingBlob: blob,
    });
    const result = this.store.finishUpload(uploadId, asset, requestId, principal);
    await this.cas.removeTemporary(uploadId);
    return result;
  }

  async readPlan(projectId: string, planHash: string): Promise<AcceptedEditPlan> {
    const project = this.store.project(projectId, {
      principalId: "worker",
      role: "owner",
      projectIds: null,
    });
    const plan = project.plans.find((candidate) => candidate.planHash === planHash);
    if (!plan) editorFailure("PROJECT_NOT_FOUND", "The approved plan is unavailable");
    return plan;
  }

  private async probe(
    source: string,
  ): Promise<{ document: ProbeDocument; streams: StreamDescriptor[] }> {
    const { stdout } = await this.run(this.tools.ffprobe, [
      "-v",
      "error",
      "-show_format",
      "-show_streams",
      "-show_chapters",
      "-of",
      "json",
      source,
    ]);
    const document = JSON.parse(stdout) as ProbeDocument;
    const streams = document.streams.map((stream) => {
      if (!stream.time_base || !/^[1-9][0-9]*\/[1-9][0-9]*$/.test(stream.time_base)) {
        editorFailure("PLAN_SEMANTIC_INVALID", "The imported stream has no positive time base");
      }
      const rotation = stream.side_data_list?.find(
        (entry) => entry.rotation !== undefined,
      )?.rotation;
      return StreamDescriptorSchema.parse({
        streamUid: `stream:${stream.index}`,
        streamIndex: stream.index,
        kind: stream.codec_type,
        codec: stream.codec_name ?? "unknown",
        codecProfile: stream.profile,
        timeBase: parseRational(stream.time_base ?? "1/1"),
        averageRate:
          stream.avg_frame_rate && stream.avg_frame_rate !== "0/0"
            ? parseRational(stream.avg_frame_rate)
            : undefined,
        width: stream.width,
        height: stream.height,
        sampleRate: stream.sample_rate ? Number(stream.sample_rate) : undefined,
        channels: stream.channels,
        channelLayout: stream.channel_layout,
        language: stream.tags?.language,
        disposition: stream.disposition ?? {},
        color: compactRecord({
          space: stream.color_space,
          transfer: stream.color_transfer,
          primaries: stream.color_primaries,
        }),
        sampleAspectRatio: stream.sample_aspect_ratio,
        rotation: rotation === undefined ? undefined : String(rotation),
      });
    });
    if (!streams.some((stream) => stream.kind === "video" || stream.kind === "audio")) {
      editorFailure(
        "PLAN_SEMANTIC_INVALID",
        "The imported file has no supported audio or video stream",
      );
    }
    return { document, streams };
  }

  /**
   * Generate a bounded contact sheet (tiled JPEG) for one asset into CAS and
   * return bounded metadata. Tiles are sampled evenly in source time from the
   * presentation index; the image itself stays in CAS and is cited by hash.
   */
  async contactSheet(
    projectId: string,
    assetId: string,
    maxTiles: number,
    principal: EditorPrincipal,
    signal: AbortSignal,
  ): Promise<ContactSheetResult> {
    const project = this.store.project(projectId, principal);
    const asset = project.assets.find((a) => a.assetId === assetId);
    if (!asset) editorFailure("ASSET_NOT_FOUND", "The asset is not in this project");
    if ((await sha256File(this.cas.pathFor(asset.original))) !== asset.original.sha256)
      editorFailure("ARTIFACT_HASH_MISMATCH", "Source changed before contact sheet");
    const indexDoc = JSON.parse((await this.cas.readBytes(asset.presentationIndex)).toString("utf8")) as {
      sourceSha256: string;
      streams: Array<{ streamIndex: number; streamUid: string; timeBase: { num: string; den: string } }>;
      frames: Array<{ stream_index: number; media_type: string; pts?: string; duration?: string }>;
    };
    const video = asset.streams.find((s) => s.kind === "video");
    if (!video) editorFailure("CAPABILITY_UNAVAILABLE", "The asset has no video stream");
    const frames = indexDoc.frames.filter(
      (f) => f.stream_index === video.streamIndex && f.media_type === "video",
    );
    if (!frames.length) editorFailure("CAPABILITY_UNAVAILABLE", "The video stream has no indexed frames");
    const base = { num: BigInt(indexDoc.streams.find((s) => s.streamUid === video.streamUid)!.timeBase.num), den: BigInt(indexDoc.streams.find((s) => s.streamUid === video.streamUid)!.timeBase.den) };
    const tiles = Math.max(1, Math.min(maxTiles, frames.length, 36));
    const columns = Math.ceil(Math.sqrt(tiles));
    const rows = Math.ceil(tiles / columns);
    const tileW = 320;
    const tileH = Math.max(1, Math.round((tileW * (video.height ?? 180)) / (video.width ?? 320)));
    // Evenly spaced source ordinals -> seconds in the source clock; pad the
    // selection with the last frame so the tile grid is always complete.
    const ordinals: number[] = [];
    for (let i = 0; i < tiles; i++) ordinals.push(Math.floor((i * frames.length) / tiles));
    while (ordinals.length < columns * rows) ordinals.push(ordinals[ordinals.length - 1]!);
    const tileSeconds = ordinals.slice(0, tiles).map((o) => {
      const pts = BigInt(frames[o]?.pts ?? "0");
      return (Number(pts * base.num) / Number(base.den)).toFixed(6);
    });
    const select = ordinals.map((o) => `eq(n,${o})`).join("+");
    const directory = await mkdtemp(path.join(tmpdir(), "video-contact-"));
    try {
      const output = path.join(directory, "sheet.jpg");
      await this.spawnChecked(this.tools.ffmpeg, [
        "-nostdin", "-v", "error", "-xerror", "-i", this.cas.pathFor(asset.original),
        "-vf", `select='${select}',scale=${tileW}:${tileH}:force_original_aspect_ratio=decrease,pad=${tileW}:${tileH}:(ow-iw)/2:(oh-ih)/2,setsar=1,tile=${columns}x${rows}`,
        "-frames:v", "1", "-q:v", "4", output,
      ], signal);
      const blob = await this.cas.importFile(output, "image/jpeg");
      const probed = await this.probe(this.cas.pathFor(blob));
      const img = probed.document.streams.find((s) => s.codec_type === "video");
      if (!img || img.width !== columns * tileW || img.height !== rows * tileH)
        editorFailure("QA_FAILED", "Contact sheet geometry differs from the requested grid");
      return {
        artifactId: `contact:${assetId}:${blob.sha256.slice(0, 16)}`,
        projectId,
        assetId,
        sourceSha256: asset.original.sha256,
        columns,
        rows,
        tiles,
        tileWidth: tileW,
        tileHeight: tileH,
        tileSourceSeconds: tileSeconds,
        blob,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /**
   * Analysis job: run the closed Python sampling kernel over the immutable
   * presentation index of one asset and store the map as a QA artifact.
   * Read-only against the source; never re-encodes, never writes outside CAS.
   */
  async executeAnalysisJob(projectId: string, jobId: string, signal: AbortSignal): Promise<JobSnapshot> {
    const worker = { principalId: "worker", role: "owner", projectIds: null } as EditorPrincipal;
    const job = this.store.job(projectId, jobId, worker);
    const assetId = job.analysisAssetId;
    const rate = job.analysisRate ?? MediaService.ANALYSIS_RATE;
    if (!assetId) editorFailure("INVALID_ARGUMENT", "Analysis job has no target asset");
    this.store.updateJob(projectId, jobId, (current) => ({
      ...current,
      phaseDetail: "verifying source hash",
    }));
    const project = this.store.project(projectId, worker);
    const asset = project.assets.find((a) => a.assetId === assetId);
    if (!asset || (await sha256File(this.cas.pathFor(asset.original))) !== asset.original.sha256)
      editorFailure("ARTIFACT_HASH_MISMATCH", "Source changed before analysis");
    this.throwIfCancelled(signal);

    const indexRef = asset.presentationIndex;
    const indexBytes = await this.cas.readBytes(indexRef);
    const indexDoc = JSON.parse(indexBytes.toString("utf8")) as {
      sourceSha256: string;
      streams: Array<{ streamIndex: number; streamUid: string; timeBase: { num: string; den: string } }>;
      frames: Array<{ stream_index: number; media_type: string; pts?: string; duration?: string }>;
    };
    const support = await this.py
      .support(signal)
      .then((s) => s)
      .catch((error) => ({ unavailable: String(error) }));

    this.store.updateJob(projectId, jobId, (current) => ({
      ...current,
      phaseDetail: "running sampling kernel",
    }));
    const streams: unknown[] = [];
    for (const stream of indexDoc.streams) {
      const frames = indexDoc.frames.filter(
        (f) => f.stream_index === stream.streamIndex && f.media_type === "video",
      );
      if (!frames.length) continue;
      this.throwIfCancelled(signal);
      const map = await this.py.samplingMap(
        {
          indexPath: this.cas.pathFor(indexRef),
          indexSha256: indexRef.sha256,
          sourceSha256: asset.original.sha256,
          streamUid: stream.streamUid,
          first: 0,
          stop: frames.length,
          rate,
        },
        signal,
      );
      streams.push({ streamUid: stream.streamUid, timeBase: stream.timeBase, frames: frames.length, map });
    }
    if (!streams.length) editorFailure("CAPABILITY_UNAVAILABLE", "The asset has no video stream");

    const report = await this.cas.writeJson({
      schemaVersion: "video.analysis/v1",
      reportId: jobId,
      assetId,
      sourceSha256: asset.original.sha256,
      indexSha256: indexRef.sha256,
      rate,
      workerSupport: support,
      streams,
    });
    this.throwIfCancelled(signal);
    const artifact = {
      artifactId: `${jobId}:analysis`,
      projectId,
      jobId,
      revision: job.revision,
      kind: "qa" as const,
      blob: report,
    };
    this.store.updateJob(projectId, jobId, (current) => ({
      ...current,
      state: "completed",
      phaseDetail: "analysis complete",
      progress: { completedUnits: String(streams.length), totalUnits: String(streams.length) },
      artifacts: [...current.artifacts, artifact],
      error: undefined,
    }));
    return this.store.job(projectId, jobId, worker);
  }

  private async presentationIndex(
    original: BlobRef,
    streams: StreamDescriptor[],
  ): Promise<unknown> {
    const { stdout } = await this.run(
      this.tools.ffprobe,
      [
        "-v",
        "error",
        "-show_frames",
        "-show_entries",
        "frame=stream_index,media_type,key_frame,pts,best_effort_timestamp,duration,pkt_duration:frame_side_data=",
        "-of",
        "json",
        this.cas.pathFor(original),
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return {
      schemaVersion: "video.presentation-index/v2",
      sourceSha256: original.sha256,
      streams: streams.map(({ streamIndex, streamUid, timeBase }) => ({
        streamIndex,
        streamUid,
        timeBase,
      })),
      frames: parsePresentationFrames(stdout),
    };
  }

  private async createFinalReviewProxy(candidate: BlobRef, signal: AbortSignal): Promise<BlobRef> {
    const directory = await mkdtemp(path.join(tmpdir(), "final-review-"));
    try {
      const output = path.join(directory, "review.mp4");
      await this.spawnChecked(this.tools.ffmpeg, [
        "-nostdin", "-v", "error", "-xerror", "-i", this.cas.pathFor(candidate),
        "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1",
        "-fps_mode", "vfr", "-enc_time_base:v", "filter", "-c:v", "libx264", "-crf", "27", "-pix_fmt", "yuv420p",
        "-c:a", "copy", "-movflags", "+faststart", output,
      ], signal);
      return await this.cas.importFile(output, "video/mp4");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async createProxy(source: string): Promise<BlobRef> {
    const directory = await mkdtemp(path.join(tmpdir(), "video-proxy-"));
    const output = path.join(directory, "proxy.mp4");
    try {
      await this.run(this.tools.ffmpeg, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-i",
        source,
        "-map",
        "0:v:0",
        "-vf",
        "scale='min(640,iw)':-2",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "27",
        "-pix_fmt",
        "yuv420p",
        "-an",
        "-movflags",
        "+faststart",
        output,
      ]);
      return await this.cas.importFile(output, "video/mp4");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async render(
    assets: Map<string, SourceAsset>,
    firstAsset: SourceAsset,
    plan: AcceptedEditPlan,
    kind: "preview" | "final",
    output: string,
    signal: AbortSignal,
  ): Promise<void> {
    assertRenderablePreview(plan);
    if (plan.deterministicBackendId !== "ffmpeg")
      editorFailure("CAPABILITY_UNAVAILABLE", "The approved backend is unavailable");
    const ops = plan.trimOperations;
    const first = ops[0]!;
    const firstVideo = firstAsset.streams.find(
      (s) => s.streamUid === first.source.streamUid && s.kind === "video",
    );
    if (!firstVideo) editorFailure("CAPABILITY_UNAVAILABLE", "The first trim has no video stream");
    // Multi-asset concat: every segment's video must share the first segment's
    // geometry; mismatched geometry is normalized per segment before concat.
    const targetW = firstVideo.width ?? 0;
    const targetH = firstVideo.height ?? 0;
    // One input per segment (each from its own asset); segments are trimmed in
    // source time, rebased to zero, normalized, then concatenated in record
    // order. Source PTS timing is preserved per segment (vfr).
    const args = ["-v", "error", "-xerror", "-nostdin"];
    const filters: string[] = [];
    const audioOps = new Map(plan.audioOperations.map((op) => [op.clipId, op]));
    const audioProfile = [...assets.values()].flatMap(a => a.streams).find(s => s.kind === "audio");
    ops.forEach((op, i) => {
      const asset = assets.get(op.source.assetId)!;
      const video = asset.streams.find(
        (s) => s.streamUid === op.source.streamUid && s.kind === "video",
      );
      if (!video) editorFailure("CAPABILITY_UNAVAILABLE", `Segment ${i} has no video stream`);
      const audio = asset.streams.filter((s) => s.kind === "audio");
      if (audio.length > 1) editorFailure("CAPABILITY_UNAVAILABLE", "At most one audio stream per asset");
      args.push("-i", this.cas.pathFor(asset.original));
      const range = `start=${rationalSeconds(op.sourceRange.start)}:duration=${rationalSeconds(op.sourceRange.duration)}`;
      let vchain = `[${i}:${video.streamIndex}]trim=${range},setpts=PTS-STARTPTS`;
      if (targetW && targetH && (video.width !== targetW || video.height !== targetH))
        vchain += `,scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2`;
      vchain += `,setsar=1[vs${i}]`;
      filters.push(vchain);
      if (audio[0]) {
        if (audio[0].channels !== audioProfile?.channels)
          editorFailure("CAPABILITY_UNAVAILABLE", "Mixed audio channel counts require an explicit mix");
        let chain = `[${i}:${audio[0].streamIndex}]atrim=${range},asetpts=PTS-STARTPTS`;
        const audioOp = audioOps.get(op.clipId);
        if (audioOp) {
          const gainDb = audioOp.mute ? "-inf" : (Number(audioOp.gainMilli) / 1000).toFixed(3);
          chain += `,volume=${gainDb}dB`;
        }
        filters.push(`${chain},aresample=48000[as${i}]`);
      } else if (audioProfile) {
        const layout = audioProfile.channels === 1 ? "mono" : audioProfile.channels === 2 ? "stereo" : undefined;
        if (!layout) editorFailure("CAPABILITY_UNAVAILABLE", "Silent segments require a mono or stereo mix");
        filters.push(`anullsrc=r=48000:cl=${layout},atrim=duration=${rationalSeconds(op.recordRange.duration)},asetpts=PTS-STARTPTS[as${i}]`);
      }
    });
    const vLabels = ops.map((_, i) => `[vs${i}]`).join("");
    // Preserve the source clock for a single trim. concat otherwise quantizes to microseconds.
    const clock = `${firstVideo.timeBase.num}/${firstVideo.timeBase.den}`;
    filters.push(ops.length === 1 ? `${vLabels}null[vcat]` :
      `${vLabels}concat=n=${ops.length}:v=1:a=0,settb=${clock}[vcat]`);
    if (audioProfile) {
      const labels = ops.map((_, i) => `[as${i}]`).join("");
      filters.push(`${labels}concat=n=${ops.length}:v=0:a=1[acat]`);
    }
    filters.push(
      kind === "preview"
        ? "[vcat]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1[vout]"
        : "[vcat]null[vout]",
    );
    let vOut = "[vout]";
    let subDir: string | undefined;
    if (plan.subtitleOperations.length) {
      // Burn-in cues are written to an SRT in record time and rendered after the
      // concat/scale so cue ranges refer to the output timeline, not the source.
      const cues = plan.subtitleOperations.slice().sort((a, b) =>
        BigInt(a.range.start.num) * BigInt(b.range.start.den) <
        BigInt(b.range.start.num) * BigInt(a.range.start.den) ? -1 : 1,
      );
      const fmt = (s: number) => {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = Math.floor(s % 60);
        const ms = Math.round((s - Math.floor(s)) * 1000);
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
      };
      const srt = cues
        .map((cue, i) => {
          const start = Number(rationalSeconds(cue.range.start));
          const end = start + Number(rationalSeconds(cue.range.duration));
          return `${i + 1}\n${fmt(start)} --> ${fmt(end)}\n${cue.text.replace(/\s+/g, " ").trim()}\n`;
        })
        .join("\n");
      subDir = await mkdtemp(path.join(tmpdir(), "video-subs-"));
      const srtPath = path.join(subDir, "cues.srt");
      await writeFile(srtPath, srt, "utf8");
      const escaped = srtPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "'\\''");
      filters.push(
        `[vout]subtitles='${escaped}':force_style='FontSize=18,Outline=1,BackColour=&H80000000&'[vfinal]`,
      );
      vOut = "[vfinal]";
    }
    args.push(
      "-filter_complex",
      filters.join(";"),
      "-map",
      vOut,
      "-fps_mode",
      "vfr",
      ...(kind === "preview" ? ["-enc_time_base:v", "filter"] : []),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
    );
    if (audioProfile)
      args.push("-map", "[acat]", "-c:a", "aac", "-ar", "48000");
    args.push("-movflags", "+faststart", output);
    try {
      await this.spawnChecked(this.tools.ffmpeg, args, signal);
    } finally {
      if (subDir) await rm(subDir, { recursive: true, force: true });
    }
  }

  async verifyCandidateDecode(candidate: BlobRef, signal: AbortSignal): Promise<void> {
    await this.spawnChecked(
      this.tools.ffmpeg,
      ["-v", "error", "-xerror", "-nostdin", "-i", this.cas.pathFor(candidate), "-map", "0", "-f", "null", "-"],
      signal,
    );
  }

  private async run(
    command: string,
    args: string[],
    options: { maxBuffer?: number } = {},
  ): Promise<ProcessResult> {
    try {
      return await execFileAsync(command, args, {
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
        windowsHide: true,
      });
    } catch {
      throw new EditorError("UPSTREAM_UNAVAILABLE", "The media inspection tool failed", true);
    }
  }

  private spawnChecked(command: string, args: string[], signal: AbortSignal): Promise<void> {
    this.throwIfCancelled(signal);
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stderr.resume();
      const cancel = () => child.kill("SIGTERM");
      signal.addEventListener("abort", cancel, { once: true });
      child.once("error", () => {
        signal.removeEventListener("abort", cancel);
        reject(new EditorError("UPSTREAM_UNAVAILABLE", "The media worker could not start", true));
      });
      child.once("close", (code) => {
        signal.removeEventListener("abort", cancel);
        if (signal.aborted)
          return reject(new EditorError("CANCELLED", "The media job was cancelled"));
        if (code !== 0)
          return reject(
            new EditorError("QA_FAILED", "FFmpeg rejected the edit or produced an invalid output"),
          );
        resolve();
      });
    });
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) editorFailure("CANCELLED", "The media job was cancelled");
  }
}

export function assertCandidateAudio(
  source: ReadonlyArray<Pick<StreamDescriptor, "kind" | "channels">>,
  output: ReadonlyArray<Pick<ProbeDocument["streams"][number], "codec_type" | "codec_name" | "sample_rate" | "channels">>,
): void {
  const expected = source.filter(stream => stream.kind === "audio");
  const actual = output.filter(stream => stream.codec_type === "audio");
  if (actual.length !== expected.length || actual.some((stream, index) => {
    const channels = expected[index]?.channels;
    return stream.codec_name !== "aac" || stream.sample_rate !== "48000" ||
      !stream.channels || (channels !== undefined && stream.channels !== channels);
  })) editorFailure("QA_FAILED", "Candidate audio tracks differ from the approved render profile");
}

function checkCandidate(
  doc: ProbeDocument,
  asset: SourceAsset,
  plan: AcceptedEditPlan,
  kind: "preview" | "final",
  audioProfile: StreamDescriptor | undefined,
): void {
  const video = doc.streams.find((s) => s.codec_type === "video");
  const source = asset.streams.find((s) => s.kind === "video");
  const width = kind === "final" ? source?.width : 640;
  const height = kind === "final" ? source?.height : 360;
  const expectedStreams = 1 + (audioProfile ? 1 : 0);
  if (
    !video ||
    video.codec_name !== "h264" ||
    video.width !== width ||
    video.height !== height ||
    doc.streams.length !== expectedStreams
  )
    editorFailure("QA_FAILED", "Unexpected candidate streams or dimensions");
  assertCandidateAudio(audioProfile ? [audioProfile] : [], doc.streams);
  let total = { num: 0n, den: 1n };
  for (const op of plan.trimOperations) {
    total = {
      num: total.num * BigInt(op.recordRange.duration.den) + BigInt(op.recordRange.duration.num) * total.den,
      den: total.den * BigInt(op.recordRange.duration.den),
    };
  }
  const dur: Rational = { num: total.num.toString(), den: total.den.toString() };
  for (const s of doc.streams) {
    if (!s.time_base || !Number.isSafeInteger(s.duration_ts) || s.start_pts !== 0)
      editorFailure("QA_FAILED", "Missing or invalid candidate timeline");
    const base = parseRational(s.time_base);
    const error =
      BigInt(s.duration_ts!) * BigInt(base.num) * BigInt(dur.den) -
      BigInt(dur.num) * BigInt(base.den);
    if (error !== 0n)
      editorFailure("QA_FAILED", "Candidate stream duration differs from the approved trim");
  }
}

const frameTickFields = new Set(["pts", "best_effort_timestamp", "duration", "pkt_duration"]);

export function parsePresentationFrames(json: string): unknown[] {
  // ffprobe emits int64 ticks as JSON numbers. Use the JSON token, not its rounded JS value.
  const document: unknown = JSON.parse(
    json,
    (key: string, value: unknown, context?: { source?: string }) => {
      if (!frameTickFields.has(key)) return value;
      const token = context?.source;
      if (typeof value !== "number" || typeof token !== "string" || !/^-?[0-9]+$/.test(token)) {
        editorFailure("QA_FAILED", "No exact integer token for a probed frame time");
      }
      return token;
    },
  );
  if (
    !document ||
    typeof document !== "object" ||
    !("frames" in document) ||
    !Array.isArray(document.frames)
  ) {
    editorFailure("QA_FAILED", "No decoded frame list in probe output");
  }
  return document.frames;
}

function parseRational(value: string): Rational {
  const [num, den] = value.split("/");
  return { num: num ?? "0", den: den ?? "1" };
}

function rationalSeconds(value: Rational): string {
  const numerator = BigInt(value.num);
  const denominator = BigInt(value.den);
  if (denominator === 0n)
    editorFailure("PLAN_SEMANTIC_INVALID", "A rational time has a zero denominator");
  const sign = numerator < 0n ? "-" : "";
  const absolute = numerator < 0n ? -numerator : numerator;
  const whole = absolute / denominator;
  const remainder = absolute % denominator;
  return `${sign}${whole}.${((remainder * 1_000_000_000n) / denominator).toString().padStart(9, "0")}`;
}

function compactRecord(
  values: Record<string, string | undefined>,
): Record<string, string> | undefined {
  const entries = Object.entries(values).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
