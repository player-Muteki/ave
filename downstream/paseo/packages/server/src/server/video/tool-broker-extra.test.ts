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
    store.addAsset(
      projectId,
      {
        assetId: "clip",
        original: blob,
        displayName: "clip",
        streams: [
          { kind: "video", streamUid: "stream:0", streamIndex: 0, codec: "h264", timeBase: { num: "1", den: "30" }, disposition: {} },
        ],
        probe: blob,
        presentationIndex: blob,
        sourceNeverWritable: true,
      },
      "asset",
      principal,
    );
    const broker = new VideoToolBroker(store, { projectId, runId: "run", principal });
    const call = (tool: string, args: unknown) =>
      broker.invoke({ protocolVersion: "1", toolCallId: "call", tool, args });

    expect(call("get_asset_metadata", { assetId: "clip", contentHash: blob.sha256 })).toEqual({
      assetId: "clip",
      contentHash: blob.sha256,
      streams: [{ streamUid: "stream:0", kind: "video", codec: "h264", timeBase: { num: "1", den: "30" } }],
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