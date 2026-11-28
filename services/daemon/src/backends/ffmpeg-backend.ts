import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sha256File, type ContentAddressedStore } from "@ave/cas";
import {
  EditorError,
  SourceAssetSchema,
  StreamDescriptorSchema,
  editorFailure,
  type AcceptedEditPlan,
  type ArtifactRef,
  type BlobRef,
  type JobSnapshot,
  type Rational,
  type SourceAsset,
  type StreamDescriptor,
} from "@ave/contracts";
import { assertRenderablePreview } from "@ave/domain";
import { ffmpegOutputTimingArgs } from "../media-flags.js";
import type {
  AnalysisArtifactsResult,
  ContactSheetData,
  DeterministicBackend,
  GeneratedShot,
  GenerateShot,
  ProbeAndIndexResult,
  RenderPlanResult,
} from "./deterministic-backend.js";

const execFileAsync = promisify(execFile);
const FRAME_TICK_FIELDS = new Set(["pts", "best_effort_timestamp", "duration", "pkt_duration"]);

export interface ProbeDocument {
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

interface SceneCutDocument {
  schemaVersion: "video.scene-cuts/v1";
  reportId: string;
  assetId: string;
  sourceSha256: string;
  indexSha256: string;
  ffmpegBuildHash: string;
  streamUid: string;
  rate: Rational | null;
  threshold: string;
  minGapSeconds: string;
  frameCount: number;
  truncated: boolean;
  cuts: Array<{ frameIndex: number; ptsTime: string; score: string; aligned: Rational }>;
  stats: { maxScore: string; meanScore: string };
}

interface WaveformDocument {
  schemaVersion: "video.waveform/v1";
  reportId: string;
  assetId: string;
  sourceSha256: string;
  indexSha256: string;
  streamUid: string;
  sampleRate: number;
  bucketMs: number;
  durationAnalyzedMs: string;
  truncated: boolean;
  buckets: string[];
}

export interface FfmpegTools {
  ffmpeg: string;
  ffprobe: string;
}

export class FfmpegBackend implements DeterministicBackend {
  readonly id = "ffmpeg" as const;
  private fontconfigSupport?: Promise<boolean>;

  constructor(
    private readonly tools: FfmpegTools = {
      ffmpeg: process.env.AVE_FFMPEG ?? "ffmpeg",
      ffprobe: process.env.AVE_FFPROBE ?? "ffprobe",
    },
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      await this.run(this.tools.ffmpeg, ["-version"]);
      await this.run(this.tools.ffprobe, ["-version"]);
      return true;
    } catch {
      return false;
    }
  }

  async ffmpegVersion(): Promise<string | undefined> {
    try {
      const { stdout } = await this.run(this.tools.ffmpeg, ["-version"]);
      return stdout.split("\n")[0]?.trim();
    } catch {
      return undefined;
    }
  }

  burnInSubtitlesAvailable(): Promise<boolean> {
    this.fontconfigSupport ??= this.run("fc-list", ["--version"])
      .then(() => true)
      .catch(() => false);
    return this.fontconfigSupport;
  }

  async probeAndIndex(input: {
    assetId: string;
    displayName: string;
    originalBlob: BlobRef;
    cas: ContentAddressedStore;
  }): Promise<ProbeAndIndexResult> {
    const source = input.cas.pathFor(input.originalBlob);
    const probed = await this.probe(source);
    const presentationIndex = await this.presentationIndex(input.originalBlob, source);
    const probeRef = await input.cas.writeJson(probed.document);
    const indexRef = await input.cas.writeJson({
      schemaVersion: "video.presentation-index/v2",
      sourceSha256: input.originalBlob.sha256,
      streams: probed.streams.map(({ streamIndex, streamUid, timeBase }) => ({
        streamIndex,
        streamUid,
        timeBase,
      })),
      frames: presentationIndex,
    });

    const constantRateStreamUids: string[] = [];
    for (const stream of probed.streams) {
      if (stream.kind !== "video" || !stream.averageRate) continue;
      const frames = (presentationIndex as Array<{ stream_index: number; pts?: string }>).filter(
        (f) => f.stream_index === stream.streamIndex,
      );
      const scale = BigInt(stream.timeBase.num) * BigInt(stream.averageRate.num);
      const step = BigInt(stream.timeBase.den) * BigInt(stream.averageRate.den);
      if (
        frames.length > 1 &&
        frames.every(
          (f, i) =>
            f.pts !== undefined &&
            (i === 0 || (BigInt(f.pts) - BigInt(frames[i - 1]!.pts!)) * scale === step),
        )
      ) {
        constantRateStreamUids.push(stream.streamUid);
      }
    }

    const proxy = await this.createProxy(source, input.cas);
    const asset = SourceAssetSchema.parse({
      assetId: input.assetId,
      original: input.originalBlob,
      displayName: input.displayName,
      streams: probed.streams,
      presentationIndex: indexRef,
      probe: probeRef,
      proxy,
      sourceNeverWritable: true,
    });
    return { asset, constantRateStreamUids };
  }

