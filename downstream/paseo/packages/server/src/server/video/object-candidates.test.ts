import { describe, expect, it } from "vitest";
import {
  assignRoles,
  candidateRisk,
  objectIdFor,
  toObjectCandidates,
  type DetectorResult,
  type DetectorTrack,
} from "./object-candidates.js";

function track(overrides: Partial<DetectorTrack> = {}): DetectorTrack {
  return {
    trackId: "t1",
    firstFrame: "0",
    lastFrame: "20",
    evidenceFrames: ["0", "5", "10"],
    box: { x: 0.4, y: 0.3, width: 0.2, height: 0.4 },
    confidence: 0.85,
    areaRatio: 0.2,
    centrality: 0.9,
    motion: 0.1,
    occlusion: 0.05,
    visibility: 0.95,
    ...overrides,
  };
}

function result(tracks: DetectorTrack[]): DetectorResult {
  return { backend: "hog", frameWidth: 640, frameHeight: 360, frames: 30, tracks };
}

describe("object candidates", () => {
  it("names one dominant central person as the protagonist and edge persons as background", () => {
    const roles = assignRoles([
      track(),
      track({ trackId: "t2", box: { x: 0.02, y: 0.55, width: 0.05, height: 0.12 }, areaRatio: 0.01, centrality: 0.2 }),
    ]);
    expect(roles).toEqual(["protagonist", "background"]);
  });

  it("leaves two comparable persons uncertain instead of guessing", () => {
    const roles = assignRoles([
      track(),
      track({ trackId: "t2", box: { x: 0.6, y: 0.3, width: 0.18, height: 0.36 }, areaRatio: 0.18, centrality: 0.75 }),
    ]);
    expect(roles[0]).toBe("protagonist");
    expect(roles[1]).toBe("uncertain");
  });

  it("derives stable object ids from asset hash and track id", () => {
    const hash = "a".repeat(64);
    expect(objectIdFor(hash, "t1")).toBe(objectIdFor(hash, "t1"));
    expect(objectIdFor(hash, "t1")).not.toBe(objectIdFor(hash, "t2"));
    expect(objectIdFor("b".repeat(64), "t1")).not.toBe(objectIdFor(hash, "t1"));
  });

  it("maps tracks to clamped candidates with ordered evidence and risk inputs", () => {
    const candidates = toObjectCandidates(
      result([
        track({ box: { x: 0.95, y: 0.9, width: 0.3, height: 0.3 }, evidenceFrames: ["10", "0", "10", "5", "99"] }),
      ]),
      "c".repeat(64),
    );
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.box.x).toBeCloseTo(0.95, 6);
    expect(candidate.box.width).toBeCloseTo(0.05, 6);
    expect(candidate.evidenceFrames).toEqual(["0", "5", "10"]);
    expect(candidate.role).toBe("protagonist");
    expect(candidateRisk(candidate)).toBeCloseTo(0.5 * 0.2 + 0.3 * 0.05 + 0.2 * 0.1, 6);
  });

  it("drops degenerate boxes and keeps an empty detector result empty", () => {
    const candidates = toObjectCandidates(
      result([track({ box: { x: 0.5, y: 0.5, width: 0, height: 0.2 } })]),
      "d".repeat(64),
    );
    expect(candidates).toEqual([]);
    expect(toObjectCandidates(result([]), "d".repeat(64))).toEqual([]);
  });

  it("does not invent a protagonist when nobody is visible enough", () => {
    const candidates = toObjectCandidates(
      result([
        track({ areaRatio: 0.01, centrality: 0.9 }),
        track({ trackId: "t2", areaRatio: 0.02, centrality: 0.8 }),
      ]),
      "e".repeat(64),
    );
    expect(candidates.map((candidate) => candidate.role)).toEqual(["background", "background"]);
  });
});
