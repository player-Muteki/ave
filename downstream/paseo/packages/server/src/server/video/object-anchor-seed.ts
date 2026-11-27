import {
  InspectFrameRequestSchema,
  type InspectFrameRequest,
  type ObjectCandidate,
} from "#video-editor/contracts/v1";
import { editorFailure } from "./errors.js";

/**
 * Turn a human-confirmed candidate box into SAM2 point prompts on one source
 * frame. Points are integer pixels inside the box; the existing mask-revision
 * and approval flow stays untouched, so this only replaces hand-clicking.
 */

export interface AnchorPoint {
  x: number;
  y: number;
  foreground: boolean;
}

export interface AnchorSeedContext {
  projectId: string;
  assetId: string;
  streamUid: string;
  sourcePresentationIndexHash: string;
  frame: number;
}

/** 3×3 grid at quarter positions: robust to loose boxes, still fully inside them. */
export function seedAnchorPoints(
  candidate: ObjectCandidate,
  width: number,
  height: number,
): AnchorPoint[] {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
    editorFailure("INVALID_ARGUMENT", "A positive integer frame size is required");
  const box = candidate.box;
  if (!(box.width > 0 && box.height > 0))
    editorFailure("INVALID_ARGUMENT", "The candidate box has no area to seed from");
  const left = Math.max(0, Math.floor(box.x * width));
  const top = Math.max(0, Math.floor(box.y * height));
  const right = Math.min(width - 1, Math.ceil((box.x + box.width) * width) - 1);
  const bottom = Math.min(height - 1, Math.ceil((box.y + box.height) * height) - 1);
  if (right < left || bottom < top)
    editorFailure("INVALID_ARGUMENT", "The candidate box lies outside the frame");
  const xs = [0.25, 0.5, 0.75].map((fraction) =>
    Math.min(right, Math.max(left, Math.round(left + (right - left) * fraction))),
  );
  const ys = [0.25, 0.5, 0.75].map((fraction) =>
    Math.min(bottom, Math.max(top, Math.round(top + (bottom - top) * fraction))),
  );
  const points: AnchorPoint[] = [];
  for (const y of new Set(ys))
    for (const x of new Set(xs)) points.push({ x, y, foreground: true });
  return points;
}

export function seedMaskAnchorRequest(
  context: AnchorSeedContext,
  candidate: ObjectCandidate,
  width: number,
  height: number,
): InspectFrameRequest {
  const points = seedAnchorPoints(candidate, width, height);
  const request: InspectFrameRequest = {
    projectId: context.projectId,
    assetId: context.assetId,
    streamUid: context.streamUid,
    sourcePresentationIndexHash: context.sourcePresentationIndexHash,
    frame: context.frame,
    points,
  };
  // Parse the same wire shape the daemon will validate, so a bad seed fails here.
  return InspectFrameRequestSchema.parse(request);
}
