import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EditorPrincipal } from "#video-editor/contracts/v1";
import { expect, it } from "vitest";
import { ContentAddressedStore } from "./cas.js";
import { EditorStore } from "./store.js";

const owner: EditorPrincipal = { principalId: "owner", role: "owner", projectIds: null };

async function activeJobFixture(root: string, state: string = "rendering_preview") {
  const store = await EditorStore.create(root);
  const cas = new ContentAddressedStore(path.join(root, "cas"));
  await cas.initialize();
  const project = store.createProject({ requestId: "create", title: "Recovery", principal: owner });
  const blob = await cas.writeBytes(Buffer.from("fixture"), "video/mp4");
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
  store.updateJob(project.projectId, job.jobId, (snapshot) => ({
    ...snapshot,
    state: state as typeof snapshot.state,
    phaseDetail: "rendering",
  }));
  return { store, projectId: project.projectId, jobId: job.jobId };
}

it("daemon restart recovers an interrupted job and emits exactly one terminal state event", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "job-recovery-"));
  try {
    const first = await activeJobFixture(root);
    const before = first.store.events(first.projectId, "0", owner).events;
    const lastSeq = before.at(-1)?.seq ?? "0";
    first.store.close();

    const reopened = await EditorStore.create(root);
    const recovered = reopened.job(first.projectId, first.jobId, owner);
    expect(recovered.state).toBe("failed");
    expect(recovered.error).toMatchObject({ code: "NEEDS_RECONCILIATION", retryable: true });
    const after = reopened.events(first.projectId, lastSeq, owner).events;
    expect(after.map((event) => event.payload)).toEqual([
      expect.objectContaining({ jobId: first.jobId, state: "failed" }),
    ]);
    reopened.close();

    // A second reopen finds no active job and must not emit a duplicate terminal event.
    const again = await EditorStore.create(root);
    expect(again.events(first.projectId, lastSeq, owner).events).toEqual(after);
    again.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("recovers in-flight states to failed but leaves settled review/paused jobs untouched", async () => {
  for (const state of ["pausing", "cancel_requested", "rendering_final", "validating", "analyzing"]) {
    const root = await mkdtemp(path.join(tmpdir(), "job-recovery-matrix-"));
    try {
      const first = await activeJobFixture(root, state);
      first.store.close();
      const reopened = await EditorStore.create(root);
      const recovered = reopened.job(first.projectId, first.jobId, owner);
      expect(recovered.state).toBe("failed");
      expect(recovered.error).toMatchObject({ code: "NEEDS_RECONCILIATION" });
      reopened.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  for (const state of ["awaiting_review", "paused"]) {
    const root = await mkdtemp(path.join(tmpdir(), "job-recovery-skip-"));
    try {
      const first = await activeJobFixture(root, state);
      first.store.close();
      const reopened = await EditorStore.create(root);
      expect(reopened.job(first.projectId, first.jobId, owner).state).toBe(state);
      reopened.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
