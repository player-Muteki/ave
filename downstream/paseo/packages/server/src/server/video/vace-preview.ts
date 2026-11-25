import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import {
  EditPlanDraftV1Schema,
  VACE_PROFILE,
  VACE_MODEL,
  TrackedMaskManifestSchema,
  type AcceptedEditPlan,
  type ProposeVacePreview,
  type Rational,
  type SourceAsset,
} from "#video-editor/contracts/v1";
import { ContentAddressedStore, sha256Json } from "./cas.js";
import { editorFailure } from "./errors.js";
import { prepareFrames } from "./mask-tracking.js";
import { resolveWorkerDir } from "./py-worker.js";
import type { TrackedMaskReviewInputs } from "./store.js";
import type { MediaTools } from "./media.js";

const execute = promisify(execFile);
type Manifest = z.infer<typeof TrackedMaskManifestSchema>;
const workerReport = z
  .object({
    modelRevision: z.literal(VACE_MODEL),
    steps: z.literal(20),
    seed: z.number().int().nonnegative(),
    changedPixels: z.array(z.number().int().nonnegative()).length(9),
    protectedPixels: z.array(z.number().int().nonnegative()).length(9),
    gpu: z.string(),
    torch: z.string(),
    cuda: z.string(),
    diffusers: z.string(),
    transformers: z.string(),
    textSeconds: z.number().nonnegative(),
    generationSeconds: z.number().nonnegative(),
    peakAllocatedBytes: z.number().int().nonnegative(),
    peakReservedBytes: z.number().int().nonnegative(),
  })
  .strict();

function rational(num: bigint, den: bigint): Rational {
  let a = num,
    b = den;
  while (b) [a, b] = [b, a % b];
  return { num: String(num / a), den: String(den / a) };
}
function sameTime(a: Rational, b: Rational) {
  return BigInt(a.num) * BigInt(b.den) === BigInt(b.num) * BigInt(a.den);
}
function seconds(t: Rational) {
  return (Number(t.num) / Number(t.den)).toFixed(9);
}
export async function configuredVacePython() {
  const python = process.env.VIDEO_EDITOR_VACE_PYTHON;
  const model = process.env.VIDEO_EDITOR_VACE_MODEL;
  if (!python || !model || !path.isAbsolute(python) || !path.isAbsolute(model)) return undefined;
  try {
    await Promise.all([access(python), access(path.join(model, "model_index.json"))]);
    return python;
  } catch {
    return undefined;
  }
}
export async function vaceRuntime() {
  return (
    (await configuredVacePython()) ??
    editorFailure("CAPABILITY_UNAVAILABLE", "Configure the local VACE model and Python runtime")
  );
}

function generationStream(asset: SourceAsset, doc: Manifest) {
  const stream = asset.streams.find((s) => s.streamUid === doc.streamUid && s.kind === "video");
  if (!stream) editorFailure("ASSET_NOT_FOUND", "Missing generation video stream");
  const squarePixels = ["1:1", "1/1", "N/A", ""].includes(stream.sampleAspectRatio ?? "");
  const hdr = ["smpte2084", "arib-std-b67"].includes(stream.color?.transfer ?? "");
  if (
    doc.frames.length !== 9 ||
    doc.width % 2 ||
    doc.height % 2 ||
    Number(stream.rotation ?? 0) !== 0 ||
    !squarePixels ||
    hdr
  )
    editorFailure(
      "CAPABILITY_UNAVAILABLE",
      "Local VACE needs nine unrotated, square-pixel SDR frames of even size",
    );
  return stream;
}

