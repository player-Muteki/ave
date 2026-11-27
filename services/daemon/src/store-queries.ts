import type { ContentAddressedStore } from "@ave/cas";
import {
  BlobRefSchema,
  editorFailure,
  type ArtifactRef,
  type BlobRef,
  type EditorPrincipal,
} from "@ave/contracts";
import { sha256Json } from "@ave/domain";
import type { AveStore } from "@ave/sqlite";

export class DaemonQueries {
  constructor(
    private readonly store: AveStore,
    private readonly cas: ContentAddressedStore,
  ) {}

  async qaSummary(projectId: string, jobId: string, principal: EditorPrincipal) {
    this.store.devices.authorizeProject(projectId, principal, "viewer");
    const job = this.store.jobs.getJob(projectId, jobId, principal);
    const qa = job.artifacts.find((a) => a.kind === "qa");
    if (!qa) editorFailure("ASSET_NOT_FOUND", "The job has no QA artifact yet");
    const doc = await this.cas.readJson<{
      subjectHash?: string;
      planHash?: string;
      ffmpegBuildHash?: string;
      renderRecipeHash?: string;
      audioLoudness?: { meanVolumeDb: string; maxVolumeDb: string } | null;
      gates?: Array<{
        gate: string;
        status: string;
        checks?: Array<{ name: string; status: string }>;
      }>;
      probe?: {
        format?: { duration?: string };
        streams?: Array<Record<string, unknown>>;
      };
    }>(qa.blob);
    return {
      jobId,
      kind: job.kind,
      state: job.state,
      revision: job.revision,
      qaArtifactId: qa.artifactId,
      qaSha256: qa.blob.sha256,
      subjectHash: doc.subjectHash ?? null,
      planHash: doc.planHash ?? null,
      ffmpegBuildHash: doc.ffmpegBuildHash ?? null,
      renderRecipeHash: doc.renderRecipeHash ?? null,
      audioLoudness: doc.audioLoudness ?? null,
      durationSeconds: doc.probe?.format?.duration ?? null,
      streams: (doc.probe?.streams ?? []).slice(0, 8).map((s) => ({
        codecType: s.codec_type as string | undefined,
        codecName: s.codec_name as string | undefined,
        width: s.width as number | undefined,
        height: s.height as number | undefined,
        sampleRate: s.sample_rate as string | number | undefined,
        channels: s.channels as number | undefined,
      })),
      gates: (doc.gates ?? []).map((g) => ({
        gate: g.gate,
        status: g.status,
        checks: (g.checks ?? []).map((c) => ({ name: c.name, status: c.status })),
      })),
    };
  }

  async exportSummary(projectId: string, jobId: string, principal: EditorPrincipal) {
    this.store.devices.authorizeProject(projectId, principal, "viewer");
    const job = this.store.jobs.getJob(projectId, jobId, principal);
    if (job.kind !== "export") editorFailure("INVALID_ARGUMENT", "The job is not an export");
    const manifest = job.artifacts.find((a) => a.kind === "manifest");
    if (!manifest) editorFailure("ASSET_NOT_FOUND", "The export job has no manifest artifact yet");
    const doc = await this.cas.readJson<{
      exportId?: string;
      output?: BlobRef;
      sourceManifestHash?: string;
      planHash?: string;
      ffmpegBuildHash?: string;
      renderRecipeHash?: string | null;
      approvalId?: string;
      segments?: unknown[];
      transitions?: unknown[];
      transforms?: unknown[];
      subtitleCues?: unknown[];
      audioOperations?: unknown[];
      qaReport?: { audioLoudness?: { meanVolumeDb: string; maxVolumeDb: string } | null };
    }>(manifest.blob);
    return {
      jobId,
      state: job.state,
      revision: job.revision,
      manifestArtifactId: manifest.artifactId,
      manifestSha256: manifest.blob.sha256,
      exportId: doc.exportId ?? null,
      output: doc.output ?? null,
      sourceManifestHash: doc.sourceManifestHash ?? null,
      planHash: doc.planHash ?? null,
      ffmpegBuildHash: doc.ffmpegBuildHash ?? null,
      renderRecipeHash: doc.renderRecipeHash ?? null,
      approvalId: doc.approvalId ?? null,
      segmentCount: doc.segments?.length ?? 0,
      transitionCount: doc.transitions?.length ?? 0,
      transformCount: doc.transforms?.length ?? 0,
      subtitleCueCount: doc.subtitleCues?.length ?? 0,
      audioOperationCount: doc.audioOperations?.length ?? 0,
      audioLoudness: doc.qaReport?.audioLoudness ?? null,
    };
  }

