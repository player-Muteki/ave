import type { EditPlanDraftV1, ProjectSnapshot } from "../shared/contracts/v1.js";

// The editor accepts seconds with millisecond precision, never frame numbers derived from FPS.
function milliseconds(value: string): bigint {
  const match = /^(\d{1,9})(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) throw new Error("请输入非负秒数，最多三位小数。");
  return BigInt(match[1]!) * 1000n + BigInt((match[2] ?? "").padEnd(3, "0"));
}

export interface CaptionCue {
  text: string;
  start: string;
  end: string;
}

export interface TransformSpec {
  scaleW?: string;
  scaleH?: string;
  rotation?: "0" | "90" | "180" | "270";
}

export function proposeCut(
  project: ProjectSnapshot,
  assetId: string,
  start: string,
  end: string,
  caption?: CaptionCue,
  audioGainMilli?: string,
  transform?: TransformSpec,
  bgmAssetId?: string,
): EditPlanDraftV1 {
  const asset = project.assets.find((a) => a.assetId === assetId);
  const stream = asset?.streams.find((s) => s.kind === "video");
  if (!asset || !stream) throw new Error("请选择含视频流的素材。");
  const first = milliseconds(start);
  const last = milliseconds(end);
  if (last <= first) throw new Error("出点必须晚于入点。");
  const duration = { num: (last - first).toString(), den: "1000" };
  if (transform) {
    for (const v of [transform.scaleW, transform.scaleH])
      if (v !== undefined && v.trim() !== "" && !/^\d{1,7}$/.test(v.trim()))
        throw new Error("缩放宽高必须是非负整数");
    if (
      transform.rotation !== undefined &&
      !["0", "90", "180", "270"].includes(transform.rotation)
    )
      throw new Error("旋转角度只能是 0/90/180/270");
  }
  return {
    schemaVersion: "video.edit-plan/v1",
    projectId: project.projectId,
    baseTimelineRevision: project.revision,
    baseAssetManifestHash: project.baseAssetManifestHash,
    preferredDeterministicBackendId: "ffmpeg",
    intent: `保留 ${asset.displayName} 的 ${start.trim()}–${end.trim()} 秒`,
    trimOperations: [
      {
        opId: "trim-1",
        order: "1",
        trackId: "v1",
        clipId: "clip-1",
        source: {
          assetId,
          assetContentHash: asset.original.sha256,
          streamUid: stream.streamUid,
          probeRevision: "1",
        },
        sourceRange: { start: { num: first.toString(), den: "1000" }, duration },
        recordRange: { start: { num: "0", den: "1" }, duration },
      },
    ],
    transformOperations: transform
      ? [
          {
            opId: "xf-1",
            order: "1",
            trackId: "v1",
            clipId: "clip-1",
            source: {
              assetId,
              assetContentHash: asset.original.sha256,
              streamUid: stream.streamUid,
              probeRevision: "1",
            },
            sourceRange: { start: { num: first.toString(), den: "1000" }, duration },
            recordRange: { start: { num: "0", den: "1" }, duration },
            crop: { x: "0", y: "0", width: "0", height: "0" },
            scale: {
              width: transform.scaleW?.trim() || "0",
              height: transform.scaleH?.trim() || "0",
            },
            rotationDegrees: transform.rotation ?? "0",
          },
        ]
      : [],
    audioOperations: bgmAssetId
      ? (() => {
          const bgm = project.assets.find((a) => a.assetId === bgmAssetId);
          const astream = bgm?.streams.find((s) => s.kind === "audio");
          if (!bgm || !astream) throw new Error("BGM 素材缺少音频流");
          return [
            {
              opId: "audio-1",
              order: "1",
              trackId: "a1",
              clipId: "clip-1",
              source: {
                assetId: bgm.assetId,
                assetContentHash: bgm.original.sha256,
                streamUid: astream.streamUid,
                probeRevision: "1",
              },
              sourceRange: { start: { num: "0", den: "1" }, duration },
              recordRange: { start: { num: "0", den: "1" }, duration },
              gainMilli:
                audioGainMilli && /^-?\d{1,6}$/.test(audioGainMilli.trim())
                  ? audioGainMilli.trim()
                  : "0",
              mute: false,
            },
          ];
        })()
      : audioGainMilli && /^\d{1,6}$/.test(audioGainMilli.trim())
        ? [
            {
              opId: "audio-1",
              order: "1",
              trackId: "a1",
              clipId: "clip-1",
              source: {
                assetId,
                assetContentHash: asset.original.sha256,
                streamUid: asset.streams.find((s) => s.kind === "audio")?.streamUid ?? stream.streamUid,
                probeRevision: "1",
              },
              sourceRange: { start: { num: first.toString(), den: "1000" }, duration },
              recordRange: { start: { num: "0", den: "1" }, duration },
              gainMilli: audioGainMilli.trim(),
              mute: false,
            },
          ]
        : [],
    transitionOperations: [],
    subtitleOperations: caption
      ? [
          {
            opId: "sub-1",
            order: "1",
            trackId: "s1",
            clipId: "clip-1",
            cueId: "cue-1",
            range: {
              start: { num: milliseconds(caption.start).toString(), den: "1000" },
              duration: { num: (milliseconds(caption.end) - milliseconds(caption.start)).toString(), den: "1000" },
            },
            text: caption.text.slice(0, 16_384),
            mode: "burn-in" as const,
          },
        ]
      : [],
    generationRequests: [],
    qaRequirements: [],
    externalDestinations: [],
    maxCostMicros: "0",
  };
}

