import { createHash } from "node:crypto";
import { z } from "zod";
import type { ObjectCandidate, PersonRole } from "@ave/contracts";
import { riskScore } from "./object-edit.js";

const uint = z.string().regex(/^(0|[1-9][0-9]*)$/);

export const DetectorTrackSchema = z
  .object({
    trackId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/),
    firstFrame: uint,
    lastFrame: uint,
    evidenceFrames: z.array(uint).min(1).max(64),
    box: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      })
      .strict(),
    confidence: z.number().min(0).max(1),
    areaRatio: z.number().min(0).max(1),
    centrality: z.number().min(0).max(1),
    motion: z.number().min(0).max(1),
    occlusion: z.number().min(0).max(1),
    visibility: z.number().min(0).max(1),
  })
  .strict();

export const DetectorResultSchema = z
  .object({
    backend: z.string().min(1).max(64),
    frameWidth: z.number().int().positive(),
    frameHeight: z.number().int().positive(),
    frames: z.number().int().positive(),
    tracks: z.array(DetectorTrackSchema).max(64),
  })
  .strict();

export type DetectorTrack = z.infer<typeof DetectorTrackSchema>;
export type DetectorResult = z.infer<typeof DetectorResultSchema>;

function clamp(value: number, low = 0, high = 1): number {
  return Math.min(high, Math.max(low, value));
}

export function protagonistScore(track: DetectorTrack): number {
  return 0.5 * track.areaRatio + 0.3 * track.centrality + 0.2 * track.visibility;
}

export function assignRoles(tracks: readonly DetectorTrack[]): PersonRole[] {
  const scores = tracks.map(protagonistScore);
  const best = scores.reduce(
    (winner, score, index) => (score > (scores[winner] ?? -1) ? index : winner),
    scores.length > 0 ? 0 : -1,
  );
  return tracks.map((track, index) => {
    const dominant = best === index && (scores[index] ?? 0) >= 0.3 && track.areaRatio >= 0.03;
    if (dominant) return "protagonist";
    if (track.areaRatio < 0.035 || track.centrality < 0.35) return "background";
    return "uncertain";
  });
}

export function objectIdFor(assetContentHash: string, trackId: string): string {
  return `obj-${createHash("sha256").update(`${assetContentHash}:${trackId}`).digest("hex").slice(0, 24)}`;
}

function normalizedBox(track: DetectorTrack) {
  const x = clamp(track.box.x);
  const y = clamp(track.box.y);
  const width = clamp(track.box.width, 0, 1 - x);
  const height = clamp(track.box.height, 0, 1 - y);
  return { x, y, width, height };
}

function orderedEvidence(track: DetectorTrack): string[] {
  const first = Number(track.firstFrame);
  const last = Number(track.lastFrame);
  const unique = [...new Set(track.evidenceFrames.map(Number))]
    .filter((frame) => frame >= first && frame <= last)
    .sort((left, right) => left - right);
  return (unique.length > 0 ? unique : [first]).slice(0, 12).map(String);
}

export function toObjectCandidates(
  result: DetectorResult,
  assetContentHash: string,
): ObjectCandidate[] {
  const tracks = result.tracks.filter((track) => {
    const box = normalizedBox(track);
    return box.width > 0 && box.height > 0;
  });
  const roles = assignRoles(tracks);
  return tracks.map((track, index) => ({
    objectId: objectIdFor(assetContentHash, track.trackId),
    trackId: track.trackId,
    role: roles[index] ?? "uncertain",
    confidence: clamp(track.confidence),
    evidenceFrames: orderedEvidence(track),
    box: normalizedBox(track),
    risk: {
      areaRatio: clamp(track.areaRatio),
      occlusion: clamp(track.occlusion),
      motion: clamp(track.motion),
      overlapProtected: false,
    },
  }));
}

export function candidateRisk(candidate: ObjectCandidate): number {
  return riskScore(candidate.risk);
}
