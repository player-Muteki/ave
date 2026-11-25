import { VideoToolCallSchema, type EditorPrincipal } from "#video-editor/contracts/v1";
import { sha256Json } from "./cas.js";
import { editorFailure } from "./errors.js";
import type { EditorStore } from "./store.js";

export interface PlannerScope {
  projectId: string;
  runId: string;
  principal: EditorPrincipal;
}

/** Construct one per admitted run. Do not pass a generic RPC dispatcher to the worker. */
export class VideoToolBroker {
  constructor(
    private readonly store: EditorStore,
    private readonly scope: PlannerScope,
  ) {}

  invoke(message: unknown) {
    const parsed = VideoToolCallSchema.safeParse(message);
    if (!parsed.success) editorFailure("INVALID_ARGUMENT", "Invalid planner tool request");
    const call = parsed.data;
    const { projectId, runId, principal } = this.scope;
    if ("projectId" in call.args && call.args.projectId !== projectId)
      editorFailure("PERMISSION_DENIED", "The planner is bound to another project");
    switch (call.tool) {
      case "get_project_snapshot": {
        const p = this.store.project(projectId, principal);
        const analysisState = new Map<string, string>();
        for (const j of [...p.jobs].sort((a, b) => (a.jobId < b.jobId ? 1 : -1)))
          if (j.analysisAssetId && !analysisState.has(j.analysisAssetId))
            analysisState.set(j.analysisAssetId, j.state);
        return {
          projectId,
          revision: p.revision,
          baseAssetManifestHash: p.baseAssetManifestHash,
          assetCount: p.assets.length,
          assets: p.assets
            .slice(0, 64)
            .map((a) => ({
              assetId: a.assetId,
              contentHash: a.original.sha256,
              analysisState: analysisState.get(a.assetId) ?? null,
            })),
          hasMoreAssets: p.assets.length > 64,
          planCount: p.plans.length,
          plans: p.plans
            .slice(0, 32)
            .map((plan) => ({
              planId: plan.planId,
              revision: plan.revision,
              planHash: plan.planHash,
              intent: plan.intent.slice(0, 200),
            })),
          hasMorePlans: p.plans.length > 32,
          approvalCount: p.approvals.length,
          pendingApprovalCount: p.approvals.filter((a) => a.status === "pending").length,
          jobCount: p.jobs.length,
          jobs: p.jobs
            .slice(0, 64)
            .map((j) => ({
              jobId: j.jobId,
              kind: j.kind,
              state: j.state,
              revision: j.revision,
              analysisAssetId: j.analysisAssetId ?? null,
            })),
          hasMoreJobs: p.jobs.length > 64,
        };
      }
      case "get_asset_metadata":
        return this.store.plannerAssetMetadata(projectId, call.args.assetId, call.args.contentHash, principal);
      case "get_job_status": {
        const job = this.store.job(projectId, call.args.jobId, principal);
        return {
          jobId: job.jobId,
          kind: job.kind,
          state: job.state,
          revision: job.revision,
          progress: job.progress,
          artifacts: job.artifacts.map((a) => ({
            kind: a.kind,
            artifactId: a.artifactId,
            revision: a.revision,
            sha256: a.blob.sha256,
          })),
        };
      }
      case "get_qa_report": {
        const job = this.store.job(projectId, call.args.jobId, principal);
        const qa = job.artifacts.find((a) => a.kind === "qa");
        if (!qa) editorFailure("ASSET_NOT_FOUND", "The job has no QA artifact yet");
        return {
          jobId: job.jobId,
          kind: job.kind,
          state: job.state,
          revision: job.revision,
          qaArtifactId: qa.artifactId,
          qaSha256: qa.blob.sha256,
        };
      }
      case "get_contact_sheet": {
        const asset = this.store
          .project(projectId, principal)
          .assets.find((a) => a.assetId === call.args.assetId);
        if (!asset || asset.original.sha256 !== call.args.contentHash)
          editorFailure("ASSET_NOT_FOUND", "Asset identity is not in the bound project");
        const indexBytes = asset.presentationIndex;
        return {
          assetId: asset.assetId,
          contentHash: asset.original.sha256,
          presentationIndexSha256: indexBytes.sha256,
          streams: asset.streams.map((s) => ({
            streamUid: s.streamUid,
            kind: s.kind,
            codec: s.codec,
            width: s.width,
            height: s.height,
            averageRate: s.averageRate,
          })),
          note: "Bounded metadata only; pixels are never sent to the model. Generate the sheet via video.v1.contact_sheet.",
        };
      }
      case "get_analysis":
        return this.store.analysisSummary(projectId, call.args.assetId, principal, call.args.contentHash);
      case "get_scene_cuts":
        return this.store.sceneCuts(projectId, call.args.assetId, principal);
      case "get_waveform":
        return this.store.waveform(projectId, call.args.assetId, principal);
      case "diff_plans": {
        if (call.args.draft.projectId !== projectId)
          editorFailure("PERMISSION_DENIED", "The draft belongs to another project");
        const plan = this.store
          .project(projectId, principal)
          .plans.find((p) => p.planId === call.args.planId);
        if (!plan) editorFailure("ASSET_NOT_FOUND", "No such plan in the bound project");
        const draft = call.args.draft;
        const kinds = [
          "trimOperations",
          "transformOperations",
          "audioOperations",
          "transitionOperations",
          "subtitleOperations",
        ] as const;
        const result: Record<string, unknown> = {
          planId: plan.planId,
          planHash: plan.planHash,
          intentChanged: draft.intent !== plan.intent,
        };
        for (const kind of kinds) {
          const before = new Map((plan[kind] as Array<Record<string, unknown>>).map((o) => [o.opId as string, o]));
          const after = new Map((draft[kind] as Array<Record<string, unknown>>).map((o) => [o.opId as string, o]));
          const added: string[] = [];
          const removed: string[] = [];
          const changed: Array<{ opId: string; fields: string[] }> = [];
          for (const [opId, op] of after) {
            const old = before.get(opId);
            if (!old) {
              added.push(opId);
              continue;
            }
            const fields: string[] = [];
            for (const k of new Set([...Object.keys(old), ...Object.keys(op)]))
              if (JSON.stringify(old[k]) !== JSON.stringify(op[k])) fields.push(k);
            if (fields.length) changed.push({ opId, fields: fields.slice(0, 12) });
          }
          for (const opId of before.keys()) if (!after.has(opId)) removed.push(opId);
          result[kind] = {
            added: added.slice(0, 64),
            removed: removed.slice(0, 64),
            changed: changed.slice(0, 64),
          };
        }
        return result;
      }
      case "get_qa_summary":
        return this.store.qaSummary(projectId, call.args.jobId, principal);
      case "get_planning_run": {
        const lifecycle = this.store.runLifecycle(projectId, principal);
        const current = lifecycle.find((r) => r.runId === runId);
        const { events } = this.store.events(projectId, "0", principal);
        const mine = events.filter((e) => e.runId === runId);
        return {
          projectId,
          runId,
          state: current?.state ?? "unknown",
          eventCount: mine.length,
          recentEvents: mine.slice(-16).map((e) => ({
            seq: e.seq,
            type: e.type,
            payload:
              typeof e.payload === "object" && e.payload !== null
                ? JSON.stringify(e.payload).slice(0, 500)
                : String(e.payload).slice(0, 500),
          })),
          note: "Read-only view of this planning run's persisted daemon events.",
        };
      }
      case "get_plan":
        return this.store.plan(projectId, call.args.planId, principal);
      case "validate_edit_plan":
        this.store.validateProposal(call.args, principal);
        return { valid: true };
      case "estimate_timeline":
        return this.store.estimateTimeline(
          { requestId: sha256Json([projectId, runId, call.toolCallId, "estimate"]), draft: call.args },
          principal,
        );
      case "submit_edit_plan": {
        const { plan } = this.store.createPlan({
          runId,
          toolCallId: call.toolCallId,
          draft: call.args,
          principal,
          requestId: sha256Json([
            "video-planner",
            projectId,
            principal.principalId,
            runId,
            call.toolCallId,
          ]),
        });
        return { planId: plan.planId, planHash: plan.planHash, status: plan.status };
      }
    }
  }
}