/** Delete the middle range [cutStart, cutEnd) and concatenate the rest: two contiguous trims. */
export function proposeCutOut(
  project: ProjectSnapshot,
  assetId: string,
  cutStart: string,
  cutEnd: string,
  totalSeconds: string,
): EditPlanDraftV1 {
  const asset = project.assets.find((a) => a.assetId === assetId);
  const stream = asset?.streams.find((s) => s.kind === "video");
  if (!asset || !stream) throw new Error("请选择含视频流的素材。");
  const from = milliseconds(cutStart);
  const to = milliseconds(cutEnd);
  const total = milliseconds(totalSeconds);
  if (to <= from) throw new Error("删除终点必须晚于删除起点。");
  if (total <= to) throw new Error("素材总长必须大于删除终点。");
  const ms = (v: bigint) => ({ num: v.toString(), den: "1000" });
  const head = { num: from.toString(), den: "1000" };
  const tailDuration = total - to;
  const tailStart = { num: to.toString(), den: "1000" };
  const base = proposeCut(project, assetId, "0", "0.001");
  return {
    ...base,
    intent: `删除 ${asset.displayName} 的 ${cutStart.trim()}–${cutEnd.trim()} 秒并拼接前后段`,
    trimOperations: [
      {
        opId: "trim-head",
        order: "1",
        trackId: "v1",
        clipId: "clip-head",
        source: base.trimOperations[0]!.source,
        sourceRange: { start: ms(0n), duration: head },
        recordRange: { start: ms(0n), duration: head },
      },
      {
        opId: "trim-tail",
        order: "2",
        trackId: "v1",
        clipId: "clip-tail",
        source: base.trimOperations[0]!.source,
        sourceRange: { start: tailStart, duration: ms(tailDuration) },
        recordRange: { start: head, duration: ms(tailDuration) },
      },
    ],
  };
}

export interface ConcatSegment {
  assetId: string;
  start: string;
  end: string;
}

/** Concatenate segments from possibly different assets into one contiguous timeline. */
export function proposeConcat(
  project: ProjectSnapshot,
  segments: ConcatSegment[],
  fadeSeconds?: string,
  transitionKind: "crossfade" | "fade" = "crossfade",
): EditPlanDraftV1 {
  if (!segments.length) throw new Error("至少需要一个片段。");
  const ops = segments.map((seg, i) => {
    const asset = project.assets.find((a) => a.assetId === seg.assetId);
    const stream = asset?.streams.find((s) => s.kind === "video");
    if (!asset || !stream) throw new Error(`素材 ${seg.assetId} 缺少视频流。`);
    const from = milliseconds(seg.start);
    const to = milliseconds(seg.end);
    if (to <= from) throw new Error("出点必须晚于入点。");
    return { asset, stream, from, to, index: i };
  });
  let cursor = 0n;
  const trimOperations = ops.map(({ asset, stream, from, to, index }) => {
    const duration = { num: (to - from).toString(), den: "1000" };
    const op = {
      opId: `trim-${index + 1}`,
      order: (index + 1).toString(),
      trackId: "v1",
      clipId: `clip-${index + 1}`,
      source: {
        assetId: asset.assetId,
        assetContentHash: asset.original.sha256,
        streamUid: stream.streamUid,
        probeRevision: "1",
      },
      sourceRange: { start: { num: from.toString(), den: "1000" }, duration },
      recordRange: { start: { num: cursor.toString(), den: "1000" }, duration },
    };
    cursor += to - from;
    return op;
  });
  const fadeMs = fadeSeconds !== undefined ? milliseconds(fadeSeconds) : 0n;
  const transitionOperations =
    fadeMs > 0n && ops.length > 1
      ? ops.slice(1).map((o, i) => {
          const leftDur = ops[i]!.to - ops[i]!.from;
          const rightDur = o.to - o.from;
          if (fadeMs > leftDur || fadeMs > rightDur)
            throw new Error("转场时长不能超过相邻任一片段");
          return {
            opId: `xfade-${i + 1}`,
            order: (i + 1).toString(),
            trackId: "v1",
            clipId: `clip-${i + 2}`,
            leftClipId: `clip-${i + 1}`,
            rightClipId: `clip-${i + 2}`,
            kind: transitionKind,
            duration: { num: fadeMs.toString(), den: "1000" },
          };
        })
      : [];
  const base = proposeCut(project, ops[0]!.asset.assetId, segments[0]!.start, segments[0]!.end);
  return {
    ...base,
    transitionOperations,
    intent: `拼接 ${ops.length} 段：` + ops.map((o, i) => `${o.asset.displayName}[${segments[i]!.start}-${segments[i]!.end}]`).join(" + "),
    trimOperations,
  };
}
