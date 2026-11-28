import { randomUUID } from "node:crypto";
import {
  AcceptedEditPlanSchema,
  ApprovalRequestSchema,
  BlobRefSchema,
  JobSnapshotSchema,
  ObjectEditWorkflowSchema,
  PlannerAssetMetadataSchema,
  ProjectSnapshotSchema,
  SourceAssetSchema,
  editorFailure,
  type BlobRef,
  type CancelUploadRequest,
  type CancelUploadResult,
  type EditorPrincipal,
  type ProjectSnapshot,
  type SourceAsset,
  type TimeRange,
} from "@ave/contracts";
import {
  alignCfrTrimRange,
  assertPositiveRange,
  assertRoleAtLeast,
  playbackDurationSeconds,
  presentationSpans,
  probeStartTime,
  rationalSub,
  removalTargets,
  sha256Json,
  type FrameIndex,
} from "@ave/domain";
import type { TransactionCoordinator } from "../coordinator.js";
import type { DeviceGrantRepository } from "./device-grant-repository.js";

const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

interface ProbeDocumentLike {
  format?: { start_time?: string; duration?: string };
  streams: Array<{
    index: number;
    codec_type?: string;
    time_base?: string;
    start_pts?: number;
    duration_ts?: number;
  }>;
}

export class ProjectAssetRevisionRepository {
  constructor(
    private readonly tx: TransactionCoordinator,
    private readonly grants: DeviceGrantRepository,
  ) {}

  createProject(input: {
    requestId: string;
    title: string;
    principal: EditorPrincipal;
  }): ProjectSnapshot {
    assertRoleAtLeast(input.principal, "operator");
    const projectId = `project-${sha256Json({ kind: "video-project", requestId: input.requestId, principalId: input.principal.principalId }).slice(0, 32)}`;
    return this.tx.mutate({
      projectId,
      requestId: input.requestId,
      payload: input,
      execute: () => {
        const hash = sha256Json([]);
        this.tx.db
          .prepare(
            "INSERT INTO projects(project_id, title, revision, asset_manifest_hash, created_at) VALUES (?, ?, '0', ?, ?)",
          )
          .run(projectId, input.title, hash, this.tx.now());
        this.grants.grantProjectRole(projectId, input.principal.principalId, "owner");
        this.tx.emit(projectId, "project.created", { title: input.title });
        return this.getProjectSnapshot(projectId, input.principal);
      },
    });
  }

  projectSummary(projectId: string, principal: EditorPrincipal) {
    this.grants.authorizeProject(projectId, principal, "viewer");
    const { title, revision } = this.grants.requireProjectRow(projectId);
    return { projectId, title, revision };
  }

  listProjects(
    principal: EditorPrincipal,
  ): Array<{ projectId: string; title: string; revision: string }> {
    type Row = { project_id: string; title: string; revision: string };
    const summarize = (row: Row) => ({
      projectId: row.project_id,
      title: row.title,
      revision: row.revision,
    });
    if (principal.role === "owner" && principal.projectIds === null) {
      const rows = this.tx.db
        .prepare("SELECT project_id, title, revision FROM projects ORDER BY created_at, project_id")
        .all() as Row[];
      return rows.map(summarize);
    }
    const rows = this.tx.db
      .prepare(
        "SELECT p.project_id, p.title, p.revision FROM projects p JOIN project_grants g ON g.project_id = p.project_id WHERE g.principal_id = ? ORDER BY p.created_at, p.project_id",
      )
      .all(principal.principalId) as Row[];
    return rows
      .filter((row) => principal.projectIds === null || principal.projectIds.includes(row.project_id))
      .map(summarize);
  }

