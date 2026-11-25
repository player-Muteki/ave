import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { SqliteDatabase } from "./sqlite-types.js";
import { DatabaseSync } from "./sqlite.js";
import { assertRenderablePreview } from "./preview-profile.js";
import { sha256Json } from "./cas.js";
import {
  AcceptedEditPlanSchema,
  ApprovalGrantSchema,
  ApprovalRequestSchema,
  EditorEventSchema,
  JobSnapshotSchema,
  ProjectSnapshotSchema,
  SourceAssetSchema,
  type ArtifactRef,
  type AcceptedEditPlan,
  type ApprovalDecision,
  type ApprovalGrant,
  type ApprovalRequest,
  type EditPlanDraftV1,
  type EditorPrincipal,
  type EditorRole,
  type JobSnapshot,
  type ProjectSnapshot,
  type SourceAsset,
} from "#video-editor/contracts/v1";
import { EditorError, editorFailure } from "./errors.js";

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
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(job_id), document TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  project_id TEXT NOT NULL, seq TEXT NOT NULL, document TEXT NOT NULL,
  PRIMARY KEY(project_id, seq)
);
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
`;

export class EditorStore {
  private readonly database: SqliteDatabase;
  private transactionDepth = 0;

  static async create(root: string): Promise<EditorStore> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    return new EditorStore(root);
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
  ): SourceAsset | undefined {
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
    return SourceAssetSchema.parse(JSON.parse(receipt.response));
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

  validateProposal(draft: EditPlanDraftV1, principal: EditorPrincipal): void {
    this.authorize(draft.projectId, principal, "operator");
    this.validatePlan(draft);
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
          this.emit(approval.projectId, "approval.decided", {
            approvalId: current.approvalId,
            decision: "rejected",
          });
          return { approval: rejected };
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

  /** Read-only analysis job: no approval/grant, operator-or-above, deduplicated per asset+hash. */
  createAnalysisJob(input: {
    requestId: string;
    projectId: string;
    assetId: string;
    rate?: string;
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
        const planHash = sha256Json(["analysis", input.assetId, asset.original.sha256, rate]);
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
          analysisAssetId: input.assetId,
          analysisRate: rate,
        });
        this.database
          .prepare(
            "INSERT INTO jobs(job_id, project_id, plan_hash, revision, kind, document, active) VALUES (?, ?, ?, ?, ?, ?, 1)",
          )
          .run(job.jobId, job.projectId, planHash, job.revision, job.kind, JSON.stringify(job));
        this.emit(input.projectId, "job.state.changed", { jobId: job.jobId, state: job.state });
        return { job, deduplicated: false };
      },
    });
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

  /** Latest lifecycle state per planning run, derived from the persisted event log. */
  runLifecycle(
    projectId: string,
    principal: EditorPrincipal,
  ): Array<{ runId: string; state: string }> {
    this.authorize(projectId, principal, "viewer");
    const documents = this.rows(
      "SELECT document FROM events WHERE project_id = ? AND json_extract(document, '$.type') LIKE 'run.%' ORDER BY CAST(seq AS INTEGER)",
      projectId,
    );
    const states = new Map<string, string>();
    for (const document of documents) {
      const event = EditorEventSchema.parse(JSON.parse(document));
      const runId = (event.payload as { runId?: string } | undefined)?.runId;
      if (runId) states.set(runId, event.type.slice("run.".length));
    }
    return [...states.entries()].map(([runId, state]) => ({ runId, state }));
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
      this.validateRange(operation.sourceRange);
      this.validateRange(operation.recordRange);
      // CFR sources quantize to whole frames; misaligned durations would fail
      // the exact candidate duration check after render.
      const videoStream = asset.streams.find(
        (stream) => stream.streamUid === operation.source.streamUid && stream.kind === "video",
      );
      if (videoStream?.averageRate) {
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
      requiredInputs: [],
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
