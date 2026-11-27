import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContentAddressedStore } from "./cas.js";
import { EditorError } from "./errors.js";
import { EditorStore } from "./store.js";
import { candidateManifestHash } from "./object-edit.js";
import type {
  EditorPrincipal,
  ObjectCandidate,
  ObjectDecision,
  SourceAsset,
} from "#video-editor/contracts/v1";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const owner: EditorPrincipal = { principalId: "owner", role: "owner", projectIds: null };
const range = { start: { num: "0", den: "1" }, duration: { num: "2", den: "1" } };
const risk = { areaRatio: 0.3, occlusion: 0.2, motion: 0.1, overlapProtected: false };

function candidate(objectId: string, trackId = `track-${objectId}`): ObjectCandidate {
  return {
    objectId,
    trackId,
    role: "background",
    confidence: 0.9,
    evidenceFrames: ["1", "5"],
    box: { x: 0.2, y: 0.1, width: 0.4, height: 0.6 },
    risk,
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "object-edit-"));
  roots.push(root);
  const store = await EditorStore.create(root);
  const cas = new ContentAddressedStore(path.join(root, "cas"));
  await cas.initialize();
  const project = store.createProject({ requestId: "create", title: "Copilot", principal: owner });
  const blob = await cas.writeBytes(Uint8Array.of(9, 9, 9), "video/x-matroska");
  const asset: SourceAsset = {
    assetId: "clip-a",
    displayName: "clip-a",
    original: blob,
    presentationIndex: blob,
    probe: blob,
    streams: [
      {
        streamUid: "v",
        streamIndex: 0,
        kind: "video",
        codec: "ffv1",
        timeBase: { num: "1", den: "9" },
        disposition: {},
        width: 2,
        height: 1,
      },
    ],
    sourceNeverWritable: true,
  };
  store.addAsset(project.projectId, asset, "add-a", owner);
  return { root, store, cas, projectId: project.projectId, asset, blob };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof EditorError) return error.code;
    throw error;
  }
  throw new Error("expected the call to fail");
}

async function opened(context: Awaited<ReturnType<typeof fixture>>) {
  const revision = context.store.project(context.projectId, owner).revision;
  return context.store.openObjectEdit({
    requestId: "open",
    projectId: context.projectId,
    assetId: context.asset.assetId,
    expectedRevision: revision,
    sourceRange: range,
    actor: owner,
  });
}

