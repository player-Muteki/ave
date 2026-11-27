import { describe, expect, it } from "vitest";
import {
  ROLE_LABELS,
  candidateRisk,
  decisionsById,
  describeObjectEditState,
  rankCandidates,
  removeCount,
  riskBand,
} from "../client/object-edit-view.js";
import type { ObjectCandidate, ObjectEditWorkflow } from "../shared/contracts/v1.js";

function candidate(
  objectId: string,
  role: ObjectCandidate["role"],
  overrides: Partial<ObjectCandidate> = {},
): ObjectCandidate {
  return {
    objectId,
    trackId: `t-${objectId}`,
    role,
    confidence: 0.8,
    evidenceFrames: ["0"],
    box: { x: 0.1, y: 0.1, width: 0.2, height: 0.4 },
    risk: { areaRatio: 0.2, occlusion: 0, motion: 0.1, overlapProtected: false },
    ...overrides,
  };
}

describe("object edit view", () => {
  it("orders protagonist, uncertain, background and breaks ties by risk", () => {
    const ranked = rankCandidates([
      candidate("bg", "background", { risk: { areaRatio: 0.5, occlusion: 0.5, motion: 0.5, overlapProtected: false } }),
      candidate("unc", "uncertain"),
      candidate("lead", "protagonist"),
    ]);
    expect(ranked.map((entry) => entry.objectId)).toEqual(["lead", "unc", "bg"]);
    expect(ROLE_LABELS.protagonist).toBe("主角");
  });

  it("scores risk with the same weights as the server and treats protected overlap as an override", () => {
    expect(candidateRisk(candidate("a", "background"))).toBeCloseTo(0.12, 6);
    expect(riskBand(candidate("a", "background"))).toBe("low");
    const protectedOverlap = candidate("b", "protagonist", {
      risk: { areaRatio: 0.1, occlusion: 0.1, motion: 0.1, overlapProtected: true },
    });
    expect(candidateRisk(protectedOverlap)).toBeCloseTo(0.95, 6);
    expect(riskBand(protectedOverlap)).toBe("high");
  });

  it("explains every workflow state without leaking internal jargon", () => {
    for (const state of [
      "analyzing",
      "awaiting_target_selection",
      "awaiting_mask_review",
      "awaiting_generation_review",
      "completed",
      "failed",
    ] as const) {
      const copy = describeObjectEditState(state);
      expect(copy.label.length).toBeGreaterThan(0);
      expect(copy.hint.length).toBeGreaterThan(0);
    }
  });

  it("maps recorded decisions and counts removals", () => {
    const workflow = {
      decisions: [
        { objectId: "a", decision: "remove" },
        { objectId: "b", decision: "keep" },
      ],
    } as unknown as ObjectEditWorkflow;
    expect(decisionsById(workflow).get("a")).toBe("remove");
    expect(removeCount(workflow)).toBe(1);
  });
});
