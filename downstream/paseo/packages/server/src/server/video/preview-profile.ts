import type { EditPlanDraftV1, Rational } from "#video-editor/contracts/v1";
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
    draft.generationRequests,
    draft.qaRequirements,
    draft.externalDestinations,
  ];
  if (
    draft.preferredDeterministicBackendId === "filmcraft" ||
    unsupported.some((ops) => ops.length > 0)
  )
    editorFailure("CAPABILITY_UNAVAILABLE", "This preview profile supports FFmpeg trims only");
  if (draft.audioOperations.length > 64)
    editorFailure("CAPABILITY_UNAVAILABLE", "At most 64 audio operations per plan");
  for (const op of draft.audioOperations) {
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
  }
  if (draft.subtitleOperations.length > 64)
    editorFailure("CAPABILITY_UNAVAILABLE", "At most 64 subtitle cues per plan");
  const ops = draft.trimOperations;
  if (ops.length === 0)
    editorFailure("CAPABILITY_UNAVAILABLE", "At least one trim operation is required");
  if (ops.length > 64)
    editorFailure("CAPABILITY_UNAVAILABLE", "At most 64 segments per plan in this profile");
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
      cursor = rationalAdd(cursor, op.recordRange.duration);
    }
    if (trackId === "v1") mainTotal = cursor;
  }
  // Subtitle cues are expressed in output time and must fit the main track.
  for (const cue of draft.subtitleOperations) {
    if (cue.range.start.num.startsWith("-") || cue.range.duration.num.startsWith("-"))
      editorFailure("CAPABILITY_UNAVAILABLE", "Subtitle ranges must be non-negative");
    const end = rationalAdd(cue.range.start, cue.range.duration);
    if (BigInt(end.num) * BigInt(mainTotal.den) > BigInt(mainTotal.num) * BigInt(end.den))
      editorFailure("CAPABILITY_UNAVAILABLE", "Subtitle cue extends past the output duration");
  }
  // Transitions only between consecutive segments of one track, never longer
  // than either side.
  const byClip = new Map(ops.map((op) => [op.clipId, op]));
  for (const tr of draft.transitionOperations) {
    if (tr.kind !== "crossfade" && tr.kind !== "fade")
      editorFailure("CAPABILITY_UNAVAILABLE", "Only crossfade/fade transitions are supported");
    const left = byClip.get(tr.leftClipId);
    const right = byClip.get(tr.rightClipId);
    if (!left || !right)
      editorFailure("CAPABILITY_UNAVAILABLE", "Transition endpoints must match trim clips");
    const track = tracks.get(left.trackId)!;
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

