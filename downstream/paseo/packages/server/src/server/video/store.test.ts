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
    const jpeg = await cas.writeBytes(Buffer.from("sheet"), "image/jpeg");
    const sheetId = store.registerContactSheet(project.projectId, current.revision, blob.sha256, jpeg, owner);
    expect(store.contactSheetBlob(project.projectId, current.revision, sheetId, viewer)).toEqual(jpeg);
    expect(() => store.contactSheetBlob(project.projectId, current.revision, "contact:unknown", viewer)).toThrow("No such contact sheet");
    expect(() => store.contactSheetBlob(project.projectId, project.revision, sheetId, viewer)).toThrow("fresh project snapshot");
    const other = store.createProject({ requestId: "other", title: "Other project", principal: owner });
    expect(() => store.contactSheetBlob(other.projectId, other.revision, sheetId, owner)).toThrow("No such contact sheet");
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

describe("listProjects", () => {
  it("owner sees every project; a paired device sees only its scoped grants", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "editor-list-"));
    roots.push(root);
    const store = await EditorStore.create(root);
    const a = store.createProject({ requestId: "a", title: "A", principal: owner });
    const b = store.createProject({ requestId: "b", title: "B", principal: owner });
    expect(store.listProjects(owner).map((p) => p.projectId).sort()).toEqual(
      [a.projectId, b.projectId].sort(),
    );
    store.registerDevice({ projectId: a.projectId, principalId: "device-1", role: "viewer", actor: owner });
    const device: EditorPrincipal = { principalId: "device-1", role: "viewer", projectIds: [a.projectId] };
    expect(store.listProjects(device)).toEqual([
      { projectId: a.projectId, title: "A", revision: a.revision },
    ]);
    // A grant outside the credential's scope is still filtered out.
    store.registerDevice({ projectId: b.projectId, principalId: "device-1", role: "viewer", actor: owner });
    expect(store.listProjects(device).map((p) => p.projectId)).toEqual([a.projectId]);
    // An unpaired principal sees nothing.
    const stranger: EditorPrincipal = { principalId: "nobody", role: "viewer", projectIds: null };
    expect(store.listProjects(stranger)).toEqual([]);
    store.close();
  });
});

