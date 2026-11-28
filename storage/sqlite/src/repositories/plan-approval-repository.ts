import { randomUUID } from "node:crypto";
import {
  AcceptedEditPlanSchema,
  ApprovalGrantSchema,
  ApprovalRequestSchema,
  ModelPolicySchema,
  editorFailure,
  type AcceptedEditPlan,
  type ApprovalDecision,
  type ApprovalGrant,
  type ApprovalRequest,
  type EditPlanDraftV1,
  type EditorPrincipal,
  type ModelPolicy,
  type ModelStage,
  type RevokeApprovalRequest,
} from "@ave/contracts";
import {
  sha256Json,
  summarizeDraftTimeline,
  rationalAdd,
  validateEditPlanSemantics,
} from "@ave/domain";
import type { TransactionCoordinator } from "../coordinator.js";
import type { DeviceGrantRepository } from "./device-grant-repository.js";
import type { ProjectAssetRevisionRepository } from "./project-asset-repository.js";
import type { ObjectEditRepository } from "./object-edit-repository.js";

export interface StoredApproval {
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

export class PlanApprovalRepository {
  private objectEdits?: ObjectEditRepository;

  constructor(
    private readonly tx: TransactionCoordinator,
    private readonly grants: DeviceGrantRepository,
    private readonly projects: ProjectAssetRevisionRepository,
  ) {}

  bindObjectEdits(objectEdits: ObjectEditRepository): void {
    this.objectEdits = objectEdits;
  }

  private requireObjectEdits(): ObjectEditRepository {
    if (!this.objectEdits) {
      editorFailure("INTERNAL", "ObjectEditRepository is not bound");
    }
    return this.objectEdits;
  }

  newApproval(
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
      requiredInputs: plan.generationRequests.map((g) => ({
        type: "mask_approval",
        id: g.maskApprovalId!,
        hash: g.referenceManifestHash,
        revision: plan.baseTimelineRevision,
      })),
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

  insertApproval(approval: ApprovalRequest, grant?: ApprovalGrant): void {
    this.tx.db
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
        this.tx.now(),
      );
  }

  updateApproval(approval: ApprovalRequest, grant?: ApprovalGrant): void {
    this.tx.db
      .prepare("UPDATE approvals SET request = ?, grant = ? WHERE approval_id = ?")
      .run(JSON.stringify(approval), grant ? JSON.stringify(grant) : null, approval.approvalId);
  }

  storedApproval(approvalId: string): StoredApproval {
    const row = this.tx.db
      .prepare("SELECT request, grant FROM approvals WHERE approval_id = ?")
      .get(approvalId) as { request: string; grant: string | null } | undefined;
    if (!row) editorFailure("PROJECT_NOT_FOUND", "The approval does not exist");
    return {
      request: ApprovalRequestSchema.parse(JSON.parse(row.request)),
      grant: row.grant ? ApprovalGrantSchema.parse(JSON.parse(row.grant)) : undefined,
    };
  }

  approval(approvalId: string): ApprovalRequest {
    return this.storedApproval(approvalId).request;
  }

  planForApproval(approval: ApprovalRequest): AcceptedEditPlan {
    const row = this.tx.db
      .prepare("SELECT document FROM plans WHERE project_id = ? AND plan_hash = ?")
      .get(approval.projectId, approval.planHash) as { document: string } | undefined;
    if (!row) editorFailure("PROJECT_NOT_FOUND", "The approved plan does not exist");
    return AcceptedEditPlanSchema.parse(JSON.parse(row.document));
  }