// This profile maps one approved source frame to each model frame. Preserve its
// actual source clock, including the duration of the last frame.
export async function sourceClock(cas: ContentAddressedStore, asset: SourceAsset, doc: Manifest) {
  const stream = generationStream(asset, doc);
  const index = JSON.parse((await cas.readBytes(asset.presentationIndex)).toString());
  const rows = index.frames.filter(
    (r: { stream_index: number; media_type: string }) =>
      r.stream_index === stream.streamIndex && r.media_type === "video",
  );
  const first = doc.frames[0]!,
    last = doc.frames[8]!;
  const start = BigInt(first.pts),
    step = BigInt(doc.frames[1]!.pts) - start;
  const final = rows[last.sourceFrame],
    next = rows[last.sourceFrame + 1];
  const duration = next
    ? BigInt(next.pts ?? next.best_effort_timestamp) - BigInt(last.pts)
    : BigInt(final?.duration ?? final?.pkt_duration ?? 0);
  if (
    start < 0n ||
    step <= 0n ||
    duration !== step ||
    doc.frames.some(
      (f, i) =>
        BigInt(f.pts) !== start + BigInt(i) * step ||
        f.pts !== (rows[f.sourceFrame]?.pts ?? rows[f.sourceFrame]?.best_effort_timestamp),
    )
  )
    editorFailure(
      "CAPABILITY_UNAVAILABLE",
      "Local VACE requires an equally spaced nine-frame range with a known end",
    );
  const n = BigInt(doc.timeBase.num),
    d = BigInt(doc.timeBase.den);
  if (asset.streams.some(s=>s.kind==="audio") && (9n*step*n*48000n)%d !== 0n)
    editorFailure("CAPABILITY_UNAVAILABLE","This shot duration cannot be represented by the 48 kHz output audio clock");
  return {
    start: rational(start * n, d),
    duration: rational(9n * step * n, d),
    rate: rational(d, step * n),
  };
}

export function generationDraft(
  request: ProposeVacePreview,
  input: TrackedMaskReviewInputs,
  doc: Manifest,
  clock: Awaited<ReturnType<typeof sourceClock>>,
  assetManifest: string,
) {
  return EditPlanDraftV1Schema.parse({
    schemaVersion: "video.edit-plan/v1",
    projectId: request.projectId,
    baseTimelineRevision: request.expectedRevision,
    baseAssetManifestHash: assetManifest,
    intent: "VACE 对象编辑 · " + request.prompt,
    preferredDeterministicBackendId: "ffmpeg",
    maxCostMicros: "0",
    trimOperations: [
      {
        opId: "trim-1",
        order: "1",
        trackId: "v1",
        clipId: "shot",
        source: {
          assetId: doc.assetId,
          assetContentHash: doc.sourceSha256,
          streamUid: doc.streamUid,
          probeRevision: "1",
        },
        sourceRange: { start: clock.start, duration: clock.duration },
        recordRange: { start: { num: "0", den: "1" }, duration: clock.duration },
      },
    ],
    transformOperations: [],
    transitionOperations: [],
    audioOperations: [],
    subtitleOperations: [],
    qaRequirements: [],
    externalDestinations: [],
    generationRequests: [
      {
        requestId: "generate-1",
        shotId: doc.jobId,
        providerProfileId: VACE_PROFILE,
        modelId: VACE_MODEL,
        prompt: request.prompt,
        negativePrompt: request.negativePrompt,
        maskRevisionId: input.manifest.artifactId,
        maskApprovalId: request.maskApprovalId,
        referenceAssetIds: [],
        referenceManifestHash: request.manifestHash,
        samplingMapHash: sha256Json([
          "source-ordinal",
          request.manifestHash,
          input.tracking.firstFrame,
          9,
        ]),
        frameCount: "9",
        sampleFps: clock.rate,
        seedPolicy: "fixed",
        seed: String(request.seed),
        maxCostMicros: "0",
      },
    ],
  });
}

async function runLocalModel(
  python: string,
  dir: string,
  options: {
    cwd: string;
    signal: AbortSignal;
    killSignal: "SIGKILL";
    timeout: number;
    maxBuffer: number;
  },
) {
  try {
    await execute(python, ["-I", "-B", path.join(dir, "generate_masked_shot.py")], {
      ...options,
      env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
    });
  } catch (e) {
    if (options.signal.aborted) editorFailure("CANCELLED", "Generation was interrupted");
    const detail = String((e as { stderr?: string }).stderr ?? "");
    if (/ModuleNotFoundError|ImportError/.test(detail))
      editorFailure(
        "CAPABILITY_UNAVAILABLE",
        "VACE dependencies are missing from the configured isolated Python environment",
      );
    if (/out of memory|No space left/i.test(detail))
      editorFailure(
        "RESOURCE_EXHAUSTED",
        "VACE exhausted device memory or local scratch space",
        true,
      );
    editorFailure(
      "WORKER_FAILED",
      "Local VACE failed during model verification or inference",
      true,
    );
  }
}

