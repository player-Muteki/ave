import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { SqliteDatabase } from "./sqlite-types.js";
import { DatabaseSync } from "./sqlite.js";
import { assertRenderablePreview, summarizeDraftTimeline } from "./preview-profile.js";
import { sha256Json, type ContentAddressedStore } from "./cas.js";
import {
  BlobRefSchema,
  type BlobRef,
  AcceptedEditPlanSchema,
  ApprovalGrantSchema,
  ApprovalRequestSchema,
  EditorEventSchema,
  PlanningRunStatusSchema,
  type PlanningRunStatus,
  JobSnapshotSchema,
  ProjectSnapshotSchema,
  SourceAssetSchema,
  type ArtifactRef,
  type AcceptedEditPlan,
  type ApprovalDecision,
  type CreateMaskRevisionRequest, type RequestTrackedMaskReview,
  TrackMaskRequestSchema, type TrackMaskRequest,
  type InspectFrameHeader,
  MaskAnchorRevisionSchema, type MaskAnchorRevision,
  type ApprovalGrant,
  type ApprovalRequest,
  type EditPlanDraftV1,
  type EditorPrincipal,
  type EditorRole,
  type JobSnapshot,
  type ProjectSnapshot,
  type SourceAsset,
} from "#video-editor/contracts/v1";
import { describeEditorError, EditorError, editorFailure } from "./errors.js";

interface ProjectRow {
  project_id: string;
  title: string;
  revision: string;
  asset_manifest_hash: string;
}

interface StoredApproval {
  request: ApprovalRequest;
  grant?: ApprovalGrant;
}

export interface CreatePlanInput {
  requestId: string;
  runId: string;
  toolCallId: string;
  draft: EditPlanDraftV1;
  principal: EditorPrincipal;
}

export interface CreateJobInput {
  requestId: string;
  projectId: string;
  approvalId: string;
  grantId: string;
  expectedRevision: string;
  principal: EditorPrincipal;
}

export interface TrackedMaskReviewInputs {
  tracking: TrackMaskRequest;
  anchor: MaskAnchorRevision;
  manifest: ArtifactRef;
  proxy: ArtifactRef;
}

export interface JobResult {
  job: JobSnapshot;
  deduplicated: boolean;
}

const JOB_START_STATE = {
  analysis: "analyzing",
  preview: "rendering_preview",
  final: "rendering_final",
  export: "validating",
} as const;

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY, title TEXT NOT NULL, revision TEXT NOT NULL,
  asset_manifest_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_grants (
  project_id TEXT NOT NULL REFERENCES projects(project_id), principal_id TEXT NOT NULL,
  role TEXT NOT NULL, PRIMARY KEY(project_id, principal_id)
);
CREATE TABLE IF NOT EXISTS assets (
  asset_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id),
  revision TEXT NOT NULL, document TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mask_tracking_jobs (
  job_id TEXT PRIMARY KEY REFERENCES jobs(job_id), project_id TEXT NOT NULL REFERENCES projects(project_id), request TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tracked_mask_reviews (
  approval_id TEXT PRIMARY KEY REFERENCES approvals(approval_id),
  job_id TEXT NOT NULL REFERENCES mask_tracking_jobs(job_id), decided_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_tracked_reviews_job ON tracked_mask_reviews(job_id);
CREATE TABLE IF NOT EXISTS mask_anchors (
  mask_revision_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id),
  approval_id TEXT NOT NULL REFERENCES approvals(approval_id), request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL, document TEXT NOT NULL, approved_by TEXT,
  UNIQUE(project_id, request_id)
);
CREATE TABLE IF NOT EXISTS plans (
  plan_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id),
  plan_hash TEXT NOT NULL, revision TEXT NOT NULL, document TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id),
  plan_hash TEXT NOT NULL, purpose TEXT NOT NULL, request TEXT NOT NULL, grant TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mutations (
  project_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  response TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id, request_id)
);
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id),
  plan_hash TEXT NOT NULL, revision TEXT NOT NULL, kind TEXT NOT NULL,
  document TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS active_job_semantics ON jobs(project_id, plan_hash, revision, kind) WHERE active = 1;
