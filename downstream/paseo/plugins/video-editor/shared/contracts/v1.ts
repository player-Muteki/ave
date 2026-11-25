import { z } from "zod";

export const VIDEO_PROTOCOL_VERSION = "1" as const;
export const VIDEO_PLUGIN_ID = "video-editor" as const;
export const VACE_PROFILE = "vace-local-9f-480p-v1";
export const VACE_MODEL = "ec4d2cb062b548996b179d493fdd05340de702a1";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const requestId = id;
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const uint = z.string().regex(/^(0|[1-9][0-9]*)$/);

export const RationalSchema = z
  .object({
    num: z.string().regex(/^-?(0|[1-9][0-9]*)$/),
    den: z.string().regex(/^[1-9][0-9]*$/),
  })
  .strict();
export type Rational = z.infer<typeof RationalSchema>;

export const TimeRangeSchema = z
  .object({ start: RationalSchema, duration: RationalSchema })
  .strict();
export type TimeRange = z.infer<typeof TimeRangeSchema>;

export const BlobRefSchema = z
  .object({ sha256, bytes: uint, mediaType: z.string().min(1).max(128) })
  .strict();
export type BlobRef = z.infer<typeof BlobRefSchema>;

export const AssetStreamRefSchema = z
  .object({
    assetId: id,
    assetContentHash: sha256,
    streamUid: id,
    probeRevision: uint,
  })
  .strict();
export type AssetStreamRef = z.infer<typeof AssetStreamRefSchema>;

export const StreamDescriptorSchema = z
  .object({
    streamUid: id,
    streamIndex: z.number().int().nonnegative(),
    kind: z.enum(["video", "audio", "subtitle", "attachment", "data"]),
    codec: z.string().min(1),
    codecProfile: z.string().optional(),
    timeBase: RationalSchema,
    averageRate: RationalSchema.optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    sampleRate: z.number().int().positive().optional(),
    channels: z.number().int().positive().optional(),
    channelLayout: z.string().optional(),
    language: z.string().optional(),
    disposition: z.record(z.string(), z.number()),
    color: z.record(z.string(), z.string()).optional(),
    sampleAspectRatio: z.string().optional(),
    rotation: z.string().optional(),
  })
  .strict();
export type StreamDescriptor = z.infer<typeof StreamDescriptorSchema>;

export const SourceAssetSchema = z
  .object({
    assetId: id,
    original: BlobRefSchema,
    displayName: z.string().min(1).max(512),
    streams: z.array(StreamDescriptorSchema),
    presentationIndex: BlobRefSchema,
    probe: BlobRefSchema,
    proxy: BlobRefSchema.optional(),
    sourceNeverWritable: z.literal(true),
  })
  .strict();
export type SourceAsset = z.infer<typeof SourceAssetSchema>;

const TrimOperationSchema = z
  .object({
    opId: id,
    order: uint,
    trackId: id,
    clipId: id,
    source: AssetStreamRefSchema,
    sourceRange: TimeRangeSchema,
    recordRange: TimeRangeSchema,
    // Overlay placement, only meaningful on v2 overlay-track segments.
    overlayX: uint.optional(),
    overlayY: uint.optional(),
    // Optional video fade in/out at this segment's edges (seconds).
    fadeIn: RationalSchema.optional(),
    fadeOut: RationalSchema.optional(),
  })
  .strict();
const TransformOperationSchema = TrimOperationSchema.extend({
  crop: z.object({ x: uint, y: uint, width: uint, height: uint }).strict(),
  scale: z.object({ width: uint, height: uint }).strict(),
  rotationDegrees: z.enum(["0", "90", "180", "270"]),
}).strict();
const AudioOperationSchema = TrimOperationSchema.extend({
  gainMilli: z.string().regex(/^-?(0|[1-9][0-9]*)$/),
  mute: z.boolean(),
  fadeIn: RationalSchema.optional(),
  fadeOut: RationalSchema.optional(),
}).strict();
const TransitionOperationSchema = z
  .object({
    opId: id,
    order: uint,
    trackId: id,
    clipId: id,
    leftClipId: id,
    rightClipId: id,
    kind: z.enum(["crossfade", "fade"]),
    duration: RationalSchema,
  })
  .strict();
const SubtitleOperationSchema = z
  .object({
    opId: id,
    order: uint,
    trackId: id,
    clipId: id,
    cueId: id,
    range: TimeRangeSchema,
    text: z.string().max(16_384),
    mode: z.enum(["metadata", "burn-in"]),
  })
  .strict();
