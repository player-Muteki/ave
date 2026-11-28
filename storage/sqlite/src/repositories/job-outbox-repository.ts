import { randomUUID } from "node:crypto";
import {
  ApprovalRequestSchema,
  EditorEventSchema,
  JobSnapshotSchema,
  PlanningRunStatusSchema,
  TrackMaskRequestSchema,
  describeEditorError,
  editorFailure,
  type ApprovalRequest,
  type ArtifactRef,
  type EditorEvent,
  type EditorPrincipal,
  type JobSnapshot,
  type ModelRef,
  type ModelStage,
  type PlanningRunStatus,
  type TrackMaskRequest,
} from "@ave/contracts";
import { clampAnalysisRate, sha256Json } from "@ave/domain";
import { sha256File } from "@ave/cas";
import type { TransactionCoordinator } from "../coordinator.js";
import type { DeviceGrantRepository } from "./device-grant-repository.js";
import type { ProjectAssetRevisionRepository } from "./project-asset-repository.js";
import type { PlanApprovalRepository } from "./plan-approval-repository.js";
import type { ObjectEditRepository } from "./object-edit-repository.js";

export interface CreateJobInput {
  requestId: string;
  projectId: string;
  approvalId: string;
  grantId: string;
  expectedRevision: string;
  model?: ModelRef;
  principal: EditorPrincipal;
}

export interface JobResult {
  job: JobSnapshot;
  deduplicated: boolean;
}

export const JOB_START_STATE = {
  analysis: "analyzing",
  preview: "rendering_preview",
  final: "rendering_final",
  export: "validating",
} as const;

export class JobOutboxRepository {
  private objectEdits?: ObjectEditRepository;

  constructor(
    private readonly tx: TransactionCoordinator,
    private readonly grants: DeviceGrantRepository,
    private readonly projects: ProjectAssetRevisionRepository,
    private readonly plans: PlanApprovalRepository,
  ) {}

  bindObjectEdits(objectEdits: ObjectEditRepository): void {
    this.objectEdits = objectEdits;
  }

  private requireObjectEdits(): ObjectEditRepository {
    if (!this.objectEdits) editorFailure("INTERNAL", "ObjectEditRepository is not bound");
    return this.objectEdits;
  }

  getJob(projectId: string, jobId: string, principal: EditorPrincipal): JobSnapshot {
    this.grants.authorizeProject(projectId, principal, "viewer");
    const row = this.tx.db
      .prepare("SELECT document FROM jobs WHERE project_id = ? AND job_id = ?")
      .get(projectId, jobId) as { document: string } | undefined;
    if (!row) editorFailure("PROJECT_NOT_FOUND", "The job does not exist in this project");
    return JobSnapshotSchema.parse(JSON.parse(row.document));
  }

