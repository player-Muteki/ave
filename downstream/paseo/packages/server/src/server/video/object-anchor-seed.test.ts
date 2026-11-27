import { describe, expect, it } from "vitest";
import { EditorError } from "./errors.js";
import { seedAnchorPoints, seedMaskAnchorRequest } from "./object-anchor-seed.js";
import type { ObjectCandidate } from "#video-editor/contracts/v1";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof EditorError) return error.code;
    throw error;
  }
  throw new Error("expected the call to fail");
}

function candidate(box: ObjectCandidate["box"]): ObjectCandidate {
  return {
    objectId: "obj-a",
    trackId: "t1",
    role: "protagonist",
    confidence: 0.9,
    evidenceFrames: ["0"],
    box,
    risk: { areaRatio: 0.2, occlusion: 0, motion: 0.1, overlapProtected: false },
  };
}

describe("object anchor seeding", () => {
  it("seeds a full 3×3 grid inside a central box", () => {
    const points = seedAnchorPoints(candidate({ x: 0.4, y: 0.3, width: 0.2, height: 0.4 }), 100, 100);
    expect(points).toHaveLength(9);
    expect(points.every((point) => point.foreground)).toBe(true);
    expect(points.every((point) => point.x >= 40 && point.x <= 60)).toBe(true);
    expect(points.every((point) => point.y >= 30 && point.y <= 70)).toBe(true);
  });

  it("dedupes a tiny box to its single pixel and clamps at the frame edge", () => {
    const tiny = seedAnchorPoints(candidate({ x: 0.5, y: 0.5, width: 0.01, height: 0.01 }), 100, 100);
    expect(tiny.length).toBeGreaterThanOrEqual(1);
    expect(tiny.length).toBeLessThanOrEqual(9);
    expect(new Set(tiny.map((point) => `${point.x}:${point.y}`)).size).toBe(tiny.length);
    const edge = seedAnchorPoints(candidate({ x: 0.95, y: 0.95, width: 0.1, height: 0.1 }), 100, 100);
    expect(edge.every((point) => point.x <= 99 && point.y <= 99)).toBe(true);
    expect(edge.every((point) => point.x >= 95 && point.y >= 95)).toBe(true);
  });

  it("rejects degenerate candidates and invalid frame sizes", () => {
    expect(
      codeOf(() => seedAnchorPoints(candidate({ x: 0.5, y: 0.5, width: 0, height: 0.2 }), 100, 100)),
    ).toBe("INVALID_ARGUMENT");
    expect(
      codeOf(() => seedAnchorPoints(candidate({ x: 0.5, y: 0.5, width: 0.2, height: 0.2 }), 0, 100)),
    ).toBe("INVALID_ARGUMENT");
  });

  it("builds a wire-valid mask anchor request", () => {
    const request = seedMaskAnchorRequest(
      {
        projectId: "project-a",
        assetId: "clip-a",
        streamUid: "v",
        sourcePresentationIndexHash: "a".repeat(64),
        frame: 12,
      },
      candidate({ x: 0.2, y: 0.2, width: 0.3, height: 0.5 }),
      640,
      360,
    );
    expect(request.frame).toBe(12);
    expect(request.points).toHaveLength(9);
    expect(request.points.every((point) => point.x < 640 && point.y < 360)).toBe(true);
  });
});