describe("EditorStore object edit workflow", () => {
  it("pins the asset bytes, range and revision when opened", async () => {
    const context = await fixture();
    const workflow = await opened(context);
    expect(workflow.state).toBe("analyzing");
    expect(workflow.workflowRevision).toBe("0");
    expect(workflow.assetContentHash).toBe(context.blob.sha256);
    expect(workflow.sourceRange).toEqual(range);
    expect(workflow.baseTimelineRevision).toBe("1");
    expect(workflow.candidates).toEqual([]);
    expect(workflow.candidateManifestHash).toBe(candidateManifestHash([]));
  });

  it("refuses an open against a stale revision or a missing asset", async () => {
    const context = await fixture();
    expect(
      codeOf(() =>
        context.store.openObjectEdit({
          requestId: "stale",
          projectId: context.projectId,
          assetId: context.asset.assetId,
          expectedRevision: "0",
          sourceRange: range,
          actor: owner,
        }),
      ),
    ).toBe("REVISION_CONFLICT");
    expect(
      codeOf(() =>
        context.store.openObjectEdit({
          requestId: "missing",
          projectId: context.projectId,
          assetId: "nope",
          expectedRevision: "1",
          sourceRange: range,
          actor: owner,
        }),
      ),
    ).toBe("ASSET_NOT_FOUND");
  });

  it("records detector candidates once and hashes them canonically", async () => {
    const context = await fixture();
    const workflow = await opened(context);
    const candidates = [candidate("a"), candidate("b"), candidate("c")];
    const recorded = context.store.recordObjectCandidates({
      requestId: "record",
      projectId: context.projectId,
      workflowId: workflow.workflowId,
      expectedWorkflowRevision: "0",
      candidates,
      actor: owner,
    });
    expect(recorded.state).toBe("awaiting_target_selection");
    expect(recorded.workflowRevision).toBe("1");
    expect(recorded.candidateManifestHash).toBe(candidateManifestHash(candidates));
    expect(context.store.getObjectEdit(context.projectId, workflow.workflowId, owner).candidates)
      .toHaveLength(3);
    expect(
      codeOf(() =>
        context.store.recordObjectCandidates({
          requestId: "record-again",
          projectId: context.projectId,
          workflowId: workflow.workflowId,
          expectedWorkflowRevision: "1",
          candidates,
          actor: owner,
        }),
      ),
    ).toBe("WORKFLOW_STATE");
  });

  it("refuses candidates for a moved workflow or a non-owner device", async () => {
    const context = await fixture();
    const workflow = await opened(context);
    expect(
      codeOf(() =>
        context.store.recordObjectCandidates({
          requestId: "record-stale",
          projectId: context.projectId,
          workflowId: workflow.workflowId,
          expectedWorkflowRevision: "9",
          candidates: [candidate("a")],
          actor: owner,
        }),
      ),
    ).toBe("REVISION_CONFLICT");
    context.store.registerDevice({
      projectId: context.projectId,
      principalId: "operator-1",
      role: "operator",
      actor: owner,
    });
    const operator: EditorPrincipal = {
      principalId: "operator-1",
      role: "operator",
      projectIds: [context.projectId],
    };
    expect(
      codeOf(() =>
        context.store.recordObjectCandidates({
          requestId: "record-operator",
          projectId: context.projectId,
          workflowId: workflow.workflowId,
          expectedWorkflowRevision: "0",
          candidates: [candidate("a")],
          actor: operator,
        }),
      ),
    ).toBe("PERMISSION_DENIED");
  });

  it("moves to mask review when a target is marked for removal", async () => {
    const context = await fixture();
    const workflow = await opened(context);
    const recorded = context.store.recordObjectCandidates({
      requestId: "record",
      projectId: context.projectId,
      workflowId: workflow.workflowId,
      expectedWorkflowRevision: "0",
      candidates: [candidate("a"), candidate("b")],
      actor: owner,
    });
    const decided = context.store.decideObjectTarget({
      requestId: "decide",
      projectId: context.projectId,
      workflowId: workflow.workflowId,
      expectedWorkflowRevision: recorded.workflowRevision,
      decisions: [
        { objectId: "a", decision: "remove" },
        { objectId: "b", decision: "keep" },
      ],
      actor: owner,
    });
    expect(decided.state).toBe("awaiting_mask_review");
    expect(decided.workflowRevision).toBe("2");
    expect(decided.decisions).toHaveLength(2);
  });

  it("completes without a target when everything is kept", async () => {
    const context = await fixture();
    const workflow = await opened(context);
    const recorded = context.store.recordObjectCandidates({
      requestId: "record",
      projectId: context.projectId,
      workflowId: workflow.workflowId,
      expectedWorkflowRevision: "0",
      candidates: [candidate("a"), candidate("b")],
      actor: owner,
    });
    const decisions: ObjectDecision[] = [
      { objectId: "a", decision: "keep" },
      { objectId: "b", decision: "skip" },
    ];
    const decided = context.store.decideObjectTarget({
      requestId: "decide",
      projectId: context.projectId,
      workflowId: workflow.workflowId,
      expectedWorkflowRevision: recorded.workflowRevision,
      decisions,
      actor: owner,
    });
    expect(decided.state).toBe("completed");
    expect(decided.decisions).toEqual(decisions);
  });

  it("refuses decisions before candidates exist, for unknown objects, and after a re-decide", async () => {
    const context = await fixture();
    const workflow = await opened(context);
    expect(
      codeOf(() =>
        context.store.decideObjectTarget({
          requestId: "too-early",
          projectId: context.projectId,
          workflowId: workflow.workflowId,
          expectedWorkflowRevision: "0",
          decisions: [{ objectId: "a", decision: "remove" }],
          actor: owner,
        }),
      ),
    ).toBe("WORKFLOW_STATE");
    const recorded = context.store.recordObjectCandidates({
      requestId: "record",
      projectId: context.projectId,
      workflowId: workflow.workflowId,
      expectedWorkflowRevision: "0",
      candidates: [candidate("a")],
      actor: owner,
    });
    expect(
      codeOf(() =>
        context.store.decideObjectTarget({
          requestId: "unknown",
          projectId: context.projectId,
          workflowId: workflow.workflowId,
          expectedWorkflowRevision: recorded.workflowRevision,
          decisions: [{ objectId: "ghost", decision: "remove" }],
          actor: owner,
        }),
      ),
    ).toBe("INVALID_ARGUMENT");
    context.store.decideObjectTarget({
      requestId: "decide-1",
      projectId: context.projectId,
      workflowId: workflow.workflowId,
      expectedWorkflowRevision: recorded.workflowRevision,
      decisions: [{ objectId: "a", decision: "remove" }],
      actor: owner,
    });
    expect(
      codeOf(() =>
        context.store.decideObjectTarget({
          requestId: "decide-2",
          projectId: context.projectId,
          workflowId: workflow.workflowId,
          expectedWorkflowRevision: "2",
          decisions: [{ objectId: "a", decision: "keep" }],
          actor: owner,
        }),
      ),
    ).toBe("WORKFLOW_STATE");
  });

  it("invalidates the recorded choice when the asset set changes under it", async () => {
    const context = await fixture();
    const workflow = await opened(context);
    const recorded = context.store.recordObjectCandidates({
      requestId: "record",
      projectId: context.projectId,
      workflowId: workflow.workflowId,
      expectedWorkflowRevision: "0",
      candidates: [candidate("a")],
      actor: owner,
    });
    const second = await context.cas.writeBytes(Uint8Array.of(7, 7), "video/x-matroska");
    context.store.addAsset(
      context.projectId,
      { ...context.asset, assetId: "clip-b", original: second, presentationIndex: second, probe: second },
      "add-b",
      owner,
    );
    expect(
      codeOf(() =>
        context.store.decideObjectTarget({
          requestId: "decide-stale",
          projectId: context.projectId,
          workflowId: workflow.workflowId,
          expectedWorkflowRevision: recorded.workflowRevision,
          decisions: [{ objectId: "a", decision: "remove" }],
          actor: owner,
        }),
      ),
    ).toBe("REVISION_CONFLICT");
    const after = context.store.getObjectEdit(context.projectId, workflow.workflowId, owner);
    expect(after.state).toBe("awaiting_target_selection");
    expect(after.decisions).toEqual([]);
    expect(after.workflowRevision).toBe(recorded.workflowRevision);
  });

  it("replays an identical decision idempotently and rejects a conflicting reuse", async () => {
    const context = await fixture();
    const workflow = await opened(context);
    const recorded = context.store.recordObjectCandidates({
      requestId: "record",
      projectId: context.projectId,
      workflowId: workflow.workflowId,
      expectedWorkflowRevision: "0",
      candidates: [candidate("a"), candidate("b")],
      actor: owner,
    });
    const input = {
      requestId: "decide",
      projectId: context.projectId,
      workflowId: workflow.workflowId,
      expectedWorkflowRevision: recorded.workflowRevision,
      decisions: [{ objectId: "a", decision: "remove" }],
      actor: owner,
    } as const;
    const first = context.store.decideObjectTarget(input);
    const replay = context.store.decideObjectTarget(input);
    expect(replay).toEqual(first);
    expect(
      context.store.getObjectEdit(context.projectId, workflow.workflowId, owner).workflowRevision,
    ).toBe("2");
    expect(
      codeOf(() =>
        context.store.decideObjectTarget({ ...input, decisions: [{ objectId: "b", decision: "remove" }] }),
      ),
    ).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("keeps viewers read-only and lets them reload the same step", async () => {
    const context = await fixture();
    const workflow = await opened(context);
    context.store.registerDevice({
      projectId: context.projectId,
      principalId: "viewer-1",
      role: "viewer",
      actor: owner,
    });
    const viewer: EditorPrincipal = {
      principalId: "viewer-1",
      role: "viewer",
      projectIds: [context.projectId],
    };
    expect(context.store.getObjectEdit(context.projectId, workflow.workflowId, viewer).state).toBe(
      "analyzing",
    );
    expect(
      codeOf(() =>
        context.store.openObjectEdit({
          requestId: "viewer-open",
          projectId: context.projectId,
          assetId: context.asset.assetId,
          expectedRevision: "1",
          sourceRange: range,
          actor: viewer,
        }),
      ),
    ).toBe("PERMISSION_DENIED");
  });

  it("survives a daemon restart and blocks generation until a mask review exists", async () => {
    const context = await fixture();
    const workflow = await opened(context);
    const recorded = context.store.recordObjectCandidates({
      requestId: "record",
      projectId: context.projectId,
      workflowId: workflow.workflowId,
      expectedWorkflowRevision: "0",
      candidates: [candidate("a")],
      actor: owner,
    });
    const decided = context.store.decideObjectTarget({
      requestId: "decide",
      projectId: context.projectId,
      workflowId: workflow.workflowId,
      expectedWorkflowRevision: recorded.workflowRevision,
      decisions: [{ objectId: "a", decision: "remove" }],
      actor: owner,
    });
    context.store.close();
    const reopened = await EditorStore.create(context.root);
    const restored = reopened.getObjectEdit(context.projectId, workflow.workflowId, owner);
    expect(restored.state).toBe("awaiting_mask_review");
    expect(restored.decisions).toEqual(decided.decisions);
    expect(
      codeOf(() => reopened.objectEditGenerationGuard(context.projectId, workflow.workflowId)),
    ).toBe("WORKFLOW_STATE");
    reopened.close();
  });
});