  createJob(input: CreateJobInput): JobResult {
    this.grants.authorizeProject(input.projectId, input.principal, "operator");
    return this.tx.mutate({
      projectId: input.projectId,
      requestId: input.requestId,
      payload: input,
      execute: () => {
        const approval = this.plans.approval(input.approvalId);
        const stored = this.plans.storedApproval(input.approvalId);
        const grant = stored.grant;
        if (!grant || grant.grantId !== input.grantId) {
          editorFailure("PERMISSION_DENIED", "The grant does not belong to this approval");
        }
        if (grant.consumedAt) {
          editorFailure("APPROVAL_CONSUMED", "The grant has already been consumed");
        }
        if (grant.revokedReason) {
          editorFailure("PERMISSION_DENIED", "The grant has been revoked");
        }
        if (Date.parse(grant.expiresAt) <= Date.now()) {
          editorFailure("APPROVAL_EXPIRED", "The grant has expired");
        }
        if (
          approval.projectId !== input.projectId ||
          grant.baseTimelineRevision !== input.expectedRevision
        ) {
          editorFailure("REVISION_CONFLICT", "The grant is not valid for this project revision");
        }
        const project = this.grants.requireProjectRow(input.projectId);
        if (project.revision !== input.expectedRevision) {
          editorFailure("REVISION_CONFLICT", "The project changed after approval");
        }
        const plan = this.plans.planForApproval(approval);
        if (plan.planHash !== grant.planHash || plan.revision !== grant.baseTimelineRevision) {
          editorFailure("REVISION_CONFLICT", "The approved plan is no longer current");
        }
        if (grant.purpose !== approval.purpose || grant.subjectHash !== approval.subjectHash) {
          editorFailure("PERMISSION_DENIED", "Grant subject mismatch");
        }
        if (grant.purpose !== "preview") this.reviewedCandidate(approval);
        if (input.model) {
          const stage: ModelStage = plan.generationRequests.length
            ? "inpainting"
            : grant.purpose === "export"
              ? "qa"
              : "planning";
          if (
            !this.plans.modelAllowed(
              input.projectId,
              stage,
              { provider: input.model.provider, id: input.model.id },
              input.principal,
            )
          ) {
            editorFailure(
              "PERMISSION_DENIED",
              `Model ${input.model.provider}/${input.model.id} is not admitted for stage "${stage}" by any enabled policy`,
            );
          }
        }
        const state = JOB_START_STATE[grant.purpose];
        const existing = this.tx.db
          .prepare(
            "SELECT job_id, document FROM jobs WHERE project_id = ? AND plan_hash = ? AND revision = ? AND kind = ? AND active = 1",
          )
          .get(input.projectId, plan.planHash, plan.revision, grant.purpose) as
          | { job_id: string; document: string }
          | undefined;
        if (existing) {
          return {
            job: JobSnapshotSchema.parse(JSON.parse(existing.document)),
            deduplicated: true,
          };
        }
        const job = JobSnapshotSchema.parse({
          jobId: randomUUID(),
          projectId: input.projectId,
          revision: plan.revision,
          planHash: plan.planHash,
          approvalId: approval.approvalId,
          candidateRevision: (BigInt(this.tx.latestSeq(input.projectId)) + 1n).toString(),
          parentRevision: approval.subjectRevision,
          kind: grant.purpose,
          state,
          phaseDetail: "queued",
          progress: { completedUnits: "0" },
          artifacts: [],
          model: input.model ? { provider: input.model.provider, id: input.model.id } : undefined,
        });
        this.tx.db
          .prepare(
            "INSERT INTO jobs(job_id, project_id, plan_hash, revision, kind, document, active) VALUES (?, ?, ?, ?, ?, ?, 1)",
          )
          .run(job.jobId, job.projectId, job.planHash, job.revision, job.kind, JSON.stringify(job));
        this.plans.updateApproval(approval, { ...grant, consumedAt: this.tx.now() });
        this.tx.emit(input.projectId, "job.state.changed", { jobId: job.jobId, state: job.state });
        return { job, deduplicated: false };
      },
    });
  }

  createTrackingJob(request: TrackMaskRequest, principal: EditorPrincipal) {
    const revision = this.requireObjectEdits().approvedTrackingAnchor(request, principal);
    return this.createAnalysisJob({
      projectId: request.projectId,
      requestId: request.requestId,
      assetId: revision.anchor.assetId,
      principal,
      tracking: request,
    });
  }

