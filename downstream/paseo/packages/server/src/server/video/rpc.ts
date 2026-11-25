import { z } from "zod";
import {
  CreateJobRequestSchema,
  CreateProjectInputSchema,
  CreateUploadRequestSchema,
  WriteUploadChunkSchema,
  DecideApprovalResultSchema,
  ProjectRequestSchema,
  PlanReviewRequestSchema,
  ReadAssetChunkRequestSchema,
  PlanningRunRequestSchema,
  StartPlanningRunInputSchema,
  SteerPlanningRunInputSchema,
  AnalyzeAssetInputSchema,
  ContactSheetRequestSchema,
  type EditorPrincipal,
} from "#video-editor/contracts/v1";
import { decodeFramedChunk } from "#video-editor/bytes";
import { authorizeVideoMethod, type EditorCaller } from "./authorization.js";
import { editorFailure } from "./errors.js";
import type { EditorService } from "./service.js";

export class EditorRpcService {
  constructor(private readonly editor: EditorService) {}

  async invoke(method: string, input: unknown, caller: EditorCaller): Promise<unknown> {
    const principal = authorizeVideoMethod(method, caller);
    switch (method) {
      case "video.v1.get_capabilities":
        return {
          protocolVersion: "1",
          features: ["deterministic-editing", "persistent-jobs", "chunked-media"],
          operations: ["trim"],
          deterministicBackends: [
            { id: "ffmpeg", available: true, version: "system" },
            {
              id: "filmcraft",
              available: false,
              reason: "Full source build and media conformance have not been verified",
            },
          ],
          workerProfiles: [],
        };
      case "video.v1.create_project":
        return this.editor.store.createProject({
          ...CreateProjectInputSchema.parse(input),
          principal,
        });
      case "video.v1.get_project":
        return this.editor.store.project(ProjectRequestSchema.parse(input).projectId, principal);
      case "video.v1.submit_plan": {
        const request = PlanReviewRequestSchema.parse(input);
        return this.editor.store.createPlan({ ...request, principal });
      }
      case "video.v1.decide_approval": {
        const result = this.editor.store.decideApproval(
          z
            .object({
              requestId: z.string(),
              approvalId: z.string(),
              expectedRevision: z.string(),
              decision: z.enum(["approve", "reject"]),
              comment: z.string().optional(),
            })
            .parse(input),
          principal,
        );
        return DecideApprovalResultSchema.parse(result);
      }
      case "video.v1.create_job": {
        const request = CreateJobRequestSchema.parse(input);
        const result = this.editor.store.createJob({ ...request, principal });
        this.editor.jobs.enqueue(request.projectId, result.job.jobId);
        return result;
      }
      case "video.v1.get_job": {
        const request = z.object({ projectId: z.string(), jobId: z.string() }).parse(input);
        return this.editor.store.job(request.projectId, request.jobId, principal);
      }
      case "video.v1.control_job": {
        const request = z
          .object({
            projectId: z.string(),
            jobId: z.string(),
            requestId: z.string(),
            action: z.enum(["cancel", "pause", "resume", "retry"]),
          })
          .parse(input);
        return this.editor.jobs.control(
          request.projectId,
          request.jobId,
          request.action,
          request.requestId,
          principal,
        );
      }
      case "video.v1.get_events": {
        const request = z.object({ projectId: z.string(), afterSeq: z.string() }).parse(input);
        return this.editor.store.events(request.projectId, request.afterSeq, principal);
      }
      case "video.v1.start_planning_run": {
        const request = StartPlanningRunInputSchema.parse(input);
        return this.editor.agents.startRun(request, principal);
      }
      case "video.v1.steer_planning_run": {
        const request = SteerPlanningRunInputSchema.parse(input);
        return this.editor.agents.steer(request, principal);
      }
      case "video.v1.follow_up_planning_run": {
        const request = SteerPlanningRunInputSchema.parse(input);
        return this.editor.agents.followUp(request, principal);
      }
      case "video.v1.stop_planning_run": {
        const request = PlanningRunRequestSchema.parse(input);
        return this.editor.agents.stopRun(request.projectId, request.runId, principal);
      }
      case "video.v1.get_planning_run": {
        const request = PlanningRunRequestSchema.parse(input);
        return this.editor.agents.status(request.projectId, request.runId, principal);
      }
      case "video.v1.analyze_asset": {
        const request = AnalyzeAssetInputSchema.parse(input);
        const result = this.editor.store.createAnalysisJob({ ...request, principal });
        this.editor.jobs.enqueue(request.projectId, result.job.jobId);
        return result;
      }
      case "video.v1.contact_sheet": {
        const request = ContactSheetRequestSchema.parse(input);
        this.editor.store.authorizeProject(request.projectId, principal, "operator");
        return this.editor.media.contactSheet(
          request.projectId,
          request.assetId,
          request.maxTiles ? Number(request.maxTiles) : 12,
          principal,
          new AbortController().signal,
        );
      }
      case "video.v1.create_invitation":
      case "video.v1.redeem_invitation":
      case "video.v1.revoke_device":
        return this.deviceOperation(method, input, principal);
      case "video.v1.read_asset_chunk":
        return this.readAssetChunk(ReadAssetChunkRequestSchema.parse(input), principal);
      case "video.v1.create_upload": {
        const request = CreateUploadRequestSchema.parse(input);
        return this.editor.store.createUpload({ ...request, principal });
      }
      case "video.v1.write_upload_chunk": {
        if (!(input instanceof Uint8Array))
          editorFailure("INVALID_ARGUMENT", "A framed binary upload chunk is required");
        return this.writeUploadChunk(input, principal);
      }
      case "video.v1.get_upload_status": {
        const request = z.object({ projectId: z.string(), uploadId: z.string() }).parse(input);
        return this.editor.store.uploadStatus(request.projectId, request.uploadId, principal);
      }
      case "video.v1.commit_upload": {
        const request = z
          .object({ requestId: z.string(), uploadId: z.string(), finalSha256: z.string() })
          .parse(input);
        return this.editor.media.commitUpload(
          request.uploadId,
          request.requestId,
          request.finalSha256,
          principal,
        );
      }
      case "video.v1.import_asset":
        editorFailure(
          "CAPABILITY_UNAVAILABLE",
          "Use a media upload; server paths are not accepted",
        );
      default:
        editorFailure("INVALID_ARGUMENT", `Unknown video editor RPC ${method}`);
    }
  }

