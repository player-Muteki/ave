import { randomUUID } from "node:crypto";
import {
  ApprovalRequestSchema,
  MaskAnchorRevisionSchema,
  ObjectEditWorkflowSchema,
  SourceAssetSchema,
  TrackedMaskManifestSchema,
  editorFailure,
  type ApprovalRequest,
  type ArtifactRef,
  type BlobRef,
  type CreateMaskRevisionRequest,
  type EditorPrincipal,
  type InspectFrameHeader,
  type JobSnapshot,
  type MaskAnchorRevision,
  type ObjectCandidate,
  type ObjectDecision,
  type ObjectEditWorkflow,
  type ObjectQaReport,
  type RequestTrackedMaskReview,
  type SourceAsset,
  type TimeRange,
  type TrackMaskRequest,
} from "@ave/contracts";
import {
  assertObjectEditTransition,
  candidateManifestHash,
  evaluateObjectQa,
  parseCandidates,
  parseDecisions,
  parseObjectQa,
  parseSourceRange,
  removalTargets,
  sha256Json,
} from "@ave/domain";
import type { TransactionCoordinator } from "../coordinator.js";
import type { DeviceGrantRepository } from "./device-grant-repository.js";
import type { ProjectAssetRevisionRepository } from "./project-asset-repository.js";
import type { PlanApprovalRepository } from "./plan-approval-repository.js";
import type { JobOutboxRepository } from "./job-outbox-repository.js";

export interface TrackedMaskReviewInputs {
  tracking: TrackMaskRequest;
  anchor: MaskAnchorRevision;
  manifest: ArtifactRef;
  proxy: ArtifactRef;
}

export class ObjectEditRepository {
  constructor(
    private readonly tx: TransactionCoordinator,
    private readonly grants: DeviceGrantRepository,
    private readonly projects: ProjectAssetRevisionRepository,
    private readonly plans: PlanApprovalRepository,
    private readonly jobs: JobOutboxRepository,
  ) {}

  private sourceAsset(projectId: string, assetId: string): SourceAsset {
    const row = this.tx.db
      .prepare("SELECT document FROM assets WHERE project_id = ? AND asset_id = ?")
      .get(projectId, assetId) as { document: string } | undefined;
    if (!row) editorFailure("ASSET_NOT_FOUND", "The source asset does not exist in this project");
    return SourceAssetSchema.parse(JSON.parse(row.document));
  }

  private objectEditRow(projectId: string, workflowId: string): ObjectEditWorkflow {
    const row = this.tx.db
      .prepare("SELECT document FROM object_edits WHERE project_id = ? AND workflow_id = ?")
      .get(projectId, workflowId) as { document: string } | undefined;
    if (!row) editorFailure("NOT_FOUND", "The object edit workflow does not exist");
    return ObjectEditWorkflowSchema.parse(JSON.parse(row.document));
  }

  private saveObjectEdit(workflow: ObjectEditWorkflow): void {
    this.tx.db
      .prepare("UPDATE object_edits SET document = ? WHERE project_id = ? AND workflow_id = ?")
      .run(JSON.stringify(workflow), workflow.projectId, workflow.workflowId);
  }

  private scheduleWorker(workflow: ObjectEditWorkflow, stage: "detect" | "mask", actor: EditorPrincipal): ObjectEditWorkflow {
    const { job } = this.jobs.createAnalysisJob({
      requestId: sha256Json([workflow.workflowId, workflow.workflowRevision, stage]),
      projectId: workflow.projectId, assetId: workflow.assetId, principal: actor,
      objectTask: { workflowId: workflow.workflowId, stage },
    });
    return { ...workflow, workerJobId: job.jobId, error: undefined };
  }