  async sceneCuts(projectId: string, assetId: string, principal: EditorPrincipal) {
    this.store.devices.authorizeProject(projectId, principal, "viewer");
    const project = this.store.projects.getProjectSnapshot(projectId, principal);
    const asset = project.assets.find((a) => a.assetId === assetId);
    if (!asset) editorFailure("ASSET_NOT_FOUND", "The asset is not in this project");
    const jobs = project.jobs
      .filter((j) => j.analysisAssetId === assetId)
      .sort((a, b) => (a.jobId < b.jobId ? 1 : -1));
    const latest = jobs.find((j) => j.artifacts.some((a) => a.kind === "scenecuts")) ?? jobs[0];
    if (!latest) editorFailure("ASSET_NOT_FOUND", "No analysis job exists for this asset");
    const artifact = latest.artifacts.find((a) => a.kind === "scenecuts");
    if (!artifact) editorFailure("ASSET_NOT_FOUND", "The analysis job has no scene-cut artifact yet");
    const doc = await this.cas.readJson<{
      schemaVersion?: string;
      threshold?: string;
      minGapSeconds?: string;
      rate?: { num: string; den: string } | null;
      frameCount?: number;
      truncated?: boolean;
      cuts?: Array<{
        frameIndex: number;
        ptsTime: string;
        score: string;
        aligned: { num: string; den: string };
      }>;
    }>(artifact.blob);
    if (doc.schemaVersion !== "video.scene-cuts/v1") {
      editorFailure("ARTIFACT_HASH_MISMATCH", "Unexpected scene-cut schema version");
    }
    return {
      assetId,
      contentHash: asset.original.sha256,
      jobId: latest.jobId,
      state: latest.state,
      revision: latest.revision,
      scenecutsArtifactId: artifact.artifactId,
      scenecutsSha256: artifact.blob.sha256,
      threshold: doc.threshold ?? null,
      minGapSeconds: doc.minGapSeconds ?? null,
      rate: doc.rate ?? null,
      frameCount: doc.frameCount ?? null,
      truncated: doc.truncated ?? false,
      cutCount: doc.cuts?.length ?? 0,
      cuts: (doc.cuts ?? []).slice(0, 64),
      note: "Frame-aligned cut suggestions from the deterministic FFmpeg scene-score pass; never pixels.",
    };
  }

  async waveform(projectId: string, assetId: string, principal: EditorPrincipal) {
    this.store.devices.authorizeProject(projectId, principal, "viewer");
    const project = this.store.projects.getProjectSnapshot(projectId, principal);
    const asset = project.assets.find((a) => a.assetId === assetId);
    if (!asset) editorFailure("ASSET_NOT_FOUND", "The asset is not in this project");
    const jobs = project.jobs
      .filter((j) => j.analysisAssetId === assetId)
      .sort((a, b) => (a.jobId < b.jobId ? 1 : -1));
    const latest = jobs.find((j) => j.artifacts.some((a) => a.kind === "waveform")) ?? jobs[0];
    if (!latest) editorFailure("ASSET_NOT_FOUND", "No analysis job exists for this asset");
    const artifact = latest.artifacts.find((a) => a.kind === "waveform");
    if (!artifact) editorFailure("ASSET_NOT_FOUND", "The analysis job has no waveform artifact yet");
    const doc = await this.cas.readJson<{
      schemaVersion?: string;
      streamUid?: string;
      sampleRate?: number;
      bucketMs?: number;
      durationAnalyzedMs?: string;
      truncated?: boolean;
      buckets?: string[];
    }>(artifact.blob);
    if (doc.schemaVersion !== "video.waveform/v1") {
      editorFailure("ARTIFACT_HASH_MISMATCH", "Unexpected waveform schema version");
    }
    const buckets = doc.buckets ?? [];
    return {
      assetId,
      contentHash: asset.original.sha256,
      jobId: latest.jobId,
      state: latest.state,
      revision: latest.revision,
      waveformArtifactId: artifact.artifactId,
      waveformSha256: artifact.blob.sha256,
      streamUid: doc.streamUid ?? null,
      sampleRate: doc.sampleRate ?? null,
      bucketMs: doc.bucketMs ?? null,
      durationAnalyzedMs: doc.durationAnalyzedMs ?? null,
      truncated: doc.truncated ?? false,
      bucketCount: buckets.length,
      buckets: buckets.slice(0, 1200),
      note: "RMS level per bucket normalized to 0..1; use silent buckets (near 0) as dialogue-free cut candidates.",
    };
  }