describe("controlJob terminal matrix", () => {
  it("pause/resume/cancel reach the right states with and without a worker and emit events", async () => {
    const { store, cas, project } = await fixture();
    const blob = await cas.writeBytes(Buffer.from("fixture"), "video/mp4");
    await store.addAsset(
      project.projectId,
      {
        assetId: blob.sha256,
        original: blob,
        displayName: "fixture",
        streams: [
          { streamUid: "stream:0", streamIndex: 0, kind: "video", codec: "h264", timeBase: { num: "1", den: "30" }, disposition: {} },
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
      { requestId: "approve", approvalId: approval.approvalId, expectedRevision: current.revision, decision: "approve" },
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
    expect(job.state).toBe("rendering_preview");
    const control = (action: "pause" | "resume" | "cancel", requestId: string, hasWorker: boolean) =>
      store.controlJob({ projectId: current.projectId, jobId: job.jobId, action, requestId, principal: owner }, hasWorker);
    // No worker: pause finalizes straight to paused, resume re-queues the start state.
    expect(control("pause", "pause", false).job.state).toBe("paused");
    expect(control("resume", "resume", false).job.state).toBe("rendering_preview");
    // With a worker: pause only requests a safe checkpoint.
    expect(control("pause", "pause-worker", true).job.state).toBe("pausing");
    // No worker: cancel finalizes straight to cancelled even from a requested state.
    expect(control("cancel", "cancel", false).job.state).toBe("cancelled");
    expect(() => control("cancel", "cancel-again", false)).toThrow("already finished");
    const states = store
      .events(current.projectId, "0", owner)
      .events.filter((e) => e.type === "job.state.changed")
      .map((e) => (e.payload as { state: string }).state);
    expect(states).toEqual(
      expect.arrayContaining(["rendering_preview", "paused", "pausing", "cancelled"]),
    );
    store.close();
  });
});

describe("events cursor and isolation", () => {
  it("filters by afterSeq, keeps per-project seq monotonic, and isolates projects", async () => {
    const { store, project } = await fixture();
    const second = store.createProject({ requestId: "second", title: "Second", principal: owner });

    const all = store.events(project.projectId, "0", owner).events;
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((e) => e.projectId === project.projectId)).toBe(true);
    const seqs = all.map((e) => Number(e.seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    // Cursor at the latest seq yields nothing further.
    const lastSeq = all[all.length - 1]!.seq;
    expect(store.events(project.projectId, lastSeq, owner).events).toHaveLength(0);
    // Cursor before the first event yields everything.
    expect(store.events(project.projectId, "0", owner).events.length).toBe(all.length);

    // The second project's events never leak into the first project's stream.
    const secondEvents = store.events(second.projectId, "0", owner).events;
    expect(secondEvents.every((e) => e.projectId === second.projectId)).toBe(true);
    expect(secondEvents.some((e) => e.projectId === project.projectId)).toBe(false);
    store.close();
  });
});

describe("createProject scope and transactional rollback", () => {
  it("rejects a scoped device creating an out-of-scope project and rolls back fully", async () => {
    const { store, project } = await fixture();
    const before = store.listProjects(owner).length;
    const scopedDevice: EditorPrincipal = {
      principalId: "device-x",
      role: "operator",
      projectIds: [project.projectId],
    };
    // The new project id is outside the credential's scope, so the snapshot read
    // inside the mutation fails authorization and the whole transaction rolls back.
    expect(() =>
      store.createProject({ requestId: "dev-create", title: "Out of scope", principal: scopedDevice }),
    ).toThrow("no access to this project");
    expect(store.listProjects(owner).length).toBe(before);
    // The rolled-back grant left the device with no project grants at all.
    expect(store.listProjects(scopedDevice)).toEqual([]);
    store.close();
  });
});

describe("plan validation edges", () => {
  async function withAsset() {
    const { store, cas, project } = await fixture();
    const blob = await cas.writeBytes(Buffer.from("not-a-video"), "video/mp4");
    await store.addAsset(
      project.projectId,
      {
        assetId: blob.sha256,
        original: blob,
        displayName: "source.mp4",
        streams: [
          { streamUid: "stream:0", streamIndex: 0, kind: "video" as const, codec: "h264", timeBase: { num: "1", den: "30" }, disposition: {} },
        ],
        presentationIndex: blob,
        probe: blob,
        sourceNeverWritable: true as const,
      },
      "asset",
      owner,
    );
    return { store, current: store.project(project.projectId, owner) };
  }

  it("rejects stale revision/manifest, bad asset identity, missing stream and invalid ranges", async () => {
    const { store, current } = await withAsset();
    const base = draft(current).draft;
    expect(() => store.validateProposal(base, owner)).not.toThrow();

    expect(() => store.validateProposal({ ...base, baseTimelineRevision: "999" }, owner)).toThrow("older project snapshot");
    expect(() => store.validateProposal({ ...base, baseAssetManifestHash: "c".repeat(64) }, owner)).toThrow("older project snapshot");

    const op = base.trimOperations[0]!;
    const badAsset = { ...base, trimOperations: [{ ...op, source: { ...op.source, assetId: "missing" } }] };
    expect(() => store.validateProposal(badAsset as typeof base, owner)).toThrow("missing or changed asset");
    const badHash = { ...base, trimOperations: [{ ...op, source: { ...op.source, assetContentHash: "d".repeat(64) } }] };
    expect(() => store.validateProposal(badHash as typeof base, owner)).toThrow("missing or changed asset");
    const badStream = { ...base, trimOperations: [{ ...op, source: { ...op.source, streamUid: "stream:99" } }] };
    expect(() => store.validateProposal(badStream as typeof base, owner)).toThrow("existing video stream");

    const negStart = { ...base, trimOperations: [{ ...op, sourceRange: { start: { num: "-1", den: "1" }, duration: { num: "1", den: "1" } } }] };
    expect(() => store.validateProposal(negStart as typeof base, owner)).toThrow("non-empty, non-negative");
    const zeroDur = { ...base, trimOperations: [{ ...op, sourceRange: { start: { num: "0", den: "1" }, duration: { num: "0", den: "1" } }, recordRange: { start: { num: "0", den: "1" }, duration: { num: "0", den: "1" } } }] };
    expect(() => store.validateProposal(zeroDur as typeof base, owner)).toThrow("non-empty, non-negative");
    const zeroDen = { ...base, trimOperations: [{ ...op, recordRange: { start: { num: "0", den: "0" }, duration: { num: "1", den: "1" } } }] };
    expect(() => store.validateProposal(zeroDen as typeof base, owner)).toThrow("non-empty, non-negative");
    store.close();
  });
});

describe("grant lifecycle edges", () => {
  async function setup() {
    const { store, cas, project } = await fixture();
    const blob = await cas.writeBytes(Buffer.from("not-a-video"), "video/mp4");
    const asset = {
      assetId: blob.sha256,
      original: blob,
      displayName: "source.mp4",
      streams: [{ streamUid: "stream:0", streamIndex: 0, kind: "video" as const, codec: "h264", timeBase: { num: "1", den: "30" }, disposition: {} }],
      presentationIndex: blob,
      probe: blob,
      sourceNeverWritable: true as const,
    };
    await store.addAsset(project.projectId, asset, "asset", owner);
    const current = store.project(project.projectId, owner);
    const { approval } = store.createPlan(draft(current));
    const { grant } = store.decideApproval(
      { requestId: "approve", approvalId: approval.approvalId, expectedRevision: current.revision, decision: "approve" },
      owner,
    );
    return { store, cas, current, approval, grant: grant!, asset };
  }

  it("rejects reusing a consumed grant for a new job request", async () => {
    const { store, current, approval, grant } = await setup();
    const jobInput = {
      projectId: current.projectId,
      approvalId: approval.approvalId,
      grantId: grant.grantId,
      expectedRevision: current.revision,
      principal: owner,
    };
    expect(store.createJob({ ...jobInput, requestId: "job-1" }).deduplicated).toBe(false);
    // A different requestId bypasses the idempotency cache and hits the consumed check.
    expect(() => store.createJob({ ...jobInput, requestId: "job-2" })).toThrow("already been consumed");
    store.close();
  });

  it("rejects a job when the project changed after approval", async () => {
    const { store, cas, current, approval, grant } = await setup();
    const blob2 = await cas.writeBytes(Buffer.from("another-video"), "video/mp4");
    await store.addAsset(
      current.projectId,
      { assetId: blob2.sha256, original: blob2, displayName: "second.mp4", streams: [{ streamUid: "stream:0", streamIndex: 0, kind: "video" as const, codec: "h264", timeBase: { num: "1", den: "30" }, disposition: {} }], presentationIndex: blob2, probe: blob2, sourceNeverWritable: true as const },
      "asset-2",
      owner,
    );
    expect(() =>
      store.createJob({
        requestId: "job-stale",
        projectId: current.projectId,
        approvalId: approval.approvalId,
        grantId: grant.grantId,
        expectedRevision: current.revision,
        principal: owner,
      }),
    ).toThrow("project changed after approval");
    store.close();
  });
});

it("retrieves all project plans and resumes stable pages after reopening", async () => {
  const { root, store, project, cas } = await fixture();
  const { projectId } = project;
  const blob = await cas.writeBytes(Buffer.from("history"), "video/mp4");
  const ids: string[] = [];
  let otherProjectId: string;
  try {
    store.addAsset(projectId, {
      assetId: "clip", displayName: "history", original: blob, presentationIndex: blob, probe: blob,
      streams: [{ streamUid: "stream:0", streamIndex: 0, kind: "video", codec: "h264",
        timeBase: { num: "1", den: "25" }, disposition: {} }], sourceNeverWritable: true,
    }, "history-asset", owner);
    const current = store.project(projectId, owner);
    for (let i = 0; i < 130; i++) {
      const request = draft(current, `history-${i}`);
      ids.push(store.createPlan({ ...request, toolCallId: request.requestId }).plan.planId);
    }
    otherProjectId = store.createProject({ requestId: "other", title: "Other", principal: owner }).projectId;
    expect(store.plan(projectId, ids[0]!, owner).planId).toBe(ids[0]);
    const first = store.listPlans(projectId, owner);
    expect(first.plans.map(plan => plan.planId)).toEqual(ids.slice(0, 128));
    expect(first.hasMore).toBe(true);
  } finally {
    store.close();
  }
  const reopened = await EditorStore.create(root);
  try {
    const second = reopened.listPlans(projectId, owner, ids[127]);
    expect(second.plans.map(plan => plan.planId)).toEqual(ids.slice(128));
    expect(second.hasMore).toBe(false);
    expect(reopened.listPlans(projectId, owner, ids[129]).plans).toEqual([]);
    expect(reopened.plan(projectId, ids[0]!, owner).planId).toBe(ids[0]);
    expect(() => reopened.plan(otherProjectId, ids[0]!, owner)).toThrow(/No such plan/);
  } finally {
    reopened.close();
  }
});
