import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  AveClient,
  SourceImport,
  createUploadChannels,
  sha256HexBrowserSafe,
} from "@ave/client-sdk";
import {
  ApprovalRequestSchema,
  InspectFrameHeaderSchema,
  MaskAnchorRevisionSchema,
  VACE_MODEL,
  VACE_PROFILE,
  decodeFramedChunk,
  type ApprovalRequest,
  type JobSnapshot,
  type ObjectEditWorkflow,
  type SourceAsset,
} from "@ave/contracts";
import {
  checkSeamContinuity,
  planRemovalGeneration,
  planTrackWindows,
} from "@ave/domain";
import { AveDaemon, AvePyWorker, type MediaWorkerTestAdapter } from "../src/index.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_SCRIPT = path.resolve(
  __dirname,
  "../../../conformance/r0-baseline/generate_golden_media.py",
);

const tempDirs: string[] = [];
const daemons: AveDaemon[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function uploadGoldenCfr(client: AveClient, projectId: string, cfrPath: string, reqPrefix: string) {
  const bytes = await readFile(cfrPath);
  const importer = new SourceImport(
    projectId,
    {
      name: "cfr_25fps_av.mp4",
      size: bytes.byteLength,
      type: "video/mp4",
      slice: (s = 0, e = bytes.byteLength) => ({
        arrayBuffer: async () => bytes.subarray(s, e).slice().buffer,
      }),
    },
    reqPrefix,
  );
  return importer.transfer(createUploadChannels(client), sha256HexBrowserSafe);
}

async function waitForJobTerminal(
  client: AveClient,
  projectId: string,
  jobId: string,
): Promise<JobSnapshot> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = await client.getJob(projectId, jobId);
    if (job.state === "completed") return job;
    if (job.state === "failed" || job.state === "cancelled") {
      throw new Error(`Job ${jobId} terminated in ${job.state}: ${JSON.stringify(job.error)}`);
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

afterEach(async () => {
  while (daemons.length) {
    await daemons.pop()!.stop().catch(() => {});
  }
  while (tempDirs.length) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("@ave/daemon R4 Media Worker & Object-Edit Loop", () => {
  it("runs PyWorker kernels, real FFmpeg frame inspection, 6-state object-edit workflow, and gates unconfigured GPU ops", async () => {
    const mediaDir = await makeTempDir("ave-r4-media-");
    const aveHome = await makeTempDir("ave-r4-home-");
    await execFileAsync("python3", [GOLDEN_SCRIPT, "--out-dir", mediaDir]);
    const cfrPath = path.join(mediaDir, "cfr_25fps_av.mp4");

    const py = new AvePyWorker();
    const support = await py.support(new AbortController().signal);
    expect(support.numpy).toBe(true);

    const daemon = await AveDaemon.create({ aveHome });
    daemons.push(daemon);
    const addr = await daemon.start();

    const client = new AveClient({
      url: addr.wsUrl,
      auth: { kind: "localOwner", token: addr.ownerToken },
      WebSocketImpl: WebSocket as unknown as new (url: string) => never,
      reconnect: false,
    });
    await client.connect();

    const project = await client.createProject({ requestId: "r4-p1", title: "Object Edit QA" });
    const asset: SourceAsset = await uploadGoldenCfr(client, project.projectId, cfrPath, "r4-u1");
    const videoStream = asset.streams.find((s) => s.kind === "video")!;

    // 1. Real AvePyWorker sampling-map against CAS presentationIndex
    const smap = await py.samplingMap(
      {
        indexPath: daemon.cas.pathFor(asset.presentationIndex),
        indexSha256: asset.presentationIndex.sha256,
        sourceSha256: asset.original.sha256,
        streamUid: videoStream.streamUid,
        first: 0,
        stop: 9,
        rate: "25/1",
      },
      new AbortController().signal,
    );
    expect(smap.sample_to_source).toHaveLength(9);

    // 2. Real FFmpeg inspect_frame with 0 points returns verified JPEG frame
    const rawFrame = await client.callBinary("video.v1.inspect_frame", {
      projectId: project.projectId,
      assetId: asset.assetId,
      streamUid: videoStream.streamUid,
      sourcePresentationIndexHash: asset.presentationIndex.sha256,
      frame: 0,
      points: [],
    });
    const decoded = decodeFramedChunk(rawFrame);
    const frameHeader = InspectFrameHeaderSchema.parse(
      JSON.parse(new TextDecoder().decode(decoded.metadata)),
    );
    expect(frameHeader.width).toBe(videoStream.width);
    expect(frameHeader.height).toBe(videoStream.height);
    expect(decoded.payload.length).toBeGreaterThan(100);

    // Unconfigured SAM2 / tracking / VACE fail honestly with CAPABILITY_UNAVAILABLE
    await expect(
      client.callBinary("video.v1.inspect_frame", {
        projectId: project.projectId,
        assetId: asset.assetId,
        streamUid: videoStream.streamUid,
        sourcePresentationIndexHash: asset.presentationIndex.sha256,
        frame: 0,
        points: [{ x: 10, y: 10, foreground: true }],
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });

    await expect(
      client.call("video.v1.propose_vace_preview", {
        projectId: project.projectId,
        requestId: "r4-unconf-vace",
        expectedRevision: "0",
        maskApprovalId: "missing-approval",
        manifestHash: "0".repeat(64),
        prompt: "remove person",
        negativePrompt: "",
        seed: 42,
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });

    // 3. Object-edit 6-state FSM + domain window/generation/QA gates + invalidation
    const snap = await client.getProject(project.projectId);
    const opened = await client.call<{ workflow: ObjectEditWorkflow }>("video.v1.open_object_edit", {
      requestId: "r4-oe-open-1",
      projectId: project.projectId,
      assetId: asset.assetId,
      expectedRevision: snap.revision,
      sourceRange: { start: { num: "0", den: "1" }, duration: { num: "1", den: "1" } },
    });
    expect(opened.workflow.state).toBe("analyzing");

    // Stale expectedWorkflowRevision causes REVISION_CONFLICT
    await expect(
      client.call("video.v1.record_object_candidates", {
        requestId: "r4-oe-stale",
        projectId: project.projectId,
        workflowId: opened.workflow.workflowId,
        expectedWorkflowRevision: "99",
        candidates: [
          {
            objectId: "p1",
            trackId: "t1",
            role: "background",
            confidence: 0.9,
            evidenceFrames: ["0"],
            box: { x: 0.1, y: 0.1, width: 0.2, height: 0.4 },
            risk: { areaRatio: 0.1, occlusion: 0.0, motion: 0.1, overlapProtected: false },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

    const withCands = await client.call<{ workflow: ObjectEditWorkflow }>(
      "video.v1.record_object_candidates",
      {
        requestId: "r4-oe-cands-1",
        projectId: project.projectId,
        workflowId: opened.workflow.workflowId,
        expectedWorkflowRevision: opened.workflow.workflowRevision,
        candidates: [
          {
            objectId: "person-bg",
            trackId: "trk-bg",
            role: "background",
            confidence: 0.91,
            evidenceFrames: ["0", "4"],
            box: { x: 0.1, y: 0.2, width: 0.2, height: 0.4 },
            risk: { areaRatio: 0.12, occlusion: 0.05, motion: 0.1, overlapProtected: false },
          },
          {
            objectId: "person-main",
            trackId: "trk-main",
            role: "protagonist",
            confidence: 0.98,
            evidenceFrames: ["0", "4"],
            box: { x: 0.5, y: 0.2, width: 0.2, height: 0.5 },
            risk: { areaRatio: 0.2, occlusion: 0.0, motion: 0.05, overlapProtected: false },
          },
        ],
      },
    );
    expect(withCands.workflow.state).toBe("awaiting_target_selection");

    const decided = await client.call<{ workflow: ObjectEditWorkflow }>(
      "video.v1.decide_object_target",
      {
        requestId: "r4-oe-dec-1",
        projectId: project.projectId,
        workflowId: withCands.workflow.workflowId,
        expectedWorkflowRevision: withCands.workflow.workflowRevision,
        decisions: [
          { objectId: "person-bg", decision: "remove" },
          { objectId: "person-main", decision: "keep" },
        ],
      },
    );
    expect(decided.workflow.state).toBe("awaiting_mask_review");

    const rejectedMask = await client.call<{ workflow: ObjectEditWorkflow }>(
      "video.v1.review_object_mask",
      {
        requestId: "r4-oe-mask-rej",
        projectId: project.projectId,
        workflowId: decided.workflow.workflowId,
        expectedWorkflowRevision: decided.workflow.workflowRevision,
        maskRevisionId: "mask-1",
        approved: false,
      },
    );
    expect(rejectedMask.workflow.state).toBe("awaiting_mask_review");

    const approvedMask = await client.call<{ workflow: ObjectEditWorkflow }>(
      "video.v1.review_object_mask",
      {
        requestId: "r4-oe-mask-app",
        projectId: project.projectId,
        workflowId: rejectedMask.workflow.workflowId,
        expectedWorkflowRevision: rejectedMask.workflow.workflowRevision,
        maskRevisionId: "mask-2",
        approved: true,
      },
    );
    expect(approvedMask.workflow.state).toBe("awaiting_generation_review");

    // Verify domain removal plan & long-shot window planning
    const genPlan = planRemovalGeneration(approvedMask.workflow, {
      frames: 9,
      width: videoStream.width!,
      height: videoStream.height!,
      rotation: 0,
      sampleAspectRatio: "1:1",
      transfer: "bt709",
    });
    expect(genPlan.objectId).toBe("person-bg");
    const windows = planTrackWindows(0, 120, { maxFrames: 81, overlap: 2 });
    expect(windows).toHaveLength(2);
    const seamA = new Uint8Array([255, 255, 0, 0]);
    expect(checkSeamContinuity(seamA, seamA).passed).toBe(true);

    // Failing QA transitions workflow to failed
    const failedQa = await client.call<{ workflow: ObjectEditWorkflow }>(
      "video.v1.record_object_qa",
      {
        requestId: "r4-oe-qa-fail",
        projectId: project.projectId,
        workflowId: approvedMask.workflow.workflowId,
        expectedWorkflowRevision: approvedMask.workflow.workflowRevision,
        qa: { frames: "9", residualRatio: 0.15, completeRatio: 0.99, flickerRatio: 0.01 },
      },
    );
    expect(failedQa.workflow.state).toBe("failed");

    // Second workflow completes cleanly on passing QA
    const w2 = await client.call<{ workflow: ObjectEditWorkflow }>("video.v1.open_object_edit", {
      requestId: "r4-oe-open-2",
      projectId: project.projectId,
      assetId: asset.assetId,
      expectedRevision: snap.revision,
      sourceRange: { start: { num: "0", den: "1" }, duration: { num: "1", den: "1" } },
    });
    const w2C = await client.call<{ workflow: ObjectEditWorkflow }>(
      "video.v1.record_object_candidates",
      {
        requestId: "r4-oe-c2",
        projectId: project.projectId,
        workflowId: w2.workflow.workflowId,
        expectedWorkflowRevision: w2.workflow.workflowRevision,
        candidates: withCands.workflow.candidates,
      },
    );
    const w2D = await client.call<{ workflow: ObjectEditWorkflow }>(
      "video.v1.decide_object_target",
      {
        requestId: "r4-oe-d2",
        projectId: project.projectId,
        workflowId: w2C.workflow.workflowId,
        expectedWorkflowRevision: w2C.workflow.workflowRevision,
        decisions: [{ objectId: "person-bg", decision: "remove" }],
      },
    );
    const w2M = await client.call<{ workflow: ObjectEditWorkflow }>(
      "video.v1.review_object_mask",
      {
        requestId: "r4-oe-m2",
        projectId: project.projectId,
        workflowId: w2D.workflow.workflowId,
        expectedWorkflowRevision: w2D.workflow.workflowRevision,
        maskRevisionId: "mask-pass",
        approved: true,
      },
    );
    const w2Done = await client.call<{ workflow: ObjectEditWorkflow }>(
      "video.v1.record_object_qa",
      {
        requestId: "r4-oe-q2",
        projectId: project.projectId,
        workflowId: w2M.workflow.workflowId,
        expectedWorkflowRevision: w2M.workflow.workflowRevision,
        qa: { frames: "9", residualRatio: 0.005, completeRatio: 0.995, flickerRatio: 0.01 },
      },
    );
    expect(w2Done.workflow.state).toBe("completed");

    client.close();
  });

  it("runs recorded-adapter anchor -> tracking (real FFmpeg H.264 review video) -> VACE preview proposal", async () => {
    const mediaDir = await makeTempDir("ave-r4-mask-media-");
    const aveHome = await makeTempDir("ave-r4-mask-home-");
    await execFileAsync("python3", [GOLDEN_SCRIPT, "--out-dir", mediaDir]);
    const cfrPath = path.join(mediaDir, "cfr_25fps_av.mp4");

    const buildDeterministicLabel = (w: number, h: number): Uint8Array => {
      const buf = new Uint8Array(w * h);
      for (let y = 10; y < Math.min(h, 50); y += 1) {
        for (let x = 10; x < Math.min(w, 50); x += 1) {
          buf[y * w + x] = 255;
        }
      }
      return buf;
    };

    const adapter: MediaWorkerTestAdapter = {
      enableVace: true,
      inspectMask: async ({ directory, width, height, saveLabel }) => {
        const label = buildDeterministicLabel(width, height);
        await copyFile(path.join(directory, "frame.png"), path.join(directory, "overlay.png"));
        if (saveLabel) {
          await writeFile(path.join(directory, "label.raw"), label);
        }
        return {
          engine: "sam2.1-tiny",
          weightsSha256: "7".repeat(64),
          labelSha256: sha256Bytes(label),
          foregroundPixels: label.filter((v) => v === 255).length,
        };
      },
      trackMask: async ({ directory, width, height, count, anchorOffset, anchorRaw }) => {
        const areas: number[] = [];
        for (let i = 0; i < count; i += 1) {
          const raw =
            i === anchorOffset ? anchorRaw : buildDeterministicLabel(width, height);
          await writeFile(
            path.join(directory, "labels", String(i).padStart(5, "0") + ".raw"),
            raw,
          );
          let fg = 0;
          for (const v of raw) if (v === 255) fg += 1;
          areas.push(fg);
        }
        await execFileAsync("ffmpeg", [
          "-nostdin",
          "-v",
          "error",
          "-y",
          "-start_number",
          "0",
          "-i",
          path.join(directory, "frames/%05d.jpg"),
          path.join(directory, "overlay/%05d.png"),
        ]);
        return areas;
      },
    };

    const daemon = await AveDaemon.create({ aveHome, mediaWorkerTestAdapter: adapter });
    daemons.push(daemon);
    const addr = await daemon.start();

    const client = new AveClient({
      url: addr.wsUrl,
      auth: { kind: "localOwner", token: addr.ownerToken },
      WebSocketImpl: WebSocket as unknown as new (url: string) => never,
      reconnect: false,
    });
    await client.connect();

    const caps = await client.getCapabilities();
    expect(caps.features).toContain("mask-tracking");
    expect(caps.features).toContain("vace-preview");

    const project = await client.createProject({ requestId: "r4-m-p1", title: "Mask Tracking Loop" });
    const asset: SourceAsset = await uploadGoldenCfr(client, project.projectId, cfrPath, "r4-m-u1");
    const videoStream = asset.streams.find((s) => s.kind === "video")!;
    const snap = await client.getProject(project.projectId);

    // 1. Inspect frame with foreground click -> anchor preview
    const anchorReq = {
      projectId: project.projectId,
      assetId: asset.assetId,
      streamUid: videoStream.streamUid,
      sourcePresentationIndexHash: asset.presentationIndex.sha256,
      frame: 2,
      points: [{ x: 20, y: 20, foreground: true }],
    };
    const inspectedBytes = await client.callBinary("video.v1.inspect_frame", anchorReq);
    const inspectedDecoded = decodeFramedChunk(inspectedBytes);
    const header = InspectFrameHeaderSchema.parse(
      JSON.parse(new TextDecoder().decode(inspectedDecoded.metadata)),
    );
    expect(header.mask).toBeDefined();

    // 2. Save mask revision + human approval
    const maskApproval = ApprovalRequestSchema.parse(
      await client.call("video.v1.create_mask_revision", {
        requestId: "r4-cmr-1",
        expectedRevision: snap.revision,
        anchor: anchorReq,
        expectedLabelSha256: header.mask!.labelSha256,
        expectedPreviewSha256: header.previewSha256,
      }),
    );

    // Unapproved pending mask anchor must reject track_mask with PERMISSION_DENIED
    await expect(
      client.call("video.v1.track_mask", {
        projectId: project.projectId,
        requestId: "r4-unapproved-track",
        expectedRevision: snap.revision,
        anchorApprovalId: maskApproval.approvalId,
        anchorHash: maskApproval.subjectHash,
        firstFrame: 0,
        frameCount: 9,
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

    const savedMaskRaw = await client.callBinary("video.v1.get_mask_revision", {
      projectId: project.projectId,
      maskRevisionId: maskApproval.subjectId,
    });
    const savedMaskDecoded = decodeFramedChunk(savedMaskRaw);
    const maskRevDoc = MaskAnchorRevisionSchema.parse(
      JSON.parse(new TextDecoder().decode(savedMaskDecoded.metadata)),
    );
    expect(maskRevDoc.rawLabelMask.sha256).toBe(header.mask!.labelSha256);

    await client.decideApproval({
      requestId: "r4-dec-anchor",
      approvalId: maskApproval.approvalId,
      expectedRevision: snap.revision,
      decision: "approve",
    });

    // 3. Track 9 frames -> real FFmpeg H.264 review.mp4 + ffprobe clock verification
    const trackCreated = await client.call<{ job: JobSnapshot }>("video.v1.track_mask", {
      projectId: project.projectId,
      requestId: "r4-tm-1",
      expectedRevision: snap.revision,
      anchorApprovalId: maskApproval.approvalId,
      anchorHash: maskApproval.subjectHash,
      firstFrame: 0,
      frameCount: 9,
    });
    const trackDone = await waitForJobTerminal(client, project.projectId, trackCreated.job.jobId);
    const maskArtifact = trackDone.artifacts.find((a) => a.artifactId.endsWith(":tracked-mask"))!;
    const proxyArtifact = trackDone.artifacts.find((a) =>
      a.artifactId.endsWith(":tracking-preview"),
    )!;
    expect(maskArtifact).toBeDefined();
    expect(proxyArtifact).toBeDefined();

    // 4. Request tracked mask review -> human approve -> propose_vace_preview
    const seqApproval = await client.call<ApprovalRequest>(
      "video.v1.request_tracked_mask_review",
      {
        projectId: project.projectId,
        requestId: "r4-rtmr-1",
        jobId: trackDone.jobId,
        expectedRevision: snap.revision,
        manifestHash: maskArtifact.blob.sha256,
        reviewHash: proxyArtifact.blob.sha256,
      },
    );
    await client.decideApproval({
      requestId: "r4-dec-seq",
      approvalId: seqApproval.approvalId,
      expectedRevision: snap.revision,
      decision: "approve",
    });

    const vaceProposal = await client.call<{
      plan: { generationRequests: Array<{ providerProfileId: string; modelId: string }> };
      approval: ApprovalRequest;
    }>("video.v1.propose_vace_preview", {
      projectId: project.projectId,
      requestId: "r4-vace-1",
      expectedRevision: snap.revision,
      maskApprovalId: seqApproval.approvalId,
      manifestHash: maskArtifact.blob.sha256,
      prompt: "Remove background person naturally",
      negativePrompt: "artifacts, blur",
      seed: 1234,
    });
    expect(vaceProposal.approval.status).toBe("pending");
    expect(vaceProposal.plan.generationRequests[0]?.providerProfileId).toBe(VACE_PROFILE);
    expect(vaceProposal.plan.generationRequests[0]?.modelId).toBe(VACE_MODEL);

    client.close();
  });
});