  registerPreviewSheet(
    projectId: string,
    jobId: string,
    revision: string,
    blob: BlobRef,
    principal: EditorPrincipal,
  ): string {
    this.store.jobs.reviewablePreview(projectId, jobId, principal, revision);
    const id = `contact:preview:${sha256Json([jobId, revision, blob.sha256])}`;
    this.store.coordinator.db
      .prepare("INSERT OR IGNORE INTO preview_sheets VALUES (?, ?, ?, ?, ?)")
      .run(id, projectId, jobId, revision, JSON.stringify(blob));
    return id;
  }

  resolveChunkBlob(
    projectId: string,
    assetId: string,
    revision: string,
    principal: EditorPrincipal,
  ): BlobRef {
    this.store.devices.authorizeProject(projectId, principal, "viewer");
    if (assetId.startsWith("contact:preview:")) {
      const row = this.store.coordinator.db
        .prepare(
          "SELECT job_id, blob FROM preview_sheets WHERE project_id = ? AND revision = ? AND artifact_id = ?",
        )
        .get(projectId, revision, assetId) as { job_id: string; blob: string } | undefined;
      if (!row) editorFailure("ASSET_NOT_FOUND", "No preview sheet for this project and revision");
      this.store.jobs.reviewablePreview(projectId, row.job_id, principal, revision);
      return BlobRefSchema.parse(JSON.parse(row.blob));
    }
    if (assetId.startsWith("contact:")) {
      if (this.store.devices.requireProjectRow(projectId).revision !== revision) {
        editorFailure("REVISION_CONFLICT", "Download a fresh project snapshot");
      }
      const [doc] = this.store.coordinator.rows(
        "SELECT blob FROM contact_sheets WHERE project_id = ? AND revision = ? AND artifact_id = ?",
        projectId,
        revision,
        assetId,
      );
      if (!doc) editorFailure("ASSET_NOT_FOUND", "No such contact sheet in this project revision");
      return BlobRefSchema.parse(JSON.parse(doc));
    }
    if (assetId.endsWith(":candidate")) {
      return this.store.jobs.reviewablePreview(
        projectId,
        assetId.slice(0, -":candidate".length),
        principal,
        revision,
      ).blob;
    }
    if (assetId.endsWith(":review-proxy")) {
      this.store.devices.authorizeProject(projectId, principal, "operator");
      const jobId = assetId.slice(0, -":review-proxy".length);
      const job = this.store.jobs.getJob(projectId, jobId, principal);
      if (job.kind !== "final" || job.state !== "awaiting_delivery_approval") {
        editorFailure(
          "PERMISSION_DENIED",
          "Only a final candidate awaiting delivery approval can be reviewed",
        );
      }
      if (job.candidateRevision !== revision) {
        editorFailure("REVISION_CONFLICT", "Review proxy revision mismatch");
      }
      const proxy = job.artifacts.find(
        (a) =>
          a.kind === "proxy" &&
          a.jobId === job.jobId &&
          a.projectId === projectId &&
          a.revision === revision &&
          a.artifactId === assetId,
      );
      if (!proxy) editorFailure("ASSET_NOT_FOUND", "No review proxy for this candidate");
      return proxy.blob;
    }
    if (assetId.includes(":")) {
      const ref: ArtifactRef = this.store.jobs.artifact(projectId, assetId, revision, principal);
      return ref.blob;
    }
    if (assetId.endsWith(".proxy")) {
      const source = this.store.projects.getAsset(
        projectId,
        assetId.slice(0, -".proxy".length),
        revision,
        principal,
      );
      return source.proxy ?? source.original;
    }
    return this.store.projects.getAsset(projectId, assetId, revision, principal).original;
  }
}