  private planResult(planId: string): { plan: AcceptedEditPlan; approval: ApprovalRequest } {
    const plan = AcceptedEditPlanSchema.parse(
      JSON.parse(this.tx.rows("SELECT document FROM plans WHERE plan_id = ?", planId)[0]!),
    );
    const row = this.tx.db
      .prepare(
        "SELECT request FROM approvals WHERE plan_hash = ? AND purpose = 'preview' ORDER BY created_at LIMIT 1",
      )
      .get(plan.planHash) as { request: string } | undefined;
    if (!row) editorFailure("INTERNAL", "A stored plan has no approval");
    return { plan, approval: ApprovalRequestSchema.parse(JSON.parse(row.request)) };
  }

  private validatePlanDraft(draft: EditPlanDraftV1): void {
    const project = this.grants.requireProjectRow(draft.projectId);
    if (
      project.revision !== draft.baseTimelineRevision ||
      project.asset_manifest_hash !== draft.baseAssetManifestHash
    ) {
      editorFailure("REVISION_CONFLICT", "The plan was built against an older project snapshot");
    }
    const assets = this.projects.listAssetsMap(draft.projectId);
    validateEditPlanSemantics(draft, assets, (indexSha, streamUid) =>
      this.projects.hasConstantRate(indexSha, streamUid),
    );
  }

  validateProposal(draft: EditPlanDraftV1, principal: EditorPrincipal): void {
    this.grants.authorizeProject(draft.projectId, principal, "operator");
    this.validatePlanDraft(draft);
    for (const g of draft.generationRequests) {
      const input = this.requireObjectEdits().approvedSequence(
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
      ) {
        editorFailure(
          "PLAN_SEMANTIC_INVALID",
          "Generation references differ from the approved mask sequence",
        );
      }
      const anchor = input.anchor.anchor;
      const rate = BigInt(g.sampleFps.num);
      const period = BigInt(g.sampleFps.den);
      const duration = op.sourceRange.duration;
      const start = rationalAdd(op.sourceRange.start, anchor.inputStartTime ?? { num: "0", den: "1" });
      const offset = BigInt(anchor.frame - input.tracking.firstFrame);
      const atAnchor = BigInt(start.num) * rate + offset * period * BigInt(start.den);
      if (
        rate <= 0n ||
        BigInt(duration.num) * rate !== 9n * period * BigInt(duration.den) ||
        atAnchor * BigInt(anchor.timeBase.den) !==
          BigInt(anchor.pts) * BigInt(anchor.timeBase.num) * BigInt(start.den) * rate
      ) {
        editorFailure(
          "PLAN_SEMANTIC_INVALID",
          "Generation trim does not align with the approved source anchor",
        );
      }
    }
  }

