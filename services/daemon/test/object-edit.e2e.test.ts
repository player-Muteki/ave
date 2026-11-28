import { execFile } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
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
import { recordedWorker, makePeopleClip, type WorkerMode } from "./recorded-object-worker.js";
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

async function settledJob(client: AveClient, projectId: string, id: string): Promise<JobSnapshot> {
  let job = await client.getJob(projectId, id);
  const deadline = Date.now() + 30000;
  while (!["completed", "failed", "cancelled", "awaiting_review", "awaiting_delivery_approval"].includes(job.state)) {
    if (Date.now() > deadline) throw new Error("Timeout in " + job.phaseDetail);
    await new Promise(resolve => setTimeout(resolve, 30));
    job = await client.getJob(projectId, id);
  }
  return job;
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

    // Detection is scheduled by the daemon. The actual CPU detector can report
    // zero candidates on this synthetic clip, or a missing optional capability.
    const actual = await settledJob(client, project.projectId, opened.workflow.workerJobId!);
    if (!support.hog) expect(actual.error?.code).toBe("CAPABILITY_UNAVAILABLE");
    else expect(actual.state, JSON.stringify(actual.error)).toBe("completed");
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

it("runs scheduled detection, mask review and approved nine-frame preview and final renders", async () => {
  const dir = await makeTempDir("ave-two-people-");
  const clip = await makePeopleClip(dir, 2);
  let mode: WorkerMode = "normal";
  const daemon = await AveDaemon.create({ aveHome: await makeTempDir("ave-edit-home-"), mediaWorkerTestAdapter: recordedWorker(() => mode) });
  daemons.push(daemon);
  const address = await daemon.start();
  const client = new AveClient({ url: address.wsUrl, auth: { kind: "localOwner", token: address.ownerToken },
    WebSocketImpl: WebSocket as unknown as new (url: string) => never, reconnect: false });
  await client.connect();
  try {
    const { projectId } = await client.createProject({ requestId: randomUUID(), title: "Two targets" });
    const asset = await uploadGoldenCfr(client, projectId, clip, "two");
    const expectedRevision = (await client.getProject(projectId)).revision;
    const open = async () => (await client.call<{ workflow: ObjectEditWorkflow }>("video.v1.open_object_edit", {
      projectId, expectedRevision, assetId: asset.assetId, requestId: randomUUID(),
      sourceRange: { start: { num: "4", den: "25" }, duration: { num: "12", den: "25" } },
    })).workflow;
    const get = async (id: string) => (await client.call<{ workflow: ObjectEditWorkflow }>("video.v1.get_object_edit", { projectId, workflowId: id })).workflow;
    for (const scenario of ["empty", "unavailable"] as const) {
      mode = scenario;
      const wf = await open();
      await settledJob(client, projectId, wf.workerJobId!);
      expect((await get(wf.workflowId)).state).toBe(scenario === "empty" ? "completed" : "failed");
    }
    mode = "normal";
    let wf = await open();
    expect((await settledJob(client, projectId, wf.workerJobId!)).state).toBe("completed");
    wf = await get(wf.workflowId);
    expect(wf.sourceFrames).toMatchObject({ firstFrame: 4, frameCount: 12 });
    expect(wf.candidates).toHaveLength(2);
    const workflowId = wf.workflowId;
    const decisions = wf.candidates.map((c, i) => ({ objectId: c.objectId, decision: i ? "keep" : "remove" }));
    wf = (await client.call<{ workflow: ObjectEditWorkflow }>("video.v1.decide_object_target", {
      requestId: randomUUID(), projectId, workflowId, expectedWorkflowRevision: wf.workflowRevision, decisions,
    })).workflow;
    expect((await settledJob(client, projectId, wf.workerJobId!)).state).toBe("completed");
    wf = await get(workflowId);
    const review = (approved: boolean, id = wf.maskRevisionId!, requestId = randomUUID()) => ({
      approved, maskRevisionId: id, requestId, projectId, workflowId, expectedWorkflowRevision: wf.workflowRevision,
    });
    await expect(client.call("video.v1.review_object_mask", review(true, "unknown"))).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const initialId = wf.maskRevisionId;
    const rejected = (await client.call<{ workflow: ObjectEditWorkflow }>("video.v1.review_object_mask", review(false))).workflow;
    await settledJob(client, projectId, rejected.workerJobId!);
    wf = await get(workflowId);
    expect(wf.maskRevisionId).toBeTruthy();
    expect(wf.maskRevisionId).not.toBe(initialId);
    const mask = daemon.store.plans.approval(wf.maskApprovalId!);
    daemon.store.plans.updateApproval({ ...mask, expiresAt: new Date(0).toISOString() });
    await expect(client.call("video.v1.review_object_mask", review(true))).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
    daemon.store.plans.updateApproval(mask);
    const revision = daemon.store.objectEdits.getMaskRevision(projectId, wf.maskRevisionId!, { principalId: "owner", role: "owner", projectIds: null });
    expect(BigInt(revision.anchor.inputStartTime!.num)).toBeGreaterThan(0n);
    const savedLabel = await daemon.cas.readBytes(revision.rawLabelMask);
    await writeFile(daemon.cas.pathFor(revision.rawLabelMask), Buffer.alloc(savedLabel.length));
    await expect(client.call("video.v1.review_object_mask", review(true))).rejects.toMatchObject({ code: "ARTIFACT_HASH_MISMATCH" });
    await writeFile(daemon.cas.pathFor(revision.rawLabelMask), savedLabel);
    const request = review(true);
    const accepted = await client.call<{ workflow: ObjectEditWorkflow }>("video.v1.review_object_mask", request);
    expect(await client.call("video.v1.review_object_mask", request)).toEqual(accepted);
    wf = accepted.workflow;
    expect(wf.state).toBe("awaiting_generation_review");
    const planned = planRemovalGeneration(wf, { frames: 9, width: 160, height: 128, rotation: 0, sampleAspectRatio: "1:1", transfer: "bt709" });
    expect(planned.objectId).toBe(decisions[0]!.objectId);
    expect(planTrackWindows(0, 120, { maxFrames: 81, overlap: 2 })).toHaveLength(2);
    expect(checkSeamContinuity(Uint8Array.of(255), Uint8Array.of(255)).passed).toBe(true);
    const track = await client.call<{ job: JobSnapshot }>("video.v1.track_mask", {
      projectId, requestId: randomUUID(), expectedRevision, anchorApprovalId: mask.approvalId,
      anchorHash: mask.subjectHash, firstFrame: 4, frameCount: 9,
    });
    const tracked = await waitForJobTerminal(client, projectId, track.job.jobId);
    const manifest = tracked.artifacts.find(a => a.kind === "mask")!;
    const proxy = tracked.artifacts.find(a => a.kind === "proxy")!;
    const seq = await client.call<ApprovalRequest>("video.v1.request_tracked_mask_review", { projectId,
      requestId: randomUUID(), jobId: tracked.jobId, expectedRevision, manifestHash: manifest.blob.sha256, reviewHash: proxy.blob.sha256 });
    const proposal = (seed: number) => client.call<{ approval: ApprovalRequest }>("video.v1.propose_vace_preview", {
      projectId, expectedRevision, requestId: randomUUID(), maskApprovalId: seq.approvalId, manifestHash: manifest.blob.sha256,
      prompt: "Remove the red figure and preserve the blue figure", negativePrompt: "", seed });
    await expect(proposal(1)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    const approve = (approval: ApprovalRequest) => client.decideApproval({ requestId: randomUUID(), expectedRevision,
      approvalId: approval.approvalId, decision: "approve" });
    await approve(seq);
    async function render(approval: ApprovalRequest) {
      const { grant } = await approve(approval);
      const { job } = await client.createJob({ projectId, expectedRevision, requestId: randomUUID(), approvalId: approval.approvalId, grantId: grant!.grantId });
      return settledJob(client, projectId, job.jobId);
    }
    let seed = 1;
    for (const scenario of ["no-change", "leak", "missing-output", "timeout"] as const) {
      mode = scenario;
      const job = await render((await proposal(++seed)).approval);
      expect(job.state, scenario).toBe("failed");
      expect(job.error?.code, job.error?.sanitizedDetail).toBe(scenario === "timeout" ? "WORKER_FAILED" : "QA_FAILED");
      expect(job.artifacts).toHaveLength(0);
    }
    mode = "normal";
    const preview = await render((await proposal(++seed)).approval);
    expect(preview.state, JSON.stringify(preview.error)).toBe("awaiting_review");
    const finalApproval = (await client.getProject(projectId)).approvals.find(a => a.purpose === "final" && a.status === "pending")!;
    const final = await render(finalApproval);
    expect(final.state, JSON.stringify(final.error)).toBe("awaiting_delivery_approval");
    for (const job of [preview, final]) {
      const candidate = job.artifacts.find(a => a.kind === "candidate")!;
      const qa = await daemon.cas.readJson<any>(job.artifacts.find(a => a.kind === "qa")!.blob);
      expect(qa.generation).toMatchObject({ modelRevision: VACE_MODEL, seed, maskHash: manifest.blob.sha256 });
      const file = daemon.cas.pathFor(candidate.blob);
      const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file]);
      const streams = JSON.parse(stdout).streams;
      expect(streams[0].nb_frames).toBe("9");
      expect(streams.map((stream: { duration: string }) => stream.duration)).toEqual(["0.360000", "0.360000"]);
      const { stdout: rgb } = await execFileAsync("ffmpeg", ["-v", "error", "-i", file, "-frames:v", "1", ...(job.kind === "preview" ? ["-vf", "crop=450:360:95:0,scale=160:128"] : []), "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], { encoding: "buffer" });
      const pixel = (x: number) => Array.from(rgb.subarray(3 * (160 * 40 + x), 3 * (160 * 40 + x) + 3));
      expect(Math.max(...pixel(30)) - Math.min(...pixel(30))).toBeLessThan(12);
      expect(pixel(110)[2]! - pixel(110)[0]!).toBeGreaterThan(150);
    }
    expect(await daemon.cas.verifyBlob(asset.original)).toBe(true);
    const state = await client.call<{ workflow: ObjectEditWorkflow }>("video.v1.record_object_qa", { projectId, workflowId,
      expectedWorkflowRevision: wf.workflowRevision, requestId: randomUUID(), qa: { frames: "9", residualRatio: 0, completeRatio: 1, flickerRatio: 0 } });
    expect(state.workflow.state).toBe("completed");
  } finally { client.close(); }
}, 90_000);