  private async deviceOperation(
    method: string,
    input: unknown,
    principal: EditorPrincipal,
  ): Promise<unknown> {
    switch (method) {
      case "video.v1.create_invitation": {
        if (principal.role !== "owner")
          editorFailure("PERMISSION_DENIED", "Only the project owner can pair a device");
        const request = z
          .object({ projectId: z.string(), role: z.enum(["viewer", "operator"]) })
          .parse(input);
        this.editor.store.project(request.projectId, principal);
        return this.editor.access.createInvitation({
          role: request.role,
          projectIds: [request.projectId],
        });
      }
      case "video.v1.redeem_invitation": {
        const request = z.object({ invitationId: z.string(), token: z.string() }).parse(input);
        if (principal.role !== "owner")
          editorFailure("PERMISSION_DENIED", "Only the owner can provision a paired device");
        const device = await this.editor.access.redeemInvitation(
          request.invitationId,
          request.token,
        );
        for (const projectId of device.principal.projectIds ?? []) {
          this.editor.store.registerDevice({
            projectId,
            principalId: device.deviceId,
            role: device.principal.role,
            actor: principal,
          });
        }
        return device;
      }
      case "video.v1.revoke_device": {
        if (principal.role !== "owner")
          editorFailure("PERMISSION_DENIED", "Only the project owner can revoke a device");
        const request = z.object({ deviceId: z.string() }).parse(input);
        await this.editor.access.revoke(request.deviceId);
        return { revoked: true };
      }
      default:
        editorFailure("INVALID_ARGUMENT", "Unknown device operation");
    }
  }

