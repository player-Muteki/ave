import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { EditorService } from "../service.js";
import { VideoToolBroker } from "../tool-broker.js";
import { DaemonToWorkerSchema, WorkerToDaemonSchema, IpcChannel, sha256Hex, type DaemonToWorker, type WorkerToDaemon } from "./ipc.js";
import { videoPlannerPromptSignature } from "./prompt.js";
import { createPlannerSession } from "./session.js";

it("routes Responses tool calls through Pi and persists one proposal for human approval", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ave-planner-proposal-"));
  const service = await EditorService.create({ paseoHome: root });
  const toDaemon = new PassThrough();
  const toWorker = new PassThrough();
  const worker = new IpcChannel<DaemonToWorker, WorkerToDaemon>(toWorker, toDaemon, DaemonToWorkerSchema);
  let session: Awaited<ReturnType<typeof createPlannerSession>> | undefined;
  try {
    await service.start();
    const principal = service.principalForOwner();
    const { projectId } = service.store.createProject({ requestId: "create", title: "Proposal", principal });
    const blob = await service.cas.writeBytes(Buffer.from("test asset"), "application/octet-stream");
    service.store.addAsset(projectId, {
      assetId: "source", displayName: "clip", original: blob, probe: blob, presentationIndex: blob,
      sourceNeverWritable: true, streams: [{ streamUid: "stream:0", streamIndex: 0, kind: "video",
        codec: "h264", timeBase: { num: "1", den: "25" }, disposition: {} }],
    }, "asset", principal);
    const snapshot = service.store.project(projectId, principal);
    const broker = new VideoToolBroker(service.store, { projectId, runId: "run", principal });
    const daemon = new IpcChannel<WorkerToDaemon, DaemonToWorker>(toDaemon, toWorker, WorkerToDaemonSchema);
    const callIds: string[] = [];
    daemon.setHandler(message => {
      if (message.kind !== "tool_call") return;
      callIds.push(message.call.toolCallId);
      const result = broker.invoke(message.call);
      daemon.sendValidated({ kind: "tool_result", requestId: message.requestId, ok: true, result }, DaemonToWorkerSchema);
    });

    // Feed deterministic Responses SSE bytes to the real SDK. No provider requests leave this test.
    await writeFile(path.join(root, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fixture" } }));
    vi.stubEnv("PI_OFFLINE", "1");
    let turn = 0;
    let scopeDescription = "";
    const range = { start: { num: "0", den: "1" }, duration: { num: "1", den: "1" } };
    const draft = {
      schemaVersion: "video.edit-plan/v1", projectId, baseTimelineRevision: snapshot.revision,
      baseAssetManifestHash: snapshot.baseAssetManifestHash, intent: "Keep first second",
      trimOperations: [{ opId: "cut", clipId: "clip", trackId: "v1", order: "1", sourceRange: range,
        recordRange: range, source: { assetId: "source", assetContentHash: blob.sha256, streamUid: "stream:0", probeRevision: "1" } }],
      transformOperations: [], audioOperations: [], subtitleOperations: [], transitionOperations: [],
      generationRequests: [], externalDestinations: [], qaRequirements: [], maxCostMicros: "0",
    };
    const calls = [
      { name: "get_project_snapshot", args: { projectId } },
      { name: "validate_edit_plan", args: draft },
      { name: "submit_edit_plan", args: draft },
    ];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (!req.url.endsWith("/responses")) throw new Error("Unexpected fixture request");
      const body = await req.json();
      const tools = body.tools ?? body.input.find((item: { type?: string }) => item.type === "additional_tools")?.tools;
      if (tools) scopeDescription = tools.find((tool: { name: string }) => tool.name === "get_project_snapshot").description;
      const call = calls[turn++];
      if (!call) return new Response("fixture rejection", { status: 400 });
      const item = { type: "function_call", call_id: "call_" + turn, id: "fc_" + turn,
        name: call.name, arguments: JSON.stringify(call.args), status: "completed" };
      const events = [
        { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_" + turn, status: "completed", output: [item] } },
      ];
      return new Response(events.map(event => "data: " + JSON.stringify(event) + "\n\n").join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const causes: string[] = [];
    session = await createPlannerSession({ projectId, runId: "run", sessionId: "session", workspace: root,
      promptSignature: videoPlannerPromptSignature(), channel: worker, onEvent(event) {
        WorkerToDaemonSchema.parse({ kind: "event", event });
        if (event.causationId) causes.push(event.causationId);
      } });
    await session.prompt("Keep the first second of the clip.");
    expect(scopeDescription).toContain(projectId);
    expect(callIds).toEqual([1, 2, 3].map(i => sha256Hex("call_" + i + "|fc_" + i)));
    expect(causes).toEqual(callIds);
    const after = service.store.project(projectId, principal);
    expect(after.plans).toHaveLength(1);
    expect(after.plans[0]).toMatchObject({ runId: "run", status: "proposed", trimOperations: draft.trimOperations });
    expect(after.approvals).toMatchObject([{ subjectId: after.plans[0].planId, status: "pending" }]);
    expect(after.jobs).toEqual([]);
    await expect(session.prompt("Try another edit")).rejects.toThrow("Planner provider failed");
    expect(service.store.project(projectId, principal).plans).toHaveLength(1);
  } finally {
    await session?.dispose();
    toDaemon.end();
    toWorker.end();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