  getProjectSnapshot(projectId: string, principal: EditorPrincipal): ProjectSnapshot {
    this.grants.authorizeProject(projectId, principal, "viewer");
    const row = this.grants.requireProjectRow(projectId);
    const plans = this.tx
      .rows("SELECT document FROM plans WHERE project_id = ? ORDER BY revision", projectId)
      .map((document) => AcceptedEditPlanSchema.parse(JSON.parse(document)))
      .slice(-128);
    const approvals = this.tx
      .rows(
        "SELECT request FROM approvals WHERE project_id = ? ORDER BY created_at, approval_id",
        projectId,
      )
      .map((document) => ApprovalRequestSchema.parse(JSON.parse(document)))
      .slice(-256);
    const jobs = this.tx
      .rows("SELECT document FROM jobs WHERE project_id = ? ORDER BY job_id", projectId)
      .map((document) => JobSnapshotSchema.parse(JSON.parse(document)))
      .slice(-256);
    return ProjectSnapshotSchema.parse({
      protocolVersion: "1",
      projectId,
      title: row.title,
      revision: row.revision,
      baseAssetManifestHash: row.asset_manifest_hash,
      assets: this.tx
        .rows("SELECT document FROM assets WHERE project_id = ? ORDER BY asset_id", projectId)
        .map((document) => SourceAssetSchema.parse(JSON.parse(document))),
      plans,
      approvals,
      jobs,
      objectEdits: this.tx
        .rows(
          "SELECT document FROM object_edits WHERE project_id = ? ORDER BY rowid DESC LIMIT 8",
          projectId,
        )
        .map((document) => {
          const workflow = ObjectEditWorkflowSchema.parse(JSON.parse(document));
          return {
            workflowId: workflow.workflowId,
            assetId: workflow.assetId,
            state: workflow.state,
            candidateCount: workflow.candidates.length,
            removalCount: removalTargets(workflow.candidates, workflow.decisions).length,
            workflowRevision: workflow.workflowRevision,
            createdAt: workflow.createdAt,
          };
        }),
      latestSeq: this.tx.latestSeq(projectId),
    });
  }

  private assetManifest(projectId: string): Array<{ assetId: string; sha256: string }> {
    return this.tx
      .rows("SELECT document FROM assets WHERE project_id = ?", projectId)
      .map((document) => {
        const asset = SourceAssetSchema.parse(JSON.parse(document));
        return { assetId: asset.assetId, sha256: asset.original.sha256 };
      });
  }

  addAsset(
    projectId: string,
    asset: SourceAsset,
    requestId: string,
    principal: EditorPrincipal,
  ): SourceAsset {
    this.grants.authorizeProject(projectId, principal, "operator");
    return this.tx.mutate({
      projectId,
      requestId,
      payload: asset,
      execute: () => {
        const project = this.grants.requireProjectRow(projectId);
        const manifest = this.assetManifest(projectId);
        manifest.push({ assetId: asset.assetId, sha256: asset.original.sha256 });
        manifest.sort((left, right) => left.assetId.localeCompare(right.assetId));
        const revision = (BigInt(project.revision) + 1n).toString();
        this.tx.db
          .prepare(
            "INSERT INTO assets(asset_id, project_id, revision, document) VALUES (?, ?, ?, ?)",
          )
          .run(asset.assetId, projectId, revision, JSON.stringify(asset));
        this.tx.db
          .prepare(
            "UPDATE projects SET revision = ?, asset_manifest_hash = ? WHERE project_id = ?",
          )
          .run(revision, sha256Json(manifest), projectId);
        this.tx.emit(projectId, "artifact.committed", { assetId: asset.assetId, revision });
        return asset;
      },
    });
  }

  getAsset(
    projectId: string,
    assetId: string,
    revision: string,
    principal: EditorPrincipal,
  ): SourceAsset {
    this.grants.authorizeProject(projectId, principal, "viewer");
    const row = this.tx.db
      .prepare("SELECT document FROM assets WHERE project_id = ? AND asset_id = ?")
      .get(projectId, assetId) as { document: string } | undefined;
    if (!row) editorFailure("ASSET_NOT_FOUND", "The asset does not exist in this project");
    const asset = SourceAssetSchema.parse(JSON.parse(row.document));
    if (this.grants.requireProjectRow(projectId).revision !== revision) {
      editorFailure(
        "REVISION_CONFLICT",
        "The asset revision has changed; download a fresh snapshot",
      );
    }
    return asset;
  }

  listAssetsMap(projectId: string): Map<string, SourceAsset> {
    return new Map(
      this.tx
        .rows("SELECT document FROM assets WHERE project_id = ?", projectId)
        .map((document) => {
          const asset = SourceAssetSchema.parse(JSON.parse(document));
          return [asset.assetId, asset] as const;
        }),
    );
  }

