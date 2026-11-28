import type { EditPlanDraftV1, ProjectSnapshot, Rational, SourceAsset, TimeRange } from "@ave/contracts";

function parseSeconds(value: string): Rational {
  const text = value.trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) throw new Error("请输入非负秒数，可以使用小数。");
  const [whole, decimals = ""] = text.split(".");
  const fraction = decimals.replace(/0+$/, "");
  return { num: BigInt((whole || "0") + fraction).toString(), den: (10n ** BigInt(fraction.length)).toString() };
}

export function readTrimRange(startSeconds: string, durationSeconds: string): TimeRange {
  const start = parseSeconds(startSeconds);
  const duration = parseSeconds(durationSeconds);
  if (duration.num === "0") throw new Error("裁剪时长必须大于零。");
  return { start, duration };
}

export function buildSingleTrimDraft(
  project: ProjectSnapshot,
  asset: SourceAsset,
  range: TimeRange,
  intent: string,
): EditPlanDraftV1 {
  const video = asset.streams.find((s) => s.kind === "video");
  if (!video) {
    throw new Error("所选素材不包含视频流。");
  }
  const { start, duration } = range;
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
    intent: intent.trim() || "桌面端裁剪片段",
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
