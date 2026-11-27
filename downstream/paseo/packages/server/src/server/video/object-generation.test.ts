import { describe, expect, it } from "vitest";
import { EditorError } from "./errors.js";
import { planRemovalGeneration } from "./object-generation.js";
import type { ObjectEditWorkflow } from "#video-editor/contracts/v1";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof EditorError) return error.code;
    throw error;
  }
  throw new Error("expected the call to fail");
}

const media = {
  frames: 9,
  width: 640,
  height: 360,
  rotation: 0,
  sampleAspectRatio: "1:1",
  transfer: "bt709",
};

function workflow(overrides: Partial<ObjectEditWorkflow> = {}): ObjectEditWorkflow {
  return {
    workflowId: "object-edit-a",
    projectId: "project-a",
    assetId: "clip-a",
    assetContentHash: "a".repeat(64),
    sourceRange: { start: { num: "0", den: "1" }, duration: { num: "1", den: "1" } },
    baseTimelineRevision: "1",
    candidateManifestHash: "b".repeat(64),
    candidates: [
      {
        objectId: "obj-a",
        trackId: "t1",
        role: "protagonist",
        confidence: 0.9,
        evidenceFrames: ["0"],
        box: { x: 0.4, y: 0.3, width: 0.2, height: 0.4 },
        risk: { areaRatio: 0.2, occlusion: 0, motion: 0.1, overlapProtected: false },
      },
      {
        objectId: "obj-b",
        trackId: "t2",
        role: "background",
        confidence: 0.8,
        evidenceFrames: ["0"],
        box: { x: 0.05, y: 0.6, width: 0.1, height: 0.2 },
        risk: { areaRatio: 0.02, occlusion: 0, motion: 0.1, overlapProtected: false },
      },
    ],
    decisions: [
      { objectId: "obj-a", decision: "remove" },
      { objectId: "obj-b", decision: "keep" },
    ],
    maskRevisionId: "mask-1",
    state: "awaiting_generation_review",
    workflowRevision: "3",
    createdAt: "2026-11-27T10:00:00.000Z",
    ...overrides,
  };
}

describe("removal generation planning", () => {
  it("plans one target under the nine-frame profile", () => {
    const plan = planRemovalGeneration(workflow(), media);
    expect(plan.profileId).toBe("removal-vace-9f-832x480-v1");
    expect(plan.objectId).toBe("obj-a");
    expect(plan.trackId).toBe("t1");
    expect(plan.frames).toBe(9);
  });

  it("refuses before mask approval, without a target, or with two targets", () => {
    expect(
      codeOf(() => planRemovalGeneration(workflow({ state: "awaiting_mask_review" }), media)),
    ).toBe("WORKFLOW_STATE");
    expect(
      codeOf(() =>
        planRemovalGeneration(
          workflow({
            state: "completed",
            decisions: [
              { objectId: "obj-a", decision: "keep" },
              { objectId: "obj-b", decision: "skip" },
            ],
          }),
          media,
        ),
      ),
    ).toBe("WORKFLOW_STATE");
    expect(
      codeOf(() =>
        planRemovalGeneration(
          workflow({
            decisions: [
              { objectId: "obj-a", decision: "remove" },
              { objectId: "obj-b", decision: "remove" },
            ],
          }),
          media,
        ),
      ),
    ).toBe("CAPABILITY_UNAVAILABLE");
  });

  it("enforces every profile gate independently", () => {
    expect(codeOf(() => planRemovalGeneration(workflow(), { ...media, frames: 10 }))).toBe(
      "CAPABILITY_UNAVAILABLE",
    );
    expect(codeOf(() => planRemovalGeneration(workflow(), { ...media, width: 641 }))).toBe(
      "CAPABILITY_UNAVAILABLE",
    );
    expect(
      codeOf(() => planRemovalGeneration(workflow(), { ...media, width: 840, height: 360 })),
    ).toBe("CAPABILITY_UNAVAILABLE");
    expect(codeOf(() => planRemovalGeneration(workflow(), { ...media, rotation: 90 }))).toBe(
      "CAPABILITY_UNAVAILABLE",
    );
    expect(
      codeOf(() => planRemovalGeneration(workflow(), { ...media, sampleAspectRatio: "4:3" })),
    ).toBe("CAPABILITY_UNAVAILABLE");
    expect(
      codeOf(() => planRemovalGeneration(workflow(), { ...media, transfer: "arib-std-b67" })),
    ).toBe("CAPABILITY_UNAVAILABLE");
  });
});
