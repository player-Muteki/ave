import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContentAddressedStore } from "./cas.js";
import { EditorError } from "./errors.js";
import { EditorStore } from "./store.js";
import type { EditorPrincipal } from "#video-editor/contracts/v1";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const owner: EditorPrincipal = { principalId: "owner", role: "owner", projectIds: null };
const viewer: EditorPrincipal = { principalId: "viewer", role: "viewer", projectIds: null };

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "editor-store-"));
  roots.push(root);
  const store = await EditorStore.create(root);
  const cas = new ContentAddressedStore(path.join(root, "cas"));
  await cas.initialize();
  const project = store.createProject({
    requestId: "create",
    title: "Real media",
    principal: owner,
  });
  return { root, store, cas, project };
}

function draft(project: ReturnType<EditorStore["createProject"]>, requestId = "plan") {
  const asset = project.assets[0]!;
  return {
    requestId,
    runId: "run",
    toolCallId: "tool",
    principal: owner,
    draft: {
      schemaVersion: "video.edit-plan/v1" as const,
      projectId: project.projectId,
      baseTimelineRevision: project.revision,
      baseAssetManifestHash: project.baseAssetManifestHash,
      intent: "Trim one second",
      trimOperations: [
        {
          opId: "trim-1",
          order: "1",
          trackId: "v1",
          clipId: "clip-1",
          source: {
            assetId: asset.assetId,
            assetContentHash: asset.original.sha256,
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
  };
}

describe("EditorStore durable workflow", () => {
  it("retains the reviewed anchor, its save receipt and input approval across database reopen", async () => {
    const { root, store, project, cas } = await fixture();
    const label = await cas.writeBytes(Uint8Array.of(255, 0), "application/octet-stream");
    const jpeg = await cas.writeBytes(Uint8Array.of(1, 2), "image/jpeg");
    const stream = { streamUid: "v", streamIndex: 0, kind: "video" as const, codec: "ffv1",
      timeBase: {num: "1", den: "9"}, disposition: {}, width: 2, height: 1 };
    await store.addAsset(project.projectId, {assetId: "clip", displayName: "clip", original: jpeg,
      presentationIndex: jpeg, probe: jpeg, streams: [stream], sourceNeverWritable: true}, "add", owner);
    const expectedRevision = store.project(project.projectId, owner).revision;
    const anchor = { projectId: project.projectId, assetId: "clip", streamUid: "v", frame: 0,
      sourcePresentationIndexHash: jpeg.sha256, points: [{x: 0, y: 0, foreground: true}] };
    const request = { requestId: "save", expectedRevision, anchor, expectedLabelSha256: label.sha256, expectedPreviewSha256: jpeg.sha256 };
    const header = {...anchor, sourceSha256: jpeg.sha256, pts: "0", timeBase: stream.timeBase, frameCount: 1,
      width: 2, height: 1, previewWidth: 2, previewHeight: 1, previewSha256: jpeg.sha256,
      mask: { engine: "sam2.1-tiny" as const, weightsSha256: "1".repeat(64), labelSha256: label.sha256, foregroundPixels: 1 }};
    const pending = store.saveMaskRevision(request, header, label, jpeg, owner);
    store.close();
    const reopened = await EditorStore.create(root);
    try {
      expect(reopened.savedMaskApproval(request, owner)).toEqual(pending);
      expect(() => reopened.savedMaskApproval({...request, expectedLabelSha256: jpeg.sha256}, owner)).toThrow();
      expect(reopened.maskRevision(project.projectId, pending.subjectId, owner).rawLabelMask).toEqual(label);
      expect(() => reopened.maskRevision("other-project", pending.subjectId, owner)).toThrow();
      const decision = reopened.decideApproval({requestId: "approval", decision: "approve", expectedRevision,
        approvalId: pending.approvalId}, owner);
      expect(decision.approval.status).toBe("approved");
      expect(decision.grant).toBeUndefined();
      expect(reopened.project(project.projectId, owner).jobs).toEqual([]);
    } finally { reopened.close(); }
  });

  it("replays creation and enforces viewer read-only project access", async () => {
    const { store, project, cas } = await fixture();
    const blob = await cas.writeBytes(Buffer.from("viewer-test"), "video/mp4");
    await store.addAsset(
      project.projectId,
      {
        assetId: blob.sha256,
        original: blob,
        displayName: "source",
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
    expect(
      store.createProject({ requestId: "create", title: "Real media", principal: owner }),
    ).toEqual(project);
    expect(() =>
      store.createProject({ requestId: "create", title: "Different", principal: owner }),
    ).toThrow(EditorError);
    store.registerDevice({
      projectId: project.projectId,
      principalId: viewer.principalId,
      role: "viewer",
      actor: owner,
    });
    expect(store.project(project.projectId, viewer).projectId).toBe(project.projectId);
    expect(() => store.createPlan({ ...draft(current), principal: viewer })).toThrow(
      "This operation requires operator access",
    );
    store.registerDevice({
      projectId: project.projectId,
      principalId: viewer.principalId,
      role: "operator",
      actor: owner,
    });
    expect(() => store.validateProposal(draft(current).draft, viewer)).toThrow(
      "This operation requires operator access",
    );
    expect(store.projectSummary(project.projectId, viewer)).toEqual({
      projectId: project.projectId,
      title: current.title,
      revision: current.revision,
    });
    expect(() => store.project("not-a-project", owner)).toThrow("The project does not exist");
    store.close();
  });

  it("checks each trim before creating an approval", async () => {
    const { store, cas, project } = await fixture();
    try {
      const blob = await cas.writeBytes(Buffer.from("two-trim fixture"), "video/mp4");
      await store.addAsset(project.projectId, {
        assetId: "source", original: blob, displayName: "fixture.mp4",
        streams: [{ streamUid: "stream:0", streamIndex: 0, kind: "video", codec: "h264", timeBase: { num: "1", den: "25" }, disposition: {} }],
        presentationIndex: blob, probe: blob, sourceNeverWritable: true,
      }, "asset", owner);
      const plan = draft(store.project(project.projectId, owner));
      const second = structuredClone(plan.draft.trimOperations[0]!);
      Object.assign(second, { opId: "trim-2", order: "2", clipId: "clip-2" });
      second.recordRange.start.num = "1";
      plan.draft.trimOperations.push(second);
      second.source.assetContentHash = "0".repeat(64);
      expect(() => store.createPlan(plan)).toThrow("missing or changed asset");
      second.source.assetContentHash = blob.sha256;
      second.sourceRange.start.num = "-1";
      expect(() => store.createPlan(plan)).toThrow("non-negative");
      expect(store.project(project.projectId, owner).approvals).toHaveLength(0);
      second.sourceRange.start.num = "2";
      expect(store.createPlan(plan).approval.status).toBe("pending");
    } finally {
      store.close();
    }
  });

  it("persists a rejected preview without granting or starting work on replay", async () => {
    const f = await fixture();
    let store = f.store;
    try {
      const blob = await f.cas.writeBytes(Buffer.from("approval-state fixture"), "video/mp4");
      const projectId = f.project.projectId;
      await store.addAsset(projectId, {
        assetId: "source", original: blob, displayName: "fixture.mp4",
        streams: [{ streamUid: "stream:0", streamIndex: 0, kind: "video", codec: "h264", timeBase: { num: "1", den: "25" }, disposition: {} }],
        presentationIndex: blob, probe: blob, sourceNeverWritable: true,
      }, "asset", owner);
      const before = store.project(projectId, owner);
      const { approval } = store.createPlan(draft(before));
      const decision = { approvalId: approval.approvalId, expectedRevision: before.revision, requestId: `reject-${approval.approvalId}`, decision: "reject" as const };
      const result = store.decideApproval(decision, owner);
      expect(result.approval.status).toBe("rejected");
      expect(result.grant).toBeUndefined();
      const after = store.project(projectId, owner);
      expect(after.jobs).toHaveLength(0);
      expect(after.approvals).toEqual([result.approval]);
      store.close();
      store = await EditorStore.create(f.root);
      expect(store.decideApproval(decision, owner)).toEqual(result);
      expect(() => store.decideApproval({...decision, requestId: "late-approve", decision: "approve"}, owner)).toThrow("already been decided");
      expect(store.project(projectId, owner)).toEqual(after);
    } finally {
      store.close();
    }
  });

  it("creates a plan, consumes its approval once and replays the same job request", async () => {
    const { store, cas, project } = await fixture();
    const blob = await cas.writeBytes(Buffer.from("not-a-video"), "video/mp4");
    const asset = {
      assetId: blob.sha256,
      original: blob,
      displayName: "source.mp4",
      streams: [
        {
          streamUid: "stream:0",
          streamIndex: 0,
          kind: "video" as const,
          codec: "h264",
          timeBase: { num: "1", den: "30" },
          disposition: {},
        },
      ],
      presentationIndex: blob,
      probe: blob,
      sourceNeverWritable: true as const,
    };
    await store.addAsset(project.projectId, asset, "asset", owner);
    const current = store.project(project.projectId, owner);
    const { plan, approval } = store.createPlan(draft(current));
    expect(plan.status).toBe("proposed");
    expect(store.createPlan(draft(current))).toEqual({ plan, approval });
    expect(() =>
      store.createJob({
        requestId: "job",
        projectId: current.projectId,
        approvalId: approval.approvalId,
        grantId: "invalid",
        expectedRevision: current.revision,
        principal: owner,
      }),
    ).toThrow("grant does not belong");
    const approved = store.decideApproval(
      {
        requestId: "approve",
        approvalId: approval.approvalId,
        expectedRevision: current.revision,
        decision: "approve",
      },
      owner,
    );
    const grant = approved.grant!;
    const created = store.createJob({
      requestId: "job",
      projectId: current.projectId,
      approvalId: approval.approvalId,
      grantId: grant.grantId,
      expectedRevision: current.revision,
      principal: owner,
    });
    expect(created.deduplicated).toBe(false);
    expect(created.job.state).toBe("rendering_preview");
    expect(
      store.createJob({
        requestId: "job",
        projectId: current.projectId,
        approvalId: approval.approvalId,
        grantId: grant.grantId,
        expectedRevision: current.revision,
        principal: owner,
      }),
    ).toEqual(created);
    expect(() =>
      store.decideApproval(
        {
          requestId: "approve-again",
          approvalId: approval.approvalId,
          expectedRevision: current.revision,
          decision: "approve",
        },
        owner,
      ),
    ).toThrow("already been decided");
    expect(store.events(current.projectId, "0", owner).events.length).toBeGreaterThan(0);
    store.close();
  });

  it("marks an active job interrupted on restart without completing its artifacts", async () => {
    const { store, cas, project, root } = await fixture();
    const blob = await cas.writeBytes(Buffer.from("fixture"), "video/mp4");
    await store.addAsset(
      project.projectId,
      {
        assetId: blob.sha256,
        original: blob,
        displayName: "fixture",
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
    const { approval } = store.createPlan(draft(current));
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
      projectId: current.projectId,
      approvalId: approval.approvalId,
      grantId: grant!.grantId,
      expectedRevision: current.revision,
      principal: owner,
    });
    store.close();
    const reopened = await EditorStore.create(root);
    expect(reopened.job(project.projectId, job.jobId, owner)).toMatchObject({
      state: "failed",
      artifacts: [],
      error: { code: "NEEDS_RECONCILIATION", retryable: true },
    });
    reopened.close();
  });
});
