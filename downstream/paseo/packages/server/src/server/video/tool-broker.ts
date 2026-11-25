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
        return {
          projectId,
          revision: p.revision,
          baseAssetManifestHash: p.baseAssetManifestHash,
          assetCount: p.assets.length,
          assets: p.assets
            .slice(0, 64)
            .map((a) => ({ assetId: a.assetId, contentHash: a.original.sha256 })),
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
      case "get_asset_metadata": {
        const asset = this.store
          .project(projectId, principal)
          .assets.find((a) => a.assetId === call.args.assetId);
        if (!asset || asset.original.sha256 !== call.args.contentHash)
          editorFailure("ASSET_NOT_FOUND", "Asset identity is not in the bound project");
        return {
          assetId: asset.assetId,
          contentHash: asset.original.sha256,
          streams: asset.streams.map(
            ({ streamUid, kind, codec, timeBase, width, height, sampleRate }) => ({
              streamUid,
              kind,
              codec,
              timeBase,
              width,
              height,
              sampleRate,
            }),
          ),
        };
      }
      case "get_job_status": {
        const { jobId, kind, state, revision, progress } = this.store.job(
          projectId,
          call.args.jobId,
          principal,
        );
        return { jobId, kind, state, revision, progress };
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
      case "get_analysis": {
        const project = this.store.project(projectId, principal);
        const asset = project.assets.find((a) => a.assetId === call.args.assetId);
        if (!asset || asset.original.sha256 !== call.args.contentHash)
          editorFailure("ASSET_NOT_FOUND", "Asset identity is not in the bound project");
        const latest = project.jobs
          .filter((j) => j.analysisAssetId === call.args.assetId)
          .sort((a, b) => (a.jobId < b.jobId ? 1 : -1))[0];
        if (!latest) editorFailure("ASSET_NOT_FOUND", "No analysis job exists for this asset");
        const qa = latest.artifacts.find((a) => a.kind === "qa");
        const scene = latest.artifacts.find((a) => a.kind === "scenecuts");
        return {
          assetId: asset.assetId,
          contentHash: asset.original.sha256,
          jobId: latest.jobId,
          state: latest.state,
          revision: latest.revision,
          analysisRate: latest.analysisRate ?? null,
          qaArtifactId: qa?.artifactId ?? null,
          qaSha256: qa?.blob.sha256 ?? null,
          scenecutsArtifactId: scene?.artifactId ?? null,
          scenecutsSha256: scene?.blob.sha256 ?? null,
          note: "Metadata only; the sampling map stays in CAS and is never sent to the model. Use get_scene_cuts for the cut list.",
        };
      }
      case "get_scene_cuts":
        return this.store.sceneCuts(projectId, call.args.assetId, principal);
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
      case "get_plan": {
        const plan = this.store
          .project(projectId, principal)
          .plans.find((p) => p.planId === call.args.planId);
        if (!plan) editorFailure("ASSET_NOT_FOUND", "No such plan in the bound project");
        return plan;
      }
      case "validate_edit_plan":
        this.store.validateProposal(call.args, principal);
        return { valid: true };
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