const GenerationRequestSchema = z
  .object({
    requestId: id,
    shotId: id,
    providerProfileId: id,
    modelId: id,
    prompt: z.string().min(1).max(16_384),
    negativePrompt: z.string().max(16_384),
    maskRevisionId: id,
    maskApprovalId: id.optional(),
    referenceAssetIds: z.array(id).max(16),
    referenceManifestHash: sha256,
    samplingMapHash: sha256,
    frameCount: uint,
    sampleFps: RationalSchema,
    seedPolicy: z.enum(["fixed", "random"]),
    seed: uint,
    maxCostMicros: uint,
  })
  .strict();
const QaRequirementSchema = z
  .object({ gate: z.enum(["G0", "G1", "G2", "G3", "G4", "G5"]), required: z.boolean() })
  .strict();

export const EditPlanDraftV1Schema = z
  .object({
    schemaVersion: z.literal("video.edit-plan/v1"),
    projectId: id,
    baseTimelineRevision: uint,
    baseAssetManifestHash: sha256,
    preferredDeterministicBackendId: z.enum(["ffmpeg", "filmcraft"]).optional(),
    intent: z.string().min(1).max(16_384),
    trimOperations: z.array(TrimOperationSchema).max(1024),
    transformOperations: z.array(TransformOperationSchema).max(1024),
    audioOperations: z.array(AudioOperationSchema).max(1024),
    transitionOperations: z.array(TransitionOperationSchema).max(1024),
    subtitleOperations: z.array(SubtitleOperationSchema).max(4096),
    generationRequests: z.array(GenerationRequestSchema).max(64),
    qaRequirements: z.array(QaRequirementSchema).max(6),
    externalDestinations: z.array(z.string().max(2048)).max(32),
    maxCostMicros: uint,
  })
  .strict();
export type EditPlanDraftV1 = z.infer<typeof EditPlanDraftV1Schema>;

export const AcceptedEditPlanSchema = EditPlanDraftV1Schema.extend({
  deterministicBackendId: z.enum(["ffmpeg", "filmcraft"]),
  planId: id,
  revision: uint,
  runId: id,
  idempotencyKey: id,
  planHash: sha256,
  status: z.literal("proposed"),
}).strict();
export type AcceptedEditPlan = z.infer<typeof AcceptedEditPlanSchema>;

export const EditorRoleSchema = z.enum(["viewer", "operator", "owner"]);
export type EditorRole = z.infer<typeof EditorRoleSchema>;
export const EditorPrincipalSchema = z
  .object({
    principalId: z.string().min(1).max(256),
    role: EditorRoleSchema,
    projectIds: z.array(id).nullable(),
  })
  .strict();
export type EditorPrincipal = z.infer<typeof EditorPrincipalSchema>;

export const EditorErrorSchema = z
  .object({
    code: z.string().min(1),
    retryable: z.boolean(),
    sanitizedDetail: z.string().max(2048),
  })
  .strict();

