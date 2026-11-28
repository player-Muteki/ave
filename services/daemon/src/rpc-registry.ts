import { createHash } from "node:crypto";
import { z } from "zod";
import type { ContentAddressedStore } from "@ave/cas";
import {
  AnalyzeAssetInputSchema,
  AnswerRunQuestionInputSchema,
  ApprovalDecisionSchema,
  CancelUploadRequestSchema,
  CommitUploadRequestSchema,
  ContactSheetRequestSchema,
  CreateJobRequestSchema,
  CreateMaskRevisionRequestSchema,
  CreateProjectInputSchema,
  CreateUploadRequestSchema,
  DecideObjectTargetRequestSchema,
  EstimateTimelineRequestSchema,
  EventsRequestSchema,
  GetAnalysisInputSchema,
  GetApprovalInputSchema,
  GetAssetMetadataInputSchema,
  GetExportSummaryInputSchema,
  GetModelPoliciesInputSchema,
  GetMutationResultInputSchema,
  GetPlanInputSchema,
  GetQaSummaryInputSchema,
  GetRunEventsInputSchema,
  GetRunQuestionsInputSchema,
  GetSceneCutsInputSchema,
  GetWaveformInputSchema,
  InspectFrameRequestSchema,
  JobControlRequestSchema,
  JobRequestSchema,
  ListApprovalsInputSchema,
  ListObjectEditsRequestSchema,
  ListPlansInputSchema,
  MaskRevisionReviewRequestSchema,
  ObjectEditRequestSchema,
  OpenObjectEditRequestSchema,
  PlanReviewRequestSchema,
  PlanningRunRequestSchema,
  PreviewFramesRequestSchema,
  ProjectRequestSchema,
  ProposeVacePreviewSchema,
  ReadAssetChunkRequestSchema,
  RecordObjectCandidatesRequestSchema,
  RecordObjectQaRequestSchema,
  RemoveModelPolicyInputSchema,
  RequestTrackedMaskReviewSchema,
  ReviewObjectMaskRequestSchema,
  RevokeApprovalRequestSchema,
  SetModelPolicyInputSchema,
  SetProjectCloudPolicyInputSchema,
  StartPlanningRunInputSchema,
  SteerPlanningRunInputSchema,
  TrackMaskRequestSchema,
  UploadRequestSchema,
  VerifyExportInputSchema,
  WriteUploadChunkSchema,
  decodeFramedChunk,
  editorFailure,
  encodeFramedChunk,
  type ApprovalRequest,
  type EditorPrincipal,
  type PlanningRunStatus,
  type StartPlanningRunInput,
  type SteerPlanningRunInput,
} from "@ave/contracts";
import { MODEL_REGISTRY, authorizeVideoMethod, type AveCaller } from "@ave/domain";
import type { AveStore } from "@ave/sqlite";
import type { DeterministicBackendRegistry } from "./backends/deterministic-backend.js";
import type { AveJobSupervisor } from "./job-supervisor.js";
import type { DaemonQueries } from "./store-queries.js";
import type { UploadManager } from "./upload-manager.js";

export interface PlannerControllerHook {
  startRun(input: StartPlanningRunInput, principal: EditorPrincipal): Promise<PlanningRunStatus>;
  steerRun(input: SteerPlanningRunInput, principal: EditorPrincipal): Promise<PlanningRunStatus>;
  followUpRun(input: SteerPlanningRunInput, principal: EditorPrincipal): Promise<PlanningRunStatus>;
  stopRun(projectId: string, runId: string, principal: EditorPrincipal): Promise<PlanningRunStatus>;
  status(projectId: string, runId: string, principal: EditorPrincipal): PlanningRunStatus;
}

export interface MediaWorkerHook {
  inspectFrame(input: z.infer<typeof InspectFrameRequestSchema>, principal: EditorPrincipal): Promise<Uint8Array>;
  createMaskRevision(input: z.infer<typeof CreateMaskRevisionRequestSchema>, principal: EditorPrincipal): Promise<ApprovalRequest>;
  readMaskRevision(projectId: string, maskRevisionId: string, principal: EditorPrincipal): Promise<Uint8Array>;
  proposeVacePreview(input: z.infer<typeof ProposeVacePreviewSchema>, principal: EditorPrincipal): Promise<unknown>;
  hasMaskTracking(): boolean;
  hasVace(): boolean;
}

