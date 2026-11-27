import { editorFailure } from "./errors.js";

/**
 * P1 tracking expansion: SAM2 propagation only accepts 2–81 frames per run,
 * so a long shot is split into overlapping windows. The overlap exists solely
 * to prove the two runs agree at the seam; it is never exported twice.
 */

export interface TrackWindow {
  firstFrame: number;
  frameCount: number;
  /** Frames shared with the previous window at the seam. */
  overlapBefore: number;
}

export interface TrackWindowOptions {
  maxFrames?: number;
  overlap?: number;
}

export function planTrackWindows(
  firstFrame: number,
  frameCount: number,
  options: TrackWindowOptions = {},
): TrackWindow[] {
  const maxFrames = options.maxFrames ?? 81;
  const overlap = options.overlap ?? 2;
  if (!Number.isInteger(firstFrame) || firstFrame < 0)
    editorFailure("INVALID_ARGUMENT", "Tracking windows start at a non-negative integer frame");
  if (!Number.isInteger(frameCount) || frameCount < 2)
    editorFailure("INVALID_ARGUMENT", "A tracked mask needs at least two frames");
  if (!Number.isInteger(maxFrames) || maxFrames < 2 || maxFrames > 81)
    editorFailure("INVALID_ARGUMENT", "Tracking windows accept at most 81 frames per run");
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= maxFrames)
    editorFailure("INVALID_ARGUMENT", "Window overlap must be smaller than the window");
  const windows: TrackWindow[] = [];
  let start = firstFrame;
  const last = firstFrame + frameCount - 1;
  while (start <= last) {
    const count = Math.min(maxFrames, last - start + 1);
    windows.push({
      firstFrame: start,
      frameCount: count,
      overlapBefore: start === firstFrame ? 0 : overlap,
    });
    if (start + count > last) break;
    start = start + count - overlap;
  }
  return windows;
}

/** Binary mask IoU; both masks must cover the same frame. */
export function maskIou(left: Uint8Array, right: Uint8Array): number {
  if (left.length !== right.length || left.length === 0)
    editorFailure("INVALID_ARGUMENT", "Seam masks must be non-empty and equally sized");
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index] ? 1 : 0;
    const r = right[index] ? 1 : 0;
    intersection += l & r;
    union += l | r;
  }
  return union === 0 ? 1 : intersection / union;
}

export interface SeamVerdict {
  iou: number;
  passed: boolean;
}

/** A seam passes when both runs agree on the shared frame; drift means retrack. */
export function checkSeamContinuity(
  previousTail: Uint8Array,
  nextHead: Uint8Array,
  minimumIou = 0.9,
): SeamVerdict {
  if (!(minimumIou > 0 && minimumIou <= 1))
    editorFailure("INVALID_ARGUMENT", "Seam threshold must be in (0, 1]");
  const iou = maskIou(previousTail, nextHead);
  return { iou, passed: iou >= minimumIou };
}
