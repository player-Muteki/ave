import { describe, expect, it } from "vitest";
import { assertRenderablePreview, summarizeDraftTimeline } from "./preview-profile.js";
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

  it("rejects filmcraft and empty timelines but accepts contiguous trims", () => {
    expect(() => assertRenderablePreview(draft({ preferredDeterministicBackendId: "filmcraft" }))).toThrow("FFmpeg trims only");
    expect(() => assertRenderablePreview(draft({ trimOperations: [] }))).toThrow("At least one trim");
    const two = draft();
    const next = structuredClone(two.trimOperations[0]!);
    Object.assign(next, { opId: "trim-2", order: "2", clipId: "clip-2" });
    next.recordRange.start.num = "1";
    two.trimOperations.push(next);
    expect(() => assertRenderablePreview(two)).not.toThrow();
  });

  it("keeps unsupported families and unbound edit operations out of approvals", () => {
    for (const [family, error] of [
      ["transformOperations", "Transforms must target trim clips"], ["audioOperations", "Audio operations must target trim clips"],
      ["subtitleOperations", "Subtitle cues must target trim clips"], ["transitionOperations", "Only crossfade/fade"],
      ...["generationRequests", "qaRequirements", "externalDestinations"].map(name => [name, "FFmpeg trims only"] as const),
    ] as const) expect(() => assertRenderablePreview(draft({ [family]: [{}] }))).toThrow(error);
  });

  it("rejects a non-zero record start and retiming", () => {
    const gap = draft();
    gap.trimOperations[0]!.recordRange.start = { num: "5", den: "1" };
    expect(() => assertRenderablePreview(gap)).toThrow("gaps or overlaps");
    const retime = draft();
    retime.trimOperations[0]!.recordRange.duration = { num: "2", den: "1" };
    expect(() => assertRenderablePreview(retime)).toThrow("Retiming is not supported");
  });

  it("summarizes the timeline without touching media", () => {
    const two = draft();
    const second = structuredClone(two.trimOperations[0]!);
    Object.assign(second, { opId: "trim-2", order: "2", clipId: "clip-2" });
    second.recordRange.start = { num: "1", den: "1" };
    two.trimOperations.push(second);
    two.transitionOperations.push({
      opId: "tr-1", order: "1", trackId: "v1", clipId: "clip-2", leftClipId: "clip-1", rightClipId: "clip-2",
      kind: "crossfade", duration: { num: "500", den: "1000" },
    });
    const summary = summarizeDraftTimeline(two);
    expect(summary.mainTrackSegments).toBe(2);
    expect(summary.mainDurationSeconds).toBe("2.000");
    expect(summary.transitionCount).toBe(1);
    expect(summary.transitionOverlapSeconds).toBe("0.500");
    expect(summary.effectiveMainDurationSeconds).toBe("1.500");
    expect(summary.segments).toHaveLength(2);
    expect(summary.segments[1]!.sourceAssetId).toBe("asset-1");
  });
});