  private async readAssetChunk(
    input: z.infer<typeof ReadAssetChunkRequestSchema>,
    principal: EditorPrincipal,
  ): Promise<Uint8Array> {
    const length = BigInt(input.length);
    if (length > 262_144n)
      editorFailure("INVALID_ARGUMENT", "A single media chunk cannot exceed 256 KiB");
    const { projectId, assetId, revision } = input;
    const ref = (() => {
      if (assetId.endsWith(":review-proxy")) return this.editor.store.finalReviewProxy(projectId, assetId, revision, principal).blob;
      if (assetId.endsWith(":candidate")) return this.previewForReview(input, principal);
      if (assetId.endsWith(":export") || assetId.endsWith(":manifest") || assetId.endsWith(":qa")) return this.editor.store.artifact(projectId, assetId, revision, principal).blob;
      return this.editor.store.asset(projectId, assetId, revision, principal).proxy;
    })();
    if (!ref) editorFailure("ASSET_NOT_FOUND", "No preview proxy is available");
    const bytes = await this.editor.cas.readRange(ref, BigInt(input.offset), length);
    const { createHash } = await import("node:crypto");
    const metadata = {
      protocolVersion: "1",
      offset: input.offset,
      bytesLength: bytes.byteLength.toString(),
      totalBytes: ref.bytes,
      revision: input.revision,
      chunkSha256: createHash("sha256").update(bytes).digest("hex"),
      assetSha256: ref.sha256,
    };
    const header = new TextEncoder().encode(JSON.stringify(metadata));
    const frame = new Uint8Array(2 + header.byteLength + bytes.byteLength);
    new DataView(frame.buffer).setUint16(0, header.byteLength);
    frame.set(header, 2);
    frame.set(bytes, 2 + header.byteLength);
    return frame;
  }

  private previewForReview(input: z.infer<typeof ReadAssetChunkRequestSchema>, principal: EditorPrincipal) {
    const jobId = input.assetId.slice(0, -":candidate".length);
    const job = this.editor.store.job(input.projectId, jobId, principal);
    if (job.kind !== "preview" || job.state !== "awaiting_review")
      editorFailure("PERMISSION_DENIED", "Only a reviewable preview may be read on this route");
    if (job.candidateRevision !== input.revision)
      editorFailure("REVISION_CONFLICT", "The preview belongs to another candidate revision");
    const artifact = job.artifacts.find(a => a.artifactId === input.assetId && a.kind === "candidate" && a.jobId === job.jobId && a.projectId === input.projectId && a.revision === input.revision);
    if (!artifact) editorFailure("ASSET_NOT_FOUND", "No reviewed preview bytes for this revision");
    return artifact.blob;
  }

  private async writeUploadChunk(
    frame: Uint8Array,
    principal: EditorPrincipal,
  ): Promise<Uint8Array> {
    const { metadata, payload } = decodeFramedChunk(frame);
    const header = WriteUploadChunkSchema.parse(JSON.parse(new TextDecoder().decode(metadata)));
    const { createHash } = await import("node:crypto");
    if (
      payload.byteLength > 262_144 ||
      payload.byteLength.toString() !== header.length ||
      createHash("sha256").update(payload).digest("hex") !== header.chunkSha256
    ) {
      editorFailure("ARTIFACT_HASH_MISMATCH", "The uploaded chunk failed its size or hash check");
    }
    const nextOffset = await this.editor.media.writeUploadChunk(
      header.uploadId,
      header.offset,
      payload,
      principal,
    );
    return new TextEncoder().encode(JSON.stringify({ uploadId: header.uploadId, nextOffset }));
  }
}