  private async readAssetMetadata(
    projectId: string,
    assetId: string,
    principal: EditorPrincipal,
    contentHash?: string,
  ) {
    this.grants.authorizeProject(projectId, principal, "viewer");
    const row = this.tx.db
      .prepare("SELECT document FROM assets WHERE project_id = ? AND asset_id = ?")
      .get(projectId, assetId) as { document: string } | undefined;
    const asset = row && SourceAssetSchema.parse(JSON.parse(row.document));
    if (!asset || (contentHash !== undefined && asset.original.sha256 !== contentHash)) {
      editorFailure("ASSET_NOT_FOUND", "Asset identity is not in the bound project");
    }
    const cas = this.tx.requireCas();
    const probe: ProbeDocumentLike = JSON.parse((await cas.readBytes(asset.probe)).toString("utf8"));
    const index = JSON.parse(
      (await cas.readBytes(asset.presentationIndex)).toString("utf8"),
    ) as FrameIndex;
    const primaryVideo = asset.streams.find((stream) => stream.kind === "video");
    if (primaryVideo && !Array.isArray(index.frames)) {
      editorFailure("SCHEMA_UNSUPPORTED", "Missing presentation index frames");
    }
    const frameCount = primaryVideo
      ? index.frames.reduce((n, f) => n + Number(f.stream_index === primaryVideo.streamIndex), 0)
      : null;
    const byIndex = new Map(probe.streams.map((stream) => [stream.index, stream]));
    const withoutDuration = asset.streams.filter(
      ({ streamIndex, kind }) =>
        (kind === "audio" || kind === "video") && byIndex.get(streamIndex)?.duration_ts === undefined,
    );
    const spans = presentationSpans(index, asset, withoutDuration);
    const streams = asset.streams.map(
      ({ streamIndex, streamUid, kind, codec, timeBase, averageRate, width, height, sampleRate }) => {
        const stream = byIndex.get(streamIndex);
        const sameClock =
          stream?.codec_type === kind && stream.time_base === `${timeBase.num}/${timeBase.den}`;
        const start = sameClock ? stream.start_pts : undefined;
        const duration = sameClock ? stream.duration_ts : undefined;
        const span = sameClock ? spans.get(streamIndex) : undefined;
        const measured =
          span && (start === undefined || (Number.isSafeInteger(start) && BigInt(start) === span.first))
            ? span
            : undefined;
        return {
          streamUid,
          kind,
          codec,
          timeBase,
          averageRate,
          width,
          height,
          sampleRate,
          startPts: Number.isSafeInteger(start) ? String(start) : measured?.first.toString(),
          durationTicks:
            duration !== undefined && duration >= 0 && Number.isSafeInteger(duration)
              ? String(duration)
              : measured && (measured.end - measured.first).toString(),
        };
      },
    );
    const inputStartTime = probeStartTime(probe.format?.start_time);
    const durationSeconds = playbackDurationSeconds(
      probe.format?.duration,
      inputStartTime,
      streams,
    );
    return { asset, frameCount, durationSeconds, inputStartTime, streams, index };
  }

  async assetMetadata(projectId: string, assetId: string, principal: EditorPrincipal, requestedTrimRange?: TimeRange) {
    const { asset, durationSeconds, frameCount, inputStartTime, index } = await this.readAssetMetadata(
      projectId,
      assetId,
      principal,
    );
    let resolvedTrimRange = requestedTrimRange;
    if (requestedTrimRange) {
      assertPositiveRange(requestedTrimRange, "INVALID_ARGUMENT");
      const video = asset.streams.find(stream => stream.kind === "video");
      if (!video) editorFailure("INVALID_ARGUMENT", "所选素材不包含视频流。");
      if (video.averageRate && frameCount && this.hasConstantRate(asset.presentationIndex.sha256, video.streamUid)) {
        const pts = index.frames.find(frame => frame.stream_index === video.streamIndex)?.pts;
        const firstFrameTime = pts !== undefined && inputStartTime
          ? rationalSub({ num: (BigInt(pts) * BigInt(video.timeBase.num)).toString(), den: video.timeBase.den }, inputStartTime)
          : undefined;
        resolvedTrimRange = alignCfrTrimRange(requestedTrimRange, video.averageRate, frameCount, firstFrameTime);
      }
    }
    return {
      assetId,
      contentHash: asset.original.sha256,
      durationSeconds,
      frameCount,
      streams: asset.streams,
      ...(resolvedTrimRange && { resolvedTrimRange }),
    };
  }

  async plannerAssetMetadata(
    projectId: string,
    assetId: string,
    contentHash: string,
    principal: EditorPrincipal,
  ) {
    const { frameCount, durationSeconds, inputStartTime, streams } = await this.readAssetMetadata(
      projectId,
      assetId,
      principal,
      contentHash,
    );
    return PlannerAssetMetadataSchema.parse({
      assetId,
      contentHash,
      frameCount,
      durationSeconds,
      inputStartTime,
      streams,
    });
  }

  recordConstantRateStream(indexSha: string, streamUid: string): void {
    this.tx.db
      .prepare("INSERT OR IGNORE INTO constant_rate_streams VALUES (?, ?)")
      .run(indexSha, streamUid);
  }