  async renderPlan(input: {
    job: JobSnapshot;
    plan: AcceptedEditPlan;
    generateShot?: GenerateShot;
    assets: Map<string, SourceAsset>;
    cas: ContentAddressedStore;
    signal: AbortSignal;
  }): Promise<RenderPlanResult> {
    const { job, plan, assets, cas, signal } = input;
    if (job.kind !== "preview" && job.kind !== "final") {
      editorFailure("CAPABILITY_UNAVAILABLE", "Not a render job");
    }
    for (const op of [...plan.trimOperations, ...plan.audioOperations]) {
      const asset = assets.get(op.source.assetId);
      if (!asset || (await sha256File(cas.pathFor(asset.original))) !== asset.original.sha256) {
        editorFailure("ARTIFACT_HASH_MISMATCH", "A source changed before render");
      }
    }
    const firstAsset = assets.get(plan.trimOperations[0]!.source.assetId)!;

    const directory = await mkdtemp(path.join(tmpdir(), "ave-render-"));
    let outputBlob: BlobRef;
    let recipeSha256: string;
    let shot: GeneratedShot | undefined;
    try {
      const output = path.join(directory, "candidate.mp4");
      if (plan.generationRequests.length) {
        assertRenderablePreview(plan);
        if (!input.generateShot) editorFailure("CAPABILITY_UNAVAILABLE", "This backend requires a VACE worker");
        shot = await input.generateShot(plan, directory, signal);
      }
      recipeSha256 = await this.renderToFile(assets, firstAsset, plan, job.kind, output, cas, signal, shot);
      if (shot) {
        const control = path.join(directory, "trim-control.mp4");
        await this.renderToFile(assets, firstAsset, plan, job.kind, control, cas, signal);
        const digest = async (file: string) => (await this.run(this.tools.ffmpeg, ["-v", "error", "-nostdin", "-i", file,
          "-map", "0:v:0", "-pix_fmt", "rgb24", "-f", "hash", "-hash", "sha256", "-"])).stdout.trim();
        if (await digest(output) === await digest(control)) editorFailure("QA_FAILED", "Encoded candidate matches the plain trim");
        const frames = JSON.parse((await this.run(this.tools.ffprobe, ["-v", "error", "-select_streams", "v:0",
          "-show_frames", "-show_streams", "-show_entries", "frame=best_effort_timestamp:stream=time_base", "-of", "json", output])).stdout);
        const [n, d] = String(frames.streams[0]?.time_base).split("/").map(BigInt);
        if (frames.frames.length !== 9 || frames.frames.some((f: { best_effort_timestamp: number }, i: number) =>
          BigInt(f.best_effort_timestamp) * n! * BigInt(shot!.rate.num) !== BigInt(i) * d! * BigInt(shot!.rate.den))) {
          editorFailure("QA_FAILED", `Encoded candidate clock ${frames.streams[0]?.time_base} / PTS ${frames.frames.slice(0, 12).map((f: {best_effort_timestamp: number}) => f.best_effort_timestamp)} differs from the approved ${shot.rate.num}/${shot.rate.den} fps timeline`);
        }
      }
      this.throwIfCancelled(signal);
      outputBlob = await cas.importFile(output, "video/mp4");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    const probe = await this.probe(cas.pathFor(outputBlob));
    await this.verifyCandidateDecode(cas.pathFor(outputBlob), signal);

    let audioLoudness: { meanVolumeDb: string; maxVolumeDb: string } | null = null;
    if (probe.document.streams.some((s) => s.codec_type === "audio")) {
      const det = await this.run(this.tools.ffmpeg, [
        "-nostdin",
        "-v",
        "info",
        "-i",
        cas.pathFor(outputBlob),
        "-map",
        "0:a:0",
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
      ]);
      const mean = /mean_volume:\s*(-?[0-9.]+) dB/.exec(det.stderr)?.[1];
      const max = /max_volume:\s*(-?[0-9.]+) dB/.exec(det.stderr)?.[1];
      if (mean && max) audioLoudness = { meanVolumeDb: mean, maxVolumeDb: max };
    }

    const audioProfile = [...assets.values()].flatMap((a) => a.streams).find((s) => s.kind === "audio");
    checkCandidate(probe.document, firstAsset, plan, job.kind, audioProfile);

    const reviewProxy =
      job.kind === "final"
        ? await this.createFinalReviewProxy(outputBlob, probe.document, cas, signal)
        : undefined;
    if (reviewProxy) {
      checkCandidate(
        (await this.probe(cas.pathFor(reviewProxy))).document,
        firstAsset,
        plan,
        "preview",
        audioProfile,
      );
      await this.verifyCandidateDecode(cas.pathFor(reviewProxy), signal);
    }

    const build = await this.run(this.tools.ffmpeg, ["-version"]);
    const qaBlob = await cas.writeJson({
      ffmpegBuildHash: createHash("sha256").update(build.stdout).digest("hex"),
      renderRecipeHash: recipeSha256,
      ...(shot ? { generation: shot.trace } : {}),
      planHash: plan.planHash,
      reportId: job.jobId,
      subjectHash: outputBlob.sha256,
      reviewProxyHash: reviewProxy?.sha256,
      revision: job.candidateRevision,
      thresholdsVersion: "deterministic-v1",
      audioLoudness,
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

    const base: ArtifactRef = {
      artifactId: `${job.jobId}:candidate`,
      projectId: job.projectId,
      jobId: job.jobId,
      revision: job.revision,
      kind: "candidate",
      blob: outputBlob,
    };
    return {
      candidate: base,
      qa: { ...base, artifactId: `${job.jobId}:qa`, kind: "qa", blob: qaBlob },
      ...(reviewProxy
        ? {
            reviewProxy: {
              ...base,
              artifactId: `${job.jobId}:review-proxy`,
              kind: "proxy",
              blob: reviewProxy,
            },
          }
        : {}),
    };
  }

  async deliverExport(input: {
    job: JobSnapshot;
    plan: AcceptedEditPlan;
    candidate: ArtifactRef;
    qa: ArtifactRef;
    cas: ContentAddressedStore;
    signal: AbortSignal;
  }): Promise<{ output: ArtifactRef; manifest: ArtifactRef }> {
    const { job, plan, candidate, qa, cas, signal } = input;
    const report = JSON.parse((await cas.readBytes(qa.blob)).toString("utf8")) as {
      subjectHash?: string;
      revision?: string;
      reportId?: string;
      ffmpegBuildHash?: string;
      renderRecipeHash?: string | null;
      gates?: Array<{ gate: string; status: string }>;
      probe?: { streams?: unknown[] };
    };
    if (
      report.subjectHash !== candidate.blob.sha256 ||
      report.revision !== candidate.revision ||
      report.reportId !== candidate.jobId ||
      !report.gates?.some((g) => g.gate === "G4" && g.status === "passed")
    ) {
      editorFailure("QA_FAILED", "Report does not cover the reviewed output");
    }
    if (
      !(await cas.has(candidate.blob)) ||
      (await sha256File(cas.pathFor(candidate.blob))) !== candidate.blob.sha256
    ) {
      editorFailure("ARTIFACT_HASH_MISMATCH", "Reviewed bytes changed before delivery");
    }

    const manifestBlob = await cas.writeJson({
      exportId: job.jobId,
      output: candidate.blob,
      sourceManifestHash: plan.baseAssetManifestHash,
      revision: candidate.revision,
      planHash: plan.planHash,
      ffmpegBuildHash: report.ffmpegBuildHash,
      renderRecipeHash: report.renderRecipeHash ?? null,
      modelRuns: [],
      maskLineageRoots: [],
      encoding: report.probe?.streams ?? [],
      qaReport: report,
      approvalId: job.approvalId,
      segments: plan.trimOperations.map((op) => ({
        opId: op.opId,
        trackId: op.trackId,
        assetId: op.source.assetId,
        assetContentHash: op.source.assetContentHash,
        streamUid: op.source.streamUid,
        sourceRange: op.sourceRange,
        recordRange: op.recordRange,
        fadeIn: op.fadeIn,
        fadeOut: op.fadeOut,
        overlayX: op.overlayX,
        overlayY: op.overlayY,
      })),
      transitions: plan.transitionOperations.map((tr) => ({
        opId: tr.opId,
        leftClipId: tr.leftClipId,
        rightClipId: tr.rightClipId,
        kind: tr.kind,
        duration: tr.duration,
      })),
      transforms: plan.transformOperations.map((tr) => ({
        opId: tr.opId,
        clipId: tr.clipId,
        crop: tr.crop,
        scale: tr.scale,
        rotationDegrees: tr.rotationDegrees,
      })),
      subtitleCues: plan.subtitleOperations.map((cue) => ({
        opId: cue.opId,
        cueId: cue.cueId,
        range: cue.range,
        mode: cue.mode,
      })),
      audioOperations: plan.audioOperations.map((op) => ({
        opId: op.opId,
        clipId: op.clipId,
        assetId: op.source.assetId,
        assetContentHash: op.source.assetContentHash,
        sourceRange: op.sourceRange,
        gainMilli: op.gainMilli,
        mute: op.mute,
        fadeIn: op.fadeIn,
        fadeOut: op.fadeOut,
      })),
    });
    this.throwIfCancelled(signal);

    const output: ArtifactRef = {
      ...candidate,
      jobId: job.jobId,
      artifactId: `${job.jobId}:export`,
      kind: "export",
    };
    const manifest: ArtifactRef = {
      ...output,
      artifactId: `${job.jobId}:manifest`,
      kind: "manifest",
      blob: manifestBlob,
    };
    return { output, manifest };
  }

  async analyzeAsset(input: {
    job: JobSnapshot;
    asset: SourceAsset;
    cas: ContentAddressedStore;
    rate: string;
    signal: AbortSignal;
  }): Promise<AnalysisArtifactsResult> {
    const { job, asset, cas, rate, signal } = input;
    if ((await sha256File(cas.pathFor(asset.original))) !== asset.original.sha256) {
      editorFailure("ARTIFACT_HASH_MISMATCH", "Source changed before analysis");
    }
    this.throwIfCancelled(signal);

    const scene = await this.sceneCutReport(asset, job.jobId, cas, signal);
    this.throwIfCancelled(signal);
    const waveform = await this.waveformReport(asset, job.jobId, cas, signal);
    this.throwIfCancelled(signal);

    const reportBlob = await cas.writeJson({
      schemaVersion: "video.analysis/v1",
      reportId: job.jobId,
      assetId: asset.assetId,
      sourceSha256: asset.original.sha256,
      indexSha256: asset.presentationIndex.sha256,
      rate,
      sceneCuts: {
        artifactId: `${job.jobId}:scenecuts`,
        sha256: scene.blob.sha256,
        threshold: scene.doc.threshold,
        cutCount: scene.doc.cuts.length,
        truncated: scene.doc.truncated,
      },
      waveform: waveform
        ? {
            artifactId: `${job.jobId}:waveform`,
            sha256: waveform.blob.sha256,
            bucketMs: waveform.doc.bucketMs,
            bucketCount: waveform.doc.buckets.length,
            truncated: waveform.doc.truncated,
          }
        : null,
    });
    this.throwIfCancelled(signal);

    return {
      analysisQa: {
        artifactId: `${job.jobId}:analysis`,
        projectId: job.projectId,
        jobId: job.jobId,
        revision: job.revision,
        kind: "qa",
        blob: reportBlob,
      },
      sceneCuts: {
        artifactId: `${job.jobId}:scenecuts`,
        projectId: job.projectId,
        jobId: job.jobId,
        revision: job.revision,
        kind: "scenecuts",
        blob: scene.blob,
      },
      ...(waveform
        ? {
            waveform: {
              artifactId: `${job.jobId}:waveform`,
              projectId: job.projectId,
              jobId: job.jobId,
              revision: job.revision,
              kind: "waveform",
              blob: waveform.blob,
            },
          }
        : {}),
      units: 1 + (waveform ? 1 : 0),
    };
  }

  async contactSheet(input: {
    asset: SourceAsset;
    maxTiles: number;
    cas: ContentAddressedStore;
    signal: AbortSignal;
  }): Promise<ContactSheetData> {
    const { asset, maxTiles, cas, signal } = input;
    if ((await sha256File(cas.pathFor(asset.original))) !== asset.original.sha256) {
      editorFailure("ARTIFACT_HASH_MISMATCH", "Source changed before contact sheet");
    }
    const indexDoc = (await cas.readJson<{
      streams: Array<{ streamIndex: number; streamUid: string; timeBase: { num: string; den: string } }>;
      frames: Array<{ stream_index: number; media_type: string; pts?: string }>;
    }>(asset.presentationIndex));
    const video = asset.streams.find((s) => s.kind === "video");
    if (!video) editorFailure("CAPABILITY_UNAVAILABLE", "The asset has no video stream");
    const frames = indexDoc.frames.filter(
      (f) => f.stream_index === video.streamIndex && f.media_type === "video",
    );
    if (!frames.length) editorFailure("CAPABILITY_UNAVAILABLE", "The video stream has no indexed frames");
    const streamClock = indexDoc.streams.find((s) => s.streamUid === video.streamUid)!;
    const base = { num: BigInt(streamClock.timeBase.num), den: BigInt(streamClock.timeBase.den) };
    const tiles = Math.max(1, Math.min(maxTiles, frames.length, 36));
    const columns = Math.ceil(Math.sqrt(tiles));
    const rows = Math.ceil(tiles / columns);
    const tileW = 320;
    const tileH = Math.max(1, Math.round((tileW * (video.height ?? 180)) / (video.width ?? 320)));
    const ordinals: number[] = [];
    for (let i = 0; i < tiles; i++) ordinals.push(Math.floor((i * frames.length) / tiles));
    while (ordinals.length < columns * rows) ordinals.push(ordinals[ordinals.length - 1]!);
    const tileSeconds = ordinals.slice(0, tiles).map((o) => {
      const pts = BigInt(frames[o]?.pts ?? "0");
      return (Number(pts * base.num) / Number(base.den)).toFixed(6);
    });
    const select = ordinals.map((o) => `eq(n,${o})`).join("+");
    const directory = await mkdtemp(path.join(tmpdir(), "ave-contact-"));
    try {
      const output = path.join(directory, "sheet.jpg");
      await this.spawnChecked(
        this.tools.ffmpeg,
        [
          "-nostdin",
          "-v",
          "error",
          "-xerror",
          "-i",
          cas.pathFor(asset.original),
          "-vf",
          `select='${select}',scale=${tileW}:${tileH}:force_original_aspect_ratio=decrease,pad=${tileW}:${tileH}:(ow-iw)/2:(oh-ih)/2,setsar=1,tile=${columns}x${rows}`,
          "-frames:v",
          "1",
          "-q:v",
          "4",
          output,
        ],
        signal,
      );
      const blob = await cas.importFile(output, "image/jpeg");
      return {
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

  async previewFrames(input: {
    candidate: ArtifactRef;
    maxTiles: number;
    cas: ContentAddressedStore;
    signal: AbortSignal;
  }): Promise<ContactSheetData> {
    const { candidate, maxTiles, cas, signal } = input;
    const sourcePath = cas.pathFor(candidate.blob);
    if ((await sha256File(sourcePath)) !== candidate.blob.sha256) {
      editorFailure("ARTIFACT_HASH_MISMATCH", "Candidate bytes changed before storyboard");
    }
    const probed = await this.probe(sourcePath);
    const video = probed.document.streams.find((s) => s.codec_type === "video");
    if (!video) editorFailure("CAPABILITY_UNAVAILABLE", "The candidate has no video stream");
    const durationSec = Number(probed.document.format.duration ?? "0");
    if (!(durationSec > 0)) {
      editorFailure("CAPABILITY_UNAVAILABLE", "The candidate has no measurable duration");
    }
    const tiles = Math.max(1, Math.min(maxTiles, 36, Math.floor(durationSec)));
    const fps = tiles / durationSec;
    const columns = Math.ceil(Math.sqrt(tiles));
    const rows = Math.ceil(tiles / columns);
    const tileW = 320;
    const tileH = Math.max(1, Math.round((tileW * (video.height ?? 180)) / (video.width ?? 320)));
    const directory = await mkdtemp(path.join(tmpdir(), "ave-frames-"));
    try {
      const output = path.join(directory, "frames.jpg");
      await this.spawnChecked(
        this.tools.ffmpeg,
        [
          "-nostdin",
          "-v",
          "error",
          "-xerror",
          "-i",
          sourcePath,
          "-vf",
          `fps=${fps.toFixed(6)},scale=${tileW}:${tileH}:force_original_aspect_ratio=decrease,pad=${tileW}:${tileH}:(ow-iw)/2:(oh-ih)/2,setsar=1,tile=${columns}x${rows}`,
          "-frames:v",
          "1",
          "-q:v",
          "4",
          output,
        ],
        signal,
      );
      const blob = await cas.importFile(output, "image/jpeg");
      const tileSourceSeconds: string[] = [];
      for (let i = 0; i < tiles; i++) tileSourceSeconds.push(((i + 0.5) / fps).toFixed(6));
      return {
        columns,
        rows,
        tiles,
        tileWidth: tileW,
        tileHeight: tileH,
        tileSourceSeconds,
        blob,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
      const rotation = stream.side_data_list?.find((entry) => entry.rotation !== undefined)?.rotation;
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

  private async presentationIndex(original: BlobRef, sourcePath: string): Promise<unknown[]> {
    const { stdout } = await this.run(
      this.tools.ffprobe,
      [
        "-v",
        "error",
        "-show_frames",
        "-show_entries",
        // FFprobe 4.x rejects an empty frame_side_data section selector. Decoded
        // side data remains optional and display-geometry checks fail closed.
        "frame=stream_index,media_type,key_frame,pts,best_effort_timestamp,duration,pkt_duration",
        "-of",
        "json",
        sourcePath,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    void original;
    return parsePresentationFrames(stdout);
  }

  private async createProxy(source: string, cas: ContentAddressedStore): Promise<BlobRef> {
    const directory = await mkdtemp(path.join(tmpdir(), "ave-proxy-"));
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
      return await cas.importFile(output, "video/mp4");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async createFinalReviewProxy(
    candidate: BlobRef,
    probe: ProbeDocument,
    cas: ContentAddressedStore,
    signal: AbortSignal,
  ): Promise<BlobRef> {
    const clock = probe.streams.find((stream) => stream.codec_type === "video")?.time_base;
    if (!clock || !/^[1-9][0-9]*\/[1-9][0-9]*$/.test(clock)) {
      editorFailure("QA_FAILED", "Missing video time base for review proxy");
    }
    const directory = await mkdtemp(path.join(tmpdir(), "ave-review-"));
    try {
      const output = path.join(directory, "review.mp4");
      await this.spawnChecked(
        this.tools.ffmpeg,
        [
          "-nostdin",
          "-v",
          "error",
          "-xerror",
          "-i",
          cas.pathFor(candidate),
          "-map",
          "0:v:0",
          "-map",
          "0:a:0?",
          "-vf",
          "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1",
          ...(await ffmpegOutputTimingArgs(this.tools.ffmpeg, "vfr")),
          "-enc_time_base:v",
          clock,
          "-c:v",
          "libx264",
          "-crf",
          "27",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "copy",
          "-movflags",
          "+faststart",
          output,
        ],
        signal,
      );
      return await cas.importFile(output, "video/mp4");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async renderToFile(
    assets: Map<string, SourceAsset>,
    firstAsset: SourceAsset,
    plan: AcceptedEditPlan,
    kind: "preview" | "final",
    output: string,
    cas: ContentAddressedStore,
    signal: AbortSignal,
    shot?: GeneratedShot,
  ): Promise<string> {
    assertRenderablePreview(plan);
    if (plan.deterministicBackendId !== "ffmpeg") {
      editorFailure("CAPABILITY_UNAVAILABLE", "The approved backend is unavailable");
    }
    if (
      plan.subtitleOperations.some((c) => c.mode === "burn-in") &&
      !(await this.burnInSubtitlesAvailable())
    ) {
      editorFailure(
        "CAPABILITY_UNAVAILABLE",
        "Burn-in subtitles need fontconfig fonts; use mode=metadata (mov_text sidecar) on this host",
      );
    }

    const ops = plan.trimOperations;
    const first = ops[0]!;
    const firstVideo = firstAsset.streams.find(
      (s) => s.streamUid === first.source.streamUid && s.kind === "video",
    );
    if (!firstVideo) editorFailure("CAPABILITY_UNAVAILABLE", "The first trim has no video stream");

    const transformOps = new Map(plan.transformOperations.map((t) => [t.clipId, t]));
    const segGeo = ops.map((op) => {
      const asset = assets.get(op.source.assetId)!;
      const video = asset.streams.find(
        (s) => s.streamUid === op.source.streamUid && s.kind === "video",
      );
      if (!video) editorFailure("CAPABILITY_UNAVAILABLE", "A trim has no video stream");
      return segmentGeometry(video, transformOps.get(op.clipId));
    });

    const trackTarget = new Map<string, { width: number; height: number }>();
    for (const op of ops) {
      if (!trackTarget.has(op.trackId)) trackTarget.set(op.trackId, segGeo[ops.indexOf(op)]!);
    }

    const args = ["-v", "error", "-xerror", "-nostdin"];
    const filters: string[] = [];
    const audioOps = new Map(plan.audioOperations.map((op) => [op.clipId, op]));
    const audioProfile = [...assets.values()].flatMap((a) => a.streams).find((s) => s.kind === "audio");

    ops.forEach((op) => {
      args.push("-i", cas.pathFor(assets.get(op.source.assetId)!.original));
    });
    const audioInput = new Map<string, number>();
    for (const op of ops) {
      const audioOp = op.trackId === "v1" ? audioOps.get(op.clipId) : undefined;
      if (
        audioOp &&
        audioOp.source.assetId !== op.source.assetId &&
        !audioInput.has(audioOp.source.assetId)
      ) {
        args.push("-i", cas.pathFor(assets.get(audioOp.source.assetId)!.original));
        audioInput.set(audioOp.source.assetId, ops.length + audioInput.size);
      }
    }

    if (shot) {
      args.push("-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", shot.width + "x" + shot.height,
        "-framerate", shot.rate.num + "/" + shot.rate.den, "-i", shot.path);
    }
    const generatedIndex = ops.length + audioInput.size;
    const audioSegments: number[] = [];
    ops.forEach((op, i) => {
      const asset = assets.get(op.source.assetId)!;
      const video = asset.streams.find(
        (s) => s.streamUid === op.source.streamUid && s.kind === "video",
      );
      if (!video) editorFailure("CAPABILITY_UNAVAILABLE", `Segment ${i} has no video stream`);
      const range = `start=${rationalSecondsPrecise(op.sourceRange.start)}:duration=${rationalSecondsPrecise(op.sourceRange.duration)}`;
      let vchain = shot ? "[" + generatedIndex + ":v:0]setpts=PTS-STARTPTS"
        : `[${i}:${video.streamIndex}]trim=${range},setpts=PTS-STARTPTS`;
      vchain += transformFilterChain(video, transformOps.get(op.clipId));
      const vDurSec = Number(rationalSecondsPrecise(op.recordRange.duration));
      if (op.fadeIn) {
        const d = Number(rationalSecondsPrecise(op.fadeIn));
        vchain += `,fade=t=in:st=0:d=${d.toFixed(6)}`;
      }
      if (op.fadeOut) {
        const d = Number(rationalSecondsPrecise(op.fadeOut));
        vchain += `,fade=t=out:st=${Math.max(0, vDurSec - d).toFixed(6)}:d=${d.toFixed(6)}`;
      }
      const geo = segGeo[i]!;
      const tt = trackTarget.get(op.trackId)!;
      if (tt.width && tt.height && (geo.width !== tt.width || geo.height !== tt.height)) {
        vchain += `,scale=${tt.width}:${tt.height}:force_original_aspect_ratio=decrease,pad=${tt.width}:${tt.height}:(ow-iw)/2:(oh-ih)/2`;
      }
      vchain += `,setsar=1[vs${i}]`;
      filters.push(vchain);

      if (op.trackId !== "v1") return;
      const audioOp = audioOps.get(op.clipId);
      const audioAsset = audioOp ? assets.get(audioOp.source.assetId)! : asset;
      const audioIdx =
        audioOp && audioOp.source.assetId !== op.source.assetId
          ? audioInput.get(audioOp.source.assetId)!
          : i;
      const audioRange = audioOp
        ? `start=${rationalSecondsPrecise(audioOp.sourceRange.start)}:duration=${rationalSecondsPrecise(audioOp.sourceRange.duration)}`
        : range;
      const audio = audioAsset.streams.filter((s) => s.kind === "audio");
      if (audio.length > 1) editorFailure("CAPABILITY_UNAVAILABLE", "At most one audio stream per asset");
      const stream = audioOp ? audio.find((a) => a.streamUid === audioOp.source.streamUid) : audio[0];
      if (stream) {
        if (stream.channels !== audioProfile?.channels) {
          editorFailure("CAPABILITY_UNAVAILABLE", "Mixed audio channel counts require an explicit mix");
        }
        audioSegments.push(i);
        let chain = `[${audioIdx}:${stream.streamIndex}]atrim=${audioRange},asetpts=PTS-STARTPTS`;
        if (audioOp) {
          const gainDb = audioOp.mute ? "-inf" : (Number(audioOp.gainMilli) / 1000).toFixed(3);
          chain += `,volume=${gainDb}dB`;
          const durSec = Number(rationalSecondsPrecise(op.recordRange.duration));
          if (audioOp.fadeIn) {
            const d = Number(rationalSecondsPrecise(audioOp.fadeIn));
            chain += `,afade=t=in:st=0:d=${d.toFixed(6)}`;
          }
          if (audioOp.fadeOut) {
            const d = Number(rationalSecondsPrecise(audioOp.fadeOut));
            chain += `,afade=t=out:st=${Math.max(0, durSec - d).toFixed(6)}:d=${d.toFixed(6)}`;
          }
        }
        filters.push(`${chain},aresample=48000[as${i}]`);
      } else if (audioProfile) {
        const layout =
          audioProfile.channels === 1 ? "mono" : audioProfile.channels === 2 ? "stereo" : undefined;
        if (!layout) editorFailure("CAPABILITY_UNAVAILABLE", "Silent segments require a mono or stereo mix");
        audioSegments.push(i);
        filters.push(
          `anullsrc=r=48000:cl=${layout},atrim=duration=${rationalSecondsPrecise(op.recordRange.duration)},asetpts=PTS-STARTPTS[as${i}]`,
        );
      }
    });

    const transitions = new Map(plan.transitionOperations.map((tr) => [tr.leftClipId, tr]));
    const segDur = (i: number) => Number(rationalSecondsPrecise(ops[i]!.recordRange.duration));
    const trackOrder = [...new Set(ops.map((op) => op.trackId))].sort((a, b) =>
      a === "v1" ? -1 : b === "v1" ? 1 : a.localeCompare(b),
    );
    const sourceTimeBase = `${firstVideo.timeBase.num}/${firstVideo.timeBase.den}`;
    const trackOut: string[] = [];

    for (const trackId of trackOrder) {
      const indices = ops
        .map((op, i) => [op, i] as const)
        .filter(([op]) => op.trackId === trackId)
        .map(([, i]) => i);
      const tag = trackId.replace(/[^A-Za-z0-9]/g, "");
      const trackTransitions = indices
        .map((i) => transitions.get(ops[i]!.clipId))
        .filter((tr) => tr !== undefined);
      if (!trackTransitions.length) {
        const vLabels = indices.map((i) => `[vs${i}]`).join("");
        filters.push(
          indices.length === 1
            ? `${vLabels}null[vcat_${tag}]`
            : `${vLabels}concat=n=${indices.length}:v=1:a=0,settb=${sourceTimeBase}[vcat_${tag}]`,
        );
        trackOut.push(`[vcat_${tag}]`);
        continue;
      }
      let vAcc = `vs${indices[0]!}`;
      let vAccDur = segDur(indices[0]!);
      for (let k = 1; k < indices.length; k++) {
        const i = indices[k]!;
        const prev = indices[k - 1]!;
        const tr = transitions.get(ops[prev]!.clipId);
        if (!tr) {
          filters.push(`[${vAcc}][vs${i}]concat=n=2:v=1:a=0[vacc_${tag}_${k}]`);
          vAcc = `vacc_${tag}_${k}`;
          vAccDur += segDur(i);
          continue;
        }
        const firstOp = ops[indices[0]!]!;
        const rate0 = assets
          .get(firstOp.source.assetId)!
          .streams.find((s) => s.streamUid === firstOp.source.streamUid)!.averageRate;
        const vRate = assets
          .get(ops[i]!.source.assetId)!
          .streams.find((s) => s.streamUid === ops[i]!.source.streamUid)!.averageRate;
        if (JSON.stringify(rate0 ?? null) !== JSON.stringify(vRate ?? null)) {
          editorFailure("CAPABILITY_UNAVAILABLE", "Crossfade requires equal segment frame rates");
        }
        if (
          rate0 &&
          (BigInt(tr.duration.num) * BigInt(rate0.num)) %
            (BigInt(tr.duration.den) * BigInt(rate0.den)) !==
            0n
        ) {
          editorFailure("CAPABILITY_UNAVAILABLE", "Transition duration must align to whole frames");
        }
        const trDur = Number(rationalSecondsPrecise(tr.duration));
        const offset = Math.max(0, vAccDur - trDur);
        filters.push(
          `[${vAcc}][vs${i}]xfade=transition=${tr.kind === "crossfade" ? "fade" : "fadeblack"}:duration=${trDur.toFixed(6)}:offset=${offset.toFixed(6)}[vacc_${tag}_${k}]`,
        );
        vAcc = `vacc_${tag}_${k}`;
        vAccDur = offset + segDur(i);
      }
      filters.push(`[${vAcc}]null[vcat_${tag}]`);
      trackOut.push(`[vcat_${tag}]`);
    }

    if (trackOut.length === 1) {
      filters.push(`${trackOut[0]}null[vcat]`);
    } else {
      const v2op = ops.find((op) => op.trackId === "v2")!;
      filters.push(
        `${trackOut[0]}${trackOut[1]}overlay=${v2op.overlayX ?? "0"}:${v2op.overlayY ?? "0"}:eof_action=pass[vcat]`,
      );
    }

    if (audioSegments.length) {
      const v1Count = ops.filter((op) => op.trackId === "v1").length;
      if (plan.transitionOperations.length && audioSegments.length !== v1Count) {
        editorFailure("CAPABILITY_UNAVAILABLE", "Crossfade requires audio on every main-track segment");
      }
      const aLabels = audioSegments.map((i) => `[as${i}]`).join("");
      if (!plan.transitionOperations.length) {
        filters.push(
          audioSegments.length === 1
            ? `${aLabels}anull[acat]`
            : `${aLabels}concat=n=${audioSegments.length}:v=0:a=1[acat]`,
        );
      } else {
        let aAcc = `as${audioSegments[0]!}`;
        let aAccDur = segDur(audioSegments[0]!);
        for (let k = 1; k < audioSegments.length; k++) {
          const i = audioSegments[k]!;
          const tr = transitions.get(ops[audioSegments[k - 1]!]!.clipId);
          if (!tr) {
            filters.push(`[${aAcc}][as${i}]concat=n=2:v=0:a=1[aacc${k}]`);
            aAcc = `aacc${k}`;
            aAccDur += segDur(i);
            continue;
          }
          const trDur = Number(rationalSecondsPrecise(tr.duration));
          const offset = Math.max(0, aAccDur - trDur);
          filters.push(
            `[${aAcc}][as${i}]acrossfade=d=${trDur.toFixed(6)}:c1=tri:c2=tri[aacc${k}]`,
          );
          aAcc = `aacc${k}`;
          aAccDur = offset + segDur(i);
        }
        filters.push(`[${aAcc}]anull[acat]`);
      }
    }

    filters.push(
      kind === "preview"
        ? "[vcat]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1[vout]"
        : "[vcat]null[vout]",
    );

    let vOut = "[vout]";
    let subDir: string | undefined;
    const cues = plan.subtitleOperations.slice().sort((a, b) =>
      BigInt(a.range.start.num) * BigInt(b.range.start.den) <
      BigInt(b.range.start.num) * BigInt(a.range.start.den)
        ? -1
        : 1,
    );
    const fmt = (s: number) => {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = Math.floor(s % 60);
      const ms = Math.round((s - Math.floor(s)) * 1000);
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
    };
    const toSrt = (list: typeof cues) =>
      list
        .map((cue, i) => {
          const start = Number(rationalSecondsPrecise(cue.range.start));
          const end = start + Number(rationalSecondsPrecise(cue.range.duration));
          return `${i + 1}\n${fmt(start)} --> ${fmt(end)}\n${cue.text.replace(/\s+/g, " ").trim()}\n`;
        })
        .join("\n");

    const burnCues = cues.filter((c) => c.mode === "burn-in");
    const metaCues = cues.filter((c) => c.mode === "metadata");
    if (burnCues.length) {
      subDir = await mkdtemp(path.join(tmpdir(), "ave-subs-"));
      const srtPath = path.join(subDir, "cues.srt");
      await writeFile(srtPath, toSrt(burnCues), "utf8");
      const escaped = srtPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "'\\''");
      filters.push(
        `[vout]subtitles='${escaped}':force_style='FontSize=18,Outline=1,BackColour=&H80000000&'[vfinal]`,
      );
      vOut = "[vfinal]";
    }
    let metaSrtIndex = -1;
    if (metaCues.length) {
      subDir ??= await mkdtemp(path.join(tmpdir(), "ave-subs-"));
      const srtPath = path.join(subDir, "sidecar.srt");
      await writeFile(srtPath, toSrt(metaCues), "utf8");
      args.push("-i", srtPath);
      metaSrtIndex = args.reduce((n, a) => (a === "-i" ? n + 1 : n), 0) - 1;
    }

    const generationRate = plan.generationRequests[0]?.sampleFps;
    const previewClock = trackOrder.length === 1 && !transitions.size ? sourceTimeBase : "filter";
    args.push(
      "-filter_complex",
      filters.join(";"),
      "-map",
      vOut,
      ...(await ffmpegOutputTimingArgs(this.tools.ffmpeg, generationRate ? "cfr" : "vfr")),
      ...(generationRate ? ["-r:v", generationRate.num + "/" + generationRate.den, "-enc_time_base:v", generationRate.den + "/" + generationRate.num]
        : kind === "preview" ? ["-enc_time_base:v", previewClock] : []),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
    );
    if (audioSegments.length) args.push("-map", "[acat]", "-c:a", "aac", "-ar", "48000");
    if (metaSrtIndex >= 0) args.push("-map", `${metaSrtIndex}:0`, "-c:s", "mov_text");
    args.push("-movflags", "+faststart", output);

    const normalized = args.map((a) =>
      a === output ? "<output>" : shot && a === shot.path ? shot.trace.compositeHash : subDir ? a.split(subDir).join("<tmp>") : a,
    );
    const recipeSha256 = createHash("sha256").update(JSON.stringify(shot ? [normalized, shot.trace] : normalized)).digest("hex");
    try {
      await this.spawnChecked(this.tools.ffmpeg, args, signal);
    } finally {
      if (subDir) await rm(subDir, { recursive: true, force: true });
    }
    return recipeSha256;
  }

  private async verifyCandidateDecode(candidatePath: string, signal: AbortSignal): Promise<void> {
    await this.spawnChecked(
      this.tools.ffmpeg,
      ["-v", "error", "-xerror", "-nostdin", "-i", candidatePath, "-map", "0:v?", "-map", "0:a?", "-f", "null", "-"],
      signal,
    );
  }

  private async sceneCutReport(
    asset: SourceAsset,
    jobId: string,
    cas: ContentAddressedStore,
    signal: AbortSignal,
  ): Promise<{ blob: BlobRef; doc: SceneCutDocument }> {
    const video = asset.streams.find((s) => s.kind === "video");
    if (!video) editorFailure("CAPABILITY_UNAVAILABLE", "The asset has no video stream");
    const threshold = 0.3;
    const minGap = 0.5;
    const maxCuts = 64;
    const directory = await mkdtemp(path.join(tmpdir(), "ave-scene-"));
    try {
      const metadataPath = path.join(directory, "scene.txt");
      await this.spawnChecked(
        this.tools.ffmpeg,
        [
          "-nostdin",
          "-v",
          "error",
          "-xerror",
          "-i",
          cas.pathFor(asset.original),
          "-map",
          "0:v:0",
          "-vf",
          `settb=${video.timeBase.num}/${video.timeBase.den},select='gte(scene,0)',metadata=print:file=scene.txt`,
          "-f",
          "null",
          "-",
        ],
        signal,
        directory,
      );
      const text = await readFile(metadataPath, "utf8");
      this.throwIfCancelled(signal);
      const cuts: SceneCutDocument["cuts"] = [];
      let candidateCount = 0;
      let frameIndex = -1;
      let pts = 0n;
      let ptsTime = "0";
      let lastCut = -Infinity;
      let count = 0;
      let sum = 0;
      let max = 0;
      for (const line of text.split("\n")) {
        if (line.startsWith("frame:")) {
          frameIndex = Number(/frame:(\d+)/.exec(line)?.[1] ?? "-1");
          const timestamp = /\bpts:(-?\d+)/.exec(line);
          if (!timestamp) editorFailure("QA_FAILED", "Scene frame has no presentation timestamp");
          pts = BigInt(timestamp[1]!);
          ptsTime = rationalSecondsPrecise({
            num: String(pts * BigInt(video.timeBase.num)),
            den: video.timeBase.den,
          });
          continue;
        }
        if (!line.startsWith("lavfi.scene_score=")) continue;
        const scoreText = line.slice("lavfi.scene_score=".length).trim();
        const score = Number(scoreText);
        if (!Number.isFinite(score)) continue;
        count += 1;
        sum += score;
        if (score > max) max = score;
        if (score >= threshold && Number(ptsTime) - lastCut >= minGap) {
          candidateCount += 1;
          if (cuts.length < maxCuts) {
            cuts.push({
              frameIndex,
              ptsTime,
              score: scoreText,
              aligned: { num: String(pts * BigInt(video.timeBase.num) * 1000n), den: video.timeBase.den },
            });
            lastCut = Number(ptsTime);
          }
        }
      }
      const build = await this.run(this.tools.ffmpeg, ["-version"]);
      const doc: SceneCutDocument = {
        schemaVersion: "video.scene-cuts/v1",
        reportId: jobId,
        assetId: asset.assetId,
        sourceSha256: asset.original.sha256,
        indexSha256: asset.presentationIndex.sha256,
        ffmpegBuildHash: createHash("sha256").update(build.stdout).digest("hex"),
        streamUid: video.streamUid,
        rate: video.averageRate ?? null,
        threshold: String(threshold),
        minGapSeconds: String(minGap),
        frameCount: count,
        truncated: candidateCount > cuts.length,
        cuts,
        stats: {
          maxScore: max.toFixed(6),
          meanScore: count ? (sum / count).toFixed(6) : "0.000000",
        },
      };
      return { blob: await cas.writeJson(doc), doc };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async waveformReport(
    asset: SourceAsset,
    jobId: string,
    cas: ContentAddressedStore,
    signal: AbortSignal,
  ): Promise<{ blob: BlobRef; doc: WaveformDocument } | null> {
    const audio = asset.streams.find((s) => s.kind === "audio");
    if (!audio) return null;
    const rate = 8000;
    const bucketMs = 100;
    const maxSeconds = 120;
    const pcm = await this.runBuffer(
      this.tools.ffmpeg,
      [
        "-nostdin",
        "-v",
        "error",
        "-xerror",
        "-i",
        cas.pathFor(asset.original),
        "-map",
        "0:a:0",
        "-t",
        String(maxSeconds),
        "-ac",
        "1",
        "-ar",
        String(rate),
        "-f",
        "s16le",
        "-",
      ],
      signal,
      maxSeconds * rate * 2 + 4096,
    );
    this.throwIfCancelled(signal);
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
    const per = (rate * bucketMs) / 1000;
    const buckets: string[] = [];
    for (let off = 0; off + per <= samples.length; off += per) {
      let sum = 0;
      for (let i = off; i < off + per; i++) {
        const v = samples[i]! / 32768;
        sum += v * v;
      }
      buckets.push(Math.sqrt(sum / per).toFixed(4));
    }
    const doc: WaveformDocument = {
      schemaVersion: "video.waveform/v1",
      reportId: jobId,
      assetId: asset.assetId,
      sourceSha256: asset.original.sha256,
      indexSha256: asset.presentationIndex.sha256,
      streamUid: audio.streamUid,
      sampleRate: rate,
      bucketMs,
      durationAnalyzedMs: String(buckets.length * bucketMs),
      truncated: samples.length >= maxSeconds * rate,
      buckets,
    };
    return { blob: await cas.writeJson(doc), doc };
  }

  private runBuffer(
    command: string,
    args: string[],
    signal: AbortSignal,
    maxBytes: number,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new EditorError("CANCELLED", "Analysis interrupted"));
        return;
      }
      const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      let total = 0;
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error("ffmpeg timed out"));
      }, 120_000);
      const onAbort = () => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new EditorError("CANCELLED", "Analysis interrupted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > maxBytes) {
          settled = true;
          child.kill("SIGKILL");
          reject(new EditorError("INVALID_ARGUMENT", "Decoded audio exceeds the analysis budget"));
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (code === 0) resolve(Buffer.concat(chunks));
        else {
          reject(
            new EditorError("WORKER_FAILED", stderr.trim().slice(0, 500) || `ffmpeg exited ${code}`),
          );
        }
      });
    });
  }

  private async run(
    command: string,
    args: string[],
    options: { maxBuffer?: number } = {},
  ): Promise<{ stdout: string; stderr: string }> {
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

  private spawnChecked(
    command: string,
    args: string[],
    signal: AbortSignal,
    cwd?: string,
  ): Promise<void> {
    this.throwIfCancelled(signal);
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
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
        if (signal.aborted) {
          reject(new EditorError("CANCELLED", "The media job was cancelled"));
          return;
        }
        if (code !== 0) {
          reject(new EditorError("QA_FAILED", `FFmpeg rejected the edit (exit ${code})`));
          return;
        }
        resolve();
      });
    });
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) editorFailure("CANCELLED", "The media job was cancelled");
  }
}

function assertCandidateAudio(
  source: ReadonlyArray<Pick<StreamDescriptor, "kind" | "channels">>,
  output: ReadonlyArray<
    Pick<
      ProbeDocument["streams"][number],
      "codec_type" | "codec_name" | "sample_rate" | "channels"
    >
  >,
): void {
  const expected = source.filter((stream) => stream.kind === "audio");
  const actual = output.filter((stream) => stream.codec_type === "audio");
  if (
    actual.length !== expected.length ||
    actual.some((stream, index) => {
      const channels = expected[index]?.channels;
      return (
        stream.codec_name !== "aac" ||
        stream.sample_rate !== "48000" ||
        !stream.channels ||
        (channels !== undefined && stream.channels !== channels)
      );
    })
  ) {
    editorFailure("QA_FAILED", "Candidate audio tracks differ from the approved render profile");
  }
}

type TransformOp = AcceptedEditPlan["transformOperations"][number];

function segmentGeometry(
  video: { width?: number; height?: number },
  tr: TransformOp | undefined,
): { width: number; height: number } {
  let w = video.width ?? 0;
  let h = video.height ?? 0;
  if (tr) {
    const cw = Number(tr.crop.width);
    const ch = Number(tr.crop.height);
    if (cw > 0 || ch > 0) {
      w = cw;
      h = ch;
    }
    const sw = Number(tr.scale.width);
    const sh = Number(tr.scale.height);
    if (sw > 0 || sh > 0) {
      w = sw;
      h = sh;
    }
    if (tr.rotationDegrees === "90" || tr.rotationDegrees === "270") {
      const t = w;
      w = h;
      h = t;
    }
  }
  return { width: w, height: h };
}

function transformFilterChain(
  video: { width?: number; height?: number },
  tr: TransformOp | undefined,
): string {
  if (!tr) return "";
  let chain = "";
  const cw = Number(tr.crop.width);
  const ch = Number(tr.crop.height);
  if (cw > 0 || ch > 0) {
    if (
      video.width &&
      video.height &&
      (Number(tr.crop.x) + cw > video.width || Number(tr.crop.y) + ch > video.height)
    ) {
      editorFailure("CAPABILITY_UNAVAILABLE", "Crop exceeds the source frame");
    }
    chain += `,crop=${cw}:${ch}:${tr.crop.x}:${tr.crop.y}`;
  }
  const sw = Number(tr.scale.width);
  const sh = Number(tr.scale.height);
  if (sw > 0 || sh > 0) chain += `,scale=${sw}:${sh}`;
  if (tr.rotationDegrees === "90") chain += ",transpose=1";
  else if (tr.rotationDegrees === "180") chain += ",hflip,vflip";
  else if (tr.rotationDegrees === "270") chain += ",transpose=2";
  return chain;
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
  const candidateTransforms = new Map(plan.transformOperations.map((t) => [t.clipId, t]));
  const v1First = plan.trimOperations.find((op) => op.trackId === "v1") ?? plan.trimOperations[0]!;
  const outGeo = segmentGeometry(source ?? {}, candidateTransforms.get(v1First.clipId));
  const width = kind === "final" ? outGeo.width || source?.width : 640;
  const height = kind === "final" ? outGeo.height || source?.height : 360;
  const metaSubs = plan.subtitleOperations.some((op) => op.mode === "metadata") ? 1 : 0;
  const expectedStreams = 1 + (audioProfile ? 1 : 0) + metaSubs;
  if (
    !video ||
    video.codec_name !== "h264" ||
    video.width !== width ||
    video.height !== height ||
    doc.streams.length !== expectedStreams
  ) {
    editorFailure("QA_FAILED", "Unexpected candidate streams or dimensions");
  }
  if (metaSubs && !doc.streams.some((s) => s.codec_type === "subtitle" && s.codec_name === "mov_text")) {
    editorFailure("QA_FAILED", "Missing mov_text sidecar subtitle stream");
  }
  assertCandidateAudio(audioProfile ? [audioProfile] : [], doc.streams);
  let total = { num: 0n, den: 1n };
  const trackByClip = new Map(plan.trimOperations.map((op) => [op.clipId, op.trackId]));
  for (const op of plan.trimOperations) {
    if (op.trackId !== "v1") continue;
    total = {
      num: total.num * BigInt(op.recordRange.duration.den) + BigInt(op.recordRange.duration.num) * total.den,
      den: total.den * BigInt(op.recordRange.duration.den),
    };
  }
  for (const tr of plan.transitionOperations) {
    if (trackByClip.get(tr.leftClipId) !== "v1") continue;
    total = {
      num: total.num * BigInt(tr.duration.den) - BigInt(tr.duration.num) * total.den,
      den: total.den * BigInt(tr.duration.den),
    };
  }
  const dur: Rational = { num: total.num.toString(), den: total.den.toString() };
  for (const s of doc.streams) {
    if (s.codec_type === "subtitle") continue;
    if (!s.time_base || !Number.isSafeInteger(s.duration_ts) || s.start_pts !== 0) {
      editorFailure("QA_FAILED", "Missing or invalid candidate timeline");
    }
    const base = parseRational(s.time_base);
    const error =
      BigInt(s.duration_ts!) * BigInt(base.num) * BigInt(dur.den) -
      BigInt(dur.num) * BigInt(base.den);
    if (error !== 0n) {
      editorFailure("QA_FAILED", "Candidate stream duration differs from the approved trim");
    }
  }
}

function parsePresentationFrames(json: string): unknown[] {
  const document: unknown = JSON.parse(
    json,
    (key: string, value: unknown, context?: { source?: string }) => {
      if (!FRAME_TICK_FIELDS.has(key)) return value;
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
  // Older ffprobe builds expose the same exact ticks as best_effort_timestamp
  // and pkt_duration. Normalize once at the trust boundary so every consumer,
  // including the Python sampling kernel, sees decimal string pts/duration.
  return (document.frames as Array<Record<string, unknown>>).map((frame) => {
    const pts = frame.pts ?? frame.best_effort_timestamp;
    const duration = frame.duration ?? frame.pkt_duration;
    return {
      ...frame,
      ...(typeof pts === "string" ? { pts } : {}),
      ...(typeof duration === "string" ? { duration } : {}),
    };
  });
}

function parseRational(value: string): Rational {
  const [num, den] = value.split("/");
  return { num: num ?? "0", den: den ?? "1" };
}

function rationalSecondsPrecise(value: Rational): string {
  const numerator = BigInt(value.num);
  const denominator = BigInt(value.den);
  if (denominator === 0n) {
    editorFailure("PLAN_SEMANTIC_INVALID", "A rational time has a zero denominator");
  }
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
