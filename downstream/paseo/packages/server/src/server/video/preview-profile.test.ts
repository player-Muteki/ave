import { describe, expect, it } from "vitest";
import { assertRenderablePreview } from "./preview-profile.js";
import type { EditPlanDraftV1 } from "#video-editor/contracts/v1";

function draft(overrides: Partial<EditPlanDraftV1> = {}): EditPlanDraftV1 {
  return {
    schemaVersion: "video.edit-plan/v1",
    projectId: "p1",
    baseTimelineRevision: "1",
    baseAssetManifestHash: "a".repeat(64),
    preferredDeterministicBackendId: "ffmpeg",
    intent: "Trim one second",
    trimOperations: [
      {
        opId: "trim-1",
        order: "1",
        trackId: "v1",
        clipId: "clip-1",
        source: {
          assetId: "asset-1",
          assetContentHash: "b".repeat(64),
          streamUid: "stream:0",
          probeRevision: "1",
        },
        sourceRange: { start: { num: "1000", den: "1000" }, duration: { num: "1", den: "1" } },
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
    ...overrides,
  } as EditPlanDraftV1;
}

describe("assertRenderablePreview", () => {
  it("accepts a single FFmpeg trim with equal source/record durations", () => {
    expect(() => assertRenderablePreview(draft())).not.toThrow();
    // Equal durations written with different rational representations still pass.
    const d = draft();
    d.trimOperations[0]!.sourceRange.duration = { num: "1", den: "2" };
    d.trimOperations[0]!.recordRange.duration = { num: "2", den: "4" };
    expect(() => assertRenderablePreview(d)).not.toThrow();
  });

  it("rejects the filmcraft backend and non-single trim counts", () => {
    expect(() => assertRenderablePreview(draft({ preferredDeterministicBackendId: "filmcraft" }))).toThrow(
      "one FFmpeg trim only",
    );
    expect(() => assertRenderablePreview(draft({ trimOperations: [] }))).toThrow("one FFmpeg trim only");
    const two = draft();
    two.trimOperations.push({ ...two.trimOperations[0]!, opId: "trim-2", order: "2" });
    expect(() => assertRenderablePreview(two)).toThrow("one FFmpeg trim only");
  });

  it("rejects every unsupported operation family", () => {
    const families = [
      "transformOperations",
      "audioOperations",
      "transitionOperations",
      "subtitleOperations",
      "generationRequests",
      "qaRequirements",
      "externalDestinations",
    ] as const;
    for (const family of families) {
      expect(() => assertRenderablePreview(draft({ [family]: [{}] } as never))).toThrow(
        "one FFmpeg trim only",
      );
    }
  });

  it("rejects a non-zero record start and retiming", () => {
    const gap = draft();
    gap.trimOperations[0]!.recordRange.start = { num: "5", den: "1" };
    expect(() => assertRenderablePreview(gap)).toThrow("gaps and retiming");
    const retime = draft();
    retime.trimOperations[0]!.recordRange.duration = { num: "2", den: "1" };
    expect(() => assertRenderablePreview(retime)).toThrow("gaps and retiming");
  });
});