  onWorkerState(job: JobSnapshot): void {
    const task = job.objectTask!;
    const workflow = this.objectEditRow(job.projectId, task.workflowId);
    if (workflow.workerJobId !== job.jobId) return;
    const failed = job.state === "failed" || job.state === "cancelled";
    const retry = job.state === "analyzing" && workflow.state === "failed";
    if (!failed && !retry) return;
    this.saveObjectEdit({ ...workflow,
      state: failed ? "failed" : task.stage === "detect" ? "analyzing" : "awaiting_mask_review",
      error: failed ? job.error ?? { code: "CANCELLED", retryable: true, sanitizedDetail: "Object analysis cancelled" } : undefined,
      workflowRevision: String(BigInt(workflow.workflowRevision) + 1n),
    });
  }

  finishWorker(job: JobSnapshot, principal: EditorPrincipal, result:
    | { candidates: ObjectCandidate[]; sourceFrames: NonNullable<ObjectEditWorkflow["sourceFrames"]> }
    | { request: CreateMaskRevisionRequest; header: InspectFrameHeader; label: BlobRef; image: BlobRef; sourceFrames: NonNullable<ObjectEditWorkflow["sourceFrames"]> }
  ): void {
    this.tx.runInTransaction(() => {
      const wf = this.objectEditRow(job.projectId, job.objectTask!.workflowId);
      const current = this.jobs.getJob(job.projectId, job.jobId, principal);
      if (current.state !== "analyzing" || wf.workerJobId !== job.jobId) {
        editorFailure("CANCELLED", "Object task has been superseded or stopped");
      }
      this.projects.getAsset(job.projectId, wf.assetId, wf.baseTimelineRevision, principal);
      const next = { ...wf, workflowRevision: String(BigInt(wf.workflowRevision) + 1n), sourceFrames: result.sourceFrames };
      if ("candidates" in result) {
        const candidates = result.candidates.length ? parseCandidates(result.candidates) : [];
        this.saveObjectEdit({ ...next, candidates, candidateManifestHash: candidateManifestHash(candidates),
          state: candidates.length ? "awaiting_target_selection" : "completed" });
      } else {
        const approval = this.saveMaskRevision(result.request, result.header, result.label, result.image, principal);
        this.saveObjectEdit({ ...next, state: "awaiting_mask_review", anchorFrame: result.header.frame,
          maskRevisionId: approval.subjectId, maskApprovalId: approval.approvalId });
      }
      this.jobs.updateJob(job.projectId, job.jobId, latest => ({ ...latest, state: "completed",
        phaseDetail: "Object analysis complete", progress: { completedUnits: "1", totalUnits: "1" } }));
    });
  }

  openObjectEdit(input: {
    requestId: string;
    projectId: string;
    assetId: string;
    expectedRevision: string;
    sourceRange: TimeRange;
    actor: EditorPrincipal;
  }): ObjectEditWorkflow {
    this.grants.authorizeProject(input.projectId, input.actor, "operator");
    const sourceRange = parseSourceRange(input.sourceRange);
    return this.tx.mutate({
      projectId: input.projectId,
      requestId: input.requestId,
      payload: { assetId: input.assetId, expectedRevision: input.expectedRevision, sourceRange },
      execute: () => {
        const project = this.grants.requireProjectRow(input.projectId);
        if (project.revision !== input.expectedRevision) {
          editorFailure(
            "REVISION_CONFLICT",
            "The object edit was opened against an older project snapshot",
          );
        }
        const asset = this.sourceAsset(input.projectId, input.assetId);
        const workflow = this.scheduleWorker({
          workflowId: `object-edit-${sha256Json({ projectId: input.projectId, requestId: input.requestId }).slice(0, 32)}`,
          projectId: input.projectId,
          assetId: asset.assetId,
          assetContentHash: asset.original.sha256,
          sourceRange,
          baseTimelineRevision: project.revision,
          candidateManifestHash: candidateManifestHash([]),
          candidates: [],
          decisions: [],
          state: "analyzing",
          workflowRevision: "0",
          createdAt: this.tx.now(),
        }, "detect", input.actor);
        this.tx.db
          .prepare(
            "INSERT INTO object_edits(workflow_id, project_id, asset_id, document) VALUES (?, ?, ?, ?)",
          )
          .run(workflow.workflowId, workflow.projectId, workflow.assetId, JSON.stringify(workflow));
        return workflow;
      },
    });
  }

