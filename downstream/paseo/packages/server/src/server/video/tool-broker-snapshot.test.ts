import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { EditorService } from "./service.js";
import { VideoToolBroker } from "./tool-broker.js";

// get_project_snapshot caps the asset list at 64 and flags hasMoreAssets; the
// existing broker tests only exercise a single asset. Drive 65 assets to pin the
// truncation branch the planner relies on to page through large projects.

it("truncates the snapshot asset list at 64 and flags hasMoreAssets", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "planner-snapshot-"));
  const service = await EditorService.create({ paseoHome: home });
  try {
    await service.start();
    const store = service.store;
    const principal = service.principalForOwner();
    const { projectId } = store.createProject({ requestId: "p", title: "Big", principal });
    const blob = await service.cas.writeBytes(Buffer.from("snapshot-fixture"), "application/octet-stream");
    const streams = [
      { kind: "video" as const, streamUid: "stream:0", streamIndex: 0, codec: "h264", timeBase: { num: "1", den: "30" }, disposition: {} },
    ];
    for (let i = 0; i < 65; i++) {
      store.addAsset(
        projectId,
        { assetId: `clip-${String(i).padStart(2, "0")}`, original: blob, displayName: "clip", streams, probe: blob, presentationIndex: blob, sourceNeverWritable: true },
        `a${i}`,
        principal,
      );
    }
    const broker = new VideoToolBroker(store, { projectId, runId: "run", principal });
    const snapshot = broker.invoke({ protocolVersion: "1", toolCallId: "call", tool: "get_project_snapshot", args: { projectId } }) as {
      assetCount: number; hasMoreAssets: boolean; assets: unknown[];
    };
    expect(snapshot.assetCount).toBe(65);
    expect(snapshot.hasMoreAssets).toBe(true);
    expect(snapshot.assets).toHaveLength(64);
  } finally {
    await service.stop();
    await rm(home, { recursive: true, force: true });
  }
});