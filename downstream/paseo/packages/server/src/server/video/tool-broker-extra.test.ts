import { mkdtemp, rm } from "node:fs/promises";
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
    const probe = await service.cas.writeJson({ streams: [
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
        presentationIndex: blob,
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