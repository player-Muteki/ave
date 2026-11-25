import { PlannerAssetMetadataSchema } from "#video-editor/contracts/v1";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { EditorService } from "./service.js";
import { VideoToolBroker } from "./tool-broker.js";

// Complements tool-broker.test.ts: covers the successful get_asset_metadata
// stream projection, get_job_status (unknown job fails closed) and the
// get_project_snapshot asset-count/hasMoreAssets shape.

it("projects asset metadata, fails closed on unknown jobs, and reports snapshot shape", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "planner-broker-extra-"));
  const service = await EditorService.create({ paseoHome: home });
  try {
    await service.start();
    const store = service.store;
    const principal = service.principalForOwner();
    const { projectId } = store.createProject({ requestId: "p", title: "Planner", principal });
    const blob = await service.cas.writeBytes(Buffer.from("broker-extra"), "application/octet-stream");
    const probe = await service.cas.writeJson({ format: { start_time: "-0.080000" }, streams: [
      { index: 1, codec_type: "audio", time_base: "1/48000", start_pts: 0, duration_ts: 2 ** 53 },
      { index: 0, codec_type: "video", time_base: "1/90000", start_pts: -7200, duration_ts: 90000 },
    ] });
    store.addAsset(
      projectId,
      {
        assetId: "clip",
        original: blob,
        displayName: "clip",
        streams: [
          { kind: "video", streamUid: "stream:0", streamIndex: 0, codec: "h264", timeBase: { num: "1", den: "90000" }, averageRate: { num: "24", den: "1" }, disposition: {} },
          { kind: "audio", streamUid: "stream:1", streamIndex: 1, codec: "aac", timeBase: { num: "1", den: "48000" }, disposition: {} },
        ],
        probe,
        presentationIndex: await service.cas.writeJson({ frames: [{ stream_index: 1 }, { stream_index: 0 }] }),
        sourceNeverWritable: true,
      },
      "asset",
      principal,
    );
    const broker = new VideoToolBroker(store, { projectId, runId: "run", principal });
    const call = (tool: string, args: unknown) =>
      broker.invoke({ protocolVersion: "1", toolCallId: "call", tool, args });

    expect(await call("get_asset_metadata", { assetId: "clip", contentHash: blob.sha256 })).toEqual({
      assetId: "clip",
      contentHash: blob.sha256,
      durationSeconds: null,
      frameCount: 1,
      inputStartTime: { num: "-80000", den: "1000000" },
      streams: [
        { streamUid: "stream:0", kind: "video", codec: "h264", timeBase: { num: "1", den: "90000" },
          averageRate: { num: "24", den: "1" }, startPts: "-7200", durationTicks: "90000" },
        { streamUid: "stream:1", kind: "audio", codec: "aac", timeBase: { num: "1", den: "48000" }, startPts: "0" },
      ],
    });

    expect(() => call("get_job_status", { jobId: "missing" })).toThrow(/The job does not exist/);

    expect(call("get_project_snapshot", { projectId })).toMatchObject({
      assetCount: 1,
      hasMoreAssets: false,
      assets: [{ assetId: "clip", contentHash: blob.sha256 }],
    });
  } finally {
    await service.stop();
    await rm(home, { recursive: true, force: true });
  }
});

it("measures a nonzero-start Matroska stream from its decoded frame index", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "planner-index-duration-"));
  const service = await EditorService.create({ paseoHome: home });
  try {
    const source = path.join(home, "offset.mkv");
    await promisify(execFile)("ffmpeg", [
      "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=32x32:rate=25:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000:duration=2",
      "-vf", "select='gte(n,3)*not(eq(n,5))'", "-fps_mode", "vfr", "-c:v", "ffv1", "-c:a", "pcm_s16le",
      "-output_ts_offset", "2", source,
    ]);
    await service.start();
    const principal = service.principalForOwner();
    const { projectId } = service.store.createProject({ requestId: "p", title: "VFR", principal });
    const bytes = await readFile(source);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const { uploadId } = service.store.createUpload({
      projectId, principal, requestId: "upload", displayName: "offset.mkv", mediaType: "video/x-matroska",
      expectedSize: String(bytes.length), expectedSha256: sha256,
    });
    await service.media.writeUploadChunk(uploadId, "0", bytes, principal);
    const asset = await service.media.commitUpload(uploadId, "commit", sha256, principal);
    const probe = JSON.parse((await service.cas.readBytes(asset.probe)).toString("utf8"));
    expect(probe.streams.every((stream: { duration_ts?: number }) => stream.duration_ts === undefined)).toBe(true);
    const broker = new VideoToolBroker(service.store, { projectId, runId: "cut", principal });
    const metadata = (assetId: string) => broker.invoke({
      protocolVersion: "1", toolCallId: "metadata", tool: "get_asset_metadata",
      args: { assetId, contentHash: sha256 },
    });
    expect(await metadata(asset.assetId)).toMatchObject({
      inputStartTime: { num: "2000000", den: "1000000" },
      streams: [
        { kind: "video", timeBase: { num: "1", den: "1000" }, startPts: "2120", durationTicks: "1880" },
        { kind: "audio", timeBase: { num: "1", den: "1000" }, startPts: "2000", durationTicks: "2000" },
      ],
    });
    const incomplete = JSON.parse((await service.cas.readBytes(asset.presentationIndex)).toString("utf8"));
    const lastVideo = incomplete.frames.findLast((f: { media_type: string }) => f.media_type === "video");
    delete lastVideo.duration;
    delete lastVideo.pkt_duration;
    const alternate = {
      ...asset, assetId: "incomplete-index", presentationIndex: await service.cas.writeJson(incomplete),
    };
    service.store.addAsset(projectId, alternate, "add-incomplete", principal);
    const result = PlannerAssetMetadataSchema.parse(await metadata(alternate.assetId));
    expect(result.streams[0]!.durationTicks).toBeUndefined();
    expect(result.streams[1]!.durationTicks).toBe("2000");
  } finally {
    await service.stop();
    await rm(home, { recursive: true, force: true });
  }
});
