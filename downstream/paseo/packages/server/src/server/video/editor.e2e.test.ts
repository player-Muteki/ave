import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { encodeFramedChunk, decodeFramedChunk } from "#video-editor/bytes";
import {
  UploadStatusSchema,
  SourceAssetSchema,
  ProjectSnapshotSchema,
  JobSnapshotSchema,
  CreateJobResultSchema,
  DecideApprovalResultSchema,
  type ArtifactRef,
} from "#video-editor/contracts/v1";
import { ContentAddressedStore } from "./cas.js";

import { assertCandidateAudio, parsePresentationFrames } from "./media.js";

const execute = promisify(execFile);

test("preserves integer frame ticks that differ by one above the JS safe integer limit", () => {
  expect(
    parsePresentationFrames(
      '{"frames":[{"stream_index":0,"pts":9007199254740992,"duration":1},{"stream_index":0,"pts":9007199254740993,"duration":2}]}',
    ),
  ).toEqual([
    { stream_index: 0, pts: "9007199254740992", duration: "1" },
    { stream_index: 0, pts: "9007199254740993", duration: "2" },
  ]);
});

test("checks the candidate audio profile on fully decodable MP4s", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "video-track-qa-"));
  try {
    const source = [{ kind: "audio" as const, channels: 1 }];
    for (const [name, input] of [
      ["valid", "sine=sample_rate=48000:duration=1"],
      ["wrong-clock", "sine=sample_rate=44100:duration=1"],
      ["missing-audio", "color=blue:size=96x64:rate=25:duration=1"],
    ] as const) {
      const file = path.join(root, `${name}.mp4`);
      await execute("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25:duration=1", "-f", "lavfi", "-i", input, "-map", "0:0", "-map", "1:0", "-c:v", "libx264", "-c:a", "aac", file], {timeout: 15000});
      await execute("ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-i", file, "-map", "0", "-f", "null", "-"], {timeout: 15000});
      const probe = await execute("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file], {timeout: 15000});
      const {streams} = JSON.parse(probe.stdout);
      expect(streams).toHaveLength(2);
      const check = () => assertCandidateAudio(source, streams);
      if (name === "valid") {
        expect(check).not.toThrow();
        expect(() => assertCandidateAudio([{kind:"audio", channels:2}], streams)).toThrow("Candidate audio tracks");
      } else expect(check).toThrow("Candidate audio tracks");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

async function sha256(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

test.each([
  { cadence: "CFR", rate: 30, firstMs: 0, durationMs: 1000, expectedFrames: 30 },
  { cadence: "CFR", rate: 25, firstMs: 120, durationMs: 1280, expectedFrames: 32 },
  { cadence: "silent then tone", rate: 25, firstMs: 0, durationMs: 2000, expectedFrames: 50 },
  { cadence: "VFR", rate: 25, firstMs: 0, durationMs: 1000, expectedFrames: 24 },
])("a real daemon imports, approves, renders, and serves a validated $rate fps video ($cadence)", async ({cadence, rate, firstMs, durationMs, expectedFrames}) => {
  const duration = { num: String(durationMs), den: "1000" };
  const root = await mkdtemp(path.join(tmpdir(), "video-editor-e2e-"));
  const source = path.join(root, "源 clip.mp4");
  await execute(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=320x180:rate=${rate}:duration=3`,
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=3",
      ...(cadence === "VFR" ? ["-vf", "select='not(eq(n,5))'", "-fps_mode", "vfr", "-bf", "0"] : []),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      source,
    ],
    { timeout: 60_000 },
  );
  const sourceHash = await sha256(source);
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: path.join(root, "home"),
    cleanup: false,
    mcpEnabled: false,
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.18.0",
  });
  try {
    await client.connect();
    const capabilities = await client.invokePluginRpc(
      "video-editor",
      "video.v1.get_capabilities",
      {},
    );
    expect(capabilities).toMatchObject({
      protocolVersion: "1",
      deterministicBackends: [
        { id: "ffmpeg", available: true },
        { id: "filmcraft", available: false },
      ],
    });
    const createdProject = await client.invokePluginRpc("video-editor", "video.v1.create_project", {
      requestId: "project-1",
      title: "Real sample",
    });
    const projectId = Reflect.get(createdProject, "projectId") as string;
    expect(
      await client.invokePluginRpc("video-editor", "video.v1.create_project", {
        requestId: "project-1",
        title: "Real sample",
      }),
    ).toEqual(createdProject);
    const bytes = await readFile(source);
    const invoke = (method: string, input: unknown) =>
      client.invokePluginRpc("video-editor", `video.v1.${method}`, input);
    await expect(
      invoke("import_asset", {
        projectId,
        requestId: "invalid-path",
        displayName: "source.mp4",
        authorizedPath: source,
      }),
    ).rejects.toThrow();
    const upload = UploadStatusSchema.parse(
      await invoke("create_upload", {
        requestId: "upload-1",
        projectId,
        displayName: "source.mp4",
        mediaType: "video/mp4",
        expectedSize: bytes.length.toString(),
        expectedSha256: sourceHash,
      }),
    );
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      const chunk = bytes.subarray(offset, offset + 8192);
      await invoke(
        "write_upload_chunk",
        encodeFramedChunk(
          {
            requestId: `chunk-${offset}`,
            uploadId: upload.uploadId,
            offset: offset.toString(),
            length: chunk.length.toString(),
            chunkSha256: createHash("sha256").update(chunk).digest("hex"),
          },
          chunk,
        ),
      );
    }
    const commit = { requestId: "commit-1", uploadId: upload.uploadId, finalSha256: sourceHash };
    const asset = SourceAssetSchema.parse(await invoke("commit_upload", commit));
    expect(asset.original.sha256).toBe(sourceHash);
    const beforeReplay = await invoke("get_project", { projectId });
    expect(await invoke("commit_upload", commit)).toEqual(asset);
    await expect(
      invoke("commit_upload", { ...commit, finalSha256: "0".repeat(64) }),
    ).rejects.toThrow();
    await expect(
      invoke("commit_upload", { ...commit, requestId: "another-commit" }),
    ).rejects.toThrow();
    expect(await invoke("get_project", { projectId })).toEqual(beforeReplay);
    let silentAsset: typeof asset | undefined;
    if (cadence === "silent then tone") {
      const silentPath = path.join(root, "silent.mp4");
      await execute("ffmpeg", ["-v", "error", "-i", source, "-map", "0:v:0", "-an", "-c", "copy", silentPath]);
      const payload = await readFile(silentPath);
      const digest = await sha256(silentPath);
      const { uploadId } = UploadStatusSchema.parse(await invoke("create_upload", {
        requestId: "silent-upload", projectId, displayName: "silent.mp4", mediaType: "video/mp4",
        expectedSize: String(payload.length), expectedSha256: digest,
      }));
      for (let offset = 0; offset < payload.length; offset += 8192) {
        const chunk = payload.subarray(offset, offset + 8192);
        await invoke("write_upload_chunk", encodeFramedChunk({requestId: `silent-${offset}`, uploadId,
          offset: String(offset), length: String(chunk.length), chunkSha256: createHash("sha256").update(chunk).digest("hex")}, chunk));
      }
      silentAsset = SourceAssetSchema.parse(await invoke("commit_upload", {requestId: "silent-commit", uploadId, finalSha256: digest}));
    }
    const current = await client.invokePluginRpc("video-editor", "video.v1.get_project", {
      projectId,
    });
    const operation = {
      opId: "trim-1",
      order: "1",
      trackId: "v1",
      clipId: "clip-1",
      source: {
        assetId: Reflect.get(asset, "assetId"),
        assetContentHash: Reflect.get(asset, "original").sha256,
        streamUid: "stream:0",
        probeRevision: "1",
      },
      sourceRange: { start: { num: String(firstMs), den: "1000" }, duration },
      recordRange: { start: { num: "0", den: "1" }, duration },
    };
    const operations = [operation];
    if (silentAsset) {
      operation.sourceRange.duration = operation.recordRange.duration = {num: "1", den: "1"};
      const silent = structuredClone(operation);
      silent.opId = "silent-op";
      silent.clipId = "silent-clip";
      silent.source.assetId = silentAsset.assetId;
      silent.source.assetContentHash = silentAsset.original.sha256;
      operation.order = "2";
      operation.recordRange.start = {num: "1", den: "1"};
      operations.unshift(silent);
    }
    const { plan, approval } = (await client.invokePluginRpc(
      "video-editor",
      "video.v1.submit_plan",
      {
        requestId: "plan-1",
        runId: "run-1",
        toolCallId: "tool-1",
        draft: {
          schemaVersion: "video.edit-plan/v1",
          projectId,
          baseTimelineRevision: Reflect.get(current, "revision"),
          baseAssetManifestHash: Reflect.get(current, "baseAssetManifestHash"),
          intent: `Keep ${durationMs} milliseconds starting at ${firstMs} ms`,
          trimOperations: operations,
          transformOperations: [],
          audioOperations: [],
          transitionOperations: [],
          subtitleOperations: [],
          generationRequests: [],
          qaRequirements: [],
          externalDestinations: [],
          maxCostMicros: "0",
        },
      },
    )) as { plan: { planHash: string }; approval: { approvalId: string } };
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
    const { grant } = (await client.invokePluginRpc("video-editor", "video.v1.decide_approval", {
      requestId: "approve-1",
      approvalId: approval.approvalId,
      expectedRevision: Reflect.get(current, "revision"),
      decision: "approve",
    })) as { grant: { grantId: string } };
    const { job } = (await client.invokePluginRpc("video-editor", "video.v1.create_job", {
      requestId: "job-1",
      projectId,
      approvalId: approval.approvalId,
      grantId: grant.grantId,
      expectedRevision: Reflect.get(current, "revision"),
    })) as { job: { jobId: string } };
    let snapshot = await client.invokePluginRpc("video-editor", "video.v1.get_job", {
      projectId,
      jobId: job.jobId,
    });
    for (
      let attempt = 0;
      attempt < 120 && Reflect.get(snapshot, "state") === "rendering_preview";
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      snapshot = await client.invokePluginRpc("video-editor", "video.v1.get_job", {
        projectId,
        jobId: job.jobId,
      });
    }
    expect(snapshot).toMatchObject({ state: "awaiting_review", progress: { completedUnits: "1" } });
    const artifacts = Reflect.get(snapshot, "artifacts") as Array<{
      kind: string;
      blob: { sha256: string; bytes: string };
    }>;
    const candidate = artifacts.find((artifact) => artifact.kind === "candidate")!;
    const cas = new ContentAddressedStore(path.join(daemon.paseoHome, "video-editor", "cas"));
    const frameIndex = JSON.parse((await cas.readBytes(asset.presentationIndex)).toString("utf8"));
    const sourceVideo = asset.streams.find((stream) => stream.kind === "video")!;
    expect(frameIndex).toMatchObject({
      schemaVersion: "video.presentation-index/v2",
      sourceSha256: sourceHash,
    });
    expect(frameIndex.streams).toContainEqual({
      streamIndex: sourceVideo.streamIndex,
      streamUid: sourceVideo.streamUid,
      timeBase: sourceVideo.timeBase,
    });
    const sourceFrames = frameIndex.frames.filter(
      (frame: { stream_index: number }) => frame.stream_index === sourceVideo.streamIndex,
    );
    const grid = Array.from({length: rate * 3}, (_, i) => i).filter(i => cadence !== "VFR" || i !== 5);
    expect(sourceFrames).toHaveLength(grid.length);
    expect(sourceFrames[0]).toMatchObject({ pts: "0", key_frame: 1 });
    for (const [ordinal, tick] of grid.entries()) {
      expect(BigInt(sourceFrames[ordinal].pts) * BigInt(sourceVideo.timeBase.num) * BigInt(rate)).toBe(
        BigInt(tick) * BigInt(sourceVideo.timeBase.den),
      );
    }
    async function expectTrimClock(file: string) {
      const { stdout: json } = await execute("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_frames", "-show_streams", "-show_entries", "stream=time_base:frame=pts", "-of", "json", file], { timeout: 30_000 });
      const measured: {streams: {time_base:string}[]; frames: {pts:number}[]} = JSON.parse(json);
      const [num, den] = measured.streams[0]!.time_base.split("/").map(BigInt);
      const start = firstMs * rate / 1000;
      const retained = grid.filter(tick => tick >= start && tick < start + durationMs * rate / 1000);
      expect(measured.frames.map(f => BigInt(f.pts) * num! * BigInt(rate))).toEqual(retained.map(tick => BigInt(tick - start) * den!));
    }
    const exported = cas.pathFor(candidate.blob);
    await expectTrimClock(exported);
    await execute(
      "ffmpeg",
      ["-v", "error", "-xerror", "-i", exported, "-map", "0", "-f", "null", "-"],
      {
        timeout: 60_000,
      },
    );
    const { stdout } = await execute(
      "ffprobe",
      ["-v", "error", "-count_frames", "-show_streams", "-of", "json", exported],
      { timeout: 60_000 },
    );
    expect(JSON.parse(stdout).streams).toMatchObject([
      {
        codec_type: "video",
        codec_name: "h264",
        start_pts: 0,
        duration: (durationMs / 1000).toFixed(6),
        nb_read_frames: String(expectedFrames),
      },
      {
        codec_type: "audio",
        codec_name: "aac",
        start_pts: 0,
        sample_rate: "48000",
        time_base: "1/48000",
        duration_ts: durationMs * 48,
      },
    ]);
    const qa = artifacts.find((artifact) => artifact.kind === "qa")!;
    const qaPath = cas.pathFor(qa.blob);
    expect(await sha256(qaPath)).toBe(qa.blob.sha256);
    expect(JSON.parse(await readFile(qaPath, "utf8"))).toMatchObject({
      reportId: job.jobId,
      subjectHash: candidate.blob.sha256,
      gates: [
        { gate: "G4", status: "passed" },
        { gate: "G5", status: "manual_required" },
      ],
    });
    expect(await sha256(exported)).toBe(candidate.blob.sha256);
    expect((await stat(exported)).size.toString()).toBe(candidate.blob.bytes);
    expect(await sha256(source)).toBe(sourceHash);
    expect(
      await client.invokePluginRpc("video-editor", "video.v1.read_asset_chunk", {
        projectId,
        assetId: Reflect.get(asset, "assetId"),
        revision: Reflect.get(current, "revision"),
        offset: "0",
        length: "16",
      }),
    ).toBeInstanceOf(Uint8Array);
    async function advance(purpose: "final" | "export", parentId: string, expectedHash: string) {
      const project = ProjectSnapshotSchema.parse(await invoke("get_project", { projectId }));
      const review = project.approvals.find(
        (a) => a.purpose === purpose && a.subjectId === parentId,
      )!;
      expect(review).toMatchObject({
        status: "pending",
        planHash: plan.planHash,
        subjectHash: expectedHash,
      });
      const request = {
        projectId,
        approvalId: review.approvalId,
        expectedRevision: project.revision,
      };
      await expect(
        invoke("create_job", { ...request, grantId: grant.grantId, requestId: `wrong-${purpose}` }),
      ).rejects.toThrow();
      const decision = DecideApprovalResultSchema.parse(
        await invoke("decide_approval", {
          approvalId: review.approvalId,
          expectedRevision: project.revision,
          requestId: `approve-${purpose}`,
          decision: "approve",
        }),
      );
      expect(decision.grant).toMatchObject({ purpose, subjectHash: expectedHash });
      const start = { ...request, grantId: decision.grant!.grantId, requestId: `start-${purpose}` };
      const result = CreateJobResultSchema.parse(await invoke("create_job", start));
      await expect(
        invoke("create_job", { ...start, requestId: `repeat-${purpose}` }),
      ).rejects.toThrow();
      const state = purpose === "final" ? "awaiting_delivery_approval" : "completed";
      return expect
        .poll(
          async () =>
            JobSnapshotSchema.parse(await invoke("get_job", { projectId, jobId: result.job.jobId }))
              .state,
          { timeout: 15000 },
        )
        .toBe(state)
        .then(async () =>
          JobSnapshotSchema.parse(await invoke("get_job", { projectId, jobId: result.job.jobId })),
        );
    }
    const previewArtifact = JobSnapshotSchema.parse(snapshot).artifacts.find(a => a.kind === "candidate")!;
    const readPreview = { projectId, assetId: previewArtifact.artifactId, revision: previewArtifact.revision, offset: "0", length: "16" };
    const reviewPacket = await invoke("read_asset_chunk", readPreview);
    if (!(reviewPacket instanceof Uint8Array)) throw new Error("Expected binary review packet");
    expect(decodeFramedChunk(reviewPacket).payload).toEqual(new Uint8Array((await readFile(exported)).subarray(0, 16)));
    await expect(invoke("read_asset_chunk", {...readPreview, revision: (BigInt(previewArtifact.revision) + 1n).toString()})).rejects.toThrow();
    const final = await advance("final", job.jobId, candidate.blob.sha256);
    const reviewed = final.artifacts.find((a) => a.kind === "candidate")!;
    await expect(invoke("read_asset_chunk", {...readPreview, assetId: reviewed.artifactId, revision: reviewed.revision})).rejects.toThrow();
    const delivery = await advance("export", final.jobId, reviewed.blob.sha256);
    const published = delivery.artifacts.find((a) => a.kind === "export")!;
    expect(published.blob).toEqual(reviewed.blob);
    async function download(a: ArtifactRef) {
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < Number(a.blob.bytes); offset += 4096) {
        const frame = await invoke("read_asset_chunk", {
          projectId,
          assetId: a.artifactId,
          revision: a.revision,
          offset: String(offset),
          length: "4096",
        });
        if (!(frame instanceof Uint8Array)) throw new Error("Expected binary media chunk");
        const { metadata, payload } = decodeFramedChunk(frame);
        expect(JSON.parse(new TextDecoder().decode(metadata))).toMatchObject({
          assetSha256: a.blob.sha256,
          offset: String(offset),
          chunkSha256: createHash("sha256").update(payload).digest("hex"),
        });
        chunks.push(Buffer.from(payload));
      }
      const assembled = Buffer.concat(chunks);
      expect(createHash("sha256").update(assembled).digest("hex")).toBe(a.blob.sha256);
      return assembled;
    }
    const finalBytes = await download(published);
    const manifest = JSON.parse(
      (await download(delivery.artifacts.find((a) => a.kind === "manifest")!)).toString(),
    );
    expect(manifest).toMatchObject({
      output: published.blob,
      planHash: plan.planHash,
      revision: reviewed.revision,
      qaReport: { subjectHash: reviewed.blob.sha256, revision: reviewed.revision },
    });
    const downloaded = path.join(root, "approved final.mp4");
    await writeFile(downloaded, finalBytes);
    await expectTrimClock(downloaded);
    if (silentAsset) {
      const pcm = path.join(root, "delivered.s16le");
      await execute("ffmpeg", ["-v", "error", "-i", downloaded, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "s16le", pcm]);
      const samples = await readFile(pcm);
      const peak = (from: number, until: number) => {
        let max = 0;
        for (let i = from; i < until; i++) max = Math.max(max, Math.abs(samples.readInt16LE(i * 2)));
        return max;
      };
      // Exclude 10 ms on each side of the AAC transition.
      expect(peak(480, 47520)).toBeLessThan(20);
      expect(peak(48480, 48960)).toBeGreaterThan(500);
      expect(manifest.segments.map((s: {assetId: string}) => s.assetId)).toEqual([silentAsset.assetId, asset.assetId]);
    }
    await execute(
      "ffmpeg",
      ["-v", "error", "-xerror", "-i", downloaded, "-map", "0", "-f", "null", "-"],
      { timeout: 60000 },
    );
    const finalProbe = await execute("ffprobe", [
      "-v",
      "error",
      "-count_frames",
      "-show_streams",
      "-of",
      "json",
      downloaded,
    ]);
    expect(JSON.parse(finalProbe.stdout).streams).toMatchObject([
      {
        width: 320,
        height: 180,
        codec_name: "h264",
        start_pts: 0,
        nb_read_frames: String(expectedFrames),
        duration: (durationMs / 1000).toFixed(6),
      },
      { codec_name: "aac", start_pts: 0, duration_ts: durationMs * 48, time_base: "1/48000" },
    ]);
    expect(await sha256(source)).toBe(sourceHash);
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);

test("a paired viewer can read only its project and loses access when revoked", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const url = `ws://127.0.0.1:${daemon.port}/ws`;
  const owner = new DaemonClient({ url });
  const clients = [owner];
  try {
    await owner.connect();
    const invoke = (method: string, input: unknown) =>
      owner.invokePluginRpc("video-editor", `video.v1.${method}`, input);
    const create = async (title: string) =>
      ProjectSnapshotSchema.parse(
        await invoke("create_project", { requestId: `create-${title}`, title }),
      );
    const a = await create("A");
    const b = await create("B");
    const invitation = await invoke("create_invitation", {
      projectId: a.projectId,
      role: "viewer",
    });
    const issued = await invoke("redeem_invitation", invitation);
    await expect(invoke("redeem_invitation", invitation)).rejects.toThrow();
    if (
      !issued ||
      typeof issued !== "object" ||
      !("deviceId" in issued) ||
      typeof issued.deviceId !== "string" ||
      !("credential" in issued) ||
      typeof issued.credential !== "string"
    ) {
      throw new Error("No device credential returned");
    }
    const videoDevice = { deviceId: issued.deviceId, token: issued.credential };
    const openViewer = () => {
      const client = new DaemonClient({ url, videoDevice, clientId: "viewer" });
      clients.push(client);
      return client;
    };
    const viewer = openViewer();
    await viewer.connect();
    expect(viewer.getLastServerInfoMessage()?.permissions).toEqual(["video.read"]);
    expect(await viewer.getVideoProjectSummary(a.projectId)).toEqual({
      requestId: expect.any(String),
      projectId: a.projectId,
      title: "A",
      revision: a.revision,
    });
    await expect(viewer.getVideoProjectSummary(b.projectId)).rejects.toThrow(/access denied/i);
    // Project discovery over the device channel returns only the scoped grant.
    expect(await viewer.invokePluginRpc("video-editor", "video.v1.list_projects", {})).toEqual({
      projects: [{ projectId: a.projectId, title: "A", revision: a.revision }],
    });
    const ownerProjects = (await invoke("list_projects", {})) as {
      projects: Array<{ projectId: string }>;
    };
    expect(ownerProjects.projects.map((p) => p.projectId).sort()).toEqual(
      [a.projectId, b.projectId].sort(),
    );
    await expect(
      viewer.invokePluginRpc("video-editor", "video.v1.create_project", {
        requestId: "denied",
        title: "C",
      }),
    ).rejects.toThrow(/cannot modify this video project/i);
    await expect(viewer.invokePluginRpc("other-plugin", "read", {})).rejects.toThrow(
      /access denied/i,
    );
    await invoke("revoke_device", { deviceId: issued.deviceId });
    await expect.poll(() => viewer.isConnected).toBe(false);
    await expect(viewer.getVideoProjectSummary(a.projectId)).rejects.toThrow();
    await expect(openViewer().connect()).rejects.toThrow();
    expect(
      ProjectSnapshotSchema.parse(await invoke("get_project", { projectId: a.projectId })).title,
    ).toBe("A");
  } finally {
    try {
      await Promise.all(clients.map((client) => client.close()));
    } finally {
      await daemon.close();
    }
  }
}, 30_000);

test("a paired operator reaches approval and job controls but never device management", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const url = `ws://127.0.0.1:${daemon.port}/ws`;
  const owner = new DaemonClient({ url });
  const clients = [owner];
  try {
    await owner.connect();
    const invoke = (method: string, input: unknown) =>
      owner.invokePluginRpc("video-editor", `video.v1.${method}`, input);
    const project = ProjectSnapshotSchema.parse(
      await invoke("create_project", { requestId: "create-op", title: "Ops" }),
    );
    const invitation = await invoke("create_invitation", {
      projectId: project.projectId,
      role: "operator",
    });
    const issued = await invoke("redeem_invitation", invitation);
    if (
      !issued ||
      typeof issued !== "object" ||
      !("deviceId" in issued) ||
      typeof issued.deviceId !== "string" ||
      !("credential" in issued) ||
      typeof issued.credential !== "string"
    ) {
      throw new Error("No device credential returned");
    }
    const operator = new DaemonClient({
      url,
      videoDevice: { deviceId: issued.deviceId, token: issued.credential },
      clientId: "operator",
    });
    clients.push(operator);
    await operator.connect();
    expect(operator.getLastServerInfoMessage()?.permissions).toEqual(["video.read", "video.write"]);
    const call = (method: string, input: unknown) =>
      operator.invokePluginRpc("video-editor", `video.v1.${method}`, input);
    // The role gate is passed: the store answers with a domain error for the missing subject,
    // not a channel-level access denial.
    await expect(
      call("decide_approval", {
        requestId: "op-approve",
        approvalId: "missing",
        expectedRevision: project.revision,
        decision: "approve",
      }),
    ).rejects.toThrow(/does not exist/i);
    await expect(
      call("control_job", {
        projectId: project.projectId,
        jobId: "missing",
        requestId: "op-cancel",
        action: "cancel",
      }),
    ).rejects.toThrow(/does not exist/i);
    // Owner-only device management stays denied for the operator.
    await expect(
      call("create_invitation", { projectId: project.projectId, role: "viewer" }),
    ).rejects.toThrow(/only the project owner/i);
    await expect(call("revoke_device", { deviceId: issued.deviceId })).rejects.toThrow(
      /only the project owner/i,
    );
    expect(await operator.getVideoProjectSummary(project.projectId)).toMatchObject({
      projectId: project.projectId,
      title: "Ops",
    });
    // An operator discovers its own project and reads the event log over the device channel.
    expect(await call("list_projects", {})).toEqual({
      projects: [{ projectId: project.projectId, title: "Ops", revision: project.revision }],
    });
    const log = (await call("get_events", { projectId: project.projectId, afterSeq: "0" })) as {
      events: Array<{ type: string }>;
    };
    expect(log.events.length).toBeGreaterThan(0);
  } finally {
    try {
      await Promise.all(clients.map((client) => client.close()));
    } finally {
      await daemon.close();
    }
  }
}, 30_000);