const CreateInvitationSchema = z
  .object({
    role: z.enum(["viewer", "operator"]),
    projectIds: z.array(z.string().min(1)).min(1),
    ttlSeconds: z.number().int().positive().max(86_400).optional(),
  })
  .strict();

const RedeemInvitationSchema = z
  .object({
    invitationId: z.string().min(1),
    token: z.string().min(1),
  })
  .strict();

const RevokeDeviceSchema = z.object({ deviceId: z.string().min(1) }).strict();

type RpcHandler = (input: unknown, principal: EditorPrincipal) => Promise<unknown> | unknown;

export interface AveRpcDependencies {
  store: AveStore;
  cas: ContentAddressedStore;
  backends: DeterministicBackendRegistry;
  jobs: AveJobSupervisor;
  uploads: UploadManager;
  queries: DaemonQueries;
  onProjectEvent: (projectId: string) => void;
  planner?: PlannerControllerHook;
  mediaWorker?: MediaWorkerHook;
}

export class AveRpcRegistry {
  private readonly handlers = new Map<string, RpcHandler>();
  private planner?: PlannerControllerHook;
  private mediaWorker?: MediaWorkerHook;

  constructor(private readonly deps: AveRpcDependencies) {
    this.planner = deps.planner;
    this.mediaWorker = deps.mediaWorker;
    this.registerAll();
  }

  attachPlanner(planner: PlannerControllerHook): void {
    this.planner = planner;
  }

  attachMediaWorker(mediaWorker: MediaWorkerHook): void {
    this.mediaWorker = mediaWorker;
  }

  listRegisteredMethods(): string[] {
    return [...this.handlers.keys()].sort();
  }

  async invoke(method: string, input: unknown, caller: AveCaller): Promise<unknown> {
    const principal = authorizeVideoMethod(method, caller);
    const handler = this.handlers.get(method);
    if (!handler) {
      editorFailure("CAPABILITY_UNAVAILABLE", `Unsupported video editor RPC: ${method}`);
    }
    return handler(input, principal);
  }

