import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EditPlanDraftV1, ObjectCandidate, ObjectEditWorkflow } from "@ave/contracts";
import {
  MANAGE_METHODS,
  MODEL_REGISTRY,
  READ_METHODS,
  assertObjectEditTransition,
  assertRenderablePreview,
  authorizeVideoMethod,
  candidateManifestHash,
  checkSeamContinuity,
  clampAnalysisRate,
  eligibleModels,
  evaluateObjectQa,
  nextFallback,
  planRemovalGeneration,
  planTrackWindows,
  playbackDurationSeconds,
  probeStartTime,
  rationalAdd,
  rationalCompare,
  rationalEquals,
  rationalSub,
  riskBand,
  riskScore,
  routeModel,
  seedAnchorPoints,
  summarizeDraftTimeline,
  toObjectCandidates,
} from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R0_SPEC = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../../conformance/r0-baseline/baseline-spec.json"), "utf8"),
) as {
  rpcSurface: {
    mainSwitchMethods: string[];
    authorizationMatrix: {
      readMethods: string[];
      manageMethods: string[];
    };
  };
};

describe("@ave/domain", () => {
  it("performs exact rational arithmetic and analysis rate clamping", () => {
    const a = { num: "1", den: "3" };
    const b = { num: "2", den: "6" };
    expect(rationalEquals(a, b)).toBe(true);
    expect(rationalCompare(rationalAdd(a, b), { num: "2", den: "3" })).toBe(0);
    expect(rationalCompare(rationalSub({ num: "5", den: "4" }, { num: "1", den: "2" }), { num: "3", den: "4" })).toBe(0);

    expect(clampAnalysisRate()).toBe("25/1");
    expect(clampAnalysisRate("1/2")).toBe("1/1");
    expect(clampAnalysisRate("5000/1")).toBe("1000/1");
    expect(clampAnalysisRate("50/2")).toBe("25/1");

    const origin = probeStartTime("-0.080000");
    expect(origin).toEqual({ num: "-80000", den: "1000000" });
    expect(
      playbackDurationSeconds("1.0", origin, [
        { kind: "video", timeBase: { num: "1", den: "90000" }, startPts: "-7200", durationTicks: "90000" },
      ]),
    ).toBe("1.000000");
  });

  it("validates EditPlan preview profile and summarizes timeline", () => {
    const hash = "a".repeat(64);
    const draft: EditPlanDraftV1 = {
      schemaVersion: "video.edit-plan/v1",
      projectId: "proj-1",
      baseTimelineRevision: "1",
      baseAssetManifestHash: hash,
      preferredDeterministicBackendId: "ffmpeg",
      intent: "Trim first second",
      trimOperations: [
        {
          opId: "op-1",
          order: "1",
          trackId: "v1",
          clipId: "clip-1",
          source: { assetId: "asset-1", assetContentHash: hash, streamUid: "stream:0", probeRevision: "1" },
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

    expect(() => assertRenderablePreview(draft)).not.toThrow();
    const summary = summarizeDraftTimeline(draft);
    expect(summary.mainTrackSegments).toBe(1);
    expect(summary.effectiveMainDurationSeconds).toBe("2.000");

    expect(() =>
      assertRenderablePreview({ ...draft, preferredDeterministicBackendId: "filmcraft" }),
    ).toThrow(/ffmpeg/i);
  });

  it("enforces R0 authorization matrix for viewer, operator, owner and unauthenticated", () => {
    expect([...READ_METHODS].sort()).toEqual([...R0_SPEC.rpcSurface.authorizationMatrix.readMethods].sort());
    expect([...MANAGE_METHODS].sort()).toEqual([...R0_SPEC.rpcSurface.authorizationMatrix.manageMethods].sort());

    expect(() => authorizeVideoMethod("video.v1.get_project", { principalId: "anon" })).toThrow();
    expect(() =>
      authorizeVideoMethod("video.v1.get_project", {
        principalId: "v1",
        editorPrincipal: { principalId: "v1", role: "viewer", projectIds: ["p1"] },
      }),
    ).not.toThrow();
    expect(() =>
      authorizeVideoMethod("video.v1.submit_plan", {
        principalId: "v1",
        editorPrincipal: { principalId: "v1", role: "viewer", projectIds: ["p1"] },
      }),
    ).toThrow();
    expect(() =>
      authorizeVideoMethod("video.v1.revoke_device", {
        principalId: "op1",
        editorPrincipal: { principalId: "op1", role: "operator", projectIds: ["p1"] },
      }),
    ).toThrow();
    expect(
      authorizeVideoMethod("video.v1.record_object_qa", {
        principalId: "owner",
        isLocalOwner: true,
      }).role,
    ).toBe("owner");
  });

  it("covers ObjectEdit FSM transitions, candidate ranking, anchor seeding, generation gate, windows & QA", () => {
    assertObjectEditTransition("analyzing", "awaiting_target_selection");
    assertObjectEditTransition("awaiting_target_selection", "completed");
    assertObjectEditTransition("awaiting_mask_review", "awaiting_mask_review");
    assertObjectEditTransition("awaiting_mask_review", "awaiting_generation_review");
    expect(() => assertObjectEditTransition("analyzing", "completed")).toThrow();

    const hash = "b".repeat(64);
    const candidates = toObjectCandidates(
      {
        backend: "opencv-hog",
        frameWidth: 640,
        frameHeight: 360,
        frames: 30,
        tracks: [
          {
            trackId: "t1",
            firstFrame: "0",
            lastFrame: "29",
            evidenceFrames: ["0", "15"],
            box: { x: 0.2, y: 0.2, width: 0.4, height: 0.5 },
            confidence: 0.9,
            areaRatio: 0.2,
            centrality: 0.8,
            motion: 0.1,
            occlusion: 0.05,
            visibility: 0.9,
          },
        ],
      },
      hash,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.role).toBe("protagonist");
    expect(candidateManifestHash(candidates)).toBe(candidateManifestHash([...candidates].reverse()));
    expect(riskBand(riskScore({ areaRatio: 0.1, occlusion: 0.1, motion: 0.1, overlapProtected: true }))).toBe("high");

    const pts = seedAnchorPoints(candidates[0]!, 640, 360);
    expect(pts.length).toBe(9);

    const workflow: ObjectEditWorkflow = {
      workflowId: "wf-1",
      projectId: "p1",
      assetId: "a1",
      assetContentHash: hash,
      sourceRange: { start: { num: "0", den: "1" }, duration: { num: "1", den: "1" } },
      baseTimelineRevision: "1",
      candidateManifestHash: candidateManifestHash(candidates),
      candidates: candidates as ObjectCandidate[],
      decisions: [{ objectId: candidates[0]!.objectId, decision: "remove" }],
      maskRevisionId: "mask-1",
      state: "awaiting_generation_review",
      workflowRevision: "3",
      createdAt: "2026-11-27T00:00:00Z",
    };
    const genPlan = planRemovalGeneration(workflow, {
      frames: 9,
      width: 640,
      height: 360,
      rotation: 0,
      sampleAspectRatio: "1:1",
      transfer: "bt709",
    });
    expect(genPlan.objectId).toBe(candidates[0]!.objectId);

    expect(
      evaluateObjectQa({ frames: "9", residualRatio: 0.01, completeRatio: 0.99, flickerRatio: 0.01 }).passed,
    ).toBe(true);
    expect(
      evaluateObjectQa({ frames: "9", residualRatio: 0.05, completeRatio: 0.99, flickerRatio: 0.01 }).passed,
    ).toBe(false);

    const windows = planTrackWindows(0, 160, { maxFrames: 81, overlap: 2 });
    expect(windows).toEqual([
      { firstFrame: 0, frameCount: 81, overlapBefore: 0 },
      { firstFrame: 79, frameCount: 81, overlapBefore: 2 },
    ]);
    expect(checkSeamContinuity(new Uint8Array([1, 1, 0]), new Uint8Array([1, 1, 0])).passed).toBe(true);

    expect(eligibleModels("detect").length).toBeGreaterThan(0);
    const route = routeModel("detect");
    expect(nextFallback(route, [route.primary.id]).stage).toBe("detect");
    expect(MODEL_REGISTRY.every((m) => m.license === "Apache-2.0")).toBe(true);
  });
});
