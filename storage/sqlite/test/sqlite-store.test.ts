import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContentAddressedStore, sha256Bytes } from "@ave/cas";
import type { EditPlanDraftV1, EditorPrincipal, ObjectCandidate, SourceAsset } from "@ave/contracts";
import { AveStore, resolveAveHome } from "../src/index.js";

const OWNER: EditorPrincipal = { principalId: "owner", role: "owner", projectIds: null };
const tempDirs: string[] = [];

async function createTempEnv() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ave-sqlite-test-"));
  tempDirs.push(root);
  const store = await AveStore.create(root);
  const cas = new ContentAddressedStore(path.join(root, "cas"));
  await cas.initialize();
  store.bindCas(cas);
  return { root, store, cas };
}

function makeAsset(assetId: string, bytes: Buffer): SourceAsset {
  const hash = sha256Bytes(bytes);
  const metaHash = sha256Bytes(Buffer.from(assetId));
  return {
    assetId,
    original: { sha256: hash, bytes: String(bytes.length), mediaType: "video/mp4" },
    displayName: `${assetId}.mp4`,
    streams: [
      {
        streamUid: "stream:0",
        streamIndex: 0,
        kind: "video",
        codec: "h264",
        timeBase: { num: "1", den: "25" },
        averageRate: { num: "25", den: "1" },
        width: 320,
        height: 180,
        disposition: {},
      },
    ],
    presentationIndex: { sha256: metaHash, bytes: "64", mediaType: "application/json" },
    probe: { sha256: metaHash, bytes: "64", mediaType: "application/json" },
    sourceNeverWritable: true,
  };
}

