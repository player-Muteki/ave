import type { ObjectEditWorkflow } from "#video-editor/contracts/v1";
import { editorFailure } from "./errors.js";
import { removalTargets } from "./object-edit.js";

/**
 * P0-C generation gate: one shot, one target, the nine-frame VACE profile.
 * Media facts (size, rotation, pixel aspect, transfer) arrive from the caller
 * because the server never decodes; this module only decides whether the
 * workflow and the profile permit a removal generation at all.
 */
export const REMOVAL_VACE_PROFILE = {
  profileId: "removal-vace-9f-832x480-v1",
  frames: 9,
  maxWidth: 832,
  maxHeight: 480,
} as const;

export interface RemovalMediaFacts {
  frames: number;
  width: number;
  height: number;
  rotation: number;
  sampleAspectRatio: string;
  transfer: string;
}

export interface RemovalGenerationPlan {
  profileId: string;
  workflowId: string;
  assetId: string;
  objectId: string;
  trackId: string;
  frames: number;
}

const SQUARE_PIXELS = new Set(["1:1", "1/1", "N/A", ""]);
const HDR_TRANSFERS = new Set(["smpte2084", "arib-std-b67"]);

export function planRemovalGeneration(
  workflow: ObjectEditWorkflow,
  media: RemovalMediaFacts,
): RemovalGenerationPlan {
  if (workflow.state !== "awaiting_generation_review")
    editorFailure("WORKFLOW_STATE", "Generation requires a reviewed object mask");
  const targets = removalTargets(workflow.candidates, workflow.decisions);
  if (targets.length === 0)
    editorFailure("WORKFLOW_STATE", "No removal target was selected");
  if (targets.length > 1)
    editorFailure(
      "CAPABILITY_UNAVAILABLE",
      "The first removal profile accepts one target per shot",
    );
  if (media.frames !== REMOVAL_VACE_PROFILE.frames)
    editorFailure(
      "CAPABILITY_UNAVAILABLE",
      "Local removal needs the nine-frame profile; long shots arrive in P1",
    );
  if (media.width % 2 !== 0 || media.height % 2 !== 0)
    editorFailure("CAPABILITY_UNAVAILABLE", "Local removal needs even frame dimensions");
  if (media.width > REMOVAL_VACE_PROFILE.maxWidth || media.height > REMOVAL_VACE_PROFILE.maxHeight)
    editorFailure("CAPABILITY_UNAVAILABLE", "Local removal is capped at 832x480");
  if (media.rotation !== 0)
    editorFailure("CAPABILITY_UNAVAILABLE", "Local removal needs unrotated source frames");
  if (!SQUARE_PIXELS.has(media.sampleAspectRatio))
    editorFailure("CAPABILITY_UNAVAILABLE", "Local removal needs square pixels");
  if (HDR_TRANSFERS.has(media.transfer))
    editorFailure("CAPABILITY_UNAVAILABLE", "Local removal needs an SDR source");
  const target = targets[0]!;
  return {
    profileId: REMOVAL_VACE_PROFILE.profileId,
    workflowId: workflow.workflowId,
    assetId: workflow.assetId,
    objectId: target.objectId,
    trackId: target.trackId,
    frames: REMOVAL_VACE_PROFILE.frames,
  };
}
