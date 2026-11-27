import { describe, expect, it } from "vitest";
import { EditorError } from "./errors.js";
import {
  assertCandidateSet,
  assertDecisionSet,
  candidateManifestHash,
  canonicalJson,
  parseCandidates,
  parseSourceRange,
  removalTargets,
  riskBand,
  riskScore,
} from "./object-edit.js";
import type { ObjectCandidate, ObjectDecision } from "#video-editor/contracts/v1";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof EditorError) return error.code;
    throw error;
  }
  throw new Error("expected the call to fail");
}

const risk = { areaRatio: 0.2, occlusion: 0.1, motion: 0.1, overlapProtected: false };

function candidate(objectId: string, trackId = `track-${objectId}`): ObjectCandidate {
  return {
    objectId,
    trackId,
    role: "background",
    confidence: 0.8,
    evidenceFrames: ["3", "9"],
    box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    risk,
  };
}

describe("object edit pure rules", () => {
  it("hashes candidates independently of key and array member order", () => {
    const left = { b: 1, a: [{ y: 2, x: 1 }] };
    const right = { a: [{ x: 1, y: 2 }], b: 1 };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(candidateManifestHash([candidate("a"), candidate("b")])).toBe(
      candidateManifestHash([candidate("b"), candidate("a")]),
    );
    expect(candidateManifestHash([candidate("a")])).not.toBe(candidateManifestHash([]));
  });

  it("weights removal risk and lets protected overlap dominate", () => {
    expect(riskScore(risk)).toBeCloseTo(0.15, 6);
    expect(riskBand(riskScore(risk))).toBe("low");
    expect(riskScore({ ...risk, areaRatio: 1 })).toBeCloseTo(0.55, 6);
    expect(riskBand(riskScore({ ...risk, areaRatio: 1 }))).toBe("medium");
    expect(riskBand(riskScore({ ...risk, areaRatio: 1, occlusion: 0.9 }))).toBe("high");
    expect(riskScore({ ...risk, overlapProtected: true })).toBeCloseTo(0.95, 6);
  });

  it("rejects duplicate objects, tracks and decisions", () => {
    expect(codeOf(() => assertCandidateSet([candidate("a"), candidate("a")]))).toBe(
      "INVALID_ARGUMENT",
    );
    expect(
      codeOf(() => assertCandidateSet([candidate("a"), candidate("b", "track-a")])),
    ).toBe("INVALID_ARGUMENT");
    const decisions: ObjectDecision[] = [{ objectId: "a", decision: "remove" }];
    expect(codeOf(() => assertDecisionSet(decisions, []))).toBe("INVALID_ARGUMENT");
    expect(
      codeOf(() =>
        assertDecisionSet(
          [
            { objectId: "a", decision: "remove" },
            { objectId: "a", decision: "keep" },
          ],
          [candidate("a")],
        ),
      ),
    ).toBe("INVALID_ARGUMENT");
  });

  it("selects only remove decisions as generation targets", () => {
    const candidates = [candidate("a"), candidate("b"), candidate("c")];
    const decisions: ObjectDecision[] = [
      { objectId: "a", decision: "remove" },
      { objectId: "b", decision: "keep" },
      { objectId: "c", decision: "skip" },
    ];
    expect(removalTargets(candidates, decisions).map((entry) => entry.objectId)).toEqual(["a"]);
  });

  it("rejects empty candidate lists and degenerate ranges", () => {
    expect(codeOf(() => parseCandidates([]))).toBe("INVALID_ARGUMENT");
    expect(
      codeOf(() =>
        parseSourceRange({ start: { num: "0", den: "1" }, duration: { num: "0", den: "1" } }),
      ),
    ).toBe("INVALID_ARGUMENT");
    expect(
      codeOf(() =>
        parseSourceRange({ start: { num: "-1", den: "1" }, duration: { num: "2", den: "1" } }),
      ),
    ).toBe("INVALID_ARGUMENT");
  });
});
