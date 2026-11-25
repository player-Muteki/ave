import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { EditorService } from "../service.js";

interface ProviderRequest {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  tools: Array<{ function: { name: string; strict?: boolean; parameters: unknown } }>;
}

function respondWithTool(response: ServerResponse, name: string, args: unknown) {
  const chunk = {
    id: `call-${name}`,
    object: "chat.completion.chunk",
    model: "fixture",
    created: 0,
  };
  const delta = {
    role: "assistant",
    tool_calls: [
      {
        index: 0,
        id: chunk.id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const choice of [
    { index: 0, delta, finish_reason: null },
    { index: 0, delta: {}, finish_reason: "tool_calls" },
  ]) {
    response.write(`data: ${JSON.stringify({ ...chunk, choices: [choice] })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

it("passes project context to the configured provider and persists a strict tool proposal for review", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ave-planner-provider-"));
  const editor = await EditorService.create({ paseoHome: root });
  const requests: ProviderRequest[] = [];
  const server = createServer();
  try {
    await editor.start();
    const principal = editor.principalForOwner();
    const { projectId } = editor.store.createProject({
      requestId: "project",
      title: "Fixture",
      principal,
    });
    const blob = await editor.cas.writeBytes(
      Buffer.from("planner fixture"),
      "application/octet-stream",
    );
    editor.store.addAsset(
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
            timeBase: { num: "1", den: "24" },
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
    const project = editor.store.project(projectId, principal);
    const range = { start: { num: "0", den: "1" }, duration: { num: "1", den: "1" } };
    const draft = {
      schemaVersion: "video.edit-plan/v1",
      projectId,
      baseTimelineRevision: project.revision,
      baseAssetManifestHash: project.baseAssetManifestHash,
      preferredDeterministicBackendId: null,
      intent: "Keep the first second",
      trimOperations: [
        {
          opId: "trim",
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
          fadeIn: null,
          fadeOut: null,
          overlayX: null,
          overlayY: null,
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
    server.on("request", async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk);
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (requests.length === 1) respondWithTool(response, "get_project_snapshot", { projectId });
        else if (requests.length === 2) respondWithTool(response, "submit_edit_plan", draft);
        else response.writeHead(400).end("Unexpected request after submitting the plan");
      } catch {
        response.writeHead(400).end("Invalid fixture request");
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");
    const modelsPath = path.join(root, "models.json");
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: "openai-completions",
            apiKey: "fixture",
            compat: { supportsStrictMode: true },
            models: [{ id: "fixture" }],
          },
        },
      }),
    );
    vi.stubEnv("VIDEO_EDITOR_PLANNER_MODEL", "fixture/fixture");
    vi.stubEnv("VIDEO_EDITOR_PLANNER_MODELS", modelsPath);
    const { runId } = await editor.agents.startRun(
      { projectId, requestId: "plan", prompt: draft.intent },
      principal,
    );
    await expect
      .poll(
        () =>
          editor.store.runLifecycle(projectId, principal).find((run) => run.runId === runId)?.state,
        { timeout: 15_000 },
      )
      .toMatch(/^(settled|failed|interrupted)$/);

    expect(requests).toHaveLength(2);
    expect(requests[0].model).toBe("fixture");
    expect(
      JSON.stringify(requests[0].messages.find((message) => message.role === "user")?.content),
    ).toContain(projectId);
    expect(
      JSON.stringify(requests[1].messages.find((message) => message.role === "tool")?.content),
    ).toContain(blob.sha256);
    expect(
      requests[1].tools.find((tool) => tool.function.name === "submit_edit_plan")?.function,
    ).toMatchObject({
      strict: true,
      parameters: { required: expect.arrayContaining(["preferredDeterministicBackendId"]) },
    });
    const result = editor.store.project(projectId, principal);
    expect(result.plans).toMatchObject([
      { runId, status: "proposed", deterministicBackendId: "ffmpeg" },
    ]);
    expect(result.plans[0].preferredDeterministicBackendId).toBeUndefined();
    expect(result.plans[0].trimOperations).toMatchObject([
      { sourceRange: range, recordRange: range },
    ]);
    expect(result.plans[0].trimOperations[0].fadeIn).toBeUndefined();
    expect(result.approvals).toMatchObject([
      { subjectId: result.plans[0].planId, status: "pending" },
    ]);
    expect(result.jobs).toEqual([]);
    expect(editor.store.runLifecycle(projectId, principal)).toContainEqual({
      runId,
      state: "settled",
    });

    vi.stubEnv("VIDEO_EDITOR_PLANNER_MODEL", "fixture/missing-model");
    const invalid = await editor.agents.startRun(
      { projectId, requestId: "invalid-model", prompt: draft.intent },
      principal,
    );
    await expect
      .poll(
        () =>
          editor.store.runLifecycle(projectId, principal).find((run) => run.runId === invalid.runId)
            ?.state,
        { timeout: 10_000 },
      )
      .toBe("failed");
    expect(requests).toHaveLength(2);
    expect(editor.store.project(projectId, principal).plans).toEqual(result.plans);

    vi.stubEnv("VIDEO_EDITOR_PLANNER_MODEL", "fixture/fixture");
    const rejected = await editor.agents.startRun(
      { projectId, requestId: "provider-error", prompt: draft.intent },
      principal,
    );
    await expect
      .poll(
        () =>
          editor.store.runLifecycle(projectId, principal).find((run) => run.runId === rejected.runId)
            ?.state,
        { timeout: 10_000 },
      )
      .toBe("failed");
    expect(requests).toHaveLength(3);
    expect(editor.store.project(projectId, principal).plans).toEqual(result.plans);
  } finally {
    vi.unstubAllEnvs();
    await editor.stop();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);
