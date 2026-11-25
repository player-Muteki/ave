import { VACE_MODEL, VACE_PROFILE, type EditPlanDraftV1, type Rational } from "#video-editor/contracts/v1";
import { editorFailure } from "./errors.js";

function rationalEquals(a: Rational, b: Rational): boolean {
  return BigInt(a.num) * BigInt(b.den) === BigInt(b.num) * BigInt(a.den);
}

function rationalAdd(a: Rational, b: Rational): Rational {
  return {
    num: (BigInt(a.num) * BigInt(b.den) + BigInt(b.num) * BigInt(a.den)).toString(),
    den: (BigInt(a.den) * BigInt(b.den)).toString(),
  };
}

/**
 * Keep unverified operations out of approvals and re-check persisted plans before dispatch.
 * The preview profile supports contiguous multi-segment trims over video streams of one or
 * more assets: record ranges tile [0, total) in order, no segment is retimed, and each
 * segment may carry at most one crop/scale/rotation transform.
 */
export function assertRenderablePreview(draft: EditPlanDraftV1): void {
  const unsupported = [
    draft.generationRequests.filter(g => g.providerProfileId !== VACE_PROFILE),
    draft.qaRequirements,
    draft.externalDestinations,
  ];
  if (
    draft.preferredDeterministicBackendId === "filmcraft" ||
    unsupported.some((ops) => ops.length > 0)
  )
    editorFailure("CAPABILITY_UNAVAILABLE", "This preview profile supports FFmpeg trims only");
  if (draft.generationRequests.length) {
    const [g] = draft.generationRequests;
    if (draft.generationRequests.length !== 1 || draft.trimOperations.length !== 1 || draft.audioOperations.length ||
        draft.transformOperations.length || draft.transitionOperations.length || draft.subtitleOperations.length ||
        draft.trimOperations[0]?.fadeIn || draft.trimOperations[0]?.fadeOut || draft.trimOperations[0]?.trackId !== "v1" ||
        !g?.maskApprovalId || g.frameCount !== "9" || g.referenceAssetIds.length || g.seedPolicy !== "fixed" ||
        BigInt(g.seed) > 4294967295n || draft.maxCostMicros !== "0" || g.maxCostMicros !== "0" ||
        g.modelId !== VACE_MODEL || !g.prompt.trim() || g.prompt.length>2048 || g.negativePrompt.length>2048)
      editorFailure("CAPABILITY_UNAVAILABLE","Local VACE requires one approved nine-frame shot, a fixed seed and the pinned model");
  }
  if (draft.audioOperations.length > 64)
    editorFailure("CAPABILITY_UNAVAILABLE", "At most 64 audio operations per plan");
  const audioByClip = new Map<string, number>();
  for (const op of draft.audioOperations) {
    if (audioByClip.has(op.clipId))
      editorFailure("CAPABILITY_UNAVAILABLE", "At most one audio operation per clip");
    audioByClip.set(op.clipId, 1);
    const trim = draft.trimOperations.find((t) => t.clipId === op.clipId);
    if (!trim)
      editorFailure("CAPABILITY_UNAVAILABLE", "Audio operations must target trim clips");
    if (trim.trackId !== "v1")
      editorFailure("CAPABILITY_UNAVAILABLE", "Audio operations must target the main track");
    if (
      !rationalEquals(op.recordRange.start, trim.recordRange.start) ||
      !rationalEquals(op.recordRange.duration, trim.recordRange.duration)
    )
      editorFailure("CAPABILITY_UNAVAILABLE", "Audio record range must match its trim clip");
    if (!rationalEquals(op.sourceRange.duration, op.recordRange.duration))
      editorFailure("CAPABILITY_UNAVAILABLE", "Audio retiming is not supported");
    const fadeSum = rationalAdd(op.fadeIn ?? { num: "0", den: "1" }, op.fadeOut ?? { num: "0", den: "1" });
    if (
      BigInt(fadeSum.num) * BigInt(op.recordRange.duration.den) >
      BigInt(op.recordRange.duration.num) * BigInt(fadeSum.den)
    )
      editorFailure("CAPABILITY_UNAVAILABLE", "Audio fades must fit the clip duration");
  }
  if (draft.subtitleOperations.length > 64)
    editorFailure("CAPABILITY_UNAVAILABLE", "At most 64 subtitle cues per plan");
  const ops = draft.trimOperations;
  if (ops.length === 0)
    editorFailure("CAPABILITY_UNAVAILABLE", "At least one trim operation is required");
  if (ops.length > 64)
    editorFailure("CAPABILITY_UNAVAILABLE", "At most 64 segments per plan in this profile");
  const clipIds = new Set<string>();
  for (const op of ops) {
    if (clipIds.has(op.clipId))
      editorFailure("CAPABILITY_UNAVAILABLE", "Duplicate clipId in trim operations");
    clipIds.add(op.clipId);
    if (BigInt(op.sourceRange.duration.num) <= 0n || BigInt(op.recordRange.duration.num) <= 0n)
      editorFailure("CAPABILITY_UNAVAILABLE", "Segment duration must be positive");
    if (
      op.sourceRange.start.num.startsWith("-") ||
      op.recordRange.start.num.startsWith("-") ||
      op.sourceRange.duration.num.startsWith("-")
    )
      editorFailure("CAPABILITY_UNAVAILABLE", "Segment ranges must be non-negative");
  }
  // v1 is the main timeline; an optional v2 is overlaid on top of it. Each
  // track's record ranges tile [0, track total) contiguously in array order.
  const tracks = new Map<string, typeof ops>();
  for (const op of ops) {
    const list = tracks.get(op.trackId) ?? [];
    list.push(op);
    tracks.set(op.trackId, list);
  }
  if (
    tracks.size > 2 ||
    !tracks.has("v1") ||
    [...tracks.keys()].some((t) => t !== "v1" && t !== "v2")
  )
    editorFailure(
      "CAPABILITY_UNAVAILABLE",
      "Only tracks v1 (main) and v2 (overlay) are supported",
    );
  let mainTotal: Rational = { num: "0", den: "1" };
  for (const [trackId, list] of tracks) {
    let cursor: Rational = { num: "0", den: "1" };
    list.forEach((op, k) => {
      if (op.order !== String(k + 1))
        editorFailure("CAPABILITY_UNAVAILABLE", "Segment order must match its position per track");
    });
    for (const op of list) {
      if (op.overlayX !== undefined || op.overlayY !== undefined) {
        if (trackId !== "v2" || op.overlayX === undefined || op.overlayY === undefined)
          editorFailure(
            "CAPABILITY_UNAVAILABLE",
            "Overlay offsets are only supported on v2 segments (both x and y)",
          );
      }
      if (!rationalEquals(op.recordRange.start, cursor))
        editorFailure(
          "CAPABILITY_UNAVAILABLE",
          "Timeline gaps or overlaps are not supported by this preview profile",
        );
      if (!rationalEquals(op.sourceRange.duration, op.recordRange.duration))
        editorFailure(
          "CAPABILITY_UNAVAILABLE",
          "Retiming is not supported by this preview profile",
        );
      const fadeSum = rationalAdd(op.fadeIn ?? { num: "0", den: "1" }, op.fadeOut ?? { num: "0", den: "1" });
      if (
        BigInt(fadeSum.num) * BigInt(op.recordRange.duration.den) >
        BigInt(op.recordRange.duration.num) * BigInt(fadeSum.den)
      )
        editorFailure("CAPABILITY_UNAVAILABLE", "Video fades must fit the segment duration");
      cursor = rationalAdd(cursor, op.recordRange.duration);
    }
    if (trackId === "v1") mainTotal = cursor;
  }
  // Subtitle cues are expressed in output time and must fit the main track.
  for (const cue of draft.subtitleOperations) {
    if (!ops.some((op) => op.clipId === cue.clipId))
      editorFailure("CAPABILITY_UNAVAILABLE", "Subtitle cues must target trim clips");
    if (cue.range.start.num.startsWith("-") || cue.range.duration.num.startsWith("-"))
      editorFailure("CAPABILITY_UNAVAILABLE", "Subtitle ranges must be non-negative");
    const end = rationalAdd(cue.range.start, cue.range.duration);
    if (BigInt(end.num) * BigInt(mainTotal.den) > BigInt(mainTotal.num) * BigInt(end.den))
      editorFailure("CAPABILITY_UNAVAILABLE", "Subtitle cue extends past the output duration");
  }
  // Transitions only between consecutive segments of one track, never longer
  // than either side.
  const byClip = new Map(ops.map((op) => [op.clipId, op]));
  const transitionByLeft = new Map<string, number>();
  for (const tr of draft.transitionOperations) {
    if (tr.kind !== "crossfade" && tr.kind !== "fade")
      editorFailure("CAPABILITY_UNAVAILABLE", "Only crossfade/fade transitions are supported");
    if (BigInt(tr.duration.num) <= 0n)
      editorFailure("CAPABILITY_UNAVAILABLE", "Transition duration must be positive");
    const left = byClip.get(tr.leftClipId);
    const right = byClip.get(tr.rightClipId);
    if (!left || !right)
      editorFailure("CAPABILITY_UNAVAILABLE", "Transition endpoints must match trim clips");
    const track = tracks.get(left.trackId)!;
    if (transitionByLeft.has(tr.leftClipId))
      editorFailure("CAPABILITY_UNAVAILABLE", "At most one transition per segment");
    transitionByLeft.set(tr.leftClipId, 1);
    if (tr.clipId !== right.clipId)
      editorFailure("CAPABILITY_UNAVAILABLE", "Transition clipId must match the right segment");
    if (right.trackId !== left.trackId || track.indexOf(right) !== track.indexOf(left) + 1)
      editorFailure(
        "CAPABILITY_UNAVAILABLE",
        "Transitions must connect consecutive segments on one track",
      );
    const dur = BigInt(tr.duration.num) * BigInt(left.recordRange.duration.den);
    const leftLen = BigInt(left.recordRange.duration.num) * BigInt(tr.duration.den);
    const rightLen = BigInt(right.recordRange.duration.num) * BigInt(tr.duration.den);
    if (dur > leftLen || dur > rightLen)
      editorFailure("CAPABILITY_UNAVAILABLE", "Transition longer than an adjacent segment");
  }  // At most one transform per clip, and it must target an existing trim clip.
  const transformByClip = new Map<string, (typeof draft.transformOperations)[number]>();
  for (const tr of draft.transformOperations) {
    const trim = byClip.get(tr.clipId);
    if (!trim)
      editorFailure("CAPABILITY_UNAVAILABLE", "Transforms must target trim clips");
    if (
      !rationalEquals(tr.recordRange.start, trim.recordRange.start) ||
      !rationalEquals(tr.recordRange.duration, trim.recordRange.duration) ||
      !rationalEquals(tr.sourceRange.duration, tr.recordRange.duration)
    )
      editorFailure(
        "CAPABILITY_UNAVAILABLE",
        "Transform ranges must match its trim clip without retiming",
      );
    if (transformByClip.has(tr.clipId))
      editorFailure("CAPABILITY_UNAVAILABLE", "At most one transform per clip");
    const cropW = Number(tr.crop.width);
    const cropH = Number(tr.crop.height);
    const scaleW = Number(tr.scale.width);
    const scaleH = Number(tr.scale.height);
    if (cropW > 0 || cropH > 0) {
      if (cropW <= 0 || cropH <= 0 || cropW % 2 !== 0 || cropH % 2 !== 0)
        editorFailure("CAPABILITY_UNAVAILABLE", "Crop dimensions must be positive and even");
    }
    if (scaleW > 0 || scaleH > 0) {
      if (scaleW <= 0 || scaleH <= 0 || scaleW % 2 !== 0 || scaleH % 2 !== 0)
        editorFailure("CAPABILITY_UNAVAILABLE", "Scaled dimensions must be positive and even");
    }
    transformByClip.set(tr.clipId, tr);
  }
}