  recordObjectCandidates(input: {
    requestId: string;
    projectId: string;
    workflowId: string;
    expectedWorkflowRevision: string;
    candidates: ObjectCandidate[];
    actor: EditorPrincipal;
  }): ObjectEditWorkflow {
    this.grants.authorizeProject(input.projectId, input.actor, "owner");
    return this.tx.mutate({
      projectId: input.projectId,
      requestId: input.requestId,
      payload: {
        workflowId: input.workflowId,
        expectedWorkflowRevision: input.expectedWorkflowRevision,
        candidates: input.candidates,
      },
      execute: () => {
        const workflow = this.objectEditRow(input.projectId, input.workflowId);
        if (workflow.workflowRevision !== input.expectedWorkflowRevision) {
          editorFailure(
            "REVISION_CONFLICT",
            "The object edit moved on; reload before recording candidates",
          );
        }
        if (workflow.state !== "analyzing") {
          editorFailure("WORKFLOW_STATE", "Candidates can only be recorded while analyzing");
        }
        assertObjectEditTransition(workflow.state, "awaiting_target_selection");
        const candidates = parseCandidates(input.candidates);
        const next: ObjectEditWorkflow = {
          ...workflow,
          workerJobId: undefined,
          candidates,
          candidateManifestHash: candidateManifestHash(candidates),
          state: "awaiting_target_selection",
          workflowRevision: (BigInt(workflow.workflowRevision) + 1n).toString(),
        };
        this.saveObjectEdit(next);
        return next;
      },
    });
  }

  decideObjectTarget(input: {
    requestId: string;
    projectId: string;
    workflowId: string;
    expectedWorkflowRevision: string;
    decisions: ObjectDecision[];
    actor: EditorPrincipal;
  }): ObjectEditWorkflow {
    this.grants.authorizeProject(input.projectId, input.actor, "operator");
    return this.tx.mutate({
      projectId: input.projectId,
      requestId: input.requestId,
      payload: {
        workflowId: input.workflowId,
        expectedWorkflowRevision: input.expectedWorkflowRevision,
        decisions: input.decisions,
      },
      execute: () => {
        const workflow = this.objectEditRow(input.projectId, input.workflowId);
        if (workflow.workflowRevision !== input.expectedWorkflowRevision) {
          editorFailure("REVISION_CONFLICT", "The object edit moved on; reload before deciding");
        }
        if (workflow.state !== "awaiting_target_selection") {
          editorFailure("WORKFLOW_STATE", "This object edit is not waiting for a target decision");
        }
        const project = this.grants.requireProjectRow(input.projectId);
        const asset = this.sourceAsset(input.projectId, workflow.assetId);
        if (
          project.revision !== workflow.baseTimelineRevision ||
          asset.original.sha256 !== workflow.assetContentHash
        ) {
          editorFailure(
            "REVISION_CONFLICT",
            "The recorded target is stale: the asset or timeline changed, reopen the object edit",
          );
        }
        const decisions = parseDecisions(input.decisions, workflow.candidates);
        const targets = removalTargets(workflow.candidates, decisions);
        const targetState = targets.length > 0 ? "awaiting_mask_review" : "completed";
        assertObjectEditTransition(workflow.state, targetState);
        const next: ObjectEditWorkflow = {
          ...workflow,
          decisions,
          state: targetState,
          workflowRevision: (BigInt(workflow.workflowRevision) + 1n).toString(),
        };
        const result = targets.length ? this.scheduleWorker(next, "mask", input.actor) : next;
        this.saveObjectEdit(result);
        return result;
      },
    });
  }