  private register(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  private parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      editorFailure("INVALID_ARGUMENT", parsed.error.issues[0]?.message ?? "Invalid RPC payload");
    }
    return parsed.data;
  }

  private registerAll(): void {
    const { store, cas, backends, jobs, uploads, queries, onProjectEvent } = this.deps;

    this.register("video.v1.get_capabilities", async () => {
      const ffmpeg = backends.get("ffmpeg");
      const burnIn = await ffmpeg.burnInSubtitlesAvailable();
      const deterministicBackends = await backends.capabilities();
      return {
        protocolVersion: "1",
        features: [
          "deterministic-editing",
          "persistent-jobs",
          "chunked-media",
          "device-channel",
          "deterministic-analysis",
          "analysis-summary",
          "qa-summary",
          "timeline-estimate",
          "list-artifacts",
          "list-approvals",
          "list-plans",
          "run-events",
          "run-questions",
          "model-gateway-policy",
          "object-edit-workflow",
          ...(this.planner ? ["native-planner"] : []),
          ...(this.mediaWorker?.hasMaskTracking() ? ["mask-tracking"] : []),
          ...(this.mediaWorker?.hasVace() ? ["vace-preview"] : []),
          ...(burnIn ? ["burn-in-subtitles"] : []),
        ],
        operations: this.listRegisteredMethods(),
        deterministicBackends,
        workerProfiles: [
          { profileId: "ffmpeg-deterministic-v1", engine: "ffmpeg", colorSpaces: ["bt709"] },
          ...MODEL_REGISTRY.map((m) => ({
            profileId: m.id,
            engine: m.engine,
            maxFrames: String(m.maxFrames),
            colorSpaces: ["bt709"],
          })),
        ],
      };
    });

    this.register("video.v1.create_project", (input, principal) => {
      const parsed = this.parse(CreateProjectInputSchema, input);
      const snapshot = store.projects.createProject({
        requestId: parsed.requestId,
        title: parsed.title,
        principal,
      });
      onProjectEvent(snapshot.projectId);
      return snapshot;
    });

    this.register("video.v1.get_project", (input, principal) => {
      const { projectId } = this.parse(ProjectRequestSchema, input);
      return store.projects.getProjectSnapshot(projectId, principal);
    });

    this.register("video.v1.list_projects", (_input, principal) => ({
      projects: store.projects.listProjects(principal),
    }));

    this.register("video.v1.submit_plan", (input, principal) => {
      const parsed = this.parse(PlanReviewRequestSchema, input);
      const result = store.plans.createPlan({ ...parsed, principal });
      onProjectEvent(result.plan.projectId);
      return result;
    });

    this.register("video.v1.get_mutation_result", (input, principal) => {
      const parsed = this.parse(GetMutationResultInputSchema, input);
      return {
        requestId: parsed.requestId,
        projectId: parsed.projectId,
        mutation: store.plans.getMutationResult(parsed.projectId, parsed.requestId, principal),
      };
    });

    this.register("video.v1.get_approval", (input, principal) => {
      const parsed = this.parse(GetApprovalInputSchema, input);
      const approval = store.plans.getApproval(parsed.projectId, parsed.approvalId, principal);
      return { ...approval, requestId: parsed.requestId };
    });

    this.register("video.v1.revoke_approval", (input, principal) => {
      const parsed = this.parse(RevokeApprovalRequestSchema, input);
      const revoked = store.plans.revokeApproval(parsed, principal);
      onProjectEvent(revoked.projectId);
      return revoked;
    });

    this.register("video.v1.decide_approval", async (input, principal) => {
      const parsed = this.parse(ApprovalDecisionSchema, input);
      if (parsed.decision === "approve") await store.objectEdits.verifyPendingMask(parsed.approvalId, principal);
      const res = store.plans.decideApproval(parsed, principal);
      onProjectEvent(res.approval.projectId);
      return res;
    });

    this.register("video.v1.create_job", (input, principal) => {
      const parsed = this.parse(CreateJobRequestSchema, input);
      const created = store.jobs.createJob({ ...parsed, principal });
      if (!created.deduplicated) {
        jobs.enqueue(created.job.projectId, created.job.jobId);
      }
      onProjectEvent(created.job.projectId);
      return created;
    });

    this.register("video.v1.get_job", (input, principal) => {
      const parsed = this.parse(JobRequestSchema, input);
      return store.jobs.getJob(parsed.projectId, parsed.jobId, principal);
    });

    this.register("video.v1.control_job", (input, principal) => {
      const parsed = this.parse(JobControlRequestSchema, input);
      return jobs.control(
        parsed.projectId,
        parsed.jobId,
        parsed.action,
        parsed.requestId,
        principal,
      );
    });

    this.register("video.v1.get_events", (input, principal) => {
      const parsed = this.parse(EventsRequestSchema, input);
      return store.jobs.getEvents(parsed.projectId, parsed.afterSeq, principal);
    });

    this.register("video.v1.list_approvals", (input, principal) => {
      const parsed = this.parse(ListApprovalsInputSchema, input);
      return {
        requestId: parsed.requestId,
        ...store.plans.listApprovals(parsed.projectId, principal, parsed.status),
      };
    });

    this.register("video.v1.list_plans", (input, principal) => {
      const parsed = this.parse(ListPlansInputSchema, input);
      return {
        requestId: parsed.requestId,
        ...store.plans.listPlans(parsed.projectId, principal, parsed.afterPlanId),
      };
    });

    this.register("video.v1.get_run_events", (input, principal) => {
      const parsed = this.parse(GetRunEventsInputSchema, input);
      return {
        requestId: parsed.requestId,
        projectId: parsed.projectId,
        runId: parsed.runId,
        ...store.jobs.runEvents(parsed.projectId, parsed.runId, parsed.afterSeq ?? "0", principal),
      };
    });

    this.register("video.v1.get_run_questions", (input, principal) => {
      const parsed = this.parse(GetRunQuestionsInputSchema, input);
      const questions = store.jobs.runQuestions(parsed.projectId, parsed.runId, principal);
      return {
        requestId: parsed.requestId,
        projectId: parsed.projectId,
        runId: parsed.runId,
        questionCount: questions.length,
        questions,
      };
    });

    this.register("video.v1.answer_run_question", (input, principal) => {
      const parsed = this.parse(AnswerRunQuestionInputSchema, input);
      const res = store.jobs.answerRunQuestion(parsed, principal);
      onProjectEvent(parsed.projectId);
      return res;
    });

    this.register("video.v1.set_model_policy", (input, principal) => {
      const parsed = this.parse(SetModelPolicyInputSchema, input);
      const policy = store.plans.setModelPolicy(parsed, principal);
      onProjectEvent(parsed.projectId);
      return { requestId: parsed.requestId, projectId: parsed.projectId, ...policy };
    });

    this.register("video.v1.get_model_policies", (input, principal) => {
      const parsed = this.parse(GetModelPoliciesInputSchema, input);
      const policies = store.plans.listModelPolicies(parsed.projectId, principal);
      return {
        requestId: parsed.requestId,
        projectId: parsed.projectId,
        policyCount: policies.length,
        policies,
        allowCloudModels: store.projects.cloudModelsAllowed(parsed.projectId),
      };
    });

    this.register("video.v1.remove_model_policy", (input, principal) => {
      const parsed = this.parse(RemoveModelPolicyInputSchema, input);
      const { removed } = store.plans.removeModelPolicy(parsed, principal);
      if (removed) onProjectEvent(parsed.projectId);
      return { requestId: parsed.requestId, projectId: parsed.projectId, removed };
    });

    this.register("video.v1.set_project_cloud_policy", (input, principal) => {
      const parsed = this.parse(SetProjectCloudPolicyInputSchema, input);
      const { allowCloudModels } = store.projects.setProjectCloudPolicy(parsed, principal);
      onProjectEvent(parsed.projectId);
      return { requestId: parsed.requestId, projectId: parsed.projectId, allowCloudModels };
    });

    this.register("video.v1.estimate_timeline", async (input, principal) => {
      const parsed = this.parse(EstimateTimelineRequestSchema, input);
      return store.plans.estimateTimeline(parsed, principal);
    });

    this.register("video.v1.analyze_asset", (input, principal) => {
      const parsed = this.parse(AnalyzeAssetInputSchema, input);
      const created = store.jobs.createAnalysisJob({ ...parsed, principal });
      if (!created.deduplicated) {
        jobs.enqueue(created.job.projectId, created.job.jobId);
      }
      onProjectEvent(created.job.projectId);
      return created;
    });

    this.register("video.v1.get_analysis", (input, principal) => {
      const parsed = this.parse(GetAnalysisInputSchema, input);
      return {
        requestId: parsed.requestId,
        ...store.jobs.analysisSummary(parsed.projectId, parsed.assetId, principal),
      };
    });

    this.register("video.v1.get_qa_summary", async (input, principal) => {
      const parsed = this.parse(GetQaSummaryInputSchema, input);
      return {
        requestId: parsed.requestId,
        projectId: parsed.projectId,
        ...(await queries.qaSummary(parsed.projectId, parsed.jobId, principal)),
      };
    });

    this.register("video.v1.get_export_summary", async (input, principal) => {
      const parsed = this.parse(GetExportSummaryInputSchema, input);
      return {
        requestId: parsed.requestId,
        ...(await queries.exportSummary(parsed.projectId, parsed.jobId, principal)),
      };
    });

    this.register("video.v1.verify_export", async (input, principal) => {
      const parsed = this.parse(VerifyExportInputSchema, input);
      return {
        requestId: parsed.requestId,
        projectId: parsed.projectId,
        ...(await store.jobs.verifyExport(parsed.projectId, parsed.jobId, principal)),
      };
    });

    this.register("video.v1.get_scene_cuts", async (input, principal) => {
      const parsed = this.parse(GetSceneCutsInputSchema, input);
      return {
        requestId: parsed.requestId,
        ...(await queries.sceneCuts(parsed.projectId, parsed.assetId, principal)),
      };
    });

    this.register("video.v1.get_waveform", async (input, principal) => {
      const parsed = this.parse(GetWaveformInputSchema, input);
      return {
        requestId: parsed.requestId,
        ...(await queries.waveform(parsed.projectId, parsed.assetId, principal)),
      };
    });

    this.register("video.v1.get_plan", (input, principal) => {
      const parsed = this.parse(GetPlanInputSchema, input);
      return {
        requestId: parsed.requestId,
        ...store.plans.getPlan(parsed.projectId, parsed.planId, principal),
      };
    });

    this.register("video.v1.list_artifacts", (input, principal) => {
      const parsed = this.parse(GetQaSummaryInputSchema, input);
      return {
        requestId: parsed.requestId,
        ...store.jobs.listArtifacts(parsed.projectId, parsed.jobId, principal),
      };
    });

    this.register("video.v1.get_asset_metadata", async (input, principal) => {
      const parsed = this.parse(GetAssetMetadataInputSchema, input);
      return {
        requestId: parsed.requestId,
        ...(await store.projects.assetMetadata(parsed.projectId, parsed.assetId, principal, parsed.requestedTrimRange)),
      };
    });

    this.register("video.v1.contact_sheet", async (input, principal) => {
      const parsed = this.parse(ContactSheetRequestSchema, input);
      const project = store.projects.getProjectSnapshot(parsed.projectId, principal);
      const asset = project.assets.find((a) => a.assetId === parsed.assetId);
      if (!asset) editorFailure("ASSET_NOT_FOUND", "The asset is not in this project");
      const maxTiles = parsed.maxTiles ? Number(parsed.maxTiles) : 12;
      const sheet = await backends.get("ffmpeg").contactSheet({
        asset,
        maxTiles,
        cas,
        signal: new AbortController().signal,
      });
      const artifactId = store.projects.registerContactSheet(
        parsed.projectId,
        project.revision,
        parsed.assetId,
        sheet.blob,
        principal,
      );
      return {
        artifactId,
        projectId: parsed.projectId,
        assetId: parsed.assetId,
        sourceSha256: asset.original.sha256,
        ...sheet,
      };
    });

    this.register("video.v1.preview_frames", async (input, principal) => {
      const parsed = this.parse(PreviewFramesRequestSchema, input);
      const candidate = store.jobs.reviewablePreview(parsed.projectId, parsed.jobId, principal);
      const maxTiles = parsed.maxTiles ? Number(parsed.maxTiles) : 12;
      const sheet = await backends.get("ffmpeg").previewFrames({
        candidate,
        maxTiles,
        cas,
        signal: new AbortController().signal,
      });
      const artifactId = queries.registerPreviewSheet(
        parsed.projectId,
        parsed.jobId,
        candidate.revision,
        sheet.blob,
        principal,
      );
      return {
        artifactId,
        projectId: parsed.projectId,
        assetId: candidate.artifactId,
        sourceSha256: candidate.blob.sha256,
        ...sheet,
      };
    });

    this.register("video.v1.read_asset_chunk", async (input, principal) => {
      const parsed = this.parse(ReadAssetChunkRequestSchema, input);
      const blob = queries.resolveChunkBlob(
        parsed.projectId,
        parsed.assetId,
        parsed.revision,
        principal,
      );
      const bytes = await cas.readChunk(blob, BigInt(parsed.offset), BigInt(parsed.length));
      return encodeFramedChunk(
        {
          offset: parsed.offset,
          bytesLength: String(bytes.byteLength),
          totalBytes: blob.bytes,
          revision: parsed.revision,
          chunkSha256: createHash("sha256").update(bytes).digest("hex"),
          assetSha256: blob.sha256,
          protocolVersion: "1",
        },
        bytes,
      );
    });

    this.register("video.v1.create_upload", (input, principal) => {
      const parsed = this.parse(CreateUploadRequestSchema, input);
      return store.projects.createUpload({ ...parsed, principal });
    });

    this.register("video.v1.write_upload_chunk", async (input, principal) => {
      if (!(input instanceof Uint8Array)) {
        editorFailure("INVALID_ARGUMENT", "Upload chunk must be binary framed bytes");
      }
      const { metadata, payload } = decodeFramedChunk(input);
      const header = this.parse(
        WriteUploadChunkSchema,
        JSON.parse(new TextDecoder().decode(metadata)),
      );
      if (BigInt(header.length) !== BigInt(payload.byteLength)) {
        editorFailure("INVALID_ARGUMENT", "Chunk header length does not match payload bytes");
      }
      if (createHash("sha256").update(payload).digest("hex") !== header.chunkSha256) {
        editorFailure("ARTIFACT_HASH_MISMATCH", "Chunk SHA-256 mismatch");
      }
      const nextOffset = await uploads.writeUploadChunk(
        header.uploadId,
        header.offset,
        payload,
        principal,
      );
      return new TextEncoder().encode(
        JSON.stringify({ uploadId: header.uploadId, nextOffset }),
      );
    });

    this.register("video.v1.cancel_upload", async (input, principal) => {
      const parsed = this.parse(CancelUploadRequestSchema, input);
      const res = await uploads.cancelUpload(parsed, principal);
      onProjectEvent(parsed.projectId);
      return res;
    });

    this.register("video.v1.get_upload_status", (input, principal) => {
      const parsed = this.parse(UploadRequestSchema, input);
      return store.projects.getUploadStatus(parsed.projectId, parsed.uploadId, principal);
    });

    this.register("video.v1.commit_upload", async (input, principal) => {
      const parsed = this.parse(CommitUploadRequestSchema, input);
      const { projectId, asset } = await uploads.commitUpload(
        parsed.uploadId,
        parsed.requestId,
        parsed.finalSha256,
        principal,
      );
      onProjectEvent(projectId);
      return asset;
    });

    this.register("video.v1.import_asset", () => {
      editorFailure(
        "PERMISSION_DENIED",
        "Direct server filesystem import is disabled; upload bytes via chunked upload",
      );
    });

    // Device pairing & revocation (stored in SQLite)
    this.register("video.v1.create_invitation", (input) => {
      const parsed = this.parse(CreateInvitationSchema, input);
      return store.devices.createInvitation(parsed);
    });

    this.register("video.v1.redeem_invitation", (input) => {
      const parsed = this.parse(RedeemInvitationSchema, input);
      return store.devices.redeemInvitation(parsed.invitationId, parsed.token);
    });

    this.register("video.v1.revoke_device", (input) => {
      const parsed = this.parse(RevokeDeviceSchema, input);
      store.devices.revokeDevice(parsed.deviceId);
      return { deviceId: parsed.deviceId, revoked: true };
    });

    const dispatchObjectWorker = (workflow: ReturnType<typeof store.objectEdits.openObjectEdit>) => {
      if (workflow.workerJobId) jobs.enqueue(workflow.projectId, workflow.workerJobId);
      onProjectEvent(workflow.projectId);
      return { workflow };
    };
    // Copilot object-edit state machine
    this.register("video.v1.open_object_edit", (input, principal) => {
      const parsed = this.parse(OpenObjectEditRequestSchema, input);
      return dispatchObjectWorker(store.objectEdits.openObjectEdit({ ...parsed, actor: principal }));
    });

    this.register("video.v1.record_object_candidates", (input, principal) => {
      const parsed = this.parse(RecordObjectCandidatesRequestSchema, input);
      return {
        workflow: store.objectEdits.recordObjectCandidates({ ...parsed, actor: principal }),
      };
    });

    this.register("video.v1.decide_object_target", (input, principal) => {
      const parsed = this.parse(DecideObjectTargetRequestSchema, input);
      return dispatchObjectWorker(store.objectEdits.decideObjectTarget({ ...parsed, actor: principal }));
    });

    this.register("video.v1.review_object_mask", async (input, principal) => {
      const parsed = this.parse(ReviewObjectMaskRequestSchema, input);
      const workflow = store.objectEdits.getObjectEdit(parsed.projectId, parsed.workflowId, principal);
      if (parsed.approved && workflow.maskRevisionId === parsed.maskRevisionId && workflow.maskApprovalId) {
        await store.objectEdits.verifyPendingMask(workflow.maskApprovalId, principal);
      }
      return dispatchObjectWorker(store.objectEdits.reviewObjectMask({ ...parsed, actor: principal }));
    });

    this.register("video.v1.record_object_qa", (input, principal) => {
      const parsed = this.parse(RecordObjectQaRequestSchema, input);
      return { workflow: store.objectEdits.recordObjectQa({ ...parsed, actor: principal }) };
    });

    this.register("video.v1.list_object_edits", (input, principal) => {
      const parsed = this.parse(ListObjectEditsRequestSchema, input);
      return {
        workflows: store.objectEdits.listObjectEdits(
          parsed.projectId,
          parsed.assetId,
          principal,
        ),
      };
    });

    this.register("video.v1.get_object_edit", (input, principal) => {
      const parsed = this.parse(ObjectEditRequestSchema, input);
      return {
        workflow: store.objectEdits.getObjectEdit(parsed.projectId, parsed.workflowId, principal),
      };
    });

    // Mask & VACE hooks (wired in R4 media-worker)
    this.register("video.v1.inspect_frame", async (input, principal) => {
      const parsed = this.parse(InspectFrameRequestSchema, input);
      if (!this.mediaWorker) {
        editorFailure(
          "CAPABILITY_UNAVAILABLE",
          "Mask frame inspector is not configured in deterministic R2 mode",
        );
      }
      return this.mediaWorker.inspectFrame(parsed, principal);
    });

    this.register("video.v1.create_mask_revision", async (input, principal) => {
      const parsed = this.parse(CreateMaskRevisionRequestSchema, input);
      if (!this.mediaWorker) {
        editorFailure(
          "CAPABILITY_UNAVAILABLE",
          "Mask revision worker is not configured in deterministic R2 mode",
        );
      }
      return this.mediaWorker.createMaskRevision(parsed, principal);
    });

    this.register("video.v1.get_mask_revision", async (input, principal) => {
      const parsed = this.parse(MaskRevisionReviewRequestSchema, input);
      if (!this.mediaWorker) {
        editorFailure(
          "CAPABILITY_UNAVAILABLE",
          "Mask revision reader is not configured in deterministic R2 mode",
        );
      }
      return this.mediaWorker.readMaskRevision(parsed.projectId, parsed.maskRevisionId, principal);
    });

    this.register("video.v1.track_mask", (input, principal) => {
      const parsed = this.parse(TrackMaskRequestSchema, input);
      if (!this.mediaWorker?.hasMaskTracking()) {
        editorFailure(
          "CAPABILITY_UNAVAILABLE",
          "Mask tracking worker is not configured in deterministic R2 mode",
        );
      }
      const created = store.jobs.createTrackingJob(parsed, principal);
      if (!created.deduplicated) jobs.enqueue(created.job.projectId, created.job.jobId);
      onProjectEvent(created.job.projectId);
      return created;
    });

    this.register("video.v1.request_tracked_mask_review", (input, principal) => {
      const parsed = this.parse(RequestTrackedMaskReviewSchema, input);
      const approval = store.objectEdits.requestTrackedMaskReview(parsed, principal);
      onProjectEvent(parsed.projectId);
      return approval;
    });

    this.register("video.v1.propose_vace_preview", async (input, principal) => {
      const parsed = this.parse(ProposeVacePreviewSchema, input);
      if (!this.mediaWorker?.hasVace()) {
        editorFailure(
          "CAPABILITY_UNAVAILABLE",
          "VACE generation worker is not configured in deterministic R2 mode",
        );
      }
      const result = await this.mediaWorker.proposeVacePreview(parsed, principal);
      onProjectEvent(parsed.projectId);
      return result;
    });

    // Planning run lifecycle hooks (wired in R3 planner-worker)
    this.register("video.v1.start_planning_run", async (input, principal) => {
      const parsed = this.parse(StartPlanningRunInputSchema, input);
      if (!this.planner) {
        editorFailure(
          "CAPABILITY_UNAVAILABLE",
          "Native planner worker is not attached in R2 mode (arrives in R3)",
        );
      }
      const res = await this.planner.startRun(parsed, principal);
      onProjectEvent(parsed.projectId);
      return res;
    });

    this.register("video.v1.steer_planning_run", async (input, principal) => {
      const parsed = this.parse(SteerPlanningRunInputSchema, input);
      if (!this.planner) {
        editorFailure("CAPABILITY_UNAVAILABLE", "Native planner worker is not attached");
      }
      return this.planner.steerRun(parsed, principal);
    });

    this.register("video.v1.follow_up_planning_run", async (input, principal) => {
      const parsed = this.parse(SteerPlanningRunInputSchema, input);
      if (!this.planner) {
        editorFailure("CAPABILITY_UNAVAILABLE", "Native planner worker is not attached");
      }
      return this.planner.followUpRun(parsed, principal);
    });

    this.register("video.v1.stop_planning_run", async (input, principal) => {
      const parsed = this.parse(PlanningRunRequestSchema, input);
      if (!this.planner) {
        editorFailure("CAPABILITY_UNAVAILABLE", "Native planner worker is not attached");
      }
      return this.planner.stopRun(parsed.projectId, parsed.runId, principal);
    });

    this.register("video.v1.get_planning_run", (input, principal) => {
      const parsed = this.parse(PlanningRunRequestSchema, input);
      if (this.planner) {
        return this.planner.status(parsed.projectId, parsed.runId, principal);
      }
      return store.jobs.planningRunStatus(parsed.projectId, parsed.runId, principal);
    });
  }
}