export async function generateMaster(
  cas: ContentAddressedStore,
  tools: MediaTools,
  asset: SourceAsset,
  input: TrackedMaskReviewInputs,
  doc: Manifest,
  plan: AcceptedEditPlan,
  signal: AbortSignal,
) {
  const python = await vaceRuntime(),
    clock = await sourceClock(cas, asset, doc);
  const g = plan.generationRequests[0]!,
    op = plan.trimOperations[0]!;
  if (
    !sameTime(clock.start, op.sourceRange.start) ||
    !sameTime(clock.duration, op.sourceRange.duration) ||
    !sameTime(clock.rate, g.sampleFps)
  )
    editorFailure("PLAN_SEMANTIC_INVALID", "Source sampling clock differs from the approved plan");
  const scratch = process.env.VIDEO_EDITOR_VACE_SCRATCH ?? tmpdir();
  if (!path.isAbsolute(scratch))
    editorFailure("CAPABILITY_UNAVAILABLE", "VACE scratch directory must be absolute");
  const folder = await mkdtemp(path.join(scratch, "vace-edit-"));
  const options = {
    cwd: folder,
    signal,
    killSignal: "SIGKILL" as const,
    timeout: 600_000,
    maxBuffer: 4 << 20,
  };
  const ffmpeg = (args: string[]) =>
    execute(tools.ffmpeg, ["-nostdin", "-xerror", ...args], options);
  try {
    const pts = await prepareFrames(cas, asset, input.anchor, input.tracking, ffmpeg, "rgb24");
    if (pts.some((t, i) => t !== doc.frames[i]!.pts))
      editorFailure("QA_FAILED", "Decoded source frames changed");
    for (const [i, row] of doc.frames.entries())
      await writeFile(path.join(folder, i + ".raw"), await cas.readBytes(row.label));
    await writeFile(
      path.join(folder, "request.json"),
      JSON.stringify({
        width: doc.width,
        height: doc.height,
        prompt: g.prompt,
        negativePrompt: g.negativePrompt,
        seed: Number(g.seed),
      }),
    );
    const dir = resolveWorkerDir(path.dirname(fileURLToPath(import.meta.url)));
    await runLocalModel(python, dir, options);
    const report = workerReport.parse(
      JSON.parse(await readFile(path.join(folder, "report.json"), "utf8")),
    );
    const size = 9 * doc.width * doc.height * 3;
    if (
      report.modelRevision !== g.modelId ||
      report.seed !== Number(g.seed) ||
      doc.frames.some(
        (f, i) =>
          report.protectedPixels[i] !== doc.width * doc.height - f.foregroundPixels ||
          report.changedPixels[i]! > f.foregroundPixels,
      ) ||
      (await stat(path.join(folder, "source.rgb"))).size !== size ||
      (await stat(path.join(folder, "composite.rgb"))).size !== size
    )
      editorFailure("QA_FAILED", "Incomplete VACE output");
    const audio = asset.streams.find((s) => s.kind === "audio");
    await ffmpeg([
      "-v",
      "error",
      "-copyts",
      "-f",
      "rawvideo",
      "-pixel_format",
      "rgb24",
      "-video_size",
      doc.width + "x" + doc.height,
      "-framerate",
      clock.rate.num + "/" + clock.rate.den,
      "-i",
      "composite.rgb",
      "-i",
      cas.pathFor(asset.original),
      "-map",
      "0:v:0",
      ...(audio
        ? [
            "-map",
            "1:" + audio.streamIndex,
            "-af",
            "atrim=start=" +
              seconds(clock.start) +
              ":duration=" +
              seconds(clock.duration) +
              ",asetpts=PTS-STARTPTS,aresample=48000",
            "-c:a",
            "aac",
          ]
        : []),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-threads:v",
      "1",
      "-movflags",
      "+faststart",
      "master.mp4",
    ]);
    const { stdout } = await execute(
      tools.ffprobe,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_frames",
        "-show_streams",
        "-show_entries",
        "stream=time_base:frame=pts",
        "-of",
        "json",
        "master.mp4",
      ],
      options,
    );
    const probe = JSON.parse(stdout);
    const [num, den] = String(probe.streams[0]?.time_base).split("/").map(BigInt);
    if (
      probe.frames.length !== 9 ||
      probe.frames.some(
        (frame: { pts: number }, i: number) =>
          BigInt(frame.pts) * num! * BigInt(clock.rate.num) !==
          BigInt(i) * den! * BigInt(clock.rate.den),
      )
    )
      editorFailure("QA_FAILED", "Generation candidate changed source frame timing");
    const master = await cas.importFile(path.join(folder, "master.mp4"), "video/mp4");
    return {
      master,
      modelRun: {
        ...report,
        profile: g.providerProfileId,
        maskApprovalId: g.maskApprovalId,
        manifestHash: g.referenceManifestHash,
        samplingMapHash: g.samplingMapHash,
        sourceSha256: doc.sourceSha256,
      },
    };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