  hasConstantRate(indexSha: string, streamUid: string): boolean {
    return Boolean(
      this.tx.db
        .prepare("SELECT 1 FROM constant_rate_streams WHERE index_sha = ? AND stream_uid = ?")
        .get(indexSha, streamUid),
    );
  }

  registerContactSheet(
    projectId: string,
    revision: string,
    assetId: string,
    blob: BlobRef,
    principal: EditorPrincipal,
  ): string {
    this.grants.authorizeProject(projectId, principal, "operator");
    this.getAsset(projectId, assetId, revision, principal);
    const id = `contact:${sha256Json([assetId, blob.sha256])}`;
    this.tx.db
      .prepare(
        "INSERT OR IGNORE INTO contact_sheets(project_id, revision, artifact_id, blob) VALUES (?, ?, ?, ?)",
      )
      .run(projectId, revision, id, JSON.stringify(blob));
    return id;
  }

  createUpload(input: {
    projectId: string;
    displayName: string;
    expectedSize: string;
    expectedSha256: string;
    mediaType: string;
    principal: EditorPrincipal;
    requestId: string;
  }) {
    const {
      projectId,
      requestId,
      principal,
      expectedSize,
      expectedSha256,
      displayName,
      mediaType,
    } = input;
    this.grants.authorizeProject(projectId, principal, "operator");
    const size = Number(expectedSize);
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_UPLOAD_BYTES) {
      editorFailure(
        "INVALID_ARGUMENT",
        `Upload size must be a positive integer not exceeding ${MAX_UPLOAD_BYTES} bytes`,
      );
    }
    return this.tx.mutate({
      projectId,
      requestId,
      payload: [
        "create_upload",
        principal.principalId,
        expectedSize,
        expectedSha256,
        displayName,
        mediaType,
      ],
      execute: () => {
        const uploadId = randomUUID();
        this.tx.db
          .prepare(
            "INSERT INTO uploads(upload_id, project_id, expected_size, expected_sha256, display_name, media_type, next_offset, created_at) VALUES (?, ?, ?, ?, ?, ?, '0', ?)",
          )
          .run(
            uploadId,
            projectId,
            expectedSize,
            expectedSha256,
            displayName,
            mediaType,
            this.tx.now(),
          );
        return { uploadId, chunkSize: "262144", nextOffset: "0" };
      },
    });
  }

  upload(uploadId: string) {
    const row = this.tx.db
      .prepare(
        "SELECT project_id, expected_size, expected_sha256, display_name, media_type, next_offset FROM uploads WHERE upload_id = ?",
      )
      .get(uploadId) as
      | {
          project_id: string;
          expected_size: string;
          expected_sha256: string;
          display_name: string;
          media_type: string;
          next_offset: string;
        }
      | undefined;
    if (!row) editorFailure("ASSET_NOT_FOUND", "The upload does not exist");
    return {
      projectId: row.project_id,
      expectedSize: row.expected_size,
      expectedSha256: row.expected_sha256,
      displayName: row.display_name,
      mediaType: row.media_type,
      nextOffset: row.next_offset,
    };
  }

  getUploadStatus(
    projectId: string,
    uploadId: string,
    principal: EditorPrincipal,
  ): { uploadId: string; chunkSize: string; nextOffset: string } {
    const upload = this.upload(uploadId);
    this.grants.authorizeProject(projectId, principal, "operator");
    if (upload.projectId !== projectId) {
      editorFailure("PERMISSION_DENIED", "The upload belongs to another project");
    }
    return { uploadId, chunkSize: "262144", nextOffset: upload.nextOffset };
  }

  confirmedChunkHash(uploadId: string, offset: string): string | undefined {
    const row = this.tx.db
      .prepare("SELECT chunk_sha256 FROM upload_chunks WHERE upload_id = ? AND offset = ?")
      .get(uploadId, offset) as { chunk_sha256: string } | undefined;
    return row?.chunk_sha256;
  }

  confirmChunk(input: {
    uploadId: string;
    offset: string;
    nextOffset: string;
    digest: string;
  }): void {
    this.tx.runInTransaction(() => {
      const upload = this.upload(input.uploadId);
      if (upload.nextOffset !== input.offset) {
        editorFailure("IDEMPOTENCY_CONFLICT", "The confirmed offset changed");
      }
      this.tx.db
        .prepare("INSERT INTO upload_chunks(upload_id, offset, chunk_sha256) VALUES (?, ?, ?)")
        .run(input.uploadId, input.offset, input.digest);
      this.tx.db
        .prepare("UPDATE uploads SET next_offset = ? WHERE upload_id = ?")
        .run(input.nextOffset, input.uploadId);
    });
  }

  committedUpload(
    uploadId: string,
    requestId: string,
    sha256: string,
    principal: EditorPrincipal,
  ): { projectId: string; asset: SourceAsset } | undefined {
    const receipt = this.tx.db
      .prepare(
        `SELECT r.project_id, r.request_id, r.principal_id, r.sha256, m.response
         FROM upload_receipts r JOIN mutations m USING(project_id, request_id) WHERE r.upload_id = ?`,
      )
      .get(uploadId) as
      | {
          project_id: string;
          request_id: string;
          principal_id: string;
          sha256: string;
          response: string;
        }
      | undefined;
    if (!receipt) return undefined;
    this.grants.authorizeProject(receipt.project_id, principal, "operator");
    if (receipt.principal_id !== principal.principalId) {
      editorFailure("PERMISSION_DENIED", "This upload receipt belongs to another principal");
    }
    if (receipt.request_id !== requestId || receipt.sha256 !== sha256) {
      editorFailure("IDEMPOTENCY_CONFLICT", "The upload was committed with a different request");
    }
    return {
      projectId: receipt.project_id,
      asset: SourceAssetSchema.parse(JSON.parse(receipt.response)),
    };
  }

  cancelUpload(input: CancelUploadRequest, principal: EditorPrincipal): CancelUploadResult {
    this.grants.authorizeProject(input.projectId, principal, "operator");
    return this.tx.mutate({
      projectId: input.projectId,
      requestId: input.requestId,
      payload: { uploadId: input.uploadId },
      execute: () => {
        const row = this.tx.db
          .prepare("SELECT project_id FROM uploads WHERE upload_id = ?")
          .get(input.uploadId) as { project_id: string } | undefined;
        if (!row) {
          const receipt = this.tx.db
            .prepare("SELECT project_id FROM upload_receipts WHERE upload_id = ?")
            .get(input.uploadId) as { project_id: string } | undefined;
          if (receipt) editorFailure("INVALID_ARGUMENT", "The upload was already committed");
          editorFailure("ASSET_NOT_FOUND", "No such pending upload in this project");
        }
        if (row.project_id !== input.projectId) {
          editorFailure("PERMISSION_DENIED", "The upload belongs to another project");
        }
        this.tx.db.prepare("DELETE FROM upload_chunks WHERE upload_id = ?").run(input.uploadId);
        this.tx.db.prepare("DELETE FROM uploads WHERE upload_id = ?").run(input.uploadId);
        this.tx.emit(input.projectId, "upload.cancelled", { uploadId: input.uploadId });
        return {
          requestId: input.requestId,
          projectId: input.projectId,
          uploadId: input.uploadId,
          cancelled: true,
        };
      },
    });
  }

  finishUpload(
    uploadId: string,
    asset: SourceAsset,
    requestId: string,
    principal: EditorPrincipal,
  ): SourceAsset {
    return this.tx.runInTransaction(() => {
      const upload = this.upload(uploadId);
      const result = this.addAsset(upload.projectId, asset, requestId, principal);
      this.tx.db
        .prepare(
          "INSERT INTO upload_receipts(upload_id, project_id, request_id, principal_id, sha256) VALUES (?, ?, ?, ?, ?)",
        )
        .run(uploadId, upload.projectId, requestId, principal.principalId, result.original.sha256);
      this.tx.db.prepare("DELETE FROM upload_chunks WHERE upload_id = ?").run(uploadId);
      this.tx.db.prepare("DELETE FROM uploads WHERE upload_id = ?").run(uploadId);
      return result;
    });
  }

  cloudModelsAllowed(projectId: string): boolean {
    const row = this.tx.db
      .prepare("SELECT document FROM project_settings WHERE project_id = ?")
      .get(projectId) as { document: string } | undefined;
    if (!row) return false;
    return (JSON.parse(row.document) as { allowCloudModels?: boolean }).allowCloudModels === true;
  }

  setProjectCloudPolicy(
    input: { requestId: string; projectId: string; allowCloudModels: boolean },
    principal: EditorPrincipal,
  ) {
    return this.tx.mutate({
      projectId: input.projectId,
      requestId: input.requestId,
      payload: input,
      execute: (projectId) => {
        this.grants.authorizeProject(projectId, principal, "owner");
        this.tx.db
          .prepare(
            "INSERT INTO project_settings(project_id, document) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET document = excluded.document",
          )
          .run(projectId, JSON.stringify({ allowCloudModels: input.allowCloudModels }));
        this.tx.emit(projectId, "project.cloud_policy", {
          allowCloudModels: input.allowCloudModels,
        });
        return { allowCloudModels: input.allowCloudModels };
      },
    });
  }
}