CREATE TABLE IF NOT EXISTS constant_rate_streams (
  index_sha TEXT NOT NULL, stream_uid TEXT NOT NULL, PRIMARY KEY(index_sha, stream_uid)
);
CREATE TABLE IF NOT EXISTS preview_sheets (
  artifact_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(job_id),
  revision TEXT NOT NULL, blob TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contact_sheets (
  project_id TEXT NOT NULL REFERENCES projects(project_id), revision TEXT NOT NULL,
  artifact_id TEXT NOT NULL, blob TEXT NOT NULL, PRIMARY KEY(project_id, revision, artifact_id)
);
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(job_id), document TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  project_id TEXT NOT NULL, seq TEXT NOT NULL, document TEXT NOT NULL,
  PRIMARY KEY(project_id, seq)
);
-- Write-only event outbox: emit() mirrors every event here, but no drain/reader is
-- wired yet (get_events serves the events table). Retention/drain policy is an open
-- design decision; rows currently accumulate unbounded. Do not rely on it for delivery.
CREATE TABLE IF NOT EXISTS outbox (
  event_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, seq TEXT NOT NULL, document TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS uploads (
  upload_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, expected_size TEXT NOT NULL,
  expected_sha256 TEXT NOT NULL, display_name TEXT NOT NULL, media_type TEXT NOT NULL,
  next_offset TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS upload_receipts (
  upload_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, request_id TEXT NOT NULL,
  principal_id TEXT NOT NULL, sha256 TEXT NOT NULL, UNIQUE(project_id, request_id),
  FOREIGN KEY(project_id, request_id) REFERENCES mutations(project_id, request_id)
);
CREATE TABLE IF NOT EXISTS upload_chunks (
  upload_id TEXT NOT NULL, offset TEXT NOT NULL, chunk_sha256 TEXT NOT NULL,
  PRIMARY KEY(upload_id, offset)
);
-- Device project discovery joins grants by principal; the composite PK leads with project_id.
CREATE INDEX IF NOT EXISTS idx_project_grants_principal ON project_grants(principal_id);
`;

export class EditorStore {
  private readonly database: SqliteDatabase;
  private transactionDepth = 0;

  static async create(root: string): Promise<EditorStore> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    return new EditorStore(root);
  }

  private cas?: ContentAddressedStore;

  /** Bind the daemon-owned CAS so read-only artifact readers (e.g. the planner broker) can parse blobs. */
  bindCas(cas: ContentAddressedStore): void {
    this.cas = cas;
  }

  private constructor(root: string) {
    this.database = new DatabaseSync(path.join(root, "editor.sqlite"));
    try {
      this.initialize();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  private initialize(): void {
    this.database.exec(SCHEMA);
    const version = this.database
      .prepare("SELECT value FROM metadata WHERE key = 'formatVersion'")
      .get() as { value: string } | undefined;
    if (version && version.value !== "1") {
      editorFailure("SCHEMA_UNSUPPORTED", "The project database requires a newer reader");
    }
    this.database
      .prepare(
        "INSERT OR IGNORE INTO metadata(key, value) VALUES ('formatVersion', '1'), ('minReaderVersion', '1')",
      )
      .run();
    this.recoverJobs();
  }

  close(): void {
    this.database.close();
  }

  createProject(input: {
    requestId: string;
    title: string;
    principal: EditorPrincipal;
  }): ProjectSnapshot {
    this.requireRole(input.principal, "operator");
    const projectId = `project-${sha256Json({ kind: "video-project", requestId: input.requestId, principalId: input.principal.principalId }).slice(0, 32)}`;
    return this.mutate({
      projectId,
      requestId: input.requestId,
      payload: input,
      execute: () => {
        const hash = sha256Json([]);
        this.database
          .prepare(
            "INSERT INTO projects(project_id, title, revision, asset_manifest_hash, created_at) VALUES (?, ?, '0', ?, ?)",
          )
          .run(projectId, input.title, hash, this.now());
        this.grant(projectId, input.principal.principalId, "owner");
        this.emit(projectId, "project.created", { title: input.title });
        return this.project(projectId, input.principal);
      },
    });
  }

  registerDevice(input: {
    projectId: string;
    principalId: string;
    role: EditorRole;
    actor: EditorPrincipal;
  }): void {
    this.authorize(input.projectId, input.actor, "owner");
    this.grant(input.projectId, input.principalId, input.role);
  }

  private requireRole(principal: EditorPrincipal, required: EditorRole): void {
    const rank: Record<EditorRole, number> = { viewer: 0, operator: 1, owner: 2 };
    if (rank[principal.role] < rank[required])
      editorFailure("PERMISSION_DENIED", `This operation requires ${required} access`);
  }

  projectSummary(projectId: string, principal: EditorPrincipal) {
    this.authorize(projectId, principal, "viewer");
    const { title, revision } = this.projectRow(projectId);
    return { projectId, title, revision };
  }

  /** Projects the principal may open: all for the owner, only scoped grants for a paired device. */
  listProjects(principal: EditorPrincipal): Array<{ projectId: string; title: string; revision: string }> {
    type Row = { project_id: string; title: string; revision: string };
    const summarize = (row: Row) => ({
      projectId: row.project_id,
      title: row.title,
      revision: row.revision,
    });
    if (principal.role === "owner" && principal.projectIds === null) {
      const rows = this.database
        .prepare("SELECT project_id, title, revision FROM projects ORDER BY created_at, project_id")
        .all() as Row[];
      return rows.map(summarize);
    }
    const rows = this.database
      .prepare(
        "SELECT p.project_id, p.title, p.revision FROM projects p JOIN project_grants g ON g.project_id = p.project_id WHERE g.principal_id = ? ORDER BY p.created_at, p.project_id",
      )
      .all(principal.principalId) as Row[];
    return rows
      .filter((row) => principal.projectIds === null || principal.projectIds.includes(row.project_id))
      .map(summarize);
  }

  project(projectId: string, principal: EditorPrincipal): ProjectSnapshot {
    this.authorize(projectId, principal, "viewer");
    const row = this.projectRow(projectId);
    const plans = this.rows(
      "SELECT document FROM plans WHERE project_id = ? ORDER BY revision",
      projectId,
    ).map((document) => AcceptedEditPlanSchema.parse(JSON.parse(document)));
    const approvals = this.rows(
      "SELECT request FROM approvals WHERE project_id = ? ORDER BY created_at, approval_id",
      projectId,
    ).map((document) => ApprovalRequestSchema.parse(JSON.parse(document)));
    const jobs = this.rows(
      "SELECT document FROM jobs WHERE project_id = ? ORDER BY job_id",
      projectId,
    ).map((document) => JobSnapshotSchema.parse(JSON.parse(document)));
    return ProjectSnapshotSchema.parse({
      protocolVersion: "1",
      projectId,
      title: row.title,
      revision: row.revision,
      baseAssetManifestHash: row.asset_manifest_hash,
      assets: this.rows(
        "SELECT document FROM assets WHERE project_id = ? ORDER BY asset_id",
        projectId,
      ).map((document) => SourceAssetSchema.parse(JSON.parse(document))),
      plans,
      approvals,
      jobs,
      latestSeq: this.latestSeq(projectId),
    });
  }

  addAsset(
    projectId: string,
    asset: SourceAsset,
    requestId: string,
    principal: EditorPrincipal,
  ): SourceAsset {
    this.authorize(projectId, principal, "operator");
    return this.mutate({
      projectId,
      requestId,
      payload: asset,
      execute: () => {
        const project = this.projectRow(projectId);
        const manifest = this.assetManifest(projectId);
        manifest.push({ assetId: asset.assetId, sha256: asset.original.sha256 });
        manifest.sort((left, right) => left.assetId.localeCompare(right.assetId));
        const revision = (BigInt(project.revision) + 1n).toString();
        this.database
          .prepare(
            "INSERT INTO assets(asset_id, project_id, revision, document) VALUES (?, ?, ?, ?)",
          )
          .run(asset.assetId, projectId, revision, JSON.stringify(asset));
        this.database
          .prepare("UPDATE projects SET revision = ?, asset_manifest_hash = ? WHERE project_id = ?")
          .run(revision, sha256Json(manifest), projectId);
        this.emit(projectId, "artifact.committed", { assetId: asset.assetId, revision });
        return asset;
      },
    });
  }

  asset(
    projectId: string,
    assetId: string,
    revision: string,
    principal: EditorPrincipal,
  ): SourceAsset {
    this.authorize(projectId, principal, "viewer");
    const row = this.database
      .prepare("SELECT document FROM assets WHERE project_id = ? AND asset_id = ?")
      .get(projectId, assetId) as { document: string } | undefined;
    if (!row) editorFailure("ASSET_NOT_FOUND", "The asset does not exist in this project");
    const asset = SourceAssetSchema.parse(JSON.parse(row.document));
    if (this.projectRow(projectId).revision !== revision)
      editorFailure(
        "REVISION_CONFLICT",
        "The asset revision has changed; download a fresh snapshot",
      );
    return asset;
  }

  recordConstantRateStream(indexSha: string, streamUid: string): void {
    this.database.prepare("INSERT OR IGNORE INTO constant_rate_streams VALUES (?, ?)").run(indexSha, streamUid);
  }

  private hasConstantRate(indexSha: string, streamUid: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM constant_rate_streams WHERE index_sha = ? AND stream_uid = ?").get(indexSha, streamUid));
  }

  reviewablePreview(projectId: string, jobId: string, principal: EditorPrincipal, revision?: string): ArtifactRef {
    const job = this.job(projectId, jobId, principal);
    if (job.kind !== "preview" || job.state !== "awaiting_review")
      editorFailure("PERMISSION_DENIED", "Only a reviewable preview may be read on this route");
    if (revision !== undefined && job.candidateRevision !== revision)
      editorFailure("REVISION_CONFLICT", "The preview belongs to another candidate revision");
    const artifact = job.artifacts.find(a => a.artifactId === `${jobId}:candidate` && a.kind === "candidate" && a.jobId === jobId && a.projectId === projectId && a.revision === job.candidateRevision);
    if (!artifact) editorFailure("ASSET_NOT_FOUND", "No reviewed preview bytes for this revision");
    return artifact;
  }

  registerPreviewSheet(projectId: string, jobId: string, revision: string, blob: BlobRef, principal: EditorPrincipal): string {
    this.reviewablePreview(projectId, jobId, principal, revision);
    const id = `contact:preview:${sha256Json([jobId, revision, blob.sha256])}`;
    this.database.prepare("INSERT OR IGNORE INTO preview_sheets VALUES (?, ?, ?, ?, ?)").run(id, projectId, jobId, revision, JSON.stringify(blob));
    return id;
  }

  registerContactSheet(projectId: string, revision: string, assetId: string, blob: BlobRef, principal: EditorPrincipal): string {
    this.authorize(projectId, principal, "operator");
    this.asset(projectId, assetId, revision, principal);
    const id = `contact:${sha256Json([assetId, blob.sha256])}`;
    this.database.prepare("INSERT OR IGNORE INTO contact_sheets(project_id, revision, artifact_id, blob) VALUES (?, ?, ?, ?)")
      .run(projectId, revision, id, JSON.stringify(blob));
    return id;
  }

  contactSheetBlob(projectId: string, revision: string, id: string, principal: EditorPrincipal): BlobRef {
    this.authorize(projectId, principal, "viewer");
    if (id.startsWith("contact:preview:")) {
      const row = this.database.prepare("SELECT job_id, blob FROM preview_sheets WHERE project_id = ? AND revision = ? AND artifact_id = ?").get(projectId, revision, id) as { job_id: string; blob: string } | undefined;
      if (!row) editorFailure("ASSET_NOT_FOUND", "No preview sheet for this project and revision");
      this.reviewablePreview(projectId, row.job_id, principal, revision);
      return BlobRefSchema.parse(JSON.parse(row.blob));
    }
    if (this.projectRow(projectId).revision !== revision)
      editorFailure("REVISION_CONFLICT", "Download a fresh project snapshot");
    const [document] = this.rows("SELECT blob FROM contact_sheets WHERE project_id = ? AND revision = ? AND artifact_id = ?", projectId, revision, id);
    if (!document) editorFailure("ASSET_NOT_FOUND", "No such contact sheet in this project revision");
    return BlobRefSchema.parse(JSON.parse(document));
  }

  artifact(
    projectId: string,
    artifactId: string,
    revision: string,
    principal: EditorPrincipal,
  ): ArtifactRef {
    this.authorize(projectId, principal, "viewer");
    const job = this.rows("SELECT document FROM jobs WHERE project_id = ?", projectId).map(
      (document) => JobSnapshotSchema.parse(JSON.parse(document)),
    );
    const artifact = job
      .flatMap((candidate) => candidate.artifacts)
      .find((candidate) => candidate.artifactId === artifactId);
    if (!artifact) editorFailure("ASSET_NOT_FOUND", "The artifact does not exist in this project");
    if (artifact.revision !== revision)
      editorFailure("REVISION_CONFLICT", "The artifact belongs to an older revision");
    if (artifact.kind === "export" || artifact.kind === "manifest")
      this.authorize(projectId, principal, "operator");
    return artifact;
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
    this.authorize(projectId, principal, "operator");
    return this.mutate({
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
        this.database
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
            this.now(),
          );
        return { uploadId, chunkSize: "262144", nextOffset: "0" };
      },
    });
  }

  upload(uploadId: string): {
    projectId: string;
    expectedSize: string;
    expectedSha256: string;
    displayName: string;
    mediaType: string;
    nextOffset: string;
  } {
    const row = this.database
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

  uploadStatus(
    projectId: string,
    uploadId: string,
    principal: EditorPrincipal,
  ): { uploadId: string; chunkSize: string; nextOffset: string } {
    const upload = this.upload(uploadId);
    this.authorize(projectId, principal, "operator");
    if (upload.projectId !== projectId)
      editorFailure("PERMISSION_DENIED", "The upload belongs to another project");
    return { uploadId, chunkSize: "262144", nextOffset: upload.nextOffset };
  }

  confirmedChunkHash(uploadId: string, offset: string): string | undefined {
    const row = this.database
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
    this.atomic(() => {
      const upload = this.upload(input.uploadId);
      if (upload.nextOffset !== input.offset)
        editorFailure("IDEMPOTENCY_CONFLICT", "The confirmed offset changed");
      this.database
        .prepare("INSERT INTO upload_chunks(upload_id, offset, chunk_sha256) VALUES (?, ?, ?)")
        .run(input.uploadId, input.offset, input.digest);
      this.database
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
    const receipt = this.database
      .prepare(`SELECT r.project_id, r.request_id, r.principal_id, r.sha256, m.response
      FROM upload_receipts r JOIN mutations m USING(project_id, request_id) WHERE r.upload_id = ?`)
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
    this.authorize(receipt.project_id, principal, "operator");
    if (receipt.principal_id !== principal.principalId)
      editorFailure("PERMISSION_DENIED", "This upload receipt belongs to another principal");
    if (receipt.request_id !== requestId || receipt.sha256 !== sha256)
      editorFailure("IDEMPOTENCY_CONFLICT", "The upload was committed with a different request");
    return { projectId: receipt.project_id, asset: SourceAssetSchema.parse(JSON.parse(receipt.response)) };
  }

  finishUpload(
    uploadId: string,
    asset: SourceAsset,
    requestId: string,
    principal: EditorPrincipal,
  ): SourceAsset {
    return this.atomic(() => {
      const upload = this.upload(uploadId);
      const result = this.addAsset(upload.projectId, asset, requestId, principal);
      this.database
        .prepare(
          "INSERT INTO upload_receipts(upload_id, project_id, request_id, principal_id, sha256) VALUES (?,?,?,?,?)",
        )
        .run(uploadId, upload.projectId, requestId, principal.principalId, result.original.sha256);
      this.database.prepare("DELETE FROM upload_chunks WHERE upload_id = ?").run(uploadId);
      this.database.prepare("DELETE FROM uploads WHERE upload_id = ?").run(uploadId);
      return result;
    });
  }

  /**
   * Read one accepted plan by id. Viewer-level; used by the planner broker's
   * get_plan tool and the client-facing get_plan RPC.
   */
  plan(projectId: string, planId: string, principal: EditorPrincipal): AcceptedEditPlan {
    this.authorize(projectId, principal, "viewer");
    const plan = this.project(projectId, principal)
      .plans.find((p) => p.planId === planId);
    if (!plan) editorFailure("ASSET_NOT_FOUND", "No such plan in the bound project");
    return plan;
  }

  validateProposal(draft: EditPlanDraftV1, principal: EditorPrincipal): void {
    this.authorize(draft.projectId, principal, "operator");
    this.validatePlan(draft);
    for (const g of draft.generationRequests) {
      const input = this.approvedSequence(
        draft.projectId,
        g.maskApprovalId!,
        g.referenceManifestHash,
        draft.baseTimelineRevision,
        principal,
      );
      const op = draft.trimOperations[0]!;
      if (
        g.shotId !== input.manifest.jobId ||
        g.maskRevisionId !== input.manifest.artifactId ||
        g.samplingMapHash !==
          sha256Json([
            "source-ordinal",
            input.manifest.blob.sha256,
            input.tracking.firstFrame,
            9,
          ]) ||
        op.source.assetId !== input.anchor.anchor.assetId ||
        op.source.streamUid !== input.anchor.anchor.streamUid
      )
        editorFailure(
          "PLAN_SEMANTIC_INVALID",
          "Generation references differ from the approved mask sequence",
        );
      // The approved anchor is an exact point on both the source and model clocks.
      const anchor = input.anchor.anchor;
      const rate = BigInt(g.sampleFps.num),
        period = BigInt(g.sampleFps.den);
      const { start, duration } = op.sourceRange;
      const offset = BigInt(anchor.frame - input.tracking.firstFrame);
      const atAnchor = BigInt(start.num) * rate + offset * period * BigInt(start.den);
      if (
        rate <= 0n ||
        BigInt(duration.num) * rate !== 9n * period * BigInt(duration.den) ||
        atAnchor * BigInt(anchor.timeBase.den) !==
          BigInt(anchor.pts) * BigInt(anchor.timeBase.num) * BigInt(start.den) * rate
      )
        editorFailure(
          "PLAN_SEMANTIC_INVALID",
          "Generation trim does not align with the approved source anchor",
        );
    }
  }

  /**
   * Read-only dry run of a plan draft: validation outcome plus a bounded
   * timeline summary. Never persists anything and never touches media.
   */
  estimateTimeline(input: { requestId: string; draft: EditPlanDraftV1 }, principal: EditorPrincipal) {
    this.authorize(input.draft.projectId, principal, "operator");
    let valid = true;
    let issue: string | null = null;
    try {
      this.validatePlan(input.draft);
    } catch (error) {
      valid = false;
      issue = error instanceof Error ? error.message : String(error);
    }
    return {
      requestId: input.requestId,
      projectId: input.draft.projectId,
      valid,
      issue,
      ...summarizeDraftTimeline(input.draft),
    };
  }

  createPlan(input: CreatePlanInput): { plan: AcceptedEditPlan; approval: ApprovalRequest } {
    const { draft } = input;
    this.validateProposal(draft, input.principal);
    const idempotencyKey = sha256Json([
      draft.projectId,
      input.principal.principalId,
      input.runId,
      input.toolCallId,
    ]);
    return this.mutate({
      projectId: draft.projectId,
      requestId: input.requestId,
      payload: { draft, runId: input.runId, toolCallId: input.toolCallId },
      execute: () => {
        const existing = this.database
          .prepare("SELECT plan_id FROM plans WHERE plan_id = ?")
          .get(idempotencyKey) as { plan_id: string } | undefined;
        const planHash = sha256Json({
          draft,
          deterministicBackendId: draft.preferredDeterministicBackendId ?? "ffmpeg",
        });
        if (existing) {
          const result = this.planResult(existing.plan_id);
          if (result.plan.planHash !== planHash)
            editorFailure(
              "IDEMPOTENCY_CONFLICT",
              "The tool call already proposed a different plan",
            );
          return result;
        }
        const plan = AcceptedEditPlanSchema.parse({
          ...draft,
          deterministicBackendId: draft.preferredDeterministicBackendId ?? "ffmpeg",
          planId: idempotencyKey,
          revision: draft.baseTimelineRevision,
          runId: input.runId,
          idempotencyKey,
          planHash,
          status: "proposed",
        });
        const approval = this.newApproval(plan, "preview");
        this.database
          .prepare(
            "INSERT INTO plans(plan_id, project_id, plan_hash, revision, document) VALUES (?, ?, ?, ?, ?)",
          )
          .run(plan.planId, plan.projectId, planHash, plan.revision, JSON.stringify(plan));
        this.insertApproval(approval);
        this.emit(draft.projectId, "plan.proposed", { planId: plan.planId, planHash });
        this.emit(draft.projectId, "approval.requested", {
          approvalId: approval.approvalId,
          purpose: approval.purpose,
        });
        return { plan, approval };
      },
    });
  }

  savedMaskApproval(request: CreateMaskRevisionRequest, principal: EditorPrincipal) {
    this.authorize(request.anchor.projectId, principal, "operator");
    const row = this.database.prepare(
      "SELECT approval_id, request_hash FROM mask_anchors WHERE project_id = ? AND request_id = ?",
    ).get(request.anchor.projectId, request.requestId) as { approval_id: string; request_hash: string } | undefined;
    if (!row) return undefined;
    if (row.request_hash !== sha256Json(request)) editorFailure("IDEMPOTENCY_CONFLICT", "Mask save request changed");
    return this.approval(row.approval_id);
  }

  private trackingReviewInputs(
    projectId: string,
    jobId: string,
    revision: string,
    principal: EditorPrincipal,
  ): TrackedMaskReviewInputs {
    const job = this.job(projectId, jobId, principal);
    const tracking = this.trackingRequest(projectId, jobId);
    if (!tracking || job.kind !== "analysis" || job.state !== "completed")
      editorFailure("INVALID_ARGUMENT", "A completed mask tracking job is required");
    if (job.revision !== revision || tracking.expectedRevision !== revision)
      editorFailure("REVISION_CONFLICT", "Mask tracking revision changed");
    const anchor = this.approvedTrackingAnchor(tracking, principal);
    const match = (kind: ArtifactRef["kind"], suffix: string) =>
      job.artifacts.find(
        (a) =>
          a.kind === kind &&
          a.projectId === projectId &&
          a.jobId === jobId &&
          a.revision === revision &&
          a.artifactId === jobId + suffix,
      );
    const manifest = match("mask", ":tracked-mask");
    const proxy = match("proxy", ":tracking-preview");
    if (!manifest || !proxy)
      editorFailure("ASSET_NOT_FOUND", "Missing tracked mask or review proxy");
    return { tracking, anchor, manifest, proxy };
  }

  requestTrackedMaskReview(request: RequestTrackedMaskReview, principal: EditorPrincipal) {
    const { projectId, jobId, expectedRevision } = request;
    this.authorize(projectId, principal, "operator");
    return this.mutate({
      projectId,
      requestId: request.requestId,
      payload: request,
      execute: () => {
        const { tracking, manifest, proxy } = this.trackingReviewInputs(
          projectId,
          jobId,
          expectedRevision,
          principal,
        );
        if (
          manifest.blob.sha256 !== request.manifestHash ||
          proxy.blob.sha256 !== request.reviewHash
        )
          editorFailure("ARTIFACT_HASH_MISMATCH", "Tracked mask or review video changed");
        const last = this.database
          .prepare(
            "SELECT approval_id FROM tracked_mask_reviews WHERE job_id = ? ORDER BY rowid DESC LIMIT 1",
          )
          .get(jobId) as { approval_id: string } | undefined;
        if (last) {
          const existing = this.approval(last.approval_id);
          if (
            existing.status === "approved" ||
            (existing.status === "pending" && Date.parse(existing.expiresAt) > Date.now())
          )
            return existing;
          if (existing.status === "pending")
            this.updateApproval({ ...existing, status: "expired" });
        }
        const approval = ApprovalRequestSchema.parse({
          projectId,
          approvalId: randomUUID(),
          subjectType: "mask_revision",
          subjectId: manifest.artifactId,
          subjectRevision: manifest.revision,
          subjectHash: manifest.blob.sha256,
          baseTimelineRevision: expectedRevision,
          purpose: "input",
          requiredInputs: [
            {
              type: "anchor_approval",
              id: tracking.anchorApprovalId,
              revision: expectedRevision,
              hash: tracking.anchorHash,
            },
            {
              type: "review_proxy",
              id: proxy.artifactId,
              revision: proxy.revision,
              hash: proxy.blob.sha256,
            },
          ],
          diffSummary: {
            intent: "整段对象掩码",
            operationCount: tracking.frameCount,
            summary: `源帧 ${tracking.firstFrame}–${tracking.firstFrame + tracking.frameCount - 1}，共 ${tracking.frameCount} 帧`,
          },
          generationCostCapMicros: "0",
          externalDestinations: [],
          status: "pending",
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        });
        this.insertApproval(approval);
        this.database
          .prepare("INSERT INTO tracked_mask_reviews(approval_id,job_id) VALUES(?,?)")
          .run(approval.approvalId, jobId);
        this.emit(projectId, "approval.requested", {
          approvalId: approval.approvalId,
          purpose: "input",
        });
        return approval;
      },
    });
  }

  private maskInput(approval: ApprovalRequest, principal: EditorPrincipal) {
    const row = this.database
      .prepare("SELECT job_id FROM tracked_mask_reviews WHERE approval_id = ?")
      .get(approval.approvalId) as { job_id: string } | undefined;
    if (row) {
      const sequence = this.trackingReviewInputs(
        approval.projectId,
        row.job_id,
        approval.baseTimelineRevision,
        principal,
      );
      const { manifest, proxy, tracking } = sequence;
      if (
        manifest.artifactId !== approval.subjectId ||
        manifest.blob.sha256 !== approval.subjectHash ||
        !approval.requiredInputs.some(
          (i) =>
            i.type === "review_proxy" &&
            i.id === proxy.artifactId &&
            i.hash === proxy.blob.sha256 &&
            i.revision === proxy.revision,
        ) ||
        !approval.requiredInputs.some(
          (i) =>
            i.type === "anchor_approval" &&
            i.id === tracking.anchorApprovalId &&
            i.hash === tracking.anchorHash,
        )
      )
        editorFailure("ARTIFACT_HASH_MISMATCH", "Tracked input revision changed");
      return { kind: "sequence" as const, ...sequence };
    }
    const revision = this.maskRevision(approval.projectId, approval.subjectId, principal);
    if (sha256Json(revision) !== approval.subjectHash)
      editorFailure("ARTIFACT_HASH_MISMATCH", "Mask revision changed");
    return { kind: "anchor" as const, revision };
  }

  approvedSequence(
    projectId: string,
    approvalId: string,
    hash: string,
    revision: string,
    principal: EditorPrincipal,
  ) {
    this.authorize(projectId, principal, "operator");
    const approval = this.approval(approvalId);
    if (
      approval.projectId !== projectId ||
      approval.status !== "approved" ||
      approval.purpose !== "input" ||
      approval.subjectType !== "mask_revision" ||
      approval.subjectHash !== hash ||
      approval.baseTimelineRevision !== revision
    )
      editorFailure(
        "PERMISSION_DENIED",
        "An approved mask sequence in the current project is required",
      );
    const input = this.maskInput(approval, principal);
    if (input.kind !== "sequence" || input.tracking.frameCount !== 9)
      editorFailure(
        "CAPABILITY_UNAVAILABLE",
        "The local VACE profile requires nine approved source frames",
      );
    return input;
  }

  pendingMaskForDecision(id: string, principal: EditorPrincipal) {
    const approval = this.approval(id);
    this.authorize(approval.projectId, principal, "operator");
    if (approval.status === "pending" && approval.subjectType === "mask_revision")
      return this.maskInput(approval, principal);
    return undefined;
  }

  maskRevision(projectId: string, id: string, principal: EditorPrincipal) {
    this.authorize(projectId, principal, "viewer");
    const row = this.database.prepare(
      "SELECT document FROM mask_anchors WHERE project_id = ? AND mask_revision_id = ?",
    ).get(projectId, id) as { document: string } | undefined;
    if (!row) editorFailure("ASSET_NOT_FOUND", "Unknown mask revision in this project");
    return MaskAnchorRevisionSchema.parse(JSON.parse(row.document));
  }

  saveMaskRevision(request: CreateMaskRevisionRequest, anchor: InspectFrameHeader, rawLabelMask: BlobRef,
    reviewImage: BlobRef, principal: EditorPrincipal): ApprovalRequest {
    const projectId = request.anchor.projectId;
    this.authorize(projectId, principal, "operator");
    return this.mutate({ projectId, requestId: request.requestId, payload: request, execute: () => {
      const asset = this.asset(projectId, anchor.assetId, request.expectedRevision, principal);
      const stream = asset.streams.find(s => s.streamUid === anchor.streamUid);
      if (!stream || asset.original.sha256 !== anchor.sourceSha256 || asset.presentationIndex.sha256 !== anchor.sourcePresentationIndexHash)
        editorFailure("REVISION_CONFLICT", "Mask inputs changed");
      const revision = MaskAnchorRevisionSchema.parse({
        schemaVersion: "video.mask-anchor/v1", maskRevisionId: randomUUID(), projectId,
        baseTimelineRevision: request.expectedRevision, anchor, rotation: stream.rotation ?? "0",
        sampleAspectRatio: stream.sampleAspectRatio ?? "unknown", rawLabelMask, reviewImage,
      });
      const approval = ApprovalRequestSchema.parse({
        approvalId: randomUUID(), projectId, subjectType: "mask_revision", subjectId: revision.maskRevisionId,
        subjectRevision: "1", subjectHash: sha256Json(revision), baseTimelineRevision: request.expectedRevision,
        purpose: "input", requiredInputs: [{type: "asset", id: asset.assetId, revision: request.expectedRevision, hash: asset.original.sha256}],
        diffSummary: {intent: "单帧对象掩码", operationCount: 1, summary: `${asset.displayName} · 源帧 ${anchor.frame}`},
        generationCostCapMicros: "0", externalDestinations: [], status: "pending",
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      });
      this.insertApproval(approval);
      this.database.prepare("INSERT INTO mask_anchors(mask_revision_id,project_id,approval_id,request_id,request_hash,document) VALUES(?,?,?,?,?,?)")
        .run(revision.maskRevisionId, projectId, approval.approvalId, request.requestId, sha256Json(request), JSON.stringify(revision));
      this.emit(projectId, "approval.requested", { approvalId: approval.approvalId, purpose: "input" });
      return approval;
    }});
  }

  decideApproval(
    input: ApprovalDecision,
    principal: EditorPrincipal,
  ): { approval: ApprovalRequest; grant?: ApprovalGrant } {
    const approval = this.approval(input.approvalId);
    this.authorize(approval.projectId, principal, "operator");
    return this.mutate({
      projectId: approval.projectId,
      requestId: input.requestId,
      payload: input,
      execute: () => {
        const current = this.approval(input.approvalId);
        if (
          current.baseTimelineRevision !== input.expectedRevision ||
          this.projectRow(current.projectId).revision !== input.expectedRevision
        )
          editorFailure("REVISION_CONFLICT", "The approval belongs to an older timeline revision");
        if (current.status !== "pending")
          editorFailure("APPROVAL_CONSUMED", "The approval has already been decided");
        if (Date.parse(current.expiresAt) <= Date.now())
          editorFailure("APPROVAL_EXPIRED", "The approval has expired");
        if (input.decision === "reject") {
          const rejected = { ...current, status: "rejected" as const };
          this.updateApproval(rejected);
          if (current.subjectType === "mask_revision") this.database.prepare("UPDATE tracked_mask_reviews SET decided_by = ? WHERE approval_id = ?")
            .run(principal.principalId, current.approvalId);
          this.emit(approval.projectId, "approval.decided", {
            approvalId: current.approvalId,
            decision: "rejected",
          });
          return { approval: rejected };
        }
        if (current.purpose === "input" && current.subjectType === "mask_revision") {
          const inputMask = this.maskInput(current, principal);
          const approved = { ...current, status: "approved" as const };
          this.updateApproval(approved);
          if (inputMask.kind === "sequence")
            this.database.prepare("UPDATE tracked_mask_reviews SET decided_by = ? WHERE approval_id = ?").run(principal.principalId, current.approvalId);
          else this.database.prepare("UPDATE mask_anchors SET approved_by = ? WHERE project_id = ? AND mask_revision_id = ?")
            .run(principal.principalId, current.projectId, current.subjectId);
          this.emit(current.projectId, "approval.decided", { approvalId: current.approvalId, decision: "approved" });
          return { approval: approved };
        }
        const grant = ApprovalGrantSchema.parse({
          grantId: randomUUID(),
          approvalId: current.approvalId,
          projectId: current.projectId,
          subjectHash: current.subjectHash,
          planHash: current.planHash,
          baseTimelineRevision: current.baseTimelineRevision,
          purpose: current.purpose,
          approvedByDeviceId: principal.principalId,
          approvedAt: this.now(),
          expiresAt: current.expiresAt,
        });
        const approved = { ...current, status: "approved" as const };
        this.updateApproval(approved, grant);
        this.emit(approval.projectId, "approval.granted", {
          approvalId: current.approvalId,
          grantId: grant.grantId,
        });
        return { approval: approved, grant };
      },
    });
  }

  createJob(input: CreateJobInput): JobResult {
    this.authorize(input.projectId, input.principal, "operator");
    return this.mutate({
      projectId: input.projectId,
      requestId: input.requestId,
      payload: input,
      execute: () => {
        const approval = this.approval(input.approvalId);
        const stored = this.storedApproval(input.approvalId);
        const grant = stored.grant;
        if (!grant || grant.grantId !== input.grantId)
          editorFailure("PERMISSION_DENIED", "The grant does not belong to this approval");
        if (grant.consumedAt)
          editorFailure("APPROVAL_CONSUMED", "The grant has already been consumed");
        if (grant.revokedReason) editorFailure("PERMISSION_DENIED", "The grant has been revoked");
        if (Date.parse(grant.expiresAt) <= Date.now())
          editorFailure("APPROVAL_EXPIRED", "The grant has expired");
        if (
          approval.projectId !== input.projectId ||
          grant.baseTimelineRevision !== input.expectedRevision
        )
          editorFailure("REVISION_CONFLICT", "The grant is not valid for this project revision");
        const project = this.projectRow(input.projectId);
        if (project.revision !== input.expectedRevision)
          editorFailure("REVISION_CONFLICT", "The project changed after approval");
        const plan = this.planForApproval(approval);
        if (plan.planHash !== grant.planHash || plan.revision !== grant.baseTimelineRevision)
          editorFailure("REVISION_CONFLICT", "The approved plan is no longer current");
        if (grant.purpose !== approval.purpose || grant.subjectHash !== approval.subjectHash)
          editorFailure("PERMISSION_DENIED", "Grant subject mismatch");
        if (grant.purpose !== "preview") this.reviewedCandidate(approval);
        const state = JOB_START_STATE[grant.purpose];
        const existing = this.database
          .prepare(
            "SELECT job_id, document FROM jobs WHERE project_id = ? AND plan_hash = ? AND revision = ? AND kind = ? AND active = 1",
          )
          .get(input.projectId, plan.planHash, plan.revision, grant.purpose) as
          | { job_id: string; document: string }
          | undefined;
        if (existing)
          return {
            job: JobSnapshotSchema.parse(JSON.parse(existing.document)),
            deduplicated: true,
          };
        const job = JobSnapshotSchema.parse({
          jobId: randomUUID(),
          projectId: input.projectId,
          revision: plan.revision,
          planHash: plan.planHash,
          approvalId: approval.approvalId,
          candidateRevision: (BigInt(this.latestSeq(input.projectId)) + 1n).toString(),
          parentRevision: approval.subjectRevision,
          kind: grant.purpose,
          state,
          phaseDetail: "queued",
          progress: { completedUnits: "0" },
          artifacts: [],
        });
        this.database
          .prepare(
            "INSERT INTO jobs(job_id, project_id, plan_hash, revision, kind, document, active) VALUES (?, ?, ?, ?, ?, ?, 1)",
          )
          .run(job.jobId, job.projectId, job.planHash, job.revision, job.kind, JSON.stringify(job));
        this.updateApproval(approval, { ...grant, consumedAt: this.now() });
        this.emit(input.projectId, "job.state.changed", { jobId: job.jobId, state: job.state });
        return { job, deduplicated: false };
      },
    });
  }

  approvedTrackingAnchor(request: TrackMaskRequest, principal: EditorPrincipal) {
    this.authorize(request.projectId, principal, "operator");
    const approval = this.approval(request.anchorApprovalId);
    if (approval.projectId !== request.projectId || approval.subjectType !== "mask_revision" ||
        approval.status !== "approved" || approval.purpose !== "input" || approval.subjectHash !== request.anchorHash)
      editorFailure("PERMISSION_DENIED", "An approved anchor in this project is required");
    if (approval.baseTimelineRevision !== request.expectedRevision ||
        this.projectRow(request.projectId).revision !== request.expectedRevision)
      editorFailure("REVISION_CONFLICT", "The approved anchor belongs to another timeline revision");
    const revision = this.maskRevision(request.projectId, approval.subjectId, principal);
    if (sha256Json(revision) !== approval.subjectHash)
      editorFailure("ARTIFACT_HASH_MISMATCH", "Approved anchor manifest changed");
    const stop = request.firstFrame + request.frameCount;
    if (stop > revision.anchor.frameCount || revision.anchor.frame < request.firstFrame || revision.anchor.frame >= stop)
      editorFailure("INVALID_ARGUMENT", "The source range must include the approved anchor");
    return revision;
  }

  trackingRequest(projectId: string, jobId: string) {
    const row = this.database.prepare("SELECT request FROM mask_tracking_jobs WHERE project_id = ? AND job_id = ?")
      .get(projectId, jobId) as { request: string } | undefined;
    return row && TrackMaskRequestSchema.parse(JSON.parse(row.request));
  }

  createTrackingJob(request: TrackMaskRequest, principal: EditorPrincipal) {
    const revision = this.approvedTrackingAnchor(request, principal);
    return this.createAnalysisJob({projectId: request.projectId, requestId: request.requestId,
      assetId: revision.anchor.assetId, principal, tracking: request});
  }

  /** Read-only analysis job: no approval/grant, operator-or-above, deduplicated per asset+hash. */
  createAnalysisJob(input: {
    requestId: string;
    projectId: string;
    assetId: string;
    rate?: string;
    tracking?: TrackMaskRequest;
    principal: EditorPrincipal;
  }): JobResult {
    this.authorize(input.projectId, input.principal, "operator");
    return this.mutate({
      projectId: input.projectId,
      requestId: input.requestId,
      payload: input,
      execute: () => {
        const project = this.project(input.projectId, {
          principalId: "owner",
          role: "owner",
          projectIds: null,
        });
        const asset = project.assets.find((a) => a.assetId === input.assetId);
        if (!asset) editorFailure("ASSET_NOT_FOUND", "The asset is not in this project");
        const rate = input.rate ?? "25/1";
        const track = input.tracking;
        const planHash = track ? sha256Json(["track", track.anchorApprovalId, track.anchorHash, track.expectedRevision, track.firstFrame, track.frameCount])
          : sha256Json(["analysis", input.assetId, asset.original.sha256, rate]);
        const existing = this.database
          .prepare(
            "SELECT document FROM jobs WHERE project_id = ? AND plan_hash = ? AND kind = 'analysis' AND active = 1",
          )
          .get(input.projectId, planHash) as { document: string } | undefined;
        if (existing)
          return { job: JobSnapshotSchema.parse(JSON.parse(existing.document)), deduplicated: true };
        const job = JobSnapshotSchema.parse({
          jobId: randomUUID(),
          projectId: input.projectId,
          revision: project.revision,
          planHash,
          kind: "analysis",
          state: JOB_START_STATE.analysis,
          phaseDetail: "queued",
          progress: { completedUnits: "0" },
          artifacts: [],
          // Asset analysis panels and planner tools use this field for scene, audio and sampling data.
          // Mask tracking binds its source through the approved revision instead.
          analysisAssetId: track ? undefined : input.assetId,
          analysisRate: track ? undefined : rate,
        });
        this.database
          .prepare(
            "INSERT INTO jobs(job_id, project_id, plan_hash, revision, kind, document, active) VALUES (?, ?, ?, ?, ?, ?, 1)",
          )
          .run(job.jobId, job.projectId, planHash, job.revision, job.kind, JSON.stringify(job));
        if (track) this.database.prepare("INSERT INTO mask_tracking_jobs(job_id,project_id,request) VALUES(?,?,?)")
          .run(job.jobId, job.projectId, JSON.stringify(track));
        this.emit(input.projectId, "job.state.changed", { jobId: job.jobId, state: job.state });
        return { job, deduplicated: false };
      },
    });
  }

  /**
   * Read the deterministic scene-cut artifact of the latest analysis job for an
   * asset. Bounded: at most 64 cuts, frame-aligned, hashes included. Viewer-level.
   */
  async sceneCuts(projectId: string, assetId: string, principal: EditorPrincipal) {
    this.authorize(projectId, principal, "viewer");
    if (!this.cas) editorFailure("CAPABILITY_UNAVAILABLE", "The CAS reader is not bound to the store");
    const project = this.project(projectId, principal);
    const asset = project.assets.find((a) => a.assetId === assetId);
    if (!asset) editorFailure("ASSET_NOT_FOUND", "The asset is not in this project");
    const latest = project.jobs
      .filter((j) => j.analysisAssetId === assetId)
      .sort((a, b) => (a.jobId < b.jobId ? 1 : -1))[0];
    if (!latest) editorFailure("ASSET_NOT_FOUND", "No analysis job exists for this asset");
    const artifact = latest.artifacts.find((a) => a.kind === "scenecuts");
    if (!artifact) editorFailure("ASSET_NOT_FOUND", "The analysis job has no scene-cut artifact yet");
    const doc = JSON.parse((await this.cas.readBytes(artifact.blob)).toString("utf8")) as {
      schemaVersion?: string;
      threshold?: string;
      minGapSeconds?: string;
      rate?: { num: string; den: string } | null;
      frameCount?: number;
      truncated?: boolean;
      cuts?: Array<{ frameIndex: number; ptsTime: string; score: string; aligned: { num: string; den: string } }>;
    };
    if (doc.schemaVersion !== "video.scene-cuts/v1")
      editorFailure("ARTIFACT_HASH_MISMATCH", "Unexpected scene-cut schema version");
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

  /**
   * Read the deterministic waveform artifact of the latest analysis job for an
   * asset. Bounded: at most 1200 RMS buckets (100 ms each), hashes included.
   * Viewer-level; lets the planner align cuts to loud/silent audio without pixels.
   */
  async waveform(projectId: string, assetId: string, principal: EditorPrincipal) {
    this.authorize(projectId, principal, "viewer");
    if (!this.cas) editorFailure("CAPABILITY_UNAVAILABLE", "The CAS reader is not bound to the store");
    const project = this.project(projectId, principal);
    const asset = project.assets.find((a) => a.assetId === assetId);
    if (!asset) editorFailure("ASSET_NOT_FOUND", "The asset is not in this project");
    const latest = project.jobs
      .filter((j) => j.analysisAssetId === assetId)
      .sort((a, b) => (a.jobId < b.jobId ? 1 : -1))[0];
    if (!latest) editorFailure("ASSET_NOT_FOUND", "No analysis job exists for this asset");
    const artifact = latest.artifacts.find((a) => a.kind === "waveform");
    if (!artifact) editorFailure("ASSET_NOT_FOUND", "The analysis job has no waveform artifact yet");
    const doc = JSON.parse((await this.cas.readBytes(artifact.blob)).toString("utf8")) as {
      schemaVersion?: string;
      streamUid?: string;
      sampleRate?: number;
      bucketMs?: number;
      durationAnalyzedMs?: string;
      truncated?: boolean;
      buckets?: string[];
    };
    if (doc.schemaVersion !== "video.waveform/v1")
      editorFailure("ARTIFACT_HASH_MISMATCH", "Unexpected waveform schema version");
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

  /**
   * Bounded metadata view of the latest analysis job for an asset: state,
   * rate, artifact refs (with hashes) and error. Viewer-level; artifact bytes
   * stay in CAS and are read via read_asset_chunk.
   */
  analysisSummary(projectId: string, assetId: string, principal: EditorPrincipal, expectedHash?: string) {
    this.authorize(projectId, principal, "viewer");
    const project = this.project(projectId, principal);
    const asset = project.assets.find((a) => a.assetId === assetId);
    if (!asset || (expectedHash !== undefined && asset.original.sha256 !== expectedHash))
      editorFailure("ASSET_NOT_FOUND", "Asset identity is not in the bound project");
    const latest = project.jobs
      .filter((j) => j.analysisAssetId === assetId)
      .sort((a, b) => (a.jobId < b.jobId ? 1 : -1))[0];
    if (!latest) editorFailure("ASSET_NOT_FOUND", "No analysis job exists for this asset");
    return {
      projectId,
      assetId,
      contentHash: asset.original.sha256,
      jobId: latest.jobId,
      state: latest.state,
      revision: latest.revision,
      analysisRate: latest.analysisRate ?? null,
      artifacts: latest.artifacts.map((a) => ({
        artifactId: a.artifactId,
        projectId: a.projectId,
        jobId: a.jobId,
        revision: a.revision,
        kind: a.kind,
        blob: a.blob,
      })),
      error: latest.error ? describeEditorError(latest.error) : null,
      note: "Metadata only; artifact bytes stay in CAS. Planner uses get_scene_cuts/get_waveform; clients use read_asset_chunk.",
    };
  }

  /**
   * Bounded, parsed view of a job's QA artifact for the planner: stream
   * summary, duration, loudness, recipe/plan hashes and gate statuses. The
   * full probe stays in CAS; only this summary crosses the worker boundary.
   */
  async qaSummary(projectId: string, jobId: string, principal: EditorPrincipal) {
    this.authorize(projectId, principal, "viewer");
    if (!this.cas) editorFailure("CAPABILITY_UNAVAILABLE", "The CAS reader is not bound to the store");
    const job = this.job(projectId, jobId, principal);
    const qa = job.artifacts.find((a) => a.kind === "qa");
    if (!qa) editorFailure("ASSET_NOT_FOUND", "The job has no QA artifact yet");
    const doc = JSON.parse((await this.cas.readBytes(qa.blob)).toString("utf8")) as {
      schemaVersion?: string;
      reportId?: string;
      subjectHash?: string;
      revision?: string;
      planHash?: string;
      ffmpegBuildHash?: string;
      renderRecipeHash?: string;
      audioLoudness?: { meanVolumeDb: string; maxVolumeDb: string } | null;
      gates?: Array<{ gate: string; status: string; checks?: Array<{ name: string; status: string }> }>;
      probe?: {
        format?: { duration?: string };
        streams?: Array<Record<string, unknown>>;
      };
    };
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
        codecType: s.codec_type,
        codecName: s.codec_name,
        width: s.width,
        height: s.height,
        sampleRate: s.sample_rate,
        channels: s.channels,
      })),
      gates: (doc.gates ?? []).map((g) => ({
        gate: g.gate,
        status: g.status,
        checks: (g.checks ?? []).map((c) => ({ name: c.name, status: c.status })),
      })),
    };
  }

  job(projectId: string, jobId: string, principal: EditorPrincipal): JobSnapshot {
    this.authorize(projectId, principal, "viewer");
    const row = this.database
      .prepare("SELECT document FROM jobs WHERE project_id = ? AND job_id = ?")
      .get(projectId, jobId) as { document: string } | undefined;
    if (!row) editorFailure("PROJECT_NOT_FOUND", "The job does not exist in this project");
    return JobSnapshotSchema.parse(JSON.parse(row.document));
  }

  private reviewedCandidate(approval: ApprovalRequest) {
    const job = this.job(approval.projectId, approval.subjectId, {
      principalId: "worker",
      role: "owner",
      projectIds: null,
    });
    const candidate = job.artifacts.find(
      (a) => a.kind === "candidate" && a.revision === approval.subjectRevision,
    );
    const qa = job.artifacts.find(
      (a) => a.kind === "qa" && a.revision === approval.subjectRevision,
    );
    const proxy = job.artifacts.find(a => a.kind === "proxy" && a.revision === approval.subjectRevision);
    const proxyInputs = approval.requiredInputs.filter(i => i.type === "review_proxy");
    const proxyMatches = proxy ? proxyInputs.length === 1 && proxyInputs[0]?.id === proxy.artifactId && proxyInputs[0]?.revision === proxy.revision && proxyInputs[0]?.hash === proxy.blob.sha256 : proxyInputs.length === 0;
    const expectedState =
      approval.purpose === "final" ? "awaiting_review" : "awaiting_delivery_approval";
    if (
      !proxyMatches || job.state !== expectedState ||
      !candidate ||
      !qa ||
      job.planHash !== approval.planHash ||
      candidate.blob.sha256 !== approval.subjectHash ||
      !approval.requiredInputs.some((i) => i.type === "qa" && i.hash === qa.blob.sha256)
    )
      editorFailure(
        "REVISION_CONFLICT",
        "The reviewed candidate or QA no longer matches this approval",
      );
    return { candidate, qa };
  }

  reviewedGeneration(job: JobSnapshot) {
    if (job.kind !== "final" || !job.approvalId) editorFailure("PERMISSION_DENIED","A final render grant is required");
    const approval = this.approval(job.approvalId);
    if (approval.projectId !== job.projectId || approval.purpose !== "final" || approval.planHash !== job.planHash)
      editorFailure("PERMISSION_DENIED","The generation preview is outside this grant");
    return this.reviewedCandidate(approval);
  }

  deliveryInputs(job: JobSnapshot) {
    if (job.kind !== "export" || !job.approvalId)
      editorFailure("PERMISSION_DENIED", "Delivery requires an export grant");
    const approval = this.approval(job.approvalId);
    if (
      approval.purpose !== "export" ||
      approval.projectId !== job.projectId ||
      approval.planHash !== job.planHash
    )
      editorFailure("PERMISSION_DENIED", "Invalid export subject");
    return this.reviewedCandidate(approval);
  }

  finalReviewProxy(projectId: string, artifactId: string, revision: string, principal: EditorPrincipal): ArtifactRef {
    this.authorize(projectId, principal, "operator");
    const job = this.job(projectId, artifactId.slice(0, -":review-proxy".length), principal);
    if (job.kind !== "final" || job.state !== "awaiting_delivery_approval")
      editorFailure("PERMISSION_DENIED", "Only a final candidate awaiting delivery approval can be reviewed");
    if (job.candidateRevision !== revision) editorFailure("REVISION_CONFLICT", "Review proxy revision mismatch");
    const proxy = job.artifacts.find(a => a.kind === "proxy" && a.jobId === job.jobId && a.projectId === projectId && a.revision === revision && a.artifactId === artifactId);
    if (!proxy) editorFailure("ASSET_NOT_FOUND", "No review proxy for this candidate");
    return proxy;
  }

  finishCandidate(job: JobSnapshot, candidate: ArtifactRef, qa: ArtifactRef, reviewProxy?: ArtifactRef): JobSnapshot {
    return this.atomic(() => {
      const plan = this.planForJob(job);
      const revision = job.candidateRevision;
      if (!revision) editorFailure("NEEDS_RECONCILIATION", "Candidate revision not allocated");
      const result = this.updateJob(
        job.projectId,
        job.jobId,
        (current) => {
          if (current.state !== JOB_START_STATE[job.kind])
            editorFailure("CANCELLED", "Job is no longer rendering");
          return {
            ...current,
            state: job.kind === "preview" ? "awaiting_review" : "awaiting_delivery_approval",
            phaseDetail: "Candidate ready for review",
            progress: { completedUnits: "1", totalUnits: "1" },
            artifacts: [
              { ...candidate, revision },
              { ...qa, revision },
              ...(reviewProxy ? [{ ...reviewProxy, revision }] : []),
            ],
          };
        },
        "qa.completed",
      );
      const purpose = job.kind === "preview" ? "final" : "export";
      const approval = ApprovalRequestSchema.parse({
        ...this.newApproval(plan, purpose),
        subjectType: purpose === "final" ? "candidate_revision" : "export",
        subjectId: job.jobId,
        subjectRevision: revision,
        subjectHash: candidate.blob.sha256,
        requiredInputs: [{ type: "qa", id: qa.artifactId, revision, hash: qa.blob.sha256 },
          ...(reviewProxy ? [{ type: "review_proxy", id: reviewProxy.artifactId, revision, hash: reviewProxy.blob.sha256 }] : [])],
      });
      this.insertApproval(approval);
      this.emit(job.projectId, "approval.requested", {
        approvalId: approval.approvalId,
        purpose,
        subjectHash: approval.subjectHash,
      });
      return result;
    });
  }

  finishDelivery(job: JobSnapshot, output: ArtifactRef, manifest: ArtifactRef): JobSnapshot {
    return this.atomic(() => {
      this.planForJob(job);
      const { candidate } = this.deliveryInputs(job);
      if (output.blob.sha256 !== candidate.blob.sha256)
        editorFailure("ARTIFACT_HASH_MISMATCH", "Final bytes differ from approval");
      return this.updateJob(
        job.projectId,
        job.jobId,
        (current) => {
          if (current.state !== "validating")
            editorFailure("CANCELLED", "Delivery is no longer active");
          return {
            ...current,
            state: "completed",
            phaseDetail: "Approved bytes available",
            progress: { completedUnits: "1", totalUnits: "1" },
            artifacts: [output, manifest],
          };
        },
        "export.completed",
      );
    });
  }

  private planForJob(job: JobSnapshot): AcceptedEditPlan {
    if (this.projectRow(job.projectId).revision !== job.revision || !job.approvalId)
      editorFailure("REVISION_CONFLICT", "The project changed during the job");
    return this.planForApproval(this.approval(job.approvalId));
  }

  private atomic<T>(write: () => T): T {
    this.begin();
    try {
      const result = write();
      this.commit();
      return result;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  updateJob(
    projectId: string,
    jobId: string,
    update: (job: JobSnapshot) => JobSnapshot,
    eventType = "job.state.changed",
  ): JobSnapshot {
    return this.atomic(() => {
      const current = this.job(projectId, jobId, {
        principalId: "worker",
        role: "owner",
        projectIds: null,
      });
      const next = JobSnapshotSchema.parse(update(current));
      this.database
        .prepare("UPDATE jobs SET document = ?, active = ? WHERE job_id = ?")
        .run(
          JSON.stringify(next),
          ["completed", "failed", "cancelled"].includes(next.state) ? 0 : 1,
          jobId,
        );
      this.emit(projectId, eventType, { jobId, state: next.state, phaseDetail: next.phaseDetail });
      return next;
    });
  }

  controlJob(input: {
    projectId: string;
    jobId: string;
    action: "cancel" | "pause" | "resume" | "retry";
    requestId: string;
    principal: EditorPrincipal;
  }, hasWorker: boolean): { job: JobSnapshot; applied: boolean } {
    this.authorize(input.projectId, input.principal, "operator");
    let applied = false;
    const receipt = this.mutate({
      projectId: input.projectId,
      requestId: input.requestId,
      // Worker presence is runtime state, not part of the caller's idempotency key.
      payload: input,
      execute: () =>
        this.updateJob(input.projectId, input.jobId, (job) => {
          applied = true;
          if (input.action === "cancel") {
            if (["completed", "failed", "cancelled"].includes(job.state))
              editorFailure("INVALID_ARGUMENT", "The job is already finished");
            if (!hasWorker) return { ...job, state: "cancelled", phaseDetail: "cancelled without an active worker" };
            return { ...job, state: "cancel_requested", phaseDetail: "cancel requested" };
          }
          if (input.action === "pause") {
            if (
              !["rendering_preview", "rendering_final", "validating", "analyzing"].includes(
                job.state,
              )
            )
              editorFailure("INVALID_ARGUMENT", "Only an active job can be paused");
            if (!hasWorker) return { ...job, state: "paused", phaseDetail: "paused without an active worker" };
            return { ...job, state: "pausing", phaseDetail: "waiting for a safe checkpoint" };
          }
          if (input.action === "resume") {
            if (job.state !== "paused")
              editorFailure("INVALID_ARGUMENT", "The job is not paused");
            return {
              ...job,
              state: JOB_START_STATE[job.kind],
              phaseDetail: "queued",
            };
          }
          if (job.state !== "failed")
            editorFailure("INVALID_ARGUMENT", "Only a failed job can be retried");
          return {
            ...job,
            state: JOB_START_STATE[job.kind],
            phaseDetail: "retry queued",
            error: undefined,
          };
        }),
    });
    return { job: receipt, applied };
  }

  events(projectId: string, afterSeq: string, principal: EditorPrincipal) {
    this.authorize(projectId, principal, "viewer");
    const documents = this.rows(
      "SELECT document FROM events WHERE project_id = ? AND CAST(seq AS INTEGER) > ? ORDER BY CAST(seq AS INTEGER)",
      projectId,
      afterSeq,
    );
    return {
      events: documents.map((document) => EditorEventSchema.parse(JSON.parse(document))),
      snapshotRequired: false,
    };
  }

  registerPrincipal(projectId: string, principal: EditorPrincipal): void {
    this.authorize(projectId, { principalId: "owner", role: "owner", projectIds: null }, "owner");
    this.grant(projectId, principal.principalId, principal.role);
  }

  authorizeProject(projectId: string, principal: EditorPrincipal, required: EditorRole): void {
    this.authorize(projectId, principal, required);
  }

  /** Persist a daemon-side lifecycle/agent event; seq is assigned by the store. */
  recordExternalEvent(
    projectId: string,
    type: string,
    payload: unknown,
    principal: EditorPrincipal,
  ): void {
    this.authorize(projectId, principal, "viewer");
    this.emit(projectId, type, payload);
  }

  /** Reserve the persistent receipt and first event atomically, before spawning a worker. */
  reservePlanningRun(projectId: string, requestId: string, prompt: string, principal: EditorPrincipal) {
    this.authorize(projectId, principal, "operator");
    let created = false;
    const receipt = this.mutate({ projectId, requestId, payload: { method: "start_planning_run", prompt, principalId: principal.principalId }, execute: () => {
      const runId = randomUUID();
      const sessionId = randomUUID();
      const result = { projectId, runId, sessionId, state: "running" as const };
      this.emit(projectId, "run.running", { runId, sessionId, principalId: principal.principalId });
      created = true;
      return result;
    } });
    return { receipt, created };
  }

  projectsWithPlanningEvents(): string[] {
    return this.rows("SELECT DISTINCT project_id FROM events WHERE json_extract(document, '$.type') LIKE 'run.%'");
  }

  runLifecycle(projectId: string, principal: EditorPrincipal) {
    return this.planningStatuses(projectId, principal).map(({ runId, state }) => ({ runId, state }));
  }

  planningRunStatus(projectId: string, runId: string, principal: EditorPrincipal): PlanningRunStatus {
    const [status] = this.planningStatuses(projectId, principal, runId);
    if (!status) editorFailure("NOT_FOUND", "No such planning run");
    return status;
  }

  /** Reconstruct daemon states only; tool or progress events are not state transitions. */
  private planningStatuses(projectId: string, principal: EditorPrincipal, runId?: string): PlanningRunStatus[] {
    this.authorize(projectId, principal, "viewer");
    const documents = this.rows(
      `SELECT document FROM events WHERE project_id = ?
       AND json_extract(document, '$.type') IN ('run.started','run.running','run.awaiting_input','run.settled','run.interrupted','run.failed')
       ${runId === undefined ? "" : "AND json_extract(document, '$.payload.runId') = ?"}
       ORDER BY CAST(seq AS INTEGER)`,
      projectId, ...(runId === undefined ? [] : [runId]),
    );
    const statuses = new Map<string, PlanningRunStatus>();
    for (const document of documents) {
      const event = EditorEventSchema.parse(JSON.parse(document));
      const payload = event.payload as { runId?: string; sessionId?: string } | undefined;
      if (!payload?.runId) continue;
      const sessionId = statuses.get(payload.runId)?.sessionId ?? payload.sessionId;
      statuses.set(payload.runId, PlanningRunStatusSchema.parse({
        projectId, runId: payload.runId, sessionId,
        state: event.type === "run.started" ? "running" : event.type.slice(4),
      }));
    }
    return [...statuses.values()];
  }

  private mutate<Input, Output>(input: {
    projectId: string;
    requestId: string;
    payload: Input;
    execute: (projectId: string) => Output;
    allocateProjectId?: boolean;
  }): Output {
    const fingerprint = sha256Json(input.payload);
    this.begin();
    try {
      const projectId = input.projectId;
      const existing = this.database
        .prepare(
          "SELECT fingerprint, response FROM mutations WHERE project_id = ? AND request_id = ?",
        )
        .get(projectId, input.requestId) as { fingerprint: string; response: string } | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          editorFailure(
            "IDEMPOTENCY_CONFLICT",
            "The request identifier was used with different content",
          );
        this.commit();
        return JSON.parse(existing.response) as Output;
      }
      const output = input.execute(projectId);
      this.database
        .prepare(
          "INSERT INTO mutations(project_id, request_id, fingerprint, response, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(projectId, input.requestId, fingerprint, JSON.stringify(output), this.now());
      this.commit();
      return output;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  private begin(): void {
    if (this.transactionDepth++ === 0) this.database.exec("BEGIN IMMEDIATE");
  }

  private commit(): void {
    if (--this.transactionDepth === 0) this.database.exec("COMMIT");
  }

  private rollback(): void {
    if (--this.transactionDepth === 0) this.database.exec("ROLLBACK");
  }

  private validatePlan(draft: EditPlanDraftV1): void {
    const project = this.projectRow(draft.projectId);
    if (
      project.revision !== draft.baseTimelineRevision ||
      project.asset_manifest_hash !== draft.baseAssetManifestHash
    ) {
      editorFailure("REVISION_CONFLICT", "The plan was built against an older project snapshot");
    }
    const assets = new Map(
      this.rows("SELECT document FROM assets WHERE project_id = ?", draft.projectId).map(
        (document) => {
          const asset = SourceAssetSchema.parse(JSON.parse(document));
          return [asset.assetId, asset] as const;
        },
      ),
    );
    // Invalid times are semantic errors, independent of the selected render profile.
    for (const operation of draft.trimOperations) {
      this.validateRange(operation.sourceRange);
      this.validateRange(operation.recordRange);
    }
    assertRenderablePreview(draft);
    for (const operation of draft.trimOperations) {
      const asset = assets.get(operation.source.assetId);
      if (!asset || asset.original.sha256 !== operation.source.assetContentHash)
        editorFailure("PLAN_SEMANTIC_INVALID", "The trim refers to a missing or changed asset");
      if (
        !asset.streams.some(
          (stream) => stream.streamUid === operation.source.streamUid && stream.kind === "video",
        )
      )
        editorFailure("PLAN_SEMANTIC_INVALID", "The trim must select an existing video stream");
      // CFR sources quantize to whole frames; misaligned durations would fail
      // the exact candidate duration check after render.
      const videoStream = asset.streams.find(
        (stream) => stream.streamUid === operation.source.streamUid && stream.kind === "video",
      );
      if (videoStream?.averageRate && this.hasConstantRate(asset.presentationIndex.sha256, videoStream.streamUid)) {
        const rate = videoStream.averageRate;
        const dur = operation.recordRange.duration;
        if ((BigInt(dur.num) * BigInt(rate.num)) % (BigInt(dur.den) * BigInt(rate.den)) !== 0n)
          editorFailure("PLAN_SEMANTIC_INVALID", "Segment duration must align to whole frames");
      }
    }
    const trimByClip = new Map(draft.trimOperations.map((op) => [op.clipId, op]));
    for (const tr of draft.transitionOperations) {
      const left = trimByClip.get(tr.leftClipId);
      const asset = left && assets.get(left.source.assetId);
      const videoStream =
        asset && left
          ? asset.streams.find(
              (stream) => stream.streamUid === left.source.streamUid && stream.kind === "video",
            )
          : undefined;
      if (videoStream?.averageRate) {
        const rate = videoStream.averageRate;
        if (
          (BigInt(tr.duration.num) * BigInt(rate.num)) %
            (BigInt(tr.duration.den) * BigInt(rate.den)) !==
          0n
        )
          editorFailure("PLAN_SEMANTIC_INVALID", "Transition duration must align to whole frames");
      }
    }
    for (const kind of ["audio", "video"] as const) {
      const operations =
        kind === "audio" ? draft.audioOperations : draft.transformOperations;
      for (const operation of operations) {
        const asset = assets.get(operation.source.assetId);
        if (!asset || asset.original.sha256 !== operation.source.assetContentHash)
          editorFailure("PLAN_SEMANTIC_INVALID", "The operation refers to a missing or changed asset");
        if (
          !asset.streams.some(
            (stream) => stream.streamUid === operation.source.streamUid && stream.kind === kind,
          )
        )
          editorFailure("PLAN_SEMANTIC_INVALID", "The operation must select an existing stream");
        this.validateRange(operation.sourceRange);
        this.validateRange(operation.recordRange);
      }
    }
  }

  private validateRange(range: {
    start: { num: string; den: string };
    duration: { num: string; den: string };
  }): void {
    if (
      range.start.num.startsWith("-") ||
      range.duration.num.startsWith("-") ||
      range.duration.num === "0" ||
      range.start.den === "0" ||
      range.duration.den === "0"
    ) {
      editorFailure(
        "PLAN_SEMANTIC_INVALID",
        "Edit ranges must be non-empty, non-negative and rational",
      );
    }
  }

  private newApproval(
    plan: AcceptedEditPlan,
    purpose: "preview" | "final" | "export",
  ): ApprovalRequest {
    return ApprovalRequestSchema.parse({
      approvalId: randomUUID(),
      projectId: plan.projectId,
      subjectType: "edit_plan",
      subjectId: plan.planId,
      subjectRevision: plan.revision,
      subjectHash: plan.planHash,
      planHash: plan.planHash,
      baseTimelineRevision: plan.baseTimelineRevision,
      purpose,
      requiredInputs: plan.generationRequests.map(g => ({type:"mask_approval", id:g.maskApprovalId!, hash:g.referenceManifestHash, revision:plan.baseTimelineRevision})),
      diffSummary: {
        intent: plan.intent,
        operationCount:
          plan.trimOperations.length +
          plan.transformOperations.length +
          plan.audioOperations.length +
          plan.transitionOperations.length +
          plan.subtitleOperations.length +
          plan.generationRequests.length,
        summary: `${plan.deterministicBackendId} · ${plan.trimOperations.length}段/${plan.transitionOperations.length}转场/${plan.transformOperations.length}变换/${plan.audioOperations.length}音频/${plan.subtitleOperations.length}字幕 · ${plan.intent.slice(0, 200)}`,
      },
      generationCostCapMicros: plan.maxCostMicros,
      externalDestinations: plan.externalDestinations,
      status: "pending",
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
  }

  private insertApproval(approval: ApprovalRequest, grant?: ApprovalGrant): void {
    this.database
      .prepare(
        "INSERT INTO approvals(approval_id, project_id, plan_hash, purpose, request, grant, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        approval.approvalId,
        approval.projectId,
        approval.planHash ?? approval.subjectHash,
        approval.purpose,
        JSON.stringify(approval),
        grant ? JSON.stringify(grant) : null,
        this.now(),
      );
  }

  private updateApproval(approval: ApprovalRequest, grant?: ApprovalGrant): void {
    this.database
      .prepare("UPDATE approvals SET request = ?, grant = ? WHERE approval_id = ?")
      .run(JSON.stringify(approval), grant ? JSON.stringify(grant) : null, approval.approvalId);
  }

  private storedApproval(approvalId: string): StoredApproval {
    const row = this.database
      .prepare("SELECT request, grant FROM approvals WHERE approval_id = ?")
      .get(approvalId) as { request: string; grant: string | null } | undefined;
    if (!row) editorFailure("PROJECT_NOT_FOUND", "The approval does not exist");
    return {
      request: ApprovalRequestSchema.parse(JSON.parse(row.request)),
      grant: row.grant ? ApprovalGrantSchema.parse(JSON.parse(row.grant)) : undefined,
    };
  }

  private approval(approvalId: string): ApprovalRequest {
    return this.storedApproval(approvalId).request;
  }

  private planForApproval(approval: ApprovalRequest): AcceptedEditPlan {
    const row = this.database
      .prepare("SELECT document FROM plans WHERE project_id = ? AND plan_hash = ?")
      .get(approval.projectId, approval.planHash) as { document: string } | undefined;
    if (!row) editorFailure("PROJECT_NOT_FOUND", "The approved plan does not exist");
    return AcceptedEditPlanSchema.parse(JSON.parse(row.document));
  }

  private planResult(planId: string): { plan: AcceptedEditPlan; approval: ApprovalRequest } {
    const plan = AcceptedEditPlanSchema.parse(
      JSON.parse(this.rows("SELECT document FROM plans WHERE plan_id = ?", planId)[0]!),
    );
    const row = this.database
      .prepare(
        "SELECT request FROM approvals WHERE plan_hash = ? AND purpose = 'preview' ORDER BY created_at LIMIT 1",
      )
      .get(plan.planHash) as { request: string } | undefined;
    if (!row) throw new EditorError("INTERNAL", "A stored plan has no approval");
    return { plan, approval: ApprovalRequestSchema.parse(JSON.parse(row.request)) };
  }

  private emit(projectId: string, type: string, payload: unknown): void {
    const seq = (BigInt(this.latestSeq(projectId)) + 1n).toString();
    const event = EditorEventSchema.parse({
      protocolVersion: "1",
      projectId,
      eventId: randomUUID(),
      ...(type.startsWith("run.") && payload && typeof payload === "object" && "runId" in payload
        ? { runId: payload.runId } : {}),
      seq,
      occurredAt: this.now(),
      type,
      payload,
    });
    const document = JSON.stringify(event);
    this.database
      .prepare("INSERT INTO events(project_id, seq, document) VALUES (?, ?, ?)")
      .run(projectId, seq, document);
    this.database
      .prepare("INSERT INTO outbox(event_id, project_id, seq, document) VALUES (?, ?, ?, ?)")
      .run(event.eventId, projectId, seq, document);
  }

  private latestSeq(projectId: string): string {
    const row = this.database
      .prepare("SELECT MAX(CAST(seq AS INTEGER)) AS seq FROM events WHERE project_id = ?")
      .get(projectId) as { seq: number | null };
    return (row.seq ?? 0).toString();
  }

  private projectRow(projectId: string): ProjectRow {
    const row = this.database
      .prepare(
        "SELECT project_id, title, revision, asset_manifest_hash FROM projects WHERE project_id = ?",
      )
      .get(projectId) as ProjectRow | undefined;
    if (!row) editorFailure("PROJECT_NOT_FOUND", "The project does not exist");
    return row;
  }

  private assetManifest(projectId: string): Array<{ assetId: string; sha256: string }> {
    return this.rows("SELECT document FROM assets WHERE project_id = ?", projectId).map(
      (document) => {
        const asset = SourceAssetSchema.parse(JSON.parse(document));
        return { assetId: asset.assetId, sha256: asset.original.sha256 };
      },
    );
  }

  private grant(projectId: string, principalId: string, role: EditorRole): void {
    this.database
      .prepare(
        "INSERT INTO project_grants(project_id, principal_id, role) VALUES (?, ?, ?) ON CONFLICT(project_id, principal_id) DO UPDATE SET role = excluded.role",
      )
      .run(projectId, principalId, role);
  }

  private authorize(projectId: string, principal: EditorPrincipal, required: EditorRole): void {
    if (principal.projectIds !== null && !principal.projectIds.includes(projectId))
      editorFailure("PERMISSION_DENIED", "The credential has no access to this project");
    this.requireRole(principal, required);
    if (principal.role !== "owner") {
      const row = this.database
        .prepare("SELECT role FROM project_grants WHERE project_id = ? AND principal_id = ?")
        .get(projectId, principal.principalId) as { role: EditorRole } | undefined;
      if (!row) editorFailure("PERMISSION_DENIED", "The device has no grant for this project");
      this.requireRole({ ...principal, role: row.role }, required);
    }
    this.projectRow(projectId);
  }

  private recoverJobs(): void {
    const rows = this.rows("SELECT document FROM jobs WHERE active = 1");
    for (const document of rows) {
      const job = JobSnapshotSchema.parse(JSON.parse(document));
      if (
        ![
          "rendering_preview",
          "rendering_final",
          "validating",
          "analyzing",
          "pausing",
          "cancel_requested",
        ].includes(job.state)
      )
        continue;
      const recovered = {
        ...job,
        state: "failed" as const,
        phaseDetail: "interrupted by daemon restart",
        error: {
          code: "NEEDS_RECONCILIATION",
          retryable: true,
          sanitizedDetail: "The previous worker was interrupted; review and retry the job",
        },
      };
      this.database
        .prepare("UPDATE jobs SET document = ?, active = 0 WHERE job_id = ?")
        .run(JSON.stringify(recovered), job.jobId);
      // Recovery bypasses updateJob's worker path, so emit the terminal event explicitly:
      // remote viewers/operators reconciling via get_events must see the restart failure,
      // not a job stuck forever in its last rendering state.
      this.emit(job.projectId, "job.state.changed", {
        jobId: job.jobId,
        state: recovered.state,
        phaseDetail: recovered.phaseDetail,
      });
    }
  }

  private rows(sql: string, ...params: string[]): string[] {
    const statement = this.database.prepare(sql);
    const rows = statement.all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => Object.values(row)[0] as string);
  }

  private now(): string {
    return new Date().toISOString();
  }
}