function makeDraft(projectId: string, revision: string, assetManifestHash: string, asset: SourceAsset): EditPlanDraftV1 {
  return {
    schemaVersion: "video.edit-plan/v1",
    projectId,
    baseTimelineRevision: revision,
    baseAssetManifestHash: assetManifestHash,
    preferredDeterministicBackendId: "ffmpeg",
    intent: "Trim 2 seconds",
    trimOperations: [
      {
        opId: "op-1",
        order: "1",
        trackId: "v1",
        clipId: "clip-1",
        source: {
          assetId: asset.assetId,
          assetContentHash: asset.original.sha256,
          streamUid: "stream:0",
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
}

afterEach(async () => {
  while (tempDirs.length) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("@ave/sqlite 5-repository coordinator", () => {
  it("enforces AVE_HOME isolation from legacy Paseo directories", () => {
    expect(() => resolveAveHome("/home/user/.paseo/video-editor")).toThrow(/isolated/i);
    expect(() => resolveAveHome("/tmp/ave-home-ok")).not.toThrow();
  });

  it("handles idempotency, conflict, get_mutation_result, approval grants, jobs, events & outbox", async () => {
    const { store, cas } = await createTempEnv();
    try {
      const p1 = store.projects.createProject({ requestId: "req-proj-1", title: "Demo", principal: OWNER });
      const p1Replay = store.projects.createProject({ requestId: "req-proj-1", title: "Demo", principal: OWNER });
      expect(p1Replay.projectId).toBe(p1.projectId);
      expect(() =>
        store.projects.createProject({ requestId: "req-proj-1", title: "Other", principal: OWNER }),
      ).toThrow(/different content/i);

      // Chunked upload -> CAS commit -> finishUpload -> asset added & revision incremented
      const mediaBytes = Buffer.from("synthetic-mp4-bytes");
      const mediaHash = sha256Bytes(mediaBytes);
      const up = store.projects.createUpload({
        projectId: p1.projectId,
        displayName: "clip.mp4",
        expectedSize: String(mediaBytes.length),
        expectedSha256: mediaHash,
        mediaType: "video/mp4",
        principal: OWNER,
        requestId: "req-up-1",
      });
      await cas.writeUploadChunk(up.uploadId, 0n, mediaBytes);
      store.projects.confirmChunk({
        uploadId: up.uploadId,
        offset: "0",
        nextOffset: String(mediaBytes.length),
        digest: mediaHash,
      });
      await cas.commitUpload(up.uploadId, mediaHash, String(mediaBytes.length), "video/mp4");
      const asset = makeAsset("asset-1", mediaBytes);
      store.projects.finishUpload(up.uploadId, asset, "req-commit-1", OWNER);

      const snap = store.projects.getProjectSnapshot(p1.projectId, OWNER);
      expect(snap.revision).toBe("1");
      expect(snap.assets).toHaveLength(1);

      // Reconcile mutation result
      const mut = store.plans.getMutationResult(p1.projectId, "req-commit-1", OWNER);
      expect(mut).not.toBeNull();
      expect((mut!.response as SourceAsset).assetId).toBe("asset-1");

      // Create plan -> approve -> create job -> verify single-use grant consumption
      const draft = makeDraft(p1.projectId, snap.revision, snap.baseAssetManifestHash, asset);
      const { plan, approval } = store.plans.createPlan({
        requestId: "req-plan-1",
        runId: "run-1",
        toolCallId: "tc-1",
        draft,
        principal: OWNER,
      });
      expect(plan.planHash).toHaveLength(64);
      expect(approval.status).toBe("pending");

      // Stale expectedRevision fails with REVISION_CONFLICT
      expect(() =>
        store.plans.decideApproval(
          { requestId: "req-dec-bad", approvalId: approval.approvalId, expectedRevision: "0", decision: "approve" },
          OWNER,
        ),
      ).toThrow(/older timeline revision/i);

      const decided = store.plans.decideApproval(
        { requestId: "req-dec-1", approvalId: approval.approvalId, expectedRevision: "1", decision: "approve" },
        OWNER,
      );
      expect(decided.grant).toBeDefined();

      const jobRes = store.jobs.createJob({
        requestId: "req-job-1",
        projectId: p1.projectId,
        approvalId: approval.approvalId,
        grantId: decided.grant!.grantId,
        expectedRevision: "1",
        principal: OWNER,
      });
      expect(jobRes.deduplicated).toBe(false);
      expect(jobRes.job.state).toBe("rendering_preview");

      // Second createJob with same consumed grant (different requestId) is rejected
      expect(() =>
        store.jobs.createJob({
          requestId: "req-job-2",
          projectId: p1.projectId,
          approvalId: approval.approvalId,
          grantId: decided.grant!.grantId,
          expectedRevision: "1",
          principal: OWNER,
        }),
      ).toThrow(/already been consumed/i);

      // Events + Outbox sync & ack
      const ev = store.jobs.getEvents(p1.projectId, "0", OWNER);
      expect(ev.events.length).toBeGreaterThanOrEqual(4);
      const outbox = store.jobs.getOutboxPending(p1.projectId);
      expect(outbox.length).toBe(ev.events.length);
      expect(store.jobs.ackOutbox(outbox.map((e) => e.eventId))).toBe(outbox.length);
      expect(store.jobs.getOutboxPending(p1.projectId)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("recovers active jobs and planning runs on store reopen and invalidates revoked approvals", async () => {
    const { root, store } = await createTempEnv();
    const p = store.projects.createProject({ requestId: "p-rec", title: "Recover", principal: OWNER });
    const bytes = Buffer.from("video-a");
    const asset = makeAsset("a1", bytes);
    store.projects.addAsset(p.projectId, asset, "add-a1", OWNER);
    const snap = store.projects.getProjectSnapshot(p.projectId, OWNER);

    const { approval } = store.plans.createPlan({
      requestId: "pl-rec",
      runId: "run-rec",
      toolCallId: "tc-rec",
      draft: makeDraft(p.projectId, snap.revision, snap.baseAssetManifestHash, asset),
      principal: OWNER,
    });
    const { grant } = store.plans.decideApproval(
      { requestId: "dec-rec", approvalId: approval.approvalId, expectedRevision: "1", decision: "approve" },
      OWNER,
    );
    const { job } = store.jobs.createJob({
      requestId: "job-rec",
      projectId: p.projectId,
      approvalId: approval.approvalId,
      grantId: grant!.grantId,
      expectedRevision: "1",
      principal: OWNER,
    });
    const { receipt } = store.jobs.reservePlanningRun(p.projectId, "run-req", "trim clip", OWNER);

    // Also create & revoke a second approval to verify revoke blocks createJob
    const { approval: app2 } = store.plans.createPlan({
      requestId: "pl-rec-2",
      runId: "run-rec",
      toolCallId: "tc-rec-2",
      draft: makeDraft(p.projectId, snap.revision, snap.baseAssetManifestHash, asset),
      principal: OWNER,
    });
    const dec2 = store.plans.decideApproval(
      { requestId: "dec-rec-2", approvalId: app2.approvalId, expectedRevision: "1", decision: "approve" },
      OWNER,
    );
    store.plans.revokeApproval({ requestId: "rev-2", projectId: p.projectId, approvalId: app2.approvalId }, OWNER);
    expect(() =>
      store.jobs.createJob({
        requestId: "job-rev",
        projectId: p.projectId,
        approvalId: app2.approvalId,
        grantId: dec2.grant!.grantId,
        expectedRevision: "1",
        principal: OWNER,
      }),
    ).toThrow(/revoked/i);

    store.close();

    // Simulate daemon restart by reopening AveStore on same root
    const reopened = await AveStore.create(root);
    try {
      const recoveredJob = reopened.jobs.getJob(p.projectId, job.jobId, OWNER);
      expect(recoveredJob.state).toBe("failed");
      expect(recoveredJob.error?.code).toBe("NEEDS_RECONCILIATION");

      const interrupted = reopened.jobs.reconcileInterruptedPlanningRuns(OWNER);
      expect(interrupted).toContain(receipt.runId);
      expect(reopened.jobs.planningRunStatus(p.projectId, receipt.runId, OWNER).state).toBe("interrupted");
    } finally {
      reopened.close();
    }
  });

  it("enforces ObjectEdit 6-state FSM, invalidation on asset change, and SQLite device grants", async () => {
    const { root, store } = await createTempEnv();
    const p = store.projects.createProject({ requestId: "oe-proj", title: "Obj", principal: OWNER });
    const a1 = makeAsset("a1", Buffer.from("clip-1"));
    store.projects.addAsset(p.projectId, a1, "oe-add-1", OWNER);
    const snap = store.projects.getProjectSnapshot(p.projectId, OWNER);

    // SQLite device invitation -> redeem -> authenticate -> persist across reopen -> revoke
    const inv = store.devices.createInvitation({ role: "operator", projectIds: [p.projectId] });
    const redeemed = store.devices.redeemInvitation(inv.invitationId, inv.token);
    expect(redeemed.principal.role).toBe("operator");
    const authed = store.devices.authenticate(redeemed.deviceId, redeemed.credential);
    expect(authed.principalId).toBe(redeemed.deviceId);
    // One-time invitation cannot be redeemed twice
    expect(() => store.devices.redeemInvitation(inv.invitationId, inv.token)).toThrow();

    const candidate: ObjectCandidate = {
      objectId: "obj-1",
      trackId: "track-1",
      role: "protagonist",
      confidence: 0.95,
      evidenceFrames: ["0", "5"],
      box: { x: 0.1, y: 0.1, width: 0.4, height: 0.5 },
      risk: { areaRatio: 0.2, occlusion: 0.05, motion: 0.1, overlapProtected: false },
    };

    // Happy path: analyzing -> awaiting_target_selection -> awaiting_mask_review -> awaiting_generation_review -> completed
    let wf = store.objectEdits.openObjectEdit({
      requestId: "oe-1",
      projectId: p.projectId,
      assetId: "a1",
      expectedRevision: snap.revision,
      sourceRange: { start: { num: "0", den: "1" }, duration: { num: "1", den: "1" } },
      actor: authed,
    });
    expect(wf.state).toBe("analyzing");

    wf = store.objectEdits.recordObjectCandidates({
      requestId: "oe-2",
      projectId: p.projectId,
      workflowId: wf.workflowId,
      expectedWorkflowRevision: wf.workflowRevision,
      candidates: [candidate],
      actor: OWNER,
    });
    expect(wf.state).toBe("awaiting_target_selection");

    wf = store.objectEdits.decideObjectTarget({
      requestId: "oe-3",
      projectId: p.projectId,
      workflowId: wf.workflowId,
      expectedWorkflowRevision: wf.workflowRevision,
      decisions: [{ objectId: "obj-1", decision: "remove" }],
      actor: authed,
    });
    expect(wf.state).toBe("awaiting_mask_review");

    // Generation guard blocks before mask review approval
    expect(() => store.objectEdits.objectEditGenerationGuard(p.projectId, wf.workflowId)).toThrow();

    // Rejection keeps workflow in awaiting_mask_review
    wf = store.objectEdits.reviewObjectMask({
      requestId: "oe-4a",
      projectId: p.projectId,
      workflowId: wf.workflowId,
      expectedWorkflowRevision: wf.workflowRevision,
      maskRevisionId: "mask-bad",
      approved: false,
      actor: authed,
    });
    expect(wf.state).toBe("awaiting_mask_review");

    wf = store.objectEdits.reviewObjectMask({
      requestId: "oe-4b",
      projectId: p.projectId,
      workflowId: wf.workflowId,
      expectedWorkflowRevision: wf.workflowRevision,
      maskRevisionId: "mask-good",
      approved: true,
      actor: authed,
    });
    expect(wf.state).toBe("awaiting_generation_review");
    expect(store.objectEdits.objectEditGenerationGuard(p.projectId, wf.workflowId).workflowId).toBe(wf.workflowId);

    wf = store.objectEdits.recordObjectQa({
      requestId: "oe-5",
      projectId: p.projectId,
      workflowId: wf.workflowId,
      expectedWorkflowRevision: wf.workflowRevision,
      qa: { frames: "9", residualRatio: 0.01, completeRatio: 0.99, flickerRatio: 0.01 },
      actor: OWNER,
    });
    expect(wf.state).toBe("completed");

    // Second workflow: timeline/asset revision advance invalidates pending target decision
    let wf2 = store.objectEdits.openObjectEdit({
      requestId: "oe-stale-1",
      projectId: p.projectId,
      assetId: "a1",
      expectedRevision: snap.revision,
      sourceRange: { start: { num: "0", den: "1" }, duration: { num: "1", den: "1" } },
      actor: authed,
    });
    wf2 = store.objectEdits.recordObjectCandidates({
      requestId: "oe-stale-2",
      projectId: p.projectId,
      workflowId: wf2.workflowId,
      expectedWorkflowRevision: wf2.workflowRevision,
      candidates: [candidate],
      actor: OWNER,
    });
    // Add another asset (advances project revision)
    store.projects.addAsset(p.projectId, makeAsset("a2", Buffer.from("clip-2")), "oe-add-2", OWNER);
    expect(() =>
      store.objectEdits.decideObjectTarget({
        requestId: "oe-stale-3",
        projectId: p.projectId,
        workflowId: wf2.workflowId,
        expectedWorkflowRevision: wf2.workflowRevision,
        decisions: [{ objectId: "obj-1", decision: "remove" }],
        actor: authed,
      }),
    ).toThrow(/stale/i);

    store.close();

    // Device stays valid after reopen until revoked
    const reopened = await AveStore.create(root);
    try {
      expect(reopened.devices.authenticate(redeemed.deviceId, redeemed.credential).role).toBe("operator");
      reopened.devices.revokeDevice(redeemed.deviceId);
      expect(() => reopened.devices.authenticate(redeemed.deviceId, redeemed.credential)).toThrow(/revoked/i);
    } finally {
      reopened.close();
    }
  });
});
