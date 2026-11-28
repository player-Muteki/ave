import { describe, expect, it } from "vitest";
import { buildSingleTrimDraft, readTrimRange } from "../src/workbench-state.js";

describe("@ave/web workbench", () => {
  it("builds single-trim EditPlanDraftV1 with rational time and ffmpeg backend", () => {
    const hash = "a".repeat(64);
    const draft = buildSingleTrimDraft(
      {
        protocolVersion: "1",
        projectId: "proj-1",
        title: "Test",
        revision: "1",
        baseAssetManifestHash: hash,
        assets: [],
        plans: [],
        approvals: [],
        jobs: [],
        objectEdits: [],
        latestSeq: "0",
      },
      {
        assetId: "asset-1",
        original: { sha256: hash, bytes: "100", mediaType: "video/mp4" },
        displayName: "clip.mp4",
        streams: [
          {
            streamUid: "stream:0",
            streamIndex: 0,
            kind: "video",
            codec: "h264",
            timeBase: { num: "1", den: "25" },
            disposition: {},
          },
        ],
        presentationIndex: { sha256: hash, bytes: "10", mediaType: "application/json" },
        probe: { sha256: hash, bytes: "10", mediaType: "application/json" },
        sourceNeverWritable: true,
      },
      readTrimRange("0", "2"),
      "Keep 2s",
    );

    expect(draft.preferredDeterministicBackendId).toBe("ffmpeg");
    expect(draft.trimOperations[0]!.recordRange.duration).toEqual({ num: "2", den: "1" });
    expect(() =>
      buildSingleTrimDraft(
        {
          protocolVersion: "1",
          projectId: "proj-1",
          title: "Test",
          revision: "1",
          baseAssetManifestHash: hash,
          assets: [],
          plans: [],
          approvals: [],
          jobs: [],
          objectEdits: [],
          latestSeq: "0",
        },
        {
          assetId: "asset-1",
          original: { sha256: hash, bytes: "100", mediaType: "video/mp4" },
          displayName: "clip.mp4",
          streams: [],
          presentationIndex: { sha256: hash, bytes: "10", mediaType: "application/json" },
          probe: { sha256: hash, bytes: "10", mediaType: "application/json" },
          sourceNeverWritable: true,
        },
        readTrimRange("0", "1"), "bad",
      ),
    ).toThrow();
  });

  it("preserves decimal seconds without floating-point conversion", () => {
    expect(readTrimRange(".25", "2.0020")).toEqual({
      start: { num: "25", den: "100" }, duration: { num: "2002", den: "1000" },
    });
    expect(() => readTrimRange("-1", "2")).toThrow();
    expect(() => readTrimRange("0", "0.00")).toThrow();
  });
});
