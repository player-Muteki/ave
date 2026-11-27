import { describe, expect, it } from "vitest";
import { EditorError } from "./errors.js";
import {
  checkSeamContinuity,
  maskIou,
  planTrackWindows,
} from "./object-windows.js";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof EditorError) return error.code;
    throw error;
  }
  throw new Error("expected the call to fail");
}

describe("tracking windows", () => {
  it("splits a 100-frame shot into overlapping 81-frame runs", () => {
    const windows = planTrackWindows(0, 100);
    expect(windows).toEqual([
      { firstFrame: 0, frameCount: 81, overlapBefore: 0 },
      { firstFrame: 79, frameCount: 21, overlapBefore: 2 },
    ]);
    expect(windows[0]!.frameCount).toBeLessThanOrEqual(81);
    expect(windows[1]!.firstFrame).toBe(79);
    expect(windows[1]!.firstFrame + windows[1]!.frameCount - 1).toBe(99);
  });

  it("keeps a single window for 81 or 2 frames and splits 300 frames into four", () => {
    expect(planTrackWindows(0, 81)).toHaveLength(1);
    expect(planTrackWindows(0, 2)).toEqual([{ firstFrame: 0, frameCount: 2, overlapBefore: 0 }]);
    const windows = planTrackWindows(10, 300);
    expect(windows).toHaveLength(4);
    expect(windows.at(-1)!.firstFrame + windows.at(-1)!.frameCount - 1).toBe(309);
    for (const window of windows.slice(1))
      expect(window.overlapBefore).toBe(2);
  });

  it("rejects degenerate windows and sizes beyond the SAM2 contract", () => {
    expect(codeOf(() => planTrackWindows(0, 1))).toBe("INVALID_ARGUMENT");
    expect(codeOf(() => planTrackWindows(-1, 10))).toBe("INVALID_ARGUMENT");
    expect(codeOf(() => planTrackWindows(0, 10, { maxFrames: 82 }))).toBe("INVALID_ARGUMENT");
    expect(codeOf(() => planTrackWindows(0, 10, { maxFrames: 5, overlap: 5 }))).toBe(
      "INVALID_ARGUMENT",
    );
  });
});

describe("seam continuity", () => {
  it("passes identical masks and fails disjoint or drifting ones", () => {
    const left = Uint8Array.of(1, 0, 1, 1, 0, 0);
    expect(maskIou(left, left)).toBe(1);
    expect(checkSeamContinuity(left, left).passed).toBe(true);
    expect(maskIou(left, Uint8Array.of(0, 0, 0, 0, 1, 0))).toBe(0);
    expect(maskIou(left, Uint8Array.of(1, 0, 1, 0, 1, 1))).toBeCloseTo(2 / 5, 6);
    expect(checkSeamContinuity(left, Uint8Array.of(0, 0, 0, 0, 0, 0)).passed).toBe(false);
  });

  it("rejects empty, mismatched and out-of-range inputs", () => {
    expect(codeOf(() => maskIou(new Uint8Array(), new Uint8Array()))).toBe("INVALID_ARGUMENT");
    expect(codeOf(() => maskIou(Uint8Array.of(1), Uint8Array.of(1, 0)))).toBe("INVALID_ARGUMENT");
    expect(codeOf(() => checkSeamContinuity(Uint8Array.of(1), Uint8Array.of(1), 0))).toBe(
      "INVALID_ARGUMENT",
    );
    expect(codeOf(() => checkSeamContinuity(Uint8Array.of(1), Uint8Array.of(1), 1.5))).toBe(
      "INVALID_ARGUMENT",
    );
  });
});