  createAnalysisJob(input: {
    requestId: string;
    projectId: string;
    assetId: string;
    rate?: string;
    tracking?: TrackMaskRequest;
    objectTask?: JobSnapshot["objectTask"];
    model?: ModelRef;
    principal: EditorPrincipal;
  }): JobResult {
    this.grants.authorizeProject(input.projectId, input.principal, "operator");
    if (
      input.model &&
      !input.tracking &&
      !this.plans.modelAllowed(
        input.projectId,
        "detection",
        { provider: input.model.provider, id: input.model.id },
        input.principal,
      )
    ) {
      editorFailure(
        "PERMISSION_DENIED",
        `Model ${input.model.provider}/${input.model.id} is not admitted for stage "detection" by any enabled policy`,
      );
    }
    return this.tx.mutate({
      projectId: input.projectId,
      requestId: input.requestId,
      payload: input,
      execute: () => {
        const project = this.projects.getProjectSnapshot(input.projectId, {
          principalId: "owner",
          role: "owner",
          projectIds: null,
        });
        const asset = project.assets.find((a) => a.assetId === input.assetId);
        if (!asset) editorFailure("ASSET_NOT_FOUND", "The asset is not in this project");
        const rate = clampAnalysisRate(input.rate);
        const track = input.tracking;
        const planHash = track
          ? sha256Json([
              "track",
              track.anchorApprovalId,
              track.anchorHash,
              track.expectedRevision,
              track.firstFrame,
              track.frameCount,
            ])
          : input.objectTask
            ? sha256Json(["object", input.objectTask, input.requestId])
            : sha256Json(["analysis", input.assetId, asset.original.sha256, rate]);
        const existing = this.tx.db
          .prepare(
            "SELECT document FROM jobs WHERE project_id = ? AND plan_hash = ? AND kind = 'analysis' AND active = 1",
          )
          .get(input.projectId, planHash) as { document: string } | undefined;
        if (existing) {
          return { job: JobSnapshotSchema.parse(JSON.parse(existing.document)), deduplicated: true };
        }
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
          objectTask: input.objectTask,
          trackingAnchorId: track?.anchorApprovalId,
          analysisAssetId: track || input.objectTask ? undefined : input.assetId,
          analysisRate: track || input.objectTask ? undefined : rate,
          model: !track && input.model ? { provider: input.model.provider, id: input.model.id } : undefined,
        });
        this.tx.db
          .prepare(
            "INSERT INTO jobs(job_id, project_id, plan_hash, revision, kind, document, active) VALUES (?, ?, ?, ?, ?, ?, 1)",
          )
          .run(job.jobId, job.projectId, planHash, job.revision, job.kind, JSON.stringify(job));
        if (track) {
          this.tx.db
            .prepare("INSERT INTO mask_tracking_jobs(job_id, project_id, request) VALUES (?, ?, ?)")
            .run(job.jobId, job.projectId, JSON.stringify(track));
        }
        this.tx.emit(input.projectId, "job.state.changed", { jobId: job.jobId, state: job.state });
        return { job, deduplicated: false };
      },
    });
  }

  trackingRequest(projectId: string, jobId: string) {
    const row = this.tx.db
      .prepare("SELECT request FROM mask_tracking_jobs WHERE project_id = ? AND job_id = ?")
      .get(projectId, jobId) as { request: string } | undefined;
    return row && TrackMaskRequestSchema.parse(JSON.parse(row.request));
  }

  reviewedCandidate(approval: ApprovalRequest) {
    const job = this.getJob(approval.projectId, approval.subjectId, {
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
    const proxy = job.artifacts.find(
      (a) => a.kind === "proxy" && a.revision === approval.subjectRevision,
    );
    const proxyInputs = approval.requiredInputs.filter((i) => i.type === "review_proxy");
    const proxyMatches = proxy
      ? proxyInputs.length === 1 &&
        proxyInputs[0]?.id === proxy.artifactId &&
        proxyInputs[0]?.revision === proxy.revision &&
        proxyInputs[0]?.hash === proxy.blob.sha256
      : proxyInputs.length === 0;
    const expectedState =
      approval.purpose === "final" ? "awaiting_review" : "awaiting_delivery_approval";
    if (
      !proxyMatches ||
      job.state !== expectedState ||
      !candidate ||
      !qa ||
      job.planHash !== approval.planHash ||
      candidate.blob.sha256 !== approval.subjectHash ||
      !approval.requiredInputs.some((i) => i.type === "qa" && i.hash === qa.blob.sha256)
    ) {
      editorFailure(
        "REVISION_CONFLICT",
        "The reviewed candidate or QA no longer matches this approval",
      );
    }
    return { candidate, qa };
  }

  deliveryInputs(job: JobSnapshot) {
    if (job.kind !== "export" || !job.approvalId) {
      editorFailure("PERMISSION_DENIED", "Delivery requires an export grant");
    }
    const approval = this.plans.approval(job.approvalId);
    if (
      approval.purpose !== "export" ||
      approval.projectId !== job.projectId ||
      approval.planHash !== job.planHash
    ) {
      editorFailure("PERMISSION_DENIED", "Invalid export subject");
    }
    return this.reviewedCandidate(approval);
  }

  finishCandidate(
    job: JobSnapshot,
    candidate: ArtifactRef,
    qa: ArtifactRef,
    reviewProxy?: ArtifactRef,
  ): JobSnapshot {
    return this.tx.runInTransaction(() => {
      const plan = this.planForJob(job);
      const revision = job.candidateRevision;
      if (!revision) editorFailure("NEEDS_RECONCILIATION", "Candidate revision not allocated");
      const result = this.updateJob(
        job.projectId,
        job.jobId,
        (current) => {
          if (current.state !== JOB_START_STATE[job.kind]) {
            editorFailure("CANCELLED", "Job is no longer rendering");
          }
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
        ...this.plans.newApproval(plan, purpose),
        subjectType: purpose === "final" ? "candidate_revision" : "export",
        subjectId: job.jobId,
        subjectRevision: revision,
        subjectHash: candidate.blob.sha256,
        requiredInputs: [
          { type: "qa", id: qa.artifactId, revision, hash: qa.blob.sha256 },
          ...(reviewProxy
            ? [{ type: "review_proxy", id: reviewProxy.artifactId, revision, hash: reviewProxy.blob.sha256 }]
            : []),
        ],
      });
      this.plans.insertApproval(approval);
      this.tx.emit(job.projectId, "approval.requested", {
        approvalId: approval.approvalId,
        purpose,
        subjectHash: approval.subjectHash,
      });
      return result;
    });
  }

  finishDelivery(job: JobSnapshot, output: ArtifactRef, manifest: ArtifactRef): JobSnapshot {
    return this.tx.runInTransaction(() => {
      this.planForJob(job);
      const { candidate } = this.deliveryInputs(job);
      if (output.blob.sha256 !== candidate.blob.sha256) {
        editorFailure("ARTIFACT_HASH_MISMATCH", "Final bytes differ from approval");
      }
      return this.updateJob(
        job.projectId,
        job.jobId,
        (current) => {
          if (current.state !== "validating") {
            editorFailure("CANCELLED", "Delivery is no longer active");
          }
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

  private planForJob(job: JobSnapshot) {
    if (this.grants.requireProjectRow(job.projectId).revision !== job.revision || !job.approvalId) {
      editorFailure("REVISION_CONFLICT", "The project changed during the job");
    }
    return this.plans.planForApproval(this.plans.approval(job.approvalId));
  }

  updateJob(
    projectId: string,
    jobId: string,
    update: (job: JobSnapshot) => JobSnapshot,
    eventType = "job.state.changed",
  ): JobSnapshot {
    return this.tx.runInTransaction(() => {
      const current = this.getJob(projectId, jobId, {
        principalId: "worker",
        role: "owner",
        projectIds: null,
      });
      const next = JobSnapshotSchema.parse(update(current));
      this.tx.db
        .prepare("UPDATE jobs SET document = ?, active = ? WHERE job_id = ?")
        .run(
          JSON.stringify(next),
          ["completed", "failed", "cancelled"].includes(next.state) ? 0 : 1,
          jobId,
        );
      if (next.objectTask) this.requireObjectEdits().onWorkerState(next);
      this.tx.emit(projectId, eventType, {
        jobId,
        state: next.state,
        phaseDetail: next.phaseDetail,
      });
      return next;
    });
  }

  controlJob(
    input: {
      projectId: string;
      jobId: string;
      action: "cancel" | "pause" | "resume" | "retry";
      requestId: string;
      principal: EditorPrincipal;
    },
    hasWorker: boolean,
  ): { job: JobSnapshot; applied: boolean } {
    this.grants.authorizeProject(input.projectId, input.principal, "operator");
    let applied = false;
    const receipt = this.tx.mutate({
      projectId: input.projectId,
      requestId: input.requestId,
      payload: input,
      execute: () =>
        this.updateJob(input.projectId, input.jobId, (job) => {
          applied = true;
          if (input.action === "cancel") {
            if (["completed", "failed", "cancelled"].includes(job.state)) {
              editorFailure("INVALID_ARGUMENT", "The job is already finished");
            }
            if (!hasWorker) {
              return { ...job, state: "cancelled", phaseDetail: "cancelled without an active worker" };
            }
            return { ...job, state: "cancel_requested", phaseDetail: "cancel requested" };
          }
          if (input.action === "pause") {
            if (
              !["rendering_preview", "rendering_final", "validating", "analyzing"].includes(
                job.state,
              )
            ) {
              editorFailure("INVALID_ARGUMENT", "Only an active job can be paused");
            }
            if (!hasWorker) {
              return { ...job, state: "paused", phaseDetail: "paused without an active worker" };
            }
            return { ...job, state: "pausing", phaseDetail: "waiting for a safe checkpoint" };
          }
          if (input.action === "resume") {
            if (job.state !== "paused") editorFailure("INVALID_ARGUMENT", "The job is not paused");
            return { ...job, state: JOB_START_STATE[job.kind], phaseDetail: "queued" };
          }
          if (job.state !== "failed") {
            editorFailure("INVALID_ARGUMENT", "Only a failed job can be retried");
          }
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

  artifact(
    projectId: string,
    artifactId: string,
    revision: string,
    principal: EditorPrincipal,
  ): ArtifactRef {
    this.grants.authorizeProject(projectId, principal, "viewer");
    const jobs = this.tx
      .rows("SELECT document FROM jobs WHERE project_id = ?", projectId)
      .map((document) => JobSnapshotSchema.parse(JSON.parse(document)));
    const artifact = jobs.flatMap((j) => j.artifacts).find((a) => a.artifactId === artifactId);
    if (!artifact) editorFailure("ASSET_NOT_FOUND", "The artifact does not exist in this project");
    if (artifact.revision !== revision) {
      editorFailure("REVISION_CONFLICT", "The artifact belongs to an older revision");
    }
    if (artifact.kind === "export" || artifact.kind === "manifest") {
      this.grants.authorizeProject(projectId, principal, "operator");
    }
    return artifact;
  }

  listArtifacts(projectId: string, jobId: string, principal: EditorPrincipal) {
    this.grants.authorizeProject(projectId, principal, "viewer");
    const job = this.getJob(projectId, jobId, principal);
    return {
      projectId,
      jobId: job.jobId,
      kind: job.kind,
      state: job.state,
      revision: job.revision,
      artifactCount: job.artifacts.length,
      artifacts: job.artifacts.slice(0, 256).map((a) => ({
        artifactId: a.artifactId,
        jobId: a.jobId,
        revision: a.revision,
        kind: a.kind,
        sizeBytes: a.blob.bytes,
        sha256: a.blob.sha256,
        mediaType: a.blob.mediaType,
      })),
    };
  }

  reviewablePreview(
    projectId: string,
    jobId: string,
    principal: EditorPrincipal,
    revision?: string,
  ): ArtifactRef {
    const job = this.getJob(projectId, jobId, principal);
    if (job.kind !== "preview" || job.state !== "awaiting_review") {
      editorFailure("PERMISSION_DENIED", "Only a reviewable preview may be read on this route");
    }
    if (revision !== undefined && job.candidateRevision !== revision) {
      editorFailure("REVISION_CONFLICT", "The preview belongs to another candidate revision");
    }
    const artifact = job.artifacts.find(
      (a) =>
        a.artifactId === `${jobId}:candidate` &&
        a.kind === "candidate" &&
        a.jobId === jobId &&
        a.projectId === projectId &&
        a.revision === job.candidateRevision,
    );
    if (!artifact) editorFailure("ASSET_NOT_FOUND", "No reviewed preview bytes for this revision");
    return artifact;
  }

  async verifyExport(projectId: string, jobId: string, principal: EditorPrincipal) {
    this.grants.authorizeProject(projectId, principal, "operator");
    const cas = this.tx.requireCas();
    const job = this.getJob(projectId, jobId, principal);
    if (job.kind !== "export") editorFailure("INVALID_ARGUMENT", "The job is not an export");
    const manifest = job.artifacts.find((a) => a.kind === "manifest");
    const output = job.artifacts.find((a) => a.kind === "export");
    if (!manifest || !output) {
      editorFailure("ASSET_NOT_FOUND", "The export job has no manifest/export artifact yet");
    }
    const doc = JSON.parse((await cas.readBytes(manifest.blob)).toString("utf8")) as {
      output?: { sha256?: string };
      renderRecipeHash?: string | null;
      planHash?: string;
    };
    const expected = doc.output?.sha256;
    if (!expected) {
      editorFailure("ARTIFACT_HASH_MISMATCH", "The manifest does not record an output hash");
    }
    const actual = await sha256File(cas.pathFor(output.blob));
    const verified = actual === expected && actual === output.blob.sha256;
    return {
      jobId,
      state: job.state,
      verified,
      outputSha256: actual,
      manifestSha256: manifest.blob.sha256,
      renderRecipeHash: doc.renderRecipeHash ?? null,
      planHash: doc.planHash ?? null,
      detail: verified
        ? "delivered bytes match the manifest output hash"
        : "delivered bytes differ from the manifest output hash",
    };
  }

  analysisSummary(
    projectId: string,
    assetId: string,
    principal: EditorPrincipal,
    expectedHash?: string,
  ) {
    this.grants.authorizeProject(projectId, principal, "viewer");
    const project = this.projects.getProjectSnapshot(projectId, principal);
    const asset = project.assets.find((a) => a.assetId === assetId);
    if (!asset || (expectedHash !== undefined && asset.original.sha256 !== expectedHash)) {
      editorFailure("ASSET_NOT_FOUND", "Asset identity is not in the bound project");
    }
    const jobs = project.jobs
      .filter((j) => j.analysisAssetId === assetId)
      .sort((a, b) => (a.jobId < b.jobId ? 1 : -1));
    const latest = jobs.find((j) => j.state === "completed" && j.artifacts.length > 0) ?? jobs[0];
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

  getEvents(projectId: string, afterSeq: string, principal: EditorPrincipal) {
    this.grants.authorizeProject(projectId, principal, "viewer");
    const documents = this.tx.rows(
      "SELECT document FROM events WHERE project_id = ? AND CAST(seq AS INTEGER) > ? ORDER BY CAST(seq AS INTEGER) LIMIT 500",
      projectId,
      afterSeq,
    );
    return {
      events: documents.map((document) => EditorEventSchema.parse(JSON.parse(document))),
      snapshotRequired: false,
    };
  }

  getOutboxPending(projectId: string): EditorEvent[] {
    return this.tx
      .rows(
        "SELECT document FROM outbox WHERE project_id = ? ORDER BY CAST(seq AS INTEGER) LIMIT 500",
        projectId,
      )
      .map((document) => EditorEventSchema.parse(JSON.parse(document)));
  }

  ackOutbox(eventIds: readonly string[]): number {
    if (eventIds.length === 0) return 0;
    return this.tx.runInTransaction(() => {
      let deleted = 0;
      const stmt = this.tx.db.prepare("DELETE FROM outbox WHERE event_id = ?");
      for (const id of eventIds) {
        deleted += Number(stmt.run(id).changes);
      }
      return deleted;
    });
  }

  recentPlanningHistory(projectId: string, principal: EditorPrincipal, providerScope: string) {
    this.grants.authorizeProject(projectId, principal, "operator");
    const rows = this.tx.db.prepare(
      `SELECT prompt, reply FROM planning_history
       WHERE project_id = ? AND principal_id = ? AND provider_scope = ?
       ORDER BY seq DESC LIMIT 8`,
    ).all(projectId, principal.principalId, providerScope) as Array<{ prompt: string; reply: string }>;
    return rows.reverse();
  }

  recordSettledPlanningTurn(
    projectId: string,
    principal: EditorPrincipal,
    providerScope: string,
    prompt: string,
    result: { runId: string; sessionId: string; detail?: string; planId?: string; planHash?: string },
  ) {
    this.grants.authorizeProject(projectId, principal, "operator");
    const scope = [projectId, principal.principalId, providerScope];
    this.tx.runInTransaction(() => {
      const saved = this.tx.db.prepare(
        `INSERT INTO planning_history(project_id, principal_id, provider_scope, run_id, prompt, reply)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(run_id) DO NOTHING`,
      ).run(...scope, result.runId, prompt.slice(0, 2000), result.detail ?? "");
      if (!saved.changes) return;
      this.tx.db.prepare(
        `DELETE FROM planning_history WHERE seq IN (
           SELECT seq FROM planning_history WHERE project_id = ? AND principal_id = ? AND provider_scope = ?
           ORDER BY seq DESC LIMIT -1 OFFSET 8
         )`,
      ).run(...scope);
      this.tx.emit(projectId, "run.settled", result);
    });
  }

  recordExternalEvent(
    projectId: string,
    type: string,
    payload: unknown,
    principal: EditorPrincipal,
  ): void {
    this.grants.authorizeProject(projectId, principal, "viewer");
    this.tx.emit(projectId, type, payload);
  }

  recordPlannerEvent(
    run: { projectId: string; runId: string; sessionId: string },
    event: EditorEvent,
    principal: EditorPrincipal,
  ): void {
    this.grants.authorizeProject(run.projectId, principal, "viewer");
    if (
      event.projectId !== run.projectId ||
      event.sessionId !== run.sessionId ||
      event.runId !== run.runId ||
      !event.type.startsWith("agent.")
    ) {
      return;
    }
    this.tx.emit(
      run.projectId,
      event.type,
      { ...(event.payload as object), runId: run.runId, workerEventId: event.eventId },
      { runId: run.runId, sessionId: run.sessionId, causationId: event.causationId },
    );
  }

  reservePlanningRun(
    projectId: string,
    requestId: string,
    prompt: string,
    principal: EditorPrincipal,
    model?: { provider: string; id: string },
  ) {
    this.grants.authorizeProject(projectId, principal, "operator");
    if (model && !this.plans.modelAllowed(projectId, "planning", model, principal)) {
      editorFailure(
        "PERMISSION_DENIED",
        `Model ${model.provider}/${model.id} is not admitted for stage "planning" by any enabled policy`,
      );
    }
    let created = false;
    const receipt = this.tx.mutate({
      projectId,
      requestId,
      payload: {
        method: "start_planning_run",
        prompt,
        principalId: principal.principalId,
        ...(model ? { model } : {}),
      },
      execute: () => {
        const runId = randomUUID();
        const sessionId = randomUUID();
        const result = { projectId, runId, sessionId, state: "running" as const };
        this.tx.emit(projectId, "run.running", {
          runId,
          sessionId,
          principalId: principal.principalId,
        });
        created = true;
        return result;
      },
    });
    return { receipt, created };
  }

  projectsWithPlanningEvents(): string[] {
    return this.tx.rows(
      "SELECT DISTINCT project_id FROM events WHERE json_extract(document, '$.type') LIKE 'run.%'",
    );
  }

  runLifecycle(projectId: string, principal: EditorPrincipal) {
    return this.planningStatuses(projectId, principal).map(({ runId, state }) => ({
      runId,
      state,
    }));
  }

  planningRunStatus(
    projectId: string,
    runId: string,
    principal: EditorPrincipal,
  ): PlanningRunStatus {
    const [status] = this.planningStatuses(projectId, principal, runId);
    if (!status) editorFailure("NOT_FOUND", "No such planning run");
    return status;
  }

  private planningStatuses(
    projectId: string,
    principal: EditorPrincipal,
    runId?: string,
  ): PlanningRunStatus[] {
    this.grants.authorizeProject(projectId, principal, "viewer");
    const documents = this.tx.rows(
      `SELECT document FROM events WHERE project_id = ?
       AND json_extract(document, '$.type') IN ('run.started','run.running','run.awaiting_input','run.settled','run.interrupted','run.failed')
       ${runId === undefined ? "" : "AND json_extract(document, '$.payload.runId') = ?"}
       ORDER BY CAST(seq AS INTEGER)`,
      projectId,
      ...(runId === undefined ? [] : [runId]),
    );
    const statuses = new Map<string, PlanningRunStatus>();
    for (const document of documents) {
      const event = EditorEventSchema.parse(JSON.parse(document));
      const payload = event.payload as { runId?: string; sessionId?: string } | undefined;
      if (!payload?.runId) continue;
      const sessionId = statuses.get(payload.runId)?.sessionId ?? payload.sessionId;
      statuses.set(
        payload.runId,
        PlanningRunStatusSchema.parse({
          projectId,
          runId: payload.runId,
          sessionId,
          state: event.type === "run.started" ? "running" : event.type.slice(4),
        }),
      );
    }
    return [...statuses.values()];
  }

  runEvents(
    projectId: string,
    runId: string,
    afterSeq: string,
    principal: EditorPrincipal,
  ) {
    this.grants.authorizeProject(projectId, principal, "viewer");
    const documents = this.tx.rows(
      `SELECT document FROM events
       WHERE project_id = ? AND (
         json_extract(document, '$.runId') = ? OR
         (json_extract(document, '$.type') LIKE 'run.%' AND json_extract(document, '$.payload.runId') = ?)
       ) AND CAST(seq AS INTEGER) > CAST(? AS INTEGER)
       ORDER BY CAST(seq AS INTEGER) LIMIT 200`,
      projectId,
      runId,
      runId,
      afterSeq,
    );
    const events = documents.map((document) => EditorEventSchema.parse(JSON.parse(document)));
    return { events, snapshotRequired: false, latestSeq: events.at(-1)?.seq ?? afterSeq };
  }

  runQuestions(projectId: string, runId: string, principal: EditorPrincipal) {
    this.grants.authorizeProject(projectId, principal, "viewer");
    const documents = this.tx.rows(
      `SELECT document FROM events
       WHERE project_id = ? AND json_extract(document, '$.runId') = ?
         AND json_extract(document, '$.type') = 'run.question'
       ORDER BY CAST(seq AS INTEGER) DESC LIMIT 64`,
      projectId,
      runId,
    );
    return documents
      .map((document) => EditorEventSchema.parse(JSON.parse(document)))
      .map((event) => {
        const payload = (event.payload ?? {}) as {
          questionId?: string;
          text?: string;
          choices?: unknown;
        };
        return {
          eventId: event.eventId,
          seq: event.seq,
          runId: event.runId ?? runId,
          questionId: typeof payload.questionId === "string" ? payload.questionId : event.eventId,
          text: typeof payload.text === "string" ? payload.text : "",
          choices: Array.isArray(payload.choices)
            ? payload.choices.filter((c): c is string => typeof c === "string").slice(0, 8)
            : [],
        };
      })
      .filter((q) => q.text.length > 0);
  }

  answerRunQuestion(
    input: {
      requestId: string;
      projectId: string;
      runId: string;
      questionId: string;
      answer: string;
    },
    principal: EditorPrincipal,
  ) {
    return this.tx.mutate({
      projectId: input.projectId,
      requestId: input.requestId,
      payload: input,
      execute: (projectId) => {
        this.grants.authorizeProject(projectId, principal, "operator");
        this.tx.emit(
          projectId,
          "run.answer",
          { questionId: input.questionId, answer: input.answer },
          { runId: input.runId },
        );
        return { ...input, recorded: true };
      },
    });
  }

  recoverJobs(): JobSnapshot[] {
    const recoveredList: JobSnapshot[] = [];
    const rows = this.tx.rows("SELECT document FROM jobs WHERE active = 1");
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
      ) {
        continue;
      }
      const recovered: JobSnapshot = {
        ...job,
        state: "failed",
        phaseDetail: "interrupted by daemon restart",
        error: {
          code: "NEEDS_RECONCILIATION",
          retryable: true,
          sanitizedDetail: "The previous worker was interrupted; review and retry the job",
        },
      };
      this.updateJob(job.projectId, job.jobId, () => recovered);
      recoveredList.push(recovered);
    }
    return recoveredList;
  }

  reconcileInterruptedPlanningRuns(principal: EditorPrincipal): string[] {
    const interrupted: string[] = [];
    for (const projectId of this.projectsWithPlanningEvents()) {
      for (const entry of this.runLifecycle(projectId, principal)) {
        if (entry.state === "running" || entry.state === "awaiting_input") {
          this.recordExternalEvent(
            projectId,
            "run.interrupted",
            {
              runId: entry.runId,
              reason: "daemon restarted; planning runs are never blindly replayed",
            },
            principal,
          );
          interrupted.push(entry.runId);
        }
      }
    }
    return interrupted;
  }
}
