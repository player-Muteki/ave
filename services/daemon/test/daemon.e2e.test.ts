import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  downloadArtifactBytes,
  sha256HexBrowserSafe,
} from "@ave/client-sdk";
import type { EditPlanDraftV1, JobSnapshot, SourceAsset } from "@ave/contracts";
import { AveDaemon } from "../src/index.js";

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

function sha256Buf(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function waitForJobTerminal(
  client: AveClient,
  projectId: string,
  jobId: string,
  targets: string[],
): Promise<JobSnapshot> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = await client.getJob(projectId, jobId);
    if (targets.includes(job.state)) return job;
    if (job.state === "failed" || job.state === "cancelled") {
      throw new Error(`Job ${jobId} failed unexpectedly: ${JSON.stringify(job.error)}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for job ${jobId} to reach ${targets.join(",")}`);
}

afterEach(async () => {
  while (daemons.length) {
    await daemons.pop()!.stop().catch(() => {});
  }
  while (tempDirs.length) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("@ave/daemon R2 real FFmpeg E2E", () => {
  it("runs complete upload -> analyze -> plan -> approve -> preview -> final -> export -> verify & decode loop", async () => {
    const mediaDir = await makeTempDir("ave-r2-media-");
    const aveHome = await makeTempDir("ave-r2-home-");
    const outDir = await makeTempDir("ave-r2-out-");

    await execFileAsync("python3", [GOLDEN_SCRIPT, "--out-dir", mediaDir]);
    const cfrPath = path.join(mediaDir, "cfr_25fps_av.mp4");
    const cfrBytes = await readFile(cfrPath);
    const sourceShaBefore = sha256Buf(cfrBytes);

    const daemon = await AveDaemon.create({ aveHome });
    daemons.push(daemon);
    const addr = await daemon.start();

    const client = new AveClient({
      url: addr.wsUrl,
      auth: { kind: "localOwner", token: addr.ownerToken },
      WebSocketImpl: WebSocket as unknown as new (url: string) => never,
      reconnect: false,
    });
    const principal = await client.connect();
    expect(principal.role).toBe("owner");

    const caps = await client.getCapabilities();
    expect(caps.deterministicBackends.find((b) => b.id === "ffmpeg")?.available).toBe(true);
    expect(caps.deterministicBackends.find((b) => b.id === "filmcraft")?.available).toBe(false);

    // 1. Create project + subscribe to events
    const project = await client.createProject({ requestId: "r2-proj-1", title: "R2 Real Loop" });
    const receivedEvents: string[] = [];
    const unsub = await client.subscribe(project.projectId, "0", (ev) => {
      receivedEvents.push(ev.type);
    });

    // 2. Upload golden CFR 25fps sample via SourceImport
    const importer = new SourceImport(
      project.projectId,
      {
        name: "cfr_25fps_av.mp4",
        size: cfrBytes.byteLength,
        type: "video/mp4",
        slice: (s = 0, e = cfrBytes.byteLength) => ({
          arrayBuffer: async () => cfrBytes.subarray(s, e).slice().buffer,
        }),
      },
      "r2-up-1",
    );
    const asset: SourceAsset = await importer.transfer(createUploadChannels(client), sha256HexBrowserSafe);
    expect(asset.original.sha256).toBe(sourceShaBefore);
    expect(asset.sourceNeverWritable).toBe(true);

    // 3. Analyze asset -> deterministic scene cuts + waveform
    const analysisRes = await client.call<{ job: JobSnapshot }>("video.v1.analyze_asset", {
      requestId: "r2-ana-1",
      projectId: project.projectId,
      assetId: asset.assetId,
    });
    const completedAnalysis = await waitForJobTerminal(
      client,
      project.projectId,
      analysisRes.job.jobId,
      ["completed"],
    );
    expect(completedAnalysis.artifacts.some((a) => a.kind === "scenecuts")).toBe(true);
    expect(completedAnalysis.artifacts.some((a) => a.kind === "waveform")).toBe(true);

    const cuts = await client.call<{ cutCount: number }>("video.v1.get_scene_cuts", {
      requestId: "r2-cuts-1",
      projectId: project.projectId,
      assetId: asset.assetId,
    });
    expect(cuts.cutCount).toBeGreaterThanOrEqual(1);

    const wave = await client.call<{ bucketCount: number }>("video.v1.get_waveform", {
      requestId: "r2-wave-1",
      projectId: project.projectId,
      assetId: asset.assetId,
    });
    expect(wave.bucketCount).toBeGreaterThan(0);

    // 4. Submit 2-second trim plan (1s..3s? 0s..2s) and verify FilmCraft rejection
    const snap = await client.getProject(project.projectId);
    const videoStream = asset.streams.find((s) => s.kind === "video")!;
    const draft: EditPlanDraftV1 = {
      schemaVersion: "video.edit-plan/v1",
      projectId: project.projectId,
      baseTimelineRevision: snap.revision,
      baseAssetManifestHash: snap.baseAssetManifestHash,
      preferredDeterministicBackendId: "ffmpeg",
      intent: "Trim 2s deterministic clip",
      trimOperations: [
        {
          opId: "trim-1",
          order: "1",
          trackId: "v1",
          clipId: "clip-1",
          source: {
            assetId: asset.assetId,
            assetContentHash: asset.original.sha256,
            streamUid: videoStream.streamUid,
            probeRevision: "1",
          },
          sourceRange: { start: { num: "0", den: "1" }, duration: { num: "2", den: "1" } },
          recordRange: { start: { num: "0", den: "1" }, duration: { num: "2", den: "1" } },
        },
      ],
      transformOperations: [],
      audioOperations: [],
      transitionOperations: [],
      subtitleOperations: [],
      generationRequests: [],
      qaRequirements: [],
      externalDestinations: [],
      maxCostMicros: "0",
    };

    const { plan, approval: previewApproval } = await client.submitPlan({
      requestId: "r2-plan-1",
      runId: "run-manual-1",
      toolCallId: "tc-manual-1",
      draft,
    });
    expect(plan.deterministicBackendId).toBe("ffmpeg");

    // FilmCraft preferred backend must be rejected
    await expect(
      client.submitPlan({
        requestId: "r2-plan-fc",
        runId: "run-manual-1",
        toolCallId: "tc-fc",
        draft: { ...draft, preferredDeterministicBackendId: "filmcraft" },
      }),
    ).rejects.toThrow(/ffmpeg/i);

    // 5. Approve preview -> render preview via real FFmpeg -> wait for awaiting_review
    const previewDecided = await client.decideApproval({
      requestId: "r2-dec-prev",
      approvalId: previewApproval.approvalId,
      expectedRevision: snap.revision,
      decision: "approve",
    });
    const previewJobRes = await client.createJob({
      requestId: "r2-job-prev",
      projectId: project.projectId,
      approvalId: previewApproval.approvalId,
      grantId: previewDecided.grant!.grantId,
      expectedRevision: snap.revision,
    });
    const previewDone = await waitForJobTerminal(
      client,
      project.projectId,
      previewJobRes.job.jobId,
      ["awaiting_review"],
    );
    expect(previewDone.artifacts.some((a) => a.kind === "qa")).toBe(true);

    // 6. Approve final -> render final via real FFmpeg -> wait for awaiting_delivery_approval
    const afterPreviewSnap = await client.getProject(project.projectId);
    const finalApproval = afterPreviewSnap.approvals.find(
      (a) => a.purpose === "final" && a.status === "pending",
    )!;
    const finalDecided = await client.decideApproval({
      requestId: "r2-dec-final",
      approvalId: finalApproval.approvalId,
      expectedRevision: snap.revision,
      decision: "approve",
    });
    const finalJobRes = await client.createJob({
      requestId: "r2-job-final",
      projectId: project.projectId,
      approvalId: finalApproval.approvalId,
      grantId: finalDecided.grant!.grantId,
      expectedRevision: snap.revision,
    });
    await waitForJobTerminal(
      client,
      project.projectId,
      finalJobRes.job.jobId,
      ["awaiting_delivery_approval"],
    );

    // 7. Approve export -> deliver export -> verify_export -> download via read_asset_chunk -> full FFmpeg decode!
    const afterFinalSnap = await client.getProject(project.projectId);
    const exportApproval = afterFinalSnap.approvals.find(
      (a) => a.purpose === "export" && a.status === "pending",
    )!;
    const exportDecided = await client.decideApproval({
      requestId: "r2-dec-export",
      approvalId: exportApproval.approvalId,
      expectedRevision: snap.revision,
      decision: "approve",
    });
    const exportJobRes = await client.createJob({
      requestId: "r2-job-export",
      projectId: project.projectId,
      approvalId: exportApproval.approvalId,
      grantId: exportDecided.grant!.grantId,
      expectedRevision: snap.revision,
    });
    const exportDone = await waitForJobTerminal(
      client,
      project.projectId,
      exportJobRes.job.jobId,
      ["completed"],
    );

    const verified = await client.verifyExport(
      "r2-verify-1",
      project.projectId,
      exportDone.jobId,
    );
    expect(verified.verified).toBe(true);

    const exportArtifact = exportDone.artifacts.find((a) => a.kind === "export")!;
    const downloaded = await downloadArtifactBytes(
      client,
      {
        projectId: project.projectId,
        assetId: exportArtifact.artifactId,
        revision: exportArtifact.revision,
      },
      sha256HexBrowserSafe,
    );
    expect(downloaded.sha256).toBe(verified.outputSha256);

    const deliveredPath = path.join(outDir, "delivered.mp4");
    await writeFile(deliveredPath, downloaded.bytes);
    const { stdout: probeOut } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      deliveredPath,
    ]);
    const probedDelivered = JSON.parse(probeOut) as {
      format: { duration: string };
      streams: Array<{ codec_type: string; width?: number; height?: number }>;
    };
    expect(Number(probedDelivered.format.duration)).toBeCloseTo(2.0, 1);
    expect(probedDelivered.streams.find((s) => s.codec_type === "video")?.width).toBe(320);
    // Full decode of delivered bytes
    await execFileAsync("ffmpeg", ["-v", "error", "-xerror", "-i", deliveredPath, "-f", "null", "-"]);
    // Original source file untouched
    expect(sha256Buf(await readFile(cfrPath))).toBe(sourceShaBefore);
    expect(receivedEvents.length).toBeGreaterThan(0);

    unsub();
    client.close();
  }, 60_000);

  it("enforces device pairing, RBAC, and immediate WebSocket disconnection on device revocation", async () => {
    const aveHome = await makeTempDir("ave-r2-rbac-");
    const daemon = await AveDaemon.create({ aveHome });
    daemons.push(daemon);
    const addr = await daemon.start();

    const owner = new AveClient({
      url: addr.wsUrl,
      auth: { kind: "localOwner", token: addr.ownerToken },
      WebSocketImpl: WebSocket as unknown as new (url: string) => never,
      reconnect: false,
    });
    await owner.connect();
    const project = await owner.createProject({ requestId: "rbac-p1", title: "RBAC" });

    const inv = await owner.call<{ invitationId: string; token: string }>("video.v1.create_invitation", {
      role: "viewer",
      projectIds: [project.projectId],
    });
    const redeemed = await owner.call<{ deviceId: string; credential: string }>(
      "video.v1.redeem_invitation",
      { invitationId: inv.invitationId, token: inv.token },
    );

    const viewer = new AveClient({
      url: addr.wsUrl,
      auth: { kind: "device", deviceId: redeemed.deviceId, credential: redeemed.credential },
      WebSocketImpl: WebSocket as unknown as new (url: string) => never,
      reconnect: false,
    });
    const vp = await viewer.connect();
    expect(vp.role).toBe("viewer");

    const got = await viewer.getProject(project.projectId);
    expect(got.projectId).toBe(project.projectId);
    await expect(
      viewer.createProject({ requestId: "viewer-bad", title: "Forbidden" }),
    ).rejects.toThrow(/cannot modify|requires operator/i);

    await owner.call("video.v1.revoke_device", { deviceId: redeemed.deviceId });
    await new Promise((r) => setTimeout(r, 50));
    expect(viewer.connected).toBe(false);

    owner.close();
    viewer.close();
  });
});
