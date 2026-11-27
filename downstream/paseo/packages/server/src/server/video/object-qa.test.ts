import { describe, expect, it } from "vitest";
import { EditorError } from "./errors.js";
import { evaluateObjectQa, parseObjectQa } from "./object-qa.js";
import { OBJECT_EDIT_QA_LIMITS } from "#video-editor/contracts/v1";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof EditorError) return error.code;
    throw error;
  }
  throw new Error("expected the call to fail");
}

describe("object removal QA", () => {
  it("passes exactly at the published thresholds", () => {
    const verdict = evaluateObjectQa({
      frames: "9",
      residualRatio: OBJECT_EDIT_QA_LIMITS.residualRatioMax,
      completeRatio: OBJECT_EDIT_QA_LIMITS.completeRatioMin,
      flickerRatio: OBJECT_EDIT_QA_LIMITS.flickerRatioMax,
    });
    expect(verdict.passed).toBe(true);
    expect(verdict.checks.map((check) => check.metric)).toEqual(["residual", "complete", "flicker"]);
  });

  it("names every failing metric independently", () => {
    const residual = evaluateObjectQa({
      frames: "9",
      residualRatio: 0.03,
      completeRatio: 0.99,
      flickerRatio: 0.01,
    });
    expect(residual.passed).toBe(false);
    expect(residual.failed).toEqual(["residual"]);
    const all = evaluateObjectQa({
      frames: "9",
      residualRatio: 0.03,
      completeRatio: 0.9,
      flickerRatio: 0.2,
    });
    expect(all.failed).toEqual(["residual", "complete", "flicker"]);
  });

  it("rejects empty or out-of-range reports", () => {
    expect(
      codeOf(() => parseObjectQa({ frames: "0", residualRatio: 0, completeRatio: 1, flickerRatio: 0 })),
    ).toBe("INVALID_ARGUMENT");
    expect(
      codeOf(() =>
        parseObjectQa({ frames: "9", residualRatio: -0.1, completeRatio: 1, flickerRatio: 0 }),
      ),
    ).toBe("INVALID_ARGUMENT");
  });
});
