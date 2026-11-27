import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import type { EditPlanDraftV1, EditorEvent, JobSnapshot, SourceAsset } from "@ave/contracts";
import { MobileSupervisorSession } from "@ave/mobile";
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
    if (job.state === "failed") {
      throw new Error(`Job failed: ${JSON.stringify(job.error)}`);
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

describe("@ave/daemon + @ave/mobile Remote Supervision E2E", () => {
  it("pairs mobile operator & viewer, approves plan, cancels job, downloads verified video, and revokes access", async () => {
    const mediaDir = await makeTempDir("ave-r5-media-");
    const aveHome = await makeTempDir("ave-r5-home-");
    await execFileAsync("python3", [GOLDEN_SCRIPT, "--out-dir", mediaDir]);
    const cfrBytes = await readFile(path.join(mediaDir, "cfr_25fps_av.mp4"));

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

    const project = await owner.createProject({ requestId: "r5-p1", title: "Mobile E2E" });
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
      "r5-up-1",
    );
    const asset: SourceAsset = await importer.transfer(
      createUploadChannels(owner),
      sha256HexBrowserSafe,
    );
    const snap = await owner.getProject(project.projectId);
    const videoStream = asset.streams.find((s) => s.kind === "video")!;

    const draft: EditPlanDraftV1 = {
      schemaVersion: "video.edit-plan/v1",
      projectId: project.projectId,
      baseTimelineRevision: snap.revision,
      baseAssetManifestHash: snap.baseAssetManifestHash,
      preferredDeterministicBackendId: "ffmpeg",
      intent: "Mobile approved 2s trim",
      trimOperations: [
        {
          opId: "t1",
          order: "1",
          trackId: "v1",
          clipId: "c1",
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
    const submitted = await owner.submitPlan({
      requestId: "r5-plan-1",
      runId: "r5-run-1",
      toolCallId: "r5-tc-1",
      draft,
    });

    // Pair operator and viewer invitations
    const opInv = await owner.call<{ invitationId: string; token: string }>(
      "video.v1.create_invitation",
      { role: "operator", projectIds: [project.projectId] },
    );
    const viewInv = await owner.call<{ invitationId: string; token: string }>(
      "video.v1.create_invitation",
      { role: "viewer", projectIds: [project.projectId] },
    );

    const mobileOp = await MobileSupervisorSession.pairAndConnect({
      url: addr.wsUrl,
      ownerToken: addr.ownerToken,
      invitation: { invitationId: opInv.invitationId, token: opInv.token },
      WebSocketImpl: WebSocket as unknown as new (url: string) => never,
      reconnect: false,
    });
    expect(mobileOp.principal.role).toBe("operator");

    const mobileViewer = await MobileSupervisorSession.pairAndConnect({
      url: addr.wsUrl,
      ownerToken: addr.ownerToken,
      invitation: { invitationId: viewInv.invitationId, token: viewInv.token },
      WebSocketImpl: WebSocket as unknown as new (url: string) => never,
      reconnect: false,
    });
    expect(mobileViewer.principal.role).toBe("viewer");

    // Viewer can read, cannot approve
    const viewerProj = await mobileViewer.openProject(project.projectId, () => {});
    expect(viewerProj.snapshot.projectId).toBe(project.projectId);
    await expect(
      mobileViewer.approve(submitted.approval.approvalId, snap.revision, "r5-viewer-forbid"),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    viewerProj.unsubscribe();

    // Operator approves plan -> owner starts preview job -> operator downloads verified candidate
    const opEvents: EditorEvent[] = [];
    const opened = await mobileOp.openProject(project.projectId, (ev) => opEvents.push(ev));
    const decided = await mobileOp.approve(
      submitted.approval.approvalId,
      opened.snapshot.revision,
      "r5-mob-approve",
    );
    const previewJob = await owner.createJob({
      requestId: "r5-job-1",
      projectId: project.projectId,
      approvalId: decided.approval.approvalId,
      grantId: decided.grant!.grantId,
      expectedRevision: opened.snapshot.revision,
    });
    const done = await waitForJobTerminal(owner, project.projectId, previewJob.job.jobId, [
      "awaiting_review",
    ]);
    const candidate = done.artifacts.find((a) => a.kind === "candidate")!;
    const downloaded = await mobileOp.downloadVerifiedArtifact(
      project.projectId,
      candidate.artifactId,
      candidate.revision,
    );
    expect(downloaded.bytes.byteLength).toBeGreaterThan(1000);
    expect(downloaded.sha256).toBe(candidate.blob.sha256);

    // Reconnect catch-up test + device revocation
    const prevSeq = opened.snapshot.latestSeq;
    opened.unsubscribe();
    mobileOp.close();

    const reconnectedOp = await MobileSupervisorSession.pairAndConnect({
      url: addr.wsUrl,
      device: mobileOp.credential,
      WebSocketImpl: WebSocket as unknown as new (url: string) => never,
      reconnect: false,
    });
    const missed: EditorEvent[] = [];
    const unsubCatch = await reconnectedOp.client.subscribe(project.projectId, prevSeq, (ev) =>
      missed.push(ev),
    );
    expect(missed.length).toBeGreaterThan(0);

    await owner.call("video.v1.revoke_device", { deviceId: reconnectedOp.credential!.deviceId });
    await new Promise((r) => setTimeout(r, 50));
    expect(reconnectedOp.client.connected).toBe(false);
    await expect(
      MobileSupervisorSession.pairAndConnect({
        url: addr.wsUrl,
        device: mobileOp.credential,
        WebSocketImpl: WebSocket as unknown as new (url: string) => never,
        reconnect: false,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

    unsubCatch();
    mobileViewer.close();
    owner.close();
  });
});
