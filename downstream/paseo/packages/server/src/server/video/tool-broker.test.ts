import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { EditorService } from "./service.js";
import { VideoToolBroker } from "./tool-broker.js";

it("binds tool calls to the admitted project and persists only a proposed plan", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "planner-broker-"));
  const service = await EditorService.create({ paseoHome: home });
  try {
    await service.start();
    const store = service.store,
      principal = service.principalForOwner();
    const { projectId } = store.createProject({ requestId: "p", title: "Planner", principal });
    const other = store.createProject({ requestId: "q", title: "Other", principal });
    const blob = await service.cas.writeBytes(
      Buffer.from("broker-fixture"),
      "application/octet-stream",
    );
    store.addAsset(
      projectId,
      {
        assetId: "clip",
        original: blob,
        displayName: "clip",
        streams: [
          {
            kind: "video",
            streamUid: "stream:0",
            streamIndex: 0,
            codec: "h264",
            timeBase: { num: "1", den: "30" },
            disposition: {},
          },
        ],
        probe: blob,
        presentationIndex: blob,
        sourceNeverWritable: true,
      },
      "asset",
      principal,
    );
    const p = store.project(projectId, principal);
    const broker = new VideoToolBroker(store, { projectId, runId: "run", principal });
    const call = (tool: string, args: unknown) =>
      broker.invoke({ protocolVersion: "1", toolCallId: "call", tool, args });
    expect(call("get_project_snapshot", { projectId })).toMatchObject({
      assetCount: 1,
      assets: [{ assetId: "clip", contentHash: blob.sha256 }],
    });
    for (const name of ["bash", "read", "approve_plan", "create_job", "video.v1.decide_approval"])
      expect(() => call(name, {})).toThrow("Invalid planner tool request");
    expect(() => call("get_project_snapshot", { projectId: other.projectId })).toThrow(
      "bound to another project",
    );
    await expect(call("get_asset_metadata", { assetId: "clip", contentHash: "0".repeat(64) }))
      .rejects.toThrow("Asset identity");
    expect(() => call("get_project_snapshot", { projectId, principal })).toThrow(
      "Invalid planner tool request",
    );
    const range = { start: { num: "0", den: "1" }, duration: { num: "1", den: "1" } };
    const plan = {
      schemaVersion: "video.edit-plan/v1",
      projectId,
      baseTimelineRevision: p.revision,
      baseAssetManifestHash: p.baseAssetManifestHash,
      intent: "Trim",
      trimOperations: [
        {
          opId: "cut",
          order: "1",
          trackId: "v1",
          clipId: "clip",
          source: {
            assetId: "clip",
            assetContentHash: blob.sha256,
            streamUid: "stream:0",
            probeRevision: "1",
          },
          sourceRange: range,
          recordRange: range,
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
    expect(call("validate_edit_plan", plan)).toEqual({ valid: true });
    expect(store.project(projectId, principal).plans).toHaveLength(0);
    const proposed = call("submit_edit_plan", plan);
    expect(proposed).toMatchObject({ status: "proposed" });
    expect(call("submit_edit_plan", plan)).toEqual(proposed);
    expect(() => call("submit_edit_plan", { ...plan, intent: "different" })).toThrow(
      "different content",
    );
    const after = store.project(projectId, principal);
    expect(after.plans).toHaveLength(1);
    expect(after.approvals.map((a) => a.status)).toEqual(["pending"]);
    expect(after.jobs).toEqual([]);
  } finally {
    await service.stop();
    await rm(home, { recursive: true, force: true });
  }
});
