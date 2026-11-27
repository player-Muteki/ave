import type { EditPlanDraftV1, ProjectSnapshot, Rational, SourceAsset } from "@ave/contracts";

export interface TrimInput {
  startNum: string;
  startDen: string;
  durationNum: string;
  durationDen: string;
  intent: string;
}

export function buildSingleTrimDraft(
  project: ProjectSnapshot,
  asset: SourceAsset,
  trim: TrimInput,
): EditPlanDraftV1 {
  const video = asset.streams.find((s) => s.kind === "video");
  if (!video) {
    throw new Error("所选素材不包含视频流。");
  }
  const start: Rational = { num: trim.startNum.trim(), den: trim.startDen.trim() };
  const duration: Rational = { num: trim.durationNum.trim(), den: trim.durationDen.trim() };
  if (!/^(0|[1-9][0-9]*)$/.test(start.num) || !/^[1-9][0-9]*$/.test(start.den)) {
    throw new Error("起始时间必须是非负有理数。");
  }
  if (!/^[1-9][0-9]*$/.test(duration.num) || !/^[1-9][0-9]*$/.test(duration.den)) {
    throw new Error("裁剪时长必须是正有理数。");
  }
  return {
    schemaVersion: "video.edit-plan/v1",
    projectId: project.projectId,
    baseTimelineRevision: project.revision,
    baseAssetManifestHash: project.baseAssetManifestHash,
    preferredDeterministicBackendId: "ffmpeg",
    intent: trim.intent.trim() || "桌面端裁剪片段",
    trimOperations: [
      {
        opId: "trim-main-1",
        order: "1",
        trackId: "v1",
        clipId: "clip-main-1",
        source: {
          assetId: asset.assetId,
          assetContentHash: asset.original.sha256,
          streamUid: video.streamUid,
          probeRevision: "1",
        },
        sourceRange: { start, duration },
        recordRange: { start: { num: "0", den: "1" }, duration },
      },
    ],
    transformOperations: [],
    audioOperations: [],
    transitionOperations: [],
    subtitleOperations: [],
    generationRequests: [],
    qaRequirements: [],
    externalDestinations: [],
    maxCostMicros: "0",
  };
}

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
