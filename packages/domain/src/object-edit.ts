import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ObjectCandidateSchema,
  ObjectDecisionSchema,
  TimeRangeSchema,
  editorFailure,
  type ObjectCandidate,
  type ObjectDecision,
  type ObjectEditState,
  type TimeRange,
} from "@ave/contracts";
import { canonicalJson } from "./hash.js";

export function candidateManifestHash(candidates: readonly ObjectCandidate[]): string {
  const ordered = [...candidates].sort(
    (left, right) =>
      left.objectId.localeCompare(right.objectId) || left.trackId.localeCompare(right.trackId),
  );
  return createHash("sha256").update(canonicalJson(ordered)).digest("hex");
}

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

export function assertCandidateSet(candidates: readonly ObjectCandidate[]): void {
  const objectIds = new Set<string>();
  const trackIds = new Set<string>();
  for (const candidate of candidates) {
    if (objectIds.has(candidate.objectId)) {
      editorFailure("INVALID_ARGUMENT", "The candidate list contains a duplicate object id");
    }
    if (trackIds.has(candidate.trackId)) {
      editorFailure("INVALID_ARGUMENT", "The candidate list contains a duplicate track id");
    }
    objectIds.add(candidate.objectId);
    trackIds.add(candidate.trackId);
  }
}

export function assertDecisionSet(
  decisions: readonly ObjectDecision[],
  candidates: readonly ObjectCandidate[],
): void {
  const known = new Set(candidates.map((candidate) => candidate.objectId));
  const seen = new Set<string>();
  for (const decision of decisions) {
    if (!known.has(decision.objectId)) {
      editorFailure("INVALID_ARGUMENT", "A decision references an unknown object");
    }
    if (seen.has(decision.objectId)) {
      editorFailure("INVALID_ARGUMENT", "A candidate received more than one decision");
    }
    seen.add(decision.objectId);
  }
}

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
  ) {
    editorFailure("INVALID_ARGUMENT", "The object edit range must be non-empty and non-negative");
  }
}

export function parseCandidates(value: unknown): ObjectCandidate[] {
  const parsed = z.array(ObjectCandidateSchema).min(1).max(32).safeParse(value);
  if (!parsed.success) {
    editorFailure("INVALID_ARGUMENT", "The candidate payload does not match the wire contract");
  }
  assertCandidateSet(parsed.data);
  return parsed.data;
}

export function parseDecisions(
  value: unknown,
  candidates: readonly ObjectCandidate[],
): ObjectDecision[] {
  const parsed = z.array(ObjectDecisionSchema).min(1).max(32).safeParse(value);
  if (!parsed.success) {
    editorFailure("INVALID_ARGUMENT", "The decision payload does not match the wire contract");
  }
  assertDecisionSet(parsed.data, candidates);
  return parsed.data;
}

export function parseSourceRange(value: unknown): TimeRange {
  const parsed = TimeRangeSchema.safeParse(value);
  if (!parsed.success) {
    editorFailure("INVALID_ARGUMENT", "The object edit range does not match the wire contract");
  }
  assertSourceRange(parsed.data);
  return parsed.data;
}

const VALID_OBJECT_EDIT_TRANSITIONS: Record<ObjectEditState, readonly ObjectEditState[]> = {
  analyzing: ["awaiting_target_selection", "failed"],
  awaiting_target_selection: ["awaiting_mask_review", "completed", "failed"],
  awaiting_mask_review: ["awaiting_mask_review", "awaiting_generation_review", "failed"],
  awaiting_generation_review: ["completed", "failed"],
  completed: [],
  failed: [],
};

export function assertObjectEditTransition(from: ObjectEditState, to: ObjectEditState): void {
  if (!VALID_OBJECT_EDIT_TRANSITIONS[from].includes(to)) {
    editorFailure("WORKFLOW_STATE", `Invalid object edit state transition: ${from} -> ${to}`);
  }
}