  listObjectEdits(
    projectId: string,
    assetId: string | undefined,
    principal: EditorPrincipal,
  ): ObjectEditWorkflow[] {
    this.grants.authorizeProject(projectId, principal, "viewer");
    const rows = (
      assetId === undefined
        ? this.tx.rows("SELECT document FROM object_edits WHERE project_id = ?", projectId)
        : this.tx.rows(
            "SELECT document FROM object_edits WHERE project_id = ? AND asset_id = ?",
            projectId,
            assetId,
          )
    ).map((document) => ObjectEditWorkflowSchema.parse(JSON.parse(document)));
    return rows.sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));
  }

  getObjectEdit(
    projectId: string,
    workflowId: string,
    principal: EditorPrincipal,
  ): ObjectEditWorkflow {
    this.grants.authorizeProject(projectId, principal, "viewer");
    return this.objectEditRow(projectId, workflowId);
  }

  objectEditGenerationGuard(projectId: string, workflowId: string): ObjectEditWorkflow {
    const workflow = this.objectEditRow(projectId, workflowId);
    if (workflow.state !== "awaiting_generation_review") {
      editorFailure("WORKFLOW_STATE", "Generation requires a reviewed object mask");
    }
    if (removalTargets(workflow.candidates, workflow.decisions).length === 0) {
      editorFailure("WORKFLOW_STATE", "No removal target was selected");
    }
    return workflow;
  }

  reviewObjectMask(input: {
    requestId: string;
    projectId: string;
    workflowId: string;
    expectedWorkflowRevision: string;
    maskRevisionId: string;
    approved: boolean;
    actor: EditorPrincipal;
  }): ObjectEditWorkflow {
    this.grants.authorizeProject(input.projectId, input.actor, "operator");
    return this.tx.mutate({
      projectId: input.projectId,
      requestId: input.requestId,
      payload: {
        workflowId: input.workflowId,
        expectedWorkflowRevision: input.expectedWorkflowRevision,
        maskRevisionId: input.maskRevisionId,
        approved: input.approved,
      },
      execute: () => {
        const workflow = this.objectEditRow(input.projectId, input.workflowId);
        if (workflow.workflowRevision !== input.expectedWorkflowRevision) {
          editorFailure("REVISION_CONFLICT", "The object edit moved on; reload before reviewing");
        }
        if (workflow.state !== "awaiting_mask_review") {
          editorFailure("WORKFLOW_STATE", "This object edit is not waiting for a mask review");
        }
        if (workflow.maskRevisionId !== input.maskRevisionId || !workflow.maskApprovalId || !workflow.sourceFrames) {
          editorFailure("INVALID_ARGUMENT", "This workflow has no matching generated mask to review");
        }
        const approval = this.plans.getApproval(workflow.projectId, workflow.maskApprovalId, input.actor);
        const mask = this.maskInput(approval, input.actor);
        const asset = this.projects.getAsset(workflow.projectId, workflow.assetId, workflow.baseTimelineRevision, input.actor);
        const span = workflow.sourceFrames;
        if (mask.kind !== "anchor" || approval.subjectId !== workflow.maskRevisionId ||
            mask.revision.baseTimelineRevision !== workflow.baseTimelineRevision ||
            mask.revision.anchor.assetId !== asset.assetId || mask.revision.anchor.sourceSha256 !== workflow.assetContentHash ||
            mask.revision.anchor.sourcePresentationIndexHash !== asset.presentationIndex.sha256 ||
            mask.revision.anchor.streamUid !== span.streamUid || mask.revision.anchor.frame !== workflow.anchorFrame ||
            workflow.anchorFrame < span.firstFrame || workflow.anchorFrame >= span.firstFrame + span.frameCount) {
          editorFailure("REVISION_CONFLICT", "The reviewed anchor belongs to a different source, frame or revision");
        }
        this.plans.decideApproval({ requestId: sha256Json([input.requestId, "anchor-decision"]),
          approvalId: approval.approvalId, expectedRevision: workflow.baseTimelineRevision,
          decision: input.approved ? "approve" : "reject" }, input.actor);
        const next: ObjectEditWorkflow = { ...workflow, state: input.approved ? "awaiting_generation_review" : "awaiting_mask_review",
          workflowRevision: String(BigInt(workflow.workflowRevision) + 1n) };
        const result = input.approved ? next : this.scheduleWorker({ ...next, maskRevisionId: undefined, maskApprovalId: undefined }, "mask", input.actor);
        this.saveObjectEdit(result);
        return result;
      },
    });
  }

  recordObjectQa(input: {
    requestId: string;
    projectId: string;
    workflowId: string;
    expectedWorkflowRevision: string;
    qa: ObjectQaReport;
    actor: EditorPrincipal;
  }): ObjectEditWorkflow {
    this.grants.authorizeProject(input.projectId, input.actor, "owner");
    return this.tx.mutate({
      projectId: input.projectId,
      requestId: input.requestId,
      payload: {
        workflowId: input.workflowId,
        expectedWorkflowRevision: input.expectedWorkflowRevision,
        qa: input.qa,
      },
      execute: () => {
        const workflow = this.objectEditRow(input.projectId, input.workflowId);
        if (workflow.workflowRevision !== input.expectedWorkflowRevision) {
          editorFailure("REVISION_CONFLICT", "The object edit moved on; reload before recording QA");
        }
        if (workflow.state !== "awaiting_generation_review") {
          editorFailure("WORKFLOW_STATE", "This object edit is not waiting for removal QA");
        }
        const qa = parseObjectQa(input.qa);
        const verdict = evaluateObjectQa(qa);
        const nextState = verdict.passed ? "completed" : "failed";
        assertObjectEditTransition(workflow.state, nextState);
        const next: ObjectEditWorkflow = {
          ...workflow,
          qa,
          state: nextState,
          workflowRevision: (BigInt(workflow.workflowRevision) + 1n).toString(),
        };
        this.saveObjectEdit(next);
        return next;
      },
    });
  }

  savedMaskApproval(request: CreateMaskRevisionRequest, principal: EditorPrincipal) {
    this.grants.authorizeProject(request.anchor.projectId, principal, "operator");
    const row = this.tx.db
      .prepare(
        "SELECT approval_id, request_hash FROM mask_anchors WHERE project_id = ? AND request_id = ?",
      )
      .get(request.anchor.projectId, request.requestId) as
      | { approval_id: string; request_hash: string }
      | undefined;
    if (!row) return undefined;
    if (row.request_hash !== sha256Json(request)) {
      editorFailure("IDEMPOTENCY_CONFLICT", "Mask save request changed");
    }
    return this.plans.approval(row.approval_id);
  }

  getMaskRevision(projectId: string, id: string, principal: EditorPrincipal) {
    this.grants.authorizeProject(projectId, principal, "viewer");
    const row = this.tx.db
      .prepare(
        "SELECT document FROM mask_anchors WHERE project_id = ? AND mask_revision_id = ?",
      )
      .get(projectId, id) as { document: string } | undefined;
    if (!row) editorFailure("ASSET_NOT_FOUND", "Unknown mask revision in this project");
    return MaskAnchorRevisionSchema.parse(JSON.parse(row.document));
  }

  saveMaskRevision(
    request: CreateMaskRevisionRequest,
    anchor: InspectFrameHeader,
    rawLabelMask: BlobRef,
    reviewImage: BlobRef,
    principal: EditorPrincipal,
  ): ApprovalRequest {
    const projectId = request.anchor.projectId;
    this.grants.authorizeProject(projectId, principal, "operator");
    return this.tx.mutate({
      projectId,
      requestId: request.requestId,
      payload: request,
      execute: () => {
        const asset = this.projects.getAsset(
          projectId,
          anchor.assetId,
          request.expectedRevision,
          principal,
        );
        const stream = asset.streams.find((s) => s.streamUid === anchor.streamUid);
        if (
          !stream ||
          asset.original.sha256 !== anchor.sourceSha256 ||
          asset.presentationIndex.sha256 !== anchor.sourcePresentationIndexHash
        ) {
          editorFailure("REVISION_CONFLICT", "Mask inputs changed");
        }
        const revision = MaskAnchorRevisionSchema.parse({
          schemaVersion: "video.mask-anchor/v1",
          maskRevisionId: randomUUID(),
          projectId,
          baseTimelineRevision: request.expectedRevision,
          anchor,
          rotation: stream.rotation ?? "0",
          sampleAspectRatio: stream.sampleAspectRatio ?? "unknown",
          rawLabelMask,
          reviewImage,
        });
        const approval = ApprovalRequestSchema.parse({
          approvalId: randomUUID(),
          projectId,
          subjectType: "mask_revision",
          subjectId: revision.maskRevisionId,
          subjectRevision: "1",
          subjectHash: sha256Json(revision),
          baseTimelineRevision: request.expectedRevision,
          purpose: "input",
          requiredInputs: [
            {
              type: "asset",
              id: asset.assetId,
              revision: request.expectedRevision,
              hash: asset.original.sha256,
            },
          ],
          diffSummary: {
            intent: "单帧对象掩码",
            operationCount: 1,
            summary: `${asset.displayName} · 源帧 ${anchor.frame}`,
          },
          generationCostCapMicros: "0",
          externalDestinations: [],
          status: "pending",
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        });
        this.plans.insertApproval(approval);
        this.tx.db
          .prepare(
            "INSERT INTO mask_anchors(mask_revision_id, project_id, approval_id, request_id, request_hash, document) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            revision.maskRevisionId,
            projectId,
            approval.approvalId,
            request.requestId,
            sha256Json(request),
            JSON.stringify(revision),
          );
        this.tx.emit(projectId, "approval.requested", {
          approvalId: approval.approvalId,
          purpose: "input",
        });
        return approval;
      },
    });
  }

  approvedTrackingAnchor(request: TrackMaskRequest, principal: EditorPrincipal) {
    this.grants.authorizeProject(request.projectId, principal, "operator");
    const approval = this.plans.approval(request.anchorApprovalId);
    if (
      approval.projectId !== request.projectId ||
      approval.subjectType !== "mask_revision" ||
      approval.status !== "approved" ||
      approval.purpose !== "input" ||
      approval.subjectHash !== request.anchorHash
    ) {
      editorFailure("PERMISSION_DENIED", "An approved anchor in this project is required");
    }
    if (
      approval.baseTimelineRevision !== request.expectedRevision ||
      this.grants.requireProjectRow(request.projectId).revision !== request.expectedRevision
    ) {
      editorFailure("REVISION_CONFLICT", "The approved anchor belongs to another timeline revision");
    }
    const revision = this.getMaskRevision(request.projectId, approval.subjectId, principal);
    if (sha256Json(revision) !== approval.subjectHash) {
      editorFailure("ARTIFACT_HASH_MISMATCH", "Approved anchor manifest changed");
    }
    const stop = request.firstFrame + request.frameCount;
    if (
      stop > revision.anchor.frameCount ||
      revision.anchor.frame < request.firstFrame ||
      revision.anchor.frame >= stop
    ) {
      editorFailure("INVALID_ARGUMENT", "The source range must include the approved anchor");
    }
    return revision;
  }

  private trackingReviewInputs(
    projectId: string,
    jobId: string,
    revision: string,
    principal: EditorPrincipal,
  ): TrackedMaskReviewInputs {
    const job = this.jobs.getJob(projectId, jobId, principal);
    const tracking = this.jobs.trackingRequest(projectId, jobId);
    if (!tracking || job.kind !== "analysis" || job.state !== "completed") {
      editorFailure("INVALID_ARGUMENT", "A completed mask tracking job is required");
    }
    if (job.revision !== revision || tracking.expectedRevision !== revision) {
      editorFailure("REVISION_CONFLICT", "Mask tracking revision changed");
    }
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
    if (!manifest || !proxy) {
      editorFailure("ASSET_NOT_FOUND", "Missing tracked mask or review proxy");
    }
    return { tracking, anchor, manifest, proxy };
  }

  requestTrackedMaskReview(request: RequestTrackedMaskReview, principal: EditorPrincipal) {
    const { projectId, jobId, expectedRevision } = request;
    this.grants.authorizeProject(projectId, principal, "operator");
    return this.tx.mutate({
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
        ) {
          editorFailure("ARTIFACT_HASH_MISMATCH", "Tracked mask or review video changed");
        }
        const last = this.tx.db
          .prepare(
            "SELECT approval_id FROM tracked_mask_reviews WHERE job_id = ? ORDER BY rowid DESC LIMIT 1",
          )
          .get(jobId) as { approval_id: string } | undefined;
        if (last) {
          const existing = this.plans.approval(last.approval_id);
          if (
            existing.status === "approved" ||
            (existing.status === "pending" && Date.parse(existing.expiresAt) > Date.now())
          ) {
            return existing;
          }
          if (existing.status === "pending") {
            this.plans.updateApproval({ ...existing, status: "expired" });
          }
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
        this.plans.insertApproval(approval);
        this.tx.db
          .prepare("INSERT INTO tracked_mask_reviews(approval_id, job_id) VALUES (?, ?)")
          .run(approval.approvalId, jobId);
        this.tx.emit(projectId, "approval.requested", {
          approvalId: approval.approvalId,
          purpose: "input",
        });
        return approval;
      },
    });
  }

  maskInput(approval: ApprovalRequest, principal: EditorPrincipal) {
    const row = this.tx.db
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
      ) {
        editorFailure("ARTIFACT_HASH_MISMATCH", "Tracked input revision changed");
      }
      return { kind: "sequence" as const, ...sequence };
    }
    const revision = this.getMaskRevision(approval.projectId, approval.subjectId, principal);
    if (sha256Json(revision) !== approval.subjectHash) {
      editorFailure("ARTIFACT_HASH_MISMATCH", "Mask revision changed");
    }
    return { kind: "anchor" as const, revision };
  }

  approvedSequence(
    projectId: string,
    approvalId: string,
    hash: string,
    revision: string,
    principal: EditorPrincipal,
  ) {
    this.grants.authorizeProject(projectId, principal, "operator");
    const approval = this.plans.approval(approvalId);
    if (
      approval.projectId !== projectId ||
      approval.status !== "approved" ||
      approval.purpose !== "input" ||
      approval.subjectType !== "mask_revision" ||
      approval.subjectHash !== hash ||
      approval.baseTimelineRevision !== revision
    ) {
      editorFailure(
        "PERMISSION_DENIED",
        "An approved mask sequence in the current project is required",
      );
    }
    const input = this.maskInput(approval, principal);
    if (input.kind !== "sequence" || input.tracking.frameCount !== 9) {
      editorFailure(
        "CAPABILITY_UNAVAILABLE",
        "The local VACE profile requires nine approved source frames",
      );
    }
    return input;
  }

  async verifyPendingMask(id: string, principal: EditorPrincipal): Promise<void> {
    const input = this.pendingMaskForDecision(id, principal);
    if (!input) return;
    const cas = this.tx.requireCas();
    const refs = input.kind === "anchor" ? [input.revision.rawLabelMask, input.revision.reviewImage] :
      [input.manifest.blob, input.proxy.blob, input.anchor.rawLabelMask, input.anchor.reviewImage];
    if (input.kind === "sequence") {
      const doc = TrackedMaskManifestSchema.parse(await cas.readJson(input.manifest.blob));
      refs.push(...doc.frames.map(frame => frame.label));
    }
    for (const ref of refs) {
      if (!await cas.verifyBlob(ref)) editorFailure("ARTIFACT_HASH_MISMATCH", "Mask review data is missing or changed");
    }
  }

  pendingMaskForDecision(id: string, principal: EditorPrincipal) {
    const approval = this.plans.approval(id);
    this.grants.authorizeProject(approval.projectId, principal, "operator");
    if (approval.status === "pending" && approval.subjectType === "mask_revision") {
      return this.maskInput(approval, principal);
    }
    return undefined;
  }
}
