import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EditorPrincipal } from "#video-editor/contracts/v1";
import { expect, it } from "vitest";
import { ContentAddressedStore } from "./cas.js";
import { MediaService } from "./media.js";
import { EditorStore } from "./store.js";

const owner: EditorPrincipal = { principalId: "owner", role: "owner", projectIds: null };

async function jobFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "media-failure-"));
  const store = await EditorStore.create(root);
  const cas = new ContentAddressedStore(path.join(root, "cas"));
  await cas.initialize();
  const project = store.createProject({
    requestId: "create",
    title: "Failure matrix",
    principal: owner,
  });
  const blob = await cas.writeBytes(Buffer.from("not-a-real-video"), "video/mp4");
  await store.addAsset(
    project.projectId,
    {
      assetId: blob.sha256,
      original: blob,
      displayName: "source.mp4",
      streams: [
        {
          streamUid: "stream:0",
          streamIndex: 0,
          kind: "video",
          codec: "h264",
          timeBase: { num: "1", den: "30" },
          disposition: {},
        },
      ],
      presentationIndex: blob,
      probe: blob,
      sourceNeverWritable: true,
    },
    "asset",
    owner,
  );
  const current = store.project(project.projectId, owner);
  const { approval } = store.createPlan({
    requestId: "plan",
    runId: "run",
    toolCallId: "tool",
    principal: owner,
    draft: {
      schemaVersion: "video.edit-plan/v1",
      projectId: project.projectId,
      baseTimelineRevision: current.revision,
      baseAssetManifestHash: current.baseAssetManifestHash,
      intent: "Trim one second",
      trimOperations: [
        {
          opId: "trim-1",
          order: "1",
          trackId: "v1",
          clipId: "clip-1",
          source: {
            assetId: blob.sha256,
            assetContentHash: blob.sha256,
            streamUid: "stream:0",
            probeRevision: "1",
          },
          sourceRange: { start: { num: "0", den: "1" }, duration: { num: "1", den: "1" } },
          recordRange: { start: { num: "0", den: "1" }, duration: { num: "1", den: "1" } },
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
    },
  });
  const { grant } = store.decideApproval(
    {
      requestId: "approve",
      approvalId: approval.approvalId,
      expectedRevision: current.revision,
      decision: "approve",
    },
    owner,
  );
  const { job } = store.createJob({
    requestId: "job",
    projectId: project.projectId,
    approvalId: approval.approvalId,
    grantId: grant!.grantId,
    expectedRevision: current.revision,
    principal: owner,
  });
  const media = new MediaService(store, cas, { ffmpeg: "ffmpeg", ffprobe: "ffprobe" });
  return { root, store, cas, media, projectId: project.projectId, jobId: job.jobId, blob };
}

it("rejects a source whose CAS bytes changed after import", async () => {
  const f = await jobFixture();
  try {
    await writeFile(f.cas.pathFor(f.blob), Buffer.from("tampered"));
    await expect(
      f.media.executeJob(f.projectId, f.jobId, new AbortController().signal),
    ).rejects.toMatchObject({ code: "ARTIFACT_HASH_MISMATCH" });
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

it("rejects an analysis job with no target asset", async () => {
  const f = await jobFixture();
  try {
    f.store.updateJob(f.projectId, f.jobId, (job) => ({ ...job, kind: "analysis" }));
    await expect(
      f.media.executeJob(f.projectId, f.jobId, new AbortController().signal),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", message: "Analysis job has no target asset" });
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

it("cancels a render job whose signal is already aborted before spawning ffmpeg", async () => {
  const f = await jobFixture();
  try {
    await expect(
      f.media.executeJob(f.projectId, f.jobId, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
