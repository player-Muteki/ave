import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ObjectCandidateSchema,
  ObjectDecisionSchema,
  TimeRangeSchema,
  type ObjectCandidate,
  type ObjectDecision,
  type TimeRange,
} from "#video-editor/contracts/v1";
import { editorFailure } from "./errors.js";

/**
 * Deterministic JSON with sorted object keys. Candidate hashes must not change
 * because a detector or a worker serialized its fields in another order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function candidateManifestHash(candidates: readonly ObjectCandidate[]): string {
  // The manifest identifies the set, so member order must not change the hash.
  const ordered = [...candidates].sort(
    (left, right) =>
      left.objectId.localeCompare(right.objectId) || left.trackId.localeCompare(right.trackId),
  );
  return createHash("sha256").update(canonicalJson(ordered)).digest("hex");
}

/**
 * Removal risk: how much of the frame disappears, how occluded or fast the
 * subject is, and whether it overlaps a protected region (faces of kept people,
 * subtitles, product close-ups). Overlap is an override, not an average.
 */
export function riskScore(risk: ObjectCandidate["risk"]): number {
  const weighted = 0.5 * risk.areaRatio + 0.3 * risk.occlusion + 0.2 * risk.motion;
  const bounded = Math.max(0, Math.min(1, weighted));
  return risk.overlapProtected ? Math.max(bounded, 0.95) : bounded;
}

export type RiskBand = "low" | "medium" | "high";

export function riskBand(score: number): RiskBand {
  if (score >= 0.65) return "high";
  if (score >= 0.35) return "medium";
  return "low";
}

/** Candidates are one row per tracked object; duplicates would fork a decision. */
export function assertCandidateSet(candidates: readonly ObjectCandidate[]): void {
  const objectIds = new Set<string>();
  const trackIds = new Set<string>();
  for (const candidate of candidates) {
    if (objectIds.has(candidate.objectId))
      editorFailure("INVALID_ARGUMENT", "The candidate list contains a duplicate object id");
    if (trackIds.has(candidate.trackId))
      editorFailure("INVALID_ARGUMENT", "The candidate list contains a duplicate track id");
    objectIds.add(candidate.objectId);
    trackIds.add(candidate.trackId);
  }
}

/** Every decision must point at a candidate that exists, at most once. */
export function assertDecisionSet(
  decisions: readonly ObjectDecision[],
  candidates: readonly ObjectCandidate[],
): void {
  const known = new Set(candidates.map((candidate) => candidate.objectId));
  const seen = new Set<string>();
  for (const decision of decisions) {
    if (!known.has(decision.objectId))
      editorFailure("INVALID_ARGUMENT", "A decision references an unknown object");
    if (seen.has(decision.objectId))
      editorFailure("INVALID_ARGUMENT", "A candidate received more than one decision");
    seen.add(decision.objectId);
  }
}

/** Objects the user asked to remove; only these may seed a generation. */
export function removalTargets(
  candidates: readonly ObjectCandidate[],
  decisions: readonly ObjectDecision[],
): ObjectCandidate[] {
  const byId = new Map(candidates.map((candidate) => [candidate.objectId, candidate] as const));
  return decisions
    .filter((decision) => decision.decision === "remove")
    .map((decision) => byId.get(decision.objectId))
    .filter((candidate): candidate is ObjectCandidate => candidate !== undefined);
}

export function assertSourceRange(range: TimeRange): void {
  if (
    range.start.num.startsWith("-") ||
    range.duration.num.startsWith("-") ||
    range.duration.num === "0"
  )
    editorFailure("INVALID_ARGUMENT", "The object edit range must be non-empty and non-negative");
}

/** Validate untrusted worker payloads before they reach the durable workflow row. */
export function parseCandidates(value: unknown): ObjectCandidate[] {
  const parsed = z.array(ObjectCandidateSchema).min(1).max(32).safeParse(value);
  if (!parsed.success)
    editorFailure("INVALID_ARGUMENT", "The candidate payload does not match the wire contract");
  assertCandidateSet(parsed.data);
  return parsed.data;
}

export function parseDecisions(
  value: unknown,
  candidates: readonly ObjectCandidate[],
): ObjectDecision[] {
  const parsed = z.array(ObjectDecisionSchema).min(1).max(32).safeParse(value);
  if (!parsed.success)
    editorFailure("INVALID_ARGUMENT", "The decision payload does not match the wire contract");
  assertDecisionSet(parsed.data, candidates);
  return parsed.data;
}

export function parseSourceRange(value: unknown): TimeRange {
  const parsed = TimeRangeSchema.safeParse(value);
  if (!parsed.success)
    editorFailure("INVALID_ARGUMENT", "The object edit range does not match the wire contract");
  assertSourceRange(parsed.data);
  return parsed.data;
}