  async estimateTimeline(
    input: { requestId: string; draft?: EditPlanDraftV1; projectId?: string; planId?: string },
    principal: EditorPrincipal,
  ) {
    const draft =
      input.draft ??
      (() => {
        if (!input.projectId || !input.planId) {
          editorFailure("INVALID_ARGUMENT", "Provide either a draft or a planId");
        }
        const plan = this.getPlan(input.projectId, input.planId, principal);
        return { ...plan } as EditPlanDraftV1;
      })();
    this.grants.authorizeProject(draft.projectId, principal, "operator");
    let valid = true;
    let issue: string | null = null;
    try {
      this.validatePlanDraft(draft);
    } catch (error) {
      valid = false;
      issue = error instanceof Error ? error.message : String(error);
    }
    const warnings: string[] = [];
    const cas = this.tx.getCas();
    if (cas) {
      const project = this.projects.getProjectSnapshot(draft.projectId, principal);
      for (const op of draft.trimOperations) {
        const asset = project.assets.find((a) => a.assetId === op.source.assetId);
        if (!asset) continue;
        try {
          const probe = JSON.parse((await cas.readBytes(asset.probe)).toString("utf8")) as {
            format?: { duration?: string };
          };
          const duration = Number(probe.format?.duration ?? "NaN");
          if (!Number.isFinite(duration)) continue;
          const start = Number(op.sourceRange.start.num) / Number(op.sourceRange.start.den);
          const dur = Number(op.sourceRange.duration.num) / Number(op.sourceRange.duration.den);
          if (start + dur > duration + 1e-6) {
            warnings.push(
              `trim ${op.opId} exceeds asset ${asset.assetId} duration (${start + dur}s > ${duration}s)`,
            );
          }
        } catch {
          // probe unreadable: skip warning
        }
        if (warnings.length >= 16) break;
      }
    }
    return {
      requestId: input.requestId,
      projectId: draft.projectId,
      ...(input.planId ? { planId: input.planId } : {}),
      valid,
      issue,
      warnings,
      ...summarizeDraftTimeline(draft),
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
    return this.tx.mutate({
      projectId: draft.projectId,
      requestId: input.requestId,
      payload: { draft, runId: input.runId, toolCallId: input.toolCallId },
      execute: () => {
        const existing = this.tx.db
          .prepare("SELECT plan_id FROM plans WHERE plan_id = ?")
          .get(idempotencyKey) as { plan_id: string } | undefined;
        const planHash = sha256Json({
          draft,
          deterministicBackendId: draft.preferredDeterministicBackendId ?? "ffmpeg",
        });
        if (existing) {
          const result = this.planResult(existing.plan_id);
          if (result.plan.planHash !== planHash) {
            editorFailure(
              "IDEMPOTENCY_CONFLICT",
              "The tool call already proposed a different plan",
            );
          }
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
        this.tx.db
          .prepare(
            "INSERT INTO plans(plan_id, project_id, plan_hash, revision, document) VALUES (?, ?, ?, ?, ?)",
          )
          .run(plan.planId, plan.projectId, planHash, plan.revision, JSON.stringify(plan));
        this.insertApproval(approval);
        const cause = { runId: input.runId, causationId: input.toolCallId };
        this.tx.emit(draft.projectId, "plan.proposed", { planId: plan.planId, planHash }, cause);
        this.tx.emit(
          draft.projectId,
          "approval.requested",
          { approvalId: approval.approvalId, purpose: approval.purpose },
          cause,
        );
        return { plan, approval };
      },
    });
  }

  getPlan(projectId: string, planId: string, principal: EditorPrincipal): AcceptedEditPlan {
    this.grants.authorizeProject(projectId, principal, "viewer");
    const [document] = this.tx.rows(
      "SELECT document FROM plans WHERE project_id = ? AND plan_id = ?",
      projectId,
      planId,
    );
    if (!document) editorFailure("ASSET_NOT_FOUND", "No such plan in the bound project");
    return AcceptedEditPlanSchema.parse(JSON.parse(document));
  }

  listPlans(projectId: string, principal: EditorPrincipal, afterPlanId?: string) {
    this.grants.authorizeProject(projectId, principal, "viewer");
    const plans =
      afterPlanId === undefined
        ? this.tx.rows("SELECT document FROM plans WHERE project_id = ? ORDER BY rowid LIMIT 129", projectId)
        : this.tx.rows(
            `SELECT document FROM plans WHERE project_id = ?
             AND rowid > (SELECT rowid FROM plans WHERE project_id = ? AND plan_id = ?)
             ORDER BY rowid LIMIT 129`,
            projectId,
            projectId,
            afterPlanId,
          );
    const page = plans
      .slice(0, 128)
      .map((document) => AcceptedEditPlanSchema.parse(JSON.parse(document)));
    return {
      projectId,
      planCount: page.length,
      plans: page.map((p) => ({
        planId: p.planId,
        revision: p.revision,
        planHash: p.planHash,
        intent: p.intent.slice(0, 200),
        status: p.status,
        deterministicBackendId: p.deterministicBackendId,
      })),
      hasMore: plans.length > 128,
    };
  }

  getApproval(projectId: string, approvalId: string, principal: EditorPrincipal): ApprovalRequest {
    this.grants.authorizeProject(projectId, principal, "viewer");
    const stored = this.storedApproval(approvalId);
    if (stored.request.projectId !== projectId) {
      editorFailure("PERMISSION_DENIED", "The approval belongs to another project");
    }
    return stored.request;
  }

  listApprovals(projectId: string, principal: EditorPrincipal, status?: string) {
    this.grants.authorizeProject(projectId, principal, "viewer");
    const approvals = this.tx
      .rows(
        "SELECT request FROM approvals WHERE project_id = ? ORDER BY created_at, approval_id",
        projectId,
      )
      .map((document) => ApprovalRequestSchema.parse(JSON.parse(document)))
      .filter((a) => !status || a.status === status)
      .slice(-256);
    return { projectId, status: status ?? null, approvalCount: approvals.length, approvals };
  }

  revokeApproval(input: RevokeApprovalRequest, principal: EditorPrincipal): ApprovalRequest {
    const approval = this.approval(input.approvalId);
    this.grants.authorizeProject(approval.projectId, principal, "operator");
    return this.tx.mutate({
      projectId: approval.projectId,
      requestId: input.requestId,
      payload: { approvalId: input.approvalId },
      execute: () => {
        const stored = this.storedApproval(input.approvalId);
        const current = stored.request;
        if (current.projectId !== input.projectId) {
          editorFailure("PERMISSION_DENIED", "The approval belongs to another project");
        }
        if (!["pending", "approved"].includes(current.status)) {
          editorFailure("APPROVAL_CONSUMED", "Only pending or approved approvals can be revoked");
        }
        const revoked: ApprovalRequest = { ...current, status: "revoked" };
        this.updateApproval(
          revoked,
          stored.grant ? { ...stored.grant, revokedReason: "revoked by operator" } : undefined,
        );
        this.tx.emit(current.projectId, "approval.decided", {
          approvalId: current.approvalId,
          decision: "revoked",
        });
        return revoked;
      },
    });
  }

  decideApproval(
    input: ApprovalDecision,
    principal: EditorPrincipal,
  ): { approval: ApprovalRequest; grant?: ApprovalGrant } {
    const approval = this.approval(input.approvalId);
    this.grants.authorizeProject(approval.projectId, principal, "operator");
    return this.tx.mutate({
      projectId: approval.projectId,
      requestId: input.requestId,
      payload: input,
      execute: () => {
        const current = this.approval(input.approvalId);
        if (
          current.baseTimelineRevision !== input.expectedRevision ||
          this.grants.requireProjectRow(current.projectId).revision !== input.expectedRevision
        ) {
          editorFailure("REVISION_CONFLICT", "The approval belongs to an older timeline revision");
        }
        if (current.status !== "pending") {
          editorFailure("APPROVAL_CONSUMED", "The approval has already been decided");
        }
        if (Date.parse(current.expiresAt) <= Date.now()) {
          editorFailure("APPROVAL_EXPIRED", "The approval has expired");
        }
        if (input.decision === "reject") {
          const rejected: ApprovalRequest = { ...current, status: "rejected" };
          this.updateApproval(rejected);
          if (current.subjectType === "mask_revision") {
            this.tx.db
              .prepare("UPDATE tracked_mask_reviews SET decided_by = ? WHERE approval_id = ?")
              .run(principal.principalId, current.approvalId);
          }
          this.tx.emit(approval.projectId, "approval.decided", {
            approvalId: current.approvalId,
            decision: "rejected",
          });
          return { approval: rejected };
        }
        if (current.purpose === "input" && current.subjectType === "mask_revision") {
          const inputMask = this.requireObjectEdits().maskInput(current, principal);
          const approved: ApprovalRequest = { ...current, status: "approved" };
          this.updateApproval(approved);
          if (inputMask.kind === "sequence") {
            this.tx.db
              .prepare("UPDATE tracked_mask_reviews SET decided_by = ? WHERE approval_id = ?")
              .run(principal.principalId, current.approvalId);
          } else {
            this.tx.db
              .prepare(
                "UPDATE mask_anchors SET approved_by = ? WHERE project_id = ? AND mask_revision_id = ?",
              )
              .run(principal.principalId, current.projectId, current.subjectId);
          }
          this.tx.emit(current.projectId, "approval.decided", {
            approvalId: current.approvalId,
            decision: "approved",
          });
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
          approvedAt: this.tx.now(),
          expiresAt: current.expiresAt,
        });
        const approved: ApprovalRequest = { ...current, status: "approved" };
        this.updateApproval(approved, grant);
        this.tx.emit(approval.projectId, "approval.granted", {
          approvalId: current.approvalId,
          grantId: grant.grantId,
        });
        return { approval: approved, grant };
      },
    });
  }

  getMutationResult(projectId: string, requestId: string, principal: EditorPrincipal) {
    this.grants.authorizeProject(projectId, principal, "viewer");
    const row = this.tx.db
      .prepare(
        "SELECT fingerprint, response, created_at FROM mutations WHERE project_id = ? AND request_id = ?",
      )
      .get(projectId, requestId) as
      | { fingerprint: string; response: string; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      requestId,
      projectId,
      fingerprint: row.fingerprint,
      response: JSON.parse(row.response),
      createdAt: row.created_at,
    };
  }

  setModelPolicy(
    input: { requestId: string; projectId: string; policy: ModelPolicy },
    principal: EditorPrincipal,
  ) {
    return this.tx.mutate({
      projectId: input.projectId,
      requestId: input.requestId,
      payload: input,
      execute: (projectId) => {
        this.grants.authorizeProject(projectId, principal, "owner");
        const policy = ModelPolicySchema.parse(input.policy);
        this.tx.db
          .prepare(
            "INSERT INTO model_policies(project_id, provider, model_id, document) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, provider, model_id) DO UPDATE SET document = excluded.document",
          )
          .run(projectId, policy.provider, policy.modelId, JSON.stringify(policy));
        this.tx.emit(projectId, "model.policy_set", {
          provider: policy.provider,
          modelId: policy.modelId,
          stages: policy.stages,
        });
        return policy;
      },
    });
  }

  listModelPolicies(projectId: string, principal: EditorPrincipal): ModelPolicy[] {
    this.grants.authorizeProject(projectId, principal, "viewer");
    return this.tx
      .rows(
        "SELECT document FROM model_policies WHERE project_id = ? ORDER BY provider, model_id LIMIT 64",
        projectId,
      )
      .map((document) => ModelPolicySchema.parse(JSON.parse(document)));
  }

  removeModelPolicy(
    input: { requestId: string; projectId: string; provider: string; modelId: string },
    principal: EditorPrincipal,
  ) {
    return this.tx.mutate({
      projectId: input.projectId,
      requestId: input.requestId,
      payload: input,
      execute: (projectId) => {
        this.grants.authorizeProject(projectId, principal, "owner");
        const info = this.tx.db
          .prepare("DELETE FROM model_policies WHERE project_id = ? AND provider = ? AND model_id = ?")
          .run(projectId, input.provider, input.modelId);
        const removed = Number(info.changes) > 0;
        if (removed) {
          this.tx.emit(projectId, "model.policy_removed", {
            provider: input.provider,
            modelId: input.modelId,
          });
        }
        return { removed };
      },
    });
  }

  modelAllowed(
    projectId: string,
    stage: ModelStage,
    model: { provider: string; id: string },
    principal: EditorPrincipal,
  ): boolean {
    this.grants.authorizeProject(projectId, principal, "viewer");
    const policy = this.listModelPolicies(projectId, principal).find(
      (p) => p.provider === model.provider && p.modelId === model.id,
    );
    if (!policy || !policy.enabled) return false;
    if (policy.location === "cloud" && !this.projects.cloudModelsAllowed(projectId)) return false;
    return policy.stages.includes(stage);
  }
}