function rationalSub(a: Rational, b: Rational): Rational {
  return {
    num: (BigInt(a.num) * BigInt(b.den) - BigInt(b.num) * BigInt(a.den)).toString(),
    den: (BigInt(a.den) * BigInt(b.den)).toString(),
  };
}

function rationalSeconds(r: Rational): string {
  const value = Number(r.num) / Number(r.den);
  return Number.isFinite(value) ? value.toFixed(3) : "0";
}

export interface DraftTimelineSummary {
  mainTrackSegments: number;
  overlayTrackSegments: number;
  mainDurationSeconds: string;
  overlayDurationSeconds: string;
  transitionCount: number;
  transitionOverlapSeconds: string;
  effectiveMainDurationSeconds: string;
  audioOperationCount: number;
  transformCount: number;
  subtitleCueCount: number;
  segments: Array<{
    clipId: string;
    trackId: string;
    startSeconds: string;
    durationSeconds: string;
    sourceAssetId: string;
  }>;
}

/**
 * Bounded, read-only timeline summary of a draft for the planner: per-track
 * segment totals, transition overlap and op counts. Pure arithmetic on the
 * draft; never touches media or CAS.
 */
export function summarizeDraftTimeline(draft: EditPlanDraftV1): DraftTimelineSummary {
  const tracks = new Map<string, typeof draft.trimOperations>();
  for (const op of draft.trimOperations) {
    const list = tracks.get(op.trackId) ?? [];
    list.push(op);
    tracks.set(op.trackId, list);
  }
  const total = (list: typeof draft.trimOperations): Rational =>
    list.reduce((acc, op) => rationalAdd(acc, op.recordRange.duration), { num: "0", den: "1" });
  const main = total(tracks.get("v1") ?? []);
  const overlay = total(tracks.get("v2") ?? []);
  const overlap = draft.transitionOperations.reduce(
    (acc, tr) => rationalAdd(acc, tr.duration),
    { num: "0", den: "1" } as Rational,
  );
  return {
    mainTrackSegments: (tracks.get("v1") ?? []).length,
    overlayTrackSegments: (tracks.get("v2") ?? []).length,
    mainDurationSeconds: rationalSeconds(main),
    overlayDurationSeconds: rationalSeconds(overlay),
    transitionCount: draft.transitionOperations.length,
    transitionOverlapSeconds: rationalSeconds(overlap),
    effectiveMainDurationSeconds: rationalSeconds(rationalSub(main, overlap)),
    audioOperationCount: draft.audioOperations.length,
    transformCount: draft.transformOperations.length,
    subtitleCueCount: draft.subtitleOperations.length,
    segments: draft.trimOperations.slice(0, 64).map((op) => ({
      clipId: op.clipId,
      trackId: op.trackId,
      startSeconds: rationalSeconds(op.recordRange.start),
      durationSeconds: rationalSeconds(op.recordRange.duration),
      sourceAssetId: op.source.assetId,
    })),
  };
}