export const ApprovalRequestSchema = z
  .object({
    approvalId: id,
    projectId: id,
    subjectType: z.enum([
      "mask_revision",
      "keyframe_set",
      "edit_plan",
      "candidate_revision",
      "export",
    ]),
    subjectId: id,
    subjectRevision: uint,
    subjectHash: sha256,
    planHash: sha256.optional(),
    baseTimelineRevision: uint,
    purpose: z.enum(["input", "preview", "final", "export"]),
    requiredInputs: z.array(
      z.object({ type: z.string(), id, revision: uint, hash: sha256 }).strict(),
    ),
    diffSummary: z
      .object({
        intent: z.string(),
        operationCount: z.number().int().nonnegative(),
        summary: z.string(),
      })
      .strict(),
    generationCostCapMicros: uint,
    externalDestinations: z.array(z.string()),
    status: z.enum(["pending", "approved", "rejected", "superseded", "expired", "revoked"]),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalDecisionSchema = z
  .object({
    requestId,
    approvalId: id,
    expectedRevision: uint,
    decision: z.enum(["approve", "reject"]),
    comment: z.string().max(4096).optional(),
  })
  .strict();
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalGrantSchema = z
  .object({
    grantId: id,
    approvalId: id,
    projectId: id,
    subjectHash: sha256,
    planHash: sha256.optional(),
    baseTimelineRevision: uint,
    purpose: z.enum(["preview", "final", "export"]),
    approvedByDeviceId: z.string().min(1),
    approvedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    consumedAt: z.string().datetime().optional(),
    revokedReason: z.string().optional(),
  })
  .strict();
export type ApprovalGrant = z.infer<typeof ApprovalGrantSchema>;

export const JobStateSchema = z.enum([
  "draft",
  "analyzing",
  "awaiting_plan_approval",
  "awaiting_inputs",
  "rendering_preview",
  "awaiting_review",
  "rendering_final",
  "validating",
  "awaiting_delivery_approval",
  "pausing",
  "paused",
  "completed",
  "failed",
  "cancel_requested",
  "cancelled",
]);
export type JobState = z.infer<typeof JobStateSchema>;

export const ArtifactRefSchema = z
  .object({
    artifactId: id,
    projectId: id,
    jobId: id,
    revision: uint,
    kind: z.enum(["probe", "proxy", "mask", "candidate", "export", "qa", "manifest", "contact", "scenecuts", "waveform"]),
    blob: BlobRefSchema,
  })
  .strict();
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const JobSnapshotSchema = z
  .object({
    jobId: id,
    projectId: id,
    revision: uint,
    planHash: sha256,
    approvalId: id.optional(),
    candidateRevision: uint.optional(),
    parentRevision: uint.optional(),
    kind: z.enum(["analysis", "preview", "final", "export"]),
    state: JobStateSchema,
    phaseDetail: z.string().optional(),
    progress: z.object({ completedUnits: uint, totalUnits: uint.optional() }).strict().optional(),
    artifacts: z.array(ArtifactRefSchema),
    error: EditorErrorSchema.optional(),
    analysisAssetId: id.optional(),
    analysisRate: z
      .string()
      .regex(/^[1-9][0-9]*\/[1-9][0-9]*$/)
      .optional(),
  })
  .strict();
export type JobSnapshot = z.infer<typeof JobSnapshotSchema>;

export const EditorEventSchema = z
  .object({
    protocolVersion: z.literal(VIDEO_PROTOCOL_VERSION),
    projectId: id,
    sessionId: id.optional(),
    runId: id.optional(),
    jobId: id.optional(),
    eventId: id,
    seq: uint,
    causationId: id.optional(),
    occurredAt: z.string().datetime(),
    type: z.string().min(1),
    payload: z.unknown(),
  })
  .strict();
export type EditorEvent = z.infer<typeof EditorEventSchema>;

export const ProjectSnapshotSchema = z
  .object({
    protocolVersion: z.literal(VIDEO_PROTOCOL_VERSION),
    projectId: id,
    title: z.string(),
    revision: uint,
    baseAssetManifestHash: sha256,
    assets: z.array(SourceAssetSchema),
    plans: z.array(AcceptedEditPlanSchema),
    approvals: z.array(ApprovalRequestSchema),
    jobs: z.array(JobSnapshotSchema),
    latestSeq: uint,
  })
  .strict();
export type ProjectSnapshot = z.infer<typeof ProjectSnapshotSchema>;

export const WorkerProfileSchema = z
  .object({
    profileId: id,
    engine: z.string(),
    modelDigest: sha256.optional(),
    maxFrames: uint.optional(),
    maxWidth: z.number().int().positive().optional(),
    maxHeight: z.number().int().positive().optional(),
    colorSpaces: z.array(z.string()),
  })
  .strict();

export const CapabilitySetSchema = z
  .object({
    protocolVersion: z.literal(VIDEO_PROTOCOL_VERSION),
    features: z.array(z.string()),
    operations: z.array(z.string()),
    deterministicBackends: z.array(
      z
        .object({
          id: z.enum(["ffmpeg", "filmcraft"]),
          available: z.boolean(),
          reason: z.string().optional(),
          version: z.string().optional(),
        })
        .strict(),
    ),
    workerProfiles: z.array(WorkerProfileSchema),
  })
  .strict();
export type CapabilitySet = z.infer<typeof CapabilitySetSchema>;

export const CreateProjectInputSchema = z
  .object({ requestId, title: z.string().min(1).max(256).regex(/\S/).trim() })
  .strict();
export const ProjectRequestSchema = z.object({ projectId: id }).strict();
// The daemon binds the principal, project and run to the worker channel. They
// are never selected by a model-supplied envelope.
const toolEnvelope = z.object({ protocolVersion: z.literal("1"), toolCallId: id }).strict();
export const VideoToolCallSchema = z.discriminatedUnion("tool", [
  toolEnvelope.extend({ tool: z.literal("get_project_snapshot"), args: ProjectRequestSchema }),
  toolEnvelope.extend({
    tool: z.literal("get_asset_metadata"),
    args: z.object({ assetId: id, contentHash: sha256 }).strict(),
  }),
  toolEnvelope.extend({
    tool: z.literal("get_job_status"),
    args: z.object({ jobId: id }).strict(),
  }),
  toolEnvelope.extend({ tool: z.literal("validate_edit_plan"), args: EditPlanDraftV1Schema }),
  toolEnvelope.extend({ tool: z.literal("estimate_timeline"), args: EditPlanDraftV1Schema }),
  toolEnvelope.extend({ tool: z.literal("submit_edit_plan"), args: EditPlanDraftV1Schema }),
  toolEnvelope.extend({
    tool: z.literal("get_contact_sheet"),
    args: z.object({ assetId: id, contentHash: sha256 }).strict(),
  }),
  toolEnvelope.extend({ tool: z.literal("get_qa_report"), args: z.object({ jobId: id }).strict() }),
  toolEnvelope.extend({
    tool: z.literal("get_analysis"),
    args: z.object({ assetId: id, contentHash: sha256 }).strict(),
  }),
  toolEnvelope.extend({ tool: z.literal("get_plan"), args: z.object({ planId: id }).strict() }),
  toolEnvelope.extend({
    tool: z.literal("get_scene_cuts"),
    args: z.object({ assetId: id, contentHash: sha256 }).strict(),
  }),
  toolEnvelope.extend({
    tool: z.literal("get_waveform"),
    args: z.object({ assetId: id, contentHash: sha256 }).strict(),
  }),
  toolEnvelope.extend({ tool: z.literal("get_planning_run"), args: ProjectRequestSchema }),
  toolEnvelope.extend({
    tool: z.literal("diff_plans"),
    args: z.object({ planId: id, draft: EditPlanDraftV1Schema }).strict(),
  }),
  toolEnvelope.extend({ tool: z.literal("get_qa_summary"), args: z.object({ jobId: id }).strict() }),
]);
export const PlanReviewRequestSchema = z
  .object({
    requestId,
    runId: id,
    toolCallId: id,
    draft: EditPlanDraftV1Schema,
  })
  .strict();
export const PlanReviewResultSchema = z
  .object({ plan: AcceptedEditPlanSchema, approval: ApprovalRequestSchema })
  .strict();
export const DecideApprovalResultSchema = z
  .object({
    approval: ApprovalRequestSchema,
    grant: ApprovalGrantSchema.optional(),
  })
  .strict();
export const CreateJobRequestSchema = z
  .object({
    requestId,
    projectId: id,
    approvalId: id,
    grantId: id,
    expectedRevision: uint,
  })
  .strict();
export const CreateJobResultSchema = z
  .object({ job: JobSnapshotSchema, deduplicated: z.boolean() })
  .strict();
export const JobRequestSchema = z.object({ projectId: id, jobId: id }).strict();
export const JobControlRequestSchema = JobRequestSchema.extend({
  requestId,
  action: z.enum(["cancel", "pause", "resume", "retry"]),
}).strict();
export const EventsRequestSchema = z.object({ projectId: id, afterSeq: uint }).strict();
export const EventsResultSchema = z
  .object({ events: z.array(EditorEventSchema), snapshotRequired: z.boolean() })
  .strict();

export const ReadAssetChunkRequestSchema = z
  .object({
    projectId: id,
    assetId: id,
    revision: uint,
    offset: uint,
    length: z.string().regex(/^[1-9][0-9]*$/),
  })
  .strict();
export type ReadAssetChunkRequest = z.infer<typeof ReadAssetChunkRequestSchema>;

export const ReadAssetChunkMetadataSchema = z
  .object({
    offset: uint,
    bytesLength: uint,
    totalBytes: uint,
    revision: uint,
    chunkSha256: sha256,
    assetSha256: sha256,
    protocolVersion: z.literal(VIDEO_PROTOCOL_VERSION),
  })
  .strict();

export const CreateUploadRequestSchema = z
  .object({
    requestId,
    projectId: id,
    displayName: z.string().min(1).max(512),
    expectedSize: uint,
    expectedSha256: sha256,
    mediaType: z.string().min(1).max(128),
  })
  .strict();
export const UploadStatusSchema = z
  .object({ uploadId: id, chunkSize: uint, nextOffset: uint })
  .strict();
export const WriteUploadChunkSchema = z
  .object({ requestId, uploadId: id, offset: uint, length: uint, chunkSha256: sha256 })
  .strict();
export const CommitUploadRequestSchema = z
  .object({ requestId, uploadId: id, finalSha256: sha256 })
  .strict();
export const UploadRequestSchema = z.object({ projectId: id, uploadId: id }).strict();

export const getCapabilitiesRpc = {
  name: "video.v1.get_capabilities",
  input: z.object({}).strict(),
  output: CapabilitySetSchema,
};
export const createProjectRpc = {
  name: "video.v1.create_project",
  input: CreateProjectInputSchema,
  output: ProjectSnapshotSchema,
};
export const getProjectRpc = {
  name: "video.v1.get_project",
  input: ProjectRequestSchema,
  output: ProjectSnapshotSchema,
};
export const listProjectsRpc = {
  name: "video.v1.list_projects",
  input: z.object({}).strict(),
  // Inline output keeps the generated schema bundle unchanged; summaries are not a fixture target.
  output: z
    .object({
      projects: z.array(z.object({ projectId: id, title: z.string(), revision: z.string() }).strict()),
    })
    .strict(),
};
export const submitPlanRpc = {
  name: "video.v1.submit_plan",
  input: PlanReviewRequestSchema,
  output: PlanReviewResultSchema,
};

export const EstimateTimelineRequestSchema = z
  .object({ requestId, draft: EditPlanDraftV1Schema })
  .strict();
export type EstimateTimelineRequest = z.infer<typeof EstimateTimelineRequestSchema>;
export const TimelineSegmentSummarySchema = z
  .object({
    clipId: id,
    trackId: id,
    startSeconds: z.string(),
    durationSeconds: z.string(),
    sourceAssetId: id,
  })
  .strict();
export const EstimateTimelineResultSchema = z
  .object({
    requestId,
    projectId: id,
    valid: z.boolean(),
    issue: z.string().nullable(),
    mainTrackSegments: z.number().int().min(0),
    overlayTrackSegments: z.number().int().min(0),
    mainDurationSeconds: z.string(),
    overlayDurationSeconds: z.string(),
    transitionCount: z.number().int().min(0),
    transitionOverlapSeconds: z.string(),
    effectiveMainDurationSeconds: z.string(),
    audioOperationCount: z.number().int().min(0),
    transformCount: z.number().int().min(0),
    subtitleCueCount: z.number().int().min(0),
    segments: z.array(TimelineSegmentSummarySchema).max(64),
  })
  .strict();
export type EstimateTimelineResult = z.infer<typeof EstimateTimelineResultSchema>;
export const estimateTimelineRpc = {
  name: "video.v1.estimate_timeline",
  input: EstimateTimelineRequestSchema,
  output: EstimateTimelineResultSchema,
};
export const decideApprovalRpc = {
  name: "video.v1.decide_approval",
  input: ApprovalDecisionSchema,
  output: DecideApprovalResultSchema,
};
export const createJobRpc = {
  name: "video.v1.create_job",
  input: CreateJobRequestSchema,
  output: CreateJobResultSchema,
};
export const getJobRpc = {
  name: "video.v1.get_job",
  input: JobRequestSchema,
  output: JobSnapshotSchema,
};
export const controlJobRpc = {
  name: "video.v1.control_job",
  input: JobControlRequestSchema,
  output: JobSnapshotSchema,
};
export const getEventsRpc = {
  name: "video.v1.get_events",
  input: EventsRequestSchema,
  output: EventsResultSchema,
};
export const createUploadRpc = {
  name: "video.v1.create_upload",
  input: CreateUploadRequestSchema,
  output: UploadStatusSchema,
};
export const writeUploadChunkRpc = {
  name: "video.v1.write_upload_chunk",
  // The JSON schema describes the frame header; the RPC takes the complete binary frame.
  input: z.instanceof(Uint8Array),
  output: z.instanceof(Uint8Array),
};
export const getUploadStatusRpc = {
  name: "video.v1.get_upload_status",
  input: UploadRequestSchema,
  output: UploadStatusSchema,
};
export const commitUploadRpc = {
  name: "video.v1.commit_upload",
  input: CommitUploadRequestSchema,
  output: SourceAssetSchema,
};
export const AnalyzeAssetInputSchema = z
  .object({
    requestId,
    projectId: id,
    assetId: id,
    rate: z
      .string()
      .regex(/^[1-9][0-9]*\/[1-9][0-9]*$/)
      .optional(),
  })
  .strict();
export type AnalyzeAssetInput = z.infer<typeof AnalyzeAssetInputSchema>;

export const readAssetChunkRpc = {
  name: "video.v1.read_asset_chunk",
  input: ReadAssetChunkRequestSchema,
  output: z.instanceof(Uint8Array),
};

export const PlanningRunRequestSchema = z
  .object({ projectId: id, runId: id })
  .strict();
export type PlanningRunRequest = z.infer<typeof PlanningRunRequestSchema>;

export const StartPlanningRunInputSchema = z
  .object({
    requestId,
    projectId: id,
    prompt: z.string().min(1).max(64_000),
    model: z
      .object({ provider: z.string().min(1), id: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();
export type StartPlanningRunInput = z.infer<typeof StartPlanningRunInputSchema>;

export const SteerPlanningRunInputSchema = z
  .object({ requestId, projectId: id, runId: id, text: z.string().min(1).max(64_000) })
  .strict();
export type SteerPlanningRunInput = z.infer<typeof SteerPlanningRunInputSchema>;

export const PlanningRunStatusSchema = z
  .object({
    runId: id,
    projectId: id,
    sessionId: id.optional(),
    state: z.enum(["running", "awaiting_input", "settled", "interrupted", "failed"]),
    workerPid: z.number().int().optional(),
  })
  .strict();
export type PlanningRunStatus = z.infer<typeof PlanningRunStatusSchema>;

export const startPlanningRunRpc = {
  name: "video.v1.start_planning_run",
  input: StartPlanningRunInputSchema,
  output: PlanningRunStatusSchema,
};
export const steerPlanningRunRpc = {
  name: "video.v1.steer_planning_run",
  input: SteerPlanningRunInputSchema,
  output: PlanningRunStatusSchema,
};
export const followUpPlanningRunRpc = {
  name: "video.v1.follow_up_planning_run",
  input: SteerPlanningRunInputSchema,
  output: PlanningRunStatusSchema,
};
export const stopPlanningRunRpc = {
  name: "video.v1.stop_planning_run",
  input: PlanningRunRequestSchema,
  output: PlanningRunStatusSchema,
};
export const InspectFrameRequestSchema = z.object({
  projectId: id, assetId: id, streamUid: id, sourcePresentationIndexHash: sha256,
  frame: z.number().int().min(0).max(2_147_483_647),
  points: z.array(z.object({
    x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), foreground: z.boolean(),
  }).strict()).max(32),
}).strict();
export type InspectFrameRequest = z.infer<typeof InspectFrameRequestSchema>;

export const InspectFrameHeaderSchema = InspectFrameRequestSchema.extend({
  sourceSha256: sha256, pts: z.string().regex(/^-?[0-9]+$/), timeBase: RationalSchema,
  frameCount: z.number().int().positive(),
  width: z.number().int().positive(), height: z.number().int().positive(),
  previewWidth: z.number().int().positive().max(640), previewHeight: z.number().int().positive().max(640),
  previewSha256: sha256,
  mask: z.object({
    engine: z.literal("sam2.1-tiny"), weightsSha256: sha256, labelSha256: sha256,
    foregroundPixels: z.number().int().nonnegative(),
  }).strict().optional(),
});
export type InspectFrameHeader = z.infer<typeof InspectFrameHeaderSchema>;
export const CreateMaskRevisionRequestSchema = z.object({
  requestId, expectedRevision: uint, anchor: InspectFrameRequestSchema,
  expectedLabelSha256: sha256, expectedPreviewSha256: sha256,
}).strict();
export type CreateMaskRevisionRequest = z.infer<typeof CreateMaskRevisionRequestSchema>;
export const MaskAnchorRevisionSchema = z.object({
  schemaVersion: z.literal("video.mask-anchor/v1"), maskRevisionId: id, projectId: id,
  baseTimelineRevision: uint, anchor: InspectFrameHeaderSchema.required({ mask: true }),
  rotation: z.string(), sampleAspectRatio: z.string(),
  rawLabelMask: BlobRefSchema, reviewImage: BlobRefSchema,
}).strict();
export type MaskAnchorRevision = z.infer<typeof MaskAnchorRevisionSchema>;
export const MaskRevisionReviewRequestSchema = z.object({ projectId: id, maskRevisionId: id }).strict();
export const TrackMaskRequestSchema = z.object({
  projectId: id, requestId, expectedRevision: uint, anchorApprovalId: id, anchorHash: sha256,
  firstFrame: z.number().int().nonnegative(), frameCount: z.number().int().min(2).max(81),
}).strict();
export type TrackMaskRequest = z.infer<typeof TrackMaskRequestSchema>;
export const TrackedMaskManifestSchema = z.object({
  schemaVersion: z.literal("video.tracked-mask/v1"), projectId: id, jobId: id,
  anchorApprovalId: id, anchorHash: sha256, maskRevisionId: id,
  sourceSha256: sha256, sourcePresentationIndexHash: sha256, assetId: id, streamUid: id,
  engine: z.literal("sam2.1-tiny"), weightsSha256: sha256, anchorFrame: z.number().int().nonnegative(),
  width: z.number().int().positive(), height: z.number().int().positive(), timeBase: RationalSchema,
  frames: z.array(z.object({ sourceFrame: z.number().int().nonnegative(), pts: z.string().regex(/^-?[0-9]+$/),
    foregroundPixels: z.number().int().nonnegative(), label: BlobRefSchema }).strict()).min(2).max(81),
  reviewImageRate: z.literal(9), reviewVideo: BlobRefSchema,
}).strict();
export const ProposeVacePreviewSchema = z.object({
  projectId: id, requestId, expectedRevision: uint, maskApprovalId: id, manifestHash: sha256,
  prompt:z.string().trim().min(1).max(2048), negativePrompt:z.string().max(2048), seed:z.number().int().min(0).max(4294967295),
}).strict();
export type ProposeVacePreview = z.infer<typeof ProposeVacePreviewSchema>;
export const proposeVacePreviewRpc = {name:"video.v1.propose_vace_preview",input:ProposeVacePreviewSchema,output:PlanReviewResultSchema};

export const RequestTrackedMaskReviewSchema = z.object({
  projectId: id, requestId, jobId: id, expectedRevision: uint, manifestHash: sha256, reviewHash: sha256,
}).strict();
export type RequestTrackedMaskReview = z.infer<typeof RequestTrackedMaskReviewSchema>;
export const requestTrackedMaskReviewRpc = {
  name: "video.v1.request_tracked_mask_review", input: RequestTrackedMaskReviewSchema, output: ApprovalRequestSchema,
};
export const trackMaskRpc = { name: "video.v1.track_mask", input: TrackMaskRequestSchema, output: CreateJobResultSchema };

export const createMaskRevisionRpc = {
  name: "video.v1.create_mask_revision", input: CreateMaskRevisionRequestSchema, output: ApprovalRequestSchema,
};
export const getMaskRevisionRpc = {
  name: "video.v1.get_mask_revision", input: MaskRevisionReviewRequestSchema, output: z.instanceof(Uint8Array),
};

export const inspectFrameRpc = {
  name: "video.v1.inspect_frame", input: InspectFrameRequestSchema, output: z.instanceof(Uint8Array),
};

export const ContactSheetRequestSchema = z
  .object({
    requestId,
    projectId: id,
    assetId: id,
    maxTiles: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,2})$/)
      .optional(),
  })
  .strict();
export type ContactSheetRequest = z.infer<typeof ContactSheetRequestSchema>;

export const ContactSheetResultSchema = z
  .object({
    artifactId: id,
    projectId: id,
    assetId: id,
    sourceSha256: sha256,
    columns: z.number().int().positive(),
    rows: z.number().int().positive(),
    tiles: z.number().int().nonnegative(),
    tileWidth: z.number().int().positive(),
    tileHeight: z.number().int().positive(),
    tileSourceSeconds: z.array(z.string()),
    blob: BlobRefSchema,
  })
  .strict();
export type ContactSheetResult = z.infer<typeof ContactSheetResultSchema>;

export const analyzeAssetRpc = {
  name: "video.v1.analyze_asset",
  input: AnalyzeAssetInputSchema,
  output: CreateJobResultSchema,
};

export const GetAnalysisInputSchema = z
  .object({ requestId, projectId: id, assetId: id })
  .strict();
export type GetAnalysisInput = z.infer<typeof GetAnalysisInputSchema>;
export const AnalysisSummarySchema = z
  .object({
    projectId: id,
    assetId: id,
    contentHash: sha256,
    jobId: id,
    state: JobStateSchema,
    revision: uint,
    analysisRate: z.string().regex(/^[1-9][0-9]*\/[1-9][0-9]*$/).nullable(),
    artifacts: z.array(ArtifactRefSchema),
    error: EditorErrorSchema.nullable(),
    note: z.string(),
  })
  .strict();
export type AnalysisSummary = z.infer<typeof AnalysisSummarySchema>;
export const GetAnalysisResultSchema = AnalysisSummarySchema.extend({ requestId }).strict();
export const getAnalysisRpc = {
  name: "video.v1.get_analysis",
  input: GetAnalysisInputSchema,
  output: GetAnalysisResultSchema,
};

export const GetQaSummaryInputSchema = z
  .object({ requestId, projectId: id, jobId: id })
  .strict();
export type GetQaSummaryInput = z.infer<typeof GetQaSummaryInputSchema>;
export const QaSummarySchema = z
  .object({
    jobId: id,
    kind: z.enum(["analysis", "preview", "final", "export"]),
    state: JobStateSchema,
    revision: uint,
    qaArtifactId: id,
    qaSha256: sha256,
    subjectHash: sha256.nullable(),
    planHash: sha256.nullable(),
    ffmpegBuildHash: z.string().nullable(),
    renderRecipeHash: sha256.nullable(),
    audioLoudness: z
      .object({ meanVolumeDb: z.string(), maxVolumeDb: z.string() })
      .strict()
      .nullable(),
    durationSeconds: z.string().nullable(),
    streams: z.array(
      z
        .object({
          codecType: z.string().optional(),
          codecName: z.string().optional(),
          width: z.number().optional(),
          height: z.number().optional(),
          sampleRate: z.union([z.string(), z.number()]).optional(),
          channels: z.number().optional(),
        })
        .loose(),
    ),
    gates: z.array(
      z
        .object({
          gate: z.string(),
          status: z.string(),
          checks: z.array(z.object({ name: z.string(), status: z.string() }).strict()),
        })
        .strict(),
    ),
  })
  .strict();
export type QaSummary = z.infer<typeof QaSummarySchema>;
export const GetQaSummaryResultSchema = QaSummarySchema.extend({ requestId, projectId: id }).strict();
export const getQaSummaryRpc = {
  name: "video.v1.get_qa_summary",
  input: GetQaSummaryInputSchema,
  output: GetQaSummaryResultSchema,
};

export const SceneCutsSchema = z
  .object({
    assetId: id,
    contentHash: sha256,
    jobId: id,
    state: JobStateSchema,
    revision: uint,
    scenecutsArtifactId: id,
    scenecutsSha256: sha256,
    threshold: z.string().nullable(),
    minGapSeconds: z.string().nullable(),
    rate: RationalSchema.nullable(),
    frameCount: z.number().int().min(0).nullable(),
    truncated: z.boolean(),
    cutCount: z.number().int().min(0),
    cuts: z
      .array(
        z
          .object({
            frameIndex: z.number().int().min(0),
            ptsTime: z.string(),
            score: z.string(),
            aligned: RationalSchema,
          })
          .strict(),
      )
      .max(64),
    note: z.string(),
  })
  .strict();
export type SceneCuts = z.infer<typeof SceneCutsSchema>;
export const GetSceneCutsInputSchema = z
  .object({ requestId, projectId: id, assetId: id })
  .strict();
export const GetSceneCutsResultSchema = SceneCutsSchema.extend({ requestId }).strict();
export const getSceneCutsRpc = {
  name: "video.v1.get_scene_cuts",
  input: GetSceneCutsInputSchema,
  output: GetSceneCutsResultSchema,
};
export const WaveformSummarySchema = z
  .object({
    assetId: id,
    contentHash: sha256,
    jobId: id,
    state: JobStateSchema,
    revision: uint,
    waveformArtifactId: id,
    waveformSha256: sha256,
    streamUid: z.string().nullable(),
    sampleRate: z.number().nullable(),
    bucketMs: z.number().nullable(),
    durationAnalyzedMs: z.string().nullable(),
    truncated: z.boolean(),
    bucketCount: z.number().int().min(0),
    buckets: z.array(z.string()).max(1200),
    note: z.string(),
  })
  .strict();
export type WaveformSummary = z.infer<typeof WaveformSummarySchema>;
export const GetWaveformInputSchema = z
  .object({ requestId, projectId: id, assetId: id })
  .strict();
export const GetWaveformResultSchema = WaveformSummarySchema.extend({ requestId }).strict();
export const getWaveformRpc = {
  name: "video.v1.get_waveform",
  input: GetWaveformInputSchema,
  output: GetWaveformResultSchema,
};

export const GetPlanInputSchema = z
  .object({ requestId, projectId: id, planId: id })
  .strict();
export type GetPlanInput = z.infer<typeof GetPlanInputSchema>;
export const GetPlanResultSchema = AcceptedEditPlanSchema.extend({ requestId }).strict();
export type GetPlanResult = z.infer<typeof GetPlanResultSchema>;
export const getPlanRpc = {
  name: "video.v1.get_plan",
  input: GetPlanInputSchema,
  output: GetPlanResultSchema,
};

export const GetExportSummaryInputSchema = z
  .object({ requestId, projectId: id, jobId: id })
  .strict();
export type GetExportSummaryInput = z.infer<typeof GetExportSummaryInputSchema>;
export const ExportSummarySchema = z
  .object({
    jobId: id,
    state: JobStateSchema,
    revision: uint,
    manifestArtifactId: id,
    manifestSha256: sha256,
    exportId: z.string().nullable(),
    output: BlobRefSchema.nullable(),
    sourceManifestHash: sha256.nullable(),
    planHash: sha256.nullable(),
    ffmpegBuildHash: z.string().nullable(),
    renderRecipeHash: sha256.nullable(),
    approvalId: z.string().nullable(),
    segmentCount: z.number().int().min(0),
    transitionCount: z.number().int().min(0),
    transformCount: z.number().int().min(0),
    subtitleCueCount: z.number().int().min(0),
    audioOperationCount: z.number().int().min(0),
    audioLoudness: z
      .object({ meanVolumeDb: z.string(), maxVolumeDb: z.string() })
      .strict()
      .nullable(),
  })
  .strict();
export type ExportSummary = z.infer<typeof ExportSummarySchema>;
export const GetExportSummaryResultSchema = ExportSummarySchema.extend({ requestId }).strict();
export const getExportSummaryRpc = {
  name: "video.v1.get_export_summary",
  input: GetExportSummaryInputSchema,
  output: GetExportSummaryResultSchema,
};

export const contactSheetRpc = {
  name: "video.v1.contact_sheet",
  input: ContactSheetRequestSchema,
  output: ContactSheetResultSchema,
};

export const PreviewFramesRequestSchema = z
  .object({
    requestId,
    projectId: id,
    jobId: id,
    maxTiles: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,2})$/)
      .optional(),
  })
  .strict();
export type PreviewFramesRequest = z.infer<typeof PreviewFramesRequestSchema>;

export const previewFramesRpc = {
  name: "video.v1.preview_frames",
  input: PreviewFramesRequestSchema,
  output: ContactSheetResultSchema,
};
export const getPlanningRunRpc = {
  name: "video.v1.get_planning_run",
  input: PlanningRunRequestSchema,
  output: PlanningRunStatusSchema,
